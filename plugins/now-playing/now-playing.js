(function () {
  "use strict";

  const ROUTE = "/plugin/now-playing";
  const NAV_ID = "stash-now-playing-nav";
  const APP_ID = "stash-now-playing-root";
  const HEARTBEAT_MS = 8000;
  const REFRESH_MS = 5000;

  const state = {
    pluginId: "",
    routeRegistered: false,
    routeContainer: null,
    sessions: [],
    error: "",
    loading: false,
    currentScene: null,
    lastReportKey: "",
    lastReportAt: 0,
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
    if (state.currentScene && state.currentScene.id === sceneId) return state.currentScene;
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
    state.currentScene = data && data.findScene;
    return state.currentScene;
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
      sceneId,
      title: scene.title || (firstFile && firstFile.basename) || `Scene ${sceneId}`,
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
    const preferred = document.querySelector(".navbar-collapse .navbar-nav");
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
    if (!nav) return;
    const wrap = el("div", "stash-np-nav-wrap");
    wrap.id = NAV_ID;
    const link = el("a", "nav-link stash-np-nav-button");
    link.href = ROUTE;
    link.appendChild(el("span", "fa fa-play-circle fas fa-play-circle stash-np-nav-icon"));
    link.appendChild(el("span", "stash-np-nav-text", "Now Playing"));
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
    status.textContent = session.active ? `Playing on ${session.clientName || "Browser"}` : `Paused/recent · ${session.ageSeconds || 0}s ago`;

    const progress = el("span", "stash-np-progress");
    const bar = el("span", "stash-np-progress-bar");
    bar.style.width = `${progressPercent(session)}%`;
    progress.appendChild(bar);

    const time = el("span", "stash-np-time", `${formatTime(session.currentTime)} / ${formatTime(session.duration)}`);
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
    const summary = el("div", "stash-np-summary", `${active.length} active · ${recent.length} recent`);
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
    if (state.routeContainer) {
      renderInto(state.routeContainer);
      return;
    }
    const navButton = document.querySelector(`#${NAV_ID} .stash-np-nav-button`);
    if (navButton) navButton.classList.toggle("active", isRoute());
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
    document.addEventListener("play", () => sendHeartbeat(true).catch(() => {}), true);
    document.addEventListener("pause", () => sendHeartbeat(true).catch(() => {}), true);
    monitorPlayback();
  }

  const observer = new MutationObserver(addNav);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", render);
  window.addEventListener("stash-now-playing-route", render);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
