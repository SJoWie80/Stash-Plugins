import base64
import html
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


USER_AGENT = "Stash Tag Image Picker/0.1 (+https://github.com/SJoWie80/Stash-Plugins)"
MAX_THUMB_BYTES = 900000


def read_input():
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def arg_value(args, key, default=None):
    value = args.get(key, default)
    if isinstance(value, dict):
        if "value" in value:
            return value.get("value")
        for typed_key in ("str", "i", "f", "b"):
            if typed_key in value:
                return value.get(typed_key)
    return value


def fetch(url, accept="application/json,text/plain,*/*", timeout=20):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": accept,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            content_type = response.headers.get("Content-Type", "")
            return response.read(), content_type
    except (ssl.SSLError, urllib.error.URLError) as error:
        reason = getattr(error, "reason", error)
        if not isinstance(reason, ssl.SSLError):
            raise
        context = ssl._create_unverified_context()
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            content_type = response.headers.get("Content-Type", "")
            return response.read(), content_type


def fetch_json(url):
    data, _ = fetch(url)
    return json.loads(data.decode("utf-8", errors="replace"))


def safe_int(value, default):
    try:
        return int(value)
    except Exception:
        return default


def data_url(url):
    try:
        data, content_type = fetch(url, accept="image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*", timeout=12)
        if len(data) > MAX_THUMB_BYTES:
            return ""
        mime = (content_type.split(";")[0] or "image/jpeg").strip()
        if not mime.startswith("image/"):
            return ""
        encoded = base64.b64encode(data).decode("ascii")
        return "data:{};base64,{}".format(mime, encoded)
    except Exception:
        return ""


def wikimedia_search(query, limit):
    params = {
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrnamespace": "6",
        "gsrsearch": query,
        "gsrlimit": str(min(max(limit, 1), 40)),
        "prop": "imageinfo",
        "iiprop": "url|mime|size",
        "iiurlwidth": "420",
        "origin": "*",
    }
    url = "https://commons.wikimedia.org/w/api.php?{}".format(urllib.parse.urlencode(params))
    payload = fetch_json(url)
    pages = ((payload.get("query") or {}).get("pages") or {}).values()
    results = []
    for page in pages:
        info = (page.get("imageinfo") or [{}])[0]
        image_url = info.get("url") or ""
        thumb_url = info.get("thumburl") or image_url
        if not image_url or not thumb_url:
            continue
        title = page.get("title") or "Wikimedia image"
        results.append(
            {
                "title": title.replace("File:", "", 1),
                "imageUrl": image_url,
                "thumbUrl": thumb_url,
                "thumbData": data_url(thumb_url),
                "sourceUrl": "https://commons.wikimedia.org/wiki/{}".format(urllib.parse.quote(title.replace(" ", "_"))),
                "provider": "Wikimedia Commons",
            }
        )
    return results[:limit]


def duckduckgo_vqd(query):
    search_url = "https://duckduckgo.com/?{}".format(urllib.parse.urlencode({"q": query, "iax": "images", "ia": "images"}))
    data, _ = fetch(search_url, accept="text/html,*/*")
    text = data.decode("utf-8", errors="replace")
    patterns = [
        r"vqd=['\"]([^'\"]+)['\"]",
        r"vqd=([^&]+)&",
        r'"vqd":"([^"]+)"',
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return html.unescape(match.group(1))
    return ""


def duckduckgo_search(query, limit):
    vqd = duckduckgo_vqd(query)
    if not vqd:
        return []
    params = {
        "l": "us-en",
        "o": "json",
        "q": query,
        "vqd": vqd,
        "f": ",,,",
        "p": "1",
    }
    url = "https://duckduckgo.com/i.js?{}".format(urllib.parse.urlencode(params))
    payload = fetch_json(url)
    results = []
    for item in payload.get("results") or []:
        image_url = item.get("image") or ""
        thumb_url = item.get("thumbnail") or image_url
        if not image_url or not thumb_url:
            continue
        results.append(
            {
                "title": item.get("title") or item.get("source") or "DuckDuckGo image",
                "imageUrl": image_url,
                "thumbUrl": thumb_url,
                "thumbData": data_url(thumb_url),
                "sourceUrl": item.get("url") or image_url,
                "provider": "DuckDuckGo",
            }
        )
        if len(results) >= limit:
            break
    return results


def search(args):
    query = str(arg_value(args, "query", "") or "").strip()
    provider = str(arg_value(args, "provider", "wikimedia") or "wikimedia").strip().lower()
    limit = min(max(safe_int(arg_value(args, "limit", 12), 12), 4), 40)
    if not query:
        return {"error": "Missing search query"}

    started = time.time()
    errors = []
    results = []
    providers = ["wikimedia", "duckduckgo"] if provider == "all" else [provider]
    for name in providers:
        try:
            if name == "duckduckgo":
                results.extend(duckduckgo_search(query, limit - len(results)))
            else:
                results.extend(wikimedia_search(query, limit - len(results)))
        except Exception as error:
            errors.append("{}: {}".format(name, error))
        if len(results) >= limit:
            break

    return {
        "output": {
            "query": query,
            "provider": provider,
            "count": len(results),
            "elapsedMs": int((time.time() - started) * 1000),
            "errors": errors,
            "results": results[:limit],
        }
    }


def main():
    payload = read_input()
    args = payload.get("args") or {}
    action = str(arg_value(args, "action", "search") or "search").lower()
    if action == "search":
        return search(args)
    return {"error": "Unknown action {}".format(action)}


print(json.dumps(main()))
