import base64
import json
import re
import sys
import urllib.parse
import urllib.request


ICONIFY_SEARCH = "https://api.iconify.design/search"
ICONIFY_ICON = "https://api.iconify.design/{}/{}.svg"


CURATED_ICONS = [
    (("anal", "anus, gaping", "gaping", "rim"), ("healthicons:anus", "healthicons:anus-outline", "healthicons:anus-24px", "healthicons:anus-outline-24px", "pinhead:anus")),
    (("cock", "dick", "penis", "bbc", "erect"), ("healthicons:penis", "healthicons:penis-outline", "healthicons:penis-alt", "healthicons:penis-alt-outline", "healthicons:penis-24px")),
    (("pussy", "vagina", "vaginal", "vulva", "clit", "labia"), ("healthicons:vagina", "healthicons:vagina-outline", "healthicons:vagina-alt", "healthicons:vagina-alt-outline")),
    (("tits", "boobs", "breast", "nipples", "areolas", "topless"), ("healthicons:breasts", "healthicons:breasts-outline")),
    (("condom", "safe sex"), ("healthicons:male-condom", "healthicons:male-condom-outline", "healthicons:female-condom", "healthicons:female-condom-outline")),
    (("cum", "sperm", "facial", "swallowing", "creampie", "cream pie"), ("healthicons:sperm", "healthicons:sperm-outline", "hugeicons:sperm", "icon-park-outline:sperm")),
    (("bdsm", "bondage", "fetish", "submission", "domination", "femdom", "maledom"), ("openmoji:bdsm-rights", "mdi:handcuffs", "hugeicons:handcuffs", "game-icons:handcuffs")),
    (("handcuffs", "restraints", "cuffs"), ("mdi:handcuffs", "hugeicons:handcuffs", "game-icons:handcuffs", "fa7-solid:handcuffs")),
    (("dildo", "vibrator", "sex toy", "toys", "magic wand"), ("arcticons:vibrator", "mdi:magic-staff", "game-icons:vibrating-shield")),
    (("lingerie", "bra", "panties", "thong", "underwear"), ("mdi:lingerie", "lucide-lab:lingerie")),
    (("oral", "blowjob", "deepthroat", "mouth", "licking", "sucking", "rimming"), ("material-symbols:lips", "mingcute:mouth-fill", "icon-park-outline:mouth", "openmoji:mouth")),
    (("kiss", "kissing"), ("openmoji:kiss", "glyphs:kiss", "fa7-solid:kiss")),
    (("feet", "foot", "toe", "barefoot"), ("game-icons:morgue-feet", "streamline-ultimate:medical-specialty-feet")),
    (("teacher", "professor", "tutor"), ("mdi:teacher", "hugeicons:teacher", "game-icons:teacher")),
    (("nurse", "doctor", "medical"), ("healthicons:nurse", "healthicons:nurse-outline", "tabler:nurse", "fontisto:nurse")),
    (("vr", "virtual reality", "180", "200", "220", "360"), ("mdi:virtual-reality", "tabler:badge-vr", "game-icons:vr-headset")),
    (("adult", "xxx", "porn"), ("dinkie-icons:adult", "dinkie-icons:adult-filled", "noto:adult", "el:adult")),
    (("sex worker",), ("healthicons:female-sex-worker", "healthicons:female-sex-worker-outline", "healthicons:male-sex-worker", "healthicons:male-sex-worker-outline")),
    (("aggressive", "rough", "hardcore", "hard fuck", "angry", "rage"), ("boxicons:angry", "mingcute:angry-fill", "fe:rage", "game-icons:enrage", "mdi:flame")),
    (("slapping", "slap", "spanking", "spank"), ("game-icons:slap", "game-icons:wind-slap", "icon-park-outline:fist", "mdi:hand-back-left")),
    (("choking", "choke", "strangle"), ("game-icons:grab", "mdi:hand-back-left", "icon-park-outline:fist")),
    (("dirty talk", "talking", "whisper"), ("mdi:message-text", "mdi:chat-alert", "material-symbols:chat")),
    (("kinky",), ("openmoji:bdsm-rights", "mdi:handcuffs", "mdi:flame")),
    (("romantic", "passion", "intimate"), ("mdi:heart", "game-icons:burning-passion", "openmoji:kiss", "mdi:candle")),
]


CONTEXT_QUERIES = [
    (("aggressive", "rough", "hardcore", "hard fuck"), ("angry", "rage", "fist", "flame", "slap")),
    (("slapping", "slap"), ("slap", "hand", "fist")),
    (("spanking", "spank"), ("slap", "hand", "fist")),
    (("choking", "choke", "strangle"), ("grab", "hand", "fist", "warning")),
    (("dirty talk",), ("chat", "message", "talk")),
    (("domination", "dominant", "femdom", "maledom"), ("crown", "handcuffs", "control", "power")),
    (("submission", "submissive"), ("handcuffs", "kneel", "down", "collar")),
    (("kinky", "fetish"), ("bdsm", "handcuffs", "flame")),
    (("romantic", "passion", "intimate"), ("heart", "kiss", "candle")),
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


def curated_icons(query):
    text = normalize(query)
    icons = []
    for words, icon in CURATED_ICONS:
        if any(word in text for word in words):
            if isinstance(icon, (list, tuple)):
                icons.extend(icon)
            else:
                icons.append(icon)
    return icons


def context_queries(query):
    text = normalize(query)
    queries = []
    for words, fallbacks in CONTEXT_QUERIES:
        if any(word in text for word in words):
            queries.extend(fallbacks)
    if not queries:
        parts = text.split()
        if len(parts) > 1:
            queries.extend(parts)
    return queries


def search_icons(query):
    params = urllib.parse.urlencode({"query": query, "limit": "24"})
    data = fetch_json("{}?{}".format(ICONIFY_SEARCH, params))
    return data.get("icons") or []


def icon_url(icon):
    prefix, name = icon.split(":", 1)
    params = urllib.parse.urlencode({"height": "512"})
    return "{}?{}".format(ICONIFY_ICON.format(urllib.parse.quote(prefix), urllib.parse.quote(name)), params)


def unique_icons(icons):
    seen = set()
    unique = []
    for icon in icons:
        if not icon or ":" not in icon or icon in seen:
            continue
        seen.add(icon)
        unique.append(icon)
    return unique


def fetch_icon_result(icon):
    url = icon_url(icon)
    content_type, raw = fetch_bytes(url, "image/svg+xml,image/*,*/*")
    if b"<svg" not in raw[:1000].lower():
        return None
    encoded = base64.b64encode(raw).decode("ascii")
    prefix, name = icon.split(":", 1)
    return {
        "id": icon,
        "name": icon.replace(":", " / "),
        "sourceUrl": url,
        "pageUrl": "https://icon-sets.iconify.design/{}/{}".format(prefix, name),
        "imageData": "data:{};base64,{}".format(content_type or "image/svg+xml", encoded),
    }


def iconify_icon(args):
    query = str(arg_value(args, "query", "") or "").strip()
    if not query:
        return {"error": "Missing Iconify search query"}

    candidates = curated_icons(query)
    for fallback_query in context_queries(query):
        candidates.extend(search_icons(fallback_query))
    candidates.extend(search_icons(query))
    candidates = unique_icons(candidates)
    if not candidates:
        return {"error": "No Iconify icon found for {}".format(query)}

    results = []
    for icon in candidates:
        try:
            result = fetch_icon_result(icon)
            if result:
                results.append(result)
        except Exception:
            pass
        if len(results) >= 5:
            break

    if not results:
        return {"error": "Iconify did not return usable SVG icons"}

    selected = results[0]
    return {
        "output": {
            "id": selected["id"],
            "name": selected["name"],
            "sourceUrl": selected["sourceUrl"],
            "pageUrl": selected["pageUrl"],
            "imageData": selected["imageData"],
            "results": results,
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
