/* ==========================================================================
   detail.js —— 详情弹窗（幕布拉开式）
   ========================================================================== */
(function () {
  'use strict';

  var modal = document.getElementById('detailModal');
  var posterEl = document.getElementById('detailPoster');
  var bodyEl = document.getElementById('detailBody');
  var current = null;
  var sequence = [];
  var lastFocus = null;

  function esc(t) { return Store.escapeHtml(t); }

  function posterHtml(item) {
    var cover = Store.coverFor(item.key);
    var img = cover
      ? '<img src="' + esc(cover) + '" alt="" onerror="this.remove()">'
      : '';
    return img + Store.fallbackHtml(item) +
      '<span class="kind">' + (item.type === 'book' ? '书籍' : '影视剧') + '</span>' +
      '<button class="btn change" data-detail-act="cover">换海报</button>';
  }

  function ratingHtml(item) {
    var d = parseFloat(item.doubanRating);
    var mine = item.myRating;
    return '' +
      '<div class="rating-compare">' +
        '<div class="col"><div class="label">豆瓣评分</div>' +
          '<div class="value">' + (isNaN(d) ? '—' : d.toFixed(1)) + '<small>/ 10</small></div></div>' +
        '<div class="col mine"><div class="label">我的评分</div>' +
          (mine ? '<div class="value">' + mine + '<small>/ 5</small></div>' +
                  '<div class="stars" style="font-size:12px">' + Store.starsHtml(mine) + '</div>'
                : '<div class="value empty">还没打分</div>') +
        '</div>' +
      '</div>';
  }

  function creatorsHtml(item) {
    if (item.type === 'book') {
      var rows = [];
      if (item.author) rows.push(['作者', item.author]);
      if (item.publisher) rows.push(['出版社', item.publisher]);
      if (!rows.length) return '';
      return rows.map(function (r) {
        return '<div class="detail-section"><div class="label">' + r[0] +
          '</div><div class="value">' + esc(r[1]) + '</div></div>';
      }).join('');
    }
    var html = '';
    if (item.director) {
      html += '<div class="detail-section"><div class="label">导演</div><div class="value">' +
        esc(item.director) + '</div></div>';
    }
    if (item.cast) {
      html += '<div class="detail-section"><div class="label">主演</div><div class="value">' +
        esc(item.cast) + '</div></div>';
    }
    return html;
  }

  function bodyHtml(item) {
    var chips = [];
    if (item.year) chips.push(item.year);
    if (item.type === 'book') {
      if (item.publisher) chips.push(item.publisher);
    } else {
      if (item.regions) chips.push(item.regions);
      if (item.genres) chips.push(item.genres);
    }
    if (item.tags) chips.push(item.tags);
    if (item.custom) chips.push('我新增的');

    var onWall = Store.isFeatured(item.key);
    return '' +
      '<h2 id="detailTitle">' + esc(item.title) + '</h2>' +
      '<div class="chips">' + chips.map(function (c) {
        return '<span>' + esc(c) + '</span>';
      }).join('') + '</div>' +
      ratingHtml(item) +
      creatorsHtml(item) +
      (item.review ? '<div class="detail-section"><div class="label">我的评论</div>' +
        '<div class="detail-review">' + esc(item.review) + '</div></div>' : '') +
      (item.rawIntro ? '<div class="detail-section"><div class="label">简介</div>' +
        '<div class="value">' + esc(item.rawIntro) + '</div></div>' : '') +
      (item.createdAt ? '<div class="detail-section"><div class="label">收录时间</div>' +
        '<div class="value">' + esc(String(item.createdAt).slice(0, 10)) + '</div></div>' : '') +
      '<div class="detail-foot">' +
        (item.url ? '<a class="btn gold" href="' + esc(item.url) +
          '" target="_blank" rel="noopener">在豆瓣查看</a>' : '') +
        '<button class="btn" data-detail-act="wall">' +
          (onWall ? '移出卡片墙' : '加入卡片墙') + '</button>' +
        '<button class="btn" data-detail-act="cover">换海报</button>' +
      '</div>';
  }

  function paint() {
    if (!current) return;
    var item = Store.byKey(current);
    if (!item) { close(); return; }
    posterEl.innerHTML = posterHtml(item);
    bodyEl.innerHTML = bodyHtml(item);
    bodyEl.scrollTop = 0;
  }

  function open(key) {
    if (!Store.byKey(key)) return;
    lastFocus = document.activeElement;
    current = key;
    paint();
    modal.classList.add('open');
    var closeBtn = modal.querySelector('.panel-close');
    if (closeBtn) closeBtn.focus({ preventScroll: true });
  }

  function close() {
    modal.classList.remove('open');
    current = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }

  function step(delta) {
    if (!sequence.length || !current) return;
    var i = sequence.indexOf(current);
    if (i < 0) return;
    var next = sequence[(i + delta + sequence.length) % sequence.length];
    if (next) open(next);
  }

  modal.addEventListener('click', function (e) {
    if (e.target === modal) { close(); return; }
    var closeBtn = e.target.closest('[data-close]');
    if (closeBtn) { close(); return; }

    var act = e.target.closest('[data-detail-act]');
    if (!act || !current) return;
    var kind = act.dataset.detailAct;
    if (kind === 'cover') { Covers.open(current); return; }
    if (kind === 'wall') {
      if (Store.isFeatured(current)) {
        Gallery.removeKey(current);
        UI.toast('已移出卡片墙');
      } else {
        Gallery.addKey(current, { focus: true });
        UI.toast('已加入卡片墙');
      }
      paint();
      UI.refreshSearch();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (!modal.classList.contains('open')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });

  window.Detail = {
    open: open,
    close: close,
    refresh: paint,
    isOpen: function () { return modal.classList.contains('open'); },
    setSequence: function (keys) { sequence = (keys || []).slice(); },
    current: function () { return current; }
  };
})();