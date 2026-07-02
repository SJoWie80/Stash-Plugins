#!/usr/bin/env python3
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


STASH_URL = os.environ.get("STASH_URL", "http://127.0.0.1:9999").rstrip("/")
PUBLIC_STASH_URL = os.environ.get("PUBLIC_STASH_URL", STASH_URL).rstrip("/")
STASH_API_KEY = os.environ.get("STASH_API_KEY", "")
HOST = os.environ.get("PLAYA_BRIDGE_HOST", "0.0.0.0")
PORT = int(os.environ.get("PLAYA_BRIDGE_PORT", "8890"))
PAGE_SIZE_MAX = 100


def ok(data=None):
    response = {"status": {"code": 1, "message": "ok"}}
    if data is not None:
        response["data"] = data
    return response


def fail(message, code=2):
    return {"status": {"code": code, "message": str(message)}}


def page_response(page_index, page_size, total, content):
    page_total = max(1, math.ceil(total / max(1, page_size)))
    return {
        "page_index": page_index,
        "page_size": page_size,
        "page_total": page_total,
        "item_total": total,
        "content": content,
    }


def graphql(query, variables=None):
    body = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if STASH_API_KEY:
        headers["ApiKey"] = STASH_API_KEY
    request = urllib.request.Request(f"{STASH_URL}/graphql", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("errors"):
        raise RuntimeError("; ".join(error.get("message", str(error)) for error in payload["errors"]))
    return payload.get("data") or {}


def absolute_url(value):
    if not value:
        return None
    if value.startswith("http://") or value.startswith("https://"):
        return with_api_key(value)
    return with_api_key(f"{PUBLIC_STASH_URL}/{value.lstrip('/')}")


def with_api_key(url):
    if not STASH_API_KEY or not url.startswith(PUBLIC_STASH_URL):
        return url
    parsed = urllib.parse.urlparse(url)
    params = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    if any(key.lower() == "apikey" for key, _ in params):
        return url
    params.append(("apikey", STASH_API_KEY))
    return urllib.parse.urlunparse(parsed._replace(query=urllib.parse.urlencode(params)))


def scene_title(scene):
    file_info = (scene.get("files") or [{}])[0] or {}
    return scene.get("title") or file_info.get("basename") or f"Scene {scene.get('id')}"


def names(items):
    return [item.get("name") for item in (items or []) if item.get("name")]


def unix_date(value):
    if not value:
        return None
    try:
        return int(time.mktime(time.strptime(value[:10], "%Y-%m-%d")))
    except Exception:
        return None


def infer_projection_and_stereo(scene):
    text = " ".join(
        [
            scene_title(scene),
            " ".join(names(scene.get("tags"))),
            " ".join((item.get("path") or "") for item in (scene.get("files") or [])),
        ]
    ).lower()

    projection = "FLT"
    if "fisheye" in text or "fsh" in text:
        projection = "FSH"
    elif "360" in text:
        projection = "360"
    elif "180" in text or "vr" in text:
        projection = "180"

    stereo = "MN"
    if re.search(r"\b(tb|bt|top[ -]?bottom|over[ -]?under|ou)\b", text):
        stereo = "TB"
    elif re.search(r"\b(lr|rl|sbs|side[ -]?by[ -]?side|3d)\b", text):
        stereo = "LR"

    return projection, stereo


def quality_for_scene(scene):
    width = int(scene.get("width") or 0)
    height = int(scene.get("height") or 0)
    size = max(width, height)
    if size >= 7680:
        return "8K", 85
    if size >= 5760:
        return "6K", 65
    if size >= 3840:
        return "4K", 45
    if size >= 1920:
        return "2K", 25
    if height:
        return f"{height}p", 15
    return "Source", 25


def stream_url(scene):
    paths = scene.get("paths") or {}
    if paths.get("stream"):
        return absolute_url(paths.get("stream"))
    return with_api_key(f"{PUBLIC_STASH_URL}/scene/{scene.get('id')}/stream")


def video_list_view(scene):
    projection, stereo = infer_projection_and_stereo(scene)
    duration = int(float(scene.get("duration") or 0))
    performers = names(scene.get("performers"))
    subtitle = " - ".join([scene.get("studio", {}).get("name") or "", ", ".join(performers[:3])]).strip(" -")
    return {
        "id": str(scene.get("id")),
        "title": scene_title(scene),
        "subtitle": subtitle,
        "preview_image": absolute_url((scene.get("paths") or {}).get("screenshot")),
        "release_date": unix_date(scene.get("date")),
        "has_scripts": False,
        "details": [
            {
                "type": "full",
                "duration_seconds": duration,
                "transparency_mode": 0,
                "has_scripts": False,
            }
        ],
    }


def video_view(scene):
    projection, stereo = infer_projection_and_stereo(scene)
    quality_name, quality_order = quality_for_scene(scene)
    duration = int(float(scene.get("duration") or 0))
    tags = scene.get("tags") or []
    performers = scene.get("performers") or []
    studio = scene.get("studio")
    return {
        "id": str(scene.get("id")),
        "title": scene_title(scene),
        "subtitle": studio.get("name") if studio else "",
        "description": scene.get("details") or "",
        "preview_image": absolute_url((scene.get("paths") or {}).get("screenshot")),
        "release_date": unix_date(scene.get("date")),
        "studio": [{"id": str(studio.get("id")), "title": studio.get("name")}] if studio else [],
        "categories": [{"id": str(tag.get("id")), "title": tag.get("name")} for tag in tags],
        "actors": [{"id": str(actor.get("id")), "title": actor.get("name")} for actor in performers],
        "views": int(scene.get("play_count") or 0),
        "transparency": {"m": 0},
        "details": [
            {
                "type": "full",
                "duration_seconds": duration,
                "links": [
                    {
                        "is_stream": True,
                        "is_download": True,
                        "url": stream_url(scene),
                        "projection": projection,
                        "stereo": stereo,
                        "quality_name": quality_name,
                        "quality_order": quality_order,
                    }
                ],
            }
        ],
    }


SCENE_FIELDS = """
  id
  title
  details
  date
  duration
  play_count
  width
  height
  paths { screenshot stream }
  files { path basename }
  studio { id name }
  performers { id name }
  tags { id name }
"""


def find_scenes(params):
    page_index = max(0, int(params.get("page-index", ["0"])[0] or 0))
    page_size = min(PAGE_SIZE_MAX, max(1, int(params.get("page-size", ["30"])[0] or 30)))
    order = params.get("order", [""])[0]
    direction = params.get("direction", ["desc"])[0].upper()
    sort_map = {"title": "title", "release_date": "date", "popularity": "play_count"}
    find_filter = {
        "page": page_index + 1,
        "per_page": page_size,
        "sort": sort_map.get(order, "date"),
        "direction": "ASC" if direction == "ASC" else "DESC",
    }
    if params.get("title", [""])[0]:
        find_filter["q"] = params["title"][0]

    scene_filter = {}
    if params.get("studio", [""])[0]:
        scene_filter["studios"] = {"value": [params["studio"][0]], "modifier": "INCLUDES"}
    if params.get("actor", [""])[0]:
        scene_filter["performers"] = {"value": [params["actor"][0]], "modifier": "INCLUDES"}
    if params.get("included-categories", [""])[0]:
        scene_filter["tags"] = {"value": params["included-categories"][0].split(","), "modifier": "INCLUDES_ALL"}

    data = graphql(
        f"""
        query PlayaScenes($filter: FindFilterType, $sceneFilter: SceneFilterType) {{
          findScenes(filter: $filter, scene_filter: $sceneFilter) {{
            count
            scenes {{ {SCENE_FIELDS} }}
          }}
        }}
        """,
        {"filter": find_filter, "sceneFilter": scene_filter or None},
    )
    result = data.get("findScenes") or {}
    scenes = result.get("scenes") or []
    return page_response(page_index, page_size, int(result.get("count") or 0), [video_list_view(scene) for scene in scenes])


def get_scene(scene_id):
    data = graphql(
        f"""
        query PlayaScene($id: ID!) {{
          findScene(id: $id) {{ {SCENE_FIELDS} }}
        }}
        """,
        {"id": str(scene_id)},
    )
    scene = data.get("findScene")
    if not scene:
        return None
    return video_view(scene)


def find_people(params, kind):
    page_index = max(0, int(params.get("page-index", ["0"])[0] or 0))
    page_size = min(PAGE_SIZE_MAX, max(1, int(params.get("page-size", ["30"])[0] or 30)))
    query_name = "findPerformers" if kind == "actors" else "findStudios"
    list_name = "performers" if kind == "actors" else "studios"
    find_filter = {
        "page": page_index + 1,
        "per_page": page_size,
        "sort": "name",
        "direction": "ASC",
    }
    if params.get("title", [""])[0]:
        find_filter["q"] = params["title"][0]
    data = graphql(
        f"""
        query PlayaDirectory($filter: FindFilterType) {{
          {query_name}(filter: $filter) {{
            count
            {list_name} {{ id name image_path details }}
          }}
        }}
        """,
        {"filter": find_filter},
    )
    result = data.get(query_name) or {}
    content = [
        {"id": str(item.get("id")), "title": item.get("name"), "preview": absolute_url(item.get("image_path"))}
        for item in (result.get(list_name) or [])
    ]
    return page_response(page_index, page_size, int(result.get("count") or 0), content)


def get_person(item_id, kind):
    query_name = "findPerformer" if kind == "actors" else "findStudio"
    data = graphql(
        f"""
        query PlayaItem($id: ID!) {{
          {query_name}(id: $id) {{ id name image_path details }}
        }}
        """,
        {"id": str(item_id)},
    )
    item = data.get(query_name)
    if not item:
        return None
    base = {
        "id": str(item.get("id")),
        "title": item.get("name"),
        "preview": absolute_url(item.get("image_path")),
        "description": item.get("details") or "",
        "views": 0,
    }
    if kind == "actors":
        base["properties"] = []
        base["aliases"] = []
    return base


def get_categories():
    data = graphql(
        """
        query PlayaTags($filter: FindFilterType) {
          findTags(filter: $filter) {
            tags { id name image_path }
          }
        }
        """,
        {"filter": {"page": 1, "per_page": 1000, "sort": "name", "direction": "ASC"}},
    )
    tags = ((data.get("findTags") or {}).get("tags") or [])
    return [{"id": str(tag.get("id")), "title": tag.get("name"), "preview": absolute_url(tag.get("image_path"))} for tag in tags]


class Handler(BaseHTTPRequestHandler):
    server_version = "StashPlayaBridge/0.1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_json(self, payload, status=200):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def playa_path(self):
        path = urllib.parse.urlparse(self.path).path.rstrip("/")
        prefix = "/api/playa/v2"
        if path.startswith(prefix):
            path = path[len(prefix):] or "/"
        return path

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type, authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = self.playa_path()
        params = urllib.parse.parse_qs(parsed.query)
        try:
            if path in ("", "/"):
                self.send_json(ok({"name": "Stash PLAY'A VR Bridge", "api": "/api/playa/v2"}))
            elif path == "/version":
                self.send_json(ok("1.10.0"))
            elif path == "/config":
                self.send_json(
                    ok(
                        {
                            "site_name": "Stash",
                            "auth": False,
                            "auth_by_code": False,
                            "actors": True,
                            "categories": True,
                            "categories_groups": True,
                            "studios": True,
                            "scripts": False,
                            "masks": False,
                            "analytics": True,
                            "nsfw": False,
                            "ar": False,
                        }
                    )
                )
            elif path == "/videos":
                self.send_json(ok(find_scenes(params)))
            elif path.startswith("/video/"):
                video = get_scene(path.split("/")[-1])
                self.send_json(ok(video) if video else fail("Video not found", 404))
            elif path == "/actors":
                self.send_json(ok(find_people(params, "actors")))
            elif path.startswith("/actor/"):
                item = get_person(path.split("/")[-1], "actors")
                self.send_json(ok(item) if item else fail("Actor not found", 404))
            elif path == "/studios":
                self.send_json(ok(find_people(params, "studios")))
            elif path.startswith("/studio/"):
                item = get_person(path.split("/")[-1], "studios")
                self.send_json(ok(item) if item else fail("Studio not found", 404))
            elif path == "/categories":
                self.send_json(ok(get_categories()))
            elif path == "/categories-groups":
                self.send_json(ok([{"id": "stash-tags", "title": "Tags", "items": get_categories()}]))
            elif path == "/video-statuses":
                self.send_json(ok([]))
            else:
                self.send_json(fail("Route not found", 404), status=404)
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError) as error:
            self.send_json(fail(error))

    def do_POST(self):
        self.route_write()

    def do_PUT(self):
        self.route_write()

    def route_write(self):
        path = self.playa_path()
        try:
            _ = self.read_json()
        except Exception:
            pass
        if path == "/event":
            self.send_json(ok())
        elif path.startswith("/auth/"):
            self.send_json(fail("Authentication is disabled", 401))
        else:
            self.send_json(fail("Route not found", 404), status=404)


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Stash PLAY'A VR Bridge listening on http://{HOST}:{PORT}")
    print(f"Using Stash at {STASH_URL}")
    server.serve_forever()


if __name__ == "__main__":
    main()
