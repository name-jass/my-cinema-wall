/* ==========================================================================
   quotes.js —— 背景氛围：电影史经典台词随机飘出、上浮、渐隐
   并发限制 3 条 + 纯 transform/opacity 动画（GPU 合成，不参与重排）
   ========================================================================== */
(function () {
  'use strict';

  var QUOTES = [
    { t: '人生就像一盒巧克力，你永远不知道下一颗是什么味道。', s: '阿甘正传' },
    { t: '如果有多一张船票，你会不会跟我走？', s: '花样年华' },
    { t: '世界上有那么多的城镇，城镇里有那么多的酒馆，她却走进了我的。', s: '卡萨布兰卡' },
    { t: '愿你出走半生，归来仍是少年。', s: '本杰明·巴顿奇事' },
    { t: '我不知道离别的滋味是这样凄凉，我不知道说声再见要这么坚强。', s: '千与千寻' },
    { t: '有些鸟儿是关不住的，它们的每一片羽毛都闪耀着自由的光辉。', s: '肖申克的救赎' },
    { t: '你要尽全力保护你的梦想。那些嘲笑你梦想的人，注定会失败。', s: '当幸福来敲门' },
    { t: '你以后想成为什么样的人？——什么意思，难道我以后就不能成为我自己吗？', s: '阿甘正传' },
    { t: '喜欢是放肆，但爱是克制。', s: '后会无期' },
    { t: '我猜中了前头，可是我猜不着这结局。', s: '大话西游' },
    { t: '那一刻，我很温暖。', s: '暖' },
    { t: '人生不能像做菜，把所有的料都准备好了才下锅。', s: '饮食男女' },
    { t: '有些人浅薄，有些人金玉其外败絮其中，但总有一天，你会遇到一个绚丽的人。', s: '怦然心动' },
    { t: '说好了一辈子，少一年、一个月、一天、一个时辰，都不是一辈子。', s: '霸王别姬' },
    { t: '我们一路奋战，不是为了改变世界，而是为了不让世界改变我们。', s: '熔炉' },
    { t: '其实了解一个人并不代表什么，人是会变的。', s: '重庆森林' },
    { t: '给你一个人生建议：跟我在一起。', s: '喜欢你' },
    { t: '生活不是我们活过的日子，而是我们记住的日子。', s: '央视 · 记住乡愁' },
    { t: '死亡不是生命的终点，遗忘才是。', s: '寻梦环游记' },
    { t: '不要等到失去，才懂得珍惜。', s: '岁月神偷' },
    { t: '如果你有梦想的话，就要去捍卫它。', s: '当幸福来敲门' },
    { t: '梦想使生活得以忍受。', s: '白日梦想家' },
    { t: '生命就像那空中白色的羽毛，或迎风搏击，或随风飘荡。', s: '阿甘正传' },
    { t: '念念不忘，必有回响。', s: '一代宗师' },
    { t: '见自己，见天地，见众生。', s: '一代宗师' },
    { t: '我的意中人是个盖世英雄，有一天他会踩着七色云彩来娶我。', s: '大话西游' },
    { t: '如果你不出去走走，你会以为这就是全世界。', s: '天堂电影院' },
    { t: '人生和电影不同，人生辛苦多了。', s: '天堂电影院' },
    { t: '不管前方的路有多苦，只要走的方向正确，都比站在原地更接近幸福。', s: '千与千寻' },
    { t: '发生过的事是不会忘记的，只是想不起来而已。', s: '千与千寻' },
    { t: '我们笑着说再见，却深知再见遥遥无期。', s: '海上钢琴师' },
    { t: '陆上的人喜欢寻根问底，虚度了大好光阴。', s: '海上钢琴师' },
    { t: '城市那么大，看不到尽头。', s: '海上钢琴师' },
    { t: '只要你装得很有钱，他们就会和你做朋友。', s: '西虹市首富' },
    { t: '人得自个儿成全自个儿。', s: '霸王别姬' },
    { t: '你的心也许会破碎，但人们依旧会像从前一样生活。', s: '四海' },
    { t: '每个人都会死去，但不是每个人都真正活过。', s: '勇敢的心' },
    { t: '把握当下吧，明天的事明天再说。', s: '乱世佳人' },
    { t: '毕竟，明天又是新的一天。', s: '乱世佳人' },
    { t: '恐惧囚禁人的灵魂，希望可以让你感受自由。', s: '肖申克的救赎' },
    { t: '希望是美好的，也许是人间至善，而美好的事物永不消逝。', s: '肖申克的救赎' },
    { t: '用回忆救赎自己，用真爱告别过去。', s: '爱在黎明破晓前' },
    { t: '如果再来一次，我还是会选你。', s: '时空恋旅人' },
    { t: '我们生活的每一天，都在穿越时空。我们能做的，就是尽其所能珍惜这段旅程。', s: '时空恋旅人' },
    { t: '这世上一定存在着某些美好，值得我们为之奋战到底。', s: '指环王' },
    { t: '即使在最黑暗的时刻，幸福也是有迹可循的。', s: '哈利·波特' },
    { t: '决定我们成为什么样人的，不是我们的能力，而是我们的选择。', s: '哈利·波特' },
    { t: '生活也许就是这样，一半是回忆，一半是继续。', s: '情书' },
    { t: '你好吗？我很好。', s: '情书' }
  ];

  var layer = document.getElementById('quotes');
  if (!layer) return;

  var MAX_ACTIVE = 3;                 // 同时最多飘 3 条，节省资源
  var active = 0;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function esc(t) {
    return String(t == null ? '' : t)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function spawn() {
    if (!document.hidden && !reduced && active < MAX_ACTIVE) {
      var q = QUOTES[Math.floor(Math.random() * QUOTES.length)];
      var el = document.createElement('figure');
      el.className = 'quote';
      el.innerHTML = '<blockquote>\u201C' + esc(q.t) + '\u201D</blockquote>' +
                     '<cite>—— ' + esc(q.s) + '</cite>';

      /* 随机落点：主要在两侧和上方，避开屏幕中心（不打扰看卡片） */
      var dice = Math.random(), x, y;
      if (dice < 0.44)      { x = 3 + Math.random() * 26; y = 14 + Math.random() * 68; }
      else if (dice < 0.88) { x = 62 + Math.random() * 28; y = 14 + Math.random() * 68; }
      else                  { x = 20 + Math.random() * 48; y = 6 + Math.random() * 16; }
      el.style.left = x + '%';
      el.style.top = y + '%';

      layer.appendChild(el);
      active++;

      /* 飘出 → 悬浮 → 上浮渐隐，全程 transform/opacity，GPU 合成 */
      var drift = (12 + Math.random() * 30).toFixed(1) + 'px';
      var anim = el.animate([
        { opacity: 0, transform: 'translate3d(0, 26px, 0) scale(.97)' },
        { opacity: .9, transform: 'translate3d(0, 8px, 0) scale(1)', offset: .16 },
        { opacity: .9, transform: 'translate3d(0, 0, 0) scale(1)', offset: .68 },
        { opacity: 0, transform: 'translate3d(' + drift + ', -64px, 0) scale(1.02)' }
      ], { duration: 12000 + Math.random() * 6000, easing: 'cubic-bezier(.4,.1,.4,1)' });

      anim.onfinish = function () { el.remove(); active--; };
      anim.oncancel = function () { if (el.parentNode) { el.remove(); } active--; };
    }
    schedule();
  }

  function schedule() {
    setTimeout(spawn, 5000 + Math.random() * 4500);
  }

  /* 稍等一会儿再开始：先让开场动画唱主角 */
  setTimeout(spawn, 9000);
})();
