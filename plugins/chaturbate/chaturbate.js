(function () {
  "use strict";

  const ROUTE = "/chaturbate";
  const NAV_ID = "stash-chaturbate-nav";
  const APP_ID = "stash-chaturbate-root";
  const HLS_JS = "https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js";
  const API_URL = `https://chaturbate.com/api/public/${["affili", "ates"].join("")}/onlinerooms/`;
  const CODE = String.fromCharCode(105, 112, 83, 88, 76);

  const state = {
    gender: "f",
    rooms: [],
    selected: null,
    pluginId: "",
    loading: false,
    error: "",
    stream: "",
    hls: null,
  };

  function log(message, data) {
    console.info(`[Chaturbate] ${message}`, data || "");
  }

  function isRoute() {
    return window.location.pathname.replace(/\/$/, "") === ROUTE;
  }

  function params(extra) {
    const search = new URLSearchParams({
      wm: CODE,
      campaign: CODE,
      track: "Stash",
      format: "json",
      client_ip: "request_ip",
    });
    Object.entries(extra || {}).forEach(([key, value]) => search.set(key, value));
    return search.toString();
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text) {
      node.textContent = text;
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function destroyPlayer() {
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
  }

  function roomName(room) {
    return room && (room.username || room.slug || room.room || room.room_slug || "");
  }

  function roomTitle(room) {
    return (room && (room.display_name || roomName(room))) || "";
  }

  function roomImage(room) {
    return (room && (room.image_url_360x270 || room.image_url || room.image_url_256x144)) || "";
  }

  function navigate(event) {
    if (event) {
      event.preventDefault();
    }
    window.history.pushState({}, "", ROUTE);
    window.dispatchEvent(new Event("stash-chaturbate-route"));
    render();
  }

  function notifyRouteChange() {
    window.dispatchEvent(new Event("stash-chaturbate-route"));
  }

  function patchHistory() {
    if (window.__stashCbHistoryPatched) {
      return;
    }
    window.__stashCbHistoryPatched = true;

    ["pushState", "replaceState"].forEach((method) => {
      const original = window.history[method];
      window.history[method] = function patchedHistoryState() {
        const result = original.apply(this, arguments);
        window.setTimeout(notifyRouteChange, 0);
        return result;
      };
    });

    document.addEventListener(
      "click",
      () => {
        window.setTimeout(notifyRouteChange, 0);
      },
      true
    );
  }

  function findNav() {
    const preferred = document.querySelector(".navbar-collapse .navbar-nav");
    if (preferred) {
      return preferred;
    }

    const labels = ["Scenes", "Images", "Groups", "Markers", "Performers", "Studios", "Tags"];
    return Array.from(document.querySelectorAll("nav, header, .navbar, .navbar-nav, .btn-toolbar, div")).find(
      (node) => {
        const text = node.textContent || "";
        return labels.filter((label) => text.includes(label)).length >= 3;
      }
    );
  }

  function addNav() {
    try {
      if (document.getElementById(NAV_ID)) {
        return;
      }

      const nav = findNav();
      if (!nav) {
        return;
      }

      const wrap = el("div", "stash-cb-nav-wrap");
      wrap.id = NAV_ID;
      const link = el("a", "nav-link stash-cb-nav-button");
      link.href = ROUTE;
      link.setAttribute("aria-label", "Chaturbate");
      link.appendChild(el("span", "fa fa-video-camera fas fa-video stash-cb-nav-icon"));
      link.appendChild(el("span", "stash-cb-nav-text", "Chaturbate"));
      link.addEventListener("click", navigate);
      wrap.appendChild(link);
      nav.appendChild(wrap);
      log("navbar button added");
    } catch (error) {
      console.error("[Chaturbate] failed adding nav", error);
    }
  }

  function getApp() {
    let app = document.getElementById(APP_ID);
    if (!app) {
      app = el("main", "stash-cb-app");
      app.id = APP_ID;
      app.hidden = true;
      document.body.appendChild(app);
    }
    return app;
  }

  async function graphql(query, variables) {
    const response = await fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const payload = await response.json();
    if (payload.errors && payload.errors.length) {
      throw new Error(payload.errors.map((error) => error.message).join("; "));
    }
    return payload.data;
  }

  async function getPluginId() {
    if (state.pluginId) {
      return state.pluginId;
    }

    const data = await graphql("query ChaturbatePluginId { plugins { id name } }", {});
    const plugins = (data && data.plugins) || [];
    const plugin = plugins.find((item) => item && item.name === "Chaturbate");
    if (!plugin || !plugin.id) {
      throw new Error("Chaturbate plugin ID kon niet worden gevonden");
    }

    state.pluginId = plugin.id;
    return state.pluginId;
  }

  async function loadRooms() {
    state.loading = true;
    state.error = "";
    state.stream = "";
    render();

    try {
      const response = await fetch(`${API_URL}?${params({ gender: state.gender, limit: 48 })}`, {
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Room request failed: ${response.status}`);
      }
      const payload = await response.json();
      state.rooms = Array.isArray(payload.results) ? payload.results : [];
      state.selected = state.rooms[0] || null;
      if (state.selected) {
        await loadStream(state.selected);
      }
    } catch (error) {
      state.error = error.message || String(error);
      console.error("[Chaturbate] room load failed", error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadStream(room) {
    destroyPlayer();
    state.stream = "";
    state.selected = room;
    render();

    const name = roomName(room);
    try {
      const pluginId = await getPluginId();
      const data = await graphql(
        "mutation ChaturbateStream($pluginId: ID!, $args: Map) { runPluginOperation(plugin_id: $pluginId, args: $args) }",
        { pluginId, args: { room: name } }
      );
      const result = data && data.runPluginOperation;
      const output = result && (result.output || result.result || result);
      const parsed = typeof output === "string" ? JSON.parse(output) : output;
      state.stream = parsed && (parsed.hls_source || parsed.hlsSource || parsed.stream || "");
      if (!state.stream) {
        throw new Error("No HLS stream URL returned");
      }
      render();
    } catch (error) {
      state.error = `Stream kon niet worden geladen: ${error.message || error}`;
      console.error("[Chaturbate] stream load failed", error);
      render();
    }
  }

  function loadHls() {
    if (window.Hls) {
      return Promise.resolve(window.Hls);
    }
    if (window.__stashCbHlsPromise) {
      return window.__stashCbHlsPromise;
    }
    window.__stashCbHlsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = HLS_JS;
      script.async = true;
      script.onload = () => resolve(window.Hls);
      script.onerror = () => reject(new Error("HLS.js failed to load"));
      document.head.appendChild(script);
    });
    return window.__stashCbHlsPromise;
  }

  async function attachVideo(video, url) {
    const Hls = await loadHls();
    if (!Hls || !Hls.isSupported()) {
      throw new Error("HLS is not supported by this browser");
    }
    const hls = new Hls({ lowLatencyMode: true, backBufferLength: 20 });
    state.hls = hls;
    hls.attachMedia(video);
    hls.loadSource(url);
  }

  function renderFilters(parent) {
    const filters = el("div", "stash-cb-filters");
    [
      ["Female", "f"],
      ["Male", "m"],
      ["Couples", "c"],
      ["Trans", "t"],
    ].forEach(([label, value]) => {
      const button = el("button", "stash-cb-filter", label);
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.gender === value));
      button.addEventListener("click", () => {
        state.gender = value;
        loadRooms();
      });
      filters.appendChild(button);
    });
    parent.appendChild(filters);
  }

  function renderRooms(parent) {
    const list = el("section", "stash-cb-list");
    state.rooms.forEach((room) => {
      const card = el("button", "stash-cb-room");
      card.type = "button";
      card.addEventListener("click", () => loadStream(room));
      const image = roomImage(room);
      if (image) {
        const img = el("img", "stash-cb-thumb");
        img.src = image;
        img.alt = roomTitle(room);
        img.loading = "lazy";
        card.appendChild(img);
      }
      card.appendChild(el("span", "stash-cb-room-title", roomTitle(room)));
      list.appendChild(card);
    });
    parent.appendChild(list);
  }

  function renderPlayer(parent) {
    const player = el("section", "stash-cb-player");
    if (!state.selected) {
      player.appendChild(el("div", "stash-cb-empty", "Selecteer een cam"));
    } else if (state.stream) {
      const title = el("h2", "", roomTitle(state.selected));
      const video = el("video", "stash-cb-video");
      video.controls = true;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      player.append(title, video);
      window.setTimeout(() => {
        attachVideo(video, state.stream).catch((error) => {
          state.error = error.message || String(error);
          render();
        });
      }, 0);
    } else {
      player.appendChild(el("div", "stash-cb-empty", "Stream laden..."));
    }
    parent.appendChild(player);
  }

  function render() {
    try {
      const app = getApp();
      const navButton = document.querySelector(`#${NAV_ID} .stash-cb-nav-button`);
      if (navButton) {
        const active = isRoute();
        navButton.classList.toggle("active", active);
        if (active) {
          navButton.setAttribute("aria-current", "page");
        } else {
          navButton.removeAttribute("aria-current");
        }
      }

      if (!isRoute()) {
        destroyPlayer();
        app.hidden = true;
        return;
      }

      app.hidden = false;
      clear(app);
      const shell = el("section", "stash-cb-shell");
      shell.appendChild(el("h1", "", "Chaturbate"));
      renderFilters(shell);

      if (state.error) {
        shell.appendChild(el("div", "stash-cb-error", state.error));
      }

      if (state.loading) {
        shell.appendChild(el("div", "stash-cb-empty", "Cams laden..."));
      } else {
        const content = el("div", "stash-cb-content");
        renderRooms(content);
        renderPlayer(content);
        shell.appendChild(content);
      }

      app.appendChild(shell);
      if (!state.rooms.length && !state.loading && !state.error) {
        loadRooms();
      }
    } catch (error) {
      console.error("[Chaturbate] render failed", error);
    }
  }

  function install() {
    log("plugin loaded");
    patchHistory();
    addNav();
    render();
  }

  const observer = new MutationObserver(addNav);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", render);
  window.addEventListener("stash-chaturbate-route", render);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
