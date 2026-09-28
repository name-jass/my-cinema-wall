# -*- coding: utf-8 -*-
"""
下载并解出 GSAP 本地库（只需运行一次）。

GSAP 3.13 起全部插件已免费（含 Draggable / InertiaPlugin），本脚本只提取网页真正用到的 3 个文件：
  gsap.min.js / Draggable.min.js / InertiaPlugin.min.js

用法： python tools/make_vendor.py
"""
import io
import os
import sys
import tarfile
import urllib.request

# 项目根目录（本文件位于 tools/ 下）
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR_DIR = os.path.join(ROOT, "assets", "vendor")

GSAP_VERSION = "3.13.0"
NEEDED = ["gsap.min.js", "Draggable.min.js", "InertiaPlugin.min.js"]

# 依次尝试的下载源（本机实测 jsdelivr 不可用，故不列入）
SOURCES = [
    ("npmmirror-tgz", "https://registry.npmmirror.com/gsap/-/gsap-{v}.tgz"),
    ("unpkg", "https://unpkg.com/gsap@{v}/dist/{f}"),
    ("staticfile", "https://cdn.staticfile.org/gsap/{v0}/gsap.min.js"),
    ("bootcdn", "https://cdn.bootcdn.net/ajax/libs/gsap/{v0}/gsap.min.js"),
]

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def _get(url, timeout=40):
    req = urllib.request.Request(url, headers=HEADERS)
    return urllib.request.urlopen(req, timeout=timeout).read()


def try_npmmirror_tgz():
    """主方案：下载 npm 包（含全部插件），从中解出需要的 3 个文件。"""
    url = SOURCES[0][1].format(v=GSAP_VERSION)
    print("[1/4] 下载 GSAP 包：%s" % url)
    blob = _get(url)
    print("      包大小 %.1f KB" % (len(blob) / 1024.0))

    out = {}
    with tarfile.open(fileobj=io.BytesIO(blob)) as tar:
        for member in tar.getmembers():
            name = os.path.basename(member.name)
            if member.name.startswith("package/dist/") and name in NEEDED:
                fh = tar.extractfile(member)
                if fh is not None:
                    out[name] = fh.read()
    return out


def try_single_file_cdn():
    """备用方案：从 CDN 逐个下载（staticfile / bootcdn 只托管核心文件）。"""
    out = {}
    for _, tpl in SOURCES[1:]:
        for f in NEEDED:
            if f in out:
                continue
            url = tpl.format(v=GSAP_VERSION, v0=GSAP_VERSION, f=f)
            try:
                out[f] = _get(url, timeout=25)
                print("      备用源成功：%s" % url)
            except Exception:
                continue
        if len(out) == len(NEEDED):
            break
    return out


def main():
    os.makedirs(VENDOR_DIR, exist_ok=True)

    files = {}
    try:
        files = try_npmmirror_tgz()
    except Exception as exc:
        print("      主方案失败：%s" % exc)

    if len(files) < len(NEEDED):
        print("[2/4] 主方案不完整，尝试备用 CDN…")
        for k, v in try_single_file_cdn().items():
            files.setdefault(k, v)

    missing = [f for f in NEEDED if f not in files]
    if missing:
        print("[×] 以下文件获取失败：%s" % ", ".join(missing))
        print("    请检查网络后重试，或手动把文件放入 assets/vendor/")
        return 1

    print("[3/4] 写入 assets/vendor/ …")
    for f in NEEDED:
        path = os.path.join(VENDOR_DIR, f)
        with open(path, "wb") as fp:
            fp.write(files[f])
        print("      %-22s %6.1f KB" % (f, len(files[f]) / 1024.0))

    total = sum(len(files[f]) for f in NEEDED) / 1024.0
    print("[4/4] 完成，共 3 个文件 / %.1f KB" % total)
    return 0


if __name__ == "__main__":
    sys.exit(main())