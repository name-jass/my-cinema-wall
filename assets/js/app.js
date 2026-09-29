/* ==========================================================================
   app.js —— 总装：加载数据、探测本机服务、接 HUD、开序幕
   ========================================================================== */
(function () {
  'use strict';

  var type = 'all';
  var toastTimer = null;

  /* ---------------------------------------------------------------- UI 小工具 */
  var UI = {
    toast: function (message, isError) {
      var el = document.getElementById('toast');
      el.textContent = message;
      el.className = 'show' + (isError ? ' err' : '');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { el.className = ''; }, isError ? 5200 : 3200);
    },

    currentType: function () { return type; },

    setType: function (next) {
      type = next;
      var seg = document.getElementById('typeSeg');
      Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) {
        b.classList.toggle('active', b.dataset.type === type);
      });
    },

    /* 卡片墙当前要显示的成员（受「影视剧 / 书籍」切换影响） */
    wallKeys: function () {
      var keys = Store.featured();
      if (type === 'all') return keys;
      return keys.filter(function (k) {
        var it = Store.byKey(k);
        return it && it.type === type;
      });
    },

    refreshWall: function () { Gallery.render(UI.wallKeys(), { animate: false }); },

    refreshSearch: function () { if (window.Search) Search.run(); },

    refreshHint: function () {
      var hint = document.getElementById('hudMinimapHint');
      if (!hint) return;
      if (Search.isOpen()) hint.style.opacity = '0';
    },

    closeModals: function () {
      Detail.close();
      Covers.close();
      Editor.close();
    }
  };
  window.UI = UI;

  /* ---------------------------------------------------------------- 数据加载 */
  function fetchJson(path) {
    return fetch(path, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  function readLocalCustom() {
    try {
      var raw = localStorage.getItem(Editor.localStorageKey);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function dedupe(list) {
    var seen = {}, out = [];
    list.forEach(function (it) {
      if (it && it.key && !seen[it.key]) { seen[it.key] = 1; out.push(it); }
    });
    return out;
  }

  function defaultFeaturedKeys() {
    // 读不到 data/featured.json（比如直接双击 index.html）时的兜底：
    // 全库上墙 —— 没海报的条目用兜底封面，等之后手动补海报
    var items = (window.LIBRARY && window.LIBRARY.items) || [];
    return items.map(function (i) { return i.key; });
  }

  /* ---------------------------------------------------------------- 启动 */
  function boot() {
    if (!window.LIBRARY) {
      UI.toast('数据没加载出来：请确认 data/library.js 存在（跑一次「更新数据.bat」即可）。', true);
      return;
    }

    API.probe().then(function (covers) {
      if (!API.available) {
        document.getElementById('readonlyBar').classList.remove('hidden');
      }
      var jobs = [
        fetchJson('data/featured.json').catch(function () { return null; }),
        fetchJson('data/custom_items.json').catch(function () { return null; })
      ];
      return Promise.all(jobs).then(function (res) {
        var featured = res[0] && Array.isArray(res[0].keys) ? res[0].keys : null;
        var serverCustom = res[1] && Array.isArray(res[1].items) ? res[1].items : [];
        return { covers: covers || {}, featured: featured, custom: serverCustom };
      });
    }).then(function (pack) {
      var custom = dedupe(pack.custom.concat(readLocalCustom()));
      Store.init({
        covers: pack.covers,
        featured: pack.featured || defaultFeaturedKeys(),
        custom: custom,
        mode: API.available ? 'live' : 'readonly'
      });

      Gallery.mount({
        keys: UI.wallKeys,
        onOpenDetail: function (key) {
          Detail.setSequence(UI.wallKeys());
          Gallery.cinematicFocus(key, function () { Detail.open(key, { cinematic: true }); });
        }
      });

      Gallery.render(UI.wallKeys(), { animate: false });
      wireHud();
      syncMuteIcon();

      // 一律等用户点「点击启幕」——浏览器要求先有交互才允许放声音。
      // （系统开了「减少动态效果」时序幕照演，只是不做镜头震动，见 prologue.js）
      document.getElementById('prologueStart').focus({ preventScroll: true });

      if (API.available) {
        var saved = Store.featured().length;
        var fresh = (pack.featured || []).length;
        if (fresh === 0 && saved > 0) {
          // 第一次运行：把默认的五星卡片墙写盘
          API.saveFeatured(Store.featured()).catch(function () {});
        }
      }
    }).catch(function (err) {
      UI.toast('启动出错：' + (err && err.message ? err.message : err), true);
    });
  }

  /* ---------------------------------------------------------------- HUD */
  function wireHud() {
    document.getElementById('typeSeg').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-type]');
      if (!btn) return;
      UI.setType(btn.dataset.type);
      UI.refreshWall();
      UI.refreshSearch();
    });

    document.getElementById('sortBtn').addEventListener('click', function () {
      Gallery.nextSort();
      document.getElementById('sortLabel').textContent = Gallery.sortLabel();
      UI.toast('排序：' + Gallery.sortLabel());
    });

    document.getElementById('randomBtn').addEventListener('click', function () {
      var key = Gallery.randomKey();
      if (!key) { UI.toast('卡片墙上还没有卡片'); return; }
      Gallery.focusKey(key);
      var item = Store.byKey(key);
      if (item) UI.toast('漫游到：' + item.title);
    });

    document.getElementById('addBtn').addEventListener('click', function () {
      Editor.open();
    });

    document.getElementById('replayBtn').addEventListener('click', function () {
      Prologue.replay();
    });

    document.getElementById('muteBtn').addEventListener('click', function () {
      Piano.toggleMute();
      syncMuteIcon();
      UI.toast(Piano.isMuted() ? '音乐已关' : '音乐已开');
    });
  }

  function syncMuteIcon() {
    var btn = document.getElementById('muteBtn');
    var muted = Piano.isMuted();
    btn.classList.toggle('playing', !muted);
    btn.title = muted ? '音乐已关（点击开启）' : '音乐开着（点击关闭）';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();