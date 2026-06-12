(function () {
  function $(id) {
    return document.getElementById(id);
  }

  const modal = $("lmModal");
  if (!modal) return;

  const searchForm = $("lmSearchForm");
  const nameInput = $("lmName");
  const nameList = $("lmNameList");
  const groupSelect = $("lmGroupId");
  const typeSelect = $("lmTypeId");
  const searchBtn = $("lmSearchBtn");
  const createBtn = $("lmCreateBtn");
  const tbody = $("lmTbody");
  const metaEl = $("lmMeta");
  const loadingEl = $("lmLoading");
  const loadMoreBtn = $("lmLoadMoreBtn");

  /** Перехоплення → вкладка «Перегляд»: швидкий пошук / створення орієнтира */
  const ieNameInput = $("ieLmName");
  const ieNameList = $("ieLmNameList");
  const ieSearchBtn = $("ieLmSearchBtn");
  const ieCreateBtn = $("ieLmCreateBtn");

  const editIdInput = $("lmEditId");
  const editNameInput = $("lmEditName");
  const editIsActiveInput = $("lmEditIsActive");
  const editIsPermanentInput = $("lmEditIsPermanent");
  const editLocationMgrsInput = $("lmEditLocationMgrs");
  const editLocationWktInput = $("lmEditLocationWkt");
  const editCommentInput = $("lmEditComment");
  const editGroupSelect = $("lmEditGroupId");
  const editTypeSelect = $("lmEditTypeId");
  const editGeomSelect = $("lmEditGeomId");
  const mgrsWrap = $("lmEditMgrsWrap");
  const wktWrap = $("lmEditWktWrap");
  const mapEl = $("lmEditMap");
  const editErr = $("lmEditErr");
  const editDeleteBtn = $("lmEditDeleteBtn");
  const editSaveBtn = $("lmEditSaveBtn");
  const copyMgrsBtn = $("lmEditCopyMgrs");
  const copyWktBtn = $("lmEditCopyWkt");
  const mapAddBtn = $("lmEditMapAddBtn");
  const mapClearBtn = $("lmEditMapClearBtn");
  const mapHintEl = $("lmEditMapHint");

  const mapState = {
    map: null,
    layers: [],
  };

  /** Графічний редактор геометрії на мапі модалки.
      verts — массив L.LatLng в порядку додавання;
      mainLayer — полігон/полілінія, що візуалізує контур;
      vAnchors — драгабельні маркери-вершини;
      midAnchors — маркери-середини ребер (полігон), драг → нова вершина. */
  const editor = {
    enabled: false,
    drawing: false,
    geomId: 1,
    verts: [],
    mainLayer: null,
    vAnchors: [],
    midAnchors: [],
  };

  const state = {
    groups: [],
    types: [],
    geomTypes: [],
    unknownTypeId: null,
    lastAutocompleteTimer: null,
    lastAutocompleteQuery: "",
    limit: 50,
    offset: 0,
    total: 0,
    hasMore: false,
    isLoading: false,
  };

  function openModal() {
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      scheduleMapRefresh();
    });
  }

  function closeModal() {
    if (!modal) return;
    destroyLandmarkMap();
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    editErr.style.display = "none";
    editErr.textContent = "";
  }

  function clearEditInputs() {
    if (editNameInput) editNameInput.value = "";
    if (editIsActiveInput) editIsActiveInput.checked = true;
    if (editIsPermanentInput) editIsPermanentInput.checked = true;
    if (editLocationMgrsInput) editLocationMgrsInput.value = "";
    if (editLocationWktInput) editLocationWktInput.value = "";
    if (editCommentInput) editCommentInput.value = "";
    if (editGroupSelect) editGroupSelect.value = "";
    if (editTypeSelect) editTypeSelect.value = "";
    if (editGeomSelect && state.geomTypes.length) editGeomSelect.value = String(state.geomTypes[0].id);
    editor.verts = [];
    syncGeomFields();
  }

  async function copyTextToClipboard(text) {
    const t = String(text ?? "");
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(t);
        return;
      }
    } catch {
      /* fallback */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      /* ignore */
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function mgrsToLatLonBrowser(mgrsStr) {
    if (!window.mgrs || typeof window.mgrs.toPoint !== "function") return null;
    const raw = String(mgrsStr || "")
      .trim()
      .replace(/\s+/g, "")
      .toUpperCase();
    if (!raw) return null;
    try {
      const p = window.mgrs.toPoint(raw);
      if (!Array.isArray(p) || p.length < 2) return null;
      const lon = Number(p[0]);
      const lat = Number(p[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { lat, lon };
    } catch {
      return null;
    }
  }

  function parsePointWkt(wkt) {
    const m = String(wkt || "")
      .trim()
      .match(/^POINT\s*\(\s*([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+(?:\.\d+)?)\s*\)/i);
    if (!m) return null;
    const lon = Number(m[1]);
    const lat = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  }

  function parsePolygonRingLatLngs(wkt) {
    const s = String(wkt || "").trim();
    const inner = s.match(/^POLYGON\s*\(\s*\(\s*(.+)\s*\)\s*\)/i);
    if (!inner) return null;
    const parts = inner[1].split(",").map((p) => p.trim().split(/\s+/));
    const out = [];
    for (let i = 0; i < parts.length; i++) {
      const a = parts[i];
      if (a.length < 2) continue;
      const lon = Number(a[0]);
      const lat = Number(a[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      out.push(window.L.latLng(lat, lon));
    }
    return out.length ? out : null;
  }

  function destroyLandmarkMap() {
    clearEditorLayers();
    if (mapState.map) {
      try { mapState.map.remove(); } catch {}
      mapState.map = null;
    }
    mapState.layers = [];
    editor.verts = [];
    editor.drawing = false;
    if (mapAddBtn) mapAddBtn.classList.remove("is-active");
    if (mapEl) {
      mapEl.classList.remove("is-drawing");
      mapEl.innerHTML = "";
    }
  }

  /* ---------- Helpers ---------- */
  function lmAnchorIcon(kind) {
    const cls = kind === "mid" ? "lm-anchor lm-anchor--mid" : "lm-anchor";
    return window.L.divIcon({ className: "", iconSize: [16, 16], iconAnchor: [8, 8], html: `<div class="${cls}"></div>` });
  }
  function midLatLng(a, b) { return window.L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2); }

  function ensureMap() {
    if (!mapEl || !window.L) return null;
    if (mapState.map) return mapState.map;
    mapEl.innerHTML = "";
    const map = window.L.map(mapEl, { scrollWheelZoom: true });
    mapState.map = map;
    window.L.tileLayer(
      "https://mt1.google.com/vt/lyrs=y&hl=uk&x={x}&y={y}&z={z}",
      { maxZoom: 20, attribution: "Google" }
    ).addTo(map);
    // Default view (буде fit-bounds, як з'являться точки)
    map.setView([48.5, 37.5], 9);
    // Клік по карті → додати вершину в режимі редагування
    map.on("click", function (e) {
      if (editor.drawing && (editor.geomId === 2 || editor.geomId === 3)) {
        editor.verts.push(e.latlng);
        rebuildEditorLayers();
        syncWktFromEditor();
      }
    });
    return map;
  }

  function clearEditorLayers() {
    const map = mapState.map;
    if (!map) { editor.mainLayer = null; editor.vAnchors = []; editor.midAnchors = []; return; }
    if (editor.mainLayer) { map.removeLayer(editor.mainLayer); editor.mainLayer = null; }
    editor.vAnchors.forEach(m => map.removeLayer(m));
    editor.midAnchors.forEach(m => map.removeLayer(m));
    editor.vAnchors = []; editor.midAnchors = [];
  }

  function rebuildEditorLayers() {
    const map = ensureMap(); if (!map) return;
    clearEditorLayers();
    if (!editor.verts.length) return;

    const gid = editor.geomId;
    const isPoly = (gid === 2);
    if (gid === 1) {
      // Точка
      const m = window.L.circleMarker(editor.verts[0], { radius: 8, color: "#f97316", weight: 2, fillColor: "#22c55e", fillOpacity: 0.85 }).addTo(map);
      editor.mainLayer = m;
      return;
    }

    // Зона (полігон) ≥ 3 верш або Крива (полілінія) ≥ 2 верш
    if (isPoly && editor.verts.length >= 3) {
      editor.mainLayer = window.L.polygon(editor.verts, { color: "#f97316", weight: 2, fillColor: "#22c55e", fillOpacity: 0.2 }).addTo(map);
    } else if (!isPoly && editor.verts.length >= 2) {
      editor.mainLayer = window.L.polyline(editor.verts, { color: "#f97316", weight: 3 }).addTo(map);
    } else if (editor.verts.length === 1) {
      editor.mainLayer = window.L.circleMarker(editor.verts[0], { radius: 5, color: "#f97316", fillColor: "#f97316", fillOpacity: 0.7 }).addTo(map);
    }

    // Якори-вершини
    editor.verts.forEach((ll, idx) => {
      const m = window.L.marker(ll, { icon: lmAnchorIcon("v"), draggable: true, bubblingMouseEvents: false }).addTo(map);
      m.on("drag", e => { editor.verts[idx] = e.latlng; if (editor.mainLayer && editor.mainLayer.setLatLngs) editor.mainLayer.setLatLngs(editor.verts); updateMidAnchors(); });
      m.on("dragend", () => syncWktFromEditor());
      m.on("click", e => {
        // Ctrl/Cmd-клік — видалити вершину
        if (e.originalEvent && (e.originalEvent.ctrlKey || e.originalEvent.metaKey)) {
          editor.verts.splice(idx, 1);
          rebuildEditorLayers();
          syncWktFromEditor();
        }
      });
      editor.vAnchors.push(m);
    });

    // Серединні якори (тільки для полігону / кривої) — перетягування створює нову вершину
    if (editor.verts.length >= 2) {
      const n = editor.verts.length;
      const segCnt = isPoly ? n : n - 1;
      for (let i = 0; i < segCnt; i++) {
        const a = editor.verts[i];
        const b = editor.verts[(i + 1) % n];
        const m = window.L.marker(midLatLng(a, b), { icon: lmAnchorIcon("mid"), draggable: true, bubblingMouseEvents: false }).addTo(map);
        let inserted = false; let newIdx = -1;
        m.on("dragstart", () => { inserted = false; });
        m.on("drag", e => {
          if (!inserted) {
            newIdx = i + 1;
            editor.verts.splice(newIdx, 0, e.latlng);
            inserted = true;
          } else {
            editor.verts[newIdx] = e.latlng;
          }
          if (editor.mainLayer && editor.mainLayer.setLatLngs) editor.mainLayer.setLatLngs(editor.verts);
        });
        m.on("dragend", () => { rebuildEditorLayers(); syncWktFromEditor(); });
        editor.midAnchors.push(m);
      }
    }
  }

  function updateMidAnchors() {
    const isPoly = (editor.geomId === 2);
    const n = editor.verts.length;
    const segCnt = isPoly ? n : n - 1;
    editor.midAnchors.forEach((m, i) => {
      if (i >= segCnt) return;
      const a = editor.verts[i];
      const b = editor.verts[(i + 1) % n];
      m.setLatLng(midLatLng(a, b));
    });
  }

  /* Будує WKT з editor.verts і пише в editLocationWktInput. */
  function syncWktFromEditor() {
    if (!editLocationWktInput) return;
    const gid = editor.geomId;
    if (gid === 1) {
      if (editor.verts.length) {
        const p = editor.verts[0];
        editLocationWktInput.value = `POINT (${p.lng} ${p.lat})`;
      } else {
        editLocationWktInput.value = "";
      }
      return;
    }
    if (gid === 2 && editor.verts.length >= 3) {
      const ring = editor.verts.concat([editor.verts[0]]).map(p => `${p.lng} ${p.lat}`).join(", ");
      editLocationWktInput.value = `POLYGON((${ring}))`;
      return;
    }
    if (gid === 3 && editor.verts.length >= 2) {
      const line = editor.verts.map(p => `${p.lng} ${p.lat}`).join(", ");
      editLocationWktInput.value = `LINESTRING(${line})`;
      return;
    }
    editLocationWktInput.value = "";
  }

  /* Завантажує початкові вершини з збереженого WKT (для режиму редагування). */
  function loadEditorFromWkt(wkt, gid) {
    editor.verts = [];
    if (!wkt) return;
    const up = wkt.trim().toUpperCase();
    if (up.startsWith("POINT")) {
      const pw = parsePointWkt(wkt); if (pw) editor.verts = [window.L.latLng(pw.lat, pw.lon)];
    } else if (up.startsWith("LINESTRING")) {
      const m = wkt.match(/^LINESTRING\s*\(\s*(.+)\s*\)/i);
      if (m) m[1].split(",").forEach(p => {
        const a = p.trim().split(/\s+/); const lon = Number(a[0]), lat = Number(a[1]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) editor.verts.push(window.L.latLng(lat, lon));
      });
    } else if (up.startsWith("POLYGON")) {
      const ring = parsePolygonRingLatLngs(wkt) || [];
      // У WKT POLYGON останній == перший — приберемо дубль для редактора
      const arr = ring.slice();
      if (arr.length > 1 && arr[0].lat === arr[arr.length - 1].lat && arr[0].lng === arr[arr.length - 1].lng) arr.pop();
      editor.verts = arr;
    }
  }

  function refreshLandmarkMap() {
    if (!mapEl || !window.L) return;
    const map = ensureMap(); if (!map) return;

    const gid = Number(editGeomSelect && editGeomSelect.value ? editGeomSelect.value : 1);
    editor.geomId = gid;

    // Точка: вершина береться з MGRS-інпута (overrides editor.verts)
    if (gid === 1) {
      const ll = mgrsToLatLonBrowser(editLocationMgrsInput && editLocationMgrsInput.value);
      if (ll) {
        editor.verts = [window.L.latLng(ll.lat, ll.lon)];
      } else if (!editor.verts.length && editLocationWktInput && editLocationWktInput.value) {
        loadEditorFromWkt(editLocationWktInput.value, 1);
      }
    }
    rebuildEditorLayers();
    syncWktFromEditor();

    // Авто-центр на наявних точках
    if (editor.verts.length) {
      if (editor.verts.length === 1) {
        map.setView(editor.verts[0], Math.max(map.getZoom(), 12));
      } else {
        const g = window.L.featureGroup(editor.vAnchors);
        try { map.fitBounds(g.getBounds().pad(0.2)); } catch {}
      }
    }
    setTimeout(() => map.invalidateSize(), 50);
  }

  let mapRefreshTimer = null;
  function scheduleMapRefresh() {
    if (mapRefreshTimer) clearTimeout(mapRefreshTimer);
    mapRefreshTimer = setTimeout(() => {
      mapRefreshTimer = null;
      refreshLandmarkMap();
    }, 200);
  }

  function syncGeomFields() {
    const gid = Number(editGeomSelect && editGeomSelect.value ? editGeomSelect.value : 1);
    editor.geomId = gid;
    if (mgrsWrap && wktWrap) {
      if (gid === 1) {
        mgrsWrap.classList.remove("hidden");
        wktWrap.classList.add("hidden");
      } else {
        mgrsWrap.classList.add("hidden");
        wktWrap.classList.remove("hidden");
      }
    }
    // Кнопки редактора видно лише для Зона/Крива
    const isEdit = (gid === 2 || gid === 3);
    if (mapAddBtn)   mapAddBtn.classList.toggle("hidden",   !isEdit);
    if (mapClearBtn) mapClearBtn.classList.toggle("hidden", !isEdit);
    if (!isEdit) {
      editor.drawing = false;
      if (mapAddBtn) mapAddBtn.classList.remove("is-active");
      if (mapEl) mapEl.classList.remove("is-drawing");
    }
    if (mapHintEl) {
      mapHintEl.textContent = (gid === 1)
        ? "Перегляд геометрії (WGS84). Для «точки» введіть MGRS зліва."
        : "Натисніть «+» і клікайте по карті, щоб додати вершини. Якори перетягуйте; Ctrl+клік — видалити вершину.";
    }
    scheduleMapRefresh();
  }

  async function apiGet(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || data.error || "Помилка запиту");
    return data;
  }

  async function apiPost(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || data.error || "Помилка збереження");
    return data;
  }

  function renderMeta() {
    if (!metaEl) return;
    const shown = tbody ? tbody.children.length : 0;
    metaEl.textContent = `Знайдено: ${state.total}. Показано: ${shown}.`;
  }

  function renderRows(items, append = false) {
    if (!tbody) return;
    if (!append) tbody.innerHTML = "";

    if (!items || !items.length) {
      if (!append) {
        tbody.innerHTML = `<tr><td colspan="4" class="small" style="opacity:.8">Немає результатів</td></tr>`;
      }
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const idx = state.offset + i + 1;
      const tr = document.createElement("tr");
      tr.className = "lm-row";
      tr.dataset.id = String(it.id);
      tr.innerHTML = `
        <td>${idx}</td>
        <td>${escapeHtml(it.type_name)}</td>
        <td>${escapeHtml(it.name)}</td>
        <td>${escapeHtml(it.group_name ?? "—")}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  function setLoading(isLoading) {
    state.isLoading = !!isLoading;
    if (loadingEl) loadingEl.style.display = isLoading ? "block" : "none";
    if (searchBtn) {
      searchBtn.disabled = !!isLoading;
      searchBtn.textContent = isLoading ? "Завантаження…" : "Шукати";
    }
    if (loadMoreBtn) loadMoreBtn.disabled = !!isLoading;
  }

  function setLoadMoreVisible() {
    if (!loadMoreBtn) return;
    loadMoreBtn.style.display = state.hasMore ? "inline-block" : "none";
  }

  function buildSearchParams() {
    const params = new URLSearchParams();

    const nameVal = String(nameInput?.value || "").trim();
    const groupVal = String(groupSelect?.value || "").trim();
    const typeVal = String(typeSelect?.value || "").trim();

    if (nameVal) params.set("name", nameVal);
    if (groupVal) params.set("group_id", groupVal);
    if (typeVal) params.set("type_id", typeVal);

    params.set("limit", String(state.limit));
    params.set("offset", String(state.offset));

    return params;
  }

  async function loadSearchPage(reset) {
    if (state.isLoading) return;
    if (reset) state.offset = 0;

    const params = buildSearchParams();
    const url = `/api/landmarks/search?${params.toString()}`;

    setLoading(true);
    try {
      const data = await apiGet(url);
      const items = Array.isArray(data.items) ? data.items : [];
      const meta = data.meta || {};

      state.total = Number(meta.total || 0);
      state.hasMore = !!meta.has_more;

      // Render and append.
      renderRows(items, !reset);
      renderMeta();
      setLoadMoreVisible();
    } finally {
      setLoading(false);
      if (searchBtn) searchBtn.disabled = false;
      if (loadMoreBtn) loadMoreBtn.disabled = false;
    }
  }

  async function loadAutocomplete(q) {
    if (!nameInput || !nameList) return;

    const query = String(q || "").trim();
    if (query.length < 2) {
      nameList.innerHTML = "";
      return;
    }

    const data = await apiGet(`/api/landmarks/autocomplete?q=${encodeURIComponent(query)}`);
    const rows = Array.isArray(data.rows) ? data.rows : [];

    // Only update for the latest query (avoid race conditions).
    if (state.lastAutocompleteQuery !== query) return;

    nameList.innerHTML = "";
    for (const r of rows) {
      const opt = document.createElement("option");
      opt.value = r.name || "";
      nameList.appendChild(opt);
    }
  }

  function setupAutocomplete() {
    if (!nameInput) return;
    nameInput.addEventListener("input", () => {
      const q = String(nameInput.value || "").trim();
      if (state.lastAutocompleteTimer) clearTimeout(state.lastAutocompleteTimer);
      state.lastAutocompleteQuery = q;
      state.lastAutocompleteTimer = setTimeout(() => {
        loadAutocomplete(q).catch(() => {});
      }, 250);
    });
  }

  async function loadExplorerAutocomplete(q) {
    if (!ieNameList) return;

    const query = String(q || "").trim();
    if (query.length < 2) {
      ieNameList.innerHTML = "";
      return;
    }

    const data = await apiGet(`/api/landmarks/autocomplete?q=${encodeURIComponent(query)}`);
    const rows = Array.isArray(data.rows) ? data.rows : [];

    if (state.lastAutocompleteQuery !== query) return;

    ieNameList.innerHTML = "";
    for (const r of rows) {
      const opt = document.createElement("option");
      opt.value = r.name || "";
      ieNameList.appendChild(opt);
    }
  }

  function setupExplorerAutocomplete() {
    if (!ieNameInput) return;
    ieNameInput.addEventListener("input", () => {
      const q = String(ieNameInput.value || "").trim();
      if (state.lastAutocompleteTimer) clearTimeout(state.lastAutocompleteTimer);
      state.lastAutocompleteQuery = q;
      state.lastAutocompleteTimer = setTimeout(() => {
        loadExplorerAutocomplete(q).catch(() => {});
      }, 250);
    });
  }

  function setupExplorerActions() {
    if (!ieSearchBtn || !ieNameInput) return;

    function goSearch() {
      const q = String(ieNameInput.value || "").trim();
      if (typeof window.interceptsExplorerFocusLandmarksTab === "function") {
        window.interceptsExplorerFocusLandmarksTab(q);
      }
    }

    ieSearchBtn.addEventListener("click", goSearch);
    ieNameInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        goSearch();
      }
    });

    if (ieCreateBtn) {
      ieCreateBtn.addEventListener("click", () => {
        openCreateModal();
      });
    }
  }

  function populateSelect(selectEl, items, includeAllOption, allLabel = "Усі") {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    if (includeAllOption) {
      const optAll = document.createElement("option");
      optAll.value = "";
      optAll.textContent = allLabel;
      selectEl.appendChild(optAll);
    }
    for (const it of items) {
      const opt = document.createElement("option");
      opt.value = String(it.id);
      opt.textContent = it.name || "";
      selectEl.appendChild(opt);
    }
  }

  function populateGeomSelect(selectEl, items) {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    const list = Array.isArray(items) ? items : [];
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const opt = document.createElement("option");
      opt.value = String(it.id);
      opt.textContent = it.name || "";
      selectEl.appendChild(opt);
    }
  }

  async function loadReference() {
    const data = await apiGet("/api/landmarks/reference");
    state.groups = Array.isArray(data.groups) ? data.groups : [];
    state.types = Array.isArray(data.types) ? data.types : [];
    state.geomTypes = Array.isArray(data.geom_types) ? data.geom_types : [];
    state.unknownTypeId = data.unknown_type_id ? Number(data.unknown_type_id) : null;
    // Лічильник використання — отримуємо паралельно, щоб показати в керуванні.
    try {
      const usage = await apiGet("/api/landmark-type-usage");
      state.typeUsage = usage && usage.usage ? usage.usage : {};
    } catch { state.typeUsage = {}; }

    populateSelect(groupSelect, state.groups, true, "Усі");
    populateSelect(typeSelect, state.types, true, "Усі");
    populateSelect(editGroupSelect, state.groups, true, "Без підрозділу");
    populateSelect(editTypeSelect, state.types, true, "Оберіть тип");
    populateGeomSelect(editGeomSelect, state.geomTypes);
    renderTypeManageList();
  }

  /* ---- Type manager (inline panel) ---- */
  function renderTypeManageList() {
    const host = $("lmTypeManageList");
    if (!host) return;
    host.innerHTML = "";
    const unk = state.unknownTypeId;
    state.types.forEach(t => {
      const row = document.createElement("div");
      row.className = "lm-type-manage-row";
      const isSystem = (t.id === unk);
      const used = (state.typeUsage && state.typeUsage[t.id]) || 0;
      const meta = `<span class="lm-type-manage-row-meta">${isSystem ? "системний" : (used > 0 ? "× " + used : "")}</span>`;
      const canDel = !isSystem && used === 0;
      row.innerHTML =
        `<span class="${isSystem ? "is-system" : ""}">${escapeHtml(t.name)}</span>` +
        `<span style="display:flex;align-items:center">${meta}` +
        `<button type="button" class="lm-type-manage-del-btn" data-id="${t.id}" ${canDel ? "" : "disabled"} title="${isSystem ? "Системний — не можна видалити" : (used > 0 ? "Використовується — спершу перепризначте орієнтири" : "Видалити")}">✕</button>` +
        `</span>`;
      host.appendChild(row);
    });
    host.querySelectorAll(".lm-type-manage-del-btn").forEach(b => {
      b.addEventListener("click", () => onDeleteType(Number(b.dataset.id)));
    });
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }

  async function onAddType() {
    const inp = $("lmTypeManageName");
    const err = $("lmTypeManageErr");
    if (err) { err.style.display = "none"; err.textContent = ""; }
    const name = (inp && inp.value || "").trim();
    if (!name) return;
    try {
      await apiPost("/api/landmark-types", { name });
      if (inp) inp.value = "";
      await loadReference();
      if (window.appToast) window.appToast(`Тип додано: ${name}`, "success", 1400);
    } catch (e) {
      if (err) { err.textContent = e.message || "Помилка"; err.style.display = "block"; }
    }
  }

  async function onDeleteType(id) {
    const t = state.types.find(x => x.id === id);
    if (!t) return;
    if (!confirm(`Видалити тип «${t.name}»?`)) return;
    const err = $("lmTypeManageErr");
    if (err) { err.style.display = "none"; err.textContent = ""; }
    try {
      await apiPost(`/api/landmark-types/${id}/delete`, {});
      await loadReference();
      if (window.appToast) window.appToast(`Тип видалено: ${t.name}`, "success", 1400);
    } catch (e) {
      if (err) { err.textContent = e.message || "Помилка видалення"; err.style.display = "block"; }
    }
  }

  function initTypeManageUi() {
    const btn = $("lmTypeManageBtn");
    const panel = $("lmTypeManagePanel");
    const addBtn = $("lmTypeManageAddBtn");
    const nameInp = $("lmTypeManageName");
    if (!btn || !panel) return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.toggle("hidden");
    });
    // Закриття при кліку поза панеллю.
    document.addEventListener("click", (e) => {
      if (panel.classList.contains("hidden")) return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      panel.classList.add("hidden");
    });
    if (addBtn) addBtn.addEventListener("click", onAddType);
    if (nameInp) nameInp.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); onAddType(); }
    });
  }

  function fillEditModal(landmark) {
    if (!landmark) return;
    editIdInput.value = String(landmark.id);
    editNameInput.value = landmark.name || "";
    if (editIsActiveInput) editIsActiveInput.checked = !!landmark.is_active;

    const gId = landmark.id_group == null ? "" : String(landmark.id_group);
    const tId = String(landmark.id_type);

    if (editGroupSelect) editGroupSelect.value = gId;
    if (editTypeSelect) {
      const nt = state.unknownTypeId;
      const idTypeNum = Number(landmark.id_type);
      editTypeSelect.value = nt != null && idTypeNum === nt ? "" : tId;
    }

    const ig = landmark.id_geom != null ? Number(landmark.id_geom) : 1;
    if (editGeomSelect) editGeomSelect.value = String(ig);
    editor.geomId = ig;

    if (editLocationMgrsInput) editLocationMgrsInput.value = landmark.location_mgrs || "";
    if (editLocationWktInput) editLocationWktInput.value = landmark.location_wkt || "";
    if (editCommentInput) editCommentInput.value = landmark.comment || "";
    if (editIsActiveInput) editIsActiveInput.checked = landmark.is_active !== 0;
    if (editIsPermanentInput) editIsPermanentInput.checked = landmark.is_permanent !== 0;

    // Завантажити збережений WKT у редактор (для Зона/Крива/Точка без MGRS)
    if (ig === 2 || ig === 3) {
      loadEditorFromWkt(landmark.location_wkt || "", ig);
    }

    if (
      ig === 1 &&
      editLocationMgrsInput &&
      !String(editLocationMgrsInput.value || "").trim() &&
      editLocationWktInput
    ) {
      const wkt = String(landmark.location_wkt || "").trim();
      const pw = parsePointWkt(wkt);
      if (pw && window.mgrs) {
        try {
          if (typeof window.mgrs.forward === "function") {
            editLocationMgrsInput.value = window.mgrs.forward([pw.lon, pw.lat]);
          } else if (typeof window.mgrs.toMGRS === "function") {
            editLocationMgrsInput.value = window.mgrs.toMGRS(pw.lat, pw.lon);
          }
        } catch {}
      }
    }

    $("lmModalTitle").textContent = landmark.name || "—";
    syncGeomFields();
  }

  async function openEditModal(landmarkId) {
    editErr.style.display = "none";
    editErr.textContent = "";
    editIdInput.value = String(landmarkId);

    const data = await apiGet(`/api/landmarks/${encodeURIComponent(landmarkId)}`);
    if (!data.landmark) throw new Error("Орієнтир не знайдено");

    fillEditModal(data.landmark);
    if (editDeleteBtn) editDeleteBtn.style.display = "inline-block";
    openModal();
  }

  window.openLandmarkEditModalById = function (landmarkId) {
    return openEditModal(landmarkId);
  };

  function openCreateModal() {
    editErr.style.display = "none";
    editErr.textContent = "";
    editIdInput.value = "";
    clearEditInputs();
    $("lmModalTitle").textContent = "Створення орієнтира";
    if (editDeleteBtn) editDeleteBtn.style.display = "none";
    openModal();
  }

  window.openLandmarkCreateModal = openCreateModal;

  async function saveEdit() {
    const id = String(editIdInput.value || "").trim();

    editSaveBtn.disabled = true;
    try {
      const name = String(editNameInput.value || "").trim();
      let location_mgrs = String(editLocationMgrsInput?.value || "").trim();
      let location_wkt = String(editLocationWktInput?.value || "").trim();
      const id_geom = editGeomSelect?.value ? Number(editGeomSelect.value) : 1;
      const id_type = editTypeSelect?.value || "";
      const id_group = editGroupSelect?.value || "";
      const comment = String(editCommentInput?.value || "").trim();
      const isCreate = !id;
      const is_active = editIsActiveInput?.checked ? 1 : 0;
      const is_permanent = editIsPermanentInput?.checked ? 1 : 0;

      if (!name) throw new Error("Назва не може бути порожньою");

      if (id_geom === 1) {
        if (location_mgrs) {
          const ll = mgrsToLatLonBrowser(location_mgrs);
          if (!ll) throw new Error("Некоректний MGRS");
          location_wkt = `POINT (${ll.lon} ${ll.lat})`;
        } else {
          location_wkt = "";
        }
      } else if (id_geom === 2) {
        if (editor.verts.length < 3) throw new Error("Для «Зони» потрібно щонайменше 3 вершини");
      } else if (id_geom === 3) {
        if (editor.verts.length < 2) throw new Error("Для «Кривої» потрібно щонайменше 2 точки");
      }

      const payload = {
        name: name,
        location_mgrs: location_mgrs,
        location_wkt: location_wkt,
        id_geom: id_geom,
        id_type: id_type ? Number(id_type) : null,
        id_group: id_group ? Number(id_group) : null,
        comment: comment || "",
        is_active: is_active,
        is_permanent: is_permanent,
      };

      if (id) {
        await apiPost(`/api/landmarks/${encodeURIComponent(id)}`, payload);
      } else {
        await apiPost(`/api/landmarks`, payload);
      }
      closeModal();
      if (window.appToast) window.appToast("Збережено.", "info", 1400);
      if (searchForm) {
        await loadSearchPage(true);
      } else {
        const iframe = document.getElementById("itLandmarksIframe");
        if (iframe && iframe.src) {
          iframe.src = iframe.src;
        }
      }
    } catch (e) {
      editErr.textContent = e.message || "Помилка";
      editErr.style.display = "block";
    } finally {
      editSaveBtn.disabled = false;
    }
  }

  function setupEvents() {
    // If user presses Enter inside any input, browser submits the form and navigates.
    // We intercept it and run our async search.
    if (searchForm) {
      searchForm.addEventListener("submit", (ev) => {
        ev.preventDefault();
        loadSearchPage(true).catch(() => {});
      });
    }

    if (searchBtn) searchBtn.addEventListener("click", () => loadSearchPage(true));
    if (createBtn) createBtn.addEventListener("click", openCreateModal);
    if (loadMoreBtn)
      loadMoreBtn.addEventListener("click", () => {
        state.offset += state.limit;
        loadSearchPage(false).catch(() => {});
      });

    // Row click -> open edit modal.
    if (tbody) {
      tbody.addEventListener("click", (ev) => {
        const tr = ev.target.closest("tr");
        if (!tr || !tr.dataset || !tr.dataset.id) return;
        const id = tr.dataset.id;
        openEditModal(id).catch((e) => {
          if (window.appToast) window.appToast(e.message || "Помилка", "error");
        });
      });
    }

    // Modal close handlers.
    modal.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!t) return;
      const close = t.getAttribute && t.getAttribute("data-close") === "1";
      if (close) closeModal();
      if (t === modal) closeModal();
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && modal && !modal.classList.contains("hidden")) closeModal();
    });

    if (editSaveBtn) editSaveBtn.addEventListener("click", saveEdit);

    if (copyMgrsBtn && editLocationMgrsInput) {
      copyMgrsBtn.addEventListener("click", () => {
        copyTextToClipboard(editLocationMgrsInput.value);
      });
    }
    if (copyWktBtn && editLocationWktInput) {
      copyWktBtn.addEventListener("click", () => {
        copyTextToClipboard(editLocationWktInput.value);
      });
    }

    if (editGeomSelect) editGeomSelect.addEventListener("change", () => {
      // Зміна типу геометрії скидає вершини редактора (несумісні форми).
      editor.verts = [];
      syncGeomFields();
    });
    initTypeManageUi();
    if (editLocationMgrsInput) {
      editLocationMgrsInput.addEventListener("input", scheduleMapRefresh);
    }
    if (editLocationWktInput) {
      editLocationWktInput.addEventListener("input", scheduleMapRefresh);
    }
    // Кнопка «+» — увімкнути режим додавання вершин по кліку на карту.
    if (mapAddBtn) {
      mapAddBtn.addEventListener("click", () => {
        editor.drawing = !editor.drawing;
        mapAddBtn.classList.toggle("is-active", editor.drawing);
        if (mapEl) mapEl.classList.toggle("is-drawing", editor.drawing);
      });
    }
    // Кнопка «✕» — очистити всі вершини редактора.
    if (mapClearBtn) {
      mapClearBtn.addEventListener("click", () => {
        editor.verts = [];
        rebuildEditorLayers();
        syncWktFromEditor();
      });
    }
    if (editDeleteBtn) {
      editDeleteBtn.addEventListener("click", async () => {
        const id = String(editIdInput.value || "").trim();
        if (!id) return;
        if (!confirm("Видалити орієнтир?")) return;
        editDeleteBtn.disabled = true;
        try {
          await apiPost(`/api/landmarks/${encodeURIComponent(id)}/delete`, {});
          closeModal();
          if (searchForm) {
            await loadSearchPage(true);
          } else {
            const iframe = document.getElementById("itLandmarksIframe");
            if (iframe && iframe.src) {
              iframe.src = iframe.src;
            }
          }
        } catch (e) {
          editErr.textContent = e.message || "Помилка";
          editErr.style.display = "block";
        } finally {
          editDeleteBtn.disabled = false;
        }
      });
    }
  }

  // Init
  (async function init() {
    try {
      await loadReference();
      setupAutocomplete();
      setupExplorerAutocomplete();
      setupExplorerActions();
      setupEvents();

      // If the page is opened with query params (e.g. /landmarks?name=ябло),
      // reflect them in inputs and auto-run search.
      const qs = new URLSearchParams(window.location.search);
      const qName = String(qs.get("name") || "").trim();
      const qGroup = String(qs.get("group_id") || "").trim();
      const qType = String(qs.get("type_id") || "").trim();

      if (nameInput && qName) nameInput.value = qName;
      if (groupSelect && (qGroup || qGroup === "0")) groupSelect.value = qGroup;
      if (typeSelect && (qType || qType === "0")) typeSelect.value = qType;

      // Lazy load: initial render starts empty; user presses "Шукати".
      // (Still, we can load default list if you prefer - but requirement says lazy.)
      renderRows([], false);

      if (metaEl) {
        const hasAny = !!(qName || qGroup || qType);
        metaEl.textContent = hasAny
          ? "Завантаження..."
          : "Заповни фільтри та натисни “Шукати” (або залиш порожнім — показує все).";
      }

      if (searchForm && nameInput && (qName || qGroup || qType)) {
        await loadSearchPage(true);
      }
    } catch (e) {
      if (metaEl) metaEl.textContent = `Помилка: ${e.message || e}`;
    }
  })();
})();

