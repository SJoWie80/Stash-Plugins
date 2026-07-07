(function () {
  "use strict";

  const ROUTE = "/funscript-generator";
  const NAV_ID = "stash-fg-nav";
  const LAUNCHER_ID = "stash-fg-launcher";
  const APP_ID = "stash-fg-root";
  const SETTINGS_KEY = "stash-funscript-generator-settings-v1";
  const PAGE_SIZE = 80;

  const state = {
    pluginId: "",
    routeRegistered: false,
    routeContainer: null,
    studios: [],
    scenes: [],
    selectedStudioId: "",
    selected: {},
    loading: false,
    error: "",
    status: "",
    queueState: null,
    settings: loadSettings(),
  };

  function loadSettings() {
    const defaults = {
      workers: 1,
      overwrite: false,
      analysisFps: 6,
      scaleHeight: 360,
      timeoutMinutes: 180,
      mode: "standard",
      queuedTag: "Generate Funscript",
      doneTag: "Generated Funscript",
      failedTag: "Funscript Failed",
      commandTemplate: "",
      onlyWithoutFunscript: true,
    };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return Object.assign(defaults, raw ? JSON.parse(raw) : {});
    } catch (error) {
      return defaults;
    }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function scenePath(scene) {
    const files = scene && scene.files;
    return (files && files[0] && files[0].path) || "";
  }

  function isRoute() {
    return window.location.pathname.replace(/\/$/, "") === ROUTE;
  }

  function notifyRouteChange() {
    window.dispatchEvent(new Event("stash-funscript-generator-route"));
  }

  function patchHistory() {
    if (window.__stashFgHistoryPatched) return;
    window.__stashFgHistoryPatched = true;
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
      const wrap = el("div", "stash-fg-nav-wrap");
      wrap.id = NAV_ID;
      const link = el("a", "nav-link stash-fg-nav-button");
      link.href = ROUTE;
      link.setAttribute("aria-label", "Funscript Generator");
      link.appendChild(el("span", "fa fa-magic fas fa-magic stash-fg-nav-icon"));
      link.appendChild(el("span", "stash-fg-nav-text", "Funscript Generator"));
      link.addEventListener("click", navigate);
      wrap.appendChild(link);
      nav.appendChild(wrap);
      removeLauncher();
    } catch (error) {
      console.error("[Funscript Generator] failed adding nav", error);
    }
  }

  function removeLauncher() {
    const launcher = document.getElementById(LAUNCHER_ID);
    if (launcher) launcher.remove();
  }

  function addLauncher() {
    if (document.getElementById(NAV_ID) || document.getElementById(LAUNCHER_ID)) return;
    const launcher = el("button", "stash-fg-launcher", "Funscript Generator");
    launcher.id = LAUNCHER_ID;
    launcher.type = "button";
    launcher.addEventListener("click", navigate);
    document.body.appendChild(launcher);
  }

  async function graphql(query, variables) {
    const response = await fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const payload = await response.json();
    if (payload.errors && payload.errors.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
    return payload.data;
  }

  async function getPluginId() {
    if (state.pluginId) return state.pluginId;
    const data = await graphql("query FunscriptGeneratorPluginId { plugins { id name } }", {});
    const plugin = ((data && data.plugins) || []).find((item) => item && item.name === "Funscript Generator");
    if (!plugin || !plugin.id) throw new Error("Funscript Generator plugin ID kon niet worden gevonden");
    state.pluginId = plugin.id;
    return state.pluginId;
  }

  async function pluginOperation(args) {
    const pluginId = await getPluginId();
    const data = await graphql(
      "mutation FunscriptGeneratorOperation($pluginId: ID!, $args: Map) { runPluginOperation(plugin_id: $pluginId, args: $args) }",
      { pluginId, args }
    );
    const result = data && data.runPluginOperation;
    const output = result && (result.output || result.result || result);
    return typeof output === "string" ? JSON.parse(output) : output;
  }

  async function ensureTag(name) {
    if (!name) return "";
    const data = await graphql(
      `query FunscriptGeneratorFindTag($filter: FindFilterType) {
        findTags(filter: $filter) { tags { id name } }
      }`,
      { filter: { q: name, per_page: 50 } }
    );
    const existing = ((((data || {}).findTags || {}).tags || [])).find((tag) => (tag.name || "").toLowerCase() === name.toLowerCase());
    if (existing) return existing.id;
    const created = await graphql(
      "mutation FunscriptGeneratorCreateTag($input: TagCreateInput!) { tagCreate(input: $input) { id } }",
      { input: { name } }
    );
    return created.tagCreate.id;
  }

  async function addTagToScene(sceneId, tagName) {
    const tagId = await ensureTag(tagName);
    if (!tagId || !sceneId) return;
    const data = await graphql(
      `query FunscriptGeneratorSceneTags($id: ID!) {
        findScene(id: $id) { id tags { id name } }
      }`,
      { id: sceneId }
    );
    const scene = data && data.findScene;
    if (!scene) return;
    const tagIds = (scene.tags || []).map((tag) => tag.id);
    if (tagIds.includes(tagId)) return;
    await graphql(
      "mutation FunscriptGeneratorTagScene($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }",
      { input: { id: sceneId, tag_ids: tagIds.concat([tagId]) } }
    );
  }

  async function loadStudios() {
    const data = await graphql(
      `query FunscriptGeneratorStudios($filter: FindFilterType) {
        findStudios(filter: $filter) { studios { id name scene_count } }
      }`,
      { filter: { page: 1, per_page: 500, sort: "name", direction: "ASC" } }
    );
    state.studios = (((data || {}).findStudios || {}).studios || []).filter((studio) => studio.scene_count);
  }

  async function loadScenes() {
    state.loading = true;
    state.error = "";
    render();
    try {
      const sceneFilter = {};
      if (state.selectedStudioId) sceneFilter.studios = { value: [state.selectedStudioId], modifier: "INCLUDES" };
      const data = await graphql(
        `query FunscriptGeneratorScenes($filter: FindFilterType, $sceneFilter: SceneFilterType) {
          findScenes(filter: $filter, scene_filter: $sceneFilter) {
            scenes {
              id title
              studio { id name }
              tags { id name }
              files { path basename duration }
            }
          }
        }`,
        { filter: { page: 1, per_page: PAGE_SIZE, sort: "date", direction: "DESC" }, sceneFilter }
      );
      state.scenes = (((data || {}).findScenes || {}).scenes || []).filter((scene) => !!scenePath(scene));
    } catch (error) {
      state.error = error.message || String(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  function selectedScenes() {
    return state.scenes.filter((scene) => state.selected[scene.id]);
  }

  function jobPayload(scene) {
    return {
      sceneId: scene.id,
      title: scene.title || "",
      studio: (scene.studio && scene.studio.name) || "",
      path: scenePath(scene),
      duration: scene.files && scene.files[0] ? scene.files[0].duration : null,
    };
  }

  async function enqueueSelected() {
    saveSettings();
    const scenes = selectedScenes();
    const jobs = scenes.map(jobPayload);
    const output = await pluginOperation({ action: "enqueue", jobs, settings: state.settings });
    await Promise.all(scenes.map((scene) => addTagToScene(scene.id, state.settings.queuedTag).catch(() => {})));
    state.queueState = output;
    state.status = `${output.added || 0} scenes toegevoegd aan queue`;
    render();
  }

  async function startQueue() {
    saveSettings();
    state.queueState = await pluginOperation({ action: "start", settings: state.settings });
    await refreshStatus();
  }

  async function stopQueue() {
    state.queueState = await pluginOperation({ action: "stop" });
    await refreshStatus();
  }

  async function clearQueue(mode) {
    state.queueState = await pluginOperation({ action: "clear", mode });
    await refreshStatus();
  }

  async function refreshStatus() {
    try {
      state.queueState = await pluginOperation({ action: "status" });
      const history = (state.queueState && state.queueState.history) || [];
      history.slice(0, 40).forEach((job) => {
        if (job.status === "done") addTagToScene(job.sceneId, state.settings.doneTag).catch(() => {});
        if (job.status === "failed") addTagToScene(job.sceneId, state.settings.failedTag).catch(() => {});
      });
      render();
    } catch (error) {
      console.warn("[Funscript Generator] status failed", error);
    }
  }

  function field(label, child) {
    const wrap = el("label", "stash-fg-field");
    wrap.appendChild(el("span", "", label));
    wrap.appendChild(child);
    return wrap;
  }

  function input(key, type) {
    const node = el("input");
    node.type = type || "text";
    node.value = state.settings[key] || "";
    node.addEventListener("input", () => {
      state.settings[key] = type === "number" ? Number(node.value) : node.value;
      saveSettings();
    });
    return node;
  }

  function checkbox(label, key) {
    const wrap = el("label", "stash-fg-check");
    const node = el("input");
    node.type = "checkbox";
    node.checked = !!state.settings[key];
    node.addEventListener("change", () => {
      state.settings[key] = node.checked;
      saveSettings();
    });
    wrap.appendChild(node);
    wrap.appendChild(el("span", "", label));
    return wrap;
  }

  function textarea(key) {
    const node = el("textarea");
    node.rows = 4;
    node.value = state.settings[key] || "";
    node.placeholder = "bijv: python /tools/fungen/main.py --cli \"{video}\" --output \"{output}\"";
    node.addEventListener("input", () => {
      state.settings[key] = node.value;
      saveSettings();
    });
    return node;
  }

  function renderSettings(panel) {
    panel.appendChild(checkbox("Bestaande .funscript overschrijven", "overwrite"));
    panel.appendChild(checkbox("Alleen scenes zonder funscript tonen", "onlyWithoutFunscript"));
    panel.appendChild(field("Workers", input("workers", "number")));
    panel.appendChild(field("Analysis FPS", input("analysisFps", "number")));
    panel.appendChild(field("Scale height", input("scaleHeight", "number")));
    panel.appendChild(field("Timeout minuten per scene", input("timeoutMinutes", "number")));
    panel.appendChild(field("Queue tag", input("queuedTag")));
    panel.appendChild(field("Done tag", input("doneTag")));
    panel.appendChild(field("Failed tag", input("failedTag")));
    panel.appendChild(field("Generator command", textarea("commandTemplate")));
  }

  function renderSceneList(container) {
    const toolbar = el("div", "stash-fg-toolbar");
    const select = el("select");
    select.appendChild(el("option", "", "Alle studios"));
    state.studios.forEach((studio) => {
      const option = el("option", "", `${studio.name} (${studio.scene_count})`);
      option.value = studio.id;
      option.selected = studio.id === state.selectedStudioId;
      select.appendChild(option);
    });
    select.addEventListener("change", () => {
      state.selectedStudioId = select.value;
      state.selected = {};
      loadScenes();
    });
    const load = el("button", "btn btn-secondary", state.loading ? "Laden..." : "Laad scenes");
    load.type = "button";
    load.disabled = state.loading;
    load.addEventListener("click", loadScenes);
    const all = el("button", "btn btn-secondary", "Selecteer zichtbaar");
    all.type = "button";
    all.addEventListener("click", () => {
      state.scenes.forEach((scene) => {
        state.selected[scene.id] = true;
      });
      render();
    });
    toolbar.appendChild(select);
    toolbar.appendChild(load);
    toolbar.appendChild(all);
    container.appendChild(toolbar);

    const list = el("div", "stash-fg-scenes");
    state.scenes.forEach((scene) => {
      const row = el("label", "stash-fg-scene");
      const check = el("input");
      check.type = "checkbox";
      check.checked = !!state.selected[scene.id];
      check.addEventListener("change", () => {
        state.selected[scene.id] = check.checked;
      });
      row.appendChild(check);
      const body = el("div");
      body.appendChild(el("strong", "", scene.title || "(zonder titel)"));
      body.appendChild(el("code", "", scenePath(scene)));
      row.appendChild(body);
      list.appendChild(row);
    });
    container.appendChild(list);
  }

  function renderQueue(container) {
    const queue = (state.queueState && state.queueState.queue) || [];
    const active = (state.queueState && state.queueState.active) || [];
    const running = !!(state.queueState && state.queueState.running);
    const controls = el("div", "stash-fg-actions");
    const enqueue = el("button", "btn btn-primary", `Queue selectie (${selectedScenes().length})`);
    enqueue.type = "button";
    enqueue.disabled = !selectedScenes().length;
    enqueue.addEventListener("click", enqueueSelected);
    const start = el("button", "btn btn-success", running ? "Running" : "Start queue");
    start.type = "button";
    start.disabled = running;
    start.addEventListener("click", startQueue);
    const stop = el("button", "btn btn-danger", "Stop");
    stop.type = "button";
    stop.disabled = !running;
    stop.addEventListener("click", stopQueue);
    const clearDone = el("button", "btn btn-secondary", "Ruim klaar op");
    clearDone.type = "button";
    clearDone.addEventListener("click", () => clearQueue("completed"));
    controls.appendChild(enqueue);
    controls.appendChild(start);
    controls.appendChild(stop);
    controls.appendChild(clearDone);
    container.appendChild(controls);

    const summary = el("div", "stash-fg-summary");
    summary.appendChild(el("strong", "", `Queue ${queue.length}`));
    summary.appendChild(el("span", "", running ? "Actief" : "Idle"));
    if (active.length) summary.appendChild(el("code", "", active.map((job) => job.title).join(", ")));
    container.appendChild(summary);
    queue.slice(0, 80).forEach((job) => {
      const card = el("div", `stash-fg-job ${job.status || "queued"}`);
      card.appendChild(el("strong", "", job.title || job.path));
      card.appendChild(el("span", "stash-fg-pill", job.status || "queued"));
      card.appendChild(el("code", "", job.outputPath || ""));
      if (job.error) card.appendChild(el("p", "", job.error));
      container.appendChild(card);
    });
  }

  function renderContent(app) {
    clear(app);
    const shell = el("section", "stash-fg-shell");
    const title = el("div", "stash-fg-titlebar");
    title.appendChild(el("h1", "", "Funscript Generator"));
    title.appendChild(el("p", "", "Selecteer studios/scenes, queue generatie, en draai lokaal met je eigen generator-engine."));
    shell.appendChild(title);
    if (state.error) shell.appendChild(el("div", "stash-fg-error", state.error));
    if (state.status) shell.appendChild(el("div", "stash-fg-status", state.status));
    const layout = el("div", "stash-fg-layout");
    const settings = el("aside", "stash-fg-panel");
    renderSettings(settings);
    const main = el("main", "stash-fg-main");
    renderSceneList(main);
    renderQueue(main);
    const log = state.queueState && state.queueState.logTail;
    if (log) {
      const pre = el("pre", "stash-fg-log", log);
      main.appendChild(pre);
    }
    layout.appendChild(settings);
    layout.appendChild(main);
    shell.appendChild(layout);
    app.appendChild(shell);
  }

  function render() {
    addNav();
    if (state.routeContainer) renderContent(state.routeContainer);
    const navButton = document.querySelector(`#${NAV_ID} .stash-fg-nav-button`);
    if (navButton) navButton.classList.toggle("active", isRoute());
  }

  function registerPluginRoute() {
    const api = window.PluginApi;
    if (!api || !api.React || !api.register || !api.register.route || window.__stashFgRouteRegistered) return;
    window.__stashFgRouteRegistered = true;
    state.routeRegistered = true;
    const React = api.React;
    function FunscriptGeneratorPage() {
      const ref = React.useRef(null);
      React.useEffect(() => {
        if (!ref.current) return undefined;
        state.routeContainer = ref.current;
        loadStudios().then(refreshStatus).then(loadScenes).catch((error) => {
          state.error = error.message || String(error);
          render();
        });
        return () => {
          if (state.routeContainer === ref.current) state.routeContainer = null;
        };
      }, []);
      return React.createElement("div", { id: APP_ID, ref });
    }
    api.register.route(ROUTE, FunscriptGeneratorPage);
  }

  function install() {
    registerPluginRoute();
    patchHistory();
    addNav();
    window.setTimeout(() => {
      addNav();
      addLauncher();
    }, 1500);
    window.setInterval(refreshStatus, 5000);
  }

  const observer = new MutationObserver(addNav);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", render);
  window.addEventListener("stash-funscript-generator-route", render);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();
})();
