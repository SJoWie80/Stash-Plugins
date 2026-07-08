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
    tool: "duplicates",
    loading: false,
    error: "",
    status: "",
    groups: [],
    unusedTags: [],
    selectedTagIds: new Set(),
    protectedTagIds: new Set(),
    mode: "fingerprint",
    search: "",
    loaded: false,
    tagsLoaded: false,
    scanRequested: false,
    tagScanRequested: false,
  };

  const HASH_FIELDS = ["checksum", "oshash", "phash"];

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
      link.setAttribute("aria-label", "Stash Cleanup");
      link.appendChild(el("span", "fa fa-broom fas fa-broom stash-dc-nav-icon"));
      link.appendChild(el("span", "stash-dc-nav-text", "Cleanup"));
      link.addEventListener("click", navigate);
      wrap.appendChild(link);
      nav.appendChild(wrap);
      removeLauncher();
    } catch (error) {
      console.error("[Stash Cleanup] failed adding nav", error);
    }
  }

  function removeLauncher() {
    const launcher = document.getElementById(LAUNCHER_ID);
    if (launcher) launcher.remove();
  }

  function addLauncher() {
    if (document.getElementById(NAV_ID) || document.getElementById(LAUNCHER_ID)) return;
    const launcher = el("button", "stash-dc-launcher", "Cleanup");
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

  async function loadPagedTags(query) {
    const tags = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      state.status = `Scanning tags page ${page}...`;
      render();
      const data = await graphql(query, { filter: { page, per_page: PAGE_SIZE } });
      const result = data && data.findTags;
      const items = (result && result.tags) || [];
      total = result && typeof result.count === "number" ? result.count : tags.length + items.length;
      tags.push(...items);
      if (!items.length || tags.length >= total || items.length < PAGE_SIZE) break;
    }
    return tags;
  }

  async function graphqlTypeFields(typeName) {
    const data = await graphql(
      `query DuplicateCheckerTypeFields($name: String!) {
        __type(name: $name) {
          fields { name }
        }
      }`,
      { name: typeName }
    );
    return new Set((((data && data.__type) || {}).fields || []).map((field) => field.name));
  }

  async function loadSchema() {
    try {
      const [scene, file, videoFile] = await Promise.all([
        graphqlTypeFields("Scene"),
        graphqlTypeFields("File"),
        graphqlTypeFields("VideoFile"),
      ]);
      return { scene, file, videoFile };
    } catch (error) {
      console.warn("[Stash Cleanup] schema introspection failed", error);
      return null;
    }
  }

  function hasField(schema, typeName, fieldName) {
    return Boolean(schema && schema[typeName] && schema[typeName].has(fieldName));
  }

  function buildSchemaQuery(schema) {
    const sceneFields = HASH_FIELDS.filter((field) => hasField(schema, "scene", field));
    const fileFields = ["id", "path", "basename", "size", "duration"].filter(
      (field) => hasField(schema, "file", field) || hasField(schema, "videoFile", field)
    );
    if (!fileFields.length) fileFields.push("id");
    if (hasField(schema, "file", "fingerprints") || hasField(schema, "videoFile", "fingerprints")) {
      fileFields.push("fingerprints { type value }");
    }
    return `query DuplicateCheckerScenesSchema($filter: FindFilterType) {
      findScenes(filter: $filter) {
        count
        scenes {
          id title date
          ${sceneFields.join("\n          ")}
          paths { screenshot }
          files { ${fileFields.join(" ")} }
          studio { name }
          performers { name }
          tags { name }
        }
      }
    }`;
  }

  function buildTagQuery(tagFields) {
    const countFields = ["scene_count", "gallery_count", "image_count", "performer_count", "studio_count", "marker_count"].filter((field) =>
      tagFields.has(field)
    );
    return `query DuplicateCheckerTags($filter: FindFilterType) {
      findTags(filter: $filter) {
        count
        tags {
          id name
          ${countFields.join("\n          ")}
        }
      }
    }`;
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

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[_\-.[\](){}]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function fileSize(file) {
    const value = Number(file && file.size);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function sceneDuration(scene) {
    const file = firstFile(scene);
    const value = Number(file && file.duration);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function fingerprintKeys(scene) {
    const sceneKeys = HASH_FIELDS.map((field) => {
      const value = String((scene && scene[field]) || "").toLowerCase();
      return value ? `scene:${field}:${value}` : "";
    }).filter(Boolean);
    const file = firstFile(scene);
    const fingerprints = (file && file.fingerprints) || [];
    const fileKeys = fingerprints
      .map((fingerprint) => {
        const type = String(fingerprint.type || "").toLowerCase();
        const value = String(fingerprint.value || "").toLowerCase();
        return type && value ? `fp:${type}:${value}` : "";
      })
      .filter(Boolean);
    return sceneKeys.concat(fileKeys);
  }

  function basenameStem(path) {
    const normalized = normalizePath(path).toLowerCase();
    const name = normalized.slice(normalized.lastIndexOf("/") + 1);
    return name.replace(/\.[^.]+$/, "").replace(/\s*\(\d+\)\s*$/, "").trim();
  }

  function fallbackKey(scene) {
    const file = firstFile(scene);
    const size = fileSize(file);
    const duration = sceneDuration(scene);
    const name = basenameStem((file && (file.basename || file.path)) || "");
    if (!size) return "";
    if (name) return duration ? `name-size-duration:${name}:${size}:${Math.round(duration)}` : `name-size:${name}:${size}`;
    return duration ? `size-duration:${size}:${Math.round(duration)}` : `size:${size}`;
  }

  function metadataKeys(scene) {
    const title = normalizeText(scene && scene.title);
    if (!title || title.length < 4) return [];
    const studio = normalizeText(scene.studio && scene.studio.name);
    const performers = relationNames(scene.performers).map(normalizeText).filter(Boolean).sort();
    const keys = [];
    if (studio) keys.push(`title-studio:${title}:${studio}`);
    if (performers.length) keys.push(`title-performers:${title}:${performers.join("|")}`);
    if (studio && performers.length) keys.push(`title-studio-performers:${title}:${studio}:${performers.join("|")}`);
    return keys;
  }

  function detectionKeys(scene) {
    const fps = fingerprintKeys(scene);
    if (state.mode === "fingerprint") return fps;
    const fallback = fallbackKey(scene);
    return fps.concat(metadataKeys(scene), fallback ? [fallback] : []);
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
        const type = key.startsWith("scene:")
          ? "Scene hash"
          : key.startsWith("fp:")
            ? "File fingerprint"
            : key.startsWith("title-studio-performers:")
              ? "Title + studio + performers"
              : key.startsWith("title-studio:")
                ? "Title + studio"
                : key.startsWith("title-performers:")
                  ? "Title + performers"
            : key.startsWith("name-size")
              ? "Name + size"
              : key.startsWith("size-duration:")
                ? "Size + duration"
                : "File size";
        return { key, scenes: unique, type };
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
          id title date
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
          id title date
          paths { screenshot }
          files { id path basename size duration }
          studio { name }
          performers { name }
          tags { name }
        }
      }
    }`;
    const minimalQuery = `query DuplicateCheckerScenesMinimal($filter: FindFilterType) {
      findScenes(filter: $filter) {
        count
        scenes {
          id title date
          paths { screenshot }
          files { id path basename size }
          studio { name }
          performers { name }
          tags { name }
        }
      }
    }`;
    try {
      let scenes;
      try {
        const schema = await loadSchema();
        scenes = schema ? await loadPaged(buildSchemaQuery(schema)) : await loadPaged(fingerprintQuery);
      } catch (error) {
        console.warn("[Stash Cleanup] schema-aware query failed, falling back to file fingerprints", error);
        try {
          scenes = await loadPaged(fingerprintQuery);
        } catch (fingerprintError) {
          console.warn("[Stash Cleanup] fingerprint query failed, falling back to size/duration", fingerprintError);
          try {
            scenes = await loadPaged(fallbackQuery);
          } catch (fallbackError) {
            console.warn("[Stash Cleanup] size/duration query failed, falling back to file size", fallbackError);
            scenes = await loadPaged(minimalQuery);
          }
        }
      }
      state.groups = groupScenes(scenes);
      state.loaded = true;
      const duplicateCount = state.groups.reduce((sum, group) => sum + group.scenes.length, 0);
      state.status = `${state.groups.length} duplicate groups, ${duplicateCount} scenes involved from ${scenes.length} scanned scenes`;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
      console.error("[Stash Cleanup] scan failed", error);
    } finally {
      state.loading = false;
      render();
    }
  }

  function tagUsageCount(tag) {
    return ["scene_count", "gallery_count", "image_count", "performer_count", "studio_count", "marker_count"].reduce(
      (sum, field) => sum + (Number(tag && tag[field]) || 0),
      0
    );
  }

  async function loadUnusedTags(force) {
    if (state.tagsLoaded && !force) return;
    state.loading = true;
    state.error = "";
    state.status = "Scanning tags...";
    render();
    try {
      const tagFields = await graphqlTypeFields("Tag");
      const usableFields = ["scene_count", "gallery_count", "image_count", "performer_count", "studio_count", "marker_count"].filter((field) =>
        tagFields.has(field)
      );
      if (!usableFields.length) throw new Error("Tag count fields are not available in this Stash GraphQL schema.");
      const tags = await loadPagedTags(buildTagQuery(tagFields));
      state.unusedTags = tags.filter((tag) => tagUsageCount(tag) === 0).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      state.selectedTagIds = new Set(state.unusedTags.map((tag) => String(tag.id)).filter((id) => !state.protectedTagIds.has(id)));
      state.tagsLoaded = true;
      state.status = `${state.unusedTags.length} unused tags from ${tags.length} scanned tags`;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
      console.error("[Stash Cleanup] tag scan failed", error);
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

  function filteredUnusedTags() {
    const term = state.search.trim().toLowerCase();
    if (!term) return state.unusedTags;
    return state.unusedTags.filter((tag) => String(tag.name || "").toLowerCase().includes(term));
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

  function openTag(tag) {
    window.history.pushState({}, "", `/tags/${tag.id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    notifyRouteChange();
  }

  function selectedUnusedTags() {
    return state.unusedTags.filter((tag) => state.selectedTagIds.has(String(tag.id)) && !state.protectedTagIds.has(String(tag.id)));
  }

  function setAllTagsSelected(selected) {
    state.selectedTagIds = selected
      ? new Set(filteredUnusedTags().map((tag) => String(tag.id)).filter((id) => !state.protectedTagIds.has(id)))
      : new Set();
    render();
  }

  function toggleTagSelected(tag) {
    const id = String(tag.id);
    if (state.protectedTagIds.has(id)) return;
    if (state.selectedTagIds.has(id)) state.selectedTagIds.delete(id);
    else state.selectedTagIds.add(id);
    render();
  }

  async function deleteSelectedTags() {
    const tags = selectedUnusedTags();
    if (!tags.length) return;
    const names = tags.slice(0, 8).map((tag) => tag.name || `Tag ${tag.id}`).join(", ");
    const extra = tags.length > 8 ? ` and ${tags.length - 8} more` : "";
    if (!window.confirm(`Delete ${tags.length} unused tags?\n\n${names}${extra}`)) return;

    state.loading = true;
    state.error = "";
    state.status = `Deleting ${tags.length} tags...`;
    render();
    try {
      const mutationFields = await graphqlTypeFields("Mutation");
      if (!mutationFields.has("tagDestroy")) throw new Error("tagDestroy mutation is not available in this Stash GraphQL schema.");
      const failed = [];
      for (let index = 0; index < tags.length; index += 1) {
        state.status = `Deleting tag ${index + 1} of ${tags.length}...`;
        render();
        try {
          await graphql(
            `mutation StashCleanupTagDestroy($id: ID!) {
              tagDestroy(input: { id: $id })
            }`,
            { id: tags[index].id }
          );
        } catch (error) {
          const message = error.message || String(error);
          failed.push({ tag: tags[index], message });
          state.protectedTagIds.add(String(tags[index].id));
          state.selectedTagIds.delete(String(tags[index].id));
          console.warn("[Stash Cleanup] skipped tag delete", tags[index], error);
        }
      }
      state.tagsLoaded = false;
      await loadUnusedTags(true);
      if (failed.length) {
        const names = failed.slice(0, 6).map((entry) => entry.tag.name || `Tag ${entry.tag.id}`).join(", ");
        const extra = failed.length > 6 ? ` and ${failed.length - 6} more` : "";
        state.error = `${failed.length} tags could not be deleted, usually because Stash still uses them as marker primary tags: ${names}${extra}`;
      }
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
      console.error("[Stash Cleanup] tag delete failed", error);
    } finally {
      state.loading = false;
      render();
    }
  }

  function renderToolbar(parent) {
    const toolbar = el("div", "stash-dc-toolbar");
    const tools = el("div", "stash-dc-tools");
    [
      ["duplicates", "Duplicates"],
      ["tags", "Unused Tags"],
    ].forEach(([tool, label]) => {
      const button = el("button", "stash-dc-tool", label);
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.tool === tool));
      button.addEventListener("click", () => {
        if (state.tool === tool) return;
        state.tool = tool;
        state.search = "";
        render();
      });
      tools.appendChild(button);
    });

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
        state.scanRequested = false;
        render();
      });
      tabs.appendChild(button);
    });

    const search = el("input", "stash-dc-search");
    search.type = "search";
    search.placeholder = state.tool === "tags" ? "Search unused tags" : "Search titles, paths, performers, tags";
    search.value = state.search;
    search.addEventListener("input", () => {
      state.search = search.value;
      render();
    });

    const refresh = el("button", "stash-dc-refresh", state.tool === "tags" ? "Scan Tags" : "Scan");
    refresh.type = "button";
    refresh.addEventListener("click", () => {
      if (state.tool === "tags") {
        state.tagsLoaded = false;
        state.tagScanRequested = true;
        loadUnusedTags(true);
      } else {
        state.loaded = false;
        state.scanRequested = true;
        loadDuplicates(true);
      }
    });
    toolbar.append(tools);
    if (state.tool === "duplicates") toolbar.append(tabs);
    toolbar.append(search, refresh);
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
    const key = group.key
      .replace(/^scene:/, "")
      .replace(/^fp:/, "")
      .replace(/^title-studio-performers:/, "title/studio/performers: ")
      .replace(/^title-studio:/, "title/studio: ")
      .replace(/^title-performers:/, "title/performers: ")
      .replace(/^name-size-duration:/, "name/size/duration: ")
      .replace(/^name-size:/, "name/size: ")
      .replace(/^size-duration:/, "size/duration: ")
      .replace(/^size:/, "size: ");
    section.appendChild(el("div", "stash-dc-key", key));
    const list = el("div", "stash-dc-scenes");
    group.scenes.forEach((scene) => list.appendChild(renderScene(scene)));
    section.appendChild(list);
    return section;
  }

  function renderTag(tag) {
    const item = el("div", "stash-dc-tag");
    const checkbox = el("input", "stash-dc-tag-check");
    const protectedTag = state.protectedTagIds.has(String(tag.id));
    checkbox.type = "checkbox";
    checkbox.disabled = protectedTag;
    checkbox.checked = state.selectedTagIds.has(String(tag.id));
    checkbox.addEventListener("change", () => toggleTagSelected(tag));
    const open = el("button", "stash-dc-tag-open");
    open.type = "button";
    open.addEventListener("click", () => openTag(tag));
    open.appendChild(el("span", "stash-dc-tag-name", tag.name || `Tag ${tag.id}`));
    open.appendChild(el("span", "stash-dc-tag-id", protectedTag ? `ID ${tag.id} - protected marker tag` : `ID ${tag.id}`));
    item.append(checkbox, open);
    return item;
  }

  function renderDuplicateResults(shell) {
    if (state.loading && !state.groups.length) {
      shell.appendChild(el("div", "stash-dc-empty", "Scanning database..."));
      return;
    }
    const groups = filteredGroups();
    if (!groups.length) {
      shell.appendChild(el("div", "stash-dc-empty", state.loaded ? "No duplicates found for the current scan." : "Choose a scan mode, then press Scan."));
      return;
    }
    const list = el("div", "stash-dc-groups");
    groups.forEach((group, index) => list.appendChild(renderGroup(group, index)));
    shell.appendChild(list);
  }

  function renderUnusedTagResults(shell) {
    if (state.loading && !state.unusedTags.length) {
      shell.appendChild(el("div", "stash-dc-empty", "Scanning tags..."));
      return;
    }
    const tags = filteredUnusedTags();
    if (!tags.length) {
      shell.appendChild(el("div", "stash-dc-empty", state.tagsLoaded ? "No unused tags found." : "Press Scan Tags to find unused tags."));
      return;
    }
    const actions = el("div", "stash-dc-tag-actions");
    const selected = selectedUnusedTags().length;
    const selectAll = el("button", "stash-dc-refresh", "Select Visible");
    selectAll.type = "button";
    selectAll.addEventListener("click", () => setAllTagsSelected(true));
    const clear = el("button", "stash-dc-refresh", "Clear");
    clear.type = "button";
    clear.addEventListener("click", () => setAllTagsSelected(false));
    const remove = el("button", "stash-dc-danger", `Delete Selected (${selected})`);
    remove.type = "button";
    remove.disabled = !selected || state.loading;
    remove.addEventListener("click", deleteSelectedTags);
    actions.append(selectAll, clear, remove);
    shell.appendChild(actions);
    const list = el("div", "stash-dc-tags");
    tags.forEach((tag) => list.appendChild(renderTag(tag)));
    shell.appendChild(list);
  }

  function renderInto(container) {
    container.className = "stash-dc-app";
    clear(container);
    const shell = el("section", "stash-dc-shell");
    const titlebar = el("div", "stash-dc-titlebar");
    titlebar.appendChild(el("h1", "", state.tool === "tags" ? "Unused Tags" : "Stash Cleanup"));
    titlebar.appendChild(el("p", "", state.tool === "tags" ? "Find tags that are not attached to any objects." : "Find scenes that share fingerprints or likely matching file properties."));
    shell.appendChild(titlebar);
    renderToolbar(shell);
    if (state.error) shell.appendChild(el("div", "stash-dc-error", state.error));
    if (state.status) shell.appendChild(el("div", "stash-dc-status", state.status));
    if (state.tool === "tags") renderUnusedTagResults(shell);
    else renderDuplicateResults(shell);
    container.appendChild(shell);
    if (state.tool === "tags" && state.tagScanRequested && !state.tagsLoaded && !state.loading && !state.error) loadUnusedTags(false);
    if (state.tool === "duplicates" && state.scanRequested && !state.loaded && !state.loading && !state.error) loadDuplicates(false);
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
      console.error("[Stash Cleanup] render failed", error);
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
