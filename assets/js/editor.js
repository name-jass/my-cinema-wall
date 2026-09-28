/* ==========================================================================
   editor.js —— 网页内新增条目
   ========================================================================== */
(function () {
  'use strict';

  var modal = document.getElementById('editorModal');
  var f = {
    title: document.getElementById('edTitle'),
    type: document.getElementById('edType'),
    year: document.getElementById('edYear'),
    url: document.getElementById('edUrl'),
    douban: document.getElementById('edDoubanRating'),
    stars: document.getElementById('edStars'),
    creators: document.getElementById('edCreators'),
    creatorsLabel: document.getElementById('edCreatorsLabel'),
    creatorsTip: document.getElementById('edCreatorsTip'),
    intro: document.getElementById('edIntro'),
    review: document.getElementById('edReview'),
    titleTip: document.getElementById('edTitleTip'),
    urlTip: document.getElementById('edUrlTip'),
    save: document.getElementById('edSave')
  };
  var rating = 5;
  var busy = false;
  var LS_KEY = 'mcs.custom.items';

  function esc(t) { return Store.escapeHtml(t); }

  function paintStars() {
    var html = '';
    for (var i = 1; i <= 5; i++) {
      html += '<button type="button" class="' + (i <= rating ? 'on' : '') +
        '" data-star="' + i + '" title="' + i + ' 星">★</button>';
    }
    html += '<span class="val">' + (rating ? rating + ' 星（再点一次可取消）' : '未评分') + '</span>';
    f.stars.innerHTML = html;
  }

  function syncType() {
    var isBook = f.type.value === 'book';
    f.creatorsLabel.textContent = isBook ? '作者 / 出版社' : '导演 / 主演';
    f.creators.placeholder = isBook ? '[美]埃里克·H.克莱因 / 译林出版社'
                                   : '朱塞佩·托纳多雷 / 蒂姆·罗斯';
    f.creatorsTip.textContent = isBook
      ? '用「 / 」分隔，第一段当作者，其余当出版社。'
      : '用「 / 」分隔，第一段当导演，其余当主演。';
  }

  function extractId() {
    var m = String(f.url.value).match(/subject\/(\d+)/);
    return m ? m[1] : '';
  }

  function checkUrl() {
    var v = f.url.value.trim();
    if (!v) { f.urlTip.className = 'tip'; f.urlTip.textContent = '留空也可以，只是没法自动匹配海报。'; return ''; }
    var id = extractId();
    if (id) {
      f.urlTip.className = 'tip';
      f.urlTip.textContent = '识别到豆瓣 ID：' + id;
      return id;
    }
    f.urlTip.className = 'tip err';
    f.urlTip.textContent = '这个链接里没找到豆瓣 subject 编号，自动匹配会用不上（也可以先填着）。';
    return '';
  }

  function reset() {
    f.title.value = ''; f.year.value = ''; f.url.value = '';
    f.douban.value = ''; f.creators.value = ''; f.intro.value = ''; f.review.value = '';
    f.type.value = 'movie';
    rating = 5;
    f.titleTip.className = 'tip'; f.titleTip.textContent = '';
    checkUrl();
    syncType();
    paintStars();
  }

  function open() {
    reset();
    modal.classList.add('open');
    setTimeout(function () { f.title.focus(); }, 60);
  }

  function close() { modal.classList.remove('open'); }

  function buildItem(doubanId) {
    var creators = f.creators.value.split('/').map(function (s) { return s.trim(); })
      .filter(Boolean);
    var isBook = f.type.value === 'book';
    var item = {
      key: 'c_' + Date.now(),
      type: isBook ? 'book' : 'movie',
      doubanId: doubanId,
      title: f.title.value.trim(),
      url: f.url.value.trim(),
      year: f.year.value.trim(),
      regions: '', genres: '',
      director: !isBook && creators.length > 1 ? creators[0] : '',
      cast: !isBook ? creators.slice(creators.length > 1 ? 1 : 0).join(' / ') : '',
      author: isBook && creators.length ? creators[0] : '',
      publisher: isBook ? creators.slice(1).join(' / ') : '',
      doubanRating: f.douban.value.trim(),
      myRating: rating,
      review: f.review.value.trim(),
      tags: '',
      rawIntro: f.intro.value.trim(),
      createdAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      custom: true
    };
    if (isBook && !item.publisher && creators.length === 1) item.publisher = '';
    return item;
  }

  function saveLocal(items) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(items)); } catch (e) {}
  }

  function doSave() {
    if (busy) return;
    var title = f.title.value.trim();
    if (!title) {
      f.titleTip.className = 'tip err';
      f.titleTip.textContent = '标题不能为空，写个片名或书名吧。';
      f.title.focus();
      return;
    }
    var doubanId = checkUrl();
    var item = buildItem(doubanId);

    busy = true;
    f.save.disabled = true;
    f.save.textContent = '保存中…';

    var done = function (saved) {
      busy = false;
      f.save.disabled = false;
      f.save.textContent = '保存并加入卡片墙';
      Store.addItem(item);
      Gallery.addKey(item.key, { focus: true });
      UI.refreshSearch();
      close();
      UI.toast(saved ? '已保存：' + title : '已加入（本页临时）：' + title);

      if (doubanId && API.available) {
        API.match(item).then(function (data) {
          Store.setCover(item.key, data.cover);
          Gallery.updateCardPoster(item.key);
          UI.toast('海报也自动配好了：' + title);
        }).catch(function () {
          UI.toast('海报没匹配上，点卡片右上角的图标可以自己传一张。');
        });
      } else {
        UI.toast('想配海报的话，点卡片右上角的小图标即可。');
      }
    };

    if (API.available) {
      API.saveNewItem(item)
        .then(function () { done(true); })
        .catch(function (err) {
          saveLocal(Store.customItems());
          done(false);
          UI.toast('写入硬盘失败：' + err.message, true);
        });
    } else {
      saveLocal(Store.customItems());
      done(false);
      UI.toast('当前是只读模式，这条只存在本页；双击「启动.bat」后新增才能永久保存。', true);
    }
  }

  modal.addEventListener('click', function (e) {
    if (e.target === modal || e.target.closest('[data-close]')) { close(); return; }
    var star = e.target.closest('[data-star]');
    if (star) {
      var v = parseInt(star.dataset.star, 10);
      rating = (rating === v) ? 0 : v;
      paintStars();
      return;
    }
    if (e.target.closest('#edSave')) doSave();
  });

  f.type.addEventListener('change', syncType);
  f.url.addEventListener('blur', checkUrl);
  f.url.addEventListener('input', function () {
    if (f.urlTip.className.indexOf('err') >= 0) checkUrl();
  });

  document.addEventListener('keydown', function (e) {
    if (!modal.classList.contains('open')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSave();
  });

  window.Editor = {
    open: open,
    close: close,
    localStorageKey: LS_KEY
  };
})();