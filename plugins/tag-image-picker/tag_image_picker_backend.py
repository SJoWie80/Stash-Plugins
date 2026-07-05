import base64
import json
import re
import sys
import urllib.parse
import urllib.request


ICONIFY_SEARCH = "https://api.iconify.design/search"
ICONIFY_ICON = "https://api.iconify.design/{}/{}.svg"


CURATED_ICONS = [
    (("anal", "anus", "gaping", "rim"), "healthicons:anus"),
    (("cock", "dick", "penis", "bbc", "erect"), "healthicons:penis"),
    (("pussy", "vagina", "vaginal", "vulva", "clit", "labia"), "healthicons:vagina"),
    (("tits", "boobs", "breast", "nipples", "areolas", "topless"), "healthicons:breasts"),
    (("condom", "safe sex"), "healthicons:male-condom"),
    (("cum", "sperm", "facial", "swallowing", "creampie", "cream pie"), "healthicons:sperm"),
    (("bdsm", "bondage", "fetish", "submission", "domination", "femdom", "maledom"), "openmoji:bdsm-rights"),
    (("handcuffs", "restraints", "cuffs"), "mdi:handcuffs"),
    (("dildo", "vibrator", "sex toy", "toys", "magic wand"), "arcticons:vibrator"),
    (("lingerie", "bra", "panties", "thong", "underwear"), "mdi:lingerie"),
    (("oral", "blowjob", "deepthroat", "mouth", "licking", "sucking", "rimming"), "material-symbols:lips"),
    (("kiss", "kissing"), "openmoji:kiss"),
    (("feet", "foot", "toe", "barefoot"), "game-icons:morgue-feet"),
    (("teacher", "professor", "tutor"), "mdi:teacher"),
    (("nurse", "doctor", "medical"), "healthicons:nurse"),
    (("vr", "virtual reality", "180", "200", "220", "360"), "mdi:virtual-reality"),
    (("adult", "xxx", "porn"), "dinkie-icons:adult"),
    (("sex worker",), "healthicons:female-sex-worker"),
]


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


def fetch_bytes(url, accept):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 Stash Tag Icon Studio",
            "Accept": accept,
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        content_type = response.headers.get("Content-Type", "application/octet-stream").split(";")[0]
        return content_type, response.read()


def fetch_json(url):
    content_type, raw = fetch_bytes(url, "application/json,*/*")
    return json.loads(raw.decode("utf-8"))


def normalize(value):
    return re.sub(r"[^a-z0-9]+", " ", value.lower()).strip()


def curated_icon(query):
    text = normalize(query)
    for words, icon in CURATED_ICONS:
        if any(word in text for word in words):
            return icon
    return ""


def search_icon(query):
    params = urllib.parse.urlencode({"query": query, "limit": "16"})
    data = fetch_json("{}?{}".format(ICONIFY_SEARCH, params))
    icons = data.get("icons") or []
    if not icons:
        return ""
    return icons[0]


def icon_url(icon):
    prefix, name = icon.split(":", 1)
    params = urllib.parse.urlencode({"height": "512"})
    return "{}?{}".format(ICONIFY_ICON.format(urllib.parse.quote(prefix), urllib.parse.quote(name)), params)


def iconify_icon(args):
    query = str(arg_value(args, "query", "") or "").strip()
    if not query:
        return {"error": "Missing Iconify search query"}

    selected = curated_icon(query) or search_icon(query)
    if not selected or ":" not in selected:
        return {"error": "No Iconify icon found for {}".format(query)}

    url = icon_url(selected)
    content_type, raw = fetch_bytes(url, "image/svg+xml,image/*,*/*")
    if b"<svg" not in raw[:1000].lower():
        return {"error": "Iconify did not return an SVG"}

    encoded = base64.b64encode(raw).decode("ascii")
    return {
        "output": {
            "id": selected,
            "name": selected.replace(":", " / "),
            "sourceUrl": url,
            "pageUrl": "https://icon-sets.iconify.design/{}/{}".format(*selected.split(":", 1)),
            "imageData": "data:{};base64,{}".format(content_type or "image/svg+xml", encoded),
            "results": [{"id": selected, "name": selected}],
        }
    }


def main():
    payload = read_input()
    args = payload.get("args") or {}
    action = str(arg_value(args, "action", "") or "").lower()
    if action == "iconify-icon":
        return iconify_icon(args)
    return {"error": "Unknown action"}


print(json.dumps(main()))
