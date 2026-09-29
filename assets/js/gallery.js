/* ==========================================================================
   gallery.js —— 核心：立体随机卡片墙（虚拟渲染版）
   · 分布：向日葵螺旋 + 每张卡片专属随机抖动 / 深度 / 朝向 → 立体随机云
   · 性能：只给「视口附近」的卡片建 DOM，拖动 / 惯性 / 滚动时动态换血，
     其余 2000+ 张只存数据 —— 内存和渲染量始终只有几十张
   · 拖拽：Draggable + Inertia 惯性 + 悬停 3D + 海报懒加载
   ========================================================================== */
(function () {
  'use strict';

  var stage = document.getElementById('stage');
  var world = document.getElementById('world');

  var els = {};            // key -> DOM（仅视口附近，虚拟渲染）
  var order = [];          // 当前展示顺序（全部 key，仅数据）
  var pos = {};            // key -> {x,y,z,rx,ry,rz}（全部，仅数据）
  var cells = {};          // 空间网格 "cx,cy" -> [key]（视口剔除用）
  var bbox = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  var sortMode = 'recent';
  var draggable = null;
  var geom = { cardW: 168, cardH: 252, gap: 30 };
  var hover = { el: null, quickRX: null, quickRY: null };
  var onOpenDetail = null;
  var layoutTween = null;
  var keysProvider = null;   // 由 app.js 提供（可能按「影视剧/书籍」筛选过）

  /* ---------------- 虚拟渲染参数 ---------------- */
  var CELL = 560;            // 空间网格边长（≈卡宽+边距，保证一格跨视口不多）
  var MARGIN = 760;          // 视口外预留（覆盖 z 深度带来的视觉偏移 + 卡片尺寸）
  var MAX_RENDER = 80;       // 同时渲染上限（正常视口 ~20-30 张）
  var CREATE_PER_FRAME = 4;  // 每帧最多新建几张，拖得再快也不卡
  var pendingCreate = [];     // 等待建 DOM 的卡片
  var pumping = false;
  var cullQueued = false;

  /* 3D 拖拽：拖动时整面墙跟着倾斜，速度衰减后自动回正 */
  var spin = { vx: 0, vy: 0 };
  var tilt = { x: 0, y: 0 };
  var lastPos = { x: 0, y: 0 };
  var tickerOn = false;
  var watchOn = false;
  var lastWX = null, lastWY = null;

  function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  var SORTS = [
    { id: 'recent', label: '最近添加' },
    { id: 'my', label: '我的评分' },
    { id: 'douban', label: '豆瓣评分' },
    { id: 'random', label: '随机排布' }
  ];

  /* ---------------------------------------------------------------- 尺寸 */
  function measure() {
    var cs = getComputedStyle(document.documentElement);
    geom.cardW = parseFloat(cs.getPropertyValue('--card-w')) || 168;
    geom.gap = parseFloat(cs.getPropertyValue('--card-gap')) || 30;
    geom.cardH = Math.round(geom.cardW * 1.5);
  }

  function vw() { return window.innerWidth; }
  function vh() { return window.innerHeight; }

  function allKeys() {
    return keysProvider ? keysProvider() : Store.featured();
  }

  function clampX(x) {
    var half = Math.max(1, (bbox.maxX - bbox.minX) / 2);
    var slack = Math.min(vw() * 0.35, 260);
    var min = vw() / 2 - half + slack, max = vw() / 2 + half - slack;
    if (min > max) { min = max = vw() / 2; }
    return Math.max(min, Math.min(max, x));
  }

  function clampY(y) {
    var half = Math.max(1, (bbox.maxY - bbox.minY) / 2);
    var slack = Math.min(vh() * 0.35, 220);
    var min = vh() / 2 - half + slack, max = vh() / 2 + half - slack;
    if (min > max) { min = max = vh() / 2; }
    return Math.max(min, Math.min(max, y));
  }

  function dragBounds() {
    return { minX: clampX(-Infinity), maxX: clampX(Infinity),
             minY: clampY(-Infinity), maxY: clampY(Infinity) };
  }

  /* ---------------------------------------------------------------- 排序 */
  function sortKeys(keys) {
    var list = keys.slice();
    if (sortMode === 'random') {
      for (var i = list.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = list[i]; list[i] = list[j]; list[j] = t;
      }
      return list;
    }
    var byKey = Store.byKey.bind(Store);
    list.sort(function (a, b) {
      var A = byKey(a) || {}, B = byKey(b) || {};
      if (sortMode === 'my') {
        if ((B.myRating || 0) !== (A.myRating || 0)) return (B.myRating || 0) - (A.myRating || 0);
        return String(B.createdAt || '').localeCompare(String(A.createdAt || ''));
      }
      if (sortMode === 'douban') {
        return (parseFloat(B.doubanRating) || 0) - (parseFloat(A.doubanRating) || 0);
      }
      return String(B.createdAt || '').localeCompare(String(A.createdAt || ''));
    });
    return list;
  }

  /* ---------------------------------------------------------------- 布局 */

  /* 稳定伪随机：同一条目每次打开都在同一个「座位」附近，
     但整体又足够随机 —— 立体云的钥匙 */
  function hash32(text) {
    var h = 2166136261, s = String(text);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 立体随机分布：
     · 向日葵螺旋保证「哪儿都有卡片、哪儿都不扎堆」
     · 每张卡再按自己的 key 做随机抖动 + 随机深度(z) + 随机朝向
     · y 方向压成椭圆（横屏屏幕更好看），z 随机 60~580 → 有真实纵深感 */
  function computePositions() {
    var n = order.length;
    pos = {}; cells = {};
    if (!n) {
      bbox = { minX: -400, maxX: 400, minY: -300, maxY: 300 };
      if (draggable && draggable.applyBounds) draggable.applyBounds(dragBounds());
      return;
    }

    var spread = clampNum(geom.cardW * 2.15, 300, 560);   // 相邻卡片的平均间距
    var GA = Math.PI * (3 - Math.sqrt(5));                // 黄金角
    var squash = 0.7;                                      // 纵向压扁 → 椭圆云
    var maxX = 0, maxY = 0;

    for (var i = 0; i < n; i++) {
      var key = order[i];
      var rnd = mulberry32(hash32(key) ^ 0x9E3779B9);
      var r = spread * Math.sqrt(i + 0.6);
      var a = i * GA;
      var jr = (rnd() - 0.5) * spread * 0.85;              // 位置抖动
      var ja = rnd() * Math.PI * 2;
      var x = Math.cos(a) * r + Math.cos(ja) * jr;
      var y = (Math.sin(a) * r + Math.sin(ja) * jr) * squash;
      pos[key] = {
        x: Math.round(x), y: Math.round(y),
        z: -Math.round(50 + rnd() * 540),                  // 深度 50~590
        ry: (rnd() - 0.5) * 24,                            // 左右朝向
        rx: (rnd() - 0.5) * 15,                            // 俯仰
        rz: (rnd() - 0.5) * 6                              // 微倾
      };
      var ax = Math.abs(x) + spread, ay = Math.abs(y) + spread;
      if (ax > maxX) maxX = ax;
      if (ay > maxY) maxY = ay;

      var ck = Math.floor(x / CELL) + ',' + Math.floor(y / CELL);
      (cells[ck] || (cells[ck] = [])).push(key);
    }
    bbox = { minX: -maxX, maxX: maxX, minY: -maxY, maxY: maxY };
    if (draggable && draggable.applyBounds) draggable.applyBounds(dragBounds());
  }

  function applyPositions(animate) {
    var key, el, p;
    for (key in els) {
      el = els[key]; p = pos[key];
      if (!el || !p) continue;
      if (animate) {
        gsap.to(el, { x: p.x, y: p.y, z: p.z, rotationX: p.rx, rotationY: p.ry,
                      rotationZ: p.rz, duration: 0.62, ease: 'power3.out', overwrite: 'auto' });
      } else {
        gsap.set(el, { x: p.x, y: p.y, z: p.z, rotationX: p.rx, rotationY: p.ry, rotationZ: p.rz });
      }
    }
  }

  /* ---------------------------------------------------------------- 虚拟渲染：视口剔除 */

  /* 视口(±margin)覆盖到世界坐标的哪些网格 → 其中的卡片就是要渲染的 */
  function visibleKeys() {
    var wx = gsap.getProperty(world, 'x'), wy = gsap.getProperty(world, 'y');
    var vx0 = -wx - MARGIN, vy0 = -wy - MARGIN;
    var vx1 = -wx + vw() + MARGIN, vy1 = -wy + vh() + MARGIN;
    var out = [];
    var cx0 = Math.floor(vx0 / CELL), cx1 = Math.floor(vx1 / CELL);
    var cy0 = Math.floor(vy0 / CELL), cy1 = Math.floor(vy1 / CELL);
    for (var cx = cx0; cx <= cx1; cx++) {
      for (var cy = cy0; cy <= cy1; cy++) {
        var bucket = cells[cx + ',' + cy];
        if (!bucket) continue;
        for (var i = 0; i < bucket.length; i++) {
          var k = bucket[i], p = pos[k];
          if (p && p.x >= vx0 && p.x <= vx1 && p.y >= vy0 && p.y <= vy1) out.push(k);
        }
      }
    }
    return out;
  }

  /* 拖拽时世界每帧都在移动，但没必要每一帧立刻重建 DOM。
     合并到下一帧执行，避免高速惯性下反复做空间剔除。 */
  function queueCull() {
    if (cullQueued) return;
    cullQueued = true;
    requestAnimationFrame(function () {
      cullQueued = false;
      cull();
    });
  }

  function cull() {
    var list = visibleKeys();
    if (list.length > MAX_RENDER) list = list.slice(0, MAX_RENDER);
    var need = {}, i;
    for (i = 0; i < list.length; i++) need[list[i]] = true;

    /* 出了视口的卡片直接拆掉（拖动中拆看不见，无闪烁） */
    for (var k in els) {
      if (!need[k]) {
        els[k].remove();
        delete els[k];
      }
    }
    /* 视口里还没有 DOM 的卡片排队入场（每帧限量） */
    pendingCreate.length = 0;
    for (i = 0; i < list.length; i++) {
      if (!els[list[i]]) pendingCreate.push(list[i]);
    }
    pumpCreates();
  }

  function pumpCreates() {
    if (pumping) return;
    pumping = true;
    requestAnimationFrame(function step() {
      var n = Math.min(pendingCreate.length, CREATE_PER_FRAME);
      for (var i = 0; i < n; i++) {
        var key = pendingCreate.shift();
        if (!els[key]) createCard(key, true);
      }
      if (pendingCreate.length) requestAnimationFrame(step);
      else pumping = false;
    });
  }

  /* ---------------------------------------------------------------- 卡片 DOM */
  function cardHtml(item) {
    var kind = item.type === 'book' ? '书籍' : '影视剧';
    var sub = Store.subtitleOf(item);
    var stars = item.myRating ? '<span class="stars">' + Store.starsHtml(item.myRating) + '</span>' +
      (sub ? '<span class="dot">·</span>' : '') : '';
    return '' +
      '<div class="card-inner">' +
        Store.coverHtml(item) +
        '<span class="card-badge">' + kind + '</span>' +
        '<button class="card-cover-btn" data-act="cover" title="换海报" aria-label="换海报">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
          '<rect x="3" y="4" width="18" height="16" rx="2"></rect>' +
          '<circle cx="8.5" cy="9.5" r="1.6"></circle><path d="M4 17l5-4 4 3 3-2 4 3"></path></svg>' +
        '</button>' +
        '<div class="card-meta">' +
          '<div class="card-title">' + Store.escapeHtml(item.title) + '</div>' +
          '<div class="card-sub">' + stars + Store.escapeHtml(sub) + '</div>' +
        '</div>' +
      '</div>';
  }

  /* enter=true 时带入场动画（CSS 一次性的，不占 gsap） */
  function createCard(key, enter) {
    var item = Store.byKey(key);
    if (!item) return null;
    var el = document.createElement('article');
    el.className = 'card' + (enter ? ' enter' : '');
    el.dataset.key = key;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', item.title);
    el.innerHTML = cardHtml(item);
    var p = pos[key];
    if (p) gsap.set(el, { x: p.x, y: p.y, z: p.z, rotationX: p.rx, rotationY: p.ry, rotationZ: p.rz });
    if (enter) {
      el.addEventListener('animationend', function h() {
        el.classList.remove('enter'); el.removeEventListener('animationend', h);
      });
    }
    world.appendChild(el);
    els[key] = el;
    return el;
  }

  function updateCardPoster(key) {
    var el = els[key], item = Store.byKey(key);
    if (!el || !item) return;
    var inner = el.querySelector('.card-inner');
    if (!inner) return;
    var old = inner.querySelector('.card-poster, .cover-fallback');
    var tmp = document.createElement('div');
    tmp.innerHTML = Store.coverHtml(item);
    var fresh = tmp.firstChild;
    if (old) inner.replaceChild(fresh, old);
    else inner.insertBefore(fresh, inner.firstChild);
  }

  /* 卡片内容（标题/星级）变了，若正在视口里就重画 */
  function updateCard(key) {
    var el = els[key];
    if (!el) return;
    var item = Store.byKey(key);
    if (!item) return;
    var roi = el.querySelector('.card-meta');
    var tmp = document.createElement('div');
    tmp.innerHTML = cardHtml(item);
    var meta = tmp.querySelector('.card-meta');
    if (roi && meta) roi.parentNode.replaceChild(meta, roi);
    updateCardPoster(key);
  }

  /* ---------------------------------------------------------------- 悬停 3D */
  function bindHover() {
    function reset(el) {
      if (!el) return;
      var inner = el.querySelector('.card-inner');
      if (!inner) return;
      gsap.to(inner, { rotateX: 0, rotateY: 0, y: 0, scale: 1, duration: 0.5, ease: 'power2.out', overwrite: 'auto' });
    }

    stage.addEventListener('pointerover', function (e) {
      var card = e.target.closest ? e.target.closest('.card') : null;
      if (!card || card === hover.el) return;
      if (draggable && draggable.isDragging) return;
      if (window.matchMedia('(hover: none)').matches) return;
      reset(hover.el);
      hover.el = card;
      var inner = card.querySelector('.card-inner');
      if (inner) {
        gsap.set(inner, { transformPerspective: 700, transformOrigin: 'center' });
        hover.quickRX = gsap.quickTo(inner, 'rotateX', { duration: 0.4, ease: 'power2.out' });
        hover.quickRY = gsap.quickTo(inner, 'rotateY', { duration: 0.4, ease: 'power2.out' });
      }
    });

    stage.addEventListener('pointermove', function (e) {
      if (!hover.el || (draggable && draggable.isDragging)) return;
      var card = e.target.closest ? e.target.closest('.card') : null;
      if (card !== hover.el) { reset(hover.el); hover.el = null; return; }
      var r = hover.el.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - 0.5;
      var py = (e.clientY - r.top) / r.height - 0.5;
      if (hover.quickRY) hover.quickRY(px * 15);
      if (hover.quickRX) hover.quickRX(-py * 13);
    });

    stage.addEventListener('pointerleave', function () { reset(hover.el); hover.el = null; });
  }

  /* ---------------------------------------------------------------- 拖拽 + 惯性 */

  /* 每一帧：① 墙随拖拽速度倾斜、松手回正；② 监视世界坐标，
     一旦移动（拖拽 / 惯性 / 滚轮 / 聚焦动画）就重新剔除，按需换卡片 */
  function ensureTicker() {
    if (tickerOn) return;
    tickerOn = true;
    gsap.ticker.add(function () {
      spin.vx *= 0.88;
      spin.vy *= 0.88;

      var wantX, wantY;
      var speed = Math.sqrt(spin.vx * spin.vx + spin.vy * spin.vy);

      if (speed < 0.05) {
        if (tilt.x !== 0 || tilt.y !== 0) {
          tilt.x = 0;
          tilt.y = 0;
          gsap.set(world, { rotationX: 0, rotationY: 0, rotationZ: 0 });
        }
      } else {
        wantY = clampNum(-spin.vx * 0.55, -9, 9);
        wantX = clampNum(spin.vy * 0.45, -6, 6);
        var wantZ = clampNum((spin.vx + spin.vy) * 0.075, -2.8, 2.8);

        if (Math.abs(wantX - tilt.x) >= 0.02 ||
            Math.abs(wantY - tilt.y) >= 0.02) {
          tilt.x = wantX;
          tilt.y = wantY;
          gsap.set(world, {
            rotationX: wantX,
            rotationY: wantY,
            rotationZ: wantZ
          });
        }
      }

      /* 虚拟渲染：世界在动 → 视口变了 → 下一帧统一剔除 */
      if (watchOn) {
        var wx = gsap.getProperty(world, 'x'), wy = gsap.getProperty(world, 'y');
        if (lastWX === null || Math.abs(wx - lastWX) > 2 || Math.abs(wy - lastWY) > 2) {
          lastWX = wx;
          lastWY = wy;
          queueCull();
        }
      }
    });
  }

  function bindDrag() {
    draggable = Draggable.create(world, {
      type: 'x,y',
      inertia: true,
      throwResistance: 1600,
      edgeResistance: 0.7,
      dragResistance: 0,
      allowNativeTouchScrolling: false,
      onPress: function () {
        if (layoutTween && layoutTween.isActive()) layoutTween.kill();
        gsap.killTweensOf(world);
        lastPos.x = this.x; lastPos.y = this.y;
        spin.vx = 0; spin.vy = 0;
        gsap.set(world, { rotationZ: 0 });
        stage.classList.add('dragging');
      },
      onDragStart: function () {
        if (hover.el) { gsap.to(hover.el.querySelector('.card-inner'),
          { rotateX: 0, rotateY: 0, duration: 0.2, overwrite: 'auto' }); hover.el = null; }
      },
      onDrag: function () {
        spin.vx = this.x - lastPos.x;
        spin.vy = this.y - lastPos.y;
        lastPos.x = this.x; lastPos.y = this.y;
      },
      onRelease: function () {
        setTimeout(function () { stage.classList.remove('dragging'); }, 40);
      },
      onDragEnd: function () {
        /* 惯性继续时由 ticker 驱动倾斜；速度归零后自动回正 */
        setTimeout(function () { stage.classList.remove('dragging'); }, 40);
      },
      bounds: dragBounds()
    })[0];
  }

  /* 滚轮 / 触控板平移（轻量：短促小步 tween，滚得再快也不堆积） */
  function bindWheel() {
    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      var x = clampX(gsap.getProperty(world, 'x') - e.deltaX);
      var y = clampY(gsap.getProperty(world, 'y') - e.deltaY);
      gsap.to(world, { x: x, y: y, duration: 0.35, ease: 'power2.out', overwrite: 'auto' });
    }, { passive: false });
  }

  /* 方向键平移 */
  function bindKeys() {
    document.addEventListener('keydown', function (e) {
      if (e.target.matches && e.target.matches('input, textarea, select')) return;
      var step = e.shiftKey ? 300 : 130;
      var dx = 0, dy = 0;
      if (e.key === 'ArrowLeft') dx = step;
      else if (e.key === 'ArrowRight') dx = -step;
      else if (e.key === 'ArrowUp') dy = step;
      else if (e.key === 'ArrowDown') dy = -step;
      else return;
      e.preventDefault();
      gsap.to(world, {
        x: clampX(gsap.getProperty(world, 'x') + dx),
        y: clampY(gsap.getProperty(world, 'y') + dy),
        duration: 0.4, ease: 'power2.out', overwrite: 'auto'
      });
    });
  }

  /* ---------------------------------------------------------------- 交互 */
  function bindClicks() {
    stage.addEventListener('click', function (e) {
      if (draggable && draggable.isDragging) return;
      var act = e.target.closest ? e.target.closest('[data-act="cover"]') : null;
      if (act) {
        var c = act.closest('.card');
        if (c) { e.stopPropagation(); Covers.open(c.dataset.key); }
        return;
      }
      var card = e.target.closest ? e.target.closest('.card') : null;
      if (card && onOpenDetail) onOpenDetail(card.dataset.key);
    });

    stage.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var card = e.target.closest ? e.target.closest('.card') : null;
      if (card && onOpenDetail) { e.preventDefault(); onOpenDetail(card.dataset.key); }
    });
  }

  /* ---------------------------------------------------------------- 对外接口 */
  function render(keys, opts) {
    opts = opts || {};
    order = sortKeys(keys);
    computePositions();

    /* 筛选/排序变化：旧卡片里已不在墙上的拆掉，在墙上的飞到新座位 */
    var want = {}, i, key;
    for (i = 0; i < order.length; i++) want[order[i]] = true;
    for (key in els) {
      if (!want[key]) { els[key].remove(); delete els[key]; }
    }

    if (opts.animate) applyPositions(true);

    if (!opts.keepView) center(false);
    lastWX = null;                       // 强制下一帧重新剔除
    cull();
    updateCount();
  }

  function refresh(opts) {
    render(allKeys(), opts || {});
  }

  function addKey(key, opts) {
    opts = opts || {};
    if (!Store.byKey(key)) return;
    Store.addFeatured(key);
    order = sortKeys(allKeys());
    computePositions();
    persist();
    cull();                              // 视口里看得到它就建出来，看不到就算了
    var el = els[key];
    if (el) {
      var p = pos[key];
      gsap.fromTo(el, { x: p.x, y: p.y, scale: 0.4, opacity: 0, rotateY: -40, z: p.z + 260 },
        { scale: 1, opacity: 1, rotateY: p.ry, z: p.z, duration: 0.7, ease: 'back.out(1.5)' });
    }
    updateCount();
    if (opts.focus) focusKey(key);
  }

  function removeKey(key) {
    Store.removeFeatured(key);
    var el = els[key];
    if (el) {
      gsap.to(el, {
        scale: 0.5, opacity: 0, duration: 0.35, ease: 'power2.in',
        onComplete: function () { el.remove(); }
      });
      delete els[key];
    }
    order = sortKeys(allKeys());
    setTimeout(function () { computePositions(); cull(); updateCount(); }, 120);
    persist();
    updateCount();
    return false;
  }

  function persist() {
    if (!API.available) return;
    API.saveFeatured(Store.featured()).catch(function (err) {
      UI.toast('卡片墙没能保存到硬盘：' + err.message, true);
    });
  }

  function updateCount() {
    var el = document.getElementById('hudCount');
    if (!el) return;
    var total = Store.featured().length;
    el.textContent = total + ' 张卡片 / 全库 ' + Store.count() + ' 条';
  }

  function center(animate) {
    var x = clampX(vw() / 2), y = clampY(vh() / 2);
    if (animate) layoutTween = gsap.to(world, { x: x, y: y, duration: 0.8, ease: 'power3.inOut' });
    else gsap.set(world, { x: x, y: y });
  }

  function focusKey(key, dur) {
    var p = pos[key];
    if (!p) return;
    layoutTween = gsap.to(world, {
      x: clampX(vw() / 2 - p.x), y: clampY(vh() / 2 - p.y),
      duration: dur || 1.15, ease: 'power3.inOut'
    });
    var el = els[key];
    if (el) {
      gsap.fromTo(el.querySelector('.card-inner'),
        { boxShadow: '0 0 0 0 rgba(232,185,107,0)' },
        { boxShadow: '0 0 34px 4px rgba(232,185,107,.5)', duration: 0.5, yoyo: true, repeat: 1 });
    }
  }

  function randomKey() {
    var list = allKeys();
    if (!list.length) return null;
    return list[Math.floor(Math.random() * list.length)];
  }

  function setSort(mode) {
    if (mode === sortMode) return;
    sortMode = mode;
    render(allKeys(), { animate: true, keepView: true });
  }

  function nextSort() {
    var i = SORTS.map(function (s) { return s.id; }).indexOf(sortMode);
    setSort(SORTS[(i + 1) % SORTS.length].id);
    return sortMode;
  }

  function sortLabel() {
    for (var i = 0; i < SORTS.length; i++) if (SORTS[i].id === sortMode) return SORTS[i].label;
    return '';
  }

  /* 序幕用：当前视口里的卡片从画面中央被「拉」出来 */
  function playDropIn(done) {
    var list = Object.keys(els);
    if (!list.length) { if (done) done(); return; }
    gsap.set(world, { x: vw() / 2, y: vh() / 2 });
    list.forEach(function (k) {
      var ang = Math.random() * Math.PI * 2;
      gsap.set(els[k], { x: Math.cos(ang) * 40, y: Math.sin(ang) * 40, scale: 0.15, opacity: 0, rotateY: 180 });
    });
    gsap.to(list.map(function (k) { return els[k]; }), {
      x: function (i, t) { return pos[t.dataset.key].x; },
      y: function (i, t) { return pos[t.dataset.key].y; },
      z: function (i, t) { return pos[t.dataset.key].z; },
      rotationX: function (i, t) { return pos[t.dataset.key].rx; },
      rotationY: function (i, t) { return pos[t.dataset.key].ry; },
      rotationZ: function (i, t) { return pos[t.dataset.key].rz; },
      scale: 1, opacity: 1,
      duration: 1.05, ease: 'power3.out', stagger: { each: 0.008, from: 'center' },
      onComplete: function () {
        applyPositions(false);
        cull();
        if (done) done();
      }
    });
  }

  function mount(options) {
    options = options || {};
    onOpenDetail = options.onOpenDetail || null;
    keysProvider = options.keys || null;
    measure();
    ensureTicker();
    bindDrag();
    bindWheel();
    bindKeys();
    bindHover();
    bindClicks();
    watchOn = true;
    window.addEventListener('resize', function () {
      measure();
      computePositions();
      gsap.to(world, {
        x: clampX(gsap.getProperty(world, 'x')),
        y: clampY(gsap.getProperty(world, 'y')),
        duration: 0.3, overwrite: 'auto'
      });
      lastWX = null;
      cull();
    });
  }

  window.Gallery = {
    mount: mount, render: render, refresh: refresh, addKey: addKey, removeKey: removeKey,
    updateCard: updateCard, updateCardPoster: updateCardPoster,
    focusKey: focusKey, center: center, randomKey: randomKey, playDropIn: playDropIn,
    setSort: setSort, nextSort: nextSort, sortLabel: sortLabel,
    geom: geom, isDragging: function () { return !!(draggable && draggable.isDragging); },
    /* 调试用：当前真实渲染了多少张 */
    renderedCount: function () { return Object.keys(els).length; }
  };
})();
