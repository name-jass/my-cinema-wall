/* ==========================================================================
   data.js —— 数据层：全量条目 + 卡片墙成员 + 海报清单 + 搜索
   纯全局（不用 ES Module），直接双击 index.html 也能跑
   ========================================================================== */
(function () {
  'use strict';

  var state = {
    items: [],          // 全量条目（含网页新增）
    map: {},            // key -> item
    featured: [],       // 卡片墙成员 key（有序）
    covers: {},         // key -> 海报相对路径
    custom: [],         // 网页里新增的条目
    mode: 'readonly'    // 'live' 有本机服务 / 'readonly' 无服务
  };

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* 标题哈希 → 兜底封面的色相，保证同一条目颜色固定 */
  function hashHue(text) {
    var h = 0, s = String(text || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function firstChar(title) {
    var t = String(title || '').trim();
    if (!t) return '书';
    var m = t.match(/[\u4e00-\u9fa5A-Za-z0-9]/);
    return m ? m[0].toUpperCase() : t[0];
  }

  /* 「年份 · 类型」这类副标题 */
  function subtitleOf(item) {
    var bits = [];
    if (item.type === 'book') {
      if (item.author) bits.push(item.author);
      if (item.publisher) bits.push(item.publisher);
    } else {
      if (item.year) bits.push(item.year);
      if (item.genres) bits.push(item.genres);
    }
    if (!bits.length && item.year) bits.push(item.year);
    return bits.join(' · ');
  }

  function starsHtml(rating) {
    var n = Math.max(0, Math.min(5, parseInt(rating, 10) || 0));
    var html = '';
    for (var i = 1; i <= 5; i++) {
      html += i <= n ? '★' : '<span class="off">★</span>';
    }
    return html;
  }

  /* 兜底封面（永不空白）：标题哈希成双色渐变 + 首字 */
  function fallbackHtml(item) {
    return '<div class="cover-fallback' + (item.type === 'book' ? ' book' : '') +
      '" style="--hue:' + hashHue(item.title) + '"><span>' +
      escapeHtml(firstChar(item.title)) + '</span></div>';
  }

  /* 海报区的完整 HTML：有图就用图（懒加载），没有就用兜底 */
  function coverHtml(item, cls) {
    var path = state.covers[item.key];
    var html = fallbackHtml(item);
    if (path) {
      html = '<img class="' + (cls || 'card-poster') + '" loading="lazy" decoding="async" ' +
        'src="' + escapeHtml(path) + '" alt="" onload="this.classList.add(\'loaded\')" ' +
        'onerror="this.remove()">' + html;
    }
    return html;
  }

  /* ---------------------------------------------------------------- 搜索 */
  function scoreItem(item, q) {
    var t = item.title || '';
    var lower = t.toLowerCase();
    if (lower === q) return 1000;
    if (lower.indexOf(q) === 0) return 900;
    if (lower.indexOf(q) >= 0) return 700;

    var fields = [
      [item.director, 320], [item.cast, 260], [item.author, 320],
      [item.publisher, 180], [item.genres, 200], [item.regions, 140],
      [item.year, 120], [item.doubanId, 220], [item.tags, 120], [item.review, 60]
    ];
    var best = 0;
    for (var i = 0; i < fields.length; i++) {
      var v = String(fields[i][0] || '').toLowerCase();
      if (v && v.indexOf(q) >= 0) best = Math.max(best, fields[i][1]);
    }
    return best;
  }

  function search(query, type, limit) {
    var q = String(query || '').trim().toLowerCase();
    var pool = state.items;
    if (type && type !== 'all') pool = pool.filter(function (i) { return i.type === type; });
    if (!q) {
      return pool.slice(0, limit || 50);
    }
    var hits = [];
    for (var i = 0; i < pool.length; i++) {
      var s = scoreItem(pool[i], q);
      if (s > 0) hits.push({ it: pool[i], s: s });
    }
    hits.sort(function (a, b) {
      if (b.s !== a.s) return b.s - a.s;
      return (b.it.myRating || 0) - (a.it.myRating || 0);
    });
    return hits.slice(0, limit || 50).map(function (h) { return h.it; });
  }

  /* ---------------------------------------------------------------- 卡片墙成员 */
  function featuredList() {
    return state.featured.filter(function (k) { return !!state.map[k]; });
  }

  function addFeatured(key) {
    if (!state.map[key] || state.featured.indexOf(key) >= 0) return false;
    state.featured.push(key);
    return true;
  }

  function removeFeatured(key) {
    var i = state.featured.indexOf(key);
    if (i < 0) return false;
    state.featured.splice(i, 1);
    return true;
  }

  /* ---------------------------------------------------------------- 初始化 */
  function normalize(item) {
    var out = {
      key: item.key, type: item.type === 'book' ? 'book' : 'movie',
      doubanId: item.doubanId || '', title: item.title || '',
      url: item.url || '', year: item.year || '', regions: item.regions || '',
      genres: item.genres || '', director: item.director || '',
      cast: item.cast || '', author: item.author || '',
      publisher: item.publisher || '', doubanRating: item.doubanRating || '',
      myRating: parseInt(item.myRating, 10) || 0,
      review: item.review || '', tags: item.tags || '',
      createdAt: item.createdAt || '', rawIntro: item.rawIntro || '',
      custom: !!item.custom
    };
    return out;
  }

  function rebuild() {
    var all = (window.LIBRARY && window.LIBRARY.items) || [];
    var items = all.map(normalize);
    state.custom.forEach(function (c) { items.push(normalize(c)); });
    state.items = items;
    state.map = {};
    for (var i = 0; i < items.length; i++) state.map[items[i].key] = items[i];
  }

  /* 网页里新增一条：立刻进全库，并默认上卡片墙 */
  function addItem(raw) {
    var item = normalize(raw);
    item.custom = true;
    state.custom.push(item);
    state.items.push(item);
    state.map[item.key] = item;
    if (state.featured.indexOf(item.key) < 0) state.featured.push(item.key);
    return item;
  }

  function customItems() { return state.custom; }

  function init(options) {
    options = options || {};
    state.covers = options.covers || {};
    state.custom = options.custom || [];
    state.featured = (options.featured || []).slice();
    state.mode = options.mode || 'readonly';
    rebuild();

    // 新增条目默认也要在墙上；若 featured 里出现库里没有的键，直接剔除
    state.featured = state.featured.filter(function (k) { return !!state.map[k]; });
    state.custom.forEach(function (c) {
      if (state.map[c.key] && state.featured.indexOf(c.key) < 0) state.featured.push(c.key);
    });
    return state;
  }

  window.Store = {
    init: init,
    state: state,
    all: function () { return state.items; },
    byKey: function (k) { return state.map[k]; },
    addItem: addItem,
    customItems: customItems,
    count: function () { return state.items.length; },
    mode: function () { return state.mode; },
    setCovers: function (covers) { state.covers = covers || {}; },
    covers: function () { return state.covers; },
    coverFor: function (key) { return state.covers[key] || ''; },
    setCover: function (key, path) {
      if (path) state.covers[key] = path; else delete state.covers[key];
    },
    featured: featuredList,
    isFeatured: function (key) { return state.featured.indexOf(key) >= 0; },
    addFeatured: addFeatured,
    removeFeatured: removeFeatured,
    toggleFeatured: function (key) {
      return removeFeatured(key) ? false : addFeatured(key);
    },
    search: search,
    escapeHtml: escapeHtml,
    hashHue: hashHue,
    firstChar: firstChar,
    subtitleOf: subtitleOf,
    starsHtml: starsHtml,
    fallbackHtml: fallbackHtml,
    coverHtml: coverHtml
  };
})();