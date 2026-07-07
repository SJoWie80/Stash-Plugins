import html
import io
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
import zipfile


VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".m4v", ".webm"}
DEFAULT_USER_AGENT = "Mozilla/5.0 Stash Funscript Scraper"
CACHE_FILE = os.path.join(tempfile.gettempdir(), "stash_funscript_scraper_cache.json")
CACHE_TTL_SECONDS = 24 * 60 * 60
STOP_TOKENS = {
    "1080", "1080p", "2160", "2160p", "720", "720p", "480", "480p", "4k", "5k", "6k", "8k",
    "uhd", "hd", "fhd", "web", "webdl", "webrip", "x264", "x265", "h264", "h265", "hevc",
    "mp4", "mkv", "avi", "wmv", "mov", "vr", "180", "360", "60fps", "fps", "com", "www",
    "scene", "scenes", "video", "videos", "part", "pt",
}
GENERIC_TITLE_TOKENS = {
    "bath", "time", "tie", "love", "lover", "nurse", "patient", "amateur", "anal", "deeper", "sexy",
    "white", "black", "girl", "girls", "boy", "boys", "big", "small", "hot", "teen", "mom", "step",
    "besties", "blanket", "blankets", "passion", "dreamy", "morning", "call", "shower", "walk",
    "park", "price", "tryouts", "contact", "hand", "teasing", "project", "whispers", "resist",
    "satisfaction", "heat", "delicious", "great", "day", "euphoria", "coming", "treatment",
    "pleasure", "interviews",
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


def is_generic_short_match(candidate_tokens):
    useful = [token for token in candidate_tokens if token not in GENERIC_TITLE_TOKENS]
    return len(set(candidate_tokens)) <= 3 and len(useful) == 0


def duration_score(scene, candidate):
    scene_duration = float(scene.get("duration") or 0)
    candidate_duration = float(candidate.get("duration") or 0)
    if not scene_duration or not candidate_duration:
        return 0
    diff = abs(scene_duration - candidate_duration)
    tolerance = max(20.0, scene_duration * 0.08)
    if diff <= tolerance:
        return 18
    if diff <= max(45.0, scene_duration * 0.18):
        return 8
    return -25


def metadata_bonus(scene, candidate_text):
    bonus = 0
    lowered = normalize(candidate_text)
    studio = normalize(scene.get("studio") or "")
    if studio and studio in lowered:
        bonus += 10
    for performer in scene.get("performers") or []:
        performer_norm = normalize(performer)
        if performer_norm and performer_norm in lowered:
            bonus += 12
    return min(24, bonus)


def score_candidate(scene, query, candidate):
    text = candidate.get("text") or candidate.get("title") or ""
    base = score_text(query, text)
    candidate_tokens = tokens(candidate.get("title") or text)
    query_tokens = set(tokens(query))
    overlap = set(candidate_tokens) & query_tokens
    duration_adjustment = duration_score(scene, candidate)
    meta_adjustment = metadata_bonus(scene, text)
    if is_generic_short_match(candidate_tokens) and not duration_adjustment:
        base = min(base, 55)
    if len(overlap) <= 2 and len(query_tokens) >= 5 and not duration_adjustment and not meta_adjustment:
        base = min(base, 58)
    base += duration_adjustment
    base += meta_adjustment
    return max(0, min(100, int(base)))


def title_match_quality(scene, candidate):
    scene_title_tokens = set(tokens(scene.get("title") or ""))
    candidate_tokens = set(tokens(candidate.get("title") or candidate.get("text") or ""))
    if not scene_title_tokens or not candidate_tokens:
        return {"ok": False, "coverage": 0, "overlap": 0, "generic": True}
    overlap_tokens = scene_title_tokens & candidate_tokens
    overlap = len(overlap_tokens)
    coverage = overlap / max(1, len(scene_title_tokens))
    generic_overlap = all(token in GENERIC_TITLE_TOKENS for token in overlap_tokens)
    useful_overlap = len([token for token in overlap_tokens if token not in GENERIC_TITLE_TOKENS])
    return {
        "ok": coverage >= 0.85 and (useful_overlap >= 2 or (len(scene_title_tokens) >= 4 and useful_overlap >= 1)),
        "coverage": coverage,
        "overlap": overlap,
        "generic": generic_overlap,
        "useful": useful_overlap,
    }


def has_metadata_evidence(scene, candidate):
    text = candidate.get("text") or candidate.get("title") or ""
    if duration_score(scene, candidate) > 0:
        return True
    if metadata_bonus(scene, text) >= 12:
        return True
    return False


def acceptable_candidate(scene, candidate):
    title_quality = title_match_quality(scene, candidate)
    scene_title_tokens = set(tokens(scene.get("title") or ""))
    candidate_title_tokens = set(tokens(os.path.splitext(candidate.get("title") or "")[0]))
    if len(scene_title_tokens) <= 3:
        if scene_title_tokens == candidate_title_tokens:
            return True
        return has_metadata_evidence(scene, candidate) and title_quality["coverage"] >= 0.85
    if title_quality["ok"]:
        return True
    if title_quality["coverage"] >= 0.7 and title_quality["useful"] >= 1 and has_metadata_evidence(scene, candidate):
        return True
    return False


def scene_queries(scene):
    path = scene.get("path") or ""
    base = os.path.splitext(os.path.basename(path))[0]
    title = scene.get("title") or ""
    values = [title]
    for performer in scene.get("performers") or []:
        values.append("{} {}".format(performer, scene.get("title") or "").strip())
    if not title:
        values.append(base)
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


def load_cache():
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_cache(cache):
    try:
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(cache, handle, ensure_ascii=False)
        os.replace(tmp, CACHE_FILE)
    except Exception:
        pass


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
    try:
        data = json.loads(request_url(api_url, headers=headers))
        if data.get("truncated"):
            raise ValueError("GitHub tree is truncated for {}".format(repo))
        return data.get("tree") or []
    except urllib.error.HTTPError as exc:
        if exc.code not in (403, 429):
            raise
        return github_tree_from_zip(repo, branch, headers)


def github_tree_from_zip(repo, branch, headers):
    zip_url = "https://codeload.github.com/{}/zip/refs/heads/{}".format(
        urllib.parse.quote(repo, safe="/"),
        urllib.parse.quote(branch or "main", safe=""),
    )
    raw = request_url(zip_url, headers=headers, binary=True)
    tree = []
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for name in archive.namelist():
            if name.endswith("/"):
                continue
            parts = name.split("/", 1)
            if len(parts) != 2:
                continue
            tree.append({"type": "blob", "path": parts[1]})
    return tree


def cached_github_tree(provider, branch):
    cache = provider.setdefault("_treeCache", {})
    repo = str(provider.get("repo") or "").strip().strip("/")
    key = "{}@{}".format(repo, branch)
    if key not in cache:
        disk_cache = load_cache()
        disk_item = disk_cache.get(key)
        now = time.time()
        if disk_item and now - float(disk_item.get("createdAt") or 0) < CACHE_TTL_SECONDS:
            cache[key] = disk_item.get("tree") or []
        else:
            tree = github_tree(repo, branch, provider.get("headers") or {})
            cache[key] = tree
            disk_cache[key] = {"createdAt": now, "tree": tree}
            save_cache(disk_cache)
    return cache[key]


def github_candidates(provider, repo, branch, root_path, headers):
    key = "{}@{}:{}".format(repo, branch, root_path)
    cache = provider.setdefault("_candidateCache", {})
    if key in cache:
        return cache[key]

    candidates = []
    token_index = {}
    tree = cached_github_tree(provider, branch)
    for item in tree:
        path = item.get("path") or ""
        if item.get("type") != "blob" or not path.lower().endswith(".funscript"):
            continue
        if root_path and not (path == root_path or path.startswith(root_path + "/")):
            continue
        title = os.path.basename(path)
        basename = os.path.splitext(title)[0]
        text = "{} {}".format(basename, path.replace("/", " "))
        candidate = {
            "source": provider.get("name") or "GitHub",
            "title": title,
            "url": "https://raw.githubusercontent.com/{}/{}/{}".format(
                repo,
                urllib.parse.quote(branch, safe=""),
                urllib.parse.quote(path, safe="/"),
            ),
            "pageUrl": "https://github.com/{}/blob/{}/{}".format(
                repo,
                urllib.parse.quote(branch, safe=""),
                urllib.parse.quote(path, safe="/"),
            ),
            "repo": repo,
            "branch": branch,
            "path": path,
            "headers": headers,
            "text": text,
            "tokens": set(tokens(text)),
        }
        index = len(candidates)
        candidates.append(candidate)
        for token in candidate["tokens"]:
            token_index.setdefault(token, []).append(index)
    cache[key] = {"candidates": candidates, "tokenIndex": token_index}
    return cache[key]


def find_github(scene, provider, min_score):
    if provider.get("_disabledError"):
        return None
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
    used_branch = ""
    candidate_data = None
    for candidate_branch in dict.fromkeys(branches):
        try:
            cached_github_tree(provider, candidate_branch)
            candidate_data = github_candidates(provider, repo, candidate_branch, root_path, headers)
            used_branch = candidate_branch
            break
        except Exception as exc:
            last_error = exc
    if not candidate_data:
        return {
            "source": provider.get("name") or "GitHub",
            "error": "GitHub tree failed: {}".format(last_error),
            "score": 0,
        }

    best = None
    candidate_indexes = set()
    token_index = candidate_data["tokenIndex"]
    for query in queries:
        for token in tokens(query):
            candidate_indexes.update(token_index.get(token, []))
    for index in candidate_indexes:
        candidate = candidate_data["candidates"][index]
        if not acceptable_candidate(scene, candidate):
            continue
        score = max(score_candidate(scene, query, candidate) for query in queries)
        if score >= min_score and (not best or score > best["score"]):
            best = dict(candidate)
            best["score"] = score
            best.pop("tokens", None)
            best.pop("text", None)
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
            provider["_disabledError"] = "missing repo"
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
            provider["_disabledError"] = str(last_error)
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
