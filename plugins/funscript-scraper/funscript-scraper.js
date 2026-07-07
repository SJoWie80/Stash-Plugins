(function () {
  "use strict";

  const ROUTE = "/funscript-scraper";
  const NAV_ID = "stash-fs-nav";
  const LAUNCHER_ID = "stash-fs-launcher";
  const APP_ID = "stash-fs-root";
  const SETTINGS_KEY = "stash-funscript-scraper-settings-v1";
  const PAGE_SIZE = 40;
  const MAX_PAGES = 500;
  const SCRAPE_CHUNK_SIZE = 20;

  const state = {
    pluginId: "",
    scenes: [],
    running: false,
    loading: false,
    status: "",
    error: "",
    results: [],
    providerStats: [],
    errorCount: 0,
    sampleErrors: [],
    processedCount: 0,
    matchedCount: 0,
    stopRequested: false,
    abortController: null,
    settings: loadSettings(),
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

  function loadSettings() {
    const defaultProviders = [
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
      }
    ];
    const defaults = {
      dryRun: true,
      overwrite: false,
      enableOnline: false,
      tagName: "Funscript",
      minScore: 65,
      localFoldersText: "",
      providers: defaultProviders,
      maxScenes: 10,
      scanAfterPlace: true,
    };
    try {
      const raw = window.localStorage && window.localStorage.getItem(SETTINGS_KEY);
      const loaded = Object.assign(defaults, raw ? JSON.parse(raw) : {});
      if (!Array.isArray(loaded.providers)) {
        try {
          const parsedProviders = JSON.parse(loaded.providersText || "[]");
          loaded.providers = Array.isArray(parsedProviders) ? parsedProviders : defaultProviders;
        } catch (error) {
          loaded.providers = defaultProviders;
        }
      }
      delete loaded.providersText;
      return loaded;
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
    const providers = Array.isArray(state.settings.providers) ? state.settings.providers : [];
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
    window.dispatchEvent(new PopStateEvent("popstate"));
    notifyRouteChange();
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
    try {
      if (document.getElementById(NAV_ID)) {
        removeLauncher();
        return;
      }
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
      removeLauncher();
    } catch (error) {
      console.error("[Funscript Scraper] failed adding nav", error);
    }
  }

  function removeLauncher() {
    const launcher = document.getElementById(LAUNCHER_ID);
    if (launcher) launcher.remove();
  }

  function addLauncher() {
    if (document.getElementById(NAV_ID) || document.getElementById(LAUNCHER_ID)) return;
    const launcher = el("button", "stash-fs-launcher", "Funscripts");
    launcher.id = LAUNCHER_ID;
    launcher.type = "button";
    launcher.addEventListener("click", navigate);
    document.body.appendChild(launcher);
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

  async function graphql(query, variables, signal) {
    const options = {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    };
    if (signal) options.signal = signal;
    const response = await fetch("/graphql", options);
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

  async function pluginOperation(args, signal) {
    const pluginId = await getPluginId();
    const data = await graphql(
      "mutation FunscriptScraperOperation($pluginId: ID!, $args: Map) { runPluginOperation(plugin_id: $pluginId, args: $args) }",
      { pluginId, args },
      signal
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
      let total = 0;
      let pagesChecked = 0;
      for (let page = 1; all.length < maxScenes && page <= MAX_PAGES; page += 1) {
        pagesChecked = page;
        state.status = `Scenes zoeken: ${all.length}/${maxScenes} geselecteerd`;
        render();
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
        const result = (data || {}).findScenes || {};
        const rawScenes = result.scenes || [];
        total = typeof result.count === "number" ? result.count : total;
        const scenes = rawScenes.filter((scene) => {
          const path = scenePath(scene);
          const hasScriptTag = (scene.tags || []).some((tag) => (tag.name || "").toLowerCase() === (state.settings.tagName || "Funscript").toLowerCase());
          return path && !hasScriptTag;
        });
        all.push(...scenes);
        if (!rawScenes.length || rawScenes.length < PAGE_SIZE || page * PAGE_SIZE >= total || all.length >= maxScenes) break;
      }
      state.scenes = all.slice(0, maxScenes);
      state.status = `${state.scenes.length} scenes klaar uit ${pagesChecked} pagina's`;
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
    state.providerStats = [];
    state.errorCount = 0;
    state.sampleErrors = [];
    state.processedCount = 0;
    state.matchedCount = 0;
    state.stopRequested = false;
    state.abortController = new AbortController();
    render();
    try {
      const settings = parsedSettings();
      if (!state.scenes.length) await loadScenes();
      const tagId = settings.dryRun ? "" : await ensureTag(settings.tagName || "Funscript");
      const scenes = state.scenes.map(scenePayload);
      const byId = Object.fromEntries(state.scenes.map((scene) => [scene.id, scene]));
      for (let offset = 0; offset < scenes.length; offset += SCRAPE_CHUNK_SIZE) {
        if (state.stopRequested) break;
        const chunk = scenes.slice(offset, offset + SCRAPE_CHUNK_SIZE);
        state.status = `Scraped ${state.processedCount}/${scenes.length} - hits ${state.matchedCount}`;
        render();
        const output = await pluginOperation(
          { action: "batch-search-download", scenes: chunk, settings },
          state.abortController && state.abortController.signal
        );
        if ((output.providerStats || []).length) state.providerStats = output.providerStats;
        state.errorCount += output.errorCount || 0;
        state.sampleErrors = state.sampleErrors.concat(output.errors || []).slice(0, 50);
        state.processedCount += output.processed || chunk.length;
        state.matchedCount += output.matched || 0;
        const chunkResults = (output.results || []).map((item) => ({
          scene: byId[item.sceneId] || item.scene || {},
          result: item.result || {},
        }));
        state.results = chunkResults.concat(state.results);
      }
      if (tagId) {
        for (const item of state.results) {
          if (state.stopRequested) break;
          const placed = item.result && item.result.placement && item.result.placement.placed;
          if (placed && item.scene && item.scene.id) {
            await addTagToScene(item.scene, tagId);
            if (settings.scanAfterPlace) await scanPath(scenePath(item.scene));
          }
        }
      }
      state.status = state.stopRequested
        ? `Gestopt: scraped ${state.processedCount}/${state.scenes.length} - hits ${state.matchedCount}`
        : `Klaar: scraped ${state.processedCount}/${state.scenes.length} - hits ${state.matchedCount}`;
    } catch (error) {
      state.error = state.stopRequested ? "" : (error.message || String(error));
      state.status = state.stopRequested
        ? `Gestopt: scraped ${state.processedCount}/${state.scenes.length} - hits ${state.matchedCount}`
        : "";
    } finally {
      state.abortController = null;
      state.stopRequested = false;
      state.running = false;
      render();
    }
  }

  function stopBatch() {
    if (!state.running) return;
    state.stopRequested = true;
    state.status = `Stoppen... scraped ${state.processedCount}/${state.scenes.length}`;
    if (state.abortController) {
      try {
        state.abortController.abort();
      } catch (error) {
        console.warn("[Funscript Scraper] abort failed", error);
      }
    }
    render();
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

  function updateProvider(index, key, value) {
    const providers = Array.isArray(state.settings.providers) ? state.settings.providers : [];
    const provider = Object.assign({}, providers[index] || {});
    provider[key] = value;
    providers[index] = provider;
    state.settings.providers = providers;
    saveSettings();
  }

  function addGithubProvider() {
    const providers = Array.isArray(state.settings.providers) ? state.settings.providers.slice() : [];
    providers.push({
      name: "GitHub funscripts",
      type: "github",
      enabled: false,
      repo: "",
      branch: "main",
      path: "",
      headers: {}
    });
    state.settings.providers = providers;
    saveSettings();
    render();
  }

  function enableBuiltInProviders() {
    const providers = Array.isArray(state.settings.providers) ? state.settings.providers.slice() : [];
    providers.forEach((provider) => {
      if ((provider.repo || "").match(/^(xqueezeme\/xtoys-scripts|FredTungsten\/Scripts)$/i)) {
        provider.enabled = true;
      }
    });
    state.settings.enableOnline = true;
    state.settings.providers = providers;
    saveSettings();
    render();
  }

  function removeProvider(index) {
    const providers = Array.isArray(state.settings.providers) ? state.settings.providers.slice() : [];
    providers.splice(index, 1);
    state.settings.providers = providers;
    saveSettings();
    render();
  }

  function providerInput(provider, index, key, placeholder) {
    const input = el("input");
    input.type = "text";
    input.value = provider[key] || "";
    input.placeholder = placeholder || "";
    input.addEventListener("input", () => updateProvider(index, key, input.value));
    return input;
  }

  function renderProviders() {
    const wrap = el("div", "stash-fs-providers");
    const title = el("div", "stash-fs-subhead");
    title.appendChild(el("strong", "", "GitHub bronnen"));
    const enableBuiltIns = el("button", "btn btn-secondary", "Zet standaardbronnen aan");
    enableBuiltIns.type = "button";
    enableBuiltIns.addEventListener("click", enableBuiltInProviders);
    const add = el("button", "btn btn-secondary", "Bron toevoegen");
    add.type = "button";
    add.addEventListener("click", addGithubProvider);
    title.appendChild(enableBuiltIns);
    title.appendChild(add);
    wrap.appendChild(title);

    const providers = Array.isArray(state.settings.providers) ? state.settings.providers : [];
    providers.forEach((provider, index) => {
      const card = el("div", "stash-fs-provider");
      const top = el("div", "stash-fs-provider-top");
      const enabled = el("label", "stash-fs-check");
      const checkboxInput = el("input");
      checkboxInput.type = "checkbox";
      checkboxInput.checked = !!provider.enabled;
      checkboxInput.addEventListener("change", () => updateProvider(index, "enabled", checkboxInput.checked));
      enabled.appendChild(checkboxInput);
      enabled.appendChild(el("span", "", provider.enabled ? "Aan" : "Uit"));
      top.appendChild(enabled);
      const remove = el("button", "btn btn-danger", "Verwijder");
      remove.type = "button";
      remove.addEventListener("click", () => removeProvider(index));
      top.appendChild(remove);
      card.appendChild(top);
      card.appendChild(field("Naam", providerInput(provider, index, "name", "Mijn script repo")));
      card.appendChild(field("Repo", providerInput(provider, index, "repo", "owner/repository")));
      card.appendChild(field("Branch", providerInput(provider, index, "branch", "main")));
      card.appendChild(field("Map in repo", providerInput(provider, index, "path", "funscripts")));
      wrap.appendChild(card);
    });

    if (!providers.length) {
      wrap.appendChild(el("p", "stash-fs-muted", "Nog geen bronnen toegevoegd."));
    }
    return wrap;
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

  function renderProviderStats() {
    const wrap = el("div", "stash-fs-provider-stats");
    if (!state.providerStats.length && !state.errorCount) return wrap;
    wrap.appendChild(el("h2", "", "Bronnen"));
    state.providerStats.forEach((stat) => {
      const row = el("div", "stash-fs-source-row");
      row.appendChild(el("strong", "", stat.source || "Bron"));
      if (stat.ok) {
        row.appendChild(el("span", "stash-fs-pill ok", `${stat.funscripts || 0} scripts`));
        row.appendChild(el("code", "", `${stat.repo || ""}@${stat.branch || ""}`));
      } else {
        row.appendChild(el("span", "stash-fs-pill warn", "error"));
        row.appendChild(el("code", "", stat.error || ""));
      }
      wrap.appendChild(row);
    });
    if (state.errorCount) {
      const error = el("div", "stash-fs-error-lite");
      error.appendChild(el("strong", "", `${state.errorCount} provider/download errors`));
      state.sampleErrors.slice(0, 5).forEach((item) => {
        error.appendChild(el("code", "", `${item.source || ""} ${item.title || item.sceneId || ""}: ${item.error || ""}`));
      });
      wrap.appendChild(error);
    }
    return wrap;
  }

  function renderContent(app) {
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
    panel.appendChild(renderProviders());

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
    if (state.running) {
      const stop = el("button", "btn btn-danger", "Stop scrape");
      stop.type = "button";
      stop.addEventListener("click", stopBatch);
      actions.appendChild(stop);
    }
    panel.appendChild(actions);

    const main = el("div", "stash-fs-main");
    if (state.status) main.appendChild(el("div", "stash-fs-status", state.status));
    if (state.error) main.appendChild(el("div", "stash-fs-error", state.error));
    const progress = el("div", "stash-fs-progress");
    const total = state.scenes.length || Math.max(1, Number(state.settings.maxScenes || 10));
    const processed = Math.min(state.processedCount || 0, total);
    progress.appendChild(el("strong", "", `Scraped ${processed}/${total}`));
    progress.appendChild(el("span", "", `Hits ${state.matchedCount || 0}`));
    const meter = el("div", "stash-fs-meter");
    const bar = el("div", "stash-fs-meter-bar");
    bar.style.width = `${Math.min(100, Math.round((processed / Math.max(1, total)) * 100))}%`;
    meter.appendChild(bar);
    progress.appendChild(meter);
    main.appendChild(progress);
    main.appendChild(renderProviderStats());
    const results = el("div", "stash-fs-results");
    results.appendChild(el("h2", "", `Hits (${state.results.length})`));
    if (!state.results.length) {
      results.appendChild(el("p", "stash-fs-muted", state.running ? "Nog geen hits." : "Geen hits in deze run."));
    } else {
      state.results.forEach((item) => results.appendChild(renderResult(item)));
    }
    main.appendChild(results);

    layout.appendChild(panel);
    layout.appendChild(main);
    app.appendChild(layout);
  }

  function render() {
    addNav();
    if (state.routeContainer) {
      renderContent(state.routeContainer);
    } else if (!state.routeRegistered) {
      const app = getApp();
      app.hidden = !isRoute();
      if (!app.hidden) renderContent(app);
    }
    const navButton = document.querySelector(`#${NAV_ID} .stash-fs-nav-button`);
    if (navButton) navButton.classList.toggle("active", isRoute());
  }

  function registerPluginRoute() {
    const api = window.PluginApi;
    if (!api || !api.React || !api.register || !api.register.route || window.__stashFsRouteRegistered) return;
    window.__stashFsRouteRegistered = true;
    state.routeRegistered = true;
    const React = api.React;
    function FunscriptScraperPage() {
      const ref = React.useRef(null);
      React.useEffect(() => {
        if (!ref.current) return undefined;
        const fallback = document.body.querySelector(`main#${APP_ID}`);
        if (fallback && fallback !== ref.current) fallback.remove();
        state.routeContainer = ref.current;
        ref.current.className = "stash-fs-app";
        renderContent(ref.current);
        return () => {
          if (state.routeContainer === ref.current) state.routeContainer = null;
        };
      });
      return React.createElement("div", { id: APP_ID, ref });
    }
    api.register.route(ROUTE, FunscriptScraperPage);
  }

  function boot() {
    registerPluginRoute();
    patchHistory();
    addNav();
    window.setTimeout(() => {
      addNav();
      addLauncher();
    }, 1500);
    render();
    window.addEventListener("stash-funscript-scraper-route", render);
    window.addEventListener("popstate", render);
    const observer = new MutationObserver(() => {
      addNav();
      addLauncher();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
