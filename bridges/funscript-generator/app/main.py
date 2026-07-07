#!/usr/bin/env python3
import json
import os
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel


HOST = os.environ.get("FUNSCRIPT_HOST", "0.0.0.0")
PORT = int(os.environ.get("FUNSCRIPT_PORT", "8891"))
MEDIA_ROOTS = [Path(value).resolve() for value in os.environ.get("MEDIA_ROOTS", "/videos").split(os.pathsep) if value.strip()]
OUTPUT_DIR = os.environ.get("OUTPUT_DIR", "").strip()
ANALYSIS_WIDTH = int(os.environ.get("ANALYSIS_WIDTH", "360"))
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm", ".wmv"}


app = FastAPI(title="Stash Funscript Generator")
jobs: dict[str, "Job"] = {}
job_queue: "queue.Queue[str]" = queue.Queue()


class GenerateRequest(BaseModel):
    files: list[str]
    sample_fps: float = 3.0
    sensitivity: float = 1.15
    min_gap_ms: int = 90
    output_mode: str = "next_to_video"
    overwrite: bool = False


@dataclass
class Job:
    id: str
    request: GenerateRequest
    status: str = "queued"
    progress: float = 0.0
    current_file: str = ""
    message: str = "Waiting"
    results: list[dict[str, Any]] = field(default_factory=list)
    error: str = ""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self):
        percent = int(max(0.0, min(1.0, self.progress)) * 100)
        return {
            "id": self.id,
            "status": self.status,
            "progress": round(self.progress, 3),
            "progress_percent": percent,
            "current_file": self.current_file,
            "message": self.message,
            "results": self.results,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


def log(message):
    print(f"[funscript-generator] {message}", flush=True)


def safe_roots():
    return [root for root in MEDIA_ROOTS if root.exists() and root.is_dir()]


def ensure_allowed(path_value: str) -> Path:
    path = Path(path_value)
    if not path.is_absolute():
        raise HTTPException(status_code=400, detail="Path must be absolute inside the container.")
    resolved = path.resolve()
    for root in safe_roots():
        try:
            resolved.relative_to(root)
            return resolved
        except ValueError:
            continue
    raise HTTPException(status_code=403, detail=f"Path is outside MEDIA_ROOTS: {path_value}")


def file_output_path(video_path: Path, output_mode: str) -> Path:
    if output_mode == "output_dir" and OUTPUT_DIR:
        output_root = Path(OUTPUT_DIR).resolve()
        output_root.mkdir(parents=True, exist_ok=True)
        return output_root / f"{video_path.stem}.funscript"
    return video_path.with_suffix(".funscript")


def list_directory(path_value: str | None):
    roots = safe_roots()
    if not roots:
        return {"path": "", "parent": None, "entries": [], "roots": []}

    current = roots[0] if not path_value else ensure_allowed(path_value)
    if not current.is_dir():
        current = current.parent

    entries = []
    for child in sorted(current.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower())):
        if child.name.startswith("."):
            continue
        is_video = child.is_file() and child.suffix.lower() in VIDEO_EXTENSIONS
        if child.is_dir() or is_video:
            entries.append(
                {
                    "name": child.name,
                    "path": str(child),
                    "type": "folder" if child.is_dir() else "video",
                    "size": child.stat().st_size if child.is_file() else None,
                }
            )

    parent = None
    for root in roots:
        try:
            current.relative_to(root)
            if current != root:
                parent = str(current.parent)
            break
        except ValueError:
            pass

    return {"path": str(current), "parent": parent, "entries": entries, "roots": [str(root) for root in roots]}


def smooth_positions(values: list[float], window: int = 5) -> list[float]:
    if not values:
        return []
    radius = max(1, window // 2)
    smoothed = []
    for index in range(len(values)):
        start = max(0, index - radius)
        end = min(len(values), index + radius + 1)
        smoothed.append(float(np.mean(values[start:end])))
    return smoothed


def turning_points(times: list[int], positions: list[int], min_gap_ms: int) -> list[dict[str, int]]:
    if not times or not positions:
        return []

    actions = [{"at": times[0], "pos": positions[0]}]
    last_direction = 0
    last_at = times[0]

    for index in range(1, len(positions)):
        delta = positions[index] - positions[index - 1]
        direction = 1 if delta > 0 else -1 if delta < 0 else 0
        if direction == 0:
            continue
        if last_direction and direction != last_direction and times[index] - last_at >= min_gap_ms:
            actions.append({"at": times[index - 1], "pos": positions[index - 1]})
            last_at = times[index - 1]
        last_direction = direction

    if actions[-1]["at"] != times[-1]:
        actions.append({"at": times[-1], "pos": positions[-1]})

    deduped = []
    for action in actions:
        if deduped and action["at"] - deduped[-1]["at"] < min_gap_ms:
            if abs(action["pos"] - deduped[-1]["pos"]) > 10:
                deduped[-1] = action
            continue
        deduped.append(action)
    return deduped


def generate_funscript(
    video_path: Path,
    sample_fps: float,
    sensitivity: float,
    min_gap_ms: int,
    progress_callback: Callable[[float, str], None] | None = None,
) -> dict[str, Any]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError("Video could not be opened.")

    source_fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration_ms = int((frame_count / source_fps) * 1000) if frame_count else 0
    step = max(1, int(round(source_fps / max(0.5, sample_fps))))

    previous_gray = None
    times: list[int] = []
    centers: list[float] = []
    energies: list[float] = []
    frame_index = 0
    last_progress_at = 0.0

    def report(progress: float, message: str):
        if progress_callback:
            progress_callback(max(0.0, min(1.0, progress)), message)

    while True:
        ok = capture.grab()
        if not ok:
            break
        if frame_index % step != 0:
            frame_index += 1
            now = time.time()
            if frame_count and now - last_progress_at >= 1.0:
                report(frame_index / frame_count, f"Skipping frames {min(frame_index, frame_count):,}/{frame_count:,}")
                last_progress_at = now
            continue

        ok, frame = capture.retrieve()
        if not ok:
            break

        height, width = frame.shape[:2]
        x1, x2 = int(width * 0.18), int(width * 0.82)
        y1, y2 = int(height * 0.10), int(height * 0.92)
        crop = frame[y1:y2, x1:x2]
        if ANALYSIS_WIDTH > 0 and crop.shape[1] > ANALYSIS_WIDTH:
            resized_height = max(1, int(crop.shape[0] * (ANALYSIS_WIDTH / crop.shape[1])))
            crop = cv2.resize(crop, (ANALYSIS_WIDTH, resized_height), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (9, 9), 0)

        if previous_gray is not None:
            diff = cv2.absdiff(gray, previous_gray)
            row_energy = diff.mean(axis=1)
            energy = float(row_energy.mean())
            if energy > 0:
                rows = np.arange(len(row_energy), dtype=np.float32)
                center = float(np.average(rows, weights=row_energy + 0.001) / max(1, len(row_energy) - 1))
                times.append(int((frame_index / source_fps) * 1000))
                centers.append(center)
                energies.append(energy)
        previous_gray = gray
        frame_index += 1

        now = time.time()
        if frame_count and now - last_progress_at >= 1.0:
            report(frame_index / frame_count, f"Analyzing frames {min(frame_index, frame_count):,}/{frame_count:,}")
            last_progress_at = now

    capture.release()
    report(1.0, "Building action points")

    if len(centers) < 4:
        return {"version": "1.0", "inverted": False, "range": 90, "actions": []}

    threshold = float(np.median(energies) * max(0.4, sensitivity))
    active = [center for center, energy in zip(centers, energies) if energy >= threshold]
    if len(active) < 4:
        active = centers

    low = float(np.percentile(active, 5))
    high = float(np.percentile(active, 95))
    if high - low < 0.02:
        low, high = min(active), max(active)
    if high - low < 0.01:
        return {"version": "1.0", "inverted": False, "range": 90, "actions": []}

    smoothed = smooth_positions(centers, 5)
    positions = [int(np.clip(round((value - low) / (high - low) * 100), 0, 100)) for value in smoothed]
    actions = turning_points(times, positions, min_gap_ms)

    return {
        "version": "1.0",
        "inverted": False,
        "range": 90,
        "metadata": {
            "generator": "stash-funscript-generator",
            "video": video_path.name,
            "duration_ms": duration_ms,
            "sample_fps": sample_fps,
            "analysis_width": ANALYSIS_WIDTH,
            "algorithm": "opencv-frame-difference-v1",
        },
        "actions": actions,
    }


def worker_loop():
    while True:
        job_id = job_queue.get()
        job = jobs.get(job_id)
        if not job:
            continue
        try:
            job.status = "running"
            job.message = "Analyzing videos"
            files = [ensure_allowed(path) for path in job.request.files]
            total = max(1, len(files))
            for index, video_path in enumerate(files, start=1):
                job.current_file = str(video_path)
                job.message = f"Generating {video_path.name}"
                job.progress = (index - 1) / total
                job.updated_at = time.time()

                if video_path.suffix.lower() not in VIDEO_EXTENSIONS:
                    raise RuntimeError(f"Unsupported video file: {video_path}")

                output_path = file_output_path(video_path, job.request.output_mode)
                if output_path.exists() and not job.request.overwrite:
                    job.results.append({"video": str(video_path), "output": str(output_path), "status": "skipped", "message": "Output already exists"})
                    continue

                def update_file_progress(file_progress: float, message: str):
                    job.progress = ((index - 1) + file_progress) / total
                    job.message = f"{message} - {video_path.name}"
                    job.updated_at = time.time()

                funscript = generate_funscript(
                    video_path,
                    job.request.sample_fps,
                    job.request.sensitivity,
                    job.request.min_gap_ms,
                    update_file_progress,
                )
                output_path.write_text(json.dumps(funscript, indent=2), encoding="utf-8")
                job.results.append(
                    {
                        "video": str(video_path),
                        "output": str(output_path),
                        "status": "created",
                        "actions": len(funscript.get("actions", [])),
                    }
                )

            job.status = "done"
            job.progress = 1.0
            job.message = "Done"
        except Exception as error:
            job.status = "error"
            job.error = str(error)
            job.message = "Failed"
            log(f"job {job_id} failed: {error}")
        finally:
            job.updated_at = time.time()
            job_queue.task_done()


@app.on_event("startup")
def start_worker():
    threading.Thread(target=worker_loop, daemon=True).start()
    log(f"listening on {HOST}:{PORT}; roots={', '.join(str(root) for root in MEDIA_ROOTS)}")


@app.get("/", response_class=HTMLResponse)
def index():
    return HTML


@app.get("/api/health")
def health():
    return {"status": "ok", "roots": [str(root) for root in safe_roots()], "output_dir": OUTPUT_DIR, "analysis_width": ANALYSIS_WIDTH}


@app.get("/api/browse")
def browse(path: str | None = None):
    return list_directory(path)


@app.post("/api/generate")
def generate(request: GenerateRequest):
    if not request.files:
        raise HTTPException(status_code=400, detail="Select at least one video.")
    job_id = str(uuid.uuid4())
    jobs[job_id] = Job(id=job_id, request=request)
    job_queue.put(job_id)
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return JSONResponse(job.to_dict())


HTML = r"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Stash Funscript Generator</title>
  <style>
    :root { color-scheme: dark; --bg:#111315; --panel:#1c2024; --line:#343a40; --text:#edf0f2; --muted:#9aa4ad; --accent:#41c28a; --warn:#ffca5d; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, Segoe UI, system-ui, sans-serif; background:var(--bg); color:var(--text); }
    header { padding:18px 24px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { font-size:20px; margin:0; font-weight:650; }
    main { display:grid; grid-template-columns:minmax(280px, 380px) 1fr; min-height:calc(100vh - 66px); }
    aside { border-right:1px solid var(--line); padding:18px; background:#15181b; }
    section { padding:18px; }
    button, input, select { font:inherit; }
    button { border:1px solid var(--line); background:#252a2f; color:var(--text); border-radius:6px; padding:9px 12px; cursor:pointer; }
    button:hover { border-color:#68737d; }
    button.primary { background:var(--accent); border-color:var(--accent); color:#07140e; font-weight:700; }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .path { color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
    .roots, .toolbar, .settings { display:grid; gap:10px; margin-bottom:16px; }
    .root-list { display:flex; flex-wrap:wrap; gap:8px; }
    .root-list button { padding:6px 9px; font-size:13px; }
    .entry { display:grid; grid-template-columns:72px minmax(0, 1fr) 34px; align-items:center; gap:10px; min-height:42px; padding:8px 10px; border-bottom:1px solid #252a2f; }
    .entry:hover { background:#1f2429; }
    .entry input { width:18px; height:18px; }
    .entry-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .type-badge { color:#c5d7e8; font-size:12px; line-height:1; background:#26313a; border:1px solid #3a4650; border-radius:999px; padding:5px 8px; text-align:center; }
    label { display:grid; gap:6px; color:var(--muted); font-size:13px; }
    input[type="number"], select { width:100%; border:1px solid var(--line); background:#101214; color:var(--text); border-radius:6px; padding:9px 10px; }
    .actions { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin:14px 0; }
    .panel { border:1px solid var(--line); border-radius:8px; background:var(--panel); overflow:hidden; }
    .panel-head { padding:12px 14px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:12px; align-items:center; }
    .selected { display:grid; gap:8px; padding:12px 14px; max-height:220px; overflow:auto; }
    .selected div, .result { color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
    progress { width:100%; height:14px; accent-color:var(--accent); }
    .status { display:grid; gap:12px; padding:14px; }
    .job-grid { display:grid; grid-template-columns:120px minmax(0, 1fr); gap:8px 12px; align-items:start; }
    .job-label { color:var(--muted); font-size:12px; text-transform:uppercase; }
    .job-value { color:#c5d7e8; font-size:14px; overflow-wrap:anywhere; }
    .results-list { display:grid; gap:8px; }
    .result { display:grid; gap:3px; padding:8px 10px; border:1px solid #2d343a; border-radius:6px; background:#171b1f; }
    .result strong { color:var(--text); font-size:13px; }
    .progress-row { display:grid; grid-template-columns:minmax(0, 1fr) 64px; gap:12px; align-items:center; }
    .progress-percent { color:var(--accent); font-size:18px; font-weight:700; text-align:right; }
    .hint { color:var(--warn); font-size:13px; line-height:1.4; }
    @media (max-width: 780px) {
      main { grid-template-columns:1fr; }
      aside { border-right:0; border-bottom:1px solid var(--line); }
      .job-grid { grid-template-columns:1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Stash Funscript Generator</h1>
    <div class="path" id="health">Starting...</div>
  </header>
  <main>
    <aside>
      <div class="roots">
        <div class="path">Mounted roots</div>
        <div class="root-list" id="roots"></div>
      </div>
      <div class="settings">
        <label>Sample rate
          <input id="sampleFps" type="number" min="1" max="24" step="0.5" value="3">
        </label>
        <label>Sensitivity
          <input id="sensitivity" type="number" min="0.4" max="3" step="0.05" value="1.15">
        </label>
        <label>Minimum action gap (ms)
          <input id="minGap" type="number" min="40" max="500" step="10" value="90">
        </label>
        <label>Output
          <select id="outputMode">
            <option value="next_to_video">Next to video</option>
            <option value="output_dir">OUTPUT_DIR</option>
          </select>
        </label>
        <label><span><input id="overwrite" type="checkbox"> Overwrite existing scripts</span></label>
      </div>
    </aside>
    <section>
      <div class="toolbar">
        <div class="path" id="currentPath"></div>
        <div class="actions">
          <button id="upButton">Up</button>
          <button id="refreshButton">Refresh</button>
          <button id="clearButton">Clear selection</button>
          <button class="primary" id="generateButton">Generate scripts</button>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><strong>Job</strong><span class="path" id="jobId"></span></div>
        <div class="status">
          <div class="progress-row">
            <progress id="progress" max="1" value="0"></progress>
            <div class="progress-percent" id="progressPercent">0%</div>
          </div>
          <div class="job-grid">
            <div class="job-label">Status</div>
            <div class="job-value" id="jobStatus">No job running.</div>
            <div class="job-label">Current file</div>
            <div class="job-value" id="jobFile">-</div>
            <div class="job-label">Worker</div>
            <div class="job-value" id="jobWorker">Idle</div>
          </div>
          <div class="results-list" id="results"></div>
        </div>
      </div>
      <div class="actions"></div>
      <div class="panel">
        <div class="panel-head">
          <strong>Folder</strong>
          <span class="path" id="count"></span>
        </div>
        <div id="entries"></div>
      </div>
      <div class="actions"></div>
      <div class="panel">
        <div class="panel-head">
          <strong>Selected videos</strong>
          <span class="path" id="selectedCount">0</span>
        </div>
        <div class="selected" id="selected"></div>
      </div>
    </section>
  </main>
  <script>
    const state = { path: null, parent: null, roots: [], selected: new Set(), job: null };
    const $ = (id) => document.getElementById(id);
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[char]));

    async function api(path, options) {
      const response = await fetch(path, options);
      if (!response.ok) throw new Error((await response.json()).detail || response.statusText);
      return response.json();
    }

    function renderSelected() {
      $("selectedCount").textContent = `${state.selected.size} selected`;
      $("selected").innerHTML = [...state.selected].map(path => `<div>${escapeHtml(path)}</div>`).join("") || `<div>No videos selected.</div>`;
      $("generateButton").disabled = state.selected.size === 0;
    }

    async function load(path) {
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      const data = await api(`/api/browse${query}`);
      state.path = data.path;
      state.parent = data.parent;
      state.roots = data.roots;
      $("currentPath").textContent = data.path || "No mounted media roots found";
      $("upButton").disabled = !data.parent;
      $("roots").innerHTML = data.roots.map(root => `<button data-root="${escapeHtml(root)}">${escapeHtml(root)}</button>`).join("");
      $("count").textContent = `${data.entries.length} items`;
      $("entries").innerHTML = data.entries.map(entry => {
        const icon = entry.type === "folder" ? "Folder" : "Video";
        const checked = state.selected.has(entry.path) ? "checked" : "";
        const safePath = escapeHtml(entry.path);
        const control = entry.type === "video" ? `<input type="checkbox" data-video="${safePath}" ${checked}>` : "";
        const open = entry.type === "folder" ? `data-folder="${safePath}"` : "";
        return `<div class="entry" ${open}><span class="type-badge">${icon}</span><span class="entry-name" title="${escapeHtml(entry.path)}">${escapeHtml(entry.name)}</span><span>${control}</span></div>`;
      }).join("");
      renderSelected();
    }

    async function health() {
      const data = await api("/api/health");
      $("health").textContent = data.roots.length ? `Ready: ${data.roots.join(", ")}` : "No MEDIA_ROOTS available";
    }

    async function startJob() {
      const body = {
        files: [...state.selected],
        sample_fps: Number($("sampleFps").value),
        sensitivity: Number($("sensitivity").value),
        min_gap_ms: Number($("minGap").value),
        output_mode: $("outputMode").value,
        overwrite: $("overwrite").checked
      };
      const data = await api("/api/generate", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
      state.job = data.job_id;
      $("jobId").textContent = data.job_id;
      pollJob();
    }

    async function pollJob() {
      if (!state.job) return;
      const job = await api(`/api/jobs/${state.job}`);
      $("progress").value = job.progress;
      $("progressPercent").textContent = `${job.progress_percent ?? Math.round((job.progress || 0) * 100)}%`;
      const fileName = job.current_file ? job.current_file.split(/[\\/]/).pop() : "-";
      $("jobStatus").textContent = job.error ? `${job.status}: ${job.error}` : job.status;
      $("jobFile").textContent = fileName;
      $("jobWorker").textContent = job.message || "Idle";
      $("results").innerHTML = job.results.map(result => {
        const name = (result.video || result.output || "").split(/[\\/]/).pop();
        const detail = result.output || result.video || "";
        const actionText = result.actions !== undefined ? `${result.actions} actions` : (result.message || "");
        return `<div class="result"><strong>${escapeHtml(result.status)}: ${escapeHtml(name)}</strong><span class="path">${escapeHtml(detail)}</span><span class="path">${escapeHtml(actionText)}</span></div>`;
      }).join("");
      if (job.status === "queued" || job.status === "running") setTimeout(pollJob, 1200);
    }

    document.addEventListener("click", (event) => {
      const folder = event.target.closest("[data-folder]")?.dataset.folder;
      const root = event.target.closest("[data-root]")?.dataset.root;
      if (folder) load(folder);
      if (root) load(root);
    });
    document.addEventListener("change", (event) => {
      const video = event.target.dataset.video;
      if (!video) return;
      if (event.target.checked) state.selected.add(video); else state.selected.delete(video);
      renderSelected();
    });
    $("upButton").onclick = () => state.parent && load(state.parent);
    $("refreshButton").onclick = () => load(state.path);
    $("clearButton").onclick = () => { state.selected.clear(); load(state.path); };
    $("generateButton").onclick = () => startJob().catch(error => alert(error.message));

    health().catch(error => $("health").textContent = error.message);
    load(null).catch(error => $("currentPath").textContent = error.message);
  </script>
</body>
</html>"""


def main():
    uvicorn.run("app.main:app", host=HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
