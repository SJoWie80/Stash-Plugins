(function () {
  "use strict";

  const ROUTE = "/tag-image-picker";
  const NAV_ID = "stash-tip-nav";
  const LAUNCHER_ID = "stash-tip-launcher";
  const APP_ID = "stash-tip-root";
  const DONE_TAGS_KEY = "stash-tip-done-tags-v1";
  const PAGE_SIZE = 250;
  const MAX_PAGES = 80;
  const TAGS_PER_PAGE = 40;
  const ICON_SIZE = 512;

  const state = {
    tags: [],
    selectedTagId: "",
    loadingTags: false,
    saving: false,
    loaded: false,
    pluginId: "",
    error: "",
    status: "",
    search: "",
    onlyMissing: false,
    tagPage: 1,
    style: "neon",
    externalImage: "",
    externalImageName: "",
    externalUrl: "",
    sourceResults: [],
    sourceSelected: 0,
    sourceTagId: "",
    sourceQuery: "",
    manualIconQuery: "",
    loadingSourceTagId: "",
    sourceCache: {},
    previewImage: "",
    previewKey: "",
    previewLoading: false,
    tagScrollTop: 0,
    doneTagIds: loadDoneTagIds(),
    imagePresence: {},
    routeRegistered: false,
    routeContainer: null,
  };

  const THEMES = {
    neon: { name: "Neon", bg: "#101318", fg: "#f4f7fb", muted: "#8090a6", panel: "#171b23" },
    dark: { name: "Graphite", bg: "#151515", fg: "#f5efe7", muted: "#8b8177", panel: "#202124" },
    punch: { name: "Velvet", bg: "#171116", fg: "#fff4fb", muted: "#aa8fa0", panel: "#231722" },
  };

  const COLORS = {
    body: "#ff6b9a",
    action: "#ff4d5f",
    oral: "#ff4d7d",
    sex: "#ff3f6c",
    anal: "#f27a3d",
    cum: "#f8f2d8",
    bondage: "#8b6cff",
    clothing: "#47c5ff",
    location: "#43d17a",
    role: "#ffd166",
    camera: "#64d2ff",
    tech: "#4ee3ff",
    mood: "#ff9f43",
    relationship: "#f06595",
    meta: "#b6c2d9",
  };

  const RULES = [
    { icon: "wet", group: "sex", words: ["wet", "visible wetness", "how wet", "a bit wet", "oiled", "oil", "wet look"] },
    { icon: "amateur", group: "camera", words: ["amateur", "homemade", "selfie", "sextape"] },
    { icon: "braces", group: "body", words: ["braces"] },
    { icon: "breastsmouth", group: "oral", words: ["breast sucking", "breast licking", "breast kissing", "tits sucking", "big tits worship", "ass worship"] },
    { icon: "buttplug", group: "sex", words: ["butt plug"] },
    { icon: "analcum", group: "anal", words: ["anal creampie", "anal cum", "cum on ass", "ass to mouth"] },
    { icon: "creampie", group: "cum", words: ["vaginal creampie", "creampie", "cream pie"] },
    { icon: "threed", group: "tech", words: ["3d"] },
    { icon: "resolution", group: "tech", words: ["4k", "5k", "6k", "7k", "3k", "hd", "full hd"] },
    { icon: "fps", group: "tech", words: ["fps", "60 fps"] },
    { icon: "vr", group: "tech", words: ["vr", "virtual reality", "180", "200", "220", "360"] },
    { icon: "tech", group: "tech", words: ["4k", "5k", "6k", "7k", "3k", "hd", "fps", "3d", "vr", "virtual reality", "180", "200", "220", "360"] },
    { icon: "camera", group: "camera", words: ["pov", "close", "front", "sideview", "frontview", "rearview", "low angle", "plow cam", "fisheye", "camera"] },
    { icon: "location", group: "location", words: ["bedroom", "bathroom", "kitchen", "office", "school", "classroom", "beach", "garden", "gym", "car", "pool", "spa", "field", "dungeon", "store", "prison", "home", "outdoors", "outside", "indoors", "stairs", "table", "desk", "couch", "bed", "bath", "shower"] },
    { icon: "role", group: "role", words: ["teacher", "student", "nurse", "doctor", "maid", "cop", "boss", "secretary", "coach", "babysitter", "girlfriend", "wife", "husband", "boyfriend", "roomie", "neighbor", "tutor", "assistant", "bodyguard", "bartender", "barber", "delivery", "handyman", "military"] },
    { icon: "bondage", group: "bondage", words: ["bdsm", "bondage", "handcuffs", "chains", "restraints", "leash", "collar", "gag", "blindfold", "clamps", "slave", "submission", "submissive", "domination", "femdom", "maledom", "punishment"] },
    { icon: "toy", group: "sex", words: ["dildo", "vibrator", "hitachi", "magic wand", "butt plug", "sex toy", "toys", "object insertion", "fucking machines"] },
    { icon: "cum", group: "cum", words: ["cum", "creampie", "facial", "swallowing", "drip", "cream"] },
    { icon: "mouth", group: "oral", words: ["blowjob", "blow job", "oral", "deepthroat", "gagging", "mouth", "licking", "sucking", "rimming", "asslicking", "eats her out", "pussy eating", "face fuck"] },
    { icon: "vulva", group: "sex", words: ["pussy", "clit", "vaginal", "labia", "tribbing", "scissoring", "squirting", "wet pussy", "innie"] },
    { icon: "butt", group: "anal", words: ["anal", "ass", "butt", "bum", "gaping", "rim", "pawg", "bubble butt"] },
    { icon: "penis", group: "sex", words: ["cock", "dick", "bbc", "uncircumcised", "circumcised", "trimmed dick", "erect"] },
    { icon: "breasts", group: "body", words: ["tits", "boobs", "breast", "nipples", "areolas", "topless"] },
    { icon: "feet", group: "body", words: ["feet", "foot", "toe", "barefoot", "socks", "heels", "peeptoe", "shoes", "boots", "sandals", "pumps", "wedges"] },
    { icon: "hair", group: "body", words: ["hair", "blonde", "brunette", "red hair", "black hair", "braids", "ponytail", "pigtails", "dreadlocks", "hair bun"] },
    { icon: "eye", group: "body", words: ["eyes", "contact", "glasses", "heterochromia"] },
    { icon: "clothing", group: "clothing", words: ["lingerie", "bra", "panties", "thong", "dress", "skirt", "stockings", "pantyhose", "bikini", "uniform", "cosplay", "costume", "latex", "leather", "fishnet", "jeans", "shorts", "shirt", "hoodie", "robe", "underwear"] },
    { icon: "group", group: "relationship", words: ["lesbian", "threesome", "foursome", "gangbang", "group", "orgy", "couple", "multiple", "twosome", "interracial"] },
    { icon: "heart", group: "mood", words: ["romantic", "passion", "intimate", "aftercare", "cuddling", "kissing", "girlfriend", "adorable", "shy", "innocent"] },
    { icon: "flame", group: "action", words: ["hardcore", "rough", "aggressive", "hard fuck", "deep", "slapping", "spanking", "choking", "hair pulling", "dirty talk", "kinky", "fetish"] },
    { icon: "person", group: "body", words: ["asian", "black", "white", "latin", "latina", "trans", "woman", "man", "milf", "mature", "teen", "young", "athletic", "bbw", "skinny", "slim", "curvy", "muscular", "tall", "short"] },
    { icon: "star", group: "meta", words: ["favourite", "favorite", "watch later", "available", "quality", "collection", "process", "feature", "series"] },
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

  function loadDoneTagIds() {
    try {
      const raw = window.localStorage && window.localStorage.getItem(DONE_TAGS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function saveDoneTagIds() {
    try {
      if (window.localStorage) window.localStorage.setItem(DONE_TAGS_KEY, JSON.stringify(state.doneTagIds));
    } catch (error) {
      console.warn("[Tag Icon Studio] could not persist completed tag list", error);
    }
  }

  function markTagDone(id) {
    if (!id) return;
    state.doneTagIds[id] = true;
    state.imagePresence[id] = true;
    saveDoneTagIds();
  }

  function ensureSelectedVisible() {
    const visible = filteredTags();
    if (visible.some((tag) => tag.id === state.selectedTagId)) return;
    const start = Math.max(0, (state.tagPage - 1) * TAGS_PER_PAGE);
    state.selectedTagId = (visible[start] || visible[0] || {}).id || "";
    state.sourceResults = [];
    state.sourceSelected = 0;
    state.externalImage = "";
    state.externalImageName = "";
    state.sourceTagId = "";
    state.previewImage = "";
    state.previewKey = "";
    if (state.selectedTagId) window.setTimeout(() => loadSourceIcon(state.selectedTagId), 0);
  }

  function captureTagScroll() {
    const list = document.querySelector(".stash-tip-tags");
    if (list) state.tagScrollTop = list.scrollTop;
  }

  function restoreTagScroll(list) {
    const top = state.tagScrollTop || 0;
    window.requestAnimationFrame(() => {
      list.scrollTop = top;
      window.setTimeout(() => {
        list.scrollTop = top;
      }, 0);
    });
  }

  function normalize(value) {
    return String(value || "").toLowerCase().replace(/[–—]/g, "-");
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
      link.setAttribute("aria-label", "Tag Icons");
      link.appendChild(el("span", "fa fa-icons fas fa-shapes stash-tip-nav-icon"));
      link.appendChild(el("span", "stash-tip-nav-text", "Tag Icons"));
      link.addEventListener("click", navigate);
      wrap.appendChild(link);
      nav.appendChild(wrap);
      removeLauncher();
    } catch (error) {
      console.error("[Tag Icon Studio] failed adding nav", error);
    }
  }

  function addMenuEntries() {
    addNav();
  }

  function removeLauncher() {
    const launcher = document.getElementById(LAUNCHER_ID);
    if (launcher) launcher.remove();
  }

  function addLauncher() {
    if (document.getElementById(NAV_ID) || document.getElementById(LAUNCHER_ID)) return;
    const launcher = el("button", "stash-tip-launcher", "Tag Icons");
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
    const data = await graphql("query TagIconStudioPluginId { plugins { id name } }", {});
    const plugin = ((data && data.plugins) || []).find((item) => item && item.name === "Tag Icon Studio");
    if (!plugin || !plugin.id) throw new Error("Tag Icon Studio plugin ID kon niet worden gevonden");
    state.pluginId = plugin.id;
    return state.pluginId;
  }

  async function pluginOperation(args) {
    const pluginId = await getPluginId();
    const data = await graphql(
      "mutation TagIconStudioOperation($pluginId: ID!, $args: Map) { runPluginOperation(plugin_id: $pluginId, args: $args) }",
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
      let all;
      try {
        all = await loadTagsPaged(true);
      } catch (fullError) {
        console.warn("[Tag Icon Studio] full tag query failed, trying basic query", fullError);
        all = await loadTagsPaged(false);
      }
      state.tags = all;
      state.loaded = true;
      if (!state.selectedTagId && filteredTags().length) state.selectedTagId = filteredTags()[0].id;
      state.status = `${all.length} tags loaded`;
      if (state.selectedTagId) window.setTimeout(() => loadSourceIcon(state.selectedTagId), 0);
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
      console.error("[Tag Icon Studio] load tags failed", error);
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
          ? `query TagIconStudioTags($filter: FindFilterType) {
          findTags(filter: $filter) {
            count
            tags { id name image_path scene_count scene_marker_count image_count }
          }
        }`
          : `query TagIconStudioTagsBasic($filter: FindFilterType) {
          findTags(filter: $filter) {
            count
            tags { id name image_path }
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

  function selectTag(id) {
    if (state.selectedTagId === id) return;
    captureTagScroll();
    state.selectedTagId = id;
    state.error = "";
    if (!id) {
      state.sourceResults = [];
      state.sourceSelected = 0;
      state.externalImage = "";
      state.externalImageName = "";
      state.sourceTagId = "";
      state.sourceQuery = "";
      state.manualIconQuery = "";
      state.previewImage = "";
      state.previewKey = "";
      render();
      return;
    }
    const cached = state.sourceCache[id];
    state.sourceResults = cached ? cached.results : [];
    state.sourceSelected = cached ? cached.selected : 0;
    state.externalImage = cached ? cached.imageData : "";
    state.externalImageName = cached ? cached.name : "";
    state.sourceQuery = cached ? cached.query : "";
    state.manualIconQuery = "";
    state.sourceTagId = cached ? id : "";
    state.previewImage = "";
    state.previewKey = "";
    render();
    if (!cached) loadSourceIcon(id);
  }

  function tagUsage(tag) {
    return Number(tag.scene_count || 0) + Number(tag.scene_marker_count || 0) + Number(tag.image_count || 0);
  }

  function hasKnownImage(tag) {
    if (!tag) return false;
    if (state.doneTagIds[tag.id]) return true;
    if (typeof state.imagePresence[tag.id] === "boolean") return state.imagePresence[tag.id];
    if (!tag.image_path) return false;
    if (String(tag.image_path).startsWith("data:")) return true;
    return false;
  }

  function filteredTags() {
    const term = normalize(state.search);
    return state.tags
      .filter((tag) => {
        if (!state.onlyMissing) return true;
        const known = hasKnownImage(tag);
        return known !== true;
      })
      .filter((tag) => !term || normalize(tag.name).includes(term))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  function classifyTag(name) {
    const text = normalize(name);
    const rule = RULES.find((item) => item.words.some((word) => text.includes(word)));
    if (rule) return rule;
    return { icon: "tag", group: "meta" };
  }

  function hashString(input) {
    let hash = 2166136261;
    for (let index = 0; index < input.length; index += 1) {
      hash ^= input.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function accentFor(tag, group) {
    if (COLORS[group]) return COLORS[group];
    const hue = hashString(tag.name || "") % 360;
    return `hsl(${hue} 78% 62%)`;
  }

  function drawIcon(tag, style) {
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext("2d");
    const rule = classifyTag(tag.name);
    const theme = THEMES[style] || THEMES.neon;
    const accent = accentFor(tag, rule.group);
    const secondary = shade(accent, -18);

    drawBackground(ctx, theme, accent, tag.name);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    drawSymbol(ctx, rule.icon, accent, secondary, theme.fg, tag.name);
    drawCornerGlyph(ctx, rule, tag.name, accent, theme);
    return canvas.toDataURL("image/png");
  }

  function tagPrompt(tag) {
    if (!tag) return "";
    const rule = classifyTag(tag.name);
    const accent = accentFor(tag, rule.group);
    return [
      `Square 1:1 PNG icon for an adult media library tag: "${tag.name}".`,
      "Use a clean premium pictogram style, centered subject, transparent or simple dark background, high contrast, crisp edges, no text, no logo, no watermark.",
      `Brand style: dark interface, ${accent} accent color, glossy neon rim light, consistent set icon language.`,
      "Keep it symbolic and tag-focused, avoid minors, avoid real-person likenesses, avoid copyrighted characters.",
    ].join(" ");
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not load image"));
      image.src = src;
    });
  }

  async function composeExternalIcon(tag, imageData, style) {
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIZE;
    canvas.height = ICON_SIZE;
    const ctx = canvas.getContext("2d");
    const rule = classifyTag(tag.name);
    const theme = THEMES[style] || THEMES.neon;
    const accent = accentFor(tag, rule.group);
    const secondary = shade(accent, -22);
    const image = await loadImage(imageData);
    drawBackground(ctx, theme, accent, tag.name);

    ctx.save();
    roundRect(ctx, 34, 34, 444, 444, 46);
    ctx.clip();
    const panelGradient = ctx.createLinearGradient(52, 34, 460, 478);
    panelGradient.addColorStop(0, shade(theme.panel || theme.bg, 10));
    panelGradient.addColorStop(0.55, theme.bg);
    panelGradient.addColorStop(1, shade(secondary, -42));
    ctx.fillStyle = panelGradient;
    ctx.fillRect(34, 34, 444, 444);
    ctx.fillStyle = withAlpha(accent, 0.12);
    circle(ctx, 372, 130, 142);
    ctx.fillStyle = withAlpha(theme.fg, 0.035);
    circle(ctx, 116, 390, 170);
    ctx.restore();

    const iconCanvas = document.createElement("canvas");
    iconCanvas.width = ICON_SIZE;
    iconCanvas.height = ICON_SIZE;
    const iconCtx = iconCanvas.getContext("2d");
    const box = 312;
    const scale = Math.min(box / image.width, box / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    const x = 256 - width / 2;
    const y = 246 - height / 2;
    iconCtx.drawImage(image, x, y, width, height);
    iconCtx.globalCompositeOperation = "source-in";
    const iconGradient = iconCtx.createLinearGradient(96, 86, 402, 430);
    iconGradient.addColorStop(0, theme.fg);
    iconGradient.addColorStop(0.58, accent);
    iconGradient.addColorStop(1, shade(accent, 28));
    iconCtx.fillStyle = iconGradient;
    iconCtx.fillRect(0, 0, ICON_SIZE, ICON_SIZE);

    ctx.save();
    ctx.shadowColor = withAlpha(accent, 0.48);
    ctx.shadowBlur = 30;
    ctx.shadowOffsetY = 10;
    ctx.drawImage(iconCanvas, 0, 0);
    ctx.restore();

    ctx.strokeStyle = withAlpha(theme.fg, 0.12);
    ctx.lineWidth = 2;
    roundRect(ctx, 48, 48, 416, 416, 38);
    ctx.stroke();
    ctx.strokeStyle = withAlpha(accent, 0.68);
    ctx.lineWidth = 7;
    roundRect(ctx, 30, 30, 452, 452, 48);
    ctx.stroke();
    drawCornerGlyph(ctx, rule, tag.name, accent, theme);
    return canvas.toDataURL("image/png");
  }

  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith("image/")) {
        reject(new Error("Choose a PNG, JPG, WebP, or SVG image"));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Could not read image file"));
      reader.readAsDataURL(file);
    });
  }

  async function importImageUrl() {
    const url = state.externalUrl.trim();
    if (!url) return;
    state.saving = true;
    state.error = "";
    state.status = "Importing image URL...";
    render();
    try {
      const response = await fetch(url, { credentials: "omit" });
      if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) throw new Error("URL did not return an image");
      state.externalImage = await readImageFile(new File([blob], "remote-image", { type: blob.type }));
      state.externalImageName = url;
      state.previewImage = "";
      state.previewKey = "";
      state.status = "Imported image URL";
    } catch (error) {
      state.error = `${error.message || String(error)}. If this is a Magnific download, save the PNG locally and use Upload PNG instead.`;
      state.status = "";
    } finally {
      state.saving = false;
      render();
    }
  }

  function iconSearchUrl(tag) {
    const query = encodeURIComponent((tag && tag.name) || state.search || "");
    return `https://icon-sets.iconify.design/?query=${query}`;
  }

  async function loadSourceIcon(tagId, queryOverride) {
    const tag = state.tags.find((item) => item.id === (tagId || state.selectedTagId)) || selectedTag();
    const query = String(queryOverride || (tag && tag.name) || state.search || "").trim();
    if (!query) return;
    if (state.loadingSourceTagId === tag.id) return;
    const cached = state.sourceCache[tag.id];
    if (cached && cached.query === query) {
      state.sourceResults = cached.results;
      state.sourceSelected = cached.selected;
      state.externalImage = cached.imageData;
      state.externalImageName = cached.name;
      state.sourceQuery = cached.query || query;
      state.sourceTagId = tag.id;
      render();
      return;
    }
    state.saving = true;
    state.loadingSourceTagId = tag.id;
    state.error = "";
    state.status = `Searching Iconify for ${query}...`;
    render();
    try {
      const result = await pluginOperation({
        action: "iconify-icon",
        query,
      });
      if (!result || result.error) throw new Error((result && result.error) || "No Iconify result");
      state.sourceResults = result.results || [];
      state.sourceSelected = 0;
      selectSourceResult(0, false);
      state.sourceTagId = tag.id;
      state.sourceQuery = query;
      state.sourceCache[tag.id] = {
        results: state.sourceResults,
        selected: state.sourceSelected,
        imageData: state.externalImage,
        name: state.externalImageName,
        query,
      };
      state.status = `Loaded ${state.sourceResults.length || 1} Iconify choices for ${query}`;
    } catch (error) {
      state.sourceResults = [];
      state.sourceSelected = 0;
      state.externalImage = "";
      state.externalImageName = "";
      state.sourceTagId = tag.id;
      state.sourceQuery = query;
      state.sourceCache[tag.id] = {
        results: [],
        selected: 0,
        imageData: "",
        name: "",
        query,
      };
      state.error = "";
      state.status = `No Iconify match for ${query}; using fallback style`;
      state.previewImage = "";
      state.previewKey = "";
    } finally {
      state.saving = false;
      state.loadingSourceTagId = "";
      render();
    }
  }

  async function copyPrompt() {
    const tag = selectedTag();
    if (!tag) return;
    const prompt = tagPrompt(tag);
    try {
      await navigator.clipboard.writeText(prompt);
      state.status = "Prompt copied";
    } catch (error) {
      state.error = `Could not copy prompt: ${error.message || String(error)}`;
    }
    render();
  }

  function openIconSearch() {
    const tag = selectedTag();
    const query = state.manualIconQuery || state.sourceQuery || (tag && tag.name) || state.search || "";
    window.open(`https://icon-sets.iconify.design/?query=${encodeURIComponent(query)}`, "_blank", "noopener,noreferrer");
  }

  function searchManualIcon() {
    const tag = selectedTag();
    const query = String(state.manualIconQuery || "").trim();
    if (!tag || !query) return;
    loadSourceIcon(tag.id, query);
  }

  function selectSourceResult(index, shouldRender) {
    const result = state.sourceResults[index];
    if (!result || !result.imageData) return;
    state.sourceSelected = index;
    state.externalImage = result.imageData;
    state.externalImageName = result.name ? `Iconify: ${result.name}` : "Iconify icon";
    state.previewImage = "";
    state.previewKey = "";
    if (state.selectedTagId) {
      state.sourceCache[state.selectedTagId] = {
        results: state.sourceResults,
        selected: index,
        imageData: state.externalImage,
        name: state.externalImageName,
        query: state.sourceQuery,
      };
      state.sourceTagId = state.selectedTagId;
    }
    if (shouldRender) render();
  }

  function previewKeyFor(tag) {
    if (!tag) return "";
    return [tag.id, state.style, state.sourceSelected, state.externalImage ? hashString(state.externalImage).toString(36) : "fallback"].join(":");
  }

  async function refreshStyledPreview(tagId) {
    const tag = state.tags.find((item) => item.id === (tagId || state.selectedTagId)) || selectedTag();
    if (!tag) return;
    const key = previewKeyFor(tag);
    if (!key || state.previewKey === key || state.previewLoading) return;
    state.previewLoading = true;
    try {
      const image = state.externalImage ? await composeExternalIcon(tag, state.externalImage, state.style) : drawIcon(tag, state.style);
      if (state.selectedTagId === tag.id) {
        state.previewImage = image;
        state.previewKey = key;
      }
    } catch (error) {
      console.warn("[Tag Icon Studio] preview failed, using fallback", error);
      if (state.selectedTagId === tag.id) {
        state.previewImage = drawIcon(tag, state.style);
        state.previewKey = key;
      }
    } finally {
      state.previewLoading = false;
      render();
    }
  }

  function shade(color, amount) {
    const tmp = document.createElement("canvas").getContext("2d");
    tmp.fillStyle = color;
    const normalized = tmp.fillStyle;
    const match = normalized.match(/^#([0-9a-f]{6})$/i);
    if (!match) return color;
    const value = match[1];
    const next = [0, 2, 4]
      .map((offset) => Math.max(0, Math.min(255, parseInt(value.slice(offset, offset + 2), 16) + amount)))
      .map((part) => part.toString(16).padStart(2, "0"))
      .join("");
    return `#${next}`;
  }

  function drawBackground(ctx, theme, accent, seed) {
    ctx.fillStyle = theme.bg;
    roundRect(ctx, 0, 0, ICON_SIZE, ICON_SIZE, 54);
    ctx.fill();
    const gradient = ctx.createRadialGradient(360, 120, 20, 360, 120, 390);
    gradient.addColorStop(0, withAlpha(accent, 0.38));
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE);
    ctx.strokeStyle = withAlpha(accent, 0.34);
    ctx.lineWidth = 6;
    roundRect(ctx, 16, 16, 480, 480, 42);
    ctx.stroke();

    const hash = hashString(seed || "");
    ctx.strokeStyle = withAlpha(accent, 0.12);
    ctx.lineWidth = 2;
    for (let i = 0; i < 8; i += 1) {
      const x = 60 + ((hash >> (i * 3)) % 390);
      ctx.beginPath();
      ctx.moveTo(x, 34);
      ctx.lineTo(x - 150, 478);
      ctx.stroke();
    }
  }

  function withAlpha(color, alpha) {
    const tmp = document.createElement("canvas").getContext("2d");
    tmp.fillStyle = color;
    const normalized = tmp.fillStyle;
    const match = normalized.match(/^#([0-9a-f]{6})$/i);
    if (!match) return color;
    const hex = match[1];
    return `rgba(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)}, ${alpha})`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawSymbol(ctx, icon, accent, secondary, fg, tagName) {
    ctx.save();
    ctx.translate(256, 264);
    ctx.strokeStyle = fg;
    ctx.fillStyle = accent;
    ctx.lineWidth = 18;
    const draw = {
      breasts: drawBreasts,
      breastsmouth: drawBreastsMouth,
      butt: drawButt,
      vulva: drawVulva,
      penis: drawPenis,
      mouth: drawMouth,
      wet: drawWet,
      amateur: drawAmateur,
      braces: drawBraces,
      cum: drawCum,
      analcum: drawAnalCum,
      creampie: drawCreampie,
      bondage: drawBondage,
      toy: drawToy,
      buttplug: drawButtPlug,
      feet: drawFeet,
      hair: drawHair,
      eye: drawEye,
      clothing: drawClothing,
      location: drawLocation,
      role: drawRole,
      camera: drawCamera,
      tech: drawTech,
      threed: draw3D,
      resolution: drawResolution,
      fps: drawFps,
      vr: drawVr,
      group: drawGroup,
      heart: drawHeart,
      flame: drawFlame,
      person: drawPerson,
      star: drawStar,
      tag: drawTag,
    };
    (draw[icon] || drawTag)(ctx, accent, secondary, fg, tagName);
    ctx.restore();
  }

  function drawBreasts(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.82);
    ellipse(ctx, -70, 20, 80, 105);
    ellipse(ctx, 70, 20, 80, 105);
    ctx.fillStyle = secondary;
    circle(ctx, -70, 42, 13);
    circle(ctx, 70, 42, 13);
    ctx.strokeStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-118, 0);
    ctx.quadraticCurveTo(-40, -128, 0, -42);
    ctx.quadraticCurveTo(40, -128, 118, 0);
    ctx.stroke();
  }

  function drawBreastsMouth(ctx, accent, secondary, fg) {
    drawBreasts(ctx, accent, secondary, fg);
    ctx.save();
    ctx.translate(0, 80);
    ctx.scale(0.58, 0.42);
    ctx.fillStyle = "#ff4d7d";
    ctx.beginPath();
    ctx.moveTo(-145, 0);
    ctx.quadraticCurveTo(-60, -82, 0, -25);
    ctx.quadraticCurveTo(60, -82, 145, 0);
    ctx.quadraticCurveTo(56, 72, 0, 42);
    ctx.quadraticCurveTo(-56, 72, -145, 0);
    ctx.fill();
    ctx.strokeStyle = fg;
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.moveTo(-120, 4);
    ctx.quadraticCurveTo(0, 42, 120, 4);
    ctx.stroke();
    ctx.restore();
  }

  function drawButt(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.84);
    ellipse(ctx, -62, 18, 88, 120);
    ellipse(ctx, 62, 18, 88, 120);
    ctx.strokeStyle = fg;
    ctx.beginPath();
    ctx.moveTo(0, -92);
    ctx.quadraticCurveTo(0, -10, 0, 132);
    ctx.stroke();
  }

  function drawVulva(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.84);
    ctx.beginPath();
    ctx.moveTo(0, -135);
    ctx.bezierCurveTo(105, -56, 105, 83, 0, 142);
    ctx.bezierCurveTo(-105, 83, -105, -56, 0, -135);
    ctx.fill();
    ctx.strokeStyle = fg;
    ctx.beginPath();
    ctx.moveTo(0, -80);
    ctx.bezierCurveTo(42, -24, 40, 54, 0, 96);
    ctx.bezierCurveTo(-40, 54, -42, -24, 0, -80);
    ctx.stroke();
  }

  function drawPenis(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.84);
    roundRect(ctx, -38, -128, 76, 210, 38);
    ctx.fill();
    circle(ctx, -52, 108, 50);
    circle(ctx, 52, 108, 50);
    ctx.strokeStyle = fg;
    ctx.beginPath();
    ctx.moveTo(0, -128);
    ctx.lineTo(0, 76);
    ctx.stroke();
  }

  function drawMouth(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.86);
    ctx.beginPath();
    ctx.moveTo(-145, 0);
    ctx.quadraticCurveTo(-60, -82, 0, -25);
    ctx.quadraticCurveTo(60, -82, 145, 0);
    ctx.quadraticCurveTo(56, 72, 0, 42);
    ctx.quadraticCurveTo(-56, 72, -145, 0);
    ctx.fill();
    ctx.strokeStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-120, 4);
    ctx.quadraticCurveTo(0, 42, 120, 4);
    ctx.stroke();
  }

  function drawWet(ctx, accent, secondary, fg) {
    ctx.fillStyle = "#4ee3ff";
    droplet(ctx, -78, -40, 70);
    droplet(ctx, 40, -78, 95);
    droplet(ctx, 92, 78, 58);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(-130, 122);
    ctx.bezierCurveTo(-60, 78, 55, 165, 138, 108);
    ctx.stroke();
  }

  function drawAmateur(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.86);
    roundRect(ctx, -142, -82, 225, 164, 24);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(83, -34);
    ctx.lineTo(152, -72);
    ctx.lineTo(152, 72);
    ctx.lineTo(83, 34);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = fg;
    circle(ctx, -42, 0, 48);
    ctx.fillStyle = secondary;
    circle(ctx, -42, 0, 24);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(-124, 112);
    ctx.lineTo(-72, 70);
    ctx.moveTo(-18, 112);
    ctx.lineTo(-44, 72);
    ctx.stroke();
  }

  function drawBraces(ctx, accent, secondary, fg) {
    ctx.fillStyle = "#f8f4e8";
    roundRect(ctx, -135, -72, 270, 144, 42);
    ctx.fill();
    ctx.strokeStyle = "#23262d";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(-132, 0);
    ctx.lineTo(132, 0);
    ctx.moveTo(-66, -68);
    ctx.lineTo(-66, 68);
    ctx.moveTo(0, -72);
    ctx.lineTo(0, 72);
    ctx.moveTo(66, -68);
    ctx.lineTo(66, 68);
    ctx.stroke();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(-116, 0);
    ctx.lineTo(116, 0);
    ctx.stroke();
    ctx.fillStyle = accent;
    [-66, 0, 66].forEach((x) => {
      roundRect(ctx, x - 15, -15, 30, 30, 6);
      ctx.fill();
    });
  }

  function drawCum(ctx, accent, secondary, fg) {
    ctx.fillStyle = "#f6f1de";
    blob(ctx, [[0, -135], [86, -80], [62, 42], [0, 145], [-72, 55], [-88, -76]]);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 12;
    ctx.stroke();
    ctx.fillStyle = secondary;
    circle(ctx, 92, 94, 28);
    circle(ctx, -108, 20, 22);
  }

  function drawAnalCum(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(COLORS.anal, 0.86);
    ellipse(ctx, -58, 12, 82, 122);
    ellipse(ctx, 58, 12, 82, 122);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.moveTo(0, -104);
    ctx.quadraticCurveTo(0, -2, 0, 128);
    ctx.stroke();
    ctx.fillStyle = "#f7f0d8";
    blob(ctx, [[24, -58], [86, -22], [70, 48], [26, 95], [-6, 42], [-28, -24]]);
    ctx.fillStyle = "#f7f0d8";
    circle(ctx, 94, 86, 24);
    circle(ctx, -88, 74, 18);
  }

  function drawCreampie(ctx, accent, secondary, fg) {
    drawVulva(ctx, COLORS.sex, secondary, fg);
    ctx.fillStyle = "#f7f0d8";
    blob(ctx, [[5, -42], [48, -4], [38, 72], [0, 120], [-34, 72], [-48, -4]]);
    circle(ctx, 70, 92, 20);
  }

  function drawBondage(ctx, accent, secondary, fg) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 30;
    circleStroke(ctx, -70, 14, 72);
    circleStroke(ctx, 70, 14, 72);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.moveTo(-12, 14);
    ctx.lineTo(12, 14);
    ctx.stroke();
    ctx.strokeStyle = secondary;
    ctx.beginPath();
    ctx.moveTo(-125, -88);
    ctx.lineTo(125, -88);
    ctx.stroke();
  }

  function drawToy(ctx, accent, secondary, fg) {
    ctx.save();
    ctx.rotate(-0.52);
    ctx.fillStyle = withAlpha(accent, 0.86);
    roundRect(ctx, -42, -142, 84, 245, 42);
    ctx.fill();
    ctx.fillStyle = secondary;
    roundRect(ctx, -30, 96, 60, 62, 18);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = fg;
    ctx.lineWidth = 12;
    circleStroke(ctx, 86, -106, 24);
  }

  function drawButtPlug(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.88);
    ctx.beginPath();
    ctx.moveTo(0, -145);
    ctx.bezierCurveTo(74, -90, 82, -10, 42, 62);
    ctx.lineTo(24, 98);
    ctx.lineTo(-24, 98);
    ctx.lineTo(-42, 62);
    ctx.bezierCurveTo(-82, -10, -74, -90, 0, -145);
    ctx.fill();
    roundRect(ctx, -48, 86, 96, 74, 30);
    ctx.fill();
    ctx.strokeStyle = fg;
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(-115, 154);
    ctx.quadraticCurveTo(0, 104, 115, 154);
    ctx.stroke();
    ctx.strokeStyle = secondary;
    ctx.lineWidth = 12;
    circleStroke(ctx, 112, -94, 30);
  }

  function drawFeet(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.84);
    ellipse(ctx, -54, 18, 55, 135);
    ellipse(ctx, 58, 18, 55, 135);
    for (let i = 0; i < 5; i += 1) {
      circle(ctx, -100 + i * 20, -108 + Math.abs(i - 2) * 5, 9);
      circle(ctx, 18 + i * 20, -108 + Math.abs(i - 2) * 5, 9);
    }
  }

  function drawHair(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.86);
    ctx.beginPath();
    ctx.arc(0, -20, 126, Math.PI, 0);
    ctx.bezierCurveTo(120, 120, 54, 145, 0, 85);
    ctx.bezierCurveTo(-54, 145, -120, 120, -126, -20);
    ctx.fill();
    ctx.strokeStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-52, -126);
    ctx.bezierCurveTo(-22, -40, -72, 40, -42, 120);
    ctx.moveTo(45, -126);
    ctx.bezierCurveTo(18, -42, 66, 38, 38, 120);
    ctx.stroke();
  }

  function drawEye(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.55);
    ctx.beginPath();
    ctx.moveTo(-150, 0);
    ctx.quadraticCurveTo(0, -118, 150, 0);
    ctx.quadraticCurveTo(0, 118, -150, 0);
    ctx.fill();
    ctx.fillStyle = fg;
    circle(ctx, 0, 0, 62);
    ctx.fillStyle = accent;
    circle(ctx, 0, 0, 34);
  }

  function drawClothing(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.84);
    ctx.beginPath();
    ctx.moveTo(-108, -110);
    ctx.lineTo(-30, -138);
    ctx.lineTo(0, -88);
    ctx.lineTo(30, -138);
    ctx.lineTo(108, -110);
    ctx.lineTo(74, 132);
    ctx.lineTo(-74, 132);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-62, 8);
    ctx.lineTo(62, 8);
    ctx.stroke();
  }

  function drawLocation(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.84);
    ctx.beginPath();
    ctx.moveTo(0, -150);
    ctx.bezierCurveTo(95, -150, 145, -55, 102, 24);
    ctx.lineTo(0, 150);
    ctx.lineTo(-102, 24);
    ctx.bezierCurveTo(-145, -55, -95, -150, 0, -150);
    ctx.fill();
    ctx.fillStyle = fg;
    circle(ctx, 0, -45, 44);
  }

  function drawRole(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.84);
    circle(ctx, 0, -86, 55);
    roundRect(ctx, -100, -15, 200, 150, 48);
    ctx.fill();
    ctx.strokeStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-95, -20);
    ctx.lineTo(0, 35);
    ctx.lineTo(95, -20);
    ctx.stroke();
  }

  function drawCamera(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.84);
    roundRect(ctx, -142, -80, 284, 190, 32);
    ctx.fill();
    roundRect(ctx, -86, -128, 86, 55, 18);
    ctx.fill();
    ctx.fillStyle = fg;
    circle(ctx, 20, 15, 62);
    ctx.fillStyle = secondary;
    circle(ctx, 20, 15, 34);
  }

  function drawTech(ctx, accent, secondary, fg) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 22;
    roundRect(ctx, -130, -110, 260, 220, 34);
    ctx.stroke();
    ctx.strokeStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-70, -35);
    ctx.lineTo(70, -35);
    ctx.moveTo(-70, 20);
    ctx.lineTo(70, 20);
    ctx.moveTo(-70, 75);
    ctx.lineTo(30, 75);
    ctx.stroke();
  }

  function draw3D(ctx, accent, secondary, fg) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 18;
    ctx.fillStyle = withAlpha(accent, 0.28);
    ctx.beginPath();
    ctx.moveTo(-88, -70);
    ctx.lineTo(20, -125);
    ctx.lineTo(120, -66);
    ctx.lineTo(10, -8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-88, -70);
    ctx.lineTo(-88, 58);
    ctx.lineTo(10, 128);
    ctx.lineTo(10, -8);
    ctx.moveTo(120, -66);
    ctx.lineTo(120, 60);
    ctx.lineTo(10, 128);
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.font = "900 74px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("3D", 0, 10);
  }

  function drawResolution(ctx, accent, secondary, fg, tagName) {
    const label = resolutionLabel(tagName);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 20;
    roundRect(ctx, -146, -92, 292, 184, 26);
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.font = label.length > 2 ? "900 78px Arial, sans-serif" : "900 96px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 0, 6);
  }

  function drawFps(ctx, accent, secondary, fg, tagName) {
    const match = String(tagName || "").match(/(\d+)\s*fps/i);
    ctx.fillStyle = withAlpha(accent, 0.84);
    circle(ctx, 0, 0, 126);
    ctx.fillStyle = fg;
    ctx.font = "900 78px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(match ? match[1] : "FPS", 0, -18);
    ctx.font = "800 40px Arial, sans-serif";
    ctx.fillText("FPS", 0, 52);
  }

  function resolutionLabel(tagName) {
    const value = String(tagName || "").toUpperCase();
    const match = value.match(/\b(3K|4K|5K|6K|7K|8K|FULL HD|HD)\b/);
    return match ? match[1].replace("FULL HD", "FHD") : "HD";
  }

  function drawVr(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.84);
    roundRect(ctx, -150, -62, 300, 124, 48);
    ctx.fill();
    ctx.fillStyle = themeSafe("#0f1418");
    ellipse(ctx, -64, 0, 44, 32);
    ellipse(ctx, 64, 0, 44, 32);
    ctx.strokeStyle = fg;
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.moveTo(-150, 0);
    ctx.quadraticCurveTo(-190, -30, -182, -78);
    ctx.moveTo(150, 0);
    ctx.quadraticCurveTo(190, -30, 182, -78);
    ctx.stroke();
  }

  function themeSafe(color) {
    return color;
  }

  function drawGroup(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.84);
    circle(ctx, -72, -55, 42);
    circle(ctx, 72, -55, 42);
    circle(ctx, 0, -95, 45);
    roundRect(ctx, -135, 0, 110, 130, 35);
    roundRect(ctx, 25, 0, 110, 130, 35);
    roundRect(ctx, -62, -10, 124, 150, 40);
    ctx.fill();
  }

  function drawHeart(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.88);
    ctx.beginPath();
    ctx.moveTo(0, 125);
    ctx.bezierCurveTo(-145, 25, -145, -100, -45, -100);
    ctx.bezierCurveTo(0, -100, 0, -62, 0, -62);
    ctx.bezierCurveTo(0, -62, 0, -100, 45, -100);
    ctx.bezierCurveTo(145, -100, 145, 25, 0, 125);
    ctx.fill();
  }

  function drawFlame(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.88);
    ctx.beginPath();
    ctx.moveTo(10, -150);
    ctx.bezierCurveTo(130, -35, 65, 30, 120, 95);
    ctx.bezierCurveTo(45, 165, -95, 120, -105, 10);
    ctx.bezierCurveTo(-110, -48, -55, -90, 10, -150);
    ctx.fill();
    ctx.fillStyle = secondary;
    ctx.beginPath();
    ctx.moveTo(0, -42);
    ctx.bezierCurveTo(55, 18, 26, 82, -10, 112);
    ctx.bezierCurveTo(-45, 76, -42, 12, 0, -42);
    ctx.fill();
  }

  function drawPerson(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.84);
    circle(ctx, 0, -92, 58);
    roundRect(ctx, -90, -15, 180, 158, 60);
    ctx.fill();
    ctx.strokeStyle = fg;
    ctx.beginPath();
    ctx.moveTo(-48, 45);
    ctx.lineTo(48, 45);
    ctx.stroke();
  }

  function drawStar(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.88);
    ctx.beginPath();
    for (let i = 0; i < 10; i += 1) {
      const radius = i % 2 ? 58 : 145;
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }

  function drawTag(ctx, accent, secondary, fg) {
    ctx.fillStyle = withAlpha(accent, 0.84);
    ctx.beginPath();
    ctx.moveTo(-120, -120);
    ctx.lineTo(35, -120);
    ctx.lineTo(140, -15);
    ctx.lineTo(-15, 140);
    ctx.lineTo(-120, 35);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = fg;
    circle(ctx, -55, -58, 20);
  }

  function circle(ctx, x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function circleStroke(ctx, x, y, radius) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  function ellipse(ctx, x, y, rx, ry) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function blob(ctx, points) {
    ctx.beginPath();
    points.forEach(([x, y], index) => {
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
  }

  function droplet(ctx, x, y, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 100, size / 100);
    ctx.beginPath();
    ctx.moveTo(0, -92);
    ctx.bezierCurveTo(68, -10, 58, 78, 0, 94);
    ctx.bezierCurveTo(-58, 78, -68, -10, 0, -92);
    ctx.fill();
    ctx.restore();
  }

  function drawCornerGlyph(ctx, rule, tagName, accent, theme) {
    ctx.save();
    ctx.translate(402, 402);
    ctx.fillStyle = withAlpha(accent, 0.22);
    roundRect(ctx, -54, -54, 108, 108, 28);
    ctx.fill();
    ctx.fillStyle = theme.fg;
    ctx.font = "700 34px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const label =
      rule.icon === "threed"
        ? "3D"
        : rule.icon === "vr"
          ? "VR"
          : rule.icon === "fps"
            ? "60"
            : rule.icon === "resolution"
              ? resolutionLabel(tagName)
              : { tech: "T", camera: "POV", location: "LOC", role: "ID", bondage: "X", sex: "+", body: "B", oral: "O", anal: "A", cum: "*", clothing: "C", relationship: "2+", mood: "♥", action: "!", meta: "#" }[rule.group] || "#";
    ctx.fillText(label, 0, 2);
    ctx.restore();
  }

  async function saveGenerated() {
    const tag = selectedTag();
    if (!tag) return;
    captureTagScroll();
    state.saving = true;
    state.error = "";
    state.status = `Saving icon for ${tag.name}...`;
    render();
    try {
      const image = drawIcon(tag, state.style);
      const updated = await updateTagImage(tag.id, image);
      tag.image_path = (updated && updated.image_path) || image;
      markTagDone(tag.id);
      if (state.onlyMissing) ensureSelectedVisible();
      state.status = `Saved icon for ${tag.name}`;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
      console.error("[Tag Icon Studio] save failed", error);
    } finally {
      state.saving = false;
      render();
    }
  }

  async function saveExternal() {
    const tag = selectedTag();
    if (!tag) return;
    captureTagScroll();
    state.saving = true;
    state.error = "";
    state.status = `Saving icon for ${tag.name}...`;
    render();
    try {
      const image = state.externalImage ? await composeExternalIcon(tag, state.externalImage, state.style) : drawIcon(tag, state.style);
      const updated = await updateTagImage(tag.id, image);
      tag.image_path = (updated && updated.image_path) || image;
      markTagDone(tag.id);
      if (state.onlyMissing) ensureSelectedVisible();
      state.status = `Saved icon for ${tag.name}`;
    } catch (error) {
      state.error = error.message || String(error);
      state.status = "";
      console.error("[Tag Icon Studio] imported save failed", error);
    } finally {
      state.saving = false;
      render();
    }
  }

  async function updateTagImage(id, image) {
    try {
      const data = await graphql(
        `mutation TagIconStudioUpdate($id: ID!, $image: String!) {
          tagUpdate(input: { id: $id, image: $image }) {
            id
            name
            image_path
          }
        }`,
        { id, image }
      );
      return data && data.tagUpdate;
    } catch (directError) {
      console.warn("[Tag Icon Studio] direct tagUpdate shape failed, trying wrapped shape", directError);
      const data = await graphql(
        `mutation TagIconStudioUpdateWrapped($id: ID!, $image: String!) {
          tagUpdate(input: { id: $id, image: $image }) {
            tag {
              id
              name
              image_path
            }
          }
        }`,
        { id, image }
      );
      return data && data.tagUpdate && data.tagUpdate.tag;
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
      state.tagPage = 1;
      const visible = filteredTags();
      if (!visible.some((tag) => tag.id === state.selectedTagId)) {
        selectTag(visible[0] ? visible[0].id : "");
        return;
      }
      render();
    });

    const missing = el("label", "stash-tip-check");
    const missingInput = el("input", "");
    missingInput.type = "checkbox";
    missingInput.checked = state.onlyMissing;
    missingInput.addEventListener("change", () => {
      captureTagScroll();
      state.onlyMissing = missingInput.checked;
      state.tagPage = 1;
      state.tagScrollTop = 0;
      const visible = filteredTags();
      if (!visible.some((tag) => tag.id === state.selectedTagId)) {
        selectTag(visible[0] ? visible[0].id : "");
        return;
      }
      render();
    });
    missing.append(missingInput, el("span", "", "Missing only"));

    const refresh = el("button", "stash-tip-button", "Refresh");
    refresh.type = "button";
    refresh.addEventListener("click", () => loadTags(true));
    toolbar.append(search, missing, refresh);
    parent.appendChild(toolbar);
  }

  function renderTags(parent) {
    const list = el("aside", "stash-tip-tags");
    list.addEventListener("scroll", () => {
      state.tagScrollTop = list.scrollTop;
    });
    const tags = filteredTags();
    const totalPages = Math.max(1, Math.ceil(tags.length / TAGS_PER_PAGE));
    state.tagPage = Math.min(Math.max(1, state.tagPage), totalPages);
    const start = (state.tagPage - 1) * TAGS_PER_PAGE;
    const pageTags = tags.slice(start, start + TAGS_PER_PAGE);
    const pager = el("div", "stash-tip-pager");
    const previous = el("button", "stash-tip-page-button", "Prev");
    previous.type = "button";
    previous.disabled = state.tagPage <= 1;
    previous.addEventListener("click", () => {
      captureTagScroll();
      state.tagPage = Math.max(1, state.tagPage - 1);
      state.tagScrollTop = 0;
      render();
    });
    const label = el("span", "stash-tip-page-label", `${tags.length} tags - page ${state.tagPage} / ${totalPages}`);
    const next = el("button", "stash-tip-page-button", "Next");
    next.type = "button";
    next.disabled = state.tagPage >= totalPages;
    next.addEventListener("click", () => {
      captureTagScroll();
      state.tagPage = Math.min(totalPages, state.tagPage + 1);
      state.tagScrollTop = 0;
      render();
    });
    pager.append(previous, label, next);
    list.appendChild(pager);
    if (!tags.length) {
      list.appendChild(el("div", "stash-tip-empty", "No matching tags"));
      parent.appendChild(list);
      return;
    }
    pageTags.forEach((tag) => {
      const row = el("button", "stash-tip-tag");
      row.type = "button";
      row.setAttribute("aria-pressed", String(tag.id === state.selectedTagId));
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      row.addEventListener("click", (event) => {
        event.preventDefault();
        captureTagScroll();
        row.blur();
        selectTag(tag.id);
      });
      row.appendChild(el("span", "stash-tip-tag-name", tag.name));
      const knownImage = hasKnownImage(tag);
      row.appendChild(el("span", "stash-tip-tag-meta", knownImage === true ? "image" : `${tagUsage(tag)} uses`));
      list.appendChild(row);
    });
    parent.appendChild(list);
    restoreTagScroll(list);
  }

  function renderStylePicker(parent) {
    const controls = el("div", "stash-tip-options");
    const style = el("select", "stash-tip-select");
    Object.entries(THEMES).forEach(([value, theme]) => {
      const option = el("option", "", theme.name);
      option.value = value;
      option.selected = value === state.style;
      style.appendChild(option);
    });
    style.addEventListener("change", () => {
      state.style = style.value;
      render();
    });
    controls.append(style);
    parent.appendChild(controls);
  }

  function renderExternalPicker(parent, tag) {
    const panel = el("div", "stash-tip-external");
    const actions = el("div", "stash-tip-options");
    const source = el("button", "stash-tip-button", "Open Iconify");
    source.type = "button";
    source.addEventListener("click", openIconSearch);

    const fileLabel = el("label", "stash-tip-file-button");
    fileLabel.appendChild(el("span", "", state.externalImageName || "Upload icon"));
    const file = el("input", "");
    file.type = "file";
    file.accept = "image/png,image/jpeg,image/webp,image/svg+xml";
    file.addEventListener("change", async () => {
      const picked = file.files && file.files[0];
      if (!picked) return;
      state.saving = true;
      state.error = "";
      state.status = "Loading PNG...";
      render();
      try {
        state.externalImage = await readImageFile(picked);
        state.externalImageName = picked.name;
        state.previewImage = "";
        state.previewKey = "";
        state.sourceTagId = state.selectedTagId;
        state.sourceQuery = "";
        state.status = `Loaded ${picked.name}`;
      } catch (error) {
        state.error = error.message || String(error);
        state.status = "";
      } finally {
        state.saving = false;
        render();
      }
    });
    fileLabel.appendChild(file);

    const save = el("button", "stash-tip-button save", state.saving ? "Saving..." : "Apply selected icon");
    save.type = "button";
    save.disabled = state.saving || !tag;
    save.addEventListener("click", saveExternal);
    actions.append(source, fileLabel, save);
    panel.append(actions);

    const searchRow = el("form", "stash-tip-icon-search");
    searchRow.addEventListener("submit", (event) => {
      event.preventDefault();
      searchManualIcon();
    });
    const iconSearch = el("input", "stash-tip-search");
    iconSearch.type = "search";
    iconSearch.placeholder = "Iconify keyword";
    iconSearch.value = state.manualIconQuery;
    iconSearch.disabled = !tag || state.saving;
    iconSearch.addEventListener("input", () => {
      state.manualIconQuery = iconSearch.value;
    });
    const iconSearchButton = el("button", "stash-tip-button", state.loadingSourceTagId ? "Searching..." : "Search icons");
    iconSearchButton.type = "submit";
    iconSearchButton.disabled = !tag || state.saving;
    searchRow.append(iconSearch, iconSearchButton);
    panel.appendChild(searchRow);

    if (state.sourceQuery) {
      panel.appendChild(el("div", "stash-tip-source-query", `Iconify keyword: ${state.sourceQuery}`));
    }

    if (state.sourceResults.length) {
      const choices = el("div", "stash-tip-source-grid");
      state.sourceResults.forEach((result, index) => {
        const choice = el("button", "stash-tip-source-choice");
        choice.type = "button";
        choice.setAttribute("aria-pressed", String(index === state.sourceSelected));
        choice.title = result.name || result.id || "Iconify icon";
        choice.addEventListener("click", () => selectSourceResult(index, true));
        const img = el("img", "");
        img.src = result.imageData;
        img.alt = result.name || result.id || "Iconify icon";
        choice.appendChild(img);
        choice.appendChild(el("span", "", result.id || result.name || `Choice ${index + 1}`));
        choices.appendChild(choice);
      });
      panel.appendChild(choices);
    } else if (tag && !state.loadingSourceTagId) {
      panel.appendChild(el("div", "stash-tip-source-fallback", "No Iconify match; fallback style is ready."));
    }
    parent.appendChild(panel);
  }

  function renderWork(parent) {
    const section = el("section", "stash-tip-work");
    const tag = selectedTag();
    if (tag && state.sourceTagId !== tag.id && state.loadingSourceTagId !== tag.id && !state.sourceCache[tag.id]) {
      window.setTimeout(() => loadSourceIcon(tag.id), 0);
    }
    if (tag && state.previewKey !== previewKeyFor(tag) && !state.previewLoading) {
      window.setTimeout(() => refreshStyledPreview(tag.id), 0);
    }
    const heading = el("div", "stash-tip-heading");
    heading.appendChild(el("h2", "", tag ? tag.name : "Select a tag"));
    heading.appendChild(el("div", "stash-tip-subtle", tag ? `${tagUsage(tag)} linked objects - ${classifyTag(tag.name).icon}` : "Choose a tag from the list"));
    section.appendChild(heading);
    renderStylePicker(section);
    renderExternalPicker(section, tag);
    const previewRow = el("div", "stash-tip-preview-row");
    const imported = el("div", "stash-tip-preview-card");
    imported.appendChild(el("h3", "", "Styled preview"));
    if (tag && state.previewImage) {
      const img = el("img", "stash-tip-preview");
      img.src = state.previewImage;
      img.alt = `${tag.name} styled preview`;
      imported.appendChild(img);
    } else {
      imported.appendChild(el("div", "stash-tip-empty", state.previewLoading ? "Rendering preview..." : "Fallback preview will appear here"));
    }
    previewRow.appendChild(imported);
    const current = el("div", "stash-tip-preview-card");
    current.appendChild(el("h3", "", "Current"));
    if (tag && tag.image_path) {
      const img = el("img", "stash-tip-preview");
      img.src = tag.image_path;
      img.alt = `${tag.name} current image`;
      current.appendChild(img);
    } else {
      current.appendChild(el("div", "stash-tip-empty", "No current image"));
    }
    previewRow.appendChild(current);
    section.appendChild(previewRow);
    parent.appendChild(section);
  }

  function renderInto(container) {
    container.className = "stash-tip-app";
    clear(container);
    const shell = el("section", "stash-tip-shell");
    const header = el("div", "stash-tip-titlebar");
    header.appendChild(el("h1", "", "Tag Icon Studio"));
    header.appendChild(el("p", "", "Generate consistent local icons for tags."));
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
      console.error("[Tag Icon Studio] render failed", error);
    }
  }

  function registerPluginRoute() {
    const api = window.PluginApi;
    if (!api || !api.React || !api.register || !api.register.route || window.__stashTagImagePickerRouteRegistered) return;
    window.__stashTagImagePickerRouteRegistered = true;
    state.routeRegistered = true;
    const React = api.React;
    function TagIconStudioPage() {
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
    api.register.route(ROUTE, TagIconStudioPage);
  }

  function install() {
    registerPluginRoute();
    patchHistory();
    addMenuEntries();
    window.setTimeout(() => {
      addMenuEntries();
      addLauncher();
    }, 1500);
    render();
  }

  const observer = new MutationObserver(addMenuEntries);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("popstate", render);
  window.addEventListener("stash-tag-image-picker-route", render);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
