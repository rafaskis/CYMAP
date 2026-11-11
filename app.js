(() => {
  "use strict";
  const cfg = window.CYMAP_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const layersEl = $("layers");
  const layerSelect = $("active-layer");
  const loginDialog = $("login-dialog");
  const featureDialog = $("feature-dialog");
  const layerVisibilityKey = "cymap.layerVisibility.v1";
  const collapsedCategoriesKey = "cymap.collapsedCategories.v1";

  // Adaptive Esri imagery zoom: native imagery is capped at z19, with up to
  // 4x local enlargement (two additional map zoom levels).
  const ESRI_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer";
  const ESRI_MAX_NATIVE_ZOOM = 19;
  const MAX_LOCAL_TILE_SCALE = 4;
  const MAX_LOCAL_ZOOM_STEPS = Math.log2(MAX_LOCAL_TILE_SCALE);
  const MAP_MAX_ZOOM = ESRI_MAX_NATIVE_ZOOM + MAX_LOCAL_ZOOM_STEPS;
  let adaptiveZoomCheckId = 0;
  const TILEMAP_BLOCK_SIZE = 8;
  const tileAvailabilityCache = new Map();
  const tileAvailabilityRequests = new Map();
  const imageryTileCache = new Map();
  const imageryTileStatus = new Map();
  const MAX_TILE_CACHE_ENTRIES = 450;
  let zoomInfoUpdate = null;


  // These five colors are fixed by the CYMAP maintainers, not user-editable.
  // To redesign the permanent layers, change this palette and redeploy the site.
  const PERMANENT_LAYER_COLORS = Object.freeze({
    kd: "#facc15",                  // yellow
    controlled_areas: "#2563eb",    // blue
    uncontrolled_areas: "#dc2626", // red
    sba: "#9333ea",                 // purple
    un: "#16a34a",                  // green
    additional_data: "#16a34a"      // default for user-created features
  });

  const state = {
    supabase: null, map: null, draw: null, layers: [], features: [],
    isEditor: false, user: null, selectedFeature: null,
    visibility: {}, hiddenFeatureIds: new Set(), categories: [], collapsedCategoryIds: new Set(),
    collapsedCategoriesUserId: null, circlePlacementActive: false,
    additionalLayerId: null, mapLoaded: false,
    placeSearchTimer: null, placeSearchRequestId: 0
  };

  function setStatus(message, bad = false) {
    statusEl.textContent = message;
    statusEl.style.color = bad ? "#b42318" : "#64748b";
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, c => ({
      "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
    })[c]);
  }
  function readVisibility() {
    try { return JSON.parse(localStorage.getItem(layerVisibilityKey) || "{}"); }
    catch { return {}; }
  }
  function saveVisibility() {
    localStorage.setItem(layerVisibilityKey, JSON.stringify(state.visibility));
  }
  function layerVisible(layerId) {
    return state.visibility[layerId] !== false;
  }
  function featureVisible(featureId) {
    const feature = state.features.find(item => String(item.id) === String(featureId));
    if (!feature || feature.is_visible === false) return false;
    if (!feature.category_id) return true;
    const category = state.categories.find(item => String(item.id) === String(feature.category_id));
    return !category || category.is_visible !== false;
  }
  function featureOwnVisible(feature) { return feature?.is_visible !== false; }
  function categoryVisible(category) { return category?.is_visible !== false; }
  function loadCollapsedCategories(userId) {
    state.collapsedCategoryIds = new Set();
    state.collapsedCategoriesUserId = userId || null;
    if (!userId) return;
    try {
      const saved = JSON.parse(localStorage.getItem(collapsedCategoriesKey) || "{}");
      const ids = Array.isArray(saved[userId]) ? saved[userId] : [];
      state.collapsedCategoryIds = new Set(ids.map(String));
    } catch { state.collapsedCategoryIds = new Set(); }
  }
  function saveCollapsedCategories() {
    const userId = state.collapsedCategoriesUserId;
    if (!userId) return;
    try {
      const saved = JSON.parse(localStorage.getItem(collapsedCategoriesKey) || "{}");
      saved[userId] = [...state.collapsedCategoryIds];
      localStorage.setItem(collapsedCategoriesKey, JSON.stringify(saved));
    } catch (error) { console.warn("Could not save collapsed category preferences:", error); }
  }
  function toggleCategoryCollapsed(categoryId) {
    const id = String(categoryId || "__uncategorized__");
    if (state.collapsedCategoryIds.has(id)) state.collapsedCategoryIds.delete(id);
    else state.collapsedCategoryIds.add(id);
    saveCollapsedCategories();
    renderLayers();
  }
  function getLayer(id) { return state.layers.find(x => x.id === id); }

  async function toggleFeatureVisibility(feature) {
    const next = !featureOwnVisible(feature);
    const { data, error } = await state.supabase.from("map_features")
      .update({ is_visible: next, updated_at: new Date().toISOString() })
      .eq("id", feature.id).select("*").single();
    if (error) { setStatus(`Visibility update failed: ${error.message}`, true); return; }
    const index = state.features.findIndex(item => item.id === feature.id);
    if (index >= 0) state.features[index] = data;
    refreshAllSources();
    renderLayers();
  }

  async function toggleCategoryVisibility(category) {
    const next = !categoryVisible(category);
    const { data, error } = await state.supabase.from("map_feature_categories")
      .update({ is_visible: next, updated_at: new Date().toISOString() })
      .eq("id", category.id).select("*").single();
    if (error) { setStatus(`Category update failed: ${error.message}`, true); return; }
    const index = state.categories.findIndex(item => item.id === category.id);
    if (index >= 0) state.categories[index] = data;
    refreshAllSources();
    renderLayers();
  }

  async function moveFeatureToCategory(feature, categoryId) {
    const target = categoryId || null;
    const { data, error } = await state.supabase.from("map_features")
      .update({ category_id: target, updated_at: new Date().toISOString() })
      .eq("id", feature.id).select("*").single();
    if (error) { setStatus(`Move failed: ${error.message}`, true); return; }
    const index = state.features.findIndex(item => item.id === feature.id);
    if (index >= 0) state.features[index] = data;
    renderLayers();
  }

  async function createCategory() {
    const name = window.prompt("Όνομα νέας κατηγορίας:");
    if (name === null) return;
    const clean = name.trim();
    if (!clean) { setStatus("Το όνομα κατηγορίας δεν μπορεί να είναι κενό.", true); return; }
    const { data, error } = await state.supabase.from("map_feature_categories")
      .insert({ owner_id: state.user.id, name: clean, is_visible: true, sort_order: state.categories.length })
      .select("*").single();
    if (error) { setStatus(`Category creation failed: ${error.message}`, true); return; }
    state.categories.push(data);
    renderLayers();
  }

  async function renameCategory(category) {
    const name = window.prompt("Νέο όνομα κατηγορίας:", category.name);
    if (name === null) return;
    const clean = name.trim();
    if (!clean) { setStatus("Το όνομα κατηγορίας δεν μπορεί να είναι κενό.", true); return; }
    const { data, error } = await state.supabase.from("map_feature_categories")
      .update({ name: clean, updated_at: new Date().toISOString() })
      .eq("id", category.id).select("*").single();
    if (error) { setStatus(`Category rename failed: ${error.message}`, true); return; }
    const index = state.categories.findIndex(item => item.id === category.id);
    if (index >= 0) state.categories[index] = data;
    renderLayers();
  }

  async function deleteCategory(category) {
    if (!window.confirm(`Διαγραφή της κατηγορίας «${category.name}»; Τα στοιχεία της θα μεταφερθούν στα Χωρίς κατηγορία.`)) return;
    const { error } = await state.supabase.from("map_feature_categories").delete().eq("id", category.id);
    if (error) { setStatus(`Category deletion failed: ${error.message}`, true); return; }
    state.categories = state.categories.filter(item => item.id !== category.id);
    state.features = state.features.map(feature => feature.category_id === category.id
      ? { ...feature, category_id: null } : feature);
    refreshAllSources();
    renderLayers();
  }

  function displayLayerName(layer) {
    if (!layer) return "";
    if (layer.slug === "kd") return "ΚΥΠΡΙΑΚΗ ΔΗΜΟΚΡΑΤΙΑ";
    if (layer.slug === "sba") return "British SBA";
    if (layer.slug === "un") return "UN BUFFER ZONE";
    return layer.name_el || layer.name_en || "";
  }


  function getFeature(id) { return state.features.find(x => x.id === id); }
  function additionalLayer() { return state.layers.find(x => x.slug === "additional_data"); }
  function canModifyFeature(feature) {
    return !!state.isEditor && !!feature &&
      getLayer(feature.layer_id)?.slug === "additional_data";
  }
  function featureColor(feature) {
    return feature?.properties?.color || PERMANENT_LAYER_COLORS[ getLayer(feature?.layer_id)?.slug ] || "#16a34a";
  }
  function featureCollection(layerId = null) {
    const rows = state.features.filter(f => (!layerId || f.layer_id === layerId) && featureVisible(f.id));
    return {
      type: "FeatureCollection",
      features: rows.map(f => ({
        type: "Feature", id: f.id, geometry: f.geometry,
        properties: {
          id: f.id, layer_id: f.layer_id,
          name_el: f.name_el || "", name_en: f.name_en || "",
          color: f.properties?.color || null,
          shape: f.properties?.shape || null
        }
      }))
    };
  }
  function circleCenterFeatureCollection(layerId) {
    const circles = state.features.filter(feature =>
      feature.layer_id === layerId && feature.properties?.shape === "circle" &&
      Array.isArray(feature.properties?.center) && feature.properties.center.length === 2 &&
      featureVisible(feature.id)
    );
    return {
      type: "FeatureCollection",
      features: circles.map(feature => ({
        type: "Feature",
        id: `circle-center-${feature.id}`,
        geometry: { type: "Point", coordinates: feature.properties.center },
        properties: { color: feature.properties?.color || "#2563eb" }
      }))
    };
  }
  function sourceId(layerId) { return `features-${layerId}`; }
  function centerSourceId(layerId) { return `circle-centers-${layerId}`; }
  function safeLayerSlug(slug) { return String(slug).replace(/[^a-zA-Z0-9_-]/g, "_"); }

  function tileKey(z, x, y) { return `${z}/${x}/${y}`; }
  function trimMapCache(cache, maxEntries = MAX_TILE_CACHE_ENTRIES) {
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }
  function parseTileLocation(location, fallbackX, fallbackY, fallbackWidth, fallbackHeight) {
    if (location && typeof location === "object") {
      return {
        x: Number(location.left ?? fallbackX), y: Number(location.top ?? fallbackY),
        width: Number(location.width ?? fallbackWidth), height: Number(location.height ?? fallbackHeight)
      };
    }
    if (typeof location === "string") {
      const values = location.split(",").map(Number);
      if (values.length === 4 && values.every(Number.isFinite)) {
        return { x: values[0], y: values[1], width: values[2], height: values[3] };
      }
    }
    return { x: fallbackX, y: fallbackY, width: fallbackWidth, height: fallbackHeight };
  }

  async function fetchTilemapBlock(z, x, y, signal) {
    const size = TILEMAP_BLOCK_SIZE;
    const left = Math.floor(x / size) * size;
    const top = Math.floor(y / size) * size;
    const requestKey = `${z}/${left}/${top}/${size}`;
    if (tileAvailabilityRequests.has(requestKey)) return tileAvailabilityRequests.get(requestKey);

    const request = (async () => {
      try {
        const url = `${ESRI_TILE_URL}/tilemap/${z}/${top}/${left}/${size}/${size}?f=json`;
        const response = await fetch(url, { signal, mode: "cors", credentials: "omit" });
        if (!response.ok) return false;
        const result = await response.json();
        if (!Array.isArray(result.data)) return false;
        const area = parseTileLocation(result.location, left, top, size, size);
        for (let row = 0; row < area.height; row++) {
          for (let col = 0; col < area.width; col++) {
            const index = row * area.width + col;
            const key = tileKey(z, area.x + col, area.y + row);
            tileAvailabilityCache.set(key, result.data[index] === 1);
          }
        }
        trimMapCache(tileAvailabilityCache, 6000);
        return true;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        console.warn("Esri tile availability check failed; trying the tile directly.", error);
        return false;
      } finally {
        tileAvailabilityRequests.delete(requestKey);
      }
    })();
    tileAvailabilityRequests.set(requestKey, request);
    return request;
  }

  async function isEsriTileAvailable(z, x, y, signal) {
    if (z < 0 || z > ESRI_MAX_NATIVE_ZOOM) return false;
    const key = tileKey(z, x, y);
    if (tileAvailabilityCache.has(key)) return tileAvailabilityCache.get(key);
    await fetchTilemapBlock(z, x, y, signal);
    if (tileAvailabilityCache.has(key)) return tileAvailabilityCache.get(key);

    // A bundle-boundary adjustment can omit the requested tile; retry precisely.
    try {
      const response = await fetch(`${ESRI_TILE_URL}/tilemap/${z}/${y}/${x}/1/1?f=json`, {
        signal, mode: "cors", credentials: "omit"
      });
      if (!response.ok) {
        tileAvailabilityCache.set(key, false);
        return false;
      }
      const result = await response.json();
      const available = Array.isArray(result.data) && result.data[0] === 1;
      tileAvailabilityCache.set(key, available);
      return available;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // null means unknown: the protocol will try a direct tile request.
      return null;
    }
  }

  async function fetchEsriTile(z, x, y, signal) {
    const key = tileKey(z, x, y);
    if (imageryTileCache.has(key)) return imageryTileCache.get(key).slice(0);
    try {
      const response = await fetch(`${ESRI_TILE_URL}/tile/${z}/${y}/${x}`, {
        signal, mode: "cors", credentials: "omit"
      });
      if (!response.ok) return null;
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.toLowerCase().includes("image/")) return null;
      const data = await response.arrayBuffer();
      imageryTileCache.set(key, data.slice(0));
      trimMapCache(imageryTileCache);
      return data;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return null;
    }
  }

  async function cropParentTile(parentBytes, childX, childY, zoomDifference) {
    const bitmap = await createImageBitmap(new Blob([parentBytes]));
    try {
      const factor = 2 ** zoomDifference;
      const cropSize = 256 / factor;
      const sx = (childX % factor) * cropSize;
      const sy = (childY % factor) * cropSize;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 256;
      const context = canvas.getContext("2d", { alpha: false });
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, sx, sy, cropSize, cropSize, 0, 0, 256, 256);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(result => result ? resolve(result) : reject(new Error("Could not create fallback tile")), "image/jpeg", 0.92);
      });
      return await blob.arrayBuffer();
    } finally {
      bitmap.close?.();
    }
  }

  async function makeTransparentTile() {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    return blob ? blob.arrayBuffer() : new ArrayBuffer(0);
  }

  function recordImageryTileStatus(requestedZ, requestedX, requestedY, sourceZ) {
    imageryTileStatus.set(tileKey(requestedZ, requestedX, requestedY), sourceZ);
    trimMapCache(imageryTileStatus, 3000);
    zoomInfoUpdate?.();
  }

  async function loadEsriTileWithFallback(z, x, y, signal) {
    const requestedKey = tileKey(z, x, y);
    if (imageryTileCache.has(`rendered:${requestedKey}`)) return imageryTileCache.get(`rendered:${requestedKey}`).slice(0);

    const highestCandidate = Math.min(z, ESRI_MAX_NATIVE_ZOOM);
    // The map's adaptive maxZoom is set from the best native imagery at its
    // centre. This per-tile fallback also refuses parent imagery that would
    // require more than 4x enlargement at the current fractional zoom.
    const liveZoom = state.map ? state.map.getZoom() : z;
    const lowestCandidate = Math.max(
      0,
      Math.ceil(liveZoom - Math.log2(MAX_LOCAL_TILE_SCALE) - 1e-9)
    );

    for (let sourceZ = highestCandidate; sourceZ >= lowestCandidate; sourceZ--) {
      const difference = z - sourceZ;
      const factor = 2 ** difference;
      const sourceX = Math.floor(x / factor);
      const sourceY = Math.floor(y / factor);
      const availability = await isEsriTileAvailable(sourceZ, sourceX, sourceY, signal);
      if (availability === false) continue;

      const sourceBytes = await fetchEsriTile(sourceZ, sourceX, sourceY, signal);
      if (!sourceBytes) continue;
      const renderedBytes = difference === 0
        ? sourceBytes
        : await cropParentTile(sourceBytes, x, y, difference);
      recordImageryTileStatus(z, x, y, sourceZ);
      imageryTileCache.set(`rendered:${requestedKey}`, renderedBytes.slice(0));
      trimMapCache(imageryTileCache);
      return renderedBytes;
    }

    // Never pass Esri's text placeholder through to MapLibre. If no source tile
    // exists within the 4x limit, return a transparent tile instead.
    recordImageryTileStatus(z, x, y, null);
    const emptyTile = await makeTransparentTile();
    imageryTileCache.set(`rendered:${requestedKey}`, emptyTile.slice(0));
    trimMapCache(imageryTileCache);
    return emptyTile;
  }

  function installEsriFallbackProtocol() {
    if (window.__cymapEsriProtocolInstalled) return;
    maplibregl.addProtocol("cymap-esri", async (params, abortController) => {
      const match = params.url.match(/^cymap-esri:\/\/(\d+)\/(\d+)\/(\d+)$/);
      if (!match) throw new Error(`Invalid CYMAP imagery tile URL: ${params.url}`);
      const z = Number(match[1]), x = Number(match[2]), y = Number(match[3]);
      const data = await loadEsriTileWithFallback(z, x, y, abortController?.signal);
      return { data };
    });
    window.__cymapEsriProtocolInstalled = true;
  }

  async function updateAdaptiveMaxZoom() {
    if (!state.map) return;
    const checkId = ++adaptiveZoomCheckId;
    const center = state.map.getCenter();
    const z = ESRI_MAX_NATIVE_ZOOM;
    const n = 2 ** z;
    const latitude = Math.max(-85.05112878, Math.min(85.05112878, center.lat));
    const latRad = latitude * Math.PI / 180;
    const x = Math.max(0, Math.min(n - 1, Math.floor((center.lng + 180) / 360 * n)));
    const y = Math.max(0, Math.min(n - 1, Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n)));

    // Find the highest native Esri tile available for the map-centre location.
    // If z19 is absent here, test its parent at z18, then z17, and so on.
    for (let sourceZ = ESRI_MAX_NATIVE_ZOOM; sourceZ >= 0; sourceZ--) {
      if (checkId !== adaptiveZoomCheckId) return; // a newer pan/zoom check superseded this one
      const difference = z - sourceZ;
      const factor = 2 ** difference;
      const available = await isEsriTileAvailable(
        sourceZ,
        Math.floor(x / factor),
        Math.floor(y / factor)
      );
      if (checkId !== adaptiveZoomCheckId) return;
      if (available === true) {
        const allowedMaxZoom = Math.min(MAP_MAX_ZOOM, sourceZ + MAX_LOCAL_ZOOM_STEPS);
        state.map.setMaxZoom(allowedMaxZoom);
        if (state.map.getZoom() > allowedMaxZoom + 1e-7) {
          state.map.setZoom(allowedMaxZoom);
        }
        return;
      }
      // null means the availability endpoint could not be checked. Do not
      // incorrectly lower the user's zoom limit because of a network failure.
      if (available === null) return;
    }
  }

  function updateZoomInfo() {
    if (!state.map) return;
    const info = $("map-zoom-info");
    if (!info) return;
    const zoom = state.map.getZoom();
    const tileZoom = Math.floor(zoom);
    const center = state.map.getCenter();
    const n = 2 ** tileZoom;
    const latitude = Math.max(-85.05112878, Math.min(85.05112878, center.lat));
    const latRad = latitude * Math.PI / 180;
    const x = Math.max(0, Math.min(n - 1, Math.floor((center.lng + 180) / 360 * n)));
    const y = Math.max(0, Math.min(n - 1, Math.floor((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n)));
    const sourceZ = imageryTileStatus.get(tileKey(tileZoom, x, y));

    if (sourceZ === undefined) {
      info.textContent = `Map zoom ${zoom.toFixed(1)} · Imagery checking…`;
      info.title = "Checking the best available Esri imagery tile for the map centre.";
      return;
    }
    if (sourceZ === null) {
      info.textContent = `Map zoom ${zoom.toFixed(1)} · No imagery within 4×`;
      info.title = "No available Esri imagery tile was found within the maximum 4× local enlargement.";
      return;
    }
    const enlargement = 2 ** Math.max(0, zoom - sourceZ);
    const formatted = enlargement >= 10 ? enlargement.toFixed(0) : enlargement.toFixed(1).replace(/\.0$/, "");
    info.textContent = `Map zoom ${zoom.toFixed(1)} · Imagery z${sourceZ} · ${formatted}×`;
    info.title = `Map zoom ${zoom.toFixed(1)}; native imagery tile zoom ${sourceZ}; effective local enlargement ${formatted}×.`;
  }

  function normalizePlaceQuery(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  }

  function placeFeatureLabel(code) {
    if (code === "PPLC") return "Πρωτεύουσα";
    if (code && code.startsWith("PPLA")) return "Διοικητικό κέντρο";
    if (code === "PPLX") return "Περιοχή / συνοικία";
    return "Πόλη / χωριό";
  }

  function hidePlaceSearchResults() {
    const results = $("place-search-results");
    const input = $("place-search-input");
    if (results) { results.hidden = true; results.innerHTML = ""; }
    if (input) input.setAttribute("aria-expanded", "false");
  }

  function renderPlaceSearchResults(places, query) {
    const results = $("place-search-results");
    const input = $("place-search-input");
    if (!results || !input) return;
    if (!places.length) {
      results.innerHTML = '<div class="place-search-empty">Δεν βρέθηκαν τοποθεσίες στην Κύπρο.</div>';
    } else {
      results.innerHTML = places.map((place, index) => {
        const primary = escapeHtml(place.name || place.ascii_name || "Άγνωστη τοποθεσία");
        const secondaryName = place.ascii_name && normalizePlaceQuery(place.ascii_name) !== normalizePlaceQuery(place.name)
          ? `<span class="place-search-secondary">${escapeHtml(place.ascii_name)}</span>` : "";
        return `<button type="button" class="place-search-result" role="option" data-place-index="${index}">
          <span class="place-search-result-icon" aria-hidden="true">⌖</span>
          <span class="place-search-result-text"><strong>${primary}</strong>${secondaryName}<small>${escapeHtml(placeFeatureLabel(place.feature_code))}</small></span>
        </button>`;
      }).join("");
      results.querySelectorAll("[data-place-index]").forEach(button => {
        button.addEventListener("click", () => selectPlace(places[Number(button.dataset.placeIndex)]));
      });
    }
    results.insertAdjacentHTML("beforeend", '<div class="place-search-attribution">Δεδομένα τοποθεσιών: GeoNames</div>');
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function selectPlace(place) {
    if (!place || !state.map) return;
    const lng = Number(place.longitude);
    const lat = Number(place.latitude);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    const input = $("place-search-input");
    if (input) input.value = place.name || place.ascii_name || "";
    hidePlaceSearchResults();
    const targetZoom = place.feature_code === "PPLC" ? 11.5 : 13;
    state.map.flyTo({
      center: [lng, lat],
      zoom: Math.max(state.map.getZoom(), targetZoom),
      essential: true,
      duration: 1100
    });
    showMapFeedback(`${place.name || place.ascii_name} · ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
  }

  async function searchCyprusPlaces(rawQuery) {
    const query = normalizePlaceQuery(rawQuery);
    const results = $("place-search-results");
    if (query.length < 2) { hidePlaceSearchResults(); return; }
    const requestId = ++state.placeSearchRequestId;
    if (results) {
      results.innerHTML = '<div class="place-search-empty">Αναζήτηση…</div>';
      results.hidden = false;
      $("place-search-input")?.setAttribute("aria-expanded", "true");
    }
    const { data, error } = await state.supabase.rpc("search_cyprus_places", {
      search_term: query,
      result_limit: 10
    });
    if (requestId !== state.placeSearchRequestId) return;
    if (error) {
      console.error("Cyprus place search failed:", error);
      if (results) {
        results.innerHTML = '<div class="place-search-empty place-search-error">Η αναζήτηση δεν είναι διαθέσιμη. Ελέγξτε ότι έχει εγκατασταθεί ο πίνακας τοποθεσιών και έχουν εισαχθεί τα δεδομένα.</div>';
        results.hidden = false;
      }
      return;
    }
    renderPlaceSearchResults(data || [], query);
  }

  function initPlaceSearch() {
    const input = $("place-search-input");
    const clear = $("place-search-clear");
    if (!input || !clear) return;
    input.addEventListener("input", () => {
      if (state.placeSearchTimer) clearTimeout(state.placeSearchTimer);
      state.placeSearchTimer = setTimeout(() => searchCyprusPlaces(input.value), 260);
    });
    input.addEventListener("keydown", event => {
      if (event.key === "Escape") { hidePlaceSearchResults(); input.blur(); }
      if (event.key === "Enter") {
        const first = $("place-search-results")?.querySelector("[data-place-index]");
        if (first) { event.preventDefault(); first.click(); }
      }
    });
    clear.addEventListener("click", () => {
      input.value = "";
      state.placeSearchRequestId++;
      hidePlaceSearchResults();
      input.focus();
    });
    document.addEventListener("pointerdown", event => {
      const wrapper = $("place-search");
      if (wrapper && !wrapper.contains(event.target)) hidePlaceSearchResults();
    });
  }

  let mapFeedbackTimer = null;
  function showMapFeedback(message, bad = false) {
    const feedback = $("map-feedback");
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle("is-error", bad);
    feedback.classList.add("is-visible");
    if (mapFeedbackTimer) clearTimeout(mapFeedbackTimer);
    mapFeedbackTimer = setTimeout(() => feedback.classList.remove("is-visible"), 2600);
  }

  async function copyMapCoordinates(lat, lng) {
    const coordinateText = `${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(coordinateText);
        copied = true;
      }
    } catch (error) { console.warn("Clipboard API unavailable; trying fallback:", error); }
    if (!copied) {
      const temporary = document.createElement("textarea");
      temporary.value = coordinateText;
      temporary.setAttribute("readonly", "");
      temporary.style.position = "fixed";
      temporary.style.opacity = "0";
      document.body.appendChild(temporary);
      temporary.select();
      try { copied = document.execCommand("copy"); } catch { copied = false; }
      temporary.remove();
    }
    showMapFeedback(copied
      ? `Αντιγράφηκαν συντεταγμένες: ${coordinateText}`
      : `Συντεταγμένες: ${coordinateText} (η αντιγραφή απέτυχε)`, !copied);
  }

  async function init() {
    if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT-REF") ||
        !cfg.SUPABASE_PUBLISHABLE_KEY || cfg.SUPABASE_PUBLISHABLE_KEY.includes("YOUR_SUPABASE")) {
      setStatus("Setup needed: add Supabase config", true);
      layersEl.innerHTML = '<div class="empty">Open <strong>config.js</strong> and add your Supabase Project URL and publishable key.</div>';
      return;
    }
    if (!window.supabase || !window.maplibregl || !window.MapboxDraw) {
      setStatus("A library failed to load", true);
      layersEl.textContent = "Could not load a required map library. Check your internet connection.";
      return;
    }
    state.supabase = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY);
    state.visibility = readVisibility();
    initMap();
    initPlaceSearch();
    try {
      const { data: { session } } = await state.supabase.auth.getSession();
      if (session?.user) await applySession(session.user);
      await loadLayersAndFeatures();
      state.supabase.auth.onAuthStateChange((_event, session) => {
        setTimeout(async () => {
          if (session?.user) {
            await applySession(session.user);
            await loadLayersAndFeatures();
          } else clearSession();
        }, 0);
      });
      setStatus(state.isEditor ? (state.user?.email?.split("@")[0] || "") : "");
    } catch (e) {
      console.error(e);
      setStatus("Database connection failed", true);
      layersEl.innerHTML = `<div class="empty">${escapeHtml(e.message || "Could not load map data.")}</div>`;
    }
  }

  function configureSatelliteAndLabels() {
    // Keep every symbol layer from the OpenFreeMap Liberty style (place names,
    // roads, POIs, road shields, etc.), while using satellite imagery beneath it.
    // Label language order: Greek -> English -> other available/local name -> ref.
    const originalLayers = (state.map.getStyle()?.layers || []).slice();
    const symbolLayers = originalLayers.filter(l => l.type === "symbol");
    const backgroundLayers = originalLayers.filter(l => l.type === "background");
    const languageFallback = [
      "coalesce",
      ["get", "name:el"],
      ["get", "name_el"],
      ["get", "name:en"],
      ["get", "name_en"],
      ["get", "name"],
      ["get", "name:latin"],
      ["get", "name:local"],
      ["get", "ref"]
    ];

    // Satellite imagery should not be covered by the vector style's opaque land,
    // building, road and water fills. Preserve all symbol layers for labels/icons.
    for (const layer of originalLayers) {
      if (layer.type !== "symbol" && layer.type !== "background" &&
          state.map.getLayer(layer.id)) {
        state.map.setLayoutProperty(layer.id, "visibility", "none");
      }
      if (layer.type === "symbol" && layer.layout?.["text-field"] !== undefined) {
        try {
          state.map.setLayoutProperty(layer.id, "text-field", languageFallback);
          const layerName = String(layer.id || "").toLowerCase();
          if (layerName.includes("road") || layerName.includes("street") || layerName.includes("transport")) {
            if (layer.layout["text-size"] !== undefined) state.map.setLayoutProperty(layer.id, "text-size", 14);
          }
          // Improve legibility with a strong light halo behind labels. A true opaque
          // box is not supported consistently by every symbol layer in this style.
          if (layer.paint && layer.paint["text-halo-color"] !== undefined) {
            state.map.setPaintProperty(layer.id, "text-halo-color", "#ffffff");
            state.map.setPaintProperty(layer.id, "text-halo-width", 3);
            state.map.setPaintProperty(layer.id, "text-halo-blur", 0.15);
          }
        }
        catch (e) { console.warn("Could not update label style for", layer.id, e); }
      }
    }

    if (!state.map.getSource("esriImagery")) {
      state.map.addSource("esriImagery", {
        type: "raster",
        tiles: ["cymap-esri://{z}/{x}/{y}"],
        tileSize: 256,
        maxzoom: MAP_MAX_ZOOM,
        attribution: "Satellite imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community"
      });
    }
    if (!state.map.getLayer("satellite")) {
      const firstSymbol = symbolLayers.find(l => state.map.getLayer(l.id));
      state.map.addLayer(
        { id: "satellite", type: "raster", source: "esriImagery" },
        firstSymbol?.id
      );
    }
    if (!symbolLayers.length) console.warn("No symbol layers found in the OpenFreeMap style.");
  }

  function initMap() {
    installEsriFallbackProtocol();
    state.map = new maplibregl.Map({
      attributionControl: { compact: true },
      container: "map",
      center: cfg.MAP_CENTER || [33.2, 35.1],
      zoom: cfg.MAP_ZOOM || 8,
      maxZoom: MAP_MAX_ZOOM,
      style: "https://tiles.openfreemap.org/styles/liberty"
    });
    zoomInfoUpdate = updateZoomInfo;
    state.map.on("zoom", updateZoomInfo);
    state.map.on("move", updateZoomInfo);
    state.map.on("zoomend", updateZoomInfo);
    state.map.on("moveend", () => {
      updateZoomInfo();
      updateAdaptiveMaxZoom();
    });
    updateZoomInfo();
    state.map.addControl(new maplibregl.NavigationControl(), "top-right");
    state.map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    state.map.on("load", () => {
      try { configureSatelliteAndLabels(); }
      catch (e) { console.error("Could not configure satellite/labels:", e); }
      state.mapLoaded = true;
      updateAdaptiveMaxZoom();
      for (const layer of state.layers) addLayerToMap(layer);
      refreshAllSources();
    });
    state.map.on("click", (e) => {
      if (state.circlePlacementActive && state.isEditor) {
        state.circlePlacementActive = false;
        state.map.getCanvas().style.cursor = "";
        const circleCenter = [e.lngLat.lng, e.lngLat.lat];
        const geometry = createCircleGeometry(circleCenter[0], circleCenter[1], DEFAULT_CIRCLE_RADIUS_METRES);
        state.selectedFeature = {
          layer_id: state.additionalLayerId,
          name_el: "", name_en: "", geometry,
          description: "",
          properties: { color: "#2563eb", shape: "circle", radius_m: DEFAULT_CIRCLE_RADIUS_METRES, center: circleCenter }
        };
        openFeatureDialog(state.selectedFeature, false);
        return;
      }
      // In drawing modes, the click belongs to Mapbox Draw.
      if (state.isEditor && state.draw && state.draw.getMode() !== "simple_select" &&
          state.draw.getMode() !== "direct_select") return;
      const hits = state.map.queryRenderedFeatures(e.point, { layers: state.renderLayerIds || [] });
      // Skip permanent layers and find a user-created feature underneath them if present.
      for (const hit of hits) {
        const props = hit.properties || {};
        const f = getFeature(props.id);
        if (f && getLayer(f.layer_id)?.slug === "additional_data") {
          showFeaturePopup(f, e.lngLat);
          break;
        }
      }
    });
    state.map.on("contextmenu", (e) => {
      e.preventDefault();
      e.originalEvent?.preventDefault?.();
      copyMapCoordinates(e.lngLat.lat, e.lngLat.lng);
    });
    state.map.on("error", (e) => console.warn("MapLibre error:", e.error || e));
  }

  async function loadLayersAndFeatures() {
    const [layersResult, featuresResult, categoriesResult] = await Promise.all([
      state.supabase.from("map_layers").select("*").order("sort_order"),
      state.supabase.from("map_features").select("*"),
      state.user
        ? state.supabase.from("map_feature_categories").select("*").eq("owner_id", state.user.id).order("sort_order").order("created_at")
        : Promise.resolve({ data: [], error: null })
    ]);
    if (layersResult.error) throw layersResult.error;
    if (featuresResult.error) throw featuresResult.error;
    if (categoriesResult.error) throw new Error(`Categories table unavailable. Run the supplied CYMAP categories SQL migration. ${categoriesResult.error.message}`);
    state.layers = layersResult.data || [];
    state.categories = categoriesResult.data || [];
    // Keep all permanent-layer features, but only show additional_data records
    // owned by the currently signed-in Supabase user.
    state.features = (featuresResult.data || []).filter(feature => {
      const layer = state.layers.find(item => item.id === feature.layer_id);
      if (layer?.slug !== "additional_data") return true;
      return !!state.user && feature.owner_id === state.user.id;
    });
    if (state.user) {
      const legacyKey = `cymap.hiddenFeatures.v1.${state.user.id}`;
      try {
        const legacyHidden = JSON.parse(localStorage.getItem(legacyKey) || "[]");
        if (Array.isArray(legacyHidden) && legacyHidden.length) {
          const pending = state.features.filter(feature => legacyHidden.includes(String(feature.id)) && feature.is_visible !== false);
          for (const feature of pending) {
            const { error } = await state.supabase.from("map_features").update({ is_visible: false }).eq("id", feature.id);
            if (!error) feature.is_visible = false;
          }
        }
        localStorage.removeItem(legacyKey);
      } catch (error) { console.warn("Could not migrate old feature visibility settings:", error); }
    }
    state.additionalLayerId = additionalLayer()?.id || null;
    if (!state.additionalLayerId) {
      throw new Error('Missing layer "ΕΠΙΠΡΟΣΘΕΤΑ ΔΕΔΟΜΕΝΑ". Run the CYMAP protection migration SQL.');
    }
    for (const layer of state.layers) {
      if (!(layer.id in state.visibility)) state.visibility[layer.id] = layer.slug !== "kd";
    }
    saveVisibility();
    renderLayers();
    renderLayerSelect();
    if (state.mapLoaded) {
      for (const layer of state.layers) addLayerToMap(layer);
      refreshAllSources();
    }
  }

  function addLayerToMap(layer) {
    if (!state.map || !state.mapLoaded) return;
    const slug = safeLayerSlug(layer.slug);
    const src = sourceId(layer.id);
    if (!state.map.getSource(src)) {
      state.map.addSource(src, { type: "geojson", data: featureCollection(layer.id) });
    }
    const centerSrc = centerSourceId(layer.id);
    if (!state.map.getSource(centerSrc)) {
      state.map.addSource(centerSrc, { type: "geojson", data: circleCenterFeatureCollection(layer.id) });
    }
    const fill = `fill-${slug}`, outline = `outline-${slug}`, points = `points-${slug}`;
    const circleCenters = `circle-centers-${slug}`;
    const layerColor = PERMANENT_LAYER_COLORS[layer.slug] || "#16a34a";
    const perFeatureColor = ["coalesce", ["get", "color"], layerColor];
    if (!state.map.getLayer(fill)) state.map.addLayer({
      id: fill, type: "fill", source: src,
      filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
      paint: {
        "fill-color": perFeatureColor,
        // A circle's interior is 80% transparent (20% opaque); other polygons retain 27% opacity.
        "fill-opacity": ["case", ["==", ["get", "shape"], "circle"], 0.2, 0.27]
      }
    });
    if (!state.map.getLayer(outline)) state.map.addLayer({
      id: outline, type: "line", source: src,
      filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
      paint: { "line-color": perFeatureColor, "line-width": 2.5 }
    });
    if (!state.map.getLayer(points)) state.map.addLayer({
      id: points, type: "circle", source: src,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 6,
        "circle-color": perFeatureColor,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.7
      }
    });
    if (!state.map.getLayer(circleCenters)) state.map.addLayer({
      id: circleCenters, type: "circle", source: centerSrc,
      paint: {
        "circle-radius": 5,
        "circle-color": ["coalesce", ["get", "color"], "#2563eb"],
        "circle-opacity": 0.6,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
        "circle-stroke-opacity": 0.9
      }
    });
    if (!state.renderLayerIds) state.renderLayerIds = [];
    for (const id of [fill, outline, points, circleCenters]) {
      if (!state.renderLayerIds.includes(id)) state.renderLayerIds.push(id);
    }
    setMapLayerVisibility(layer);
  }

  function setMapLayerVisibility(layer) {
    if (!state.map || !state.mapLoaded) return;
    const visible = layerVisible(layer.id) ? "visible" : "none";
    const slug = safeLayerSlug(layer.slug);
    for (const id of [`fill-${slug}`, `outline-${slug}`, `points-${slug}`, `circle-centers-${slug}`]) {
      if (state.map.getLayer(id)) state.map.setLayoutProperty(id, "visibility", visible);
    }
  }
  function refreshAllSources() {
    if (!state.map || !state.mapLoaded) return;
    for (const layer of state.layers) {
      const source = state.map.getSource(sourceId(layer.id));
      if (source) source.setData(featureCollection(layer.id));
      const centerSource = state.map.getSource(centerSourceId(layer.id));
      if (centerSource) centerSource.setData(circleCenterFeatureCollection(layer.id));
      setMapLayerVisibility(layer);
    }
  }
  function renderLayers() {
    layersEl.innerHTML = "";
    if (!state.layers.length) {
      layersEl.innerHTML = '<div class="empty">No layers found in the database.</div>';
      return;
    }
    for (const layer of state.layers) {
      if (layer.slug === "additional_data" && !state.isEditor) continue;
      const row = document.createElement("div");
      row.className = "layer-row";
      const checked = layerVisible(layer.id);
      const featureCount = state.features.filter(f => f.layer_id === layer.id).length;
      const color = PERMANENT_LAYER_COLORS[layer.slug] || "#16a34a";
      const swatchStyle = layer.slug === "additional_data"
        ? "background:linear-gradient(135deg,#ef4444 0%,#f97316 20%,#eab308 40%,#22c55e 60%,#3b82f6 80%,#a855f7 100%)"
        : `background:${color}`;
      row.innerHTML = `
        <span class="layer-swatch" style="${swatchStyle}"></span>
        <input type="checkbox" aria-label="Toggle ${escapeHtml(layer.name_en || layer.name_el)}" ${checked ? "checked" : ""}>
        <span class="layer-name"><strong>${escapeHtml(displayLayerName(layer))}</strong>${layer.slug === "additional_data" ? `<small>${featureCount} στοιχεία</small>` : ""}</span>`;
      row.querySelector("input").addEventListener("change", (e) => {
        state.visibility[layer.id] = e.target.checked;
        saveVisibility();
        setMapLayerVisibility(layer);
      });
      layersEl.appendChild(row);
      if (layer.slug !== "additional_data") continue;

      const toolbar = document.createElement("div");
      toolbar.className = "category-toolbar";
      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "button secondary category-add";
      addButton.textContent = "＋ Νέα κατηγορία";
      addButton.addEventListener("click", createCategory);
      toolbar.appendChild(addButton);
      layersEl.appendChild(toolbar);

      const featureItems = state.features.filter(f => f.layer_id === layer.id)
        .slice().sort((a, b) => displayFeatureName(a).localeCompare(displayFeatureName(b), "el"));

      const renderGroup = (category, items, isUncategorized = false) => {
        const group = document.createElement("section");
        group.className = `feature-category${isUncategorized ? " is-uncategorized" : ""}`;
        group.dataset.categoryId = category?.id || "";
        const header = document.createElement("div");
        header.className = "feature-category-header";
        const collapseId = String(category?.id || "__uncategorized__");
        const collapsed = state.collapsedCategoryIds.has(collapseId);
        const collapseButton = document.createElement("button");
        collapseButton.type = "button";
        collapseButton.className = "category-collapse-toggle";
        collapseButton.title = collapsed ? "Ανάπτυξη κατηγορίας" : "Σύμπτυξη κατηγορίας";
        collapseButton.setAttribute("aria-label", collapseButton.title);
        collapseButton.setAttribute("aria-expanded", String(!collapsed));
        collapseButton.innerHTML = collapsed
          ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>'
          : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
        collapseButton.addEventListener("click", () => toggleCategoryCollapsed(collapseId));
        header.appendChild(collapseButton);
        const title = document.createElement("span");
        title.className = "feature-category-title";
        title.textContent = isUncategorized ? "Χωρίς κατηγορία" : category.name;
        header.appendChild(title);
        if (!isUncategorized) {
          const categoryEye = document.createElement("button");
          const visible = categoryVisible(category);
          categoryEye.type = "button";
          categoryEye.className = `additional-feature-visibility category-eye${visible ? "" : " is-hidden"}`;
          categoryEye.title = visible ? "Απόκρυψη κατηγορίας" : "Εμφάνιση κατηγορίας";
          categoryEye.setAttribute("aria-label", categoryEye.title);
          categoryEye.setAttribute("aria-pressed", String(visible));
          categoryEye.innerHTML = visible
            ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>'
            : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 5.2A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a16 16 0 0 1-3.1 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10 10 0 0 0 5.1-1.4"/></svg>';
          categoryEye.addEventListener("click", () => toggleCategoryVisibility(category));
          const rename = document.createElement("button");
          rename.type = "button"; rename.className = "icon-button category-action"; rename.title = "Μετονομασία"; rename.textContent = "✎";
          rename.addEventListener("click", () => renameCategory(category));
          const remove = document.createElement("button");
          remove.type = "button"; remove.className = "icon-button category-action"; remove.title = "Διαγραφή κατηγορίας"; remove.textContent = "×";
          remove.addEventListener("click", () => deleteCategory(category));
          header.append(categoryEye, rename, remove);
        }
        group.appendChild(header);
        const list = document.createElement("div");
        list.className = "additional-feature-list category-feature-list";
        list.hidden = collapsed;
        list.setAttribute("aria-label", isUncategorized ? "Στοιχεία χωρίς κατηγορία" : `Στοιχεία: ${category.name}`);
        list.addEventListener("dragover", event => { event.preventDefault(); group.classList.add("drop-target"); });
        list.addEventListener("dragleave", event => { if (!group.contains(event.relatedTarget)) group.classList.remove("drop-target"); });
        list.addEventListener("drop", event => {
          event.preventDefault(); group.classList.remove("drop-target");
          const id = event.dataTransfer.getData("text/plain");
          const feature = state.features.find(item => String(item.id) === id);
          if (feature) moveFeatureToCategory(feature, category?.id || null);
        });
        if (!items.length) {
          list.innerHTML = '<div class="additional-feature-empty">Σύρετε εδώ λειτουργίες για να τις προσθέσετε</div>';
        } else {
          for (const feature of items) {
            const item = document.createElement("div");
            item.className = "additional-feature-item";
            item.draggable = true;
            item.addEventListener("dragstart", event => {
              event.dataTransfer.setData("text/plain", String(feature.id));
              event.dataTransfer.effectAllowed = "move";
              item.classList.add("is-dragging");
            });
            item.addEventListener("dragend", () => item.classList.remove("is-dragging"));
            const centerButton = document.createElement("button");
            centerButton.type = "button"; centerButton.className = "additional-feature-center";
            centerButton.title = "Κεντράρισμα στον χάρτη";
            centerButton.innerHTML = `<span class="additional-feature-dot" style="background:${escapeHtml(featureColor(feature))}"></span><span class="additional-feature-name">${escapeHtml(displayFeatureName(feature))}</span>`;
            centerButton.addEventListener("click", () => centerOnFeature(feature));
            const visible = featureOwnVisible(feature);
            const eyeButton = document.createElement("button");
            eyeButton.type = "button";
            eyeButton.className = `additional-feature-visibility${visible ? "" : " is-hidden"}`;
            eyeButton.title = visible ? "Απόκρυψη στοιχείου" : "Εμφάνιση στοιχείου";
            eyeButton.setAttribute("aria-label", eyeButton.title);
            eyeButton.setAttribute("aria-pressed", String(visible));
            eyeButton.innerHTML = visible
              ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>'
              : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 3 18 18M10.6 5.2A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a16 16 0 0 1-3.1 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10 10 0 0 0 5.1-1.4"/></svg>';
            eyeButton.addEventListener("click", () => toggleFeatureVisibility(feature));
            const moveSelect = document.createElement("select");
            moveSelect.className = "feature-move-select";
            moveSelect.title = "Μεταφορά σε κατηγορία";
            moveSelect.setAttribute("aria-label", "Μεταφορά σε κατηγορία");
            const uncategorizedOption = document.createElement("option");
            uncategorizedOption.value = ""; uncategorizedOption.textContent = "Χωρίς κατηγορία";
            moveSelect.appendChild(uncategorizedOption);
            for (const cat of state.categories) {
              const option = document.createElement("option"); option.value = cat.id; option.textContent = cat.name;
              moveSelect.appendChild(option);
            }
            moveSelect.value = feature.category_id || "";
            moveSelect.addEventListener("change", () => moveFeatureToCategory(feature, moveSelect.value));
            item.append(centerButton, moveSelect, eyeButton);
            list.appendChild(item);
          }
        }
        group.appendChild(list);
        layersEl.appendChild(group);
      };

      for (const category of state.categories) {
        renderGroup(category, featureItems.filter(feature => feature.category_id === category.id));
      }
      renderGroup(null, featureItems.filter(feature => !feature.category_id), true);
    }
  }

  function centerOnFeature(feature) {
    if (!state.map || !feature?.geometry) return;
    // Centering does not override the user's saved individual/category visibility settings.
    const layer = getLayer(feature.layer_id);
    if (layer && !layerVisible(layer.id)) {
      state.visibility[layer.id] = true;
      saveVisibility();
      setMapLayerVisibility(layer);
      renderLayers();
    }

    const geometry = feature.geometry;
    if (geometry.type === "Point") {
      const [lng, lat] = geometry.coordinates;
      state.map.flyTo({ center: [lng, lat], zoom: Math.max(state.map.getZoom(), 13), essential: true });
      return;
    }

    const coordinates = [];
    const collect = value => {
      if (Array.isArray(value) && value.length >= 2 &&
          typeof value[0] === "number" && typeof value[1] === "number") {
        coordinates.push(value);
      } else if (Array.isArray(value)) {
        value.forEach(collect);
      }
    };
    collect(geometry.coordinates);
    if (!coordinates.length) return;
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const [lng, lat] of coordinates) {
      west = Math.min(west, lng); south = Math.min(south, lat);
      east = Math.max(east, lng); north = Math.max(north, lat);
    }
    if (west === east && south === north) {
      state.map.flyTo({ center: [west, south], zoom: Math.max(state.map.getZoom(), 12), essential: true });
    } else {
      state.map.fitBounds([[west, south], [east, north]], {
        padding: { top: 80, right: 80, bottom: 80, left: 80 },
        maxZoom: 12,
        duration: 900
      });
    }
  }

  function renderLayerSelect() {
    if (layerSelect) layerSelect.innerHTML = "";
    // The target layer is fixed by design; no user-facing layer selection.
  }

  async function applySession(user) {
    const previousUserId = state.user?.id || null;
    if (previousUserId && previousUserId !== user.id) {
      // Do not leave the previous account's personal features in the map cache.
      state.features = state.features.filter(feature =>
        getLayer(feature.layer_id)?.slug !== "additional_data"
      );
      state.categories = [];
      refreshAllSources();
    }
    state.user = user;
    if (state.collapsedCategoriesUserId !== user.id) loadCollapsedCategories(user.id);
    const { data, error } = await state.supabase.from("map_editors")
      .select("user_id").eq("user_id", user.id).maybeSingle();
    if (error) console.warn("Editor permission check:", error.message);
    state.isEditor = !!data;
    $("editor-panel").classList.toggle("hidden", !state.isEditor);
    $("login-open").textContent = "Είσοδος";
    $("login-open").classList.toggle("hidden", state.isEditor);
    $("logout").textContent = "Έξοδος";
    $("logout").classList.toggle("hidden", !state.isEditor);
    renderLayers();
    const username = Object.keys(cfg.USER_EMAILS || {}).find(k => cfg.USER_EMAILS[k] === user.email) || user.email?.split("@")[0] || "user";
    setStatus(state.isEditor ? username : "");
  }
  function clearSession() {
    state.user = null;
    state.collapsedCategoriesUserId = null;
    state.collapsedCategoryIds = new Set();
    state.circlePlacementActive = false;
    if (state.map) state.map.getCanvas().style.cursor = "";
    state.hiddenFeatureIds = new Set();
    state.categories = [];
    state.isEditor = false;
    // Remove personal data from memory and redraw immediately on logout.
    state.features = state.features.filter(feature =>
      getLayer(feature.layer_id)?.slug !== "additional_data"
    );
    if (state.selectedFeature && getLayer(state.selectedFeature.layer_id)?.slug === "additional_data") {
      state.selectedFeature = null;
    }
    state.pendingDeleteFeature = null;
    if (state.map) document.querySelectorAll(".maplibregl-popup").forEach(el => el.remove());
    $("editor-panel").classList.add("hidden");
    $("login-open").classList.remove("hidden");
    $("logout").classList.add("hidden");
    renderLayers();
    refreshAllSources();
    setStatus("");
    if (state.draw) {
      try { state.map.removeControl(state.draw); } catch {}
      state.draw = null;
    }
  }

  function ensureDraw() {
    if (!state.isEditor) throw new Error("Sign in with an authorized editor account first.");
    if (!state.draw) {
      state.draw = new MapboxDraw({
        displayControlsDefault: false,
        controls: {},
        defaultMode: "simple_select",
        styles: [
          { id:"gl-draw-polygon-fill-inactive", type:"fill", filter:["all",["==","$type","Polygon"],["!=","mode","static"]], paint:{"fill-color":"#16a34a","fill-outline-color":"#14532d","fill-opacity":0.18}},
          { id:"gl-draw-polygon-stroke-inactive", type:"line", filter:["all",["==","$type","Polygon"],["!=","mode","static"]], layout:{"line-cap":"round","line-join":"round"}, paint:{"line-color":"#14532d","line-width":2}},
          { id:"gl-draw-polygon-fill-active", type:"fill", filter:["all",["==","$type","Polygon"],["==","mode","draw_polygon"]], paint:{"fill-color":"#16a34a","fill-opacity":0.25}},
          { id:"gl-draw-polygon-stroke-active", type:"line", filter:["all",["==","$type","Polygon"],["==","mode","draw_polygon"]], paint:{"line-color":"#14532d","line-width":2}},
          { id:"gl-draw-line-inactive", type:"line", filter:["all",["==","$type","LineString"],["!=","mode","static"]], layout:{"line-cap":"round","line-join":"round"}, paint:{"line-color":"#14532d","line-width":2}},
          { id:"gl-draw-point-inactive", type:"circle", filter:["all",["==","$type","Point"],["!=","mode","static"]], paint:{"circle-radius":6,"circle-color":"#16a34a","circle-stroke-color":"#fff","circle-stroke-width":2}},
          { id:"gl-draw-point-active", type:"circle", filter:["all",["==","$type","Point"],["==","mode","draw_point"]], paint:{"circle-radius":6,"circle-color":"#16a34a","circle-stroke-color":"#fff","circle-stroke-width":2}}
        ]
      });
      state.map.addControl(state.draw, "top-right");
      state.map.on("draw.create", onDrawCreate);
    }
    return state.draw;
  }

  const DEFAULT_CIRCLE_RADIUS_METRES = 5000;
  function measureGeodesicDistanceMetres(a, b) {
    const earthRadius = 6371008.8;
    const toRadians = value => value * Math.PI / 180;
    const lat1 = toRadians(a[1]), lat2 = toRadians(b[1]);
    const dLat = lat2 - lat1, dLng = toRadians(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * earthRadius * Math.asin(Math.sqrt(h));
  }

  function existingCircleRadius(feature) {
    const stored = Number(feature.properties?.radius_m);
    if (Number.isFinite(stored) && stored > 0) return stored;
    const ring = feature.geometry?.coordinates?.[0];
    if (!Array.isArray(ring) || ring.length < 4) return DEFAULT_CIRCLE_RADIUS_METRES;
    const center = [ringCentroidLongitude(ring), ringCentroidLatitude(ring)];
    return Math.max(1, Math.round(measureGeodesicDistanceMetres(center, ring[0])));
  }

  function createCircleGeometry(longitude, latitude, radiusMetres = DEFAULT_CIRCLE_RADIUS_METRES) {
    const earthRadius = 6371008.8;
    const angularDistance = radiusMetres / earthRadius;
    const lat1 = latitude * Math.PI / 180;
    const lon1 = longitude * Math.PI / 180;
    const ring = [];
    // 96 geodesic segments produce a smooth circle for the selected radius.
    for (let bearing = 0; bearing <= 360; bearing += 360 / 96) {
      const theta = bearing * Math.PI / 180;
      const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(angularDistance) +
        Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(theta)
      );
      const lon2 = lon1 + Math.atan2(
        Math.sin(theta) * Math.sin(angularDistance) * Math.cos(lat1),
        Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
      );
      ring.push([((lon2 * 180 / Math.PI + 540) % 360) - 180, lat2 * 180 / Math.PI]);
    }
    if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
      ring.push([...ring[0]]);
    }
    return { type: "Polygon", coordinates: [ring] };
  }

  function beginCirclePlacement() {
    if (!state.isEditor || !state.additionalLayerId) {
      alert("Απαιτείται εξουσιοδοτημένη είσοδος.");
      return;
    }
    if (state.draw) {
      try { state.draw.deleteAll(); state.draw.changeMode("simple_select"); } catch {}
    }
    state.circlePlacementActive = true;
    state.map.getCanvas().style.cursor = "crosshair";
    setStatus(`Κάντε κλικ στον χάρτη για να ορίσετε το κέντρο του κύκλου (προεπιλεγμένη ακτίνα ${DEFAULT_CIRCLE_RADIUS_METRES} m).`);
  }

  function beginDraw(mode) {
    try {
      state.circlePlacementActive = false;
      if (state.map) state.map.getCanvas().style.cursor = "";
      if (!state.additionalLayerId) throw new Error('Missing layer "ΕΠΙΠΡΟΣΘΕΤΑ ΔΕΔΟΜΕΝΑ".');
      const draw = ensureDraw();
      draw.deleteAll();
      const drawHelp = $("draw-help");
      if (drawHelp) {
        drawHelp.textContent = mode === "draw_point"
          ? "Click the map once to place a point. Enter a name and color to save it."
          : "Click to add polygon corners, then double-click to finish. Enter a name and color to save it.";
      }
      draw.changeMode(mode);
    } catch (e) { alert(e.message); }
  }

  function onDrawCreate(e) {
    if (!state.isEditor) return;
    const drawn = (e.features || [])[0];
    if (!drawn) return;
    const geometry = drawn.geometry;
    // Crucial: the geometry remains client-side until the user presses Save.
    // Closing the dialog therefore cancels creation and never writes to Supabase.
    try { state.draw.deleteAll(); state.draw.changeMode("simple_select"); } catch {}
    state.selectedFeature = {
      layer_id: state.additionalLayerId,
      name_el: "", name_en: "", geometry,
      description: "",
      properties: { color: PERMANENT_LAYER_COLORS.additional_data }
    };
    openFeatureDialog(state.selectedFeature, false);
  }

  function displayFeatureName(feature) {
    const raw = String(feature.name_el || feature.name_en || "Unnamed feature").trim();
    if (getLayer(feature.layer_id)?.slug === "kd" && /^ΚΥΠΡΙΑΚΗ ΔΗΜΟΚΡΑΤΙΑ(?:\s+\d+)?$/i.test(raw)) return "ΚΥΠΡΙΑΚΗ ΔΗΜΟΚΡΑΤΙΑ";
    if (getLayer(feature.layer_id)?.slug === "controlled_areas" && /^Ελεγχόμενη περιοχή(?:\s+\d+)?$/i.test(raw)) return "ΕΛΕΓΧΟΜΕΝΕΣ ΠΕΡΙΟΧΕΣ";
    if (getLayer(feature.layer_id)?.slug === "uncontrolled_areas" && /^Μη ελεγχόμενη περιοχή(?:\s+\d+)?$/i.test(raw)) return "ΜΗ ΕΛΕΓΧΟΜΕΝΕΣ ΠΕΡΙΟΧΕΣ";
    if (getLayer(feature.layer_id)?.slug === "un" && /^Ζώνη των Ηνωμένων Εθνών(?:\s+\d+)?$/i.test(raw)) return "UN BUFFER ZONE";
    if (getLayer(feature.layer_id)?.slug === "sba" && /^Βρετανικές Κυρίαρχες Περιοχές Βάσεων(?:\s+\d+)?$/i.test(raw)) return "ΒRITISH SBA";
    return raw;
  }

  function formatCoord(value) {
    return Number(value).toFixed(6).replace(/\\.?0+$/, "");
  }

  function coordinateSummary(feature) {
    const geometry = feature?.geometry;
    if (!geometry) return "";
    if (geometry.type === "Point") {
      const [lng, lat] = geometry.coordinates;
      return `Συντεταγμένες: ${formatCoord(lat)}, ${formatCoord(lng)}`;
    }
    if (feature.properties?.shape === "circle") return "";
    if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
      const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
      const lines = [];
      polygons.forEach((polygon, pIndex) => {
        const ring = polygon?.[0] || [];
        const vertices = ring.slice(0, -1);
        vertices.forEach((coord, index) => {
          lines.push(`${pIndex ? `Πολύγωνο ${pIndex + 1}, ` : ""}Κορυφή ${index + 1}: ${formatCoord(coord[1])}, ${formatCoord(coord[0])}`);
        });
      });
      return lines.join("\\n");
    }
    return "";
  }

  function showFeaturePopup(feature, lngLat) {
    const title = displayFeatureName(feature);
    const canEdit = canModifyFeature(feature);
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px" })
      .setLngLat(lngLat)
      .setHTML(`<div class="popup-title">${escapeHtml(title)}</div>
        <div class="coordinate-summary">${escapeHtml(coordinateSummary(feature)).replace(/\\n/g, "<br>")}</div>
        ${canEdit ? `<div class="popup-actions"><button data-action="details">Αλλαγή</button><button data-action="delete">Διαγραφή</button></div>` : ""}`)
      .addTo(state.map);
    if (canEdit) {
      popup.getElement().querySelector('[data-action="details"]')
        ?.addEventListener("click", () => {
          popup.remove();
          openFeatureDialog(feature, true);
        });
      popup.getElement().querySelector('[data-action="delete"]')
        ?.addEventListener("click", () => {
          popup.remove();
          state.selectedFeature = null;
          openDeleteDialog(feature, false);
        });
    }
  }


  function editablePolygonRing(geometry) {
    if (!geometry) return null;
    if (geometry.type === "Polygon") return geometry.coordinates?.[0] || null;
    if (geometry.type === "MultiPolygon" && geometry.coordinates?.length === 1) {
      return geometry.coordinates[0]?.[0] || null;
    }
    return null;
  }

  function addEditablePolygonRow(lat = "", lng = "") {
    const list = $("edit-polygon-coordinate-list");
    const index = list.children.length + 1;
    const row = document.createElement("div");
    row.className = "coordinate-row";
    row.innerHTML = `
      <div class="vertex-coordinate-field"><span class="vertex-number-label">Κορυφή ${index}</span><label>Πλάτος (Latitude)</label><input class="edit-vertex-lat" type="text" inputmode="decimal" data-coordinate="latitude" required placeholder="35.1856" value="${escapeHtml(lat)}"></div>
      <div class="vertex-coordinate-field"><label>Μήκος (Longitude)</label><input class="edit-vertex-lng" type="text" inputmode="decimal" data-coordinate="longitude" required placeholder="33.3823" value="${escapeHtml(lng)}"></div>
      <button type="button" class="button secondary remove-coordinate-row" aria-label="Αφαίρεση κορυφής">×</button>`;
    row.querySelector(".remove-coordinate-row").addEventListener("click", () => {
      if (list.children.length <= 3) {
        $("feature-error").textContent = "Το πολύγωνο πρέπει να έχει τουλάχιστον 3 κορυφές.";
        return;
      }
      row.remove();
      [...list.children].forEach((el, i) => {
        el.querySelector(".vertex-number-label").textContent = `Κορυφή ${i + 1}`;
      });
      $("feature-error").textContent = "";
    });
    list.appendChild(row);
  }


  function setupEditablePointCoordinates(feature) {
    const section = $("edit-point-coordinate-fields");
    const supported = !!feature.id && feature.geometry?.type === "Point";
    section.classList.toggle("hidden", !supported);
    if (!supported) return;
    const [lng, lat] = feature.geometry.coordinates;
    $("edit-point-latitude").value = Number(lat).toFixed(6);
    $("edit-point-longitude").value = Number(lng).toFixed(6);
  }

  function readEditedPointGeometry() {
    const latText = $("edit-point-latitude").value.trim();
    const lngText = $("edit-point-longitude").value.trim();
    const lat = Number(latText.replace(",", "."));
    const lng = Number(lngText.replace(",", "."));
    if (!latText || !lngText || !Number.isFinite(lat) || !Number.isFinite(lng) ||
        lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new Error("Συμπληρώστε έγκυρο πλάτος (-90 έως 90) και μήκος (-180 έως 180).");
    }
    return { type: "Point", coordinates: [Number(lng.toFixed(6)), Number(lat.toFixed(6))] };
  }

  function setupEditablePolygonCoordinates(feature) {
    const section = $("edit-polygon-coordinate-fields");
    const list = $("edit-polygon-coordinate-list");
    list.innerHTML = "";
    const ring = editablePolygonRing(feature.geometry);
    // Editing coordinates is supported for Polygon and single-ring MultiPolygon geometry.
    const supported = !!ring && (feature.geometry.type === "Polygon" ||
      (feature.geometry.type === "MultiPolygon" && feature.geometry.coordinates.length === 1));
    section.classList.toggle("hidden", !(feature.id && supported));
    if (!feature.id || !supported) return;
    const vertices = ring.slice(0, -1); // omit duplicate closing coordinate
    vertices.forEach(([lng, lat]) => addEditablePolygonRow(Number(lat).toFixed(6), Number(lng).toFixed(6)));
  }

  function readEditedPolygonGeometry(originalGeometry) {
    const rows = [...$("edit-polygon-coordinate-list").querySelectorAll(".coordinate-row")];
    if (rows.length < 3) throw new Error("Το πολύγωνο πρέπει να έχει τουλάχιστον 3 κορυφές.");
    const ring = [];
    for (const row of rows) {
      const latValue = row.querySelector(".edit-vertex-lat").value;
      const lngValue = row.querySelector(".edit-vertex-lng").value;
      const lat = Number(latValue.trim().replace(",", ".")), lng = Number(lngValue.trim().replace(",", "."));
      if (latValue === "" || lngValue === "" || !Number.isFinite(lat) || !Number.isFinite(lng) ||
          lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw new Error("Συμπληρώστε έγκυρο πλάτος και μήκος για κάθε κορυφή.");
      }
      ring.push([lng, lat]);
    }
    ring.push([...ring[0]]);
    if (originalGeometry.type === "MultiPolygon") return { type: "MultiPolygon", coordinates: [[ring]] };
    return { type: "Polygon", coordinates: [ring] };
  }

  function openFeatureDialog(feature, allowDelete) {
    state.selectedFeature = feature;
    $("feature-heading").textContent = feature.id ? "Επεξεργασία στοιχείου" : "Νέο στοιχείο";
    $("feature-id").value = feature.id || "";
    $("feature-name").value = feature.name_el || feature.name_en || "";
    $("feature-color").value = /^#[0-9a-f]{6}$/i.test(feature.properties?.color || "")
      ? feature.properties.color : (feature.properties?.shape === "circle" ? "#2563eb" : (PERMANENT_LAYER_COLORS[additionalLayer()?.slug] || "#16a34a"));
    $("feature-delete").classList.toggle("hidden", !(canModifyFeature(feature) && allowDelete && !!feature.id));
    $("feature-error").textContent = "";
    const isCircle = feature.properties?.shape === "circle";
    if (isCircle) {
      // Existing circles are intentionally limited to name, colour and delete.
      $("edit-point-coordinate-fields").classList.add("hidden");
      $("edit-polygon-coordinate-fields").classList.add("hidden");
      $("edit-polygon-coordinate-list").innerHTML = "";
    } else {
      setupEditablePointCoordinates(feature);
      setupEditablePolygonCoordinates(feature);
    }
    // Circle radius can be adjusted both when creating and editing a circle.
    $("feature-circle-radius-fields").classList.toggle("hidden", !isCircle);
    if (isCircle) {
      $("feature-circle-radius").value = String(existingCircleRadius(feature));
    }
    featureDialog.showModal();
    setTimeout(() => $("feature-name").focus(), 0);
  }

  async function saveFeatureDetails(e) {
    e.preventDefault();
    if (!state.isEditor || !state.selectedFeature) return;
    const feature = state.selectedFeature;
    const name = $("feature-name").value.trim();
    const color = $("feature-color").value;
    $("feature-error").textContent = "";
    let editedGeometry = feature.geometry;
    let updatedProperties = { ...(feature.properties || {}), color };
    if (feature.properties?.shape === "circle") {
      const radiusText = $("feature-circle-radius").value.trim();
      const radius = Number(radiusText);
      if (!radiusText || !Number.isFinite(radius) || radius <= 0) {
        $("feature-error").textContent = "Εισαγάγετε έγκυρη ακτίνα μεγαλύτερη από 0 μέτρα.";
        $("feature-circle-radius").focus();
        return;
      }
      const center = Array.isArray(feature.properties?.center) && feature.properties.center.length === 2
        ? feature.properties.center
        : [ringCentroidLongitude(feature.geometry.coordinates[0]), ringCentroidLatitude(feature.geometry.coordinates[0])];
      editedGeometry = createCircleGeometry(Number(center[0]), Number(center[1]), radius);
      updatedProperties = { ...updatedProperties, radius_m: radius, center };
    }
    try {
      if (feature.id && !$("edit-point-coordinate-fields").classList.contains("hidden")) {
        editedGeometry = readEditedPointGeometry();
      } else if (feature.id && feature.properties?.shape !== "circle" &&
          !$("edit-polygon-coordinate-fields").classList.contains("hidden")) {
        editedGeometry = readEditedPolygonGeometry(feature.geometry);
      }
    } catch (error) {
      $("feature-error").textContent = error.message || "Ελέγξτε τις συντεταγμένες.";
      return;
    }
    if (!name) {
      $("feature-error").textContent = "Please enter a name.";
      $("feature-name").focus();
      return;
    }
    if (feature.id) {
      if (!canModifyFeature(feature)) {
        $("feature-error").textContent = "The original five layers are protected.";
        return;
      }
      const { data, error } = await state.supabase.from("map_features")
        .update({
          name_el: name, name_en: "",
          geometry: editedGeometry,
          properties: updatedProperties,
          updated_at: new Date().toISOString()
        })
        .eq("id", feature.id).select("*").single();
      if (error) { $("feature-error").textContent = error.message; return; }
      const idx = state.features.findIndex(x => x.id === feature.id);
      if (idx >= 0) state.features[idx] = data;
      state.selectedFeature = data;
    } else {
      const row = {
        layer_id: state.additionalLayerId,
        owner_id: state.user.id,
        category_id: null, is_visible: true,
        name_el: name, name_en: "",
        geometry: feature.geometry,
        properties: updatedProperties
      };
      const { data, error } = await state.supabase.from("map_features").insert(row).select("*").single();
      if (error) { $("feature-error").textContent = error.message; return; }
      state.features.push(data);
      state.selectedFeature = data;
    }
    featureDialog.close();
    refreshAllSources();
    renderLayers();
  }

  function openDeleteDialog(feature, fromFeatureDialog) {
    if (!canModifyFeature(feature) || !feature?.id) return;
    state.pendingDeleteFeature = feature;
    state.closeFeatureAfterDelete = !!fromFeatureDialog;
    $("delete-feature-name").textContent = displayFeatureName(feature);
    $("delete-error").textContent = "";
    if (featureDialog.open) featureDialog.close();
    // Also clear the map popup immediately so it cannot remain over the deletion dialog.
    document.querySelectorAll(".maplibregl-popup").forEach(el => el.remove());
    $("delete-dialog").showModal();
  }

  async function deleteFeature() {
    const feature = state.pendingDeleteFeature || state.selectedFeature;
    if (!canModifyFeature(feature) || !feature?.id) return;
    $("delete-confirm").disabled = true;
    $("delete-error").textContent = "";
    const { error } = await state.supabase.from("map_features").delete().eq("id", feature.id);
    $("delete-confirm").disabled = false;
    if (error) {
      $("delete-error").textContent = error.message;
      return;
    }
    state.features = state.features.filter(x => x.id !== feature.id);
    if (state.draw) {
      try { state.draw.delete(feature.id); } catch {}
    }
    $("delete-dialog").close();
    if (featureDialog.open) featureDialog.close();
    state.pendingDeleteFeature = null;
    state.selectedFeature = null;
    refreshAllSources();
    renderLayers();
  }

  function cancelUnsavedFeature() {
    // A newly drawn geometry has not been inserted in the DB yet. Closing the
    // dialog without Save discards it completely.
    if (state.selectedFeature && !state.selectedFeature.id) {
      state.selectedFeature = null;
      if (state.draw) {
        try { state.draw.deleteAll(); state.draw.changeMode("simple_select"); } catch {}
      }
      const drawHelp = $("draw-help");
      if (drawHelp) drawHelp.textContent = "Creation cancelled. Choose Add point or Draw polygon to try again.";
    } else {
      state.selectedFeature = null;
    }
  }


  let coordinateMode = "point";

  function resetCoordinateDialog(mode) {
    state.circlePlacementActive = false;
    if (state.map) state.map.getCanvas().style.cursor = "";
    coordinateMode = mode;
    $("coordinate-heading").textContent = mode === "point"
      ? "Προσθήκη σημείου με συντεταγμένες"
      : mode === "circle"
        ? "Προσθήκη κύκλου με συντεταγμένες"
        : "Προσθήκη πολυγώνου με συντεταγμένες";
    $("point-coordinate-fields").classList.toggle("hidden", mode !== "point" && mode !== "circle");
    $("polygon-coordinate-fields").classList.toggle("hidden", mode !== "polygon");
    $("circle-radius-fields").classList.toggle("hidden", mode !== "circle");
    $("circle-radius").value = String(DEFAULT_CIRCLE_RADIUS_METRES);
    $("point-longitude").required = mode === "point" || mode === "circle";
    $("point-latitude").required = mode === "point" || mode === "circle";
    $("coordinate-name").value = "";
    $("coordinate-color").value = mode === "circle" ? "#2563eb" : PERMANENT_LAYER_COLORS.additional_data;
    $("coordinate-error").textContent = "";
    const list = $("polygon-coordinate-list");
    list.innerHTML = "";
    if (mode === "polygon") {
      addPolygonCoordinateRow();
      addPolygonCoordinateRow();
      addPolygonCoordinateRow();
    }
    $("coordinate-dialog").showModal();
    setTimeout(() => $("coordinate-name").focus(), 0);
  }

  function addPolygonCoordinateRow() {
    const list = $("polygon-coordinate-list");
    const index = list.children.length + 1;
    const row = document.createElement("div");
    row.className = "coordinate-row";
    row.innerHTML = `
      <div class="vertex-coordinate-field"><span class="vertex-number-label">Κορυφή ${index}</span><label>Πλάτος (Latitude)</label><input class="vertex-lat" type="text" inputmode="decimal" data-coordinate="latitude" required placeholder="35.1856"></div>
      <div class="vertex-coordinate-field"><label>Μήκος (Longitude)</label><input class="vertex-lng" type="text" inputmode="decimal" data-coordinate="longitude" required placeholder="33.3823"></div>
      <button type="button" class="button secondary remove-coordinate-row" aria-label="Αφαίρεση κορυφής">×</button>`;
    row.querySelector(".remove-coordinate-row").addEventListener("click", () => {
      if (list.children.length <= 3) {
        $("coordinate-error").textContent = "Το πολύγωνο πρέπει να έχει τουλάχιστον 3 κορυφές.";
        return;
      }
      row.remove();
      [...list.children].forEach((el, i) => {
        el.querySelector("div:first-child label").textContent = `Κορυφή ${i + 1} — Μήκος`;
      });
      $("coordinate-error").textContent = "";
    });
    list.appendChild(row);
  }

  async function saveCoordinateFeature(e) {
    e.preventDefault();
    if (!state.isEditor || !state.additionalLayerId) {
      $("coordinate-error").textContent = "Απαιτείται εξουσιοδοτημένη είσοδος.";
      return;
    }
    const name = $("coordinate-name").value.trim();
    const color = $("coordinate-color").value;
    if (!name) {
      $("coordinate-error").textContent = "Συμπληρώστε όνομα.";
      return;
    }
    let geometry;
    if (coordinateMode === "point" || coordinateMode === "circle") {
      const lng = Number($("point-longitude").value);
      const lat = Number($("point-latitude").value);
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        $("coordinate-error").textContent = "Ελέγξτε το γεωγραφικό μήκος (-180 έως 180) και πλάτος (-90 έως 90).";
        return;
      }
      if (coordinateMode === "circle") {
        const radiusText = $("circle-radius").value.trim();
        const radius = Number(radiusText);
        if (!radiusText || !Number.isFinite(radius) || radius <= 0) {
          $("coordinate-error").textContent = "Εισαγάγετε έγκυρη ακτίνα μεγαλύτερη από 0 μέτρα.";
          $("circle-radius").focus();
          return;
        }
        geometry = createCircleGeometry(lng, lat, radius);
        var circleProperties = { shape: "circle", radius_m: radius, center: [lng, lat] };
      } else {
        geometry = { type: "Point", coordinates: [lng, lat] };
      }
    } else {
      const rows = [...$("polygon-coordinate-list").querySelectorAll(".coordinate-row")];
      if (rows.length < 3) {
        $("coordinate-error").textContent = "Το πολύγωνο πρέπει να έχει τουλάχιστον 3 κορυφές.";
        return;
      }
      const ring = [];
      for (const row of rows) {
        const lng = Number(row.querySelector(".vertex-lng").value);
        const lat = Number(row.querySelector(".vertex-lat").value);
        if (row.querySelector(".vertex-lng").value === "" || row.querySelector(".vertex-lat").value === "" ||
            !Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
          $("coordinate-error").textContent = "Συμπληρώστε έγκυρο μήκος και πλάτος για κάθε κορυφή.";
          return;
        }
        ring.push([lng, lat]);
      }
      const first = ring[0], last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
      geometry = { type: "Polygon", coordinates: [ring] };
    }
    $("coordinate-save").disabled = true;
    $("coordinate-error").textContent = "";
    const { data, error } = await state.supabase.from("map_features").insert({
      layer_id: state.additionalLayerId,
      owner_id: state.user.id,
      category_id: null, is_visible: true,
      name_el: name, name_en: "",
      geometry,
      properties: { ...(coordinateMode === "circle" ? circleProperties : {}), color }
    }).select("*").single();
    $("coordinate-save").disabled = false;
    if (error) {
      $("coordinate-error").textContent = error.message;
      return;
    }
    state.features.push(data);
    $("coordinate-dialog").close();
    refreshAllSources();
    renderLayers();
    // Pan to the new feature, useful for both coordinate-based creation modes.
    const center = geometry.type === "Point"
      ? geometry.coordinates
      : [ringCentroidLongitude(geometry.coordinates[0]), ringCentroidLatitude(geometry.coordinates[0])];
    state.map?.easeTo({ center, zoom: Math.max(state.map.getZoom(), 11) });
  }

  function ringCentroidLongitude(ring) {
    const vertices = ring.slice(0, -1);
    return vertices.reduce((sum, coord) => sum + coord[0], 0) / Math.max(vertices.length, 1);
  }
  function ringCentroidLatitude(ring) {
    const vertices = ring.slice(0, -1);
    return vertices.reduce((sum, coord) => sum + coord[1], 0) / Math.max(vertices.length, 1);
  }

  $("login-open").addEventListener("click", () => { $("login-error").textContent = ""; loginDialog.showModal(); });
  $("login-close").addEventListener("click", () => loginDialog.close());
  $("logout").addEventListener("click", async () => { await state.supabase.auth.signOut(); clearSession(); });
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("username").value.trim().toLowerCase();
    const password = $("password").value;
    const email = cfg.USER_EMAILS?.[username];
    if (!email) { $("login-error").textContent = "Unknown username."; return; }
    const { error } = await state.supabase.auth.signInWithPassword({ email, password });
    if (error) { $("login-error").textContent = "Sign-in failed. Check username and password."; return; }
    loginDialog.close();
    $("password").value = "";
  });
  $("feature-close").addEventListener("click", () => featureDialog.close());
  $("feature-form").addEventListener("submit", saveFeatureDetails);
  $("edit-add-coordinate-row").addEventListener("click", () => {
    addEditablePolygonRow();
    $("feature-error").textContent = "";
  });
  featureDialog.addEventListener("close", cancelUnsavedFeature);
  $("feature-delete").addEventListener("click", () => openDeleteDialog(state.selectedFeature, true));
  const deleteCancelButton = $("delete-cancel");
  const deleteConfirmButton = $("delete-confirm");
  if (deleteCancelButton) deleteCancelButton.addEventListener("click", () => $("delete-dialog").close());
  if (deleteConfirmButton) deleteConfirmButton.addEventListener("click", deleteFeature);
  $("draw-point").addEventListener("click", () => beginDraw("draw_point"));

  $("draw-polygon").addEventListener("click", () => beginDraw("draw_polygon"));
  $("draw-circle").addEventListener("click", beginCirclePlacement);
  $("coordinate-circle").addEventListener("click", () => {
    if (!state.isEditor) { alert("Απαιτείται εξουσιοδοτημένη είσοδος."); return; }
    resetCoordinateDialog("circle");
  });
  $("coordinate-point").addEventListener("click", () => {
    if (!state.isEditor) { alert("Απαιτείται εξουσιοδοτημένη είσοδος."); return; }
    resetCoordinateDialog("point");
  });
  $("coordinate-polygon").addEventListener("click", () => {
    if (!state.isEditor) { alert("Απαιτείται εξουσιοδοτημένη είσοδος."); return; }
    resetCoordinateDialog("polygon");
  });
  $("add-coordinate-row").addEventListener("click", () => {
    addPolygonCoordinateRow();
    $("coordinate-error").textContent = "";
  });
  $("coordinate-form").addEventListener("submit", saveCoordinateFeature);
  $("coordinate-close").addEventListener("click", () => $("coordinate-dialog").close());
  $("coordinate-cancel").addEventListener("click", () => $("coordinate-dialog").close());

  const sidebarCollapseButton = document.getElementById("sidebar-collapse");
  if (sidebarCollapseButton) {
    sidebarCollapseButton.addEventListener("click", () => {
      const collapsed = document.body.classList.toggle("sidebar-collapsed");
      sidebarCollapseButton.textContent = collapsed ? "▶" : "◀";
      sidebarCollapseButton.setAttribute("aria-expanded", String(!collapsed));
      sidebarCollapseButton.setAttribute("aria-label", collapsed ? "Επέκταση πλευρικής στήλης" : "Σύμπτυξη πλευρικής στήλης");
      if (state.map) setTimeout(() => state.map.resize(), 220);
    });
  }

  init();
})();
