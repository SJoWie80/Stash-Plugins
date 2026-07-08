(function () {
  "use strict";

  const ROUTE = "/now-playing";
  const NAV_ID = "stash-now-playing-nav";
  const APP_ID = "stash-now-playing-root";
  const HEARTBEAT_MS = 8000;
  const REFRESH_MS = 5000;
  const LOG_POLL_MS = 10000;
  const ACTIVITY_POLL_MS = 10000;
  const ACTIVITY_PAGE_SIZE = 250;
  const ACTIVITY_MAX_PAGES = 40;
  const NAV_ICON =
    '<svg aria-hidden="true" focusable="false" class="svg-inline--fa fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0 stash-np-nav-icon" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<path fill="currentColor" d="M8 5.7v12.6c0 .95 1.04 1.53 1.85 1.03l9.9-6.3a1.22 1.22 0 0 0 0-2.06l-9.9-6.3A1.22 1.22 0 0 0 8 5.7ZM4 6a1 1 0 0 1 2 0v12a1 1 0 1 1-2 0V6Z"/>' +
    "</svg>";

  const state = {
    pluginId: "",
    routeRegistered: false,
    routeContainer: null,
    sessions: [],
    error: "",
    loading: false,
    currentScene: null,
    sceneCache: {},
    lastReportKey: "",
    lastReportAt: 0,
    logPollingAvailable: true,
    lastLogSignature: "",
    activitySeen: {},
    activityPollingAvailable: true,
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function clientId() {
    const key = "stash-now-playing-client-id";
    let id = localStorage.getItem(key);
    if (!id) {
      id = `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(key, id);
    }
    return id;
  }

  function clientName() {
    return localStorage.getItem("stash-now-playing-client-name") || navigator.platform || "Browser";
  }

  function isRoute() {
    return window.location.pathname.replace(/\/$/, "") === ROUTE;
  }

  function notifyRouteChange() {
    window.dispatchEvent(new Event("stash-now-playing-route"));
  }

  function patchHistory() {
    if (window.__stashNowPlayingHistoryPatched) return;
    window.__stashNowPlayingHistoryPatched = true;
    ["pushState", "replaceState"].forEach((method) => {
      const original = window.history[method];
      window.history[method] = function patchedHistoryState() {
        const result = original.apply(this, arguments);
        window.setTimeout(notifyRouteChange, 0);
        return result;
      };
    });
  }

  function graphql(query, variables) {
    return fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    })
      .then((response) => response.json())
      .then((payload) => {
        if (payload.errors && payload.errors.length) {
          throw new Error(payload.errors.map((error) => error.message).join("; "));
        }
        return payload.data;
      });
  }

  async function getPluginId() {
    if (state.pluginId) return state.pluginId;
    const data = await graphql("query NowPlayingPluginId { plugins { id name } }", {});
    const plugin = ((data && data.plugins) || []).find((item) => item && item.name === "Now Playing");
    if (!plugin || !plugin.id) throw new Error("Now Playing plugin ID kon niet worden gevonden");
    state.pluginId = plugin.id;
    return state.pluginId;
  }

  async function pluginOperation(args) {
    const pluginId = await getPluginId();
    const data = await graphql(
      "mutation NowPlayingOperation($pluginId: ID!, $args: Map) { runPluginOperation(plugin_id: $pluginId, args: $args) }",
      { pluginId, args }
    );
    const result = data && data.runPluginOperation;
    const output = result && (result.output || result.result || result);
    return typeof output === "string" ? JSON.parse(output) : output;
  }

  function sceneIdFromPath() {
    const match = window.location.pathname.match(/^\/scenes\/(\d+)/);
    return match ? match[1] : "";
  }

  function bestVideo() {
    return Array.from(document.querySelectorAll("video")).find((video) => Number.isFinite(video.duration) && video.duration > 0) || null;
  }

  function relationNames(list) {
    return (list || []).map((entry) => entry.name || entry.title).filter(Boolean).slice(0, 5);
  }

  async function loadScene(sceneId) {
    if (state.sceneCache[sceneId]) return state.sceneCache[sceneId];
    const data = await graphql(
      `query NowPlayingScene($id: ID!) {
        findScene(id: $id) {
          id
          title
          paths { screenshot }
          files { path basename }
          studio { name }
          performers { name }
        }
      }`,
      { id: sceneId }
    );
    state.sceneCache[sceneId] = data && data.findScene;
    state.currentScene = state.sceneCache[sceneId];
    return state.sceneCache[sceneId];
  }

  function titleForScene(scene, sceneId) {
    const firstFile = scene && scene.files && scene.files[0];
    return (scene && scene.title) || (firstFile && firstFile.basename) || `Scene ${sceneId}`;
  }

  async function reportServerScene(sceneId, resumeTime, playDelta) {
    const scene = await loadScene(sceneId);
    if (!scene) return;
    const firstFile = scene.files && scene.files[0];
    await pluginOperation({
      action: "report",
      clientId: `server-scene-${sceneId}`,
      clientName: "Stash server",
      source: "server-activity",
      sceneId,
      title: titleForScene(scene, sceneId),
      studio: scene.studio && scene.studio.name,
      performers: relationNames(scene.performers),
      cover: scene.paths && scene.paths.screenshot,
      path: firstFile && firstFile.path,
      url: `/scenes/${sceneId}?qsort=date&qfp=1&continue=false`,
      currentTime: Number(resumeTime) || 0,
      duration: 0,
      paused: false,
      userAgent: `play_duration +${playDelta || ""}`,
    });
  }

  async function pollSceneActivity() {
    if (!state.activityPollingAvailable) return;
    try {
      let reported = false;
      for (let page = 1; page <= ACTIVITY_MAX_PAGES; page += 1) {
        const data = await graphql(
          `query NowPlayingSceneActivity($filter: FindFilterType) {
            findScenes(filter: $filter) {
              count
              scenes {
                id
                title
                resume_time
                play_duration
                paths { screenshot }
                files { path basename }
                studio { name }
                performers { name }
              }
            }
          }`,
          { filter: { page, per_page: ACTIVITY_PAGE_SIZE } }
        );
        const result = (data || {}).findScenes || {};
        const scenes = result.scenes || [];
        for (const scene of scenes) {
          const seen = state.activitySeen[scene.id];
          const playDuration = Number(scene.play_duration || 0);
          const resumeTime = Number(scene.resume_time || 0);
          const durationIncreased = seen && playDuration > Number(seen.playDuration || 0) + 0.25;
          const resumeMoved = seen && Math.abs(resumeTime - Number(seen.resumeTime || 0)) > 0.25;
          state.activitySeen[scene.id] = { playDuration, resumeTime };
          if (!durationIncreased && !resumeMoved) continue;
          state.sceneCache[scene.id] = scene;
          await reportServerScene(scene.id, resumeTime, playDuration - Number(seen.playDuration || 0));
          reported = true;
        }
        const total = Number(result.count || 0);
        if (!scenes.length || page * ACTIVITY_PAGE_SIZE >= total) break;
      }
      if (reported && (state.routeContainer || isRoute())) loadSessions();
    } catch (error) {
      state.activityPollingAvailable = false;
      console.warn("[Now Playing] scene activity polling unavailable", error);
    }
  }

  function logText(entry) {
    if (!entry) return "";
    return [entry.message, entry.fields, entry.args, entry.text, entry.raw]
      .map((value) => (typeof value === "string" ? value : value ? JSON.stringify(value) : ""))
      .filter(Boolean)
      .join(" ");
  }

  function parsePlaybackLog(text) {
    if (!text || !text.includes("UPDATE `scenes`") || !text.includes("play_duration")) return null;
    const numbersMatch = text.match(/\[\[\s*([0-9.]+)\s+([0-9.]+)\s+([0-9]+)\s*\]\]/);
    if (numbersMatch) {
      return { playDelta: numbersMatch[1], resumeTime: numbersMatch[2], sceneId: numbersMatch[3] };
    }
    const tailMatch = text.match(/([0-9]+)\s*\]\]?$/);
    return tailMatch ? { playDelta: "", resumeTime: 0, sceneId: tailMatch[1] } : null;
  }

  async function pollPlaybackLogs() {
    if (!state.logPollingAvailable) return;
    try {
      let data;
      try {
        data = await graphql("query NowPlayingLogs { logs { time level message fields } }", {});
      } catch (error) {
        data = await graphql("query NowPlayingLogsBasic { logs { time level message } }", {});
      }
      const entries = ((data && data.logs) || []).slice(-80);
      const parsed = entries
        .map((entry) => parsePlaybackLog(logText(entry)))
        .filter((entry) => entry && entry.sceneId);
      if (!parsed.length) return;
      const latest = parsed[parsed.length - 1];
      const signature = `${latest.sceneId}:${latest.resumeTime}`;
      if (signature === state.lastLogSignature) return;
      state.lastLogSignature = signature;
      await reportServerScene(latest.sceneId, latest.resumeTime, latest.playDelta);
      if (state.routeContainer || isRoute()) loadSessions();
    } catch (error) {
      state.logPollingAvailable = false;
      console.warn("[Now Playing] log polling unavailable", error);
    }
  }

  async function sendHeartbeat(force) {
    const sceneId = sceneIdFromPath();
    const video = bestVideo();
    if (!sceneId || !video) return;

    const now = Date.now();
    const reportKey = `${sceneId}:${Math.floor(video.currentTime)}:${video.paused}`;
    if (!force && reportKey === state.lastReportKey && now - state.lastReportAt < HEARTBEAT_MS) return;

    const scene = await loadScene(sceneId);
    if (!scene) return;
    state.lastReportKey = reportKey;
    state.lastReportAt = now;
    const firstFile = scene.files && scene.files[0];

    await pluginOperation({
      action: "report",
      clientId: clientId(),
      clientName: clientName(),
      source: "browser",
      sceneId,
      title: titleForScene(scene, sceneId),
      studio: scene.studio && scene.studio.name,
      performers: relationNames(scene.performers),
      cover: scene.paths && scene.paths.screenshot,
      path: firstFile && firstFile.path,
      url: window.location.pathname + window.location.search,
      currentTime: video.currentTime || 0,
      duration: video.duration || 0,
      paused: Boolean(video.paused || video.ended),
      userAgent: navigator.userAgent,
    });
  }

  function monitorPlayback() {
    sendHeartbeat(false).catch(() => {});
  }

  async function loadSessions() {
    if (!state.routeContainer && !isRoute()) return;
    state.loading = true;
    try {
      const output = await pluginOperation({ action: "list" });
      state.sessions = (output && output.sessions) || [];
      state.error = "";
    } catch (error) {
      state.error = error.message || String(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  function navigate(event) {
    if (event) event.preventDefault();
    window.history.pushState({}, "", ROUTE);
    window.dispatchEvent(new PopStateEvent("popstate"));
    notifyRouteChange();
  }

  function findNav() {
    const preferred = document.querySelector("nav .navbar-nav") || document.querySelector(".navbar-collapse .navbar-nav");
    if (preferred) return preferred;
    const labels = ["Scenes", "Images", "Groups", "Markers", "Performers", "Studios", "Tags"];
    return Array.from(document.querySelectorAll("nav, header, .navbar, .navbar-nav, .btn-toolbar, div")).find((node) => {
      const text = node.textContent || "";
      return labels.filter((label) => text.includes(label)).length >= 3;
    });
  }

  function addNav() {
    if (document.getElementById(NAV_ID)) return;
    const nav = findNav();
    const scenesLink = document.querySelector('a[href="/scenes"]') || document.querySelector('a[href="/scenes/"]');
    if (!nav || !scenesLink) return;
    const wrap = el("div", "stash-np-nav-wrap");
    wrap.id = NAV_ID;
    wrap.className = scenesLink.parentElement ? scenesLink.parentElement.className : "nav-item";
    const link = el("a", "");
    link.href = ROUTE;
    link.id = "stash-np-nav-button";
    link.title = "Now Playing";
    link.setAttribute("aria-label", "Now Playing");
    link.className = `${scenesLink.className.replace(/\bactive\b/g, "").trim()} stash-np-nav-button`.trim();
    link.innerHTML = `${NAV_ICON}<span>Now Playing</span>`;
    link.addEventListener("click", navigate);
    wrap.appendChild(link);
    nav.appendChild(wrap);
  }

  function formatTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(value / 60);
    const rest = value % 60;
    return `${minutes}:${String(rest).padStart(2, "0")}`;
  }

  function progressPercent(session) {
    const duration = Number(session.duration) || 0;
    if (!duration) return 0;
    return Math.min(100, Math.max(0, (Number(session.currentTime || 0) / duration) * 100));
  }

  function timeLabel(session) {
    const duration = Number(session.duration) || 0;
    const currentTime = formatTime(session.currentTime);
    return duration > 0 ? `${currentTime} / ${formatTime(duration)}` : `${currentTime} elapsed`;
  }

  function openScene(session) {
    if (!session.sceneId) return;
    window.history.pushState({}, "", `/scenes/${session.sceneId}?qsort=date&qfp=1&continue=false`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  function renderSession(session) {
    const card = el("button", `stash-np-session ${session.active ? "is-active" : "is-recent"}`);
    card.type = "button";
    card.addEventListener("click", () => openScene(session));

    if (session.cover) {
      const img = el("img", "stash-np-thumb");
      img.src = session.cover;
      img.alt = session.title || "Scene";
      card.appendChild(img);
    } else {
      card.appendChild(el("div", "stash-np-thumb stash-np-thumb-empty", "No preview"));
    }

    const body = el("span", "stash-np-body");
    const title = el("span", "stash-np-title", session.title || `Scene ${session.sceneId}`);
    const meta = el("span", "stash-np-meta");
    const performers = Array.isArray(session.performers) ? session.performers.join(", ") : "";
    meta.textContent = [session.studio, performers].filter(Boolean).join(" · ") || session.path || "";

    const status = el("span", "stash-np-status");
    const source = session.source === "server-activity" || session.source === "server-log" ? "detected by Stash activity" : `on ${session.clientName || "Browser"}`;
    status.textContent = session.active ? `Playing ${source}` : `Paused/recent - ${session.ageSeconds || 0}s ago`;

    const progress = el("span", "stash-np-progress");
    const bar = el("span", "stash-np-progress-bar");
    bar.style.width = `${progressPercent(session)}%`;
    progress.appendChild(bar);

    const time = el("span", "stash-np-time", timeLabel(session));
    body.append(title, meta, status, progress, time);
    card.appendChild(body);
    return card;
  }

  function renderInto(container) {
    container.className = "stash-np-app";
    clear(container);
    const shell = el("section", "stash-np-shell");
    const header = el("div", "stash-np-titlebar");
    header.appendChild(el("h1", "", "Now Playing"));
    const refresh = el("button", "btn btn-secondary stash-np-refresh", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", loadSessions);
    header.appendChild(refresh);
    shell.appendChild(header);

    if (state.error) shell.appendChild(el("div", "stash-np-error", state.error));
    if (state.loading && !state.sessions.length) shell.appendChild(el("div", "stash-np-empty", "Loading playback sessions..."));

    const active = state.sessions.filter((session) => session.active);
    const recent = state.sessions.filter((session) => !session.active);
    const summary = el(
      "div",
      "stash-np-summary",
      `${active.length} active - ${recent.length} recent${state.activityPollingAvailable ? " - server activity detection on" : ""}`
    );
    shell.appendChild(summary);

    const list = el("div", "stash-np-list");
    if (!state.sessions.length && !state.loading) {
      list.appendChild(el("div", "stash-np-empty", "Nothing is currently reported as playing."));
    } else {
      state.sessions.forEach((session) => list.appendChild(renderSession(session)));
    }
    shell.appendChild(list);
    container.appendChild(shell);
  }

  function render() {
    const navButton = document.querySelector(`#${NAV_ID} .stash-np-nav-button`);
    if (navButton) navButton.classList.toggle("active", isRoute());
    if (state.routeContainer && isRoute()) {
      renderInto(state.routeContainer);
      return;
    }
  }

  function registerPluginRoute() {
    const api = window.PluginApi;
    if (!api || !api.React || !api.register || !api.register.route || window.__stashNowPlayingRouteRegistered) return;
    window.__stashNowPlayingRouteRegistered = true;
    const React = api.React;
    function NowPlayingPage() {
      const ref = React.useRef(null);
      React.useEffect(() => {
        if (!ref.current) return undefined;
        state.routeContainer = ref.current;
        loadSessions();
        return () => {
          if (state.routeContainer === ref.current) state.routeContainer = null;
        };
      }, []);
      return React.createElement("div", { id: APP_ID, ref });
    }
    api.register.route(ROUTE, NowPlayingPage);
  }

  function install() {
    registerPluginRoute();
    patchHistory();
    addNav();
    window.setTimeout(addNav, 1500);
    window.setInterval(monitorPlayback, HEARTBEAT_MS);
    window.setInterval(loadSessions, REFRESH_MS);
    window.setInterval(pollSceneActivity, ACTIVITY_POLL_MS);
    window.setInterval(pollPlaybackLogs, LOG_POLL_MS);
    document.addEventListener("play", () => sendHeartbeat(true).catch(() => {}), true);
    document.addEventListener("pause", () => sendHeartbeat(true).catch(() => {}), true);
    monitorPlayback();
    pollSceneActivity();
    pollPlaybackLogs();
  }

  const observer = new MutationObserver(addNav);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  if (window.PluginApi && window.PluginApi.Event && window.PluginApi.Event.addEventListener) {
    window.PluginApi.Event.addEventListener("stash:location", () => {
      addNav();
      render();
    });
  }
  window.addEventListener("popstate", render);
  window.addEventListener("stash-now-playing-route", render);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
