import json
import os
import sys
import time


STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "now_playing_state.json")
ACTIVE_SECONDS = 45
RECENT_SECONDS = 180


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


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2, sort_keys=True)
    os.replace(tmp, STATE_FILE)


def prune(state, now):
    sessions = state.get("sessions") or {}
    kept = {}
    for client_id, session in sessions.items():
        updated_at = float(session.get("updatedAt") or 0)
        if now - updated_at <= RECENT_SECONDS:
            kept[client_id] = session
    state["sessions"] = kept
    return state


def report(args):
    now = time.time()
    state = prune(load_state(), now)
    client_id = str(arg_value(args, "clientId", "") or "").strip()
    if not client_id:
        return {"error": "Missing clientId"}

    session = {
        "clientId": client_id,
        "clientName": arg_value(args, "clientName", "Browser"),
        "source": arg_value(args, "source", "browser"),
        "sceneId": str(arg_value(args, "sceneId", "") or ""),
        "title": arg_value(args, "title", ""),
        "studio": arg_value(args, "studio", ""),
        "performers": arg_value(args, "performers", []),
        "cover": arg_value(args, "cover", ""),
        "path": arg_value(args, "path", ""),
        "url": arg_value(args, "url", ""),
        "currentTime": float(arg_value(args, "currentTime", 0) or 0),
        "duration": float(arg_value(args, "duration", 0) or 0),
        "paused": bool(arg_value(args, "paused", False)),
        "userAgent": arg_value(args, "userAgent", ""),
        "updatedAt": now,
    }
    state.setdefault("sessions", {})[client_id] = session
    save_state(state)
    return {"output": {"ok": True, "session": session}}


def list_sessions():
    now = time.time()
    state = prune(load_state(), now)
    save_state(state)
    sessions = []
    for session in (state.get("sessions") or {}).values():
        updated_at = float(session.get("updatedAt") or 0)
        session["ageSeconds"] = max(0, int(now - updated_at))
        session["active"] = (now - updated_at <= ACTIVE_SECONDS) and not bool(session.get("paused"))
        sessions.append(session)
    sessions.sort(key=lambda item: (not item.get("active"), -float(item.get("updatedAt") or 0)))
    return {"output": {"sessions": sessions, "now": now}}


def clear(args):
    state = load_state()
    client_id = str(arg_value(args, "clientId", "") or "").strip()
    if client_id:
        state.setdefault("sessions", {}).pop(client_id, None)
    else:
        state["sessions"] = {}
    save_state(state)
    return {"output": {"ok": True}}


def main():
    payload = read_input()
    args = payload.get("args") or {}
    action = str(arg_value(args, "action", "list") or "list").lower()
    if action == "report":
        return report(args)
    if action == "clear":
        return clear(args)
    return list_sessions()


print(json.dumps(main()))
