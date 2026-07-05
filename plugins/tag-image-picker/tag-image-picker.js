(function () {
  "use strict";

  const ROUTE = "/tag-image-picker";
  const NAV_ID = "stash-tip-nav";
  const LAUNCHER_ID = "stash-tip-launcher";
  const APP_ID = "stash-tip-root";
  const PAGE_SIZE = 250;
  const MAX_PAGES = 80;

  const state = {
    pluginId: "",
    tags: [],
    selectedTagId: "",
    candidates: [],
    selectedCandidate: null,
    loadingTags: false,
    searching: false,
    saving: false,
    loaded: false,
    error: "",
    status: "",
    search: "",
    onlyMissing: true,
    provider: "wikimedia",
    resultLimit: 12,
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
    window.dispatchEvent(new Event("stash-tag-image-picker-route"));
  }

  function patchHistory() {
    if (window.__stashTagImagePickerHistoryPatched) return;
    window.__stashTagImagePickerHistoryPatched = true;
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
      const wrap = el("div", "stash-tip-nav-wrap");
      wrap.id = NAV_ID;
      const link = el("a", "nav-link stash-tip-nav-button");
      link.href = ROUTE;
      link.setAttribute("aria-label", "Tag Images");
      link.appendChild(el("span", "fa fa-image fas fa-image stash-tip-nav-icon"));
      link.appendChild(el("span", "stash-tip-nav-text", "Tag Images"));
      link.addEventListener("click", navigate);
      wrap.appendChild(link);
      nav.appendChild(wrap);
      removeLauncher();
    } catch (error) {
      console.error("[Tag Image Picker] failed adding nav", error);
    }
  }

  function removeLauncher() {
    const launcher = document.getElementById(LAUNCHER_ID);
    if (launcher) launcher.remove();
  }

  function addLauncher() {
    if (document.getElementById(NAV_ID) || document.getElementById(LAUNCHER_ID)) return;
    const launcher = el("button", "stash-tip-launcher", "Tag Images");
    launcher.id = LAUNCHER_ID;
    launcher.type = "button";
    launcher.addEventListener("click", navigate);
    document.body.appendChild(launcher);
  }

  function getApp() {
    let app = document.getElementById(APP_ID);
    if (!app) {
      app = el("main", "stash-tip-app");
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
    if (state.pluginId) return state.pluginId;
    const data = await graphql("query TagImagePickerPluginId { plugins { id name } }", {});
    const plugin = ((data && data.plugins) || []).find((item) => item && item.name === "Tag Image Picker");
    if (!plugin || !plugin.id) throw new Error("Tag Image Picker plugin ID kon niet worden gevonden");
    state.pluginId = plugin.id;
    return state.pluginId;
  }

  async function pluginOperation(args) {
    const pluginId = await getPluginId();
    const data = await graphql(
      "mutation TagImagePickerOperation($pluginId: ID!, $args: Map) { runPluginOperation(plugin_id: $pluginId, args: $args) }",
      { pluginId, args }
    );
    const result = data && data.runPluginOperation;
    const output = result && (result.output || result.result || result);
    return typeof output === "string" ? JSON.parse(output) : output;
  }

  async function loadTags(force) {
    if (state.loaded && !force) return;
    state.loadingTags = true;
    state.error = "";
    state.status = "Loading tags...";
    render();
    try {
      const all = await loadTagsPaged(true);
      state.tags = all;
      state.loaded = true;
      if (!state.selectedTagId && filteredTags().length) state.selectedTagId = filteredTags()[0].id;
      state.status = `${all.length} tags loaded`;
    } catch (fullError) {
      try {
        console.warn("[Tag Image Picker] full tag query failed, trying basic query", fullError);
        const all = await loadTagsPaged(false);
        state.tags = all;
        state.loaded = true;
        if (!state.selectedTagId && filteredTags().length) state.selectedTagId = filteredTags()[0].id;
        state.status = `${all.length} tags loaded`;
      } catch (error) {
        state.error = error.message || String(error);
        state.status = "";
        console.error("[Tag Image Picker] load tags failed", error);
      }
    } finally {
      state.loadingTags = false;
      render();
    }
  }

  async function loadTagsPaged(includeCounts) {
    const all = [];
      let total = 0;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        state.status = `Loading tags page ${page}...`;
        render();
        const data = await graphql(
          includeCounts
            ? `query TagImagePickerTags($filter: FindFilterType) {
            findTags(filter: $filter) {
              count
              tags {
                id
                name
                image_path
                scene_count
                scene_marker_count
                image_count
              }
            }
          }`
            : `query TagImagePickerTagsBasic($filter: FindFilterType) {
            findTags(filter: $filter) {
              count
              tags {
                id
                name
                image_path
              }
            }
          }`,
          { filter: { page, per_page: PAGE_SIZE, sort: "name", direction: "ASC" } }
        );
        const result = data && data.findTags;
        const tags = (result && result.tags) || [];
        total = result && typeof result.count === "number" ? result.count : all.length + tags.length;
        all.push(...tags);
        if (!tags.length || all.length >= total || tags.length < PAGE_SIZE) break;
      }
    return all;
  }

  function selectedTag() {
    return state.tags.find((tag) => tag.id === state.selectedTagId) || null;
  }

  function tagUsage(tag) {
    return Number(tag.scene_count || 0) + Number(tag.scene_marker_count || 0) + Number(tag.image_count || 0);
  }

  function filteredTags() {
    const term = state.search.trim().toLowerCase();
    return state.tags
      .filter((tag) => !state.onlyMissing || !tag.image_path)
      .filter((tag) => !term || String(tag.name || "").toLowerCase().includes(term))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  async function searchImages() {
    const tag = selectedTag();
    if (!tag) return;
    state.searching = true;
    state.error = "";
    state.status = `Searching images for ${tag.name}...`;
    state.candidates = [];
    state.selectedCandidate = null;
    render();
    try {
      const output = await pluginOperation({
        action: "search",
        query: tag.name,
        provider: state.provider,
        limit: state.resultLimit,
      });
      state.candidates = (output && output.results) || [];
      state.status = `${state.candidates.length} candidates for ${tag.name}`;
      if (output && output.errors && output.errors.length) {
        state.status += `; ${output.errors.length} provider warning${output.errors.length === 1 ? "" : "s"}`;
      }
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
      console.error("[Tag Image Picker] search failed", error);
    } finally {
      state.searching = false;
      render();
    }
  }

  async function saveSelected() {
    const tag = selectedTag();
    const candidate = state.selectedCandidate;
    if (!tag || !candidate) return;
    state.saving = true;
    state.error = "";
    state.status = `Saving image for ${tag.name}...`;
    render();
    try {
      const data = await graphql(
        `mutation TagImagePickerUpdate($id: ID!, $image: String!) {
          tagUpdate(input: { id: $id, image: $image }) {
            id
            name
            image_path
          }
        }`,
        { id: tag.id, image: candidate.imageUrl }
      );
      const updated = data && data.tagUpdate;
      tag.image_path = (updated && updated.image_path) || candidate.imageUrl;
      state.status = `Saved image for ${tag.name}`;
      state.selectedCandidate = null;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
      console.error("[Tag Image Picker] save failed", error);
    } finally {
      state.saving = false;
      render();
    }
  }

  function renderToolbar(parent) {
    const toolbar = el("div", "stash-tip-toolbar");
    const search = el("input", "stash-tip-search");
    search.type = "search";
    search.placeholder = "Search tags";
    search.value = state.search;
    search.addEventListener("input", () => {
      state.search = search.value;
      const visible = filteredTags();
      if (!visible.some((tag) => tag.id === state.selectedTagId)) {
        state.selectedTagId = visible[0] ? visible[0].id : "";
        state.candidates = [];
        state.selectedCandidate = null;
      }
      render();
    });

    const missing = el("label", "stash-tip-check");
    const missingInput = el("input", "");
    missingInput.type = "checkbox";
    missingInput.checked = state.onlyMissing;
    missingInput.addEventListener("change", () => {
      state.onlyMissing = missingInput.checked;
      const visible = filteredTags();
      if (!visible.some((tag) => tag.id === state.selectedTagId)) state.selectedTagId = visible[0] ? visible[0].id : "";
      render();
    });
    missing.append(missingInput, el("span", "", "Missing only"));

    const refresh = el("button", "stash-tip-button", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", () => loadTags(true));
    toolbar.append(search, missing, refresh);
    parent.appendChild(toolbar);
  }

  function renderOptions(parent) {
    const options = el("div", "stash-tip-options");
    const provider = el("select", "stash-tip-select");
    [
      ["wikimedia", "Wikimedia"],
      ["duckduckgo", "DuckDuckGo"],
      ["all", "Both"],
    ].forEach(([value, label]) => {
      const option = el("option", "", label);
      option.value = value;
      option.selected = value === state.provider;
      provider.appendChild(option);
    });
    provider.addEventListener("change", () => {
      state.provider = provider.value;
    });

    const limit = el("select", "stash-tip-select");
    [8, 12, 20, 32].forEach((value) => {
      const option = el("option", "", `${value} photos`);
      option.value = String(value);
      option.selected = value === state.resultLimit;
      limit.appendChild(option);
    });
    limit.addEventListener("change", () => {
      state.resultLimit = Number(limit.value) || 12;
    });

    const search = el("button", "stash-tip-button primary", state.searching ? "Searching..." : "Find photos");
    search.type = "button";
    search.disabled = state.searching || !selectedTag();
    search.addEventListener("click", searchImages);
    const save = el("button", "stash-tip-button save", state.saving ? "Saving..." : "Use selected");
    save.type = "button";
    save.disabled = state.saving || !state.selectedCandidate;
    save.addEventListener("click", saveSelected);
    options.append(provider, limit, search, save);
    parent.appendChild(options);
  }

  function renderTags(parent) {
    const list = el("aside", "stash-tip-tags");
    const tags = filteredTags();
    if (!tags.length) {
      list.appendChild(el("div", "stash-tip-empty", "No matching tags"));
      parent.appendChild(list);
      return;
    }
    tags.forEach((tag) => {
      const row = el("button", "stash-tip-tag");
      row.type = "button";
      row.setAttribute("aria-pressed", String(tag.id === state.selectedTagId));
      row.addEventListener("click", () => {
        state.selectedTagId = tag.id;
        state.candidates = [];
        state.selectedCandidate = null;
        render();
      });
      row.appendChild(el("span", "stash-tip-tag-name", tag.name));
      const meta = el("span", "stash-tip-tag-meta", tag.image_path ? "image" : `${tagUsage(tag)} uses`);
      row.appendChild(meta);
      list.appendChild(row);
    });
    parent.appendChild(list);
  }

  function renderCandidate(parent, candidate, index) {
    const card = el("button", "stash-tip-candidate");
    card.type = "button";
    card.setAttribute("aria-pressed", String(state.selectedCandidate === candidate));
    card.addEventListener("click", () => {
      state.selectedCandidate = candidate;
      render();
    });
    const img = el("img", "stash-tip-thumb");
    img.src = candidate.thumbData || candidate.thumbUrl || candidate.imageUrl;
    img.alt = candidate.title || `Candidate ${index + 1}`;
    img.loading = "lazy";
    card.appendChild(img);
    const body = el("span", "stash-tip-card-body");
    body.appendChild(el("span", "stash-tip-card-title", candidate.title || `Candidate ${index + 1}`));
    body.appendChild(el("span", "stash-tip-card-provider", candidate.provider || ""));
    card.appendChild(body);
    parent.appendChild(card);
  }

  function renderWork(parent) {
    const section = el("section", "stash-tip-work");
    const tag = selectedTag();
    const heading = el("div", "stash-tip-heading");
    heading.appendChild(el("h2", "", tag ? tag.name : "Select a tag"));
    heading.appendChild(el("div", "stash-tip-subtle", tag ? `${tagUsage(tag)} linked objects` : "Choose a tag from the list"));
    section.appendChild(heading);
    if (tag && tag.image_path) {
      const current = el("div", "stash-tip-current");
      const img = el("img", "");
      img.src = tag.image_path;
      img.alt = tag.name;
      current.append(img, el("span", "", "Current tag image"));
      section.appendChild(current);
    }
    renderOptions(section);
    if (state.searching) section.appendChild(el("div", "stash-tip-empty", "Searching image candidates..."));
    const grid = el("div", "stash-tip-grid");
    state.candidates.forEach((candidate, index) => renderCandidate(grid, candidate, index));
    section.appendChild(grid);
    parent.appendChild(section);
  }

  function renderInto(container) {
    container.className = "stash-tip-app";
    clear(container);
    const shell = el("section", "stash-tip-shell");
    const header = el("div", "stash-tip-titlebar");
    header.appendChild(el("h1", "", "Tag Image Picker"));
    header.appendChild(el("p", "", "Search candidates, pick one, and save it as the tag image."));
    shell.appendChild(header);
    renderToolbar(shell);
    if (state.error) shell.appendChild(el("div", "stash-tip-error", state.error));
    if (state.status) shell.appendChild(el("div", "stash-tip-status", state.status));
    const content = el("div", "stash-tip-content");
    renderTags(content);
    renderWork(content);
    shell.appendChild(content);
    container.appendChild(shell);
    if (!state.loaded && !state.loadingTags && !state.error) loadTags(false);
  }

  function render() {
    try {
      if (state.routeContainer) {
        renderInto(state.routeContainer);
        return;
      }
      const app = getApp();
      const navButton = document.querySelector(`#${NAV_ID} .stash-tip-nav-button`);
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
      console.error("[Tag Image Picker] render failed", error);
    }
  }

  function registerPluginRoute() {
    const api = window.PluginApi;
    if (!api || !api.React || !api.register || !api.register.route || window.__stashTagImagePickerRouteRegistered) return;
    window.__stashTagImagePickerRouteRegistered = true;
    state.routeRegistered = true;
    const React = api.React;
    function TagImagePickerPage() {
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
    api.register.route(ROUTE, TagImagePickerPage);
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
  window.addEventListener("stash-tag-image-picker-route", render);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
