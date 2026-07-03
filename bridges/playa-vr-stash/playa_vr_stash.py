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
from io import BytesIO
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from PIL import Image, ImageOps
except Exception:
    Image = None
    ImageOps = None

try:
    import cairosvg
except Exception:
    cairosvg = None


STASH_URL = os.environ.get("STASH_URL", "http://127.0.0.1:9999").rstrip("/")
PUBLIC_STASH_URL = os.environ.get("PUBLIC_STASH_URL", STASH_URL).rstrip("/")
PUBLIC_BRIDGE_URL = os.environ.get("PUBLIC_BRIDGE_URL", "").rstrip("/")
STASH_API_KEY = os.environ.get("STASH_API_KEY", "")
HOST = os.environ.get("PLAYA_BRIDGE_HOST", "0.0.0.0")
PORT = int(os.environ.get("PLAYA_BRIDGE_PORT", "8890"))
SITE_LOGO_URL = os.environ.get("PLAYA_SITE_LOGO", "").strip()
SITE_LOGO_PATH = os.environ.get("PLAYA_SITE_LOGO_PATH", "/app/assets/stash.png")
PASSTHROUGH_TAG_NAMES = {
    value.strip().lower()
    for value in os.environ.get("PLAYA_PASSTHROUGH_TAGS", "Passthrough").split(",")
    if value.strip()
}
PASSTHROUGH_MODE = int(os.environ.get("PLAYA_PASSTHROUGH_MODE", "1"))
PASSTHROUGH_CATEGORY_ID = "__passthrough"
CHROMA_KEY_STUDIO_NAMES = {
    value.strip().lower()
    for value in os.environ.get("PLAYA_CHROMA_KEY_STUDIOS", "CzechAR,Czech AR").split(",")
    if value.strip()
}
CHROMA_KEY_TAG_NAMES = {
    value.strip().lower()
    for value in os.environ.get("PLAYA_CHROMA_KEY_TAGS", "Chroma Key,Green Screen,Greenscreen").split(",")
    if value.strip()
}
CHROMA_KEY_COLORS = [
    [int(channel.strip()) for channel in color.split(",")[:3]]
    for color in os.environ.get("PLAYA_CHROMA_KEY_COLORS", "18,218,0;190,0,255;255,0,0;0,80,255").split(";")
    if color.strip()
][:4]
CHROMA_KEY_RANGE = float(os.environ.get("PLAYA_CHROMA_KEY_RANGE", "0.2"))
CHROMA_KEY_SMOOTH = float(os.environ.get("PLAYA_CHROMA_KEY_SMOOTH", "0.5"))
CHROMA_KEY_HUE = float(os.environ.get("PLAYA_CHROMA_KEY_HUE", "0.1"))
CHROMA_KEY_SATURATION = float(os.environ.get("PLAYA_CHROMA_KEY_SATURATION", "-0.25"))
CHROMA_KEY_BRIGHTNESS = float(os.environ.get("PLAYA_CHROMA_KEY_BRIGHTNESS", "-0.8"))
PAGE_SIZE_MAX = 100
SCAN_PAGE_SIZE = int(os.environ.get("PLAYA_SCAN_PAGE_SIZE", "250"))
SCAN_MAX_PAGES = int(os.environ.get("PLAYA_SCAN_MAX_PAGES", "200"))
DEFAULT_PROJECTION = os.environ.get("PLAYA_DEFAULT_PROJECTION", "180").upper()
DEFAULT_STEREO = os.environ.get("PLAYA_DEFAULT_STEREO", "LR").upper()
SHOW_VIDEO_STATUS = os.environ.get("PLAYA_SHOW_VIDEO_STATUS", "false").lower() in {"1", "true", "yes", "on"}
SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"}
IMAGE_TILE_SIZE = int(os.environ.get("PLAYA_IMAGE_TILE_SIZE", "512"))
IMAGE_PROXY_VERSION = "5"
IMAGE_SHAPES = {
    "square": (IMAGE_TILE_SIZE, IMAGE_TILE_SIZE),
    "portrait": (IMAGE_TILE_SIZE, int(IMAGE_TILE_SIZE * 1.35)),
    "video": (IMAGE_TILE_SIZE, int(IMAGE_TILE_SIZE * 9 / 16)),
}


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
    graphql_url = f"{STASH_URL}/graphql"
    request = urllib.request.Request(graphql_url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as error:
        log(f"stash connection failed url={graphql_url}: {error}")
        raise
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


def preview_url(value, bridge_base_url, shape="square"):
    if not value:
        return None
    parsed = urllib.parse.urlparse(value)
    extension = os.path.splitext(parsed.path.lower())[1]
    if extension and extension not in SUPPORTED_IMAGE_EXTENSIONS:
        return None
    source = absolute_url(value)
    return f"{bridge_base_url}/api/playa/v2/image?v={IMAGE_PROXY_VERSION}&shape={shape}&url={urllib.parse.quote(source, safe='')}"


def site_logo_url(bridge_base_url):
    return SITE_LOGO_URL or f"{bridge_base_url}/api/playa/v2/logo.png"


def trim_transparent(image):
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    alpha = image.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        return image
    return image.crop(bbox)


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


def passthrough_mode(scene):
    tag_names = {name.lower() for name in names(scene.get("tags"))}
    studio = scene.get("studio") or {}
    studio_name = (studio.get("name") or "").lower()
    if tag_names.intersection(CHROMA_KEY_TAG_NAMES):
        return 2
    if tag_names.intersection(PASSTHROUGH_TAG_NAMES):
        if studio_name in CHROMA_KEY_STUDIO_NAMES:
            return 2
        return PASSTHROUGH_MODE
    return 0


def is_passthrough(scene):
    return passthrough_mode(scene) > 0


def scene_status_ids(scene):
    rating = int(scene.get("rating100") or 0)
    play_count = int(scene.get("play_count") or 0)
    statuses = set()
    if SHOW_VIDEO_STATUS:
        statuses.add("published")
    if rating >= 100:
        statuses.add("favorite")
    if rating > 0:
        statuses.add("rated")
    if scene.get("organized"):
        statuses.add("organized")
    if play_count > 0:
        statuses.add("watched")
    else:
        statuses.add("unwatched")
    if is_passthrough(scene):
        statuses.add("passthrough")
    return statuses


def transparency_info(scene):
    mode = passthrough_mode(scene)
    if mode == 1:
        return {"m": 1}
    if mode == 2:
        return {
            "m": 2,
            "i": False,
            "c": [
                {
                    "e": True,
                    "r": CHROMA_KEY_RANGE,
                    "f": CHROMA_KEY_SMOOTH,
                    "c": {"r": color[0], "g": color[1], "b": color[2]},
                    "h": CHROMA_KEY_HUE,
                    "s": CHROMA_KEY_SATURATION,
                    "v": CHROMA_KEY_BRIGHTNESS,
                }
                for color in CHROMA_KEY_COLORS
                if len(color) == 3
            ],
        }
    if mode == 3:
        return {"m": 3}
    return {"m": 0}


def stash_stream_url(scene):
    paths = scene.get("paths") or {}
    if paths.get("stream"):
        return absolute_url(paths.get("stream"))
    return with_api_key(f"{PUBLIC_STASH_URL}/scene/{scene.get('id')}/stream")


def stream_url(scene, bridge_base_url):
    return f"{bridge_base_url}/api/playa/v2/stream/{scene.get('id')}"


def scene_preview_image(scene, bridge_base_url):
    paths = scene.get("paths") or {}
    for key in ("screenshot", "webp"):
        if paths.get(key):
            return preview_url(paths.get(key), bridge_base_url, "video")
    scene_id = scene.get("id")
    if scene_id:
        return preview_url(f"{PUBLIC_STASH_URL}/scene/{scene_id}/screenshot", bridge_base_url, "video")
    return None


def video_list_view(scene, bridge_base_url):
    projection, stereo = infer_projection_and_stereo(scene)
    duration = duration_seconds(scene)
    transparency_mode = passthrough_mode(scene)
    performers = names(scene.get("performers"))
    studio = scene.get("studio") or {}
    subtitle = " - ".join([studio.get("name") or "", ", ".join(performers[:3])]).strip(" -")
    video = {
        "id": str(scene.get("id")),
        "title": scene_title(scene),
        "subtitle": subtitle,
        "preview_image": scene_preview_image(scene, bridge_base_url),
        "release_date": unix_date(scene.get("date")),
        "has_scripts": False,
        "details": [
            {
                "type": "full",
                "duration_seconds": duration,
                "transparency_mode": transparency_mode,
                "has_scripts": False,
            }
        ],
    }
    if SHOW_VIDEO_STATUS:
        video["status"] = "Published"
    return video


def video_view(scene, bridge_base_url):
    projection, stereo = infer_projection_and_stereo(scene)
    quality_name, quality_order = quality_for_scene(scene)
    duration = duration_seconds(scene)
    tags = scene.get("tags") or []
    performers = scene.get("performers") or []
    studio = scene.get("studio")
    video = {
        "id": str(scene.get("id")),
        "title": scene_title(scene),
        "subtitle": studio.get("name") if studio else "",
        "description": scene.get("details") or "",
        "preview_image": scene_preview_image(scene, bridge_base_url),
        "release_date": unix_date(scene.get("date")),
        "studio": {"id": str(studio.get("id")), "title": studio.get("name")} if studio else None,
        "categories": [{"id": str(tag.get("id")), "title": tag.get("name")} for tag in tags],
        "actors": [{"id": str(actor.get("id")), "title": actor.get("name")} for actor in performers],
        "views": int(scene.get("play_count") or 0),
        "transparency": transparency_info(scene),
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
    if SHOW_VIDEO_STATUS:
        video["status"] = "Published"
    return video


SCENE_FIELDS = """
  id
  title
  details
  date
  play_count
  rating100
  organized
  paths { screenshot stream webp }
  files { path basename }
  studio { id name }
  performers { id name }
  tags { id name }
"""


def find_scenes(params, bridge_base_url):
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
        "included_statuses": [value for value in str(params.get("included-statuses", [""])[0] or "").split(",") if value],
        "excluded_statuses": [value for value in str(params.get("excluded-statuses", [""])[0] or "").split(",") if value],
    }
    if any(relation_filters.values()):
        return find_scenes_by_scan(find_filter, relation_filters, page_index, page_size, bridge_base_url)

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
    return page_response(page_index, page_size, total, [video_list_view(scene, bridge_base_url) for scene in scenes])


def scene_matches(scene, relation_filters):
    studio_id = relation_filters["studio"]
    actor_id = relation_filters["actor"]
    included = set(relation_filters["included_categories"])
    excluded = set(relation_filters["excluded_categories"])
    included_statuses = set(relation_filters["included_statuses"])
    excluded_statuses = set(relation_filters["excluded_statuses"])

    studio = scene.get("studio") or {}
    if studio_id and str(studio.get("id")) != studio_id:
        return False

    performer_ids = ids(scene.get("performers"))
    if actor_id and actor_id not in performer_ids:
        return False

    tag_ids = ids(scene.get("tags"))
    if PASSTHROUGH_CATEGORY_ID in included:
        if not is_passthrough(scene):
            return False
        included.remove(PASSTHROUGH_CATEGORY_ID)
    if PASSTHROUGH_CATEGORY_ID in excluded:
        if is_passthrough(scene):
            return False
        excluded.remove(PASSTHROUGH_CATEGORY_ID)
    if included and not included.issubset(tag_ids):
        return False
    if excluded and excluded.intersection(tag_ids):
        return False

    status_ids = scene_status_ids(scene)
    if included_statuses and not included_statuses.intersection(status_ids):
        return False
    if excluded_statuses and excluded_statuses.intersection(status_ids):
        return False

    return True


def find_scenes_by_scan(find_filter, relation_filters, page_index, page_size, bridge_base_url):
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
    return page_response(page_index, page_size, len(matches), [video_list_view(scene, bridge_base_url) for scene in page_matches])


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


def find_people(params, kind, bridge_base_url):
    page_index = max(0, int(params.get("page-index", ["0"])[0] or 0))
    page_size = min(PAGE_SIZE_MAX, max(1, int(params.get("page-size", ["30"])[0] or 30)))
    if kind == "studios":
        return find_studios_by_scene_count(page_index, page_size, params, bridge_base_url)

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
    content = []
    for item in (result.get(list_name) or []):
        preview = preview_url(item.get("image_path"), bridge_base_url, "portrait" if kind == "actors" else "square")
        content.append(
            {
                "id": str(item.get("id")),
                "title": item.get("name") if kind == "studios" or not preview else "",
                "preview": preview,
            }
        )
    return page_response(page_index, page_size, int(result.get("count") or 0), content)


def find_studios_by_scene_count(page_index, page_size, params, bridge_base_url):
    query = (params.get("title", [""])[0] or "").lower()
    data = graphql(
        """
        query PlayaStudiosForCounts($filter: FindFilterType) {
          findStudios(filter: $filter) {
            studios { id name image_path details }
          }
        }
        """,
        {"filter": {"page": 1, "per_page": 1000, "sort": "name", "direction": "ASC"}},
    )
    studios = ((data.get("findStudios") or {}).get("studios") or [])
    if query:
        studios = [studio for studio in studios if query in (studio.get("name") or "").lower()]

    counts = scene_counts_by_studio()
    studios.sort(key=lambda studio: (-counts.get(str(studio.get("id")), 0), (studio.get("name") or "").lower()))
    start = page_index * page_size
    end = start + page_size
    content = []
    for studio in studios[start:end]:
        content.append(
            {
                "id": str(studio.get("id")),
                "title": studio.get("name"),
                "preview": preview_url(studio.get("image_path"), bridge_base_url, "square"),
            }
        )
    return page_response(page_index, page_size, len(studios), content)


def scene_counts_by_studio():
    counts = {}
    scan_filter = {"page": 1, "per_page": SCAN_PAGE_SIZE}
    for page in range(1, SCAN_MAX_PAGES + 1):
        scan_filter["page"] = page
        data = graphql(
            """
            query PlayaStudioSceneCounts($filter: FindFilterType) {
              findScenes(filter: $filter) {
                count
                scenes { studio { id } }
              }
            }
            """,
            {"filter": scan_filter},
        )
        result = data.get("findScenes") or {}
        scenes = result.get("scenes") or []
        for scene in scenes:
            studio = scene.get("studio") or {}
            studio_id = studio.get("id")
            if studio_id is not None:
                key = str(studio_id)
                counts[key] = counts.get(key, 0) + 1
        total = int(result.get("count") or 0)
        if not scenes or page * SCAN_PAGE_SIZE >= total:
            break
    return counts


def get_person(item_id, kind, bridge_base_url):
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
        "preview": preview_url(item.get("image_path"), bridge_base_url, "portrait" if kind == "actors" else "square"),
        "description": item.get("details") or "",
        "views": 0,
    }
    if kind == "actors":
        base["properties"] = []
        base["aliases"] = []
    return base


def get_categories(bridge_base_url):
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
    content = [{"id": PASSTHROUGH_CATEGORY_ID, "title": "Passthrough", "preview": None}]
    for tag in tags:
        preview = preview_url(tag.get("image_path"), bridge_base_url)
        content.append({"id": str(tag.get("id")), "title": tag.get("name"), "preview": preview})
    return content


def get_video_statuses():
    statuses = [
        {"id": "favorite", "title": "Favorites"},
        {"id": "organized", "title": "Organized"},
        {"id": "watched", "title": "Watched"},
        {"id": "unwatched", "title": "Unwatched"},
        {"id": "rated", "title": "Rated"},
        {"id": "passthrough", "title": "Passthrough"},
    ]
    if SHOW_VIDEO_STATUS:
        statuses.insert(0, {"id": "published", "title": "Published"})
    return statuses


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

    def send_logo(self):
        try:
            with open(SITE_LOGO_PATH, "rb") as logo:
                body = logo.read()
        except OSError:
            self.send_response(404)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def health(self):
        payload = {
            "bridge": "ok",
            "stash_url": STASH_URL,
            "public_stash_url": PUBLIC_STASH_URL,
            "public_bridge_url": PUBLIC_BRIDGE_URL or self.bridge_base_url(),
        }
        try:
            data = graphql("query PlayaHealth { version { version } }", {})
            payload["stash"] = "ok"
            payload["stash_version"] = (((data or {}).get("version") or {}).get("version")) or data.get("version")
            self.send_json(ok(payload))
        except Exception as error:
            payload["stash"] = "error"
            payload["error"] = str(error)
            self.send_json(fail(payload))

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

    def proxy_image(self, params):
        source = (params.get("url") or [""])[0]
        shape = (params.get("shape") or ["square"])[0]
        if not source:
            self.send_response(404)
            self.end_headers()
            return

        parsed = urllib.parse.urlparse(source)
        extension = os.path.splitext(parsed.path.lower())[1]
        if extension and extension not in SUPPORTED_IMAGE_EXTENSIONS:
            self.send_response(415)
            self.end_headers()
            return
        target_size = IMAGE_SHAPES.get(shape, IMAGE_SHAPES["square"])

        headers = {}
        if STASH_API_KEY and source.startswith(PUBLIC_STASH_URL):
            headers["ApiKey"] = STASH_API_KEY
        request = urllib.request.Request(source, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
                content_type = response.headers.get("Content-Type") or "image/jpeg"
            if extension == ".svg" or "svg" in content_type.lower():
                if cairosvg is None:
                    raise RuntimeError("SVG conversion is unavailable")
                raw = cairosvg.svg2png(bytestring=raw, output_width=target_size[0] * 2, output_height=target_size[1] * 2)
                content_type = "image/png"

            if Image is None or ImageOps is None:
                body = raw
                output_type = content_type
            else:
                image = Image.open(BytesIO(raw))
                image = ImageOps.exif_transpose(image).convert("RGBA")
                image = trim_transparent(image)
                fitted = ImageOps.contain(image, target_size, Image.Resampling.LANCZOS)
                canvas = Image.new("RGBA", target_size, (0, 0, 0, 0))
                x = (target_size[0] - fitted.width) // 2
                y = (target_size[1] - fitted.height) // 2
                canvas.paste(fitted, (x, y), fitted)
                output = BytesIO()
                canvas.save(output, format="PNG", optimize=True)
                body = output.getvalue()
                output_type = "image/png"
        except Exception as error:
            log(f"image proxy failed: {error}")
            self.send_response(415)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", output_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=86400")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = self.playa_path()
        params = urllib.parse.parse_qs(parsed.query)
        try:
            if path in ("", "/"):
                self.send_json(ok({"name": "Stash PLAY'A VR Bridge", "api": "/api/playa/v2"}))
            elif path in ("/health", "/debug/stash"):
                self.health()
            elif path == "/version":
                self.send_json(ok("1.10.0"))
            elif path == "/config":
                self.send_json(
                    ok(
                        {
                            "site_name": "Stash",
                            "site_logo": site_logo_url(self.bridge_base_url()),
                            "auth": False,
                            "auth_by_code": False,
                            "actors": True,
                            "categories": True,
                            "categories_groups": True,
                            "studios": True,
                            "scripts": False,
                            "masks": True,
                            "analytics": True,
                            "nsfw": False,
                            "ar": False,
                        }
                    )
                )
            elif path == "/logo.png":
                self.send_logo()
            elif path == "/videos":
                self.send_json(ok(find_scenes(params, self.bridge_base_url())))
            elif path.startswith("/video/"):
                video = get_scene(path.split("/")[-1], self.bridge_base_url())
                self.send_json(ok(video) if video else fail("Video not found", 404))
            elif path.startswith("/stream/"):
                self.proxy_stream(path.split("/")[-1])
            elif path == "/image":
                self.proxy_image(params)
            elif path == "/actors":
                self.send_json(ok(find_people(params, "actors", self.bridge_base_url())))
            elif path.startswith("/actor/"):
                item = get_person(path.split("/")[-1], "actors", self.bridge_base_url())
                self.send_json(ok(item) if item else fail("Actor not found", 404))
            elif path == "/studios":
                self.send_json(ok(find_people(params, "studios", self.bridge_base_url())))
            elif path.startswith("/studio/"):
                item = get_person(path.split("/")[-1], "studios", self.bridge_base_url())
                self.send_json(ok(item) if item else fail("Studio not found", 404))
            elif path == "/categories":
                self.send_json(ok(get_categories(self.bridge_base_url())))
            elif path == "/categories-groups":
                self.send_json(ok([{"id": "stash-tags", "title": "Tags", "items": get_categories(self.bridge_base_url())}]))
            elif path == "/video-statuses":
                self.send_json(ok(get_video_statuses()))
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
