import html
import json
import os
import re
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".m4v", ".webm"}
DEFAULT_USER_AGENT = "Mozilla/5.0 Stash Funscript Scraper"
STOP_TOKENS = {
    "1080", "1080p", "2160", "2160p", "720", "720p", "480", "480p", "4k", "5k", "6k", "8k",
    "uhd", "hd", "fhd", "web", "webdl", "webrip", "x264", "x265", "h264", "h265", "hevc",
    "mp4", "mkv", "avi", "wmv", "mov", "vr", "180", "360", "60fps", "fps", "com", "www",
    "scene", "scenes", "video", "videos", "part", "pt",
}


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


def normalize(value):
    text = html.unescape(str(value or "")).lower()
    text = re.sub(r"\[[^\]]+\]|\([^)]+\)", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def tokens(value):
    result = []
    for part in normalize(value).split(" "):
        if len(part) < 2 or part in STOP_TOKENS:
            continue
        if part.isdigit() and len(part) > 2:
            continue
        result.append(part)
    return result


def score_text(needle, haystack):
    needle_tokens = tokens(needle)
    haystack_tokens = tokens(haystack)
    haystack_norm = " ".join(haystack_tokens)
    needle_norm = " ".join(needle_tokens)
    if not needle_tokens or not haystack_tokens:
        return 0
    needle_set = set(needle_tokens)
    haystack_set = set(haystack_tokens)
    hits = len(needle_set & haystack_set)
    query_coverage = hits / max(1, len(needle_set))
    candidate_coverage = hits / max(1, len(haystack_set))
    short_coverage = hits / max(1, min(len(needle_set), len(haystack_set)))
    score = int(100 * max(query_coverage, candidate_coverage, short_coverage * 0.92))
    if needle_norm and needle_norm in haystack_norm:
        score = max(score, 95)
    return score


def scene_queries(scene):
    path = scene.get("path") or ""
    base = os.path.splitext(os.path.basename(path))[0]
    values = [
        base,
        scene.get("title") or "",
        "{} {}".format(scene.get("studio") or "", scene.get("title") or "").strip(),
    ]
    for performer in scene.get("performers") or []:
        values.append("{} {}".format(performer, scene.get("title") or "").strip())
        values.append("{} {}".format(performer, base).strip())
    unique = []
    seen = set()
    for value in values:
        clean = normalize(value)
        if clean and clean not in seen:
            seen.add(clean)
            unique.append(value)
    return unique


def funscript_path_for_video(video_path):
    root, ext = os.path.splitext(video_path)
    if ext.lower() not in VIDEO_EXTENSIONS:
        root = video_path
    return root + ".funscript"


def validate_funscript(path):
    with open(path, "r", encoding="utf-8-sig") as handle:
        data = json.load(handle)
    actions = data.get("actions")
    if not isinstance(actions, list) or not actions:
        raise ValueError("funscript has no actions")
    for action in actions[:25]:
        if not isinstance(action, dict) or "at" not in action or "pos" not in action:
            raise ValueError("funscript contains invalid actions")
    last_at = 0
    for action in actions:
        try:
            at = int(action.get("at"))
            pos = int(action.get("pos"))
        except Exception as exc:
            raise ValueError("funscript action values must be numeric") from exc
        if at < last_at:
            raise ValueError("funscript actions are not sorted")
        if pos < 0 or pos > 100:
            raise ValueError("funscript position out of range")
        last_at = at
    return {"actions": len(actions), "durationMs": last_at}


def copy_candidate(source_path, target_path, dry_run, overwrite):
    if os.path.exists(target_path) and not overwrite:
        return {"placed": False, "reason": "target exists"}
    if dry_run:
        return {"placed": False, "reason": "dry run"}
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    tmp = target_path + ".tmp"
    shutil.copyfile(source_path, tmp)
    os.replace(tmp, target_path)
    return {"placed": True, "path": target_path}


def find_local(scene, settings):
    roots = settings.get("localFolders") or []
    min_score = int(settings.get("minScore") or 70)
    queries = scene_queries(scene)
    best = None
    checked = 0
    for root in roots:
        root = str(root or "").strip()
        if not root or not os.path.isdir(root):
            continue
        for dirpath, _, filenames in os.walk(root):
            for filename in filenames:
                if not filename.lower().endswith(".funscript"):
                    continue
                checked += 1
                full_path = os.path.join(dirpath, filename)
                name = os.path.splitext(filename)[0]
                score = max(score_text(query, name) for query in queries)
                if score >= min_score and (not best or score > best["score"]):
                    best = {
                        "source": "local",
                        "title": filename,
                        "score": score,
                        "path": full_path,
                        "localPath": full_path,
                        "checked": checked,
                    }
    return best


def request_url(url, headers=None, binary=False):
    request_headers = {"User-Agent": DEFAULT_USER_AGENT, "Accept": "*/*"}
    request_headers.update(headers or {})
    request = urllib.request.Request(url, headers=request_headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
    return raw if binary else raw.decode("utf-8", errors="replace")


def absolutize(base_url, url):
    return urllib.parse.urljoin(base_url, html.unescape(url or ""))


def compile_regex(pattern):
    return re.compile(pattern, re.IGNORECASE | re.DOTALL)


def find_online(scene, settings):
    providers = settings.get("providers") or []
    min_score = int(settings.get("minScore") or 70)
    queries = scene_queries(scene)
    for provider in providers:
        if not provider or provider.get("enabled") is False:
            continue
        provider_type = str(provider.get("type") or "regex").lower()
        if provider_type == "github":
            candidate = find_github(scene, provider, min_score)
            if candidate:
                return candidate
            continue
        search_template = str(provider.get("searchUrlTemplate") or "").strip()
        result_regex = str(provider.get("resultRegex") or "").strip()
        download_regex = str(provider.get("downloadRegex") or "").strip()
        if not search_template or not result_regex:
            continue
        headers = provider.get("headers") or {}
        for query in queries[:4]:
            search_url = search_template.replace("{query}", urllib.parse.quote_plus(query))
            try:
                page = request_url(search_url, headers=headers)
            except Exception as exc:
                return {
                    "source": provider.get("name") or "online",
                    "error": "search failed: {}".format(exc),
                    "score": 0,
                }
            matches = []
            for match in compile_regex(result_regex).finditer(page):
                groups = match.groupdict()
                url = groups.get("url") or (match.group(1) if match.groups() else "")
                title = groups.get("title") or url
                full_url = absolutize(search_url, url)
                score = max(score_text(q, "{} {}".format(title, full_url)) for q in queries)
                if score >= min_score:
                    matches.append({"url": full_url, "title": html.unescape(title), "score": score})
            matches.sort(key=lambda item: item["score"], reverse=True)
            for result in matches[:3]:
                page_url = result["url"]
                download_url = page_url
                if download_regex:
                    try:
                        detail_page = request_url(page_url, headers=headers)
                    except Exception:
                        continue
                    download_match = compile_regex(download_regex).search(detail_page)
                    if not download_match:
                        continue
                    groups = download_match.groupdict()
                    download_url = groups.get("url") or download_match.group(1)
                    download_url = absolutize(page_url, download_url)
                if ".funscript" in download_url.lower():
                    return {
                        "source": provider.get("name") or "online",
                        "title": result["title"],
                        "score": result["score"],
                        "url": download_url,
                        "pageUrl": page_url,
                        "headers": headers,
                    }
    return None


def github_tree(repo, branch, headers):
    api_url = "https://api.github.com/repos/{}/git/trees/{}?recursive=1".format(
        urllib.parse.quote(repo, safe="/"),
        urllib.parse.quote(branch or "main", safe=""),
    )
    data = json.loads(request_url(api_url, headers=headers))
    if data.get("truncated"):
        raise ValueError("GitHub tree is truncated for {}".format(repo))
    return data.get("tree") or []


def cached_github_tree(provider, branch):
    cache = provider.setdefault("_treeCache", {})
    repo = str(provider.get("repo") or "").strip().strip("/")
    key = "{}@{}".format(repo, branch)
    if key not in cache:
        cache[key] = github_tree(repo, branch, provider.get("headers") or {})
    return cache[key]


def find_github(scene, provider, min_score):
    repo = str(provider.get("repo") or "").strip().strip("/")
    if not repo or "/" not in repo:
        return None
    root_path = str(provider.get("path") or "").strip().strip("/")
    headers = provider.get("headers") or {}
    queries = scene_queries(scene)
    branches = []
    branch = str(provider.get("branch") or "").strip()
    if branch:
        branches.append(branch)
    branches.extend(["main", "master"])

    last_error = None
    tree = []
    used_branch = ""
    for candidate_branch in dict.fromkeys(branches):
        try:
            tree = cached_github_tree(provider, candidate_branch)
            used_branch = candidate_branch
            break
        except Exception as exc:
            last_error = exc
    if not tree:
        return {
            "source": provider.get("name") or "GitHub",
            "error": "GitHub tree failed: {}".format(last_error),
            "score": 0,
        }

    best = None
    for item in tree:
        path = item.get("path") or ""
        if item.get("type") != "blob" or not path.lower().endswith(".funscript"):
            continue
        if root_path and not (path == root_path or path.startswith(root_path + "/")):
            continue
        basename = os.path.splitext(os.path.basename(path))[0]
        comparable = "{} {}".format(basename, path.replace("/", " "))
        score = max(score_text(query, comparable) for query in queries)
        if score >= min_score and (not best or score > best["score"]):
            raw_url = "https://raw.githubusercontent.com/{}/{}/{}".format(
                repo,
                urllib.parse.quote(used_branch, safe=""),
                urllib.parse.quote(path, safe="/"),
            )
            page_url = "https://github.com/{}/blob/{}/{}".format(
                repo,
                urllib.parse.quote(used_branch, safe=""),
                urllib.parse.quote(path, safe="/"),
            )
            best = {
                "source": provider.get("name") or "GitHub",
                "title": os.path.basename(path),
                "score": score,
                "url": raw_url,
                "pageUrl": page_url,
                "repo": repo,
                "branch": used_branch,
                "path": path,
                "headers": headers,
            }
    return best


def prepare_github_providers(settings):
    stats = []
    for provider in settings.get("providers") or []:
        if not provider or provider.get("enabled") is False:
            continue
        if str(provider.get("type") or "regex").lower() != "github":
            continue
        repo = str(provider.get("repo") or "").strip().strip("/")
        if not repo or "/" not in repo:
            stats.append({"source": provider.get("name") or "GitHub", "ok": False, "error": "missing repo"})
            continue
        branches = []
        branch = str(provider.get("branch") or "").strip()
        if branch:
            branches.append(branch)
        branches.extend(["main", "master"])
        last_error = None
        for candidate_branch in dict.fromkeys(branches):
            try:
                tree = cached_github_tree(provider, candidate_branch)
                count = sum(1 for item in tree if item.get("type") == "blob" and str(item.get("path") or "").lower().endswith(".funscript"))
                stats.append({
                    "source": provider.get("name") or "GitHub",
                    "ok": True,
                    "repo": repo,
                    "branch": candidate_branch,
                    "funscripts": count,
                })
                break
            except Exception as exc:
                last_error = exc
        else:
            stats.append({
                "source": provider.get("name") or "GitHub",
                "ok": False,
                "repo": repo,
                "error": str(last_error),
            })
    return stats


def enabled_source_count(settings):
    count = len([root for root in (settings.get("localFolders") or []) if str(root or "").strip()])
    if settings.get("enableOnline"):
        count += len([provider for provider in (settings.get("providers") or []) if provider and provider.get("enabled") is not False])
    return count


def download_candidate(candidate):
    fd, temp_path = tempfile.mkstemp(prefix="stash-funscript-", suffix=".funscript")
    os.close(fd)
    try:
        raw = request_url(candidate["url"], headers=candidate.get("headers"), binary=True)
        with open(temp_path, "wb") as handle:
            handle.write(raw)
        validate_funscript(temp_path)
        return temp_path
    except Exception:
        try:
            os.remove(temp_path)
        except Exception:
            pass
        raise


def search_download(args):
    scene = arg_value(args, "scene", {}) or {}
    settings = arg_value(args, "settings", {}) or {}
    dry_run = bool(settings.get("dryRun", True))
    overwrite = bool(settings.get("overwrite", False))
    video_path = str(scene.get("path") or "").strip()
    if not video_path:
        return {"error": "Scene has no filesystem path"}

    target_path = funscript_path_for_video(video_path)
    if os.path.exists(target_path) and not overwrite:
        return {
            "output": {
                "ok": True,
                "skipped": True,
                "reason": "target exists",
                "targetPath": target_path,
            }
        }

    candidate = find_local(scene, settings)
    temp_download = None
    try:
        if not candidate and settings.get("enableOnline"):
            candidate = find_online(scene, settings)
        if not candidate:
            return {"output": {"ok": False, "matched": False, "targetPath": target_path}}
        if candidate.get("error"):
            return {"output": {"ok": False, "matched": False, "candidate": candidate, "targetPath": target_path}}
        if dry_run:
            return {
                "output": {
                    "ok": True,
                    "matched": True,
                    "candidate": candidate,
                    "stats": {},
                    "placement": {"placed": False, "reason": "dry run"},
                    "targetPath": target_path,
                    "dryRun": True,
                    "timestamp": int(time.time()),
                }
            }

        source_path = candidate.get("localPath")
        if not source_path and candidate.get("url"):
            temp_download = download_candidate(candidate)
            source_path = temp_download

        stats = validate_funscript(source_path)
        placement = copy_candidate(source_path, target_path, dry_run, overwrite)
        return {
            "output": {
                "ok": True,
                "matched": True,
                "candidate": candidate,
                "stats": stats,
                "placement": placement,
                "targetPath": target_path,
                "dryRun": dry_run,
                "timestamp": int(time.time()),
            }
        }
    except urllib.error.HTTPError as exc:
        return {"error": "HTTP {} while downloading funscript".format(exc.code)}
    except Exception as exc:
        return {"error": str(exc)}
    finally:
        if temp_download:
            try:
                os.remove(temp_download)
            except Exception:
                pass


def batch_search_download(args):
    scenes = arg_value(args, "scenes", []) or []
    settings = arg_value(args, "settings", {}) or {}
    results = []
    errors = []
    provider_stats = []
    processed = 0
    matched = 0

    source_count = enabled_source_count(settings)
    if source_count == 0:
        return {
            "output": {
                "ok": False,
                "processed": 0,
                "matched": 0,
                "results": [],
                "errors": [{"error": "Geen actieve bronnen. Zet minstens een lokale map of GitHub bron aan."}],
                "errorCount": 1,
                "providerStats": [{"source": "Sources", "ok": False, "error": "Geen actieve bronnen"}],
                "timestamp": int(time.time()),
            }
        }

    if settings.get("enableOnline"):
        provider_stats = prepare_github_providers(settings)

    for scene in scenes:
        processed += 1
        try:
            result = search_download({"scene": scene, "settings": settings})
            output = result.get("output") if isinstance(result, dict) else None
            if result.get("error"):
                errors.append({"sceneId": scene.get("id"), "title": scene.get("title"), "error": result.get("error")})
            if output and output.get("candidate", {}).get("error"):
                errors.append({
                    "sceneId": scene.get("id"),
                    "title": scene.get("title"),
                    "error": output.get("candidate", {}).get("error"),
                    "source": output.get("candidate", {}).get("source"),
                })
            if output and output.get("matched"):
                matched += 1
                results.append({"sceneId": scene.get("id"), "scene": scene, "result": output})
        except Exception as exc:
            errors.append({"sceneId": scene.get("id"), "title": scene.get("title"), "error": str(exc)})

    return {
        "output": {
            "ok": True,
            "processed": processed,
            "matched": matched,
            "results": results,
            "errors": errors[:50],
            "errorCount": len(errors),
            "providerStats": provider_stats,
            "timestamp": int(time.time()),
        }
    }


def main():
    payload = read_input()
    args = payload.get("args") or {}
    action = str(arg_value(args, "action", "search-download") or "search-download").lower()
    if action == "batch-search-download":
        return batch_search_download(args)
    if action == "search-download":
        return search_download(args)
    return {"error": "Unknown action"}


print(json.dumps(main()))
