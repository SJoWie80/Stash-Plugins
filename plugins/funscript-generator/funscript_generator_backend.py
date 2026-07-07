import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed


PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(PLUGIN_DIR, "funscript_generator_state.json")
LOG_FILE = os.path.join(PLUGIN_DIR, "funscript_generator.log")
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".m4v", ".webm"}


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


def default_state():
    state = load_state()
    state.setdefault("queue", [])
    state.setdefault("history", [])
    state.setdefault("running", False)
    state.setdefault("stopRequested", False)
    state.setdefault("workerPid", None)
    state.setdefault("active", [])
    state.setdefault("settings", {})
    return state


def append_log(message):
    line = "[{}] {}\n".format(time.strftime("%Y-%m-%d %H:%M:%S"), message)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as handle:
            handle.write(line)
    except Exception:
        pass


def funscript_path(video_path):
    root, ext = os.path.splitext(video_path)
    if ext.lower() not in VIDEO_EXTENSIONS:
        root = video_path
    return root + ".funscript"


def unique_jobs(existing, jobs):
    seen = {str(job.get("sceneId")) for job in existing}
    added = []
    for job in jobs:
        scene_id = str(job.get("sceneId") or job.get("id") or "")
        path = str(job.get("path") or "")
        if not scene_id or not path or scene_id in seen:
            continue
        seen.add(scene_id)
        added.append({
            "sceneId": scene_id,
            "title": job.get("title") or os.path.basename(path),
            "studio": job.get("studio") or "",
            "path": path,
            "outputPath": funscript_path(path),
            "duration": job.get("duration"),
            "status": "queued",
            "createdAt": time.time(),
            "updatedAt": time.time(),
            "error": "",
        })
    return added


def enqueue(args):
    state = default_state()
    jobs = arg_value(args, "jobs", []) or []
    settings = arg_value(args, "settings", {}) or {}
    added = unique_jobs(state["queue"], jobs)
    state["queue"].extend(added)
    state["settings"].update(settings)
    save_state(state)
    return {"output": {"ok": True, "added": len(added), "queue": state["queue"]}}


def status(_args=None):
    state = default_state()
    tail = []
    try:
        with open(LOG_FILE, "r", encoding="utf-8") as handle:
            tail = handle.readlines()[-80:]
    except Exception:
        pass
    state["logTail"] = "".join(tail)
    return {"output": state}


def clear(args):
    mode = str(arg_value(args, "mode", "completed") or "completed")
    state = default_state()
    if mode == "all":
        state["queue"] = []
        state["history"] = []
    else:
        state["queue"] = [job for job in state["queue"] if job.get("status") not in ("done", "failed", "skipped")]
    save_state(state)
    return {"output": {"ok": True, "queue": state["queue"]}}


def start(args):
    state = default_state()
    settings = arg_value(args, "settings", {}) or {}
    state["settings"].update(settings)
    state["stopRequested"] = False
    if state.get("running") and state.get("workerPid"):
        save_state(state)
        return {"output": {"ok": True, "alreadyRunning": True, "workerPid": state.get("workerPid")}}
    save_state(state)

    command = [sys.executable, os.path.abspath(__file__), "--worker"]
    kwargs = {
        "cwd": PLUGIN_DIR,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    proc = subprocess.Popen(command, **kwargs)
    state = default_state()
    state["running"] = True
    state["workerPid"] = proc.pid
    save_state(state)
    append_log("worker started pid={}".format(proc.pid))
    return {"output": {"ok": True, "workerPid": proc.pid}}


def stop(_args=None):
    state = default_state()
    state["stopRequested"] = True
    pid = state.get("workerPid")
    save_state(state)
    if pid:
        try:
            if os.name == "nt":
                os.kill(int(pid), signal.CTRL_BREAK_EVENT)
            else:
                os.kill(int(pid), signal.SIGTERM)
        except Exception:
            pass
    append_log("stop requested")
    return {"output": {"ok": True}}


def command_for_job(settings, job):
    template = str(settings.get("commandTemplate") or "").strip()
    if not template:
        raise ValueError("Generator command is not configured")
    replacements = {
        "video": job.get("path") or "",
        "output": job.get("outputPath") or "",
        "fps": str(settings.get("analysisFps") or "6"),
        "scale": str(settings.get("scaleHeight") or "360"),
        "mode": str(settings.get("mode") or "standard"),
        "tmp": tempfile.gettempdir(),
    }
    command = template
    for key, value in replacements.items():
        command = command.replace("{" + key + "}", value)
    return command


def run_one(settings, job):
    overwrite = bool(settings.get("overwrite", False))
    if os.path.exists(job.get("outputPath") or "") and not overwrite:
        job["status"] = "skipped"
        job["error"] = "output exists"
        job["updatedAt"] = time.time()
        return job
    command = command_for_job(settings, job)
    append_log("running scene {}: {}".format(job.get("sceneId"), command))
    completed = subprocess.run(
        command if os.name == "nt" else shlex.split(command),
        shell=(os.name == "nt"),
        cwd=PLUGIN_DIR,
        capture_output=True,
        text=True,
        timeout=int(settings.get("timeoutMinutes") or 180) * 60,
    )
    if completed.returncode != 0:
        job["status"] = "failed"
        job["error"] = (completed.stderr or completed.stdout or "generator failed")[-2000:]
    elif not os.path.exists(job.get("outputPath") or ""):
        job["status"] = "failed"
        job["error"] = "generator finished but output file was not created"
    else:
        job["status"] = "done"
        job["error"] = ""
    job["updatedAt"] = time.time()
    return job


def worker_main():
    append_log("worker loop entering")
    while True:
        state = default_state()
        settings = state.get("settings") or {}
        if state.get("stopRequested"):
            break
        queued = [job for job in state["queue"] if job.get("status") == "queued"]
        if not queued:
            break
        worker_count = max(1, min(8, int(settings.get("workers") or 1)))
        batch = queued[:worker_count]
        batch_ids = {job.get("sceneId") for job in batch}
        for item in state["queue"]:
            if item.get("sceneId") in batch_ids:
                item["status"] = "running"
                item["updatedAt"] = time.time()
        state["running"] = True
        state["active"] = batch
        save_state(state)
        completed_jobs = []
        with ThreadPoolExecutor(max_workers=worker_count) as pool:
            futures = {pool.submit(run_one, settings, dict(job)): job for job in batch}
            for future in as_completed(futures):
                job = futures[future]
                try:
                    completed_jobs.append(future.result())
                except Exception as exc:
                    job["status"] = "failed"
                    job["error"] = str(exc)
                    job["updatedAt"] = time.time()
                    completed_jobs.append(job)
        state = default_state()
        state["active"] = []
        completed_by_id = {job.get("sceneId"): job for job in completed_jobs}
        for item in state["queue"]:
            if item.get("sceneId") in completed_by_id:
                item.update(completed_by_id[item.get("sceneId")])
        for job in completed_jobs:
            state["history"].insert(0, dict(job))
        state["history"] = state["history"][:200]
        save_state(state)
    state = default_state()
    state["running"] = False
    state["workerPid"] = None
    state["active"] = []
    save_state(state)
    append_log("worker loop exited")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--worker":
        worker_main()
        return
    payload = read_input()
    args = payload.get("args") or {}
    action = str(arg_value(args, "action", "status") or "status").lower()
    if action == "enqueue":
        result = enqueue(args)
    elif action == "start":
        result = start(args)
    elif action == "stop":
        result = stop(args)
    elif action == "clear":
        result = clear(args)
    else:
        result = status(args)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
