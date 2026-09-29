/* ==========================================================================
   prologue.js —— 开场序幕（精修版）
   幕布 → 胶片倒计时 3·2·1 → 追光落下（带尘埃）→ 卓别林哑剧 →
   蒸汽火车（头灯点亮）穿过 → 多彩卡片 3D 爆出 → 光带扫过、卡片墙揭开
   浏览器禁止自动播放音频，所以必须先有一次点击 → 「点击启幕」
   ========================================================================== */
(function () {
  'use strict';

  var prologue = document.getElementById('prologue');
  var curtain = document.getElementById('curtain');
  var spotlight = document.getElementById('spotlight');
  var poolFloor = document.getElementById('poolFloor');
  var dust = document.getElementById('dust');
  var countdown = document.getElementById('countdown');
  var cdNum = document.getElementById('cdNum');
  var cdSweep = document.getElementById('cdSweep');
  var charlie = document.getElementById('charlieWrap');
  var hat = document.getElementById('charlieHat');
  var body = document.getElementById('charlieBody');
  var cane = document.getElementById('charlieCane');
  var arm = document.getElementById('charlieArm');
  var train = document.getElementById('trainWrap');
  var trainLight = document.getElementById('trainLight');
  var wheels = train.querySelectorAll ? train.querySelectorAll('.wheel') : [];
  var puffs = train.querySelectorAll ? train.querySelectorAll('.puff') : [];
  var cardsLayer = document.getElementById('prologueCards');
  var lightSweep = document.getElementById('lightSweep');
  var startBtn = document.getElementById('prologueStart');
  var skipBtn = document.getElementById('prologueSkip');
  var hud = document.getElementById('hud');
  var hint = document.getElementById('hudMinimapHint');

  var tl = null;
  var state = 'idle';        // idle → playing → done
  var sprites = [];
  var revealCalled = false;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 多彩卡片：四组片场配色，爆出时更像一叠真实的海报 */
  function makeSprites() {
    cardsLayer.innerHTML = '';
    sprites = [];
    var palettes = [
      ['#8A6A35', '#2C2413', 'rgba(232,185,107,.55)'],   // 琥珀
      ['#3F7482', '#14242C', 'rgba(125,195,210,.45)'],   // 青蓝
      ['#5C5482', '#1B1830', 'rgba(165,155,225,.45)'],   // 紫暮
      ['#8A5040', '#2A1812', 'rgba(235,165,125,.45)']    // 砖红
    ];
    for (var i = 0; i < 36; i++) {
      var d = document.createElement('div');
      d.className = 'pro-card';
      var p = palettes[i % palettes.length];
      d.style.background = 'linear-gradient(160deg, ' + p[0] + ', ' + p[1] + ')';
      d.style.borderColor = p[2];
      cardsLayer.appendChild(d);
      sprites.push(d);
    }
  }

  /* 追光里的浮尘：14 粒，CSS 循环动画（GPU），整体淡入淡出交给时间轴 */
  function makeDust() {
    dust.innerHTML = '';
    for (var i = 0; i < 14; i++) {
      var s = document.createElement('span');
      s.style.left = (28 + Math.random() * 44) + '%';
      s.style.top = (10 + Math.random() * 74) + '%';
      s.style.animationDuration = (5 + Math.random() * 6).toFixed(2) + 's';
      s.style.animationDelay = (-Math.random() * 8).toFixed(2) + 's';
      s.style.opacity = (0.15 + Math.random() * 0.3).toFixed(2);
      dust.appendChild(s);
    }
  }

  function revealWall() {
    if (revealCalled) return;
    revealCalled = true;
    Piano.setLayer('main');
    if (window.Gallery) Gallery.playDropIn();
    if (hint) {
      gsap.fromTo(hint, { opacity: 0 }, {
        opacity: 1, duration: 0.8, delay: 1.2,
        onComplete: function () { setTimeout(function () { hint.style.opacity = '0'; }, 6000); }
      });
    }
  }

  function finish() {
    state = 'done';
    prologue.classList.add('gone');
    gsap.set(hud, { clearProps: 'opacity,transform' });
    if (hint) gsap.set(hint, { clearProps: 'opacity' });
    sprites = [];
  }

  function skip() {
    if (state !== 'playing' || !tl) return;
    tl.progress(1, false);
  }

  function build() {
    makeSprites();
    makeDust();

    /* 精简片头：保留「幕布 → 胶片 → 追光 → 海报浮现 → 揭幕」五个动作。
       卓别林与火车仍保留在 DOM 中供后续扩展，但不参与默认片头，避免视觉叙事过载。 */
    gsap.set(curtain, { opacity: 1, display: 'flex' });
    gsap.set(spotlight, { opacity: 0, y: '-34vh', scaleY: 0.82, transformOrigin: '50% 0%' });
    gsap.set(poolFloor, { opacity: 0 });
    gsap.set(dust, { opacity: 0 });
    gsap.set(countdown, { display: 'none', opacity: 0, scale: 1 });
    gsap.set(charlie, { opacity: 0 });
    gsap.set(train, { opacity: 0 });
    gsap.set(lightSweep, { xPercent: -140, opacity: 0 });
    gsap.set(hud, { opacity: 0, y: -12 });
    gsap.set(sprites, { x: 0, y: 0, scale: 0.72, opacity: 0, rotate: 0, rotateY: 0 });

    tl = gsap.timeline({
      onComplete: finish,
      defaults: { ease: 'power2.out' }
    });

    /* ① 黑场标题：留一点呼吸时间，不急着“炫” */
    tl.to(curtain, {
      opacity: 0, y: -10, duration: 0.7, ease: 'power1.in',
      onComplete: function () {
        curtain.style.display = 'none';
        gsap.set(curtain, { y: 0 });
      }
    }, 0.55)

    /* ② 经典胶片倒计时 3·2·1 */
      .set(countdown, { display: 'block' }, 0.65)
      .to(countdown, { opacity: 1, duration: 0.28 }, 0.65);

    [3, 2, 1].forEach(function (n, idx) {
      var t = 0.85 + idx * 0.48;
      tl.call(function () { cdNum.textContent = n; }, null, t)
        .fromTo(cdNum,
          { scale: 1.22, opacity: 0 },
          { scale: 1, opacity: 1, duration: 0.22, ease: 'power3.out' },
          t
        )
        .fromTo(cdSweep,
          { rotation: 0 },
          { rotation: 360, duration: 0.44, ease: 'none', svgOrigin: '100 100' },
          t
        )
        .to(cdNum, { opacity: 0.34, duration: 0.2, ease: 'power1.in' }, t + 0.25);
    });

    tl.to(countdown, {
      opacity: 0, scale: 1.035, duration: 0.3, ease: 'power1.in'
    }, 2.25)
      .set(countdown, { display: 'none' }, 2.55)

    /* ③ 追光从上方落下，像电影院开灯，而不是舞台特效 */
      .to(spotlight, { opacity: 1, duration: 0.38 }, 2.38)
      .to(spotlight, {
        y: '0vh', scaleY: 1, duration: 0.78, ease: 'power2.inOut'
      }, 2.45)
      .to(poolFloor, { opacity: 0.72, duration: 0.65 }, 2.72)
      .to(dust, { opacity: 0.72, duration: 0.8 }, 2.78)

    /* ④ 海报从黑暗中缓慢浮出，再向真实卡片墙过渡 */
      .to(sprites, {
        opacity: 1, scale: 1, duration: 0.55,
        stagger: { each: 0.012, from: 'center' },
        ease: 'power2.out'
      }, 3.05)
      .to(sprites, {
        x: function () { return (Math.random() - 0.5) * window.innerWidth * 1.35; },
        y: function () { return (Math.random() - 0.5) * window.innerHeight * 1.15; },
        rotate: function () { return (Math.random() - 0.5) * 46; },
        rotateY: function () { return (Math.random() - 0.5) * 90; },
        scale: 0.5,
        opacity: 0,
        duration: 0.9,
        ease: 'power2.inOut',
        stagger: { each: 0.008, from: 'center' }
      }, 3.55)

    /* ⑤ 真正的卡片墙接管画面 */
      .add(function () { revealWall(); }, 4.05)
      .to(dust, { opacity: 0, duration: 0.55 }, 4.0)
      .set(lightSweep, { opacity: 1 }, 4.08)
      .fromTo(lightSweep,
        { xPercent: -140 },
        { xPercent: 140, duration: 0.8, ease: 'power2.inOut' },
        4.08
      )
      .to(prologue, {
        opacity: 0, duration: 0.65, ease: 'power2.inOut',
        onComplete: function () { prologue.style.display = 'none'; }
      }, 4.32)
      .to(hud, { opacity: 1, y: 0, duration: 0.5 }, 4.58);

    /* 地面轻震仅作为“胶片切入”的触感，不做连续抖动 */
    if (!reduced) {
      tl.to(prologue, { x: 1.5, duration: 0.045, yoyo: true, repeat: 3, ease: 'none' }, 2.42)
        .to(prologue, { x: 0, duration: 0.08 }, 2.65);
    }
  }

  function start() {
    if (state === 'playing') return;
    if (state === 'done') { replay(); return; }
    state = 'playing';
    Piano.begin();
    Piano.setLayer('prologue');
    if (!tl) build();
    return tl;
  }

  /* 从头再演一遍 */
  function replay() {
    if (tl) tl.pause(0);
    state = 'idle';
    tl = null;
    sprites = [];
    revealCalled = false;
    prologue.style.display = '';
    prologue.classList.remove('gone');
    gsap.set(prologue, { opacity: 1, x: 0 });
    gsap.set(curtain, { opacity: 1, display: 'flex' });
    build();
    start();
  }

  startBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    start();
  });

  skipBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    skip();
  });

  prologue.addEventListener('pointerdown', function (e) {
    if (state === 'playing' && !e.target.closest('#prologueStart')) skip();
  });

  window.Prologue = {
    start: start,
    skip: skip,
    replay: replay,
    state: function () { return state; }
  };
})();
