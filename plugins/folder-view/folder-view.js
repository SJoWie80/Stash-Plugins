(function () {
  "use strict";

  const ROUTE = "/plugin/folder-view";
  const NAV_ID = "stash-folder-view-nav";
  const LAUNCHER_ID = "stash-folder-view-launcher";
  const APP_ID = "stash-folder-view-root";
  const PAGE_SIZE = 250;

  const state = {
    type: "scenes",
    items: [],
    folders: [],
    selectedFolder: "",
    search: "",
    loading: false,
    error: "",
    loaded: {
      scenes: false,
      galleries: false,
    },
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = text;
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function isRoute() {
    return window.location.pathname.replace(/\/$/, "") === ROUTE;
  }

  function notifyRouteChange() {
    window.dispatchEvent(new Event("stash-folder-view-route"));
  }

  function patchHistory() {
    if (window.__stashFolderViewHistoryPatched) {
      return;
    }
    window.__stashFolderViewHistoryPatched = true;

    ["pushState", "replaceState"].forEach((method) => {
      const original = window.history[method];
      window.history[method] = function patchedHistoryState() {
        const result = original.apply(this, arguments);
        window.setTimeout(notifyRouteChange, 0);
        return result;
      };
    });

    document.addEventListener("click", () => window.setTimeout(notifyRouteChange, 0), true);
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

  function navigate(event) {
    if (event) {
      event.preventDefault();
    }
    window.history.pushState({}, "", ROUTE);
    notifyRouteChange();
    render();
  }

  function addNav() {
    try {
      if (document.getElementById(NAV_ID)) {
        removeLauncher();
        return;
      }

      const nav = findNav();
      if (!nav) {
        return;
      }

      const wrap = el("div", "stash-fv-nav-wrap");
      wrap.id = NAV_ID;
      const button = el("button", "btn btn-secondary stash-fv-nav-button");
      button.type = "button";
      button.setAttribute("aria-label", "Folder View");
      button.appendChild(el("span", "stash-fv-nav-icon", "Folder View"));
      button.addEventListener("click", navigate);
      wrap.appendChild(button);
      nav.appendChild(wrap);
      removeLauncher();
    } catch (error) {
      console.error("[Folder View] failed adding nav", error);
    }
  }

  function removeLauncher() {
    const launcher = document.getElementById(LAUNCHER_ID);
    if (launcher) {
      launcher.remove();
    }
  }

  function addLauncher() {
    if (document.getElementById(NAV_ID) || document.getElementById(LAUNCHER_ID)) {
      return;
    }

    const launcher = el("button", "stash-fv-launcher", "Folder View");
    launcher.id = LAUNCHER_ID;
    launcher.type = "button";
    launcher.setAttribute("aria-label", "Open Folder View");
    launcher.addEventListener("click", navigate);
    document.body.appendChild(launcher);
  }

  function getApp() {
    let app = document.getElementById(APP_ID);
    if (!app) {
      app = el("main", "stash-fv-app");
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

  function folderFromFile(file) {
    const parent = file && file.parent_folder;
    if (parent && parent.path) {
      return {
        path: parent.path,
        name: parent.basename || basename(parent.path),
      };
    }
    const path = file && file.path;
    if (!path) {
      return { path: "Unknown folder", name: "Unknown folder" };
    }
    const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    const folderPath = index >= 0 ? path.slice(0, index) : "Unknown folder";
    return {
      path: folderPath,
      name: basename(folderPath),
    };
  }

  function basename(path) {
    if (!path) {
      return "";
    }
    const cleaned = path.replace(/[\\/]+$/, "");
    const index = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
    return index >= 0 ? cleaned.slice(index + 1) : cleaned;
  }

  function itemTitle(item) {
    if (!item) {
      return "";
    }
    const firstFile = item.files && item.files[0];
    return item.title || (firstFile && firstFile.basename) || `Untitled ${state.type === "scenes" ? "scene" : "gallery"}`;
  }

  function itemPath(item) {
    const firstFile = item.files && item.files[0];
    return firstFile && firstFile.path ? firstFile.path : "";
  }

  function groupItems(items) {
    const folders = new Map();
    items.forEach((item) => {
      const firstFile = item.files && item.files[0];
      const folder = folderFromFile(firstFile);
      if (!folders.has(folder.path)) {
        folders.set(folder.path, {
          path: folder.path,
          name: folder.name,
          items: [],
        });
      }
      folders.get(folder.path).items.push(item);
    });

    return Array.from(folders.values()).sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" }));
  }

  function refreshFolders() {
    state.folders = groupItems(state.items);
    if (!state.selectedFolder || !state.folders.some((folder) => folder.path === state.selectedFolder)) {
      state.selectedFolder = state.folders[0] ? state.folders[0].path : "";
    }
  }

  async function loadScenes() {
    const query = `
      query FolderViewScenes($filter: FindFilterType) {
        findScenes(filter: $filter) {
          count
          scenes {
            id
            title
            date
            paths { screenshot }
            files {
              id
              path
              basename
              parent_folder { path basename }
            }
          }
        }
      }
    `;
    const data = await graphql(query, {
      filter: {
        page: 1,
        per_page: PAGE_SIZE,
        sort: "path",
        direction: "ASC",
      },
    });
    return data.findScenes.scenes || [];
  }

  async function loadGalleries() {
    const query = `
      query FolderViewGalleries($filter: FindFilterType) {
        findGalleries(filter: $filter) {
          count
          galleries {
            id
            title
            date
            image_count
            paths { cover }
            files {
              id
              path
              basename
              parent_folder { path basename }
            }
          }
        }
      }
    `;
    const data = await graphql(query, {
      filter: {
        page: 1,
        per_page: PAGE_SIZE,
        sort: "path",
        direction: "ASC",
      },
    });
    return data.findGalleries.galleries || [];
  }

  async function loadCurrentType(force) {
    if (state.loaded[state.type] && !force) {
      return;
    }

    state.loading = true;
    state.error = "";
    render();

    try {
      state.items = state.type === "scenes" ? await loadScenes() : await loadGalleries();
      state.loaded[state.type] = true;
      refreshFolders();
    } catch (error) {
      state.error = error.message || String(error);
      state.items = [];
      state.folders = [];
      state.selectedFolder = "";
      console.error("[Folder View] load failed", error);
    } finally {
      state.loading = false;
      render();
    }
  }

  function setType(type) {
    if (state.type === type) {
      return;
    }
    state.type = type;
    state.items = [];
    state.folders = [];
    state.selectedFolder = "";
    state.search = "";
    loadCurrentType(false);
  }

  function openItem(item) {
    const prefix = state.type === "scenes" ? "/scenes/" : "/galleries/";
    window.history.pushState({}, "", `${prefix}${item.id}`);
    notifyRouteChange();
  }

  function visibleFolders() {
    const term = state.search.trim().toLowerCase();
    if (!term) {
      return state.folders;
    }
    return state.folders
      .map((folder) => {
        const items = folder.items.filter((item) => {
          return `${itemTitle(item)} ${itemPath(item)} ${folder.path}`.toLowerCase().includes(term);
        });
        return Object.assign({}, folder, { items });
      })
      .filter((folder) => folder.items.length || folder.path.toLowerCase().includes(term));
  }

  function renderToolbar(parent) {
    const toolbar = el("div", "stash-fv-toolbar");

    const tabs = el("div", "stash-fv-tabs");
    [
      ["scenes", "Scenes"],
      ["galleries", "Galleries"],
    ].forEach(([type, label]) => {
      const button = el("button", "stash-fv-tab", label);
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.type === type));
      button.addEventListener("click", () => setType(type));
      tabs.appendChild(button);
    });

    const search = el("input", "stash-fv-search");
    search.type = "search";
    search.placeholder = "Search folders or titles";
    search.value = state.search;
    search.addEventListener("input", () => {
      state.search = search.value;
      render();
    });

    const refresh = el("button", "stash-fv-refresh", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", () => loadCurrentType(true));

    toolbar.append(tabs, search, refresh);
    parent.appendChild(toolbar);
  }

  function renderFolders(parent) {
    const folders = visibleFolders();
    const aside = el("aside", "stash-fv-folders");

    folders.forEach((folder) => {
      const button = el("button", "stash-fv-folder");
      button.type = "button";
      button.setAttribute("aria-pressed", String(folder.path === state.selectedFolder));
      button.title = folder.path;
      button.addEventListener("click", () => {
        state.selectedFolder = folder.path;
        render();
      });

      button.appendChild(el("span", "stash-fv-folder-name", folder.name || folder.path));
      button.appendChild(el("span", "stash-fv-folder-count", String(folder.items.length)));
      aside.appendChild(button);
    });

    parent.appendChild(aside);
  }

  function renderItems(parent) {
    const folders = visibleFolders();
    const folder = folders.find((entry) => entry.path === state.selectedFolder) || folders[0];
    const section = el("section", "stash-fv-items");

    if (!folder) {
      section.appendChild(el("div", "stash-fv-empty", "No folders found"));
      parent.appendChild(section);
      return;
    }

    const heading = el("div", "stash-fv-heading");
    const title = el("h2", "", folder.name || folder.path);
    const path = el("div", "stash-fv-path", folder.path);
    heading.append(title, path);
    section.appendChild(heading);

    const grid = el("div", "stash-fv-grid");
    folder.items.forEach((item) => {
      const card = el("button", "stash-fv-card");
      card.type = "button";
      card.addEventListener("click", () => openItem(item));

      const imageUrl = state.type === "scenes" ? item.paths && item.paths.screenshot : item.paths && item.paths.cover;
      if (imageUrl) {
        const img = el("img", "stash-fv-thumb");
        img.src = imageUrl;
        img.alt = itemTitle(item);
        img.loading = "lazy";
        card.appendChild(img);
      } else {
        card.appendChild(el("div", "stash-fv-thumb stash-fv-thumb-empty", "No preview"));
      }

      const body = el("span", "stash-fv-card-body");
      body.appendChild(el("span", "stash-fv-card-title", itemTitle(item)));
      const metaText = state.type === "galleries" ? `${item.image_count || 0} images` : item.date || "";
      if (metaText) {
        body.appendChild(el("span", "stash-fv-card-meta", metaText));
      }
      card.appendChild(body);
      grid.appendChild(card);
    });

    section.appendChild(grid);
    parent.appendChild(section);
  }

  function render() {
    try {
      const app = getApp();
      const navButton = document.querySelector(`#${NAV_ID} .stash-fv-nav-button`);
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
        app.hidden = true;
        return;
      }

      app.hidden = false;
      clear(app);

      const shell = el("section", "stash-fv-shell");
      const header = el("div", "stash-fv-titlebar");
      header.appendChild(el("h1", "", "Folder View"));
      header.appendChild(el("p", "", "Browse your Stash library by filesystem folder."));
      shell.appendChild(header);
      renderToolbar(shell);

      if (state.error) {
        shell.appendChild(el("div", "stash-fv-error", state.error));
      }

      if (state.loading) {
        shell.appendChild(el("div", "stash-fv-empty", "Loading folders..."));
      } else {
        const content = el("div", "stash-fv-content");
        renderFolders(content);
        renderItems(content);
        shell.appendChild(content);
      }

      app.appendChild(shell);
      if (!state.loaded[state.type] && !state.loading && !state.error) {
        loadCurrentType(false);
      }
    } catch (error) {
      console.error("[Folder View] render failed", error);
    }
  }

  function install() {
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
  window.addEventListener("stash-folder-view-route", render);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
