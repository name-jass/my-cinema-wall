/* ==========================================================================
   search.js —— 全库搜索面板（2402 条都能搜到）
   ========================================================================== */
(function () {
  'use strict';

  var input = document.getElementById('searchInput');
  var box = document.getElementById('searchBox');
  var panel = document.getElementById('searchPanel');
  var list = document.getElementById('searchList');
  var countEl = document.getElementById('searchCount');

  var PAGE = 50;
  var results = [];
  var shown = PAGE;
  var timer = null;

  function esc(t) { return Store.escapeHtml(t); }

  function lineOf(item) {
    var bits = [];
    if (item.type === 'book') {
      if (item.author) bits.push('作者 ' + item.author);
      if (item.year) bits.push(item.year);
    } else {
      if (item.director) bits.push('导演 ' + item.director);
      if (item.year) bits.push(item.year);
      if (item.genres) bits.push(item.genres);
    }
    var d = parseFloat(item.doubanRating);
    var db = isNaN(d) ? '' : '<b>豆瓣 ' + d.toFixed(1) + '</b>';
    return esc(bits.join(' · ')) + (db ? ' · ' + db : '');
  }

  function rowHtml(item) {
    var cover = Store.coverFor(item.key);
    var thumb = cover
      ? '<img src="' + esc(cover) + '" alt="" loading="lazy" onerror="this.remove()">'
      : '<div class="thumb" style="--hue:' + Store.hashHue(item.title) + '">' +
        esc(Store.firstChar(item.title)) + '</div>';
    var onWall = Store.isFeatured(item.key);
    var badges = '';
    if (onWall) badges += '<i class="onWall">已在卡片墙</i>';
    if (!cover) badges += '<i>无海报</i>';
    if (item.myRating) badges += '<i>我的 ' + item.myRating + ' 星</i>';

    return '<div class="result" data-key="' + esc(item.key) + '">' +
      thumb +
      '<div class="info">' +
        '<h3>' + esc(item.title) + '</h3>' +
        '<div class="line">' + lineOf(item) + '</div>' +
        (badges ? '<div class="tags-mini">' + badges + '</div>' : '') +
      '</div>' +
      '<div class="acts">' +
        '<button data-act="wall" class="' + (onWall ? '' : 'primary') + '">' +
          (onWall ? '移出卡片墙' : '加入卡片墙') + '</button>' +
        '<button data-act="cover">匹配海报</button>' +
        '<button data-act="detail">看详情</button>' +
      '</div>' +
    '</div>';
  }

  function render() {
    var slice = results.slice(0, shown);
    if (!slice.length) {
      var type = UI.currentType();
      list.innerHTML = '<div class="empty-tip">没有找到匹配的条目。<br>' +
        (type === 'all' ? '换个关键词试试，比如导演名、演员名、作者名。'
                        : '当前筛的是「' + (type === 'movie' ? '影视剧' : '书籍') +
                          '」，可以点上面的「全部」再搜一次。') +
        '<br><button class="btn" data-act="clear">清空搜索</button></div>';
      countEl.textContent = '';
      return;
    }
    var html = slice.map(rowHtml).join('');
    if (results.length > shown) {
      html += '<div class="empty-tip"><button class="btn" data-act="more">还有 ' +
        (results.length - shown) + ' 条，显示更多</button></div>';
    }
    list.innerHTML = html;
    countEl.textContent = '找到 ' + results.length + ' 条' +
      (results.length > shown ? '（显示前 ' + Math.min(shown, results.length) + '）' : '');
    Detail.setSequence(slice.map(function (i) { return i.key; }));
  }

  function open() { panel.classList.add('open'); }

  function close() {
    panel.classList.remove('open');
    UI.refreshHint();
  }

  function run(reset) {
    var q = input.value.trim();
    box.classList.toggle('has-text', !!q);
    if (reset) shown = PAGE;
    if (!q) {
      results = [];
      render();
      close();
      return;
    }
    results = Store.search(q, UI.currentType(), 600);
    render();
    open();
  }

  function clear() {
    input.value = '';
    box.classList.remove('has-text');
    results = [];
    list.innerHTML = '';
    countEl.textContent = '';
    close();
    input.focus();
  }

  input.addEventListener('input', function () {
    box.classList.toggle('has-text', !!input.value.trim());
    clearTimeout(timer);
    timer = setTimeout(function () { run(true); }, 130);
  });

  input.addEventListener('focus', function () { if (results.length) open(); });

  list.addEventListener('click', function (e) {
    var more = e.target.closest('[data-act="more"]');
    if (more) { shown += PAGE; render(); return; }
    var clr = e.target.closest('[data-act="clear"]');
    if (clr) { clear(); return; }

    var row = e.target.closest('.result');
    if (!row) return;
    var key = row.dataset.key;
    var btn = e.target.closest('[data-act]');
    var act = btn ? btn.dataset.act : 'detail';

    if (act === 'wall') {
      if (Store.isFeatured(key)) {
        Gallery.removeKey(key);
        UI.toast('已移出卡片墙');
      } else {
        Gallery.addKey(key, { focus: true });
        UI.toast('已放上卡片墙');
        close();
      }
      run(false);
    } else if (act === 'cover') {
      Covers.open(key);
    } else {
      if (Store.isFeatured(key)) {
        Gallery.cinematicFocus(key, function () { Detail.open(key, { cinematic: true }); });
      } else {
        Gallery.addKey(key, { focus: false });
        setTimeout(function () {
          Gallery.cinematicFocus(key, function () { Detail.open(key, { cinematic: true }); });
        }, 80);
      }
      close();
    }
  });

  document.addEventListener('keydown', function (e) {
    var key = e.key;
    var inField = e.target.matches && e.target.matches('input, textarea, select');
    if ((key === '/' && !inField) || ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'k')) {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (key === 'Escape') {
      if (panel.classList.contains('open')) { e.preventDefault(); close(); input.blur(); }
    }
  });

  document.getElementById('searchClear').addEventListener('click', clear);

  window.Search = {
    run: refresh,
    close: close,
    isOpen: function () { return panel.classList.contains('open'); },
    input: input
  };

  function refresh() {
    if (results.length) run(false);
  }
})();