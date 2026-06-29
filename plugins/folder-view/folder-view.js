(function () {
  "use strict";

  const HASH_ROUTE = "#/folder-view";
  const NAV_ID = "stash-folder-view-nav";
  const LAUNCHER_ID = "stash-folder-view-launcher";
  const APP_ID = "stash-folder-view-root";
  const PAGE_SIZE = 200;
  const MAX_PAGES = 100;
  const TYPES = {
    scenes: { label: "Scenes", listKey: "scenes", resultKey: "findScenes", route: "/scenes/" },
    galleries: { label: "Galleries", listKey: "galleries", resultKey: "findGalleries", route: "/galleries/" },
    images: { label: "Images", listKey: "images", resultKey: "findImages", route: "/images/" },
  };

  const state = {
    type: "scenes",
    roots: [],
    itemsByType: { scenes: [], galleries: [], images: [] },
    treesByType: { scenes: null, galleries: null, images: null },
    selectedPathByType: { scenes: "", galleries: "", images: "" },
    expanded: {},
    search: "",
    loading: false,
    error: "",
    status: "",
    loaded: { scenes: false, galleries: false, images: false },
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

  function normalizePath(path) {
    return String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function basename(path) {
    const normalized = normalizePath(path);
    const index = normalized.lastIndexOf("/");
    return index >= 0 ? normalized.slice(index + 1) : normalized;
  }

  function isRoute() {
    return window.location.hash === HASH_ROUTE;
  }

  function notifyRouteChange() {
    window.dispatchEvent(new Event("stash-folder-view-route"));
  }

  function patchHistory() {
    if (window.__stashFolderViewHistoryPatched) return;
    window.__stashFolderViewHistoryPatched = true;
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
    window.history.pushState({}, "", `/${HASH_ROUTE}`);
    notifyRouteChange();
    render();
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
      const wrap = el("div", "stash-fv-nav-wrap");
      wrap.id = NAV_ID;
      const button = el("button", "btn btn-secondary stash-fv-nav-button", "Folder View");
      button.type = "button";
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
    if (launcher) launcher.remove();
  }

  function addLauncher() {
    if (document.getElementById(NAV_ID) || document.getElementById(LAUNCHER_ID)) return;
    const launcher = el("button", "stash-fv-launcher", "Folder View");
    launcher.id = LAUNCHER_ID;
    launcher.type = "button";
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

  async function loadRoots() {
    if (state.roots.length) return state.roots;
    const data = await graphql(
      "query FolderViewConfig { configuration { general { stashes { path excludeVideo excludeImage } } } }",
      {}
    );
    state.roots = (((data.configuration || {}).general || {}).stashes || []).map((stash) => ({
      path: normalizePath(stash.path),
      name: basename(stash.path) || stash.path,
      excludeVideo: Boolean(stash.excludeVideo),
      excludeImage: Boolean(stash.excludeImage),
    }));
    return state.roots;
  }

  async function loadPaged(query, resultKey, listKey) {
    const allItems = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      state.status = `Loading ${TYPES[state.type].label.toLowerCase()} page ${page}...`;
      render();
      const data = await graphql(query, { filter: { page, per_page: PAGE_SIZE } });
      const result = data && data[resultKey];
      const items = (result && result[listKey]) || [];
      total = result && typeof result.count === "number" ? result.count : allItems.length + items.length;
      allItems.push(...items);
      if (!items.length || allItems.length >= total || items.length < PAGE_SIZE) break;
    }
    return { items: allItems, total };
  }

  function firstFile(item) {
    const files = state.type === "images" ? item.visual_files || item.files : item.files;
    return files && files[0];
  }

  function filePath(item) {
    const file = firstFile(item);
    return normalizePath(file && file.path);
  }

  function folderPath(item) {
    const file = firstFile(item);
    const parent = file && file.parent_folder && file.parent_folder.path;
    if (parent) return normalizePath(parent);
    const path = filePath(item);
    const index = path.lastIndexOf("/");
    return index >= 0 ? path.slice(0, index) : "Unknown folder";
  }

  function matchingRoot(path) {
    const normalized = normalizePath(path).toLowerCase();
    const roots = state.roots
      .filter((root) => {
        if (state.type === "scenes") return !root.excludeVideo;
        return !root.excludeImage;
      })
      .sort((a, b) => b.path.length - a.path.length);
    return roots.find((root) => normalized === root.path.toLowerCase() || normalized.startsWith(`${root.path.toLowerCase()}/`));
  }

  function createNode(path, name, parent) {
    return { path, name, parent, children: new Map(), items: [], total: 0, depth: parent ? parent.depth + 1 : 0 };
  }

  function ensureChild(parent, path, name) {
    if (!parent.children.has(path)) parent.children.set(path, createNode(path, name, parent));
    return parent.children.get(path);
  }

  function buildTree(items) {
    const root = createNode("", "Library", null);
    const rootsForType = state.roots.filter((stashRoot) => (state.type === "scenes" ? !stashRoot.excludeVideo : !stashRoot.excludeImage));

    rootsForType.forEach((stashRoot) => {
      ensureChild(root, stashRoot.path, stashRoot.name || stashRoot.path);
    });

    items.forEach((item) => {
      const folder = folderPath(item);
      const stashRoot = matchingRoot(folder);
      const rootPath = stashRoot ? stashRoot.path : "__other__";
      const rootName = stashRoot ? stashRoot.name || stashRoot.path : "Other";
      let node = ensureChild(root, rootPath, rootName);
      const relative = stashRoot ? normalizePath(folder).slice(stashRoot.path.length).replace(/^\/+/, "") : normalizePath(folder);
      const parts = relative ? relative.split("/").filter(Boolean) : [];
      let currentPath = rootPath;
      parts.forEach((part) => {
        currentPath = currentPath === "__other__" ? `${currentPath}/${part}` : `${currentPath}/${part}`;
        node = ensureChild(node, currentPath, part);
      });
      node.items.push(item);
    });

    updateTotals(root);
    return root;
  }

  function updateTotals(node) {
    let total = node.items.length;
    node.children.forEach((child) => {
      total += updateTotals(child);
    });
    node.total = total;
    return total;
  }

  function flatNodes(node, output) {
    Array.from(node.children.values())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      .forEach((child) => {
        output.push(child);
        if (state.expanded[child.path]) flatNodes(child, output);
      });
    return output;
  }

  function findNode(node, path) {
    if (!node) return null;
    if (node.path === path) return node;
    for (const child of node.children.values()) {
      const found = findNode(child, path);
      if (found) return found;
    }
    return null;
  }

  function selectFirstUsableNode(tree) {
    const nodes = flatNodes(tree, []);
    const selected = nodes.find((node) => node.total > 0);
    if (selected) {
      state.selectedPathByType[state.type] = selected.path;
      expandParents(selected);
    }
  }

  function expandParents(node) {
    let current = node;
    while (current && current.parent) {
      state.expanded[current.path] = true;
      current = current.parent;
    }
  }

  function itemTitle(item) {
    const file = firstFile(item);
    return item.title || (file && file.basename) || `Untitled ${TYPES[state.type].label.slice(0, -1).toLowerCase()}`;
  }

  function relationNames(list) {
    return (list || []).map((entry) => entry.name || entry.title).filter(Boolean).slice(0, 4);
  }

  function itemMatchesSearch(item, folderNode) {
    const term = state.search.trim().toLowerCase();
    if (!term) return true;
    const text = [
      itemTitle(item),
      filePath(item),
      folderNode && folderNode.path,
      item.studio && item.studio.name,
      ...relationNames(item.performers),
      ...relationNames(item.tags),
      ...relationNames(item.galleries),
      ...relationNames(item.scenes),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return text.includes(term);
  }

  function itemsForNode(node) {
    if (!node) return [];
    const items = [];
    function collect(current) {
      current.items.forEach((item) => {
        if (itemMatchesSearch(item, node)) items.push(item);
      });
      current.children.forEach(collect);
    }
    collect(node);
    return items.sort((a, b) => itemTitle(a).localeCompare(itemTitle(b), undefined, { sensitivity: "base" }));
  }

  async function loadScenes() {
    return loadPaged(
      `query FolderViewScenes($filter: FindFilterType) {
        findScenes(filter: $filter) {
          count
          scenes {
            id title date
            paths { screenshot }
            files { id path basename parent_folder { path basename } }
            studio { name }
            performers { name }
            tags { name }
            galleries { title }
          }
        }
      }`,
      "findScenes",
      "scenes"
    );
  }

  async function loadGalleries() {
    return loadPaged(
      `query FolderViewGalleries($filter: FindFilterType) {
        findGalleries(filter: $filter) {
          count
          galleries {
            id title date image_count
            paths { cover }
            files { id path basename parent_folder { path basename } }
            studio { name }
            performers { name }
            tags { name }
            scenes { title }
          }
        }
      }`,
      "findGalleries",
      "galleries"
    );
  }

  async function loadImages() {
    const visualQuery = `query FolderViewImages($filter: FindFilterType) {
        findImages(filter: $filter) {
          count
          images {
            id title date
            paths { thumbnail preview image }
            visual_files {
              ... on ImageFile { id path basename parent_folder { path basename } }
              ... on VideoFile { id path basename parent_folder { path basename } }
            }
            studio { name }
            performers { name }
            tags { name }
            galleries { title }
          }
        }
      }`;
    const legacyQuery = `query FolderViewImagesLegacy($filter: FindFilterType) {
        findImages(filter: $filter) {
          count
          images {
            id title date
            paths { thumbnail preview image }
            files { id path basename parent_folder { path basename } }
            studio { name }
            performers { name }
            tags { name }
            galleries { title }
          }
        }
      }`;
    try {
      return await loadPaged(visualQuery, "findImages", "images");
    } catch (error) {
      console.warn("[Folder View] visual_files image query failed, falling back to files", error);
      return loadPaged(legacyQuery, "findImages", "images");
    }
  }

  async function loadCurrentType(force) {
    if (state.loaded[state.type] && !force) return;
    state.loading = true;
    state.error = "";
    state.status = `Loading ${TYPES[state.type].label.toLowerCase()}...`;
    render();
    try {
      await loadRoots();
      const result = state.type === "scenes" ? await loadScenes() : state.type === "galleries" ? await loadGalleries() : await loadImages();
      state.itemsByType[state.type] = result.items;
      state.treesByType[state.type] = buildTree(result.items);
      state.loaded[state.type] = true;
      if (!state.selectedPathByType[state.type]) selectFirstUsableNode(state.treesByType[state.type]);
      state.status = `${result.items.length} ${TYPES[state.type].label.toLowerCase()} in ${countFolders(state.treesByType[state.type])} folders`;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
      console.error("[Folder View] load failed", error);
    } finally {
      state.loading = false;
      render();
    }
  }

  function countFolders(root) {
    return flatNodes(root, []).filter((node) => node.total > 0).length;
  }

  function setType(type) {
    if (state.type === type) return;
    state.type = type;
    state.search = "";
    loadCurrentType(false);
    render();
  }

  function openItem(item) {
    window.history.pushState({}, "", `${TYPES[state.type].route}${item.id}`);
    notifyRouteChange();
  }

  function renderToolbar(parent) {
    const toolbar = el("div", "stash-fv-toolbar");
    const tabs = el("div", "stash-fv-tabs");
    Object.entries(TYPES).forEach(([type, config]) => {
      const button = el("button", "stash-fv-tab", config.label);
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.type === type));
      button.addEventListener("click", () => setType(type));
      tabs.appendChild(button);
    });
    const search = el("input", "stash-fv-search");
    search.type = "search";
    search.placeholder = "Search folders, titles, performers, tags";
    search.value = state.search;
    search.addEventListener("input", () => {
      state.search = search.value;
      render();
    });
    const refresh = el("button", "stash-fv-refresh", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", () => {
      state.loaded[state.type] = false;
      loadCurrentType(true);
    });
    toolbar.append(tabs, search, refresh);
    parent.appendChild(toolbar);
  }

  function renderTree(parent) {
    const tree = state.treesByType[state.type];
    const aside = el("aside", "stash-fv-tree");
    if (!tree) {
      aside.appendChild(el("div", "stash-fv-empty", "No folder tree loaded"));
      parent.appendChild(aside);
      return;
    }
    flatNodes(tree, []).forEach((node) => {
      if (!node.total) return;
      const row = el("div", "stash-fv-tree-row");
      row.style.setProperty("--depth", String(Math.max(0, node.depth - 1)));
      const toggle = el("button", "stash-fv-tree-toggle", node.children.size ? (state.expanded[node.path] ? "-" : "+") : "");
      toggle.type = "button";
      toggle.disabled = !node.children.size;
      toggle.addEventListener("click", () => {
        state.expanded[node.path] = !state.expanded[node.path];
        render();
      });
      const folder = el("button", "stash-fv-tree-folder");
      folder.type = "button";
      folder.title = node.path;
      folder.setAttribute("aria-pressed", String(state.selectedPathByType[state.type] === node.path));
      folder.addEventListener("click", () => {
        state.selectedPathByType[state.type] = node.path;
        expandParents(node);
        render();
      });
      folder.appendChild(el("span", "stash-fv-folder-name", node.name));
      folder.appendChild(el("span", "stash-fv-folder-count", String(node.total)));
      row.append(toggle, folder);
      aside.appendChild(row);
    });
    parent.appendChild(aside);
  }

  function renderMeta(parent, item) {
    const meta = el("div", "stash-fv-meta");
    const bits = [];
    if (item.studio && item.studio.name) bits.push(item.studio.name);
    relationNames(item.performers).forEach((name) => bits.push(name));
    relationNames(item.tags).forEach((name) => bits.push(`#${name}`));
    if (state.type === "galleries") bits.push(`${item.image_count || 0} images`);
    if (item.date) bits.push(item.date);
    bits.slice(0, 7).forEach((bit) => meta.appendChild(el("span", "stash-fv-chip", bit)));
    if (bits.length) parent.appendChild(meta);
  }

  function previewUrl(item) {
    if (state.type === "scenes") return item.paths && item.paths.screenshot;
    if (state.type === "galleries") return item.paths && item.paths.cover;
    return item.paths && (item.paths.thumbnail || item.paths.preview || item.paths.image);
  }

  function renderItems(parent) {
    const tree = state.treesByType[state.type];
    const selected = findNode(tree, state.selectedPathByType[state.type]) || (tree && flatNodes(tree, []).find((node) => node.total));
    const section = el("section", "stash-fv-items");
    if (!selected) {
      section.appendChild(el("div", "stash-fv-empty", "No folders found"));
      parent.appendChild(section);
      return;
    }
    const items = itemsForNode(selected);
    const heading = el("div", "stash-fv-heading");
    heading.appendChild(el("h2", "", selected.name));
    heading.appendChild(el("div", "stash-fv-path", selected.path));
    heading.appendChild(el("div", "stash-fv-subtle", `${items.length} visible items including subfolders`));
    section.appendChild(heading);
    const grid = el("div", "stash-fv-grid");
    items.forEach((item) => {
      const card = el("button", "stash-fv-card");
      card.type = "button";
      card.title = filePath(item);
      card.addEventListener("click", () => openItem(item));
      const imageUrl = previewUrl(item);
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
      body.appendChild(el("span", "stash-fv-card-path", basename(filePath(item))));
      renderMeta(body, item);
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
      if (navButton) navButton.classList.toggle("active", isRoute());
      if (!isRoute()) {
        app.hidden = true;
        return;
      }
      app.hidden = false;
      clear(app);
      const shell = el("section", "stash-fv-shell");
      const header = el("div", "stash-fv-titlebar");
      header.appendChild(el("h1", "", "Folder View"));
      header.appendChild(el("p", "", "Browse Stash objects by your real library folders."));
      shell.appendChild(header);
      renderToolbar(shell);
      if (state.error) shell.appendChild(el("div", "stash-fv-error", state.error));
      if (state.status) shell.appendChild(el("div", "stash-fv-status", state.status));
      if (state.loading) {
        shell.appendChild(el("div", "stash-fv-empty", "Loading folder tree..."));
      } else {
        const content = el("div", "stash-fv-content");
        renderTree(content);
        renderItems(content);
        shell.appendChild(content);
      }
      app.appendChild(shell);
      if (!state.loaded[state.type] && !state.loading && !state.error) loadCurrentType(false);
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
  window.addEventListener("hashchange", render);
  window.addEventListener("stash-folder-view-route", render);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
