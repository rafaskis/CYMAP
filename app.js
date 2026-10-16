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
    visibility: {}, additionalLayerId: null, mapLoaded: false
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
  function getLayer(id) { return state.layers.find(x => x.id === id); }

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
    const rows = state.features.filter(f => !layerId || f.layer_id === layerId);
    return {
      type: "FeatureCollection",
      features: rows.map(f => ({
        type: "Feature", id: f.id, geometry: f.geometry,
        properties: {
          id: f.id, layer_id: f.layer_id,
          name_el: f.name_el || "", name_en: f.name_en || "",
          color: f.properties?.color || null
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
        setTimeout(async () => {
          if (session?.user) await applySession(session.user);
          else clearSession();
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
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
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
    state.map = new maplibregl.Map({
      attributionControl: { compact: true },
      container: "map",
      center: cfg.MAP_CENTER || [33.2, 35.1],
      zoom: cfg.MAP_ZOOM || 8,
      style: "https://tiles.openfreemap.org/styles/liberty"
    });
    state.map.addControl(new maplibregl.NavigationControl(), "top-right");
    state.map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    state.map.on("load", () => {
      try { configureSatelliteAndLabels(); }
      catch (e) { console.error("Could not configure satellite/labels:", e); }
      state.mapLoaded = true;
      for (const layer of state.layers) addLayerToMap(layer);
      refreshAllSources();
    });
    state.map.on("click", (e) => {
      // In drawing modes, the click belongs to Mapbox Draw.
      if (state.isEditor && state.draw && state.draw.getMode() !== "simple_select" &&
          state.draw.getMode() !== "direct_select") return;
      const hits = state.map.queryRenderedFeatures(e.point, { layers: state.renderLayerIds || [] });
      if (hits.length) {
        const props = hits[0].properties || {};
        const f = getFeature(props.id);
        if (f) showFeaturePopup(f, e.lngLat);
      }
    });
    state.map.on("error", (e) => console.warn("MapLibre error:", e.error || e));
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
    const fill = `fill-${slug}`, outline = `outline-${slug}`, points = `points-${slug}`;
    const layerColor = PERMANENT_LAYER_COLORS[layer.slug] || "#16a34a";
    const perFeatureColor = ["coalesce", ["get", "color"], layerColor];
    if (!state.map.getLayer(fill)) state.map.addLayer({
      id: fill, type: "fill", source: src,
      filter: ["in", ["geometry-type"], ["literal", ["Polygon", "MultiPolygon"]]],
      paint: { "fill-color": perFeatureColor, "fill-opacity": 0.27 }
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
    if (!state.renderLayerIds) state.renderLayerIds = [];
    for (const id of [fill, outline, points]) {
      if (!state.renderLayerIds.includes(id)) state.renderLayerIds.push(id);
    }
    setMapLayerVisibility(layer);
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
    }
  }
  function renderLayerSelect() {
    if (layerSelect) layerSelect.innerHTML = "";
    // The target layer is fixed by design; no user-facing layer selection.
  }

  async function applySession(user) {
    state.user = user;
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
    state.isEditor = false;
    $("editor-panel").classList.add("hidden");
    $("login-open").classList.remove("hidden");
    $("logout").classList.add("hidden");
    renderLayers();
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

  function beginDraw(mode) {
    try {
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
  function showFeaturePopup(feature, lngLat) {
    const title = displayFeatureName(feature);
    const canEdit = canModifyFeature(feature);
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px" })
      .setLngLat(lngLat)
      .setHTML(`<div class="popup-title">${escapeHtml(title)}</div>
        ${canEdit ? `<div class="popup-actions"><button data-action="details">Αλλαγή</button><button data-action="delete">Διαγραφή</button></div>` : ""}`)
      .addTo(state.map);
    if (canEdit) {
      popup.getElement().querySelector('[data-action="details"]')
        ?.addEventListener("click", () => openFeatureDialog(feature, true));
      popup.getElement().querySelector('[data-action="delete"]')
        ?.addEventListener("click", async () => {
          state.selectedFeature = feature;
          openDeleteDialog(feature, false);
        });
    }
  }

  function openFeatureDialog(feature, allowDelete) {
    state.selectedFeature = feature;
    $("feature-heading").textContent = feature.id ? "Επεξεργασία στοιχείου" : "Νέο στοιχείο";
    $("feature-id").value = feature.id || "";
    $("feature-name").value = feature.name_el || feature.name_en || "";
    $("feature-color").value = /^#[0-9a-f]{6}$/i.test(feature.properties?.color || "")
      ? feature.properties.color : (PERMANENT_LAYER_COLORS[additionalLayer()?.slug] || "#16a34a");
    $("feature-delete").classList.toggle("hidden", !(canModifyFeature(feature) && allowDelete && !!feature.id));
    $("feature-error").textContent = "";
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
          properties: { ...(feature.properties || {}), color },
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
        name_el: name, name_en: "",
        geometry: feature.geometry,
        properties: { color }
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
    await loadLayersAndFeatures();
  });
  $("feature-close").addEventListener("click", () => featureDialog.close());
  $("feature-form").addEventListener("submit", saveFeatureDetails);
  featureDialog.addEventListener("close", cancelUnsavedFeature);
  $("feature-delete").addEventListener("click", () => openDeleteDialog(state.selectedFeature, true));
  const deleteCancelButton = $("delete-cancel");
  const deleteConfirmButton = $("delete-confirm");
  if (deleteCancelButton) deleteCancelButton.addEventListener("click", () => $("delete-dialog").close());
  if (deleteConfirmButton) deleteConfirmButton.addEventListener("click", deleteFeature);
  $("draw-point").addEventListener("click", () => beginDraw("draw_point"));
  $("draw-polygon").addEventListener("click", () => beginDraw("draw_polygon"));

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
