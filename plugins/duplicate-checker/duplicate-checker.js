(function () {
  "use strict";

  const ROUTE = "/duplicate-checker";
  const NAV_ID = "stash-duplicate-checker-nav";
  const LAUNCHER_ID = "stash-duplicate-checker-launcher";
  const APP_ID = "stash-duplicate-checker-root";
  const MERGE_LOG_KEY = "stash-cleanup-merge-log-v1";
  const PAGE_SIZE = 250;
  const MAX_PAGES = 200;
  const CLEANUP_ICON =
    '<svg aria-hidden="true" focusable="false" class="svg-inline--fa fa-icon nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0 stash-dc-nav-icon" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M3 21h12M5 21v-5.5m8 5.5v-5.5M4.5 15.5h10M9 3l6 6m-7.5 4.5 9-9a2.1 2.1 0 0 1 3 3l-9 9m-3-3 3 3M16 3.5l4.5 4.5M18.5 14l.6 1.7L21 16.3l-1.9.6-.6 1.8-.6-1.8-1.9-.6 1.9-.6.6-1.7Z"/>' +
    "</svg>";

  const state = {
    routeRegistered: false,
    routeContainer: null,
    tool: "duplicates",
    loading: false,
    error: "",
    status: "",
    groups: [],
    allTags: [],
    unusedTags: [],
    tagReviewGroups: [],
    mergeLog: [],
    selectedTagIds: new Set(),
    tagMergeSelections: new Map(),
    protectedTagIds: new Set(),
    mode: "fingerprint",
    search: "",
    loaded: false,
    tagsLoaded: false,
    tagReviewLoaded: false,
    scanRequested: false,
    tagScanRequested: false,
    tagReviewScanRequested: false,
  };

  const HASH_FIELDS = ["checksum", "oshash", "phash"];
  const TAG_MERGE_TARGETS = [
    { label: "scenes", query: "findScenes", list: "scenes", mutation: "sceneUpdate", input: "SceneUpdateInput" },
    { label: "galleries", query: "findGalleries", list: "galleries", mutation: "galleryUpdate", input: "GalleryUpdateInput" },
    { label: "images", query: "findImages", list: "images", mutation: "imageUpdate", input: "ImageUpdateInput" },
    { label: "performers", query: "findPerformers", list: "performers", mutation: "performerUpdate", input: "PerformerUpdateInput" },
    { label: "studios", query: "findStudios", list: "studios", mutation: "studioUpdate", input: "StudioUpdateInput" },
    { label: "groups", query: "findGroups", list: "groups", mutation: "groupUpdate", input: "GroupUpdateInput" },
  ];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function loadMergeLog() {
    try {
      const items = JSON.parse(window.localStorage.getItem(MERGE_LOG_KEY) || "[]");
      state.mergeLog = Array.isArray(items) ? items.slice(0, 100) : [];
    } catch (error) {
      state.mergeLog = [];
      console.warn("[Stash Cleanup] merge log could not be loaded", error);
    }
  }

  function saveMergeLog() {
    try {
      window.localStorage.setItem(MERGE_LOG_KEY, JSON.stringify(state.mergeLog.slice(0, 100)));
    } catch (error) {
      console.warn("[Stash Cleanup] merge log could not be saved", error);
    }
  }

  function addMergeLogEntry(entry) {
    state.mergeLog = [{ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, createdAt: new Date().toISOString(), ...entry }, ...state.mergeLog].slice(0, 100);
    saveMergeLog();
  }

  function clearMergeLog() {
    if (!state.mergeLog.length) return;
    if (!window.confirm(`Clear ${state.mergeLog.length} merge log entries?`)) return;
    state.mergeLog = [];
    saveMergeLog();
    render();
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
    const preferred = document.querySelector("nav .navbar-nav") || document.querySelector(".navbar-collapse .navbar-nav");
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
      const scenesLink = document.querySelector('a[href="/scenes"]') || document.querySelector('a[href="/scenes/"]');
      if (!nav || !scenesLink) return;
      const wrap = el("div", "stash-dc-nav-wrap");
      wrap.id = NAV_ID;
      wrap.className = scenesLink.parentElement ? scenesLink.parentElement.className : "nav-item";
      const link = el("a", "");
      link.href = ROUTE;
      link.id = "stash-dc-nav-button";
      link.title = "Stash Cleanup";
      link.setAttribute("aria-label", "Stash Cleanup");
      link.className = `${scenesLink.className.replace(/\bactive\b/g, "").trim()} stash-dc-nav-button`.trim();
      link.innerHTML = `${CLEANUP_ICON}<span>Cleanup</span>`;
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

  async function graphqlInputFields(typeName) {
    const data = await graphql(
      `query StashCleanupInputFields($name: String!) {
        __type(name: $name) {
          inputFields { name }
        }
      }`,
      { name: typeName }
    );
    return new Set((((data && data.__type) || {}).inputFields || []).map((field) => field.name));
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
    const countFields = ["scene_count", "gallery_count", "image_count", "group_count", "performer_count", "studio_count", "marker_count"].filter((field) =>
      tagFields.has(field)
    );
    const optionalFields = ["aliases"].filter((field) => tagFields.has(field));
    return `query DuplicateCheckerTags($filter: FindFilterType) {
      findTags(filter: $filter) {
        count
        tags {
          id name
          ${countFields.join("\n          ")}
          ${optionalFields.join("\n          ")}
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
    return ["scene_count", "gallery_count", "image_count", "group_count", "performer_count", "studio_count", "marker_count"].reduce(
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
      const usableFields = ["scene_count", "gallery_count", "image_count", "group_count", "performer_count", "studio_count", "marker_count"].filter((field) =>
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

  function tagName(tag) {
    return String((tag && tag.name) || "").trim();
  }

  function tagAliases(tag) {
    return Array.isArray(tag && tag.aliases) ? tag.aliases.filter(Boolean) : [];
  }

  function tagSearchText(tag) {
    return [tagName(tag), ...tagAliases(tag)].join(" ").toLowerCase();
  }

  function simplifiedTagName(name) {
    return normalizeText(name)
      .replace(/\b(female|male|woman|women|girl|girls|man|men|boy|boys)\b/g, "")
      .replace(/\b(pussy|cunt|vagina|labia|genitals)\b/g, "genitals")
      .replace(/\b(boobs|tits|breasts)\b/g, "breasts")
      .replace(/\b(ass|butt|buttocks)\b/g, "ass")
      .replace(/\bblowjobs\b/g, "blowjob")
      .replace(/\s+/g, " ")
      .trim();
  }

  function looseTagKey(name) {
    return simplifiedTagName(name)
      .replace(/\([^)]*\)/g, "")
      .replace(/\bhd|4k|vr|pov\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function singularish(value) {
    return String(value || "")
      .split(" ")
      .map((part) => (part.length > 4 && part.endsWith("s") ? part.slice(0, -1) : part))
      .join(" ");
  }

  function tagScore(tag) {
    return tagUsageCount(tag) * 10 + tagAliases(tag).length * 2 + Math.max(0, 40 - tagName(tag).length);
  }

  function bestTag(tags) {
    return tags.slice().sort((a, b) => tagScore(b) - tagScore(a) || tagName(a).localeCompare(tagName(b)))[0];
  }

  function tagGroupSignature(tags) {
    return tags.map((tag) => String(tag.id)).sort((a, b) => Number(a) - Number(b)).join(",");
  }

  function tagReviewGroupKey(group) {
    return tagGroupSignature(group.tags);
  }

  function mergeSelectionFor(group) {
    const key = tagReviewGroupKey(group);
    if (!state.tagMergeSelections.has(key)) {
      state.tagMergeSelections.set(key, { keepId: String(group.keep.id), sourceIds: new Set() });
    }
    const selection = state.tagMergeSelections.get(key);
    if (!group.tags.some((tag) => String(tag.id) === selection.keepId)) selection.keepId = String(group.keep.id);
    selection.sourceIds.delete(selection.keepId);
    return selection;
  }

  function setMergeKeep(group, tag) {
    const selection = mergeSelectionFor(group);
    selection.keepId = String(tag.id);
    selection.sourceIds.delete(selection.keepId);
    render();
  }

  function toggleMergeSource(group, tag) {
    const selection = mergeSelectionFor(group);
    const id = String(tag.id);
    if (id === selection.keepId) return;
    if (selection.sourceIds.has(id)) selection.sourceIds.delete(id);
    else selection.sourceIds.add(id);
    render();
  }

  function setAllMergeSources(group, selected) {
    const selection = mergeSelectionFor(group);
    selection.sourceIds = selected
      ? new Set(group.tags.map((tag) => String(tag.id)).filter((id) => id !== selection.keepId))
      : new Set();
    render();
  }

  function addTagReviewGroup(output, seen, type, reason, tags, confidence) {
    const unique = Array.from(new Map(tags.filter(Boolean).map((tag) => [String(tag.id), tag])).values());
    if (unique.length < 2) return;
    const signature = tagGroupSignature(unique);
    if (seen.has(signature)) return;
    seen.add(signature);
    const keep = bestTag(unique);
    output.push({
      type,
      reason,
      confidence,
      keep,
      tags: unique.sort((a, b) => tagUsageCount(b) - tagUsageCount(a) || tagName(a).localeCompare(tagName(b))),
    });
  }

  function buildTagReviewGroups(tags) {
    const groups = [];
    const seen = new Set();
    const byExact = new Map();
    const byLoose = new Map();
    const bySingular = new Map();

    tags.forEach((tag) => {
      const name = tagName(tag);
      const exact = normalizeText(name);
      const loose = looseTagKey(name);
      const singular = singularish(loose);
      if (exact) {
        if (!byExact.has(exact)) byExact.set(exact, []);
        byExact.get(exact).push(tag);
      }
      if (loose) {
        if (!byLoose.has(loose)) byLoose.set(loose, []);
        byLoose.get(loose).push(tag);
      }
      if (singular) {
        if (!bySingular.has(singular)) bySingular.set(singular, []);
        bySingular.get(singular).push(tag);
      }
    });

    byExact.forEach((items) => addTagReviewGroup(groups, seen, "Duplicate name", "Same normalized name; usually safe to merge.", items, "High"));
    bySingular.forEach((items) => addTagReviewGroup(groups, seen, "Plural/casing variant", "Only plural/casing/punctuation appears to differ.", items, "High"));
    byLoose.forEach((items) => addTagReviewGroup(groups, seen, "Likely synonym", "Normalized common words look equivalent. Review before merging.", items, "Medium"));

    const lowUse = tags
      .filter((tag) => tagUsageCount(tag) > 0 && tagUsageCount(tag) <= 2)
      .sort((a, b) => tagUsageCount(a) - tagUsageCount(b) || tagName(a).localeCompare(tagName(b)))
      .slice(0, 80);
    lowUse.forEach((tag) => {
      const base = looseTagKey(tagName(tag));
      const candidates = tags
        .filter((other) => String(other.id) !== String(tag.id) && tagUsageCount(other) >= 10)
        .filter((other) => {
          const otherBase = looseTagKey(tagName(other));
          return base && otherBase && (base.includes(otherBase) || otherBase.includes(base));
        })
        .slice(0, 4);
      if (candidates.length) addTagReviewGroup(groups, seen, "Low-use narrow tag", "Rare tag overlaps with a busier tag. This may be noise or may be intentionally specific.", [tag, ...candidates], "Low");
    });

    const junk = tags.filter((tag) => {
      const name = tagName(tag);
      return /https?:|www\.|^\d+$|[_]{2,}|[?=&]/i.test(name) || name.length > 48 || tagUsageCount(tag) <= 1 && /[-_]{2,}|\bunknown\b|\bother\b/i.test(name);
    });
    junk.slice(0, 80).forEach((tag) => {
      const candidates = tags.filter((other) => String(other.id) !== String(tag.id) && looseTagKey(tagName(other)) === looseTagKey(tagName(tag))).slice(0, 3);
      addTagReviewGroup(groups, seen, "Possible junk tag", "Name looks imported, overly long, or low-value. Review before deleting or aliasing.", [tag, ...candidates], "Low");
    });

    return groups.sort((a, b) => {
      const rank = { High: 0, Medium: 1, Low: 2 };
      return rank[a.confidence] - rank[b.confidence] || tagUsageCount(b.keep) - tagUsageCount(a.keep) || a.type.localeCompare(b.type);
    });
  }

  async function loadTagReview(force) {
    if (state.tagReviewLoaded && !force) return;
    state.loading = true;
    state.error = "";
    state.status = "Scanning tags for cleanup suggestions...";
    render();
    try {
      const tagFields = await graphqlTypeFields("Tag");
      const tags = await loadPagedTags(buildTagQuery(tagFields));
      state.allTags = tags.sort((a, b) => tagName(a).localeCompare(tagName(b)));
      state.tagReviewGroups = buildTagReviewGroups(state.allTags);
      state.tagMergeSelections = new Map();
      state.tagReviewLoaded = true;
      const usedTags = tags.filter((tag) => tagUsageCount(tag) > 0).length;
      state.status = `${state.tagReviewGroups.length} suggestion groups from ${tags.length} tags (${usedTags} used)`;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
      console.error("[Stash Cleanup] tag review scan failed", error);
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

  function uniqueIds(ids) {
    return Array.from(new Set(ids.map((id) => String(id)).filter(Boolean)));
  }

  function objectTagIds(object) {
    return Array.isArray(object && object.tags) ? object.tags.map((tag) => String(tag.id)).filter(Boolean) : [];
  }

  async function loadPagedTaggedObjects(target) {
    const items = [];
    let total = 0;
    const query = `query StashCleanupTaggedObjects($filter: FindFilterType) {
      ${target.query}(filter: $filter) {
        count
        ${target.list} {
          id
          tags { id }
        }
      }
    }`;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      state.status = `Scanning ${target.label} page ${page}...`;
      render();
      const data = await graphql(query, { filter: { page, per_page: PAGE_SIZE } });
      const result = data && data[target.query];
      const pageItems = (result && result[target.list]) || [];
      total = result && typeof result.count === "number" ? result.count : items.length + pageItems.length;
      items.push(...pageItems);
      if (!pageItems.length || items.length >= total || pageItems.length < PAGE_SIZE) break;
    }
    return items;
  }

  async function updateTaggedObject(target, object, tagIds) {
    const input = { id: object.id, tag_ids: tagIds };
    const withSelection = `mutation StashCleanupUpdateTaggedObject($input: ${target.input}!) {
      ${target.mutation}(input: $input) { id }
    }`;
    try {
      await graphql(withSelection, { input });
      return;
    } catch (error) {
      const message = error.message || String(error);
      if (!message.includes("must not have a selection") && !message.includes("has no subfields")) throw error;
    }
    await graphql(
      `mutation StashCleanupUpdateTaggedObject($input: ${target.input}!) {
        ${target.mutation}(input: $input)
      }`,
      { input }
    );
  }

  async function mergeTargetTags(target, keepId, sourceIds) {
    const inputFields = await graphqlInputFields(target.input);
    if (!inputFields.has("id") || !inputFields.has("tag_ids")) return { target, updated: 0, skipped: true };

    const objects = await loadPagedTaggedObjects(target);
    let updated = 0;
    for (let index = 0; index < objects.length; index += 1) {
      const object = objects[index];
      const tagIds = objectTagIds(object);
      if (!tagIds.some((id) => sourceIds.has(id))) continue;
      const nextTagIds = uniqueIds([...tagIds.filter((id) => !sourceIds.has(id)), keepId]);
      if (nextTagIds.join(",") === tagIds.join(",")) continue;
      state.status = `Updating ${target.label} ${updated + 1}...`;
      render();
      await updateTaggedObject(target, object, nextTagIds);
      updated += 1;
    }
    return { target, updated, skipped: false };
  }

  async function destroyMergedTags(tags) {
    const failed = [];
    for (let index = 0; index < tags.length; index += 1) {
      state.status = `Deleting merged tag ${index + 1} of ${tags.length}...`;
      render();
      try {
        await graphql(
          `mutation StashCleanupTagDestroy($id: ID!) {
            tagDestroy(input: { id: $id })
          }`,
          { id: tags[index].id }
        );
      } catch (error) {
        failed.push({ tag: tags[index], message: error.message || String(error) });
        state.protectedTagIds.add(String(tags[index].id));
        console.warn("[Stash Cleanup] merged tag delete failed", tags[index], error);
      }
    }
    return failed;
  }

  async function mergeTagReviewGroup(group) {
    const selection = mergeSelectionFor(group);
    const keep = group.tags.find((tag) => String(tag.id) === selection.keepId);
    const sourceTags = group.tags.filter((tag) => selection.sourceIds.has(String(tag.id)) && String(tag.id) !== selection.keepId);
    if (!keep || !sourceTags.length) return;

    const names = sourceTags.map(tagName).join(", ");
    if (!window.confirm(`Merge ${sourceTags.length} tags into "${tagName(keep)}"?\n\n${names}\n\nThis updates tagged objects first, then deletes the merged tags.`)) return;

    state.loading = true;
    state.error = "";
    state.status = `Preparing merge into "${tagName(keep)}"...`;
    render();
    try {
      const [queryFields, mutationFields] = await Promise.all([graphqlTypeFields("Query"), graphqlTypeFields("Mutation")]);
      if (!mutationFields.has("tagDestroy")) throw new Error("tagDestroy mutation is not available in this Stash GraphQL schema.");
      const keepId = String(keep.id);
      const sourceIds = new Set(sourceTags.map((tag) => String(tag.id)));
      const supportedTargets = TAG_MERGE_TARGETS.filter((target) => queryFields.has(target.query) && mutationFields.has(target.mutation));
      const results = [];
      for (let index = 0; index < supportedTargets.length; index += 1) {
        const target = supportedTargets[index];
        try {
          results.push(await mergeTargetTags(target, keepId, sourceIds));
        } catch (error) {
          console.warn("[Stash Cleanup] tag merge target failed", target, error);
          results.push({ target, updated: 0, skipped: true, message: error.message || String(error) });
        }
      }
      const failedDeletes = await destroyMergedTags(sourceTags);
      addMergeLogEntry({
        keep: { id: keep.id, name: tagName(keep) },
        merged: sourceTags.map((tag) => ({ id: tag.id, name: tagName(tag), uses: tagUsageCount(tag) })),
        deleted: sourceTags.length - failedDeletes.length,
        failedDeletes: failedDeletes.map((entry) => ({ id: entry.tag.id, name: tagName(entry.tag), message: entry.message })),
        updates: results.map((result) => ({
          target: result.target.label,
          updated: result.updated || 0,
          skipped: Boolean(result.skipped),
          message: result.message || "",
        })),
      });
      state.tagReviewLoaded = false;
      await loadTagReview(true);
      const updated = results.filter((result) => !result.skipped && result.updated).map((result) => `${result.updated} ${result.target.label}`).join(", ");
      state.status = `Merged ${sourceTags.length - failedDeletes.length} tags into "${tagName(keep)}"${updated ? `; updated ${updated}` : ""}`;
      if (failedDeletes.length) {
        const failedNames = failedDeletes.slice(0, 6).map((entry) => tagName(entry.tag)).join(", ");
        const extra = failedDeletes.length > 6 ? ` and ${failedDeletes.length - 6} more` : "";
        state.error = `${failedDeletes.length} merged tags could not be deleted, usually because Stash still uses them as marker primary tags: ${failedNames}${extra}`;
      }
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
      console.error("[Stash Cleanup] tag merge failed", error);
    } finally {
      state.loading = false;
      render();
    }
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
      ["tag-review", "Tag Review"],
      ["merge-log", "Merge Log"],
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
    search.placeholder =
      state.tool === "tags"
        ? "Search unused tags"
        : state.tool === "tag-review"
          ? "Search tag suggestions"
          : state.tool === "merge-log"
            ? "Search merge log"
            : "Search titles, paths, performers, tags";
    search.value = state.search;
    search.addEventListener("input", () => {
      state.search = search.value;
      render();
    });

    const refresh = el(
      "button",
      state.tool === "merge-log" ? "stash-dc-danger" : "stash-dc-refresh",
      state.tool === "tags" ? "Scan Tags" : state.tool === "tag-review" ? "Review Tags" : state.tool === "merge-log" ? "Clear Log" : "Scan"
    );
    refresh.type = "button";
    refresh.disabled = state.tool === "merge-log" && !state.mergeLog.length;
    refresh.addEventListener("click", () => {
      if (state.tool === "tags") {
        state.tagsLoaded = false;
        state.tagScanRequested = true;
        loadUnusedTags(true);
      } else if (state.tool === "tag-review") {
        state.tagReviewLoaded = false;
        state.tagReviewScanRequested = true;
        loadTagReview(true);
      } else if (state.tool === "merge-log") {
        clearMergeLog();
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

  function filteredTagReviewGroups() {
    const term = state.search.trim().toLowerCase();
    if (!term) return state.tagReviewGroups;
    return state.tagReviewGroups.filter((group) =>
      [group.type, group.reason, ...group.tags.map(tagSearchText)].join(" ").toLowerCase().includes(term)
    );
  }

  function filteredMergeLog() {
    const term = state.search.trim().toLowerCase();
    if (!term) return state.mergeLog;
    return state.mergeLog.filter((entry) =>
      [
        entry.keep && entry.keep.name,
        entry.keep && entry.keep.id,
        ...(entry.merged || []).flatMap((tag) => [tag.name, tag.id]),
        ...(entry.updates || []).flatMap((update) => [update.target, update.updated, update.message]),
        ...(entry.failedDeletes || []).flatMap((tag) => [tag.name, tag.id, tag.message]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term)
    );
  }

  function formatLogDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || "";
    return date.toLocaleString();
  }

  function renderMergeLogEntry(entry) {
    const item = el("section", "stash-dc-log-entry");
    const header = el("div", "stash-dc-group-header");
    header.appendChild(el("h2", "", (entry.keep && entry.keep.name) || "Unknown keep tag"));
    header.appendChild(el("span", "stash-dc-badge", `${(entry.merged || []).length} merged`));
    header.appendChild(el("span", "stash-dc-type", formatLogDate(entry.createdAt)));
    item.appendChild(header);

    const merged = (entry.merged || []).map((tag) => `${tag.name || `Tag ${tag.id}`} (${tag.uses || 0})`).join(", ");
    item.appendChild(el("div", "stash-dc-key", `Kept tag ID ${(entry.keep && entry.keep.id) || "?"}; merged: ${merged || "none"}`));

    const chips = el("div", "stash-dc-log-chips");
    (entry.updates || []).forEach((update) => {
      const label = update.skipped ? `${update.target}: skipped` : `${update.target}: ${update.updated}`;
      chips.appendChild(el("span", update.skipped ? "stash-dc-chip stash-dc-chip-muted" : "stash-dc-chip", label));
    });
    chips.appendChild(el("span", "stash-dc-chip", `deleted: ${entry.deleted || 0}`));
    if ((entry.failedDeletes || []).length) chips.appendChild(el("span", "stash-dc-chip stash-dc-chip-warn", `delete failed: ${entry.failedDeletes.length}`));
    item.appendChild(chips);

    if ((entry.failedDeletes || []).length) {
      const failed = (entry.failedDeletes || []).map((tag) => `${tag.name || `Tag ${tag.id}`}: ${tag.message || "failed"}`).join("; ");
      item.appendChild(el("div", "stash-dc-error", failed));
    }
    return item;
  }

  function renderTagReviewGroup(group, index) {
    const selection = mergeSelectionFor(group);
    const selectedCount = selection.sourceIds.size;
    const section = el("section", "stash-dc-review-group");
    const header = el("div", "stash-dc-group-header");
    header.appendChild(el("h2", "", `${group.type} ${index + 1}`));
    header.appendChild(el("span", "stash-dc-badge", group.confidence));
    header.appendChild(el("span", "stash-dc-type", `${group.tags.length} tags`));
    section.appendChild(header);
    section.appendChild(el("div", "stash-dc-key", group.reason));

    const keep = el("div", "stash-dc-review-keep");
    keep.appendChild(el("span", "stash-dc-review-label", "Keep tag"));
    const keepButton = el("button", "stash-dc-review-tag is-keep", `${tagName(group.tags.find((tag) => String(tag.id) === selection.keepId) || group.keep)} (${tagUsageCount(group.tags.find((tag) => String(tag.id) === selection.keepId) || group.keep)})`);
    keepButton.type = "button";
    keepButton.addEventListener("click", () => openTag(group.tags.find((tag) => String(tag.id) === selection.keepId) || group.keep));
    keep.appendChild(keepButton);
    section.appendChild(keep);

    const actions = el("div", "stash-dc-review-actions");
    const selectAll = el("button", "stash-dc-refresh", "Select Merge Tags");
    selectAll.type = "button";
    selectAll.addEventListener("click", () => setAllMergeSources(group, true));
    const clear = el("button", "stash-dc-refresh", "Clear");
    clear.type = "button";
    clear.addEventListener("click", () => setAllMergeSources(group, false));
    const merge = el("button", "stash-dc-danger", `Merge Selected (${selectedCount})`);
    merge.type = "button";
    merge.disabled = !selectedCount || state.loading;
    merge.addEventListener("click", () => mergeTagReviewGroup(group));
    actions.append(selectAll, clear, merge);
    section.appendChild(actions);

    const list = el("div", "stash-dc-review-tags");
    group.tags.forEach((tag) => {
      const id = String(tag.id);
      const card = el("div", `stash-dc-review-tag ${id === selection.keepId ? "is-keep" : ""}`);
      const controls = el("div", "stash-dc-review-controls");
      const keepLabel = el("label", "stash-dc-review-choice");
      const keepRadio = el("input", "");
      keepRadio.type = "radio";
      keepRadio.name = `stash-dc-keep-${tagReviewGroupKey(group)}`;
      keepRadio.checked = id === selection.keepId;
      keepRadio.addEventListener("change", () => setMergeKeep(group, tag));
      keepLabel.append(keepRadio, el("span", "", "Keep"));
      const mergeLabel = el("label", "stash-dc-review-choice");
      const mergeCheck = el("input", "");
      mergeCheck.type = "checkbox";
      mergeCheck.disabled = id === selection.keepId;
      mergeCheck.checked = selection.sourceIds.has(id);
      mergeCheck.addEventListener("change", () => toggleMergeSource(group, tag));
      mergeLabel.append(mergeCheck, el("span", "", "Merge"));
      controls.append(keepLabel, mergeLabel);
      card.appendChild(controls);
      const open = el("button", "stash-dc-review-open");
      open.type = "button";
      open.addEventListener("click", () => openTag(tag));
      open.appendChild(el("span", "stash-dc-review-name", tagName(tag)));
      open.appendChild(el("span", "stash-dc-review-count", `${tagUsageCount(tag)} uses`));
      const aliases = tagAliases(tag);
      if (aliases.length) open.appendChild(el("span", "stash-dc-review-aliases", aliases.slice(0, 3).join(", ")));
      card.appendChild(open);
      list.appendChild(card);
    });
    section.appendChild(list);
    return section;
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

  function renderTagReviewResults(shell) {
    if (state.loading && !state.tagReviewGroups.length) {
      shell.appendChild(el("div", "stash-dc-empty", "Scanning tags for suggestions..."));
      return;
    }
    const groups = filteredTagReviewGroups();
    if (!groups.length) {
      shell.appendChild(el("div", "stash-dc-empty", state.tagReviewLoaded ? "No tag cleanup suggestions found." : "Press Review Tags to generate safe suggestions."));
      renderRecentMergeLog(shell);
      return;
    }
    const list = el("div", "stash-dc-review-groups");
    groups.forEach((group, index) => list.appendChild(renderTagReviewGroup(group, index)));
    shell.appendChild(list);
    renderRecentMergeLog(shell);
  }

  function renderMergeLogResults(shell) {
    const entries = filteredMergeLog();
    if (!entries.length) {
      shell.appendChild(el("div", "stash-dc-empty", state.mergeLog.length ? "No merge log entries match your search." : "No tag merges logged yet."));
      return;
    }
    const list = el("div", "stash-dc-log-list");
    entries.forEach((entry) => list.appendChild(renderMergeLogEntry(entry)));
    shell.appendChild(list);
  }

  function renderRecentMergeLog(shell) {
    if (!state.mergeLog.length) return;
    const section = el("section", "stash-dc-recent-log");
    const header = el("div", "stash-dc-group-header");
    header.appendChild(el("h2", "", "Recent Merges"));
    header.appendChild(el("span", "stash-dc-badge", `${state.mergeLog.length} logged`));
    section.appendChild(header);
    const list = el("div", "stash-dc-log-list");
    state.mergeLog.slice(0, 3).forEach((entry) => list.appendChild(renderMergeLogEntry(entry)));
    section.appendChild(list);
    shell.appendChild(section);
  }

  function renderInto(container) {
    container.className = "stash-dc-app";
    clear(container);
    const shell = el("section", "stash-dc-shell");
    const titlebar = el("div", "stash-dc-titlebar");
    titlebar.appendChild(el("h1", "", state.tool === "tags" ? "Unused Tags" : state.tool === "tag-review" ? "Tag Review" : state.tool === "merge-log" ? "Merge Log" : "Stash Cleanup"));
    titlebar.appendChild(
      el(
        "p",
        "",
        state.tool === "tags"
          ? "Find tags that are not attached to any objects."
          : state.tool === "tag-review"
            ? "Review duplicate, noisy, and low-value tags, then merge only what you select."
            : state.tool === "merge-log"
              ? "See recent tag merges stored in this browser."
              : "Find scenes that share fingerprints or likely matching file properties."
      )
    );
    shell.appendChild(titlebar);
    renderToolbar(shell);
    if (state.error) shell.appendChild(el("div", "stash-dc-error", state.error));
    if (state.status) shell.appendChild(el("div", "stash-dc-status", state.status));
    if (state.tool === "tags") renderUnusedTagResults(shell);
    else if (state.tool === "tag-review") renderTagReviewResults(shell);
    else if (state.tool === "merge-log") renderMergeLogResults(shell);
    else renderDuplicateResults(shell);
    container.appendChild(shell);
    if (state.tool === "tags" && state.tagScanRequested && !state.tagsLoaded && !state.loading && !state.error) loadUnusedTags(false);
    if (state.tool === "tag-review" && state.tagReviewScanRequested && !state.tagReviewLoaded && !state.loading && !state.error) loadTagReview(false);
    if (state.tool === "duplicates" && state.scanRequested && !state.loaded && !state.loading && !state.error) loadDuplicates(false);
  }

  function render() {
    try {
      const navButton = document.querySelector(`#${NAV_ID} .stash-dc-nav-button`);
      if (navButton) navButton.classList.toggle("active", isRoute());
      if (state.routeContainer && isRoute()) {
        renderInto(state.routeContainer);
        return;
      }
      const app = getApp();
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
    loadMergeLog();
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
  if (window.PluginApi && window.PluginApi.Event && window.PluginApi.Event.addEventListener) {
    window.PluginApi.Event.addEventListener("stash:location", () => {
      addNav();
      render();
    });
  }
  window.addEventListener("popstate", render);
  window.addEventListener("stash-duplicate-checker-route", render);
  window.addEventListener("storage", (event) => {
    if (event.key !== MERGE_LOG_KEY) return;
    loadMergeLog();
    render();
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
