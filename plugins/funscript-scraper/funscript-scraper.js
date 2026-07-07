(function () {
  "use strict";

  const ROUTE = "/funscript-scraper";
  const NAV_ID = "stash-fs-nav";
  const APP_ID = "stash-fs-root";
  const SETTINGS_KEY = "stash-funscript-scraper-settings-v1";
  const PAGE_SIZE = 40;

  const state = {
    pluginId: "",
    scenes: [],
    running: false,
    loading: false,
    status: "",
    error: "",
    results: [],
    settings: loadSettings(),
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

  function loadSettings() {
    const defaults = {
      dryRun: true,
      overwrite: false,
      enableOnline: false,
      tagName: "Funscript",
      minScore: 72,
      localFoldersText: "",
      providersText: JSON.stringify(
        [
          {
            name: "xqueezeme xtoys-scripts",
            type: "github",
            enabled: false,
            repo: "xqueezeme/xtoys-scripts",
            branch: "main",
            path: "funscripts",
            headers: {}
          },
          {
            name: "FredTungsten Scripts",
            type: "github",
            enabled: false,
            repo: "FredTungsten/Scripts",
            branch: "main",
            path: "",
            headers: {}
          },
          {
            name: "Example public index",
            type: "regex",
            enabled: false,
            searchUrlTemplate: "https://example.test/search?q={query}",
            resultRegex: "<a[^>]+href=[\"'](?<url>[^\"']+)[\"'][^>]*>(?<title>.*?)</a>",
            downloadRegex: "href=[\"'](?<url>[^\"']+\\.funscript[^\"']*)[\"']",
            headers: {}
          }
        ],
        null,
        2
      ),
      maxScenes: 10,
      scanAfterPlace: true,
    };
    try {
      const raw = window.localStorage && window.localStorage.getItem(SETTINGS_KEY);
      return Object.assign(defaults, raw ? JSON.parse(raw) : {});
    } catch (error) {
      return defaults;
    }
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (error) {
      console.warn("[Funscript Scraper] could not save settings", error);
    }
  }

  function parsedSettings() {
    let providers = [];
    try {
      providers = JSON.parse(state.settings.providersText || "[]");
      if (!Array.isArray(providers)) providers = [];
    } catch (error) {
      throw new Error("Provider JSON is niet geldig");
    }
    return {
      dryRun: !!state.settings.dryRun,
      overwrite: !!state.settings.overwrite,
      enableOnline: !!state.settings.enableOnline,
      tagName: state.settings.tagName || "Funscript",
      minScore: Number(state.settings.minScore || 72),
      localFolders: String(state.settings.localFoldersText || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
      providers,
      scanAfterPlace: !!state.settings.scanAfterPlace,
    };
  }

  function isRoute() {
    return window.location.pathname.replace(/\/$/, "") === ROUTE;
  }

  function notifyRouteChange() {
    window.dispatchEvent(new Event("stash-funscript-scraper-route"));
  }

  function navigate(event) {
    if (event) event.preventDefault();
    window.history.pushState({}, "", ROUTE);
    notifyRouteChange();
    render();
  }

  function patchHistory() {
    if (window.__stashFsHistoryPatched) return;
    window.__stashFsHistoryPatched = true;
    ["pushState", "replaceState"].forEach((method) => {
      const original = window.history[method];
      window.history[method] = function patchedHistoryState() {
        const result = original.apply(this, arguments);
        window.setTimeout(notifyRouteChange, 0);
        return result;
      };
    });
    window.addEventListener("popstate", notifyRouteChange);
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
    const wrap = el("div", "stash-fs-nav-wrap");
    wrap.id = NAV_ID;
    const link = el("a", "nav-link stash-fs-nav-button");
    link.href = ROUTE;
    link.setAttribute("aria-label", "Funscripts");
    link.appendChild(el("span", "fa fa-bolt fas fa-bolt stash-fs-nav-icon"));
    link.appendChild(el("span", "stash-fs-nav-text", "Funscripts"));
    link.addEventListener("click", navigate);
    wrap.appendChild(link);
    nav.appendChild(wrap);
  }

  function getApp() {
    let app = document.getElementById(APP_ID);
    if (!app) {
      app = el("main", "stash-fs-app");
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
    const data = await graphql("query FunscriptScraperPluginId { plugins { id name } }", {});
    const plugin = ((data && data.plugins) || []).find((item) => item && item.name === "Funscript Scraper");
    if (!plugin || !plugin.id) throw new Error("Funscript Scraper plugin ID kon niet worden gevonden");
    state.pluginId = plugin.id;
    return state.pluginId;
  }

  async function pluginOperation(args) {
    const pluginId = await getPluginId();
    const data = await graphql(
      "mutation FunscriptScraperOperation($pluginId: ID!, $args: Map) { runPluginOperation(plugin_id: $pluginId, args: $args) }",
      { pluginId, args }
    );
    const result = data && data.runPluginOperation;
    const output = result && (result.output || result.result || result);
    return typeof output === "string" ? JSON.parse(output) : output;
  }

  function scenePath(scene) {
    const files = scene && scene.files;
    return (files && files[0] && files[0].path) || scene.path || "";
  }

  async function loadScenes() {
    state.loading = true;
    state.error = "";
    state.status = "Scenes laden...";
    render();
    try {
      const all = [];
      const maxScenes = Math.max(1, Number(state.settings.maxScenes || 10));
      for (let page = 1; all.length < maxScenes; page += 1) {
        const data = await graphql(
          `query FunscriptScenes($filter: FindFilterType) {
            findScenes(filter: $filter) {
              count
              scenes {
                id
                title
                date
                details
                organized
                urls
                tags { id name }
                performers { name }
                studio { name }
                files { path basename duration }
              }
            }
          }`,
          { filter: { page, per_page: PAGE_SIZE, sort: "updated_at", direction: "DESC" } }
        );
        const scenes = (((data || {}).findScenes || {}).scenes || []).filter((scene) => {
          const path = scenePath(scene);
          const hasScriptTag = (scene.tags || []).some((tag) => (tag.name || "").toLowerCase() === (state.settings.tagName || "Funscript").toLowerCase());
          return path && !hasScriptTag;
        });
        all.push(...scenes);
        if (!scenes.length || all.length >= maxScenes) break;
      }
      state.scenes = all.slice(0, maxScenes);
      state.status = `${state.scenes.length} scenes klaar`;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
    } finally {
      state.loading = false;
      render();
    }
  }

  async function ensureTag(name) {
    const data = await graphql(
      `query FunscriptFindTags($filter: FindFilterType) {
        findTags(filter: $filter) { tags { id name } }
      }`,
      { filter: { q: name, per_page: 50 } }
    );
    const tag = ((((data || {}).findTags || {}).tags || [])).find((item) => (item.name || "").toLowerCase() === name.toLowerCase());
    if (tag && tag.id) return tag.id;
    const created = await graphql(
      "mutation FunscriptCreateTag($input: TagCreateInput!) { tagCreate(input: $input) { id name } }",
      { input: { name } }
    );
    return created.tagCreate.id;
  }

  async function addTagToScene(scene, tagId) {
    const existing = (scene.tags || []).map((tag) => tag.id);
    if (existing.includes(tagId)) return;
    const tagIds = existing.concat([tagId]);
    await graphql(
      "mutation FunscriptTagScene($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }",
      { input: { id: scene.id, tag_ids: tagIds } }
    );
    scene.tags = (scene.tags || []).concat([{ id: tagId, name: state.settings.tagName || "Funscript" }]);
  }

  async function scanPath(path) {
    const folder = path.replace(/[\\/][^\\/]+$/, "");
    await graphql("mutation FunscriptScan($input: ScanMetadataInput!) { metadataScan(input: $input) }", {
      input: { paths: [folder] },
    });
  }

  function scenePayload(scene) {
    return {
      id: scene.id,
      title: scene.title || "",
      path: scenePath(scene),
      studio: (scene.studio && scene.studio.name) || "",
      performers: (scene.performers || []).map((performer) => performer.name).filter(Boolean),
      duration: scene.files && scene.files[0] ? scene.files[0].duration : null,
      urls: scene.urls || [],
    };
  }

  async function runBatch() {
    if (state.running) return;
    saveSettings();
    state.running = true;
    state.error = "";
    state.results = [];
    render();
    try {
      const settings = parsedSettings();
      if (!state.scenes.length) await loadScenes();
      const tagId = settings.dryRun ? "" : await ensureTag(settings.tagName || "Funscript");
      for (let index = 0; index < state.scenes.length; index += 1) {
        const scene = state.scenes[index];
        state.status = `Scene ${index + 1}/${state.scenes.length}: ${scene.title || scenePath(scene)}`;
        render();
        const result = await pluginOperation({ action: "search-download", scene: scenePayload(scene), settings });
        const placed = result && result.placement && result.placement.placed;
        if (placed && tagId) {
          await addTagToScene(scene, tagId);
          if (settings.scanAfterPlace) await scanPath(scenePath(scene));
        }
        state.results.unshift({ scene, result });
        render();
      }
      state.status = "Klaar";
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
    } finally {
      state.running = false;
      render();
    }
  }

  function field(label, child) {
    const wrap = el("label", "stash-fs-field");
    wrap.appendChild(el("span", "", label));
    wrap.appendChild(child);
    return wrap;
  }

  function checkbox(label, key) {
    const wrap = el("label", "stash-fs-check");
    const input = el("input");
    input.type = "checkbox";
    input.checked = !!state.settings[key];
    input.addEventListener("change", () => {
      state.settings[key] = input.checked;
      saveSettings();
    });
    wrap.appendChild(input);
    wrap.appendChild(el("span", "", label));
    return wrap;
  }

  function textInput(key, type) {
    const input = el("input");
    input.type = type || "text";
    input.value = state.settings[key] || "";
    input.addEventListener("input", () => {
      state.settings[key] = type === "number" ? Number(input.value) : input.value;
      saveSettings();
    });
    return input;
  }

  function textarea(key, rows) {
    const input = el("textarea");
    input.rows = rows;
    input.value = state.settings[key] || "";
    input.addEventListener("input", () => {
      state.settings[key] = input.value;
      saveSettings();
    });
    return input;
  }

  function renderResult(item) {
    const result = item.result || {};
    const card = el("article", "stash-fs-result");
    const title = el("strong", "", item.scene.title || scenePath(item.scene));
    card.appendChild(title);
    if (result.matched) {
      const candidate = result.candidate || {};
      card.appendChild(el("span", "stash-fs-pill ok", `match ${candidate.score || "?"}%`));
      card.appendChild(el("p", "", `${candidate.source || "source"}: ${candidate.title || candidate.path || candidate.url || ""}`));
      card.appendChild(el("code", "", result.targetPath || ""));
      if (result.dryRun) card.appendChild(el("span", "stash-fs-pill", "dry-run"));
      if (result.placement && result.placement.placed) card.appendChild(el("span", "stash-fs-pill ok", "geplaatst"));
    } else {
      card.appendChild(el("span", "stash-fs-pill warn", result.reason || "geen match"));
    }
    return card;
  }

  function render() {
    addNav();
    const app = getApp();
    app.hidden = !isRoute();
    if (app.hidden) return;
    clear(app);

    const head = el("section", "stash-fs-head");
    head.appendChild(el("h1", "", "Funscript Scraper"));
    head.appendChild(el("p", "", "Automatisch zoeken, downloaden, naast de video plaatsen en taggen."));
    app.appendChild(head);

    const layout = el("section", "stash-fs-layout");
    const panel = el("div", "stash-fs-panel");
    panel.appendChild(checkbox("Dry-run", "dryRun"));
    panel.appendChild(checkbox("Bestaande .funscript overschrijven", "overwrite"));
    panel.appendChild(checkbox("Online providers gebruiken", "enableOnline"));
    panel.appendChild(checkbox("Scan folder na plaatsen", "scanAfterPlace"));
    panel.appendChild(field("Tagnaam", textInput("tagName")));
    panel.appendChild(field("Minimum match score", textInput("minScore", "number")));
    panel.appendChild(field("Max scenes per run", textInput("maxScenes", "number")));
    panel.appendChild(field("Lokale scriptmappen, 1 per regel", textarea("localFoldersText", 4)));
    panel.appendChild(field("Online providers JSON", textarea("providersText", 12)));

    const actions = el("div", "stash-fs-actions");
    const load = el("button", "btn btn-secondary", state.loading ? "Laden..." : "Scenes laden");
    load.type = "button";
    load.disabled = state.loading || state.running;
    load.addEventListener("click", loadScenes);
    const run = el("button", "btn btn-primary", state.running ? "Bezig..." : "Run scraper");
    run.type = "button";
    run.disabled = state.running || state.loading;
    run.addEventListener("click", runBatch);
    actions.appendChild(load);
    actions.appendChild(run);
    panel.appendChild(actions);

    const main = el("div", "stash-fs-main");
    if (state.status) main.appendChild(el("div", "stash-fs-status", state.status));
    if (state.error) main.appendChild(el("div", "stash-fs-error", state.error));
    const queue = el("div", "stash-fs-queue");
    queue.appendChild(el("h2", "", `Queue (${state.scenes.length})`));
    state.scenes.slice(0, 20).forEach((scene) => {
      const row = el("div", "stash-fs-scene");
      row.appendChild(el("strong", "", scene.title || "(zonder titel)"));
      row.appendChild(el("code", "", scenePath(scene)));
      queue.appendChild(row);
    });
    main.appendChild(queue);
    const results = el("div", "stash-fs-results");
    results.appendChild(el("h2", "", `Resultaten (${state.results.length})`));
    state.results.forEach((item) => results.appendChild(renderResult(item)));
    main.appendChild(results);

    layout.appendChild(panel);
    layout.appendChild(main);
    app.appendChild(layout);
  }

  function boot() {
    patchHistory();
    addNav();
    render();
    window.addEventListener("stash-funscript-scraper-route", render);
    window.setInterval(addNav, 2000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
