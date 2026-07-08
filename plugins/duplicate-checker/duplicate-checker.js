(function () {
  "use strict";

  const ROUTE = "/duplicate-checker";
  const NAV_ID = "stash-duplicate-checker-nav";
  const LAUNCHER_ID = "stash-duplicate-checker-launcher";
  const APP_ID = "stash-duplicate-checker-root";
  const PAGE_SIZE = 250;
  const MAX_PAGES = 200;

  const state = {
    routeRegistered: false,
    routeContainer: null,
    loading: false,
    error: "",
    status: "",
    groups: [],
    mode: "fingerprint",
    search: "",
    loaded: false,
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

  function isRoute() {
    return window.location.pathname.replace(/\/$/, "") === ROUTE;
  }

  function notifyRouteChange() {
    window.dispatchEvent(new Event("stash-duplicate-checker-route"));
  }

  function patchHistory() {
    if (window.__stashDuplicateCheckerHistoryPatched) return;
    window.__stashDuplicateCheckerHistoryPatched = true;
    ["pushState", "replaceState"].forEach((method) => {
      const original = window.history[method];
      window.history[method] = function patchedHistoryState() {
        const result = original.apply(this, arguments);
        window.setTimeout(notifyRouteChange, 0);
        return result;
      };
    });
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
    try {
      if (document.getElementById(NAV_ID)) {
        removeLauncher();
        return;
      }
      const nav = findNav();
      if (!nav) return;
      const wrap = el("div", "stash-dc-nav-wrap");
      wrap.id = NAV_ID;
      const link = el("a", "nav-link stash-dc-nav-button");
      link.href = ROUTE;
      link.setAttribute("aria-label", "Duplicate Checker");
      link.appendChild(el("span", "fa fa-copy fas fa-copy stash-dc-nav-icon"));
      link.appendChild(el("span", "stash-dc-nav-text", "Duplicates"));
      link.addEventListener("click", navigate);
      wrap.appendChild(link);
      nav.appendChild(wrap);
      removeLauncher();
    } catch (error) {
      console.error("[Duplicate Checker] failed adding nav", error);
    }
  }

  function removeLauncher() {
    const launcher = document.getElementById(LAUNCHER_ID);
    if (launcher) launcher.remove();
  }

  function addLauncher() {
    if (document.getElementById(NAV_ID) || document.getElementById(LAUNCHER_ID)) return;
    const launcher = el("button", "stash-dc-launcher", "Duplicates");
    launcher.id = LAUNCHER_ID;
    launcher.type = "button";
    launcher.addEventListener("click", navigate);
    document.body.appendChild(launcher);
  }

  function getApp() {
    let app = document.getElementById(APP_ID);
    if (!app) {
      app = el("main", "stash-dc-app");
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

  async function loadPaged(query) {
    const scenes = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      state.status = `Scanning scenes page ${page}...`;
      render();
      const data = await graphql(query, { filter: { page, per_page: PAGE_SIZE } });
      const result = data && data.findScenes;
      const items = (result && result.scenes) || [];
      total = result && typeof result.count === "number" ? result.count : scenes.length + items.length;
      scenes.push(...items);
      if (!items.length || scenes.length >= total || items.length < PAGE_SIZE) break;
    }
    return scenes;
  }

  function normalizePath(path) {
    return String(path || "").replace(/\\/g, "/");
  }

  function firstFile(scene) {
    return scene && scene.files && scene.files[0];
  }

  function titleFor(scene) {
    const file = firstFile(scene);
    return scene.title || (file && file.basename) || `Scene ${scene.id}`;
  }

  function relationNames(list) {
    return (list || []).map((entry) => entry.name || entry.title).filter(Boolean).slice(0, 5);
  }

  function fileSize(file) {
    const value = Number(file && file.size);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function sceneDuration(scene) {
    const direct = Number(scene && scene.duration);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const file = firstFile(scene);
    const value = Number(file && file.duration);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function fingerprintKeys(scene) {
    const file = firstFile(scene);
    const fingerprints = (file && file.fingerprints) || [];
    return fingerprints
      .map((fingerprint) => {
        const type = String(fingerprint.type || "").toLowerCase();
        const value = String(fingerprint.value || "").toLowerCase();
        return type && value ? `fp:${type}:${value}` : "";
      })
      .filter(Boolean);
  }

  function fallbackKey(scene) {
    const file = firstFile(scene);
    const size = fileSize(file);
    const duration = sceneDuration(scene);
    if (!size || !duration) return "";
    return `size-duration:${size}:${Math.round(duration)}`;
  }

  function detectionKeys(scene) {
    const fps = fingerprintKeys(scene);
    if (state.mode === "fingerprint") return fps;
    const fallback = fallbackKey(scene);
    return fallback ? fps.concat(fallback) : fps;
  }

  function groupScenes(scenes) {
    const buckets = new Map();
    scenes.forEach((scene) => {
      detectionKeys(scene).forEach((key) => {
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(scene);
      });
    });

    const seenSceneSets = new Set();
    return Array.from(buckets.entries())
      .filter((entry) => entry[1].length > 1)
      .map(([key, items]) => {
        const unique = Array.from(new Map(items.map((item) => [item.id, item])).values());
        return { key, scenes: unique, type: key.startsWith("fp:") ? "Fingerprint" : "Size + duration" };
      })
      .filter((group) => {
        const signature = group.scenes.map((scene) => scene.id).sort((a, b) => Number(a) - Number(b)).join(",");
        if (seenSceneSets.has(signature)) return false;
        seenSceneSets.add(signature);
        return group.scenes.length > 1;
      })
      .sort((a, b) => b.scenes.length - a.scenes.length || a.key.localeCompare(b.key));
  }

  async function loadDuplicates(force) {
    if (state.loaded && !force) return;
    state.loading = true;
    state.error = "";
    state.status = "Scanning scenes...";
    render();
    const fingerprintQuery = `query DuplicateCheckerScenes($filter: FindFilterType) {
      findScenes(filter: $filter) {
        count
        scenes {
          id title date duration
          paths { screenshot }
          files { id path basename size duration fingerprints { type value } }
          studio { name }
          performers { name }
          tags { name }
        }
      }
    }`;
    const fallbackQuery = `query DuplicateCheckerScenesBasic($filter: FindFilterType) {
      findScenes(filter: $filter) {
        count
        scenes {
          id title date duration
          paths { screenshot }
          files { id path basename size duration }
          studio { name }
          performers { name }
          tags { name }
        }
      }
    }`;
    try {
      let scenes;
      try {
        scenes = await loadPaged(fingerprintQuery);
      } catch (error) {
        console.warn("[Duplicate Checker] fingerprint query failed, falling back to size/duration", error);
        scenes = await loadPaged(fallbackQuery);
      }
      state.groups = groupScenes(scenes);
      state.loaded = true;
      const duplicateCount = state.groups.reduce((sum, group) => sum + group.scenes.length, 0);
      state.status = `${state.groups.length} duplicate groups, ${duplicateCount} scenes involved`;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
      console.error("[Duplicate Checker] scan failed", error);
    } finally {
      state.loading = false;
      render();
    }
  }

  function filteredGroups() {
    const term = state.search.trim().toLowerCase();
    if (!term) return state.groups;
    return state.groups.filter((group) =>
      group.scenes.some((scene) => {
        const file = firstFile(scene);
        const text = [
          titleFor(scene),
          file && file.path,
          scene.studio && scene.studio.name,
          ...relationNames(scene.performers),
          ...relationNames(scene.tags),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return text.includes(term);
      })
    );
  }

  function bytes(value) {
    const size = Number(value) || 0;
    if (!size) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let amount = size;
    let index = 0;
    while (amount >= 1024 && index < units.length - 1) {
      amount /= 1024;
      index += 1;
    }
    return `${amount.toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function formatDuration(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const rest = value % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${minutes}:${String(rest).padStart(2, "0")}`;
  }

  function openScene(scene) {
    window.history.pushState({}, "", `/scenes/${scene.id}?qsort=date&qfp=1&continue=false`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    notifyRouteChange();
  }

  function renderToolbar(parent) {
    const toolbar = el("div", "stash-dc-toolbar");
    const tabs = el("div", "stash-dc-tabs");
    [
      ["fingerprint", "Fingerprints"],
      ["broad", "Broad scan"],
    ].forEach(([mode, label]) => {
      const button = el("button", "stash-dc-tab", label);
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.mode === mode));
      button.addEventListener("click", () => {
        if (state.mode === mode) return;
        state.mode = mode;
        state.loaded = false;
        loadDuplicates(true);
      });
      tabs.appendChild(button);
    });

    const search = el("input", "stash-dc-search");
    search.type = "search";
    search.placeholder = "Search titles, paths, performers, tags";
    search.value = state.search;
    search.addEventListener("input", () => {
      state.search = search.value;
      render();
    });

    const refresh = el("button", "stash-dc-refresh", "Scan");
    refresh.type = "button";
    refresh.addEventListener("click", () => {
      state.loaded = false;
      loadDuplicates(true);
    });
    toolbar.append(tabs, search, refresh);
    parent.appendChild(toolbar);
  }

  function renderScene(scene) {
    const file = firstFile(scene) || {};
    const item = el("button", "stash-dc-scene");
    item.type = "button";
    item.title = file.path || titleFor(scene);
    item.addEventListener("click", () => openScene(scene));

    const imageUrl = scene.paths && scene.paths.screenshot;
    if (imageUrl) {
      const image = el("img", "stash-dc-thumb");
      image.src = imageUrl;
      image.alt = titleFor(scene);
      image.loading = "lazy";
      item.appendChild(image);
    } else {
      item.appendChild(el("div", "stash-dc-thumb stash-dc-thumb-empty", "No preview"));
    }

    const body = el("span", "stash-dc-scene-body");
    body.appendChild(el("span", "stash-dc-scene-title", titleFor(scene)));
    body.appendChild(el("span", "stash-dc-path", normalizePath(file.path || "")));
    const meta = el("span", "stash-dc-meta");
    const bits = [
      scene.studio && scene.studio.name,
      ...relationNames(scene.performers),
      bytes(file.size),
      formatDuration(sceneDuration(scene)),
      scene.date,
    ].filter(Boolean);
    bits.slice(0, 8).forEach((bit) => meta.appendChild(el("span", "stash-dc-chip", bit)));
    body.appendChild(meta);
    item.appendChild(body);
    return item;
  }

  function renderGroup(group, index) {
    const section = el("section", "stash-dc-group");
    const header = el("div", "stash-dc-group-header");
    const title = el("h2", "", `Group ${index + 1}`);
    const badge = el("span", "stash-dc-badge", `${group.scenes.length} scenes`);
    const type = el("span", "stash-dc-type", group.type);
    header.append(title, badge, type);
    section.appendChild(header);
    const key = group.key.replace(/^fp:/, "").replace(/^size-duration:/, "size/duration: ");
    section.appendChild(el("div", "stash-dc-key", key));
    const list = el("div", "stash-dc-scenes");
    group.scenes.forEach((scene) => list.appendChild(renderScene(scene)));
    section.appendChild(list);
    return section;
  }

  function renderInto(container) {
    container.className = "stash-dc-app";
    clear(container);
    const shell = el("section", "stash-dc-shell");
    const titlebar = el("div", "stash-dc-titlebar");
    titlebar.appendChild(el("h1", "", "Duplicate Checker"));
    titlebar.appendChild(el("p", "", "Find scenes that share fingerprints or likely matching file properties."));
    shell.appendChild(titlebar);
    renderToolbar(shell);
    if (state.error) shell.appendChild(el("div", "stash-dc-error", state.error));
    if (state.status) shell.appendChild(el("div", "stash-dc-status", state.status));
    if (state.loading && !state.groups.length) {
      shell.appendChild(el("div", "stash-dc-empty", "Scanning database..."));
    } else {
      const groups = filteredGroups();
      if (!groups.length) {
        shell.appendChild(el("div", "stash-dc-empty", state.loaded ? "No duplicates found for the current scan." : "Run a scan to find duplicates."));
      } else {
        const list = el("div", "stash-dc-groups");
        groups.forEach((group, index) => list.appendChild(renderGroup(group, index)));
        shell.appendChild(list);
      }
    }
    container.appendChild(shell);
    if (!state.loaded && !state.loading && !state.error) loadDuplicates(false);
  }

  function render() {
    try {
      if (state.routeContainer) {
        renderInto(state.routeContainer);
        return;
      }
      const app = getApp();
      const navButton = document.querySelector(`#${NAV_ID} .stash-dc-nav-button`);
      if (navButton) navButton.classList.toggle("active", isRoute());
      if (isRoute() && state.routeRegistered) {
        app.hidden = true;
        return;
      }
      if (!isRoute()) {
        app.hidden = true;
        return;
      }
      app.hidden = false;
      renderInto(app);
    } catch (error) {
      console.error("[Duplicate Checker] render failed", error);
    }
  }

  function registerPluginRoute() {
    const api = window.PluginApi;
    if (!api || !api.React || !api.register || !api.register.route || window.__stashDuplicateCheckerRouteRegistered) return;
    window.__stashDuplicateCheckerRouteRegistered = true;
    state.routeRegistered = true;
    const React = api.React;
    function DuplicateCheckerPage() {
      const ref = React.useRef(null);
      React.useEffect(() => {
        if (!ref.current) return undefined;
        state.routeContainer = ref.current;
        renderInto(ref.current);
        return () => {
          if (state.routeContainer === ref.current) state.routeContainer = null;
        };
      });
      return React.createElement("div", { id: APP_ID, ref });
    }
    api.register.route(ROUTE, DuplicateCheckerPage);
  }

  function install() {
    registerPluginRoute();
    patchHistory();
    addNav();
    window.setTimeout(() => {
      addNav();
      addLauncher();
    }, 1500);
    render();
  }

  const observer = new MutationObserver(addNav);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", render);
  window.addEventListener("stash-duplicate-checker-route", render);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
