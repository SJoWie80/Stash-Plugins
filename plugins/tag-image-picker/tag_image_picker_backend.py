import base64
import json
import sys
import urllib.parse
import urllib.request


API_BASE = "https://api.magnific.com/v1/icons"


def read_input():
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def arg_value(args, key, default=""):
    value = args.get(key, default)
    if isinstance(value, dict):
        if "value" in value:
            return value.get("value")
        for typed_key in ("str", "i", "f", "b"):
            if typed_key in value:
                return value.get(typed_key)
    return value


def fetch_json(url, api_key):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Stash Tag Icon Studio",
            "Accept": "application/json",
            "x-magnific-api-key": api_key,
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_bytes(url):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Stash Tag Icon Studio",
            "Accept": "image/png,image/*,*/*",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        content_type = response.headers.get("Content-Type", "image/png").split(";")[0]
        return content_type, response.read()


def best_thumbnail(icon):
    thumbnails = icon.get("thumbnails") or []
    thumbnails = [item for item in thumbnails if item.get("url")]
    if not thumbnails:
        return ""
    thumbnails.sort(key=lambda item: int(item.get("width") or 0) * int(item.get("height") or 0), reverse=True)
    return thumbnails[0].get("url") or ""


def download_url_for_icon(icon, api_key):
    icon_id = icon.get("id")
    if not icon_id:
        return ""
    params = urllib.parse.urlencode({"format": "png", "png_size": "512"})
    data = fetch_json("{}/{}/download?{}".format(API_BASE, icon_id, params), api_key)
    return ((data.get("data") or {}).get("url")) or ""


def magnific_icon(args):
    query = str(arg_value(args, "query", "") or "").strip()
    api_key = str(arg_value(args, "apiKey", "") or "").strip()
    if not query:
        return {"error": "Missing Magnific search query"}
    if not api_key:
        return {"error": "Missing Magnific API key"}

    params = urllib.parse.urlencode(
        {
            "term": query,
            "page": "1",
            "per_page": "12",
            "order": "relevance",
            "thumbnail_size": "512",
        }
    )
    data = fetch_json("{}?{}".format(API_BASE, params), api_key)
    icons = data.get("data") or []
    if not icons:
        return {"error": "No Magnific icons found for {}".format(query)}

    selected = icons[0]
    image_url = best_thumbnail(selected)
    if not image_url:
        image_url = download_url_for_icon(selected, api_key)
    if not image_url:
        return {"error": "Magnific returned an icon without a PNG URL"}

    content_type, raw = fetch_bytes(image_url)
    encoded = base64.b64encode(raw).decode("ascii")
    results = [
        {
            "id": icon.get("id"),
            "name": icon.get("name") or "",
            "thumbnail": best_thumbnail(icon),
        }
        for icon in icons[:8]
    ]
    return {
        "output": {
            "id": selected.get("id"),
            "name": selected.get("name") or query,
            "sourceUrl": image_url,
            "imageData": "data:{};base64,{}".format(content_type or "image/png", encoded),
            "results": results,
        }
    }


def main():
    payload = read_input()
    args = payload.get("args") or {}
    action = str(arg_value(args, "action", "") or "").lower()
    if action == "magnific-icon":
        return magnific_icon(args)
    return {"error": "Unknown action"}


print(json.dumps(main()))
