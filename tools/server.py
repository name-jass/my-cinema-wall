# -*- coding: utf-8 -*-
"""
本机小服务：给「我的观影小站」提供静态文件 + 4 个接口。

为什么需要它（浏览器单独做不到的两件事）：
  · 直接请求豆瓣会被跨域拦下（豆瓣不返回 CORS 头）→ 由本服务代劳
  · 网页没有往硬盘写文件的权限 → 上传的海报由本服务落盘到 assets/covers/

接口：
  GET  /api/covers                     列出本地已有的海报
  GET  /api/match?key=&type=&doubanId=&title=&year=
                                       代网页去豆瓣取回封面并存到本地；
                                       豆瓣走不通时自动改从百度图片兜底
  POST /api/upload?key=                接收图片字节，压缩成 webp 存到本地
  POST /api/save                       写回数据（卡片墙清单 / 新条目 / 恢复默认封面）

只监听 127.0.0.1（不对外网暴露），所有写操作限制在项目目录内。

用法：双击「启动.bat」（内部就是 python tools/server.py）
"""
import io
import json
import os
import re
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# 复用数据管线里的豆瓣取图逻辑（同目录下的 fetch_covers.py）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fetch_covers as fc  # noqa: E402

try:
    from PIL import Image
    HAS_PIL = True
except Exception:
    HAS_PIL = False

ROOT = fc.ROOT
DATA_DIR = fc.DATA_DIR
COVERS_DIR = fc.COVERS_DIR
FEATURED_PATH = os.path.join(DATA_DIR, "featured.json")
CUSTOM_PATH = os.path.join(DATA_DIR, "custom_items.json")

HOST = "127.0.0.1"
PORT = 8765

# 键名只允许字母数字下划线横线：既防路径穿越，也天然限制文件名
KEY_RE = re.compile(r"^[A-Za-z0-9_\-]{1,80}$")
IMAGE_EXTS = (".webp", ".jpg", ".jpeg", ".png", ".gif")

POSTER_RATIO = 2.0 / 3.0        # 海报比例，上传的图片按此居中裁剪
UPLOAD_MAX_WIDTH = 500
UPLOAD_QUALITY = 82
MIN_MATCH_INTERVAL = 1.0        # 两次「匹配海报」之间至少隔 1 秒，避免连续戳豆瓣

_match_lock = threading.Lock()
_last_match_at = [0.0]


# ----------------------------------------------------------------------------- 小工具

def json_body(obj):
    return json.dumps(obj, ensure_ascii=False).encode("utf-8")


def friendly_error(exc):
    """把技术性的报错翻成用户看得懂的一句话。"""
    text = str(exc)
    low = text.lower()
    if "timed out" in low or "urlerror" in low or "errno" in low or "handshake" in low:
        return "连不上豆瓣（网络不通或豆瓣临时限制），请稍后重试，或直接手动上传海报。"
    if "403" in text or "418" in text or "429" in text:
        return "豆瓣拒绝了这次请求（访问太频繁），请过一会儿再试，或直接手动上传海报。"
    if "404" in text:
        return "豆瓣上找不到这个条目，请手动上传海报。"
    return text[:200]


def list_covers():
    """扫描 assets/covers/，返回 {itemKey: 相对路径}（同一键优先用 webp）。"""
    out = {}
    if not os.path.isdir(COVERS_DIR):
        return out
    names = sorted(os.listdir(COVERS_DIR),
                   key=lambda n: (not n.lower().endswith(".webp"), n))
    for name in names:
        stem, ext = os.path.splitext(name)
        if ext.lower() not in IMAGE_EXTS or not KEY_RE.match(stem):
            continue
        out.setdefault(stem, "assets/covers/" + name)
    return out


def remove_cover_files(key):
    """删掉某个条目的海报文件（换扩展名后可能残留多个），恢复成默认封面。"""
    removed = []
    if not os.path.isdir(COVERS_DIR):
        return removed
    for name in os.listdir(COVERS_DIR):
        stem, ext = os.path.splitext(name)
        if stem == key and ext.lower() in IMAGE_EXTS:
            try:
                os.remove(os.path.join(COVERS_DIR, name))
                removed.append(name)
            except OSError:
                pass
    return removed


def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as fp:
            return json.load(fp)
    except Exception:
        return default


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fp:
        json.dump(obj, fp, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


# ----------------------------------------------------------------------------- 请求处理

class Handler(SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---- 基础响应 ----

    def _respond(self, status, payload):
        blob = json_body(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(blob)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(blob)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def end_headers(self):
        # 让 .webp 一定被当成图片（老版本 Python 的 mimetypes 里没有它）
        self.extensions_map[".webp"] = "image/webp"
        super().end_headers()

    def log_message(self, fmt, *args):
        # 静态文件不刷屏，只记接口调用
        if self.path.startswith("/api/"):
            sys.stdout.write("[%s] %s %s\n" % (time.strftime("%H:%M:%S"),
                                              self.command, self.path))
            sys.stdout.flush()

    def _params(self):
        query = urllib.parse.urlparse(self.path).query
        return {k: v[0] for k, v in urllib.parse.parse_qs(query).items()}

    # ---- GET ----

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/covers":
            self._respond(200, {"ok": True, "covers": list_covers()})
        elif path == "/api/match":
            self._respond(200, self.handle_match(self._params()))
        elif path.startswith("/api/"):
            self._respond(404, {"ok": False, "reason": "未知接口"})
        else:
            super().do_GET()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---- POST ----

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        body = self.rfile.read(length) if length > 0 else b""

        params = {k: v[0] for k, v in urllib.parse.parse_qs(parsed.query).items()}
        if parsed.path == "/api/upload":
            self._respond(200, self.handle_upload(params.get("key", ""), body))
        elif parsed.path == "/api/save":
            self._respond(200, self.handle_save(body))
        else:
            self._respond(404, {"ok": False, "reason": "未知接口"})

    # ---- 接口实现 ----

    def handle_match(self, params):
        key = (params.get("key") or "").strip()
        if not KEY_RE.match(key):
            return {"ok": False, "reason": "条目标识不合法"}
        item = {
            "key": key,
            "type": "book" if params.get("type") == "book" else "movie",
            "doubanId": (params.get("doubanId") or "").strip(),
            "title": (params.get("title") or "").strip(),
            "year": (params.get("year") or "").strip(),
        }
        if not item["doubanId"] and not item["title"]:
            return {"ok": False,
                    "reason": "这条既没有豆瓣链接也没有标题，无法自动匹配，请手动上传海报。"}

        # 串行 + 最小间隔：你连点几下也不会把豆瓣戳烦
        with _match_lock:
            gap = MIN_MATCH_INTERVAL - (time.time() - _last_match_at[0])
            if gap > 0:
                time.sleep(gap)
            done = False
            reason = ""
            if item["doubanId"]:
                try:
                    cover_url, match = fc.resolve_cover(item)
                    filename, size = fc.download_cover(item, cover_url, match)
                    done = True
                except Exception as exc:
                    reason = friendly_error(exc) + " "
            else:
                reason = "这条没有豆瓣链接。"

            if not done:
                # 豆瓣走不通（最常见：临时封 IP）→ 改从百度图片兜底
                try:
                    blob, url, width, height = fc.baidu_cover_for(item)
                    filename, size = fc.save_cover_blob(item, blob, url)
                    match = "baidu"
                except Exception as exc:
                    _last_match_at[0] = time.time()
                    return {"ok": False,
                            "reason": reason + "百度图片也没找到合适的：" + friendly_error(exc)}
            _last_match_at[0] = time.time()

        return {"ok": True, "cover": "assets/covers/" + filename,
                "match": match, "bytes": size}

    def handle_upload(self, key, blob):
        key = (key or "").strip()
        if not KEY_RE.match(key):
            return {"ok": False, "reason": "条目标识不合法"}
        if not blob:
            return {"ok": False, "reason": "没有收到图片内容"}
        if not HAS_PIL:
            return {"ok": False, "reason": "本机缺少 Pillow，无法压缩图片，请先安装 Pillow"}

        try:
            img = Image.open(io.BytesIO(blob))
            img.load()
            img = img.convert("RGB")

            # 居中裁剪成海报比例，再限制宽度（小图不放大，避免糊）
            w, h = img.size
            if w / float(h) > POSTER_RATIO:
                new_w = max(1, int(h * POSTER_RATIO))
                left = (w - new_w) // 2
                img = img.crop((left, 0, left + new_w, h))
            else:
                new_h = max(1, int(w / POSTER_RATIO))
                top = (h - new_h) // 2
                img = img.crop((0, top, w, top + new_h))
            if img.width > UPLOAD_MAX_WIDTH:
                ratio = UPLOAD_MAX_WIDTH / float(img.width)
                img = img.resize((UPLOAD_MAX_WIDTH, max(1, int(img.height * ratio))),
                                 Image.LANCZOS)

            buf = io.BytesIO()
            img.save(buf, format="WEBP", quality=UPLOAD_QUALITY, method=4)
            data = buf.getvalue()
        except Exception as exc:
            return {"ok": False, "reason": "这个文件读不出图片，请换一张（%s）" % str(exc)[:60]}

        os.makedirs(COVERS_DIR, exist_ok=True)
        filename = key + ".webp"
        target = os.path.join(COVERS_DIR, filename)
        with open(target, "wb") as fp:
            fp.write(data)

        # 清掉同一键的其它扩展名，避免一份海报两个文件
        for name in os.listdir(COVERS_DIR):
            stem, ext = os.path.splitext(name)
            if stem == key and name != filename and ext.lower() in IMAGE_EXTS:
                try:
                    os.remove(os.path.join(COVERS_DIR, name))
                except OSError:
                    pass

        return {"ok": True, "cover": "assets/covers/" + filename,
                "bytes": len(data), "originalBytes": len(blob)}

    def handle_save(self, body):
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            return {"ok": False, "reason": "请求内容不是合法 JSON"}
        if not isinstance(payload, dict):
            return {"ok": False, "reason": "请求格式不对"}

        result = {"ok": True, "done": []}

        # ① 卡片墙清单
        if "featured" in payload:
            keys = payload["featured"]
            if not isinstance(keys, list):
                return {"ok": False, "reason": "featured 必须是数组"}
            clean, seen = [], set()
            for k in keys:
                k = str(k).strip()
                if KEY_RE.match(k) and k not in seen:
                    seen.add(k)
                    clean.append(k)
            save_json(FEATURED_PATH, {"keys": clean,
                                      "updatedAt": time.strftime("%Y-%m-%d %H:%M:%S")})
            result["done"].append("featured")
            result["count"] = len(clean)

        # ② 新增条目
        if "newItem" in payload:
            item = payload["newItem"]
            if not isinstance(item, dict) or not KEY_RE.match(str(item.get("key", ""))):
                return {"ok": False, "reason": "新条目的 key 不合法"}
            store = load_json(CUSTOM_PATH, {"items": []})
            if not isinstance(store, dict) or not isinstance(store.get("items"), list):
                store = {"items": []}
            key = str(item["key"])
            store["items"] = [i for i in store["items"]
                              if isinstance(i, dict) and str(i.get("key")) != key]
            store["items"].append(item)
            store["updatedAt"] = time.strftime("%Y-%m-%d %H:%M:%S")
            save_json(CUSTOM_PATH, store)
            result["done"].append("newItem")

        # ③ 恢复默认封面
        if "resetCover" in payload:
            key = str(payload["resetCover"]).strip()
            if not KEY_RE.match(key):
                return {"ok": False, "reason": "条目标识不合法"}
            removed = remove_cover_files(key)
            result["done"].append("resetCover")
            result["removed"] = removed

        if not result["done"]:
            return {"ok": False, "reason": "没有需要保存的内容"}
        return result


# ----------------------------------------------------------------------------- 启动

def main():
    os.makedirs(COVERS_DIR, exist_ok=True)
    os.makedirs(DATA_DIR, exist_ok=True)

    try:
        httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as exc:
        print("！端口 %d 被占用了（可能已经有一个窗口在运行）。" % PORT)
        print("  请先关掉之前那个命令行窗口，再重新双击「启动.bat」。（%s）" % exc)
        return 1

    httpd.daemon_threads = True
    covers = len(list_covers())
    url = "http://localhost:%d/" % PORT
    print("=" * 52)
    print("  我的观影小站 · 本机服务已启动")
    print("  网页地址：%s" % url)
    print("  本地已有海报：%d 张" % covers)
    print("  请保持此窗口开启；关掉窗口 = 停止服务（数据仍在你本机）")
    print("=" * 52)

    # 自动打开浏览器（端口已经在监听，浏览器的请求会被排队等 serve_forever）
    if "--no-open" not in sys.argv:
        try:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        except Exception:
            pass

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止。")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())