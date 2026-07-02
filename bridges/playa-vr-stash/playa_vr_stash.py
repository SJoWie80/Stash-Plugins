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
PUBLIC_BRIDGE_URL = os.environ.get("PUBLIC_BRIDGE_URL", "").rstrip("/")
STASH_API_KEY = os.environ.get("STASH_API_KEY", "")
HOST = os.environ.get("PLAYA_BRIDGE_HOST", "0.0.0.0")
PORT = int(os.environ.get("PLAYA_BRIDGE_PORT", "8890"))
PAGE_SIZE_MAX = 100
SCAN_PAGE_SIZE = int(os.environ.get("PLAYA_SCAN_PAGE_SIZE", "250"))
SCAN_MAX_PAGES = int(os.environ.get("PLAYA_SCAN_MAX_PAGES", "200"))
DEFAULT_PROJECTION = os.environ.get("PLAYA_DEFAULT_PROJECTION", "180").upper()
DEFAULT_STEREO = os.environ.get("PLAYA_DEFAULT_STEREO", "LR").upper()


def log(message):
    sys.stderr.write(f"[playa-vr-stash] {message}\n")


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
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        log(f"graphql http error status={error.code}: {details}")
        raise RuntimeError(f"Stash GraphQL HTTP {error.code}: {details[:500]}")
    if payload.get("errors"):
        message = "; ".join(error.get("message", str(error)) for error in payload["errors"])
        log(f"graphql error: {message}")
        raise RuntimeError(message)
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


def ids(items):
    return {str(item.get("id")) for item in (items or []) if item.get("id") is not None}


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

    normalized = re.sub(r"[^a-z0-9]+", " ", text)

    projection = DEFAULT_PROJECTION if DEFAULT_PROJECTION in {"FLT", "180", "360", "FSH"} else "180"
    if "fisheye" in normalized or re.search(r"\bfsh\b", normalized):
        projection = "FSH"
    elif re.search(r"\b360\b|360vr|vr360", normalized):
        projection = "360"
    elif re.search(r"\b180\b|180vr|vr180|\bvr\b", normalized):
        projection = "180"

    stereo = DEFAULT_STEREO if DEFAULT_STEREO in {"MN", "LR", "RL", "TB", "BT"} else "LR"
    if re.search(r"\b(tb|bt|top bottom|topbottom|over under|overunder|ou|3dv)\b", normalized):
        stereo = "TB"
    elif re.search(r"\b(lr|rl|sbs|hsbs|fsbs|side by side|sidebyside|3dh|3d)\b", normalized):
        stereo = "LR"

    return projection, stereo


def quality_for_scene(scene):
    file_info = (scene.get("files") or [{}])[0] or {}
    width = int(file_info.get("width") or 0)
    height = int(file_info.get("height") or 0)
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


def duration_seconds(scene):
    file_info = (scene.get("files") or [{}])[0] or {}
    return max(1, int(float(file_info.get("duration") or 0)))


def stash_stream_url(scene):
    paths = scene.get("paths") or {}
    if paths.get("stream"):
        return absolute_url(paths.get("stream"))
    return with_api_key(f"{PUBLIC_STASH_URL}/scene/{scene.get('id')}/stream")


def stream_url(scene, bridge_base_url):
    return f"{bridge_base_url}/api/playa/v2/stream/{scene.get('id')}"


def video_list_view(scene):
    projection, stereo = infer_projection_and_stereo(scene)
    duration = duration_seconds(scene)
    performers = names(scene.get("performers"))
    studio = scene.get("studio") or {}
    subtitle = " - ".join([studio.get("name") or "", ", ".join(performers[:3])]).strip(" -")
    return {
        "id": str(scene.get("id")),
        "title": scene_title(scene),
        "subtitle": subtitle,
        "status": "Published",
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


def video_view(scene, bridge_base_url):
    projection, stereo = infer_projection_and_stereo(scene)
    quality_name, quality_order = quality_for_scene(scene)
    duration = duration_seconds(scene)
    tags = scene.get("tags") or []
    performers = scene.get("performers") or []
    studio = scene.get("studio")
    return {
        "id": str(scene.get("id")),
        "title": scene_title(scene),
        "subtitle": studio.get("name") if studio else "",
        "description": scene.get("details") or "",
        "status": "Published",
        "preview_image": absolute_url((scene.get("paths") or {}).get("screenshot")),
        "release_date": unix_date(scene.get("date")),
        "studio": {"id": str(studio.get("id")), "title": studio.get("name")} if studio else None,
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
                        "url": stream_url(scene, bridge_base_url),
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
  play_count
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

    relation_filters = {
        "studio": str(params.get("studio", [""])[0] or ""),
        "actor": str(params.get("actor", [""])[0] or ""),
        "included_categories": [value for value in str(params.get("included-categories", [""])[0] or "").split(",") if value],
        "excluded_categories": [value for value in str(params.get("excluded-categories", [""])[0] or "").split(",") if value],
    }
    if any(relation_filters.values()):
        return find_scenes_by_scan(find_filter, relation_filters, page_index, page_size)

    data = graphql(
        f"""
        query PlayaScenes($filter: FindFilterType) {{
          findScenes(filter: $filter) {{
            count
            scenes {{ {SCENE_FIELDS} }}
          }}
        }}
        """,
        {"filter": find_filter},
    )
    result = data.get("findScenes") or {}
    scenes = result.get("scenes") or []
    total = int(result.get("count") or 0)
    log(f"videos page={page_index} size={page_size} filters=none returned={len(scenes)} total={total}")
    return page_response(page_index, page_size, total, [video_list_view(scene) for scene in scenes])


def scene_matches(scene, relation_filters):
    studio_id = relation_filters["studio"]
    actor_id = relation_filters["actor"]
    included = set(relation_filters["included_categories"])
    excluded = set(relation_filters["excluded_categories"])

    studio = scene.get("studio") or {}
    if studio_id and str(studio.get("id")) != studio_id:
        return False

    performer_ids = ids(scene.get("performers"))
    if actor_id and actor_id not in performer_ids:
        return False

    tag_ids = ids(scene.get("tags"))
    if included and not included.issubset(tag_ids):
        return False
    if excluded and excluded.intersection(tag_ids):
        return False

    return True


def find_scenes_by_scan(find_filter, relation_filters, page_index, page_size):
    matches = []
    scanned = 0
    total = 0
    scan_filter = dict(find_filter)
    scan_filter["per_page"] = SCAN_PAGE_SIZE

    for page in range(1, SCAN_MAX_PAGES + 1):
        scan_filter["page"] = page
        data = graphql(
            f"""
            query PlayaSceneScan($filter: FindFilterType) {{
              findScenes(filter: $filter) {{
                count
                scenes {{ {SCENE_FIELDS} }}
              }}
            }}
            """,
            {"filter": scan_filter},
        )
        result = data.get("findScenes") or {}
        scenes = result.get("scenes") or []
        total = int(result.get("count") or 0)
        scanned += len(scenes)
        matches.extend(scene for scene in scenes if scene_matches(scene, relation_filters))
        if not scenes or page * SCAN_PAGE_SIZE >= total:
            break

    start = page_index * page_size
    end = start + page_size
    page_matches = matches[start:end]
    log(
        "videos page={} size={} studio={} actor={} tags={} excluded={} scanned={} matches={}".format(
            page_index,
            page_size,
            relation_filters["studio"] or "-",
            relation_filters["actor"] or "-",
            ",".join(relation_filters["included_categories"]) or "-",
            ",".join(relation_filters["excluded_categories"]) or "-",
            scanned,
            len(matches),
        )
    )
    return page_response(page_index, page_size, len(matches), [video_list_view(scene) for scene in page_matches])


def get_scene(scene_id, bridge_base_url):
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
    return video_view(scene, bridge_base_url)


def get_scene_for_stream(scene_id):
    data = graphql(
        """
        query PlayaStreamScene($id: ID!) {
          findScene(id: $id) {
            id
            paths { stream }
          }
        }
        """,
        {"id": str(scene_id)},
    )
    return data.get("findScene")


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

    def bridge_base_url(self):
        if PUBLIC_BRIDGE_URL:
            return PUBLIC_BRIDGE_URL
        host = self.headers.get("Host") or f"{self.server.server_address[0]}:{self.server.server_address[1]}"
        return f"http://{host}".rstrip("/")

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

    def proxy_stream(self, scene_id, head_only=False):
        scene = get_scene_for_stream(scene_id)
        if not scene:
            self.send_json(fail("Video not found", 404), status=404)
            return

        target = stash_stream_url(scene)
        headers = {}
        if STASH_API_KEY:
            headers["ApiKey"] = STASH_API_KEY
        if self.headers.get("Range"):
            headers["Range"] = self.headers.get("Range")
        request = urllib.request.Request(target, headers=headers, method="HEAD" if head_only else "GET")
        try:
            response = urllib.request.urlopen(request, timeout=60)
        except urllib.error.HTTPError as error:
            details = error.read().decode("utf-8", errors="replace")
            log(f"stream error scene={scene_id} status={error.code}: {details[:500]}")
            self.send_response(error.code)
            self.end_headers()
            return

        status = response.getcode()
        self.send_response(status)
        passthrough_headers = [
            "Content-Type",
            "Content-Length",
            "Content-Range",
            "Accept-Ranges",
            "Last-Modified",
            "ETag",
        ]
        for name in passthrough_headers:
            value = response.headers.get(name)
            if value:
                self.send_header(name, value)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if head_only:
            response.close()
            return

        try:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            log(f"stream client disconnected scene={scene_id}")
        response.close()

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
                video = get_scene(path.split("/")[-1], self.bridge_base_url())
                self.send_json(ok(video) if video else fail("Video not found", 404))
            elif path.startswith("/stream/"):
                self.proxy_stream(path.split("/")[-1])
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
                self.send_json(ok([{"id": "published", "title": "Published"}]))
            else:
                self.send_json(fail("Route not found", 404), status=404)
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError) as error:
            log(f"request failed path={path}: {error}")
            self.send_json(fail(error))

    def do_HEAD(self):
        path = self.playa_path()
        try:
            if path.startswith("/stream/"):
                self.proxy_stream(path.split("/")[-1], head_only=True)
            else:
                self.send_response(404)
                self.end_headers()
        except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError) as error:
            log(f"head failed path={path}: {error}")
            self.send_response(500)
            self.end_headers()

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
