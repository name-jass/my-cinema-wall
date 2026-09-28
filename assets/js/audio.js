/* ==========================================================================
   audio.js —— 程序合成钢琴（零音频文件、完全离线）
   每个音用多个谐波振荡器 + 指数衰减包络模拟钢琴；卷积混响用程序生成的白噪声
   ========================================================================== */
(function () {
  'use strict';

  var LS_KEY = 'mcs.muted';
  var ctx = null, master = null, wet = null;
  var muted = localStorage.getItem(LS_KEY) === '1';
  var started = false;
  var layer = 'prologue';
  var timer = null;
  var nextTime = 0;

  // A 小调音阶（低音区给序幕，中音区给主舞台）
  var LOW = [110.00, 130.81, 164.81, 196.00, 220.00, 246.94, 261.63];
  var MID = [220.00, 261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33];
  var HIGH = [659.25, 783.99, 880.00, 1046.50];

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function makeImpulse(seconds, decay) {
    var rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    var buf = ctx.createBuffer(2, len, rate);
    for (var ch = 0; ch < 2; ch++) {
      var data = buf.getChannelData(ch);
      for (var i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function ensure() {
    if (ctx) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();

    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.42;

    var dry = ctx.createGain();
    dry.gain.value = 0.82;

    var conv = ctx.createConvolver();
    conv.buffer = makeImpulse(2.6, 2.4);
    wet = ctx.createGain();
    wet.gain.value = 0.3;

    master.connect(dry);
    dry.connect(ctx.destination);
    master.connect(conv);
    conv.connect(wet);
    wet.connect(ctx.destination);
    return true;
  }

  function voice(freq, at, dur, level) {
    var partials = [[1, 1], [2, 0.42], [3, 0.21], [4, 0.11], [5, 0.055], [6, 0.03]];
    var env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.linearRampToValueAtTime(level, at + 0.014);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    env.connect(master);

    for (var i = 0; i < partials.length; i++) {
      var osc = ctx.createOscillator();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.value = freq * partials[i][0];
      osc.detune.value = (Math.random() * 9 - 4.5);
      var hg = ctx.createGain();
      hg.gain.value = partials[i][1];
      osc.connect(hg);
      hg.connect(env);
      osc.start(at);
      osc.stop(at + dur + 0.06);
    }
  }

  function chord(root, at, dur, level) {
    [1, 1.5, 2.4].forEach(function (r, i) { voice(root * r, at + i * 0.03, dur, level * 0.7); });
  }

  /* 一直往前排：稀疏、缓慢、带随机休止 → 不腻 */
  function schedule() {
    if (!started || !ctx) return;
    var ahead = ctx.currentTime + 2.0;
    while (nextTime < ahead) {
      var t = nextTime;
      if (layer === 'prologue') {
        chord(pick(LOW.slice(0, 4)) / 2, t, 3.4, 0.16);
        if (Math.random() < 0.5) voice(pick(LOW), t + 0.6, 2.2, 0.07);
        nextTime += 1.7 + Math.random() * 1.5;
      } else {
        if (Math.random() < 0.85) voice(pick(MID), t, 2.0 + Math.random(), 0.09);
        if (Math.random() < 0.35) voice(pick(MID), t + 0.34, 1.6, 0.06);
        if (Math.random() < 0.16) voice(pick(HIGH), t + 0.7, 2.6, 0.035);
        if (Math.random() < 0.22) chord(pick(LOW.slice(0, 5)) / 2, t, 3.0, 0.09);
        nextTime += 1.1 + Math.random() * 1.6;
      }
    }
  }

  function start() {
    if (!ensure()) return;
    if (ctx.state === 'suspended') ctx.resume();
    if (started) return;
    started = true;
    nextTime = ctx.currentTime + 0.15;
    schedule();
    timer = setInterval(schedule, 420);
  }

  function setLayer(name) {
    layer = name === 'main' ? 'main' : 'prologue';
  }

  function applyGain(animateSeconds) {
    if (!ctx || !master) return;
    var target = muted ? 0.0001 : 0.42;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setTargetAtTime(target, ctx.currentTime, animateSeconds || 0.25);
  }

  function toggleMute() {
    muted = !muted;
    localStorage.setItem(LS_KEY, muted ? '1' : '0');
    applyGain(0.2);
    applyFileGain();
    return muted;
  }

  function setMuted(value) {
    muted = !!value;
    localStorage.setItem(LS_KEY, muted ? '1' : '0');
    applyGain(0.2);
    applyFileGain();
    return muted;
  }

  document.addEventListener('visibilitychange', function () {
    if (!ctx || !started) return;
    if (document.hidden) { if (ctx.state === 'running') ctx.suspend(); }
    else if (ctx.state === 'suspended' && !muted) ctx.resume();
  });

  var preferFile = false;
  var fileAudio = null;

  function stopProcedural() {
    if (timer) { clearInterval(timer); timer = null; }
    started = false;
    if (ctx && master) master.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.2);
  }

  /* 如果你以后往 assets/audio/piano.mp3 放了曲子，就自动改放它 */
  function tryExternalFile() {
    try {
      var a = new Audio();
      a.src = 'assets/audio/piano.mp3';
      a.loop = true;
      a.volume = muted ? 0 : 0.5;
      var settled = false;
      a.addEventListener('canplaythrough', function () {
        if (settled) return;
        settled = true;
        preferFile = true;
        fileAudio = a;
        stopProcedural();
        applyFileGain();
        a.play().catch(function () {});
      });
      a.addEventListener('error', function () { settled = true; });
      setTimeout(function () { settled = true; }, 1800);
    } catch (e) { /* 没有就算了 */ }
  }

  function applyFileGain() {
    if (fileAudio) fileAudio.volume = muted ? 0 : 0.5;
  }

  function begin() {
    start();              // 点下去立刻有声音，别让用户等
    tryExternalFile();    // 同时看看有没有更好听的现成曲子
  }

  window.Piano = {
    begin: begin,
    setLayer: setLayer,
    toggleMute: toggleMute,
    setMuted: setMuted,
    isMuted: function () { return muted; },
    supports: function () { return !!(window.AudioContext || window.webkitAudioContext); }
  };
})();