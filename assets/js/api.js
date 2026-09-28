/* ==========================================================================
   api.js —— 和本机服务（tools/server.py）对话
   没有服务时自动进入只读模式，网页仍可正常浏览
   ========================================================================== */
(function () {
  'use strict';

  // 直接双击 index.html（file://）时，接口指向本机端口
  var BASE = (location.protocol === 'http:' || location.protocol === 'https:')
    ? '' : 'http://127.0.0.1:8765';

  var OFFLINE = '连不上本机服务：请关掉本页，双击项目里的「启动.bat」再打开。';

  function request(url, options, timeout) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var opts = options || {};
    if (ctrl) opts.signal = ctrl.signal;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout || 40000);

    return fetch(BASE + url, opts)
      .then(function (res) {
        return res.text().then(function (text) {
          var data;
          try { data = JSON.parse(text); } catch (e) { data = null; }
          if (!data) throw new Error('服务返回的内容看不懂（HTTP ' + res.status + '）');
          return data;
        });
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') throw new Error('等待超时，请稍后重试。');
        if (err && /Failed to fetch|NetworkError|Load failed/i.test(err.message || '')) {
          throw new Error(OFFLINE);
        }
        throw err;
      })
      .then(function (data) { clearTimeout(timer); return data; });
  }

  function get(url, timeout) { return request(url, { cache: 'no-store' }, timeout); }

  function post(url, body, isJson, timeout) {
    var headers = isJson ? { 'Content-Type': 'application/json' } : {};
    return request(url, { method: 'POST', headers: headers, body: body }, timeout);
  }

  function qs(params) {
    var parts = [];
    Object.keys(params).forEach(function (k) {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k] == null ? '' : params[k]));
    });
    return parts.join('&');
  }

  var API = {
    base: BASE,
    available: false,
    lastError: '',

    /* 启动时探测：拿到海报清单即视为可用 */
    probe: function () {
      return get('/api/covers', 8000)
        .then(function (data) {
          API.available = !!(data && data.ok);
          return API.available ? (data.covers || {}) : null;
        })
        .catch(function (err) {
          API.available = false;
          API.lastError = err.message || String(err);
          return null;
        });
    },

    /* 逐条自动匹配海报（服务端代去豆瓣取图并落盘） */
    match: function (item) {
      var url = '/api/match?' + qs({
        key: item.key, type: item.type, doubanId: item.doubanId,
        title: item.title, year: item.year
      });
      return get(url, 70000).then(function (data) {
        if (!data.ok) throw new Error(data.reason || '匹配失败');
        return data;
      });
    },

    /* 上传海报（服务端压缩成 webp 落盘） */
    upload: function (key, blob) {
      return post('/api/upload?' + qs({ key: key }), blob, false, 60000)
        .then(function (data) {
          if (!data.ok) throw new Error(data.reason || '上传失败');
          return data;
        });
    },

    /* 写回卡片墙清单 */
    saveFeatured: function (keys) {
      return post('/api/save', JSON.stringify({ featured: keys }), true)
        .then(function (data) {
          if (!data.ok) throw new Error(data.reason || '保存失败');
          return data;
        });
    },

    /* 写回新增条目 */
    saveNewItem: function (item) {
      return post('/api/save', JSON.stringify({ newItem: item }), true)
        .then(function (data) {
          if (!data.ok) throw new Error(data.reason || '保存失败');
          return data;
        });
    },

    /* 恢复默认封面：删掉本地海报文件 */
    resetCover: function (key) {
      return post('/api/save', JSON.stringify({ resetCover: key }), true)
        .then(function (data) {
          if (!data.ok) throw new Error(data.reason || '操作失败');
          return data;
        });
    }
  };

  window.API = API;
})();