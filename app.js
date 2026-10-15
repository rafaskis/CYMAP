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
  const state = {
    supabase: null, map: null, draw: null, layers: [], features: [],
    isEditor: false, user: null, selectedFeature: null, editingExistingId: null,
    visibility: {}, pendingDrawIds: new Set(), selectedLayerId: null, additionalLayerId: null
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
    return state.visibility[layerId] !== false; // visibility is per-browser, not shared
  }
  function getLayer(id) { return state.layers.find(x => x.id === id); }
  function getFeature(id) { return state.features.find(x => x.id === id); }
  function additionalLayer() { return state.layers.find(x => x.slug === "additional_data"); }
  function canModifyFeature(feature) {
    return !!state.isEditor && !!feature && getLayer(feature.layer_id)?.slug === "additional_data";
  }
  function featureTitle(f) {
    const lang = document.documentElement.lang === "el" ? "el" : "en";
    return (lang === "el" ? f.name_el : f.name_en) || f.name_el || f.name_en || "Unnamed feature";
  }
  function featureCollection(layerId = null) {
    const rows = state.features.filter(f => !layerId || f.layer_id === layerId);
    return {
      type: "FeatureCollection",
      features: rows.map(f => ({
        type: "Feature", id: f.id, geometry: f.geometry,
        properties: {
          id: f.id, layer_id: f.layer_id, name_el: f.name_el || "",
          name_en: f.name_en || "", description: f.description || ""
        }
      }))
    };
  }
  function sourceId(layerId) { return `features-${layerId}`; }
  function safeLayerSlug(slug) { return String(slug).replace(/[^a-zA-Z0-9_-]/g, "_"); }

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
    try {
      const { data: { session } } = await state.supabase.auth.getSession();
      if (session?.user) await applySession(session.user);
      await loadLayersAndFeatures();
      state.supabase.auth.onAuthStateChange((_event, session) => {
        // Defer async work so the auth callback doesn't block Supabase's auth lock.
        setTimeout(async () => {
          if (session?.user) await applySession(session.user);
          else clearSession();
        }, 0);
      });
      setStatus(state.isEditor ? "Signed in as editor" : "Public view");
    } catch (e) {
      console.error(e);
      setStatus("Database connection failed", true);
      layersEl.innerHTML = `<div class="empty">${escapeHtml(e.message || "Could not load map data.")}</div>`;
    }
  }

  function configureSatelliteAndGreekLabels() {
    // Keep OpenFreeMap/OpenStreetMap settlement labels, preferring Greek names
    // and then English names. We deliberately do not fall back to the raw
    // local "name" field, which can be Turkish in some parts of Cyprus.
    const originalLayers = (state.map.getStyle()?.layers || []).slice();
    const placeLabels = originalLayers.filter(layer =>
      layer.type === "symbol" &&
      layer["source-layer"] === "place" &&
      layer.layout &&
      layer.layout["text-field"] !== undefined
    );
    const keep = new Set(placeLabels.map(layer => layer.id));
    const greekEnglishName = [
      "coalesce",
      ["get", "name:el"],
      ["get", "name_el"],
      ["get", "name:en"],
      ["get", "name_en"]
    ];
    for (const layer of placeLabels) {
      state.map.setLayoutProperty(layer.id, "text-field", greekEnglishName);
    }
    for (const layer of originalLayers.slice().reverse()) {
      if (!keep.has(layer.id) && state.map.getLayer(layer.id)) {
        state.map.removeLayer(layer.id);
      }
    }
    state.map.addSource("esriImagery", {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      attribution: "Satellite imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community"
    });
    state.map.addLayer(
      { id: "satellite", type: "raster", source: "esriImagery" },
      placeLabels.length ? placeLabels[0].id : undefined
    );
    if (!placeLabels.length) {
      console.warn("OpenFreeMap style loaded, but no place-label layers were found.");
    }
  }

  function initMap() {
    state.map = new maplibregl.Map({
      container: "map",
      center: cfg.MAP_CENTER || [33.2, 35.1],
      zoom: cfg.MAP_ZOOM || 8,
      style: "https://tiles.openfreemap.org/styles/liberty"
    });
    state.map.addControl(new maplibregl.NavigationControl(), "top-right");
    state.map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    state.map.on("load", () => {
      try {
        configureSatelliteAndGreekLabels();
      } catch (e) {
        console.error("Could not configure satellite/Greek place labels:", e);
      }
      state.mapLoaded = true;
      for (const layer of state.layers) addLayerToMap(layer);
      refreshAllSources();
    });
    state.map.on("click", (e) => {
      if (state.isEditor && state.draw && state.draw.getMode() !== "simple_select" &&
          state.draw.getMode() !== "direct_select") return;
      const hits = state.map.queryRenderedFeatures(e.point, { layers: state.renderLayerIds || [] });
      if (hits.length) {
        const props = hits[0].properties || {};
        const f = getFeature(props.id);
        if (f) showFeaturePopup(f, e.lngLat);
      }
    });
    state.map.on("error", (e) => {
      // Keep errors visible in browser devtools without repeatedly replacing the status.
      console.warn("MapLibre error:", e.error || e);
    });
  }

  async function loadLayersAndFeatures() {
    const [layersResult, featuresResult] = await Promise.all([
      state.supabase.from("map_layers").select("*").order("sort_order"),
      state.supabase.from("map_features").select("*")
    ]);
    if (layersResult.error) throw layersResult.error;
    if (featuresResult.error) throw featuresResult.error;
    state.layers = layersResult.data || [];
    state.features = featuresResult.data || [];
    state.additionalLayerId = additionalLayer()?.id || null;
    if (!state.additionalLayerId) {
      throw new Error('Missing required layer "ΕΠΙΠΡΟΣΘΕΤΑ ΔΕΔΟΜΕΝΑ". Run the CYMAP protection migration SQL in Supabase.');
    }
    // Default: all layers visible except the permanent KD layer.
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
    const fill = `fill-${slug}`, outline = `outline-${slug}`, points = `points-${slug}`;
    if (!state.map.getLayer(fill)) state.map.addLayer({
      id: fill, type: "fill", source: src,
      filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
      paint: { "fill-color": colorForSlug(layer.slug), "fill-opacity": 0.25 }
    });
    if (!state.map.getLayer(outline)) state.map.addLayer({
      id: outline, type: "line", source: src,
      filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
      paint: { "line-color": colorForSlug(layer.slug), "line-width": 2 }
    });
    if (!state.map.getLayer(points)) state.map.addLayer({
      id: points, type: "circle", source: src,
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-radius": 6, "circle-color": colorForSlug(layer.slug), "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 }
    });
    if (!state.renderLayerIds) state.renderLayerIds = [];
    for (const id of [fill, outline, points]) if (!state.renderLayerIds.includes(id)) state.renderLayerIds.push(id);
    setMapLayerVisibility(layer);
  }
  function colorForSlug(slug) {
    return ({kd:"#8b5cf6", controlled_areas:"#e11d48", uncontrolled_areas:"#0d9488", sba:"#f59e0b", un:"#2563eb"})[slug] || "#16a34a";
  }
  function setMapLayerVisibility(layer) {
    if (!state.map || !state.mapLoaded) return;
    const visible = layerVisible(layer.id) ? "visible" : "none";
    const slug = safeLayerSlug(layer.slug);
    for (const id of [`fill-${slug}`, `outline-${slug}`, `points-${slug}`]) {
      if (state.map.getLayer(id)) state.map.setLayoutProperty(id, "visibility", visible);
    }
  }
  function refreshAllSources() {
    if (!state.map || !state.mapLoaded) return;
    for (const layer of state.layers) {
      const source = state.map.getSource(sourceId(layer.id));
      if (source) source.setData(featureCollection(layer.id));
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
      const row = document.createElement("div");
      row.className = "layer-row";
      const checked = layerVisible(layer.id);
      const featureCount = state.features.filter(f => f.layer_id === layer.id).length;
      row.innerHTML = `
        <input type="checkbox" aria-label="Toggle ${escapeHtml(layer.name_en)}" ${checked ? "checked" : ""}>
        <span class="layer-name"><strong>${escapeHtml(layer.name_el || layer.name_en)}</strong><small>${featureCount} features</small></span>
        `;
      row.querySelector('input').addEventListener("change", (e) => {
        state.visibility[layer.id] = e.target.checked;
        saveVisibility();
        setMapLayerVisibility(layer);
      });
      layersEl.appendChild(row);
    }
  }
  function renderLayerSelect() {
    const layer = additionalLayer();
    layerSelect.innerHTML = "";
    if (layer) {
      const opt = document.createElement("option");
      opt.value = layer.id;
      opt.textContent = layer.name_el || "ΕΠΙΠΡΟΣΘΕΤΑ ΔΕΔΟΜΕΝΑ";
      layerSelect.appendChild(opt);
      layerSelect.value = layer.id;
      state.selectedLayerId = layer.id;
      state.additionalLayerId = layer.id;
    } else {
      state.selectedLayerId = null;
      state.additionalLayerId = null;
    }
    layerSelect.disabled = true;
  }

  async function applySession(user) {
    state.user = user;
    const { data, error } = await state.supabase.from("map_editors").select("user_id").eq("user_id", user.id).maybeSingle();
    if (error) console.warn("Editor permission check:", error.message);
    state.isEditor = !!data;
    $("editor-panel").classList.toggle("hidden", !state.isEditor);
    $("login-open").classList.toggle("hidden", state.isEditor);
    $("logout").classList.toggle("hidden", !state.isEditor);
    renderLayers();
    setStatus(state.isEditor ? "Signed in as editor" : "Signed in (view only)");
  }
  function clearSession() {
    state.user = null; state.isEditor = false;
    $("editor-panel").classList.add("hidden");
    $("login-open").classList.remove("hidden");
    $("logout").classList.add("hidden");
    renderLayers();
    setStatus("Public view");
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
          { id:"gl-draw-polygon-fill-inactive", type:"fill", filter:["all",["==","$type","Polygon"],["!=", "mode","static"]], paint:{"fill-color":"#16a34a","fill-outline-color":"#14532d","fill-opacity":0.18}},
          { id:"gl-draw-polygon-stroke-inactive", type:"line", filter:["all",["==","$type","Polygon"],["!=", "mode","static"]], layout:{"line-cap":"round","line-join":"round"}, paint:{"line-color":"#14532d","line-width":2}},
          { id:"gl-draw-polygon-fill-active", type:"fill", filter:["all",["==","$type","Polygon"],["==","mode","draw_polygon"]], paint:{"fill-color":"#16a34a","fill-opacity":0.25}},
          { id:"gl-draw-polygon-stroke-active", type:"line", filter:["all",["==","$type","Polygon"],["==","mode","draw_polygon"]], paint:{"line-color":"#14532d","line-width":2}},
          { id:"gl-draw-line-inactive", type:"line", filter:["all",["==","$type","LineString"],["!=", "mode","static"]], layout:{"line-cap":"round","line-join":"round"}, paint:{"line-color":"#14532d","line-width":2}},
          { id:"gl-draw-point-inactive", type:"circle", filter:["all",["==","$type","Point"],["!=", "mode","static"]], paint:{"circle-radius":6,"circle-color":"#16a34a","circle-stroke-color":"#fff","circle-stroke-width":2}},
          { id:"gl-draw-point-active", type:"circle", filter:["all",["==","$type","Point"],["==","mode","draw_point"]], paint:{"circle-radius":6,"circle-color":"#16a34a","circle-stroke-color":"#fff","circle-stroke-width":2}}
        ]
      });
      state.map.addControl(state.draw, "top-right");
      // Existing features are loaded into Draw only when the editor chooses to edit one.
      state.map.on("draw.create", onDrawCreate);
      state.map.on("draw.update", onDrawUpdate);
      state.map.on("draw.delete", onDrawDelete);
    }
    return state.draw;
  }
  function beginDraw(mode) {
    try {
      if (!state.additionalLayerId) throw new Error('The required layer "ΕΠΙΠΡΟΣΘΕΤΑ ΔΕΔΟΜΕΝΑ" is missing.');
      const draw = ensureDraw();
      state.editingExistingId = null;
      $("draw-help").textContent = mode === "draw_point"
        ? "Click the map to place a point, then click Save drawing."
        : "Click to add polygon corners; double-click to finish, then click Save drawing.";
      draw.changeMode(mode);
    } catch (e) { alert(e.message); }
  }
  async function onDrawCreate(e) {
    if (!state.isEditor) return;
    for (const feature of e.features || []) {
      const props = feature.properties || {};
      const row = {
        layer_id: state.additionalLayerId,
        name_el: "",
        name_en: "",
        description: props.description || "",
        geometry: feature.geometry,
        properties: {}
      };
      const { data, error } = await state.supabase.from("map_features").insert(row).select("*").single();
      if (error) { alert("Could not save feature: " + error.message); continue; }
      state.features.push(data);
      state.draw.delete(feature.id);
      refreshAllSources();
      openFeatureDialog(data, false);
    }
    renderLayers();
  }
  async function onDrawUpdate(e) {
    if (!state.isEditor) return;
    for (const feature of e.features || []) {
      const id = feature.properties?.id || feature.id;
      const existingFeature = getFeature(id);
      if (!id || !existingFeature) continue;
      if (!canModifyFeature(existingFeature)) {
        alert("The original five layers are protected and cannot be edited.");
        refreshAllSources();
        continue;
      }
      const { data, error } = await state.supabase.from("map_features")
        .update({ geometry: feature.geometry, updated_at: new Date().toISOString() })
        .eq("id", id).select("*").single();
      if (error) { alert("Could not update geometry: " + error.message); continue; }
      const idx = state.features.findIndex(f => f.id === id);
      if (idx >= 0) state.features[idx] = data;
      refreshAllSources();
    }
  }
  function onDrawDelete() {
    // Mapbox Draw deletions are local editor-tool operations only.
    // Database deletion is performed exclusively by deleteFeature(), which
    // checks the layer and is additionally restricted by Supabase RLS.
    refreshAllSources();
  }

  function showFeaturePopup(feature, lngLat) {
    const layer = getLayer(feature.layer_id);
    const title = feature.name_el || feature.name_en || "Unnamed feature";
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px" })
      .setLngLat(lngLat)
      .setHTML(`<div class="popup-title">${escapeHtml(title)}</div>
        ${feature.name_en && feature.name_el ? `<div class="popup-description">${escapeHtml(feature.name_en)}</div>` : ""}
        ${feature.description ? `<div class="popup-description">${escapeHtml(feature.description)}</div>` : ""}
        <div class="popup-description">Layer: ${escapeHtml(layer?.name_el || layer?.name_en || "")}</div>
        ${canModifyFeature(feature) ? `<div class="popup-actions"><button data-action="details">Rename / edit details</button><button data-action="shape">Edit shape</button></div>` : ""}`)
      .addTo(state.map);
    if (canModifyFeature(feature)) {
      popup.getElement().querySelector('[data-action="details"]')?.addEventListener("click", () => openFeatureDialog(feature, true));
      popup.getElement().querySelector('[data-action="shape"]')?.addEventListener("click", () => editShape(feature));
    }
  }
  function openFeatureDialog(feature, allowDelete) {
    state.selectedFeature = feature;
    $("feature-heading").textContent = feature.id ? "Edit feature details" : "New feature";
    $("feature-id").value = feature.id || "";
    $("feature-name").value = feature.name_el || feature.name_en || "";
    $("feature-description").value = feature.description || "";
    $("feature-delete").classList.toggle("hidden", !(canModifyFeature(feature) && allowDelete && !!feature.id));
    $("feature-error").textContent = "";
    featureDialog.showModal();
  }
  function editShape(feature) {
    if (!canModifyFeature(feature)) {
      alert("The original five layers are protected. Only features in ΕΠΙΠΡΟΣΘΕΤΑ ΔΕΔΟΜΕΝΑ can be edited.");
      return;
    }
    try {
      const draw = ensureDraw();
      // Draw IDs must be unique strings; preserve DB id in feature properties.
      const f = { type:"Feature", id:feature.id, geometry:feature.geometry,
        properties:{ id:feature.id, name_el:feature.name_el || "", name_en:feature.name_en || "", description:feature.description || "" } };
      const existing = draw.get(feature.id);
      if (existing) draw.delete(feature.id);
      draw.add(f);
      state.editingExistingId = feature.id;
      draw.changeMode("direct_select", { featureId: feature.id });
      $("draw-help").textContent = "Drag vertices to edit the shape. Changes are saved when you finish editing.";
    } catch (e) { alert("Could not open shape editor: " + e.message); }
  }
  async function saveFeatureDetails(e) {
    e.preventDefault();
    if (!state.isEditor || !state.selectedFeature) return;
    const f = state.selectedFeature;
    const payload = {
      name_el: $("feature-name").value.trim(),
      name_en: "",
      description: $("feature-description").value.trim(),
      updated_at: new Date().toISOString()
    };
    $("feature-error").textContent = "";
    if (f.id) {
      if (!canModifyFeature(f)) {
        $("feature-error").textContent = "The original five layers are protected and cannot be renamed.";
        return;
      }
      if (!payload.name_el) {
        $("feature-error").textContent = "Please enter a name.";
        return;
      }
      const { data, error } = await state.supabase.from("map_features").update(payload).eq("id", f.id).select("*").single();
      if (error) { $("feature-error").textContent = error.message; return; }
      const idx = state.features.findIndex(x => x.id === f.id);
      if (idx >= 0) state.features[idx] = data;
    } else {
      f.name_el = payload.name_el; f.name_en = ""; f.description = payload.description;
      state.features.push(f);
    }
    featureDialog.close();
    refreshAllSources(); renderLayers();
  }
  async function deleteFeature() {
    const f = state.selectedFeature;
    if (!canModifyFeature(f) || !f?.id) {
      $("feature-error").textContent = "The original five layers are protected and cannot be deleted.";
      return;
    }
    if (!confirm("Delete this feature permanently? This cannot be undone.")) return;
    const { error } = await state.supabase.from("map_features").delete().eq("id", f.id);
    if (error) { $("feature-error").textContent = error.message; return; }
    state.features = state.features.filter(x => x.id !== f.id);
    if (state.draw?.get(f.id)) state.draw.delete(f.id);
    featureDialog.close();
    refreshAllSources(); renderLayers();
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
    loginDialog.close(); $("password").value = "";
    await loadLayersAndFeatures();
  });
  $("feature-close").addEventListener("click", () => featureDialog.close());
  $("feature-form").addEventListener("submit", saveFeatureDetails);
  $("feature-delete").addEventListener("click", deleteFeature);
  layerSelect.addEventListener("change", () => state.selectedLayerId = layerSelect.value);
  $("draw-point").addEventListener("click", () => beginDraw("draw_point"));
  $("draw-polygon").addEventListener("click", () => beginDraw("draw_polygon"));
  $("edit-selected").addEventListener("click", () => {
    if (!state.isEditor) return;
    alert("To edit an existing shape, click the feature on the map and choose “Edit shape”.");
  });
  $("save-drawings").addEventListener("click", () => {
    if (!state.draw) return;
    if (state.draw.getMode() === "draw_polygon" || state.draw.getMode() === "draw_point") {
      // Mapbox Draw fires draw.create when the shape is completed.
      $("draw-help").textContent = "Drawing complete. If saved successfully, it now appears on the map.";
      state.draw.changeMode("simple_select");
    } else {
      $("draw-help").textContent = "Geometry edits are saved automatically when vertices are changed.";
    }
  });
  $("cancel-drawing").addEventListener("click", () => {
    if (state.draw) state.draw.changeMode("simple_select");
    $("draw-help").textContent = "Choose a tool to begin.";
  });
  init();
})();
