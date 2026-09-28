# -*- coding: utf-8 -*-
"""
数据管线：解析豆伴导出的 Excel → 生成网页数据 → 抓取五星条目的海报。

产出：
  data/library.js        全量条目（结构化、不含封面路径），只读
  data/featured.json     卡片墙成员清单（默认 = 我的评分 5 星的条目）
  assets/covers/<key>.*  五星条目的海报（约 252 张）
  tools/cache/cover_urls.json     已解析到的海报地址（重跑时不再请求豆瓣）
  tools/cache/cover_manifest.json 已下载好的封面清单
  tools/cache/cover_failed.json   失败清单，重跑时自动重试

豆瓣没有开放官方 API，所以这里的抓取刻意保守：
单线程、每次请求间隔 3–6 秒、已成功的绝不重抓、连续被拒 3 次就整体停下保护 IP。
正常情况下只需要跑一次，图片就永久落在本地了。

用法：
  python tools/fetch_covers.py                 # 抓所有缺的封面
  python tools/fetch_covers.py --only-failed   # 只重试上次失败的（走豆瓣）
  python tools/fetch_covers.py --from-baidu    # 失败清单改从百度图片补（不封 IP）
"""
import io
import json
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request
import zipfile

try:
    from PIL import Image
    HAS_PIL = True
except Exception:
    HAS_PIL = False

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
COVERS_DIR = os.path.join(ROOT, "assets", "covers")
CACHE_DIR = os.path.join(ROOT, "tools", "cache")
MANIFEST_PATH = os.path.join(CACHE_DIR, "cover_manifest.json")
FAILED_PATH = os.path.join(CACHE_DIR, "cover_failed.json")
URL_CACHE_PATH = os.path.join(CACHE_DIR, "cover_urls.json")

# 兜底：找不到 data/*.xlsx 时使用最初上传的那份
FALLBACK_XLSX = (r"c:\Users\M\.trae-cn\attachments\6aba4e503dad3f900f5933ea"
                 r"\63fddcbc-0f76-466e-aacc-0329195c150d_豆伴(46910768).xlsx")

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
    "Referer": "https://movie.douban.com/",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

# 类型词表：用于从「简介」里识别类型那一节
GENRE_WORDS = set("""
剧情 喜剧 动作 爱情 科幻 动画 悬疑 惊悚 恐怖 犯罪 纪录片 战争 奇幻 冒险 灾难 武侠 古装
历史 音乐 歌舞 家庭 儿童 传记 运动 短片 情色 同性 西部 鬼怪 黑色电影 真人秀 脱口秀 真人
舞台艺术 戏曲 新闻 纪实 运动 惊栗 恐怖片 冒险片 科幻片
""".split())

MAX_COVER_WIDTH = 600


# ----------------------------------------------------------------------------- Excel

def _cell_value(attrs, body, shared):
    vm = re.search(r"<v>(.*?)</v>", body, re.S)
    if not vm:
        # 内联字符串
        im = re.search(r"<t[^>]*>(.*?)</t>", body, re.S)
        return _unescape(im.group(1)) if im else ""
    raw = vm.group(1)
    if "t=" in attrs:
        try:
            return shared[int(raw)]
        except (ValueError, IndexError):
            return raw
    return raw


def _unescape(text):
    return (text.replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", '"').replace("&apos;", "'")
                .replace("&#10;", "\n").replace("&amp;", "&"))


def read_sheet(zf, shared, sheet_path):
    xml = zf.read(sheet_path).decode("utf-8", "ignore")
    rows = []
    for row_xml in re.findall(r"<row[^>]*>(.*?)</row>", xml, re.S):
        cells = {}
        for col, attrs, body in re.findall(
                r"<c r=\x22([A-Z]+)\d+\x22([^>]*)>(.*?)</c>", row_xml, re.S):
            cells[col] = _cell_value(attrs, body, shared)
        rows.append(cells)
    return rows


def load_excel():
    candidates = []
    if os.path.isdir(DATA_DIR):
        candidates = [os.path.join(DATA_DIR, f) for f in os.listdir(DATA_DIR)
                      if f.lower().endswith(".xlsx") and not f.startswith("~$")]
    if not candidates and os.path.exists(FALLBACK_XLSX):
        candidates = [FALLBACK_XLSX]
    if not candidates:
        raise SystemExit("找不到 Excel：请把豆伴导出的 .xlsx 放到 data\\ 目录下")

    path = max(candidates, key=os.path.getmtime)
    print("读取 Excel：%s" % path)

    with zipfile.ZipFile(path) as zf:
        sst = zf.read("xl/sharedStrings.xml").decode("utf-8", "ignore")
        shared = [_unescape("".join(re.findall(r"<t[^>]*>(.*?)</t>", si, re.S)))
                  for si in re.findall(r"<si>(.*?)</si>", sst, re.S)]
        sheet_files = sorted(n for n in zf.namelist()
                             if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
        movies, books = [], []
        for idx, sf in enumerate(sheet_files):
            rows = read_sheet(zf, shared, sf)
            if not rows:
                continue
            first = rows[0].get("A", "")
            if first != "标题":          # 跳过非数据表
                continue
            target = movies if idx == 0 else books
            target.extend(rows[1:])
    return movies, books


# ----------------------------------------------------------------------------- 解析

def _to_int(text, default=0):
    try:
        return int(float(str(text).strip()))
    except (TypeError, ValueError):
        return default


def _split_intro(intro):
    return [p.strip() for p in re.split(r"\s*/\s*", intro) if p.strip()]


def parse_movie_intro(intro):
    """影视剧简介：2026 / 美国 / 动作 历史 / 克里斯托弗·诺兰 / 马特·达蒙 汤姆·霍兰德"""
    out = {"year": "", "regions": "", "genres": "", "director": "", "cast": ""}
    parts = _split_intro(intro)
    if not parts:
        return out, False

    year_idx = -1
    for i, p in enumerate(parts):
        if re.match(r"^\d{4}(\s*[-–—]\s*\d{2,4})?$", p):
            year_idx = i
            break

    genre_idx = -1
    best = 0.0
    for i, p in enumerate(parts):
        if i == year_idx:
            continue
        tokens = re.split(r"[\s　]+", p)
        if not tokens:
            continue
        hits = sum(1 for t in tokens if t in GENRE_WORDS)
        ratio = hits / float(len(tokens))
        if hits and ratio > best:
            best, genre_idx = ratio, i

    if year_idx >= 0:
        out["year"] = parts[year_idx]
    if genre_idx >= 0:
        out["genres"] = parts[genre_idx]

    # 地区：年份之后、类型之前的那一节；若无类型则取年份后第一节
    start = (year_idx + 1) if year_idx >= 0 else 0
    end = genre_idx if genre_idx >= 0 else len(parts)
    region_parts = [p for p in parts[start:end] if p]
    if region_parts:
        out["regions"] = region_parts[0]

    # 主创：类型之后的所有节；>=2 节时第一节为导演，其余为主演
    if genre_idx >= 0 and genre_idx + 1 < len(parts):
        creators = parts[genre_idx + 1:]
        if len(creators) >= 2:
            out["director"] = creators[0]
            out["cast"] = " / ".join(creators[1:])
        else:
            out["cast"] = creators[0]
    elif genre_idx < 0 and len(parts) > 3:
        creators = parts[3:]
        if len(creators) >= 2:
            out["director"], out["cast"] = creators[0], " / ".join(creators[1:])
        else:
            out["cast"] = creators[0]

    ok = bool(out["year"] and out["regions"])
    return out, ok


def parse_book_intro(intro):
    """书籍简介：[美]埃里克•H.克莱因 / 2022 / 译林出版社"""
    out = {"author": "", "year": "", "publisher": ""}
    parts = _split_intro(intro)
    if not parts:
        return out, False
    out["author"] = parts[0]
    rest = parts[1:]
    for i, p in enumerate(rest):
        if re.match(r"^\d{4}", p):
            out["year"] = p
            rest = rest[i + 1:]
            break
    if rest:
        out["publisher"] = " / ".join(rest)
    return out, bool(out["author"])


def build_item(row, sheet_type):
    url = (row.get("D") or "").strip()
    m = re.search(r"subject/(\d+)", url)
    douban_id = m.group(1) if m else ""
    is_book = "book.douban.com" in url
    item_type = "book" if is_book else sheet_type

    if douban_id:
        key = ("b_" if item_type == "book" else "m_") + douban_id
    else:
        key = "x_" + re.sub(r"\W+", "", row.get("A", ""))[:24]

    title = (row.get("A") or "").strip()
    intro = (row.get("B") or "").strip()
    created = (row.get("E") or "").strip()

    item = {
        "key": key,
        "type": item_type,
        "doubanId": douban_id,
        "title": title,
        "url": url,
        "createdAt": created,
        "doubanRating": (row.get("C") or "").strip(),
        "myRating": _to_int(row.get("F")),
        "review": (row.get("H") or "").strip(),
        "tags": (row.get("G") or "").strip(),
    }

    if item_type == "book":
        parsed, ok = parse_book_intro(intro)
        item.update(parsed)
        item.update({"regions": "", "genres": "", "director": "", "cast": ""})
    else:
        parsed, ok = parse_movie_intro(intro)
        item.update(parsed)
        item.update({"author": "", "publisher": ""})

    if not ok:
        item["rawIntro"] = intro
    return item


# ----------------------------------------------------------------------------- 封面

MOBILE_APIKEY = "0dad551ec0f84ed02907ff5c42e8ec70"       # 豆瓣手机端公开 apikey
REXXAR_URL = "https://m.douban.com/rexxar/api/v2/%s/%s?apikey=" + MOBILE_APIKEY
SUBJECT_PAGE = "https://m.douban.com/%s/subject/%s/"
DESKTOP_PAGE = {"movie": "https://movie.douban.com/subject/%s/",
                "book": "https://book.douban.com/subject/%s/"}
MOBILE_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
                   "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 "
                   "Mobile/15E148 Safari/604.1"),
    "Accept-Language": "zh-CN,zh;q=0.9",
    "Referer": "https://m.douban.com/",
}
POSTER_RE = re.compile(r"https://img\d\.doubanio\.com/view/(?:photo|subject)/[^\"'\s\\]+?\.(?:jpg|jpeg|webp)")

# 抓取策略（刻意保守：只跑一次、抓完就本地缓存，尽量不惊动豆瓣——它没有开放官方 API）
#   · 单线程串行；每次请求前随机等 PAGE_DELAY 秒
#   · 先打 rexxar JSON 接口（响应最小），失败再退手机版 / 桌面版作品页 HTML
#   · 解析到的图片地址写入 cover_urls.json：重跑只补缺失的，绝不重复请求豆瓣
#   · 连续 BLOCK_LIMIT 次被拒（403/418/429/超时）立即整体中止并保存进度，保护 IP
#   · 图片一律换 .webp 变体（实测 .jpg 地址会被反爬拦截）
PAGE_DELAY = (3.0, 6.0)
BLOCK_LIMIT = 3
BLOCK_HINTS = ("403", "418", "429", "timed out")


def _fetch(url, headers, timeout=25):
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers),
                                  timeout=timeout).read()


def _to_webp_variant(url):
    return re.sub(r"\.(?:jpg|jpeg)$", ".webp", url, flags=re.I)


def _pick_poster(urls, item):
    if not urls:
        return None
    if item["type"] == "book":
        for u in urls:
            if "/view/subject/" in u:
                return u
    for u in urls:
        if "s_ratio_poster" in u:
            return u
    for u in urls:
        if "/view/photo/" in u:
            return u
    return urls[0]


def resolve_cover(item):
    """
    取封面地址，返回 (封面URL, 匹配精确度)。

    全部走豆瓣 ID，不做任何关键词搜索（搜索接口是限流重灾区）。
    依次尝试：rexxar JSON 接口 → 手机版作品页 → 桌面版作品页。
    """
    sid = item.get("doubanId")
    if not sid:
        raise ValueError("没有豆瓣 ID（新增条目请在网页里手动匹配封面）")

    kind = "book" if item["type"] == "book" else "movie"
    errors = []

    # ① rexxar JSON 接口：响应体积最小
    try:
        data = json.loads(_fetch(REXXAR_URL % (kind, sid), MOBILE_HEADERS, 20)
                          .decode("utf-8", "ignore"))
        pic = data.get("pic") or {}
        url = pic.get("normal") or pic.get("large") or pic.get("small")
        if url:
            return _to_webp_variant(url.replace("\\/", "/")), "exact"
        errors.append("接口未返回封面")
    except Exception as exc:
        errors.append("接口失败：%s" % str(exc)[:60])

    # ② 手机版作品页
    try:
        html = _fetch(SUBJECT_PAGE % (kind, sid), MOBILE_HEADERS).decode("utf-8", "ignore")
        poster = _pick_poster(POSTER_RE.findall(html), item)
        if poster:
            return _to_webp_variant(poster), "exact"
        errors.append("手机页未找到海报")
    except Exception as exc:
        errors.append("手机页失败：%s" % str(exc)[:60])

    # ③ 桌面版作品页
    try:
        html = _fetch(DESKTOP_PAGE[kind] % sid, HEADERS).decode("utf-8", "ignore")
        poster = _pick_poster(POSTER_RE.findall(html), item)
        if poster:
            return _to_webp_variant(poster), "exact"
        errors.append("桌面页未找到海报")
    except Exception as exc:
        errors.append("桌面页失败：%s" % str(exc)[:60])

    raise ValueError("；".join(errors) or "取封面失败")


def _looks_like_image(blob):
    head = blob[:16]
    return (head.startswith(b"\xff\xd8") or head.startswith(b"\x89PNG")
            or head.startswith(b"GIF8") or (head.startswith(b"RIFF") and b"WEBP" in head))


def save_cover_blob(item, blob, src_url):
    """把图片字节统一压成 webp 存到 assets/covers/，返回 (文件名, 字节数)。"""
    ext = ".webp"
    if HAS_PIL:
        img = Image.open(io.BytesIO(blob)).convert("RGB")
        if img.width > MAX_COVER_WIDTH:
            ratio = MAX_COVER_WIDTH / float(img.width)
            img = img.resize((MAX_COVER_WIDTH, max(1, int(img.height * ratio))),
                             Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="WEBP", quality=85, method=4)
        blob = buf.getvalue()
    else:
        guessed = os.path.splitext(urllib.parse.urlparse(src_url).path)[1].lower()
        ext = guessed if guessed in (".webp", ".jpg", ".jpeg", ".png") else ".jpg"

    filename = item["key"] + ext
    with open(os.path.join(COVERS_DIR, filename), "wb") as fp:
        fp.write(blob)
    return filename, len(blob)


def download_cover(item, cover_url, match):
    """从豆瓣下载并统一转成 webp，返回保存后的相对路径。"""
    req = urllib.request.Request(cover_url, headers=HEADERS)
    blob = urllib.request.urlopen(req, timeout=25).read()
    if len(blob) < 512:
        raise ValueError("封面文件过小")
    if not _looks_like_image(blob):
        raise ValueError("返回内容不是图片（可能被豆瓣限流）")
    return save_cover_blob(item, blob, cover_url)


# -----------------------------------------------------------------------------------
# 百度图片兜底：豆瓣封 IP 时改从这里拿海报
# 百度返回的是它自己 CDN（img0/1/2.baidu.com）上的图，可以直接下载，不封 IP。
# -----------------------------------------------------------------------------------
BAIDU_API = "https://image.baidu.com/search/acjson"
BAIDU_HEADERS = {
    "User-Agent": HEADERS["User-Agent"],
    "Referer": "https://image.baidu.com/",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
}
BAIDU_DELAY = (1.0, 2.0)


def baidu_search(word, count=30):
    """百度图片搜索，返回 [{url, title}, ...]"""
    query = urllib.parse.urlencode({
        "tn": "resultjson_com", "ipn": "rj", "word": word,
        "pn": "0", "rn": str(count), "gsm": "1e", "ie": "utf-8",
    })
    raw = _fetch(BAIDU_API + "?" + query, BAIDU_HEADERS, 15).decode("utf-8", "ignore")
    rows = json.loads(raw).get("data") or []
    out = []
    for row in rows:
        if not row:
            continue
        url = row.get("middleURL") or row.get("thumbURL") or ""
        if not url.startswith("http"):
            continue
        out.append({
            "url": url,
            "title": re.sub(r"<[^>]+>", "", row.get("fromPageTitleEnc") or ""),
        })
    return out


def baidu_query_for(item):
    if item["type"] == "book":
        return "%s 豆瓣 封面" % item["title"]
    year = item.get("year") or ""
    return ("%s %s 电影海报" % (item["title"], year)) if year else ("%s 电影海报" % item["title"])


def baidu_cover_for(item, tries=8):
    """
    在百度结果里挑一张最像海报的：竖版、比例接近 2:3、宽度够大。
    返回 (图片字节, 图片地址, 宽, 高)。
    """
    candidates = baidu_search(baidu_query_for(item))
    if not candidates:
        raise ValueError("百度没有返回结果")

    best = None
    for cand in candidates[:tries]:
        try:
            time.sleep(random.uniform(*BAIDU_DELAY))
            blob = _fetch(cand["url"], BAIDU_HEADERS, 20)
        except Exception:
            continue
        if len(blob) < 4096 or not _looks_like_image(blob):
            continue
        if not HAS_PIL:
            return blob, cand["url"], 0, 0
        try:
            width, height = Image.open(io.BytesIO(blob)).size
        except Exception:
            continue
        if not width:
            continue
        ratio = height / float(width)
        if 1.30 <= ratio <= 1.80:          # 标准海报比例
            score = 100 - abs(ratio - 1.5) * 60
        elif ratio > 1.0:                  # 竖版但不是海报比例
            score = 30 - abs(ratio - 1.5) * 20
        else:
            score = -50                    # 横版：基本是剧照
        score += min(width, 800) / 40.0
        if best is None or score > best[0]:
            best = (score, blob, cand["url"], width, height)

    if not best or best[0] < 20:
        raise ValueError("百度结果里没有合适的竖版海报")
    return best[1], best[2], best[3], best[4]


def fetch_from_baidu(items):
    """把豆瓣抓不到的条目交给百度补。"""
    manifest = load_json(MANIFEST_PATH, {})
    failures = load_json(FAILED_PATH, {})
    done = 0
    print("\n从百度图片补 %d 张海报……" % len(items))
    for idx, item in enumerate(items, 1):
        entry = manifest.get(item["key"])
        if entry and os.path.exists(os.path.join(COVERS_DIR, entry.get("file", ""))):
            failures.pop(item["key"], None)
            continue
        try:
            blob, url, width, height = baidu_cover_for(item)
            filename, size = save_cover_blob(item, blob, url)
            manifest[item["key"]] = {"file": filename, "match": "baidu", "bytes": size,
                                     "title": item["title"], "src": url,
                                     "size": "%dx%d" % (width, height)}
            failures.pop(item["key"], None)
            done += 1
            print("      [%d/%d] 成功 %s ← %dx%d" % (idx, len(items), item["title"], width, height))
        except Exception as exc:
            print("      [%d/%d] 失败 %s：%s" % (idx, len(items), item["title"], str(exc)[:70]))
        if idx % 5 == 0:
            save_json(MANIFEST_PATH, manifest)
            save_json(FAILED_PATH, failures)
    save_json(MANIFEST_PATH, manifest)
    save_json(FAILED_PATH, failures)
    print("\n百度补抓完成：成功 %d 张，仍未拿到 %d 张" % (done, len(failures)))
    return done


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as fp:
            return json.load(fp)
    except Exception:
        return default


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(obj, fp, ensure_ascii=False, indent=2)


def fetch_all_covers(items):
    """
    串行抓取封面。已成功的条目直接跳过，重跑永远不会重复请求豆瓣。
    """
    manifest = load_json(MANIFEST_PATH, {})
    url_cache = load_json(URL_CACHE_PATH, {})
    failures = load_json(FAILED_PATH, {})
    stats = {"exact": 0, "loose": 0, "skipped": 0, "failed": 0, "resolved": 0}

    queue = []
    for it in items:
        entry = manifest.get(it["key"])
        if entry and os.path.exists(os.path.join(COVERS_DIR, entry.get("file", ""))):
            stats["skipped"] += 1
            continue
        queue.append(it)

    print("\n需要抓取的封面：%d 张（已缓存 %d 张）" % (len(queue), stats["skipped"]))
    if not queue:
        return stats, failures

    blocked = 0
    for idx, item in enumerate(queue, 1):
        try:
            cached = url_cache.get(item["key"])
            if cached:
                # 上次已经解析出图片地址，这里只补下载，不再打扰豆瓣
                cover_url, match = cached["url"], cached.get("match", "exact")
            else:
                time.sleep(random.uniform(*PAGE_DELAY))
                cover_url, match = resolve_cover(item)
                stats["resolved"] += 1
                url_cache[item["key"]] = {"url": cover_url, "match": match,
                                          "title": item["title"]}
                save_json(URL_CACHE_PATH, url_cache)
            filename, size = download_cover(item, cover_url, match)
            manifest[item["key"]] = {"file": filename, "match": match, "bytes": size,
                                     "title": item["title"], "src": cover_url}
            failures.pop(item["key"], None)
            stats["exact" if match == "exact" else "loose"] += 1
            blocked = 0
        except Exception as exc:
            text = str(exc)
            if any(h in text for h in BLOCK_HINTS):
                blocked += 1
            failures[item["key"]] = {"title": item["title"], "reason": text[:160]}
            stats["failed"] += 1
            print("      [%d/%d] 失败 %s：%s" % (idx, len(queue), item["title"], text[:80]))
            if blocked >= BLOCK_LIMIT:
                print("\n！！连续 %d 次被豆瓣拒绝，已中止本次抓取以保护你的 IP。" % blocked)
                print("   已抓到的封面都已存到本地。建议隔 1 小时以上再重跑本脚本，它会自动接着抓。")
                break

        if idx % 10 == 0 or idx == len(queue):
            print("      进度 %d/%d（本次成功 %d，失败 %d）"
                  % (idx, len(queue), stats["exact"] + stats["loose"], stats["failed"]))
            save_json(MANIFEST_PATH, manifest)
            save_json(URL_CACHE_PATH, url_cache)
            save_json(FAILED_PATH, failures)

    save_json(MANIFEST_PATH, manifest)
    save_json(URL_CACHE_PATH, url_cache)
    save_json(FAILED_PATH, failures)
    return stats, failures


# ----------------------------------------------------------------------------- 主流程

def main():
    os.makedirs(COVERS_DIR, exist_ok=True)
    os.makedirs(CACHE_DIR, exist_ok=True)

    movie_rows, book_rows = load_excel()
    print("原始行数：影视剧 %d / 书籍 %d" % (len(movie_rows), len(book_rows)))

    raw_items = []
    for row in movie_rows:
        if (row.get("A") or "").strip():
            raw_items.append(build_item(row, "movie"))
    for row in book_rows:
        if (row.get("A") or "").strip():
            raw_items.append(build_item(row, "book"))

    # 按豆瓣 ID / key 去重，保留创建时间最新的那条
    dedup = {}
    for it in raw_items:
        old = dedup.get(it["key"])
        if old is None or (it["createdAt"] or "") > (old["createdAt"] or ""):
            dedup[it["key"]] = it
    items = list(dedup.values())
    items.sort(key=lambda x: (x.get("createdAt") or ""), reverse=True)

    movies = [i for i in items if i["type"] == "movie"]
    books = [i for i in items if i["type"] == "book"]
    five = [i for i in items if i.get("myRating") == 5]
    five_m = [i for i in five if i["type"] == "movie"]
    five_b = [i for i in five if i["type"] == "book"]
    unparsed = [i for i in items if i.get("rawIntro")]

    print("去重后总条目：%d（影视剧 %d / 书籍 %d）" % (len(items), len(movies), len(books)))
    print("5 星条目：%d（影视剧 %d / 书籍 %d）" % (len(five), len(five_m), len(five_b)))
    print("简介未能结构化解析（保留原文）：%d 条" % len(unparsed))

    payload = {
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "counts": {"total": len(items), "movie": len(movies), "book": len(books),
                   "featured": len(five)},
        "items": items,
    }
    path = os.path.join(DATA_DIR, "library.js")
    with open(path, "w", encoding="utf-8") as fp:
        fp.write("// 由 tools/fetch_covers.py 自动生成，请勿手改（改数据请改 Excel 后重跑脚本）\n")
        fp.write("window.LIBRARY = ")
        json.dump(payload, fp, ensure_ascii=False, separators=(",", ":"))
        fp.write(";\n")
    print("已生成 data/library.js（%.0f KB）" % (os.path.getsize(path) / 1024.0))

    featured_path = os.path.join(DATA_DIR, "featured.json")
    if os.path.exists(featured_path):
        print("data/featured.json 已存在，保留你现有的卡片墙配置（未覆盖）")
    else:
        save_json(featured_path, {"keys": [i["key"] for i in five]})
        print("已生成 data/featured.json（%d 条五星卡片）" % len(five))

    # 豆瓣抓不到的那些，改从百度图片补（不封 IP，可放心跑）
    if "--from-baidu" in sys.argv:
        wanted = load_json(FAILED_PATH, {})
        targets = [i for i in items if i["key"] in wanted]
        if not targets:
            print("\n失败清单是空的，没有需要从百度补的封面。")
        else:
            fetch_from_baidu(targets)
        print("现在双击「启动.bat」即可查看网页。")
        return 0

    if "--only-failed" in sys.argv:
        retry = load_json(FAILED_PATH, {})
        five = [i for i in five if i["key"] in retry]
        print("仅重试失败清单中的 %d 条" % len(five))

    stats, failures = fetch_all_covers(five)

    print("\n=========== 完成 ===========")
    print("全量条目        : %d" % len(items))
    print("卡片墙（5 星）  : %d" % len(five))
    print("封面 精确匹配   : %d" % stats["exact"])
    print("封面 近似匹配   : %d" % stats["loose"])
    print("封面 复用缓存   : %d" % stats["skipped"])
    print("封面 抓取失败   : %d" % stats["failed"])
    if failures:
        print("失败清单（最多显示 20 条，网页里可逐条手动匹配或上传）：")
        for k, v in list(failures.items())[:20]:
            print("  - %s | %s | %s" % (k, v["title"], v["reason"]))
    print("现在双击「启动.bat」即可查看网页。")
    return 0


if __name__ == "__main__":
    sys.exit(main())