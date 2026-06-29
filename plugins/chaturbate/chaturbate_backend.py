import json
import sys
import urllib.parse
import urllib.request


def read_input():
    try:
        raw = sys.stdin.read()
        return json.loads(raw) if raw.strip() else {}
    except Exception:
        return {}


def arg_value(args, key):
    value = args.get(key, "")
    if isinstance(value, dict):
        return value.get("str") or value.get("value") or ""
    return value


def fetch_json(url):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 Stash Chaturbate Plugin",
            "Accept": "application/json,text/plain,*/*",
        },
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def main():
    payload = read_input()
    args = payload.get("args") or {}
    room = str(arg_value(args, "room")).strip()

    if not room:
        return {"error": "No room provided"}

    url = "https://chaturbate.com/api/chatvideocontext/{}/".format(
        urllib.parse.quote(room)
    )
    data = fetch_json(url)
    stream = data.get("hls_source")

    if not stream:
        return {"error": "No stream URL returned for room {}".format(room)}

    return {
        "output": {
            "room": room,
            "title": data.get("room_title", ""),
            "hls_source": stream,
        }
    }


print(json.dumps(main()))
