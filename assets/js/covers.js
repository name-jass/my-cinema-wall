/* ==========================================================================
   covers.js —— 海报管理：自动匹配 / 手动上传 / 恢复默认
   逐条操作，天然省资源；离线时降级为「仅本次浏览有效」的临时替换
   ========================================================================== */
(function () {
  'use strict';

  var modal = document.getElementById('coverModal');
  var frame = document.getElementById('coverFrame');
  var metaEl = document.getElementById('coverMeta');
  var drop = document.getElementById('coverDrop');
  var fileInput = document.getElementById('coverFile');
  var statusEl = document.getElementById('coverStatus');
  var subEl = document.getElementById('coverSub');
  var btnMatch = document.getElementById('coverMatch');
  var btnPick = document.getElementById('coverPick');
  var btnReset = document.getElementById('coverReset');

  var current = null;
  var busy = false;
  var tempUrls = [];

  function esc(t) { return Store.escapeHtml(t); }

  function humanSize(bytes) {
    if (!bytes) return '—';
    return bytes > 1024 * 1024
      ? (bytes / 1024 / 1024).toFixed(2) + ' MB'
      : Math.round(bytes / 1024) + ' KB';
  }

  function status(text, cls) {
    statusEl.className = cls || '';
    statusEl.innerHTML = text || '';
  }

  function paintFrame(item) {
    var cover = Store.coverFor(item.key);
    frame.innerHTML = (cover ? '<img src="' + esc(cover) + '" alt="" onerror="this.remove()">' : '') +
      Store.fallbackHtml(item);
    var path = cover || '';
    var isTemp = /^blob:|^data:/.test(path);
    metaEl.innerHTML =
      '<b>' + esc(item.title) + '</b><br>' +
      (item.type === 'book' ? '书籍' : '影视剧') +
      (item.doubanId ? ' · 豆瓣 ID ' + esc(item.doubanId) : ' · 没有豆瓣链接') + '<br>' +
      '当前海报：' + (path ? (isTemp ? '临时预览（刷新后失效）' : '已保存到本地') : '默认兜底封面') +
      '<div class="path">' + esc(path || 'assets/covers/' + item.key + '.webp') + '</div>';
  }

  function open(key) {
    var item = Store.byKey(key);
    if (!item) return;
    current = key;
    paintFrame(item);
    subEl.textContent = API.available
      ? '可以自动匹配，也可以上传你喜欢的图片（会自动压成小尺寸 webp 存在本地）。'
      : '当前没有连上本机服务：可以浏览，但匹配/上传只能本页临时预览。';
    status('');
    btnReset.disabled = !Store.coverFor(key);
    modal.classList.add('open');
  }

  function close() {
    modal.classList.remove('open');
    current = null;
  }

  function afterCoverChanged() {
    if (!current) return;
    Gallery.updateCardPoster(current);
    if (Detail.isOpen()) Detail.refresh();
    paintFrame(Store.byKey(current));
    btnReset.disabled = !Store.coverFor(current);
    UI.refreshSearch();
  }

  /* ---------------------------------------------------------------- 自动匹配 */
  function doMatch() {
    if (busy || !current) return;
    if (!API.available) {
      status('没有连上本机服务，暂时不能自动匹配。请双击「启动.bat」后重试，或直接手动上传。', 'err');
      return;
    }
    var item = Store.byKey(current);
    busy = true;
    btnMatch.disabled = true;
    status('正在向豆瓣取图，可能要等几秒…', 'busy');
    API.match(item).then(function (data) {
      Store.setCover(current, data.cover);
      afterCoverChanged();
      status('匹配成功（' + (data.match === 'exact' ? '精确匹配' : '近似匹配') +
        '），已保存 ' + humanSize(data.bytes) + '。', 'ok');
    }).catch(function (err) {
      status(esc(err.message) + '<br>可以点下面的「手动上传」自己选一张。', 'err');
      drop.classList.add('over');
    }).then(function () {
      busy = false;
      btnMatch.disabled = false;
    });
  }

  /* ---------------------------------------------------------------- 手动上传 */
  function localPreview(file) {
    var url = URL.createObjectURL(file);
    tempUrls.push(url);
    Store.setCover(current, url);
    afterCoverChanged();
    status('图片只在本页临时显示（刷新后会恢复原样）。', 'err');
  }

  function uploadFile(file) {
    if (busy || !current || !file) return;
    if (!/^image\//.test(file.type || '')) {
      status('这不是图片文件，请选一张图片。', 'err');
      return;
    }
    if (!API.available) { localPreview(file); return; }

    busy = true;
    btnPick.disabled = true;
    status('正在压缩并保存…', 'busy');

    // 先给个临时预览，服务端压完再换成正式文件
    var url = URL.createObjectURL(file);
    tempUrls.push(url);
    Store.setCover(current, url);
    afterCoverChanged();

    API.upload(current, file).then(function (data) {
      Store.setCover(current, data.cover);
      afterCoverChanged();
      status('已保存到本地：' + humanSize(data.originalBytes) + ' → ' +
        humanSize(data.bytes) + '（webp）。', 'ok');
    }).catch(function (err) {
      status('保存失败：' + esc(err.message) + '，本页先临时预览。', 'err');
    }).then(function () {
      busy = false;
      btnPick.disabled = false;
    });
  }

  /* ---------------------------------------------------------------- 恢复默认 */
  function doReset() {
    if (busy || !current) return;
    if (!API.available) {
      Store.setCover(current, '');
      afterCoverChanged();
      status('已恢复成默认封面（只影响本页，硬盘上的文件没动）。', 'err');
      return;
    }
    busy = true;
    btnReset.disabled = true;
    status('正在恢复…', 'busy');
    API.resetCover(current).then(function () {
      Store.setCover(current, '');
      afterCoverChanged();
      status('已恢复成默认封面。下次双击「更新数据.bat」会重新抓一次。', 'ok');
    }).catch(function (err) {
      status('操作失败：' + esc(err.message), 'err');
    }).then(function () {
      busy = false;
      btnReset.disabled = !Store.coverFor(current);
    });
  }

  /* ---------------------------------------------------------------- 事件绑定 */
  modal.addEventListener('click', function (e) {
    var closeBtn = e.target.closest('[data-close]');
    if (closeBtn || e.target === modal) { close(); return; }
    if (e.target.closest('#coverMatch')) doMatch();
    else if (e.target.closest('#coverPick') || e.target.closest('#coverDrop')) fileInput.click();
  });

  fileInput.addEventListener('change', function () {
    if (fileInput.files && fileInput.files[0]) uploadFile(fileInput.files[0]);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(function (evt) {
    drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (evt) {
    drop.addEventListener(evt, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });

  modal.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image') === 0) {
        var file = items[i].getAsFile();
        if (file) { e.preventDefault(); uploadFile(file); return; }
      }
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modal.classList.contains('open')) close();
  });

  window.addEventListener('beforeunload', function () {
    tempUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (err) {} });
  });

  window.Covers = {
    open: open,
    close: close,
    isOpen: function () { return modal.classList.contains('open'); }
  };
})();