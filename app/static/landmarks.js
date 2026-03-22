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

  const mapState = {
    map: null,
    layers: [],
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
    if (editLocationMgrsInput) editLocationMgrsInput.value = "";
    if (editLocationWktInput) editLocationWktInput.value = "";
    if (editCommentInput) editCommentInput.value = "";
    if (editGroupSelect) editGroupSelect.value = "";
    if (editTypeSelect) editTypeSelect.value = "";
    if (editGeomSelect && state.geomTypes.length) editGeomSelect.value = String(state.geomTypes[0].id);
    syncGeomFields();
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
    if (mapState.map) {
      try {
        mapState.map.remove();
      } catch {}
      mapState.map = null;
    }
    mapState.layers = [];
    if (mapEl) mapEl.innerHTML = "";
  }

  function refreshLandmarkMap() {
    destroyLandmarkMap();
    if (!mapEl || !window.L) return;

    const gid = Number(editGeomSelect && editGeomSelect.value ? editGeomSelect.value : 1);
    let latlngs = [];
    let isPoint = false;

    if (gid === 1) {
      const ll = mgrsToLatLonBrowser(editLocationMgrsInput && editLocationMgrsInput.value);
      if (ll) {
        latlngs = [window.L.latLng(ll.lat, ll.lon)];
        isPoint = true;
      } else if (editLocationWktInput && editLocationWktInput.value) {
        const pw = parsePointWkt(editLocationWktInput.value);
        if (pw) {
          latlngs = [window.L.latLng(pw.lat, pw.lon)];
          isPoint = true;
        }
      }
    } else {
      const wkt = String(editLocationWktInput && editLocationWktInput.value ? editLocationWktInput.value : "").trim();
      const up = wkt.toUpperCase();
      if (up.startsWith("POINT")) {
        const pw = parsePointWkt(wkt);
        if (pw) {
          latlngs = [window.L.latLng(pw.lat, pw.lon)];
          isPoint = true;
        }
      } else if (up.startsWith("LINESTRING")) {
        const inner = wkt.match(/^LINESTRING\s*\(\s*(.+)\s*\)/i);
        if (inner) {
          const pts = inner[1].split(",").map((p) => p.trim().split(/\s+/));
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i];
            if (a.length < 2) continue;
            const lon = Number(a[0]);
            const lat = Number(a[1]);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            latlngs.push(window.L.latLng(lat, lon));
          }
        }
      } else {
        const ring = parsePolygonRingLatLngs(wkt);
        if (ring && ring.length) latlngs = ring;
      }
    }

    if (!latlngs.length) {
      mapEl.innerHTML = `<div class="landmark-modal-map-placeholder small">Немає координат для відображення</div>`;
      return;
    }

    const map = window.L.map(mapEl, { scrollWheelZoom: false });
    mapState.map = map;

    window.L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 19,
        attribution: "Tiles &copy; Esri",
      }
    ).addTo(map);

    if (isPoint) {
      const m = window.L.circleMarker(latlngs[0], {
        radius: 8,
        color: "#f97316",
        weight: 2,
        fillColor: "#22c55e",
        fillOpacity: 0.85,
      });
      m.addTo(map);
      mapState.layers.push(m);
      map.setView(latlngs[0], 12);
    } else {
      const gid = Number(editGeomSelect && editGeomSelect.value ? editGeomSelect.value : 2);
      const wktStr = String(editLocationWktInput && editLocationWktInput.value ? editLocationWktInput.value : "").trim();
      const isLine = wktStr.toUpperCase().startsWith("LINESTRING") || gid === 3;
      if (isLine && latlngs.length >= 2) {
        const line = window.L.polyline(latlngs, {
          color: "#f97316",
          weight: 3,
        });
        line.addTo(map);
        mapState.layers.push(line);
        map.fitBounds(line.getBounds().pad(0.2));
      } else if (latlngs.length >= 3) {
        const poly = window.L.polygon(latlngs, {
          color: "#f97316",
          weight: 2,
          fillColor: "#22c55e",
          fillOpacity: 0.2,
        });
        poly.addTo(map);
        mapState.layers.push(poly);
        map.fitBounds(poly.getBounds().pad(0.15));
      } else {
        try {
          map.remove();
        } catch {}
        mapState.map = null;
        mapEl.innerHTML = `<div class="landmark-modal-map-placeholder small">Недостатньо даних для WKT</div>`;
      }
    }
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
    if (mgrsWrap && wktWrap) {
      if (gid === 1) {
        mgrsWrap.classList.remove("hidden");
        wktWrap.classList.add("hidden");
      } else {
        mgrsWrap.classList.add("hidden");
        wktWrap.classList.remove("hidden");
      }
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
    if (searchBtn && isLoading) searchBtn.disabled = true;
    if (loadMoreBtn && isLoading) loadMoreBtn.disabled = true;
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

    populateSelect(groupSelect, state.groups, true, "Усі");
    populateSelect(typeSelect, state.types, true, "Усі");
    populateSelect(editGroupSelect, state.groups, true, "Без підрозділу");
    populateSelect(editTypeSelect, state.types, true, "Оберіть тип");
    populateGeomSelect(editGeomSelect, state.geomTypes);
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

    if (editLocationMgrsInput) editLocationMgrsInput.value = landmark.location_mgrs || "";
    if (editLocationWktInput) editLocationWktInput.value = landmark.location_wkt || "";
    if (editCommentInput) editCommentInput.value = landmark.comment || "";

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

      if (!name) throw new Error("Назва не може бути порожньою");

      if (id_geom === 1) {
        if (!location_mgrs) throw new Error("Вкажіть координати MGRS (точка)");
        const ll = mgrsToLatLonBrowser(location_mgrs);
        if (!ll) throw new Error("Некоректний MGRS");
        location_wkt = `POINT (${ll.lon} ${ll.lat})`;
      } else {
        if (!location_wkt) throw new Error("Вкажіть геометрію WKT (зона / крива)");
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
      };

      if (id) {
        await apiPost(`/api/landmarks/${encodeURIComponent(id)}`, payload);
      } else {
        await apiPost(`/api/landmarks`, payload);
      }
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
          alert(e.message || "Помилка");
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

    if (editGeomSelect) editGeomSelect.addEventListener("change", syncGeomFields);
    if (editLocationMgrsInput) {
      editLocationMgrsInput.addEventListener("input", scheduleMapRefresh);
    }
    if (editLocationWktInput) {
      editLocationWktInput.addEventListener("input", scheduleMapRefresh);
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

