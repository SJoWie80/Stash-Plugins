(function () {
  "use strict";

  const ROUTE = "/x-wall";
  const NAV_ID = "stash-xw-nav";
  const LAUNCHER_ID = "stash-xw-launcher";
  const APP_ID = "stash-xw-root";
  const PAGE_SIZE = 250;
  const MAX_PAGES = 80;
  const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

  const state = {
    performers: [],
    handles: [],
    loading: false,
    loaded: false,
    error: "",
    status: "",
    search: "",
    routeRegistered: false,
    routeContainer: null,
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
    window.dispatchEvent(new Event("stash-x-wall-route"));
  }

  function patchHistory() {
    if (window.__stashXWallHistoryPatched) return;
    window.__stashXWallHistoryPatched = true;
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
    const preferred = document.querySelector(".navbar-collapse .navbar-nav, .navbar-nav, nav .nav, header .nav");
    if (preferred) return preferred;
    const labels = ["Scenes", "Images", "Groups", "Markers", "Performers", "Studios", "Tags"];
    return Array.from(document.querySelectorAll("nav, header, .navbar, .navbar-nav, .btn-toolbar, [role='navigation'], div")).find((node) => {
      const text = node.textContent || "";
      return labels.filter((label) => text.includes(label)).length >= 3;
    });
  }

  function insertNavItem(nav, item) {
    const listItem = el("li", "nav-item stash-xw-nav-item");
    listItem.appendChild(item);
    if (nav.tagName && nav.tagName.toLowerCase() === "ul") {
      nav.appendChild(listItem);
      return;
    }
    nav.appendChild(item);
  }

  function addNav() {
    try {
      if (document.getElementById(NAV_ID)) {
        removeLauncher();
        return;
      }
      const nav = findNav();
      if (!nav) {
        addLauncher();
        return;
      }
      const wrap = el("div", "stash-xw-nav-wrap");
      wrap.id = NAV_ID;
      const link = el("a", "nav-link stash-xw-nav-button");
      link.href = ROUTE;
      link.setAttribute("aria-label", "X Wall");
      link.appendChild(el("span", "fa fa-brands fa-x-twitter fab stash-xw-nav-icon"));
      link.appendChild(el("span", "stash-xw-nav-text", "X Wall"));
      link.addEventListener("click", navigate);
      wrap.appendChild(link);
      insertNavItem(nav, wrap);
      removeLauncher();
    } catch (error) {
      console.error("[X Wall] failed adding nav", error);
      addLauncher();
    }
  }

  function removeLauncher() {
    const launcher = document.getElementById(LAUNCHER_ID);
    if (launcher) launcher.remove();
  }

  function addLauncher() {
    if (document.getElementById(NAV_ID) || document.getElementById(LAUNCHER_ID)) return;
    const launcher = el("button", "stash-xw-launcher", "X Wall");
    launcher.id = LAUNCHER_ID;
    launcher.type = "button";
    launcher.addEventListener("click", navigate);
    document.body.appendChild(launcher);
  }

  function getApp() {
    let app = document.getElementById(APP_ID);
    if (!app) {
      app = el("main", "stash-xw-app");
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

  function extractUrls(performer) {
    const raw = [];
    if (Array.isArray(performer.urls)) raw.push(...performer.urls);
    if (performer.url) raw.push(performer.url);
    return raw.map((url) => String(url || "").trim()).filter(Boolean);
  }

  function handleFromUrl(url) {
    const value = String(url || "").trim();
    if (!value) return "";
    const direct = value.match(/^@?([A-Za-z0-9_]{1,15})$/);
    if (direct) return direct[1];

    let parsed;
    try {
      parsed = new URL(value.startsWith("http") ? value : `https://${value}`);
    } catch (_) {
      return "";
    }

    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    if (!["x.com", "twitter.com", "mobile.twitter.com"].includes(host)) return "";
    const parts = parsed.pathname.split("/").filter(Boolean);
    const blocked = new Set(["home", "i", "intent", "share", "search", "hashtag", "messages", "notifications", "settings"]);
    const candidate = parts[0] || "";
    if (!HANDLE_RE.test(candidate) || blocked.has(candidate.toLowerCase())) return "";
    return candidate;
  }

  function buildHandles(performers) {
    const byHandle = new Map();
    performers.forEach((performer) => {
      extractUrls(performer).forEach((url) => {
        const handle = handleFromUrl(url);
        if (!handle) return;
        const key = handle.toLowerCase();
        if (!byHandle.has(key)) {
          byHandle.set(key, {
            handle,
            performers: [],
            urls: [],
            image: performer.image_path || "",
          });
        }
        const entry = byHandle.get(key);
        entry.urls.push(url);
        if (!entry.performers.some((item) => item.id === performer.id)) {
          entry.performers.push({ id: performer.id, name: performer.name || handle });
        }
      });
    });
    return Array.from(byHandle.values()).sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { sensitivity: "base" }));
  }

  async function loadWithUrlsField(onlyFavorites) {
    const query = `query XWallPerformers($filter: FindFilterType, $performer_filter: PerformerFilterType) {
      findPerformers(filter: $filter, performer_filter: $performer_filter) {
        count
        performers {
          id
          name
          favorite
          image_path
          urls
        }
      }
    }`;
    return loadPaged(query, onlyFavorites);
  }

  async function loadWithUrlField(onlyFavorites) {
    const query = `query XWallPerformersLegacy($filter: FindFilterType, $performer_filter: PerformerFilterType) {
      findPerformers(filter: $filter, performer_filter: $performer_filter) {
        count
        performers {
          id
          name
          favorite
          image_path
          url
        }
      }
    }`;
    return loadPaged(query, onlyFavorites);
  }

  async function loadPaged(query, onlyFavorites) {
    const all = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      state.status = `Loading favorite performers page ${page}...`;
      render();
      const data = await graphql(query, {
        filter: { page, per_page: PAGE_SIZE, sort: "name", direction: "ASC" },
        performer_filter: onlyFavorites ? { favorite: { value: true, modifier: "EQUALS" } } : undefined,
      });
      const result = data && data.findPerformers;
      const performers = (result && result.performers) || [];
      total = result && typeof result.count === "number" ? result.count : all.length + performers.length;
      all.push(...performers);
      if (!performers.length || all.length >= total || performers.length < PAGE_SIZE) break;
    }
    return all;
  }

  async function loadPerformers() {
    state.loading = true;
    state.error = "";
    state.status = "Loading favorite performers...";
    render();
    try {
      let performers = await loadBestPerformerQuery(true);
      if (!performers.length) performers = await loadBestPerformerQuery(false);

      const favoritePerformers = performers.filter((performer) => performer.favorite !== false);
      state.performers = favoritePerformers;
      state.handles = buildHandles(favoritePerformers);
      state.loaded = true;
      state.status = `${state.handles.length} X account${state.handles.length === 1 ? "" : "s"} found for favorite performers`;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
      console.error("[X Wall] load failed", error);
    } finally {
      state.loading = false;
      render();
    }
  }

  async function loadBestPerformerQuery(onlyFavorites) {
    try {
      return await loadWithUrlsField(onlyFavorites);
    } catch (urlsError) {
      console.warn("[X Wall] urls performer query failed, trying legacy url field", urlsError);
      try {
        return await loadWithUrlField(onlyFavorites);
      } catch (urlError) {
        if (onlyFavorites) {
          console.warn("[X Wall] favorite performer filter failed, loading all performers for client-side filtering", urlError);
          return loadBestPerformerQuery(false);
        }
        throw urlError;
      }
    }
  }

  function displayName(entry) {
    return entry.performers.map((performer) => performer.name).join(", ") || `@${entry.handle}`;
  }

  function filteredHandles() {
    const term = state.search.trim().toLowerCase();
    if (!term) return state.handles;
    return state.handles.filter((entry) => {
      const haystack = [entry.handle, displayName(entry), ...entry.urls].join(" ").toLowerCase();
      return haystack.includes(term);
    });
  }

  function loadWidgets() {
    if (!state.routeContainer && !isRoute()) return;
    const existing = document.querySelector('script[src="https://platform.twitter.com/widgets.js"]');
    if (existing && window.twttr && window.twttr.widgets) {
      window.twttr.widgets.load();
      return;
    }
    if (existing) return;
    const script = document.createElement("script");
    script.async = true;
    script.charset = "utf-8";
    script.src = "https://platform.twitter.com/widgets.js";
    document.body.appendChild(script);
  }

  function renderToolbar(parent) {
    const toolbar = el("div", "stash-xw-toolbar");
    const search = el("input", "stash-xw-search");
    search.type = "search";
    search.placeholder = "Search performers or X handles";
    search.value = state.search;
    search.addEventListener("input", () => {
      state.search = search.value;
      render();
    });
    const refresh = el("button", "stash-xw-refresh", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", () => loadPerformers());
    toolbar.append(search, refresh);
    parent.appendChild(toolbar);
  }

  function renderTimeline(parent, entry) {
    const card = el("article", "stash-xw-card");
    const header = el("header", "stash-xw-card-header");
    const avatar = el("div", "stash-xw-avatar");
    if (entry.image) {
      const img = el("img", "");
      img.src = entry.image;
      img.alt = displayName(entry);
      img.loading = "lazy";
      avatar.appendChild(img);
    } else {
      avatar.textContent = displayName(entry).slice(0, 1).toUpperCase();
    }
    const title = el("div", "stash-xw-card-title");
    title.appendChild(el("h2", "", displayName(entry)));
    title.appendChild(el("a", "stash-xw-handle", `@${entry.handle}`));
    title.lastChild.href = `https://x.com/${entry.handle}`;
    title.lastChild.target = "_blank";
    title.lastChild.rel = "noreferrer";
    header.append(avatar, title);

    const timelineWrap = el("div", "stash-xw-timeline");
    const link = el("a", "twitter-timeline", `Posts by @${entry.handle}`);
    link.href = `https://twitter.com/${entry.handle}`;
    link.setAttribute("data-dnt", "true");
    link.setAttribute("data-theme", document.documentElement.getAttribute("data-bs-theme") === "light" ? "light" : "dark");
    link.setAttribute("data-chrome", "noheader nofooter noborders transparent");
    link.setAttribute("data-height", "620");
    timelineWrap.appendChild(link);
    card.append(header, timelineWrap);
    parent.appendChild(card);
  }

  function renderWall(parent) {
    const handles = filteredHandles();
    if (!handles.length) {
      parent.appendChild(el("div", "stash-xw-empty", state.loaded ? "No X/Twitter URLs found on favorite performers." : "No accounts loaded yet."));
      return;
    }
    const grid = el("div", "stash-xw-grid");
    handles.forEach((entry) => renderTimeline(grid, entry));
    parent.appendChild(grid);
    window.setTimeout(loadWidgets, 0);
  }

  function renderInto(container) {
    container.className = "stash-xw-app";
    clear(container);
    const shell = el("section", "stash-xw-shell");
    const header = el("div", "stash-xw-titlebar");
    const title = el("div", "");
    title.appendChild(el("h1", "", "X Wall"));
    title.appendChild(el("p", "", "Profile timelines for favorite performers with X/Twitter URLs."));
    header.appendChild(title);
    shell.appendChild(header);
    renderToolbar(shell);
    if (state.error) shell.appendChild(el("div", "stash-xw-error", state.error));
    if (state.status) shell.appendChild(el("div", "stash-xw-status", state.status));
    if (state.loading) shell.appendChild(el("div", "stash-xw-empty", "Loading favorite performers..."));
    renderWall(shell);
    container.appendChild(shell);
    if (!state.loaded && !state.loading && !state.error) loadPerformers();
  }

  function render() {
    try {
      if (state.routeContainer) {
        renderInto(state.routeContainer);
        return;
      }
      const app = getApp();
      const navButton = document.querySelector(`#${NAV_ID} .stash-xw-nav-button`);
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
      console.error("[X Wall] render failed", error);
    }
  }

  function registerPluginRoute() {
    const api = window.PluginApi;
    if (!api || !api.React || !api.register || !api.register.route || window.__stashXWallRouteRegistered) return;
    window.__stashXWallRouteRegistered = true;
    state.routeRegistered = true;
    const React = api.React;
    function XWallPage() {
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
    api.register.route(ROUTE, XWallPage);
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
  window.addEventListener("stash-x-wall-route", render);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
