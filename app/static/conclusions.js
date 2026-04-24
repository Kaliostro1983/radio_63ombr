/**
 * conclusions.js — Висновки page (v3).
 *
 * "Перегляд"     — filter bar + geo panel + card-style results table
 * "Налаштування" — conclusion types CRUD with keyword chips + colour picker
 */
(function () {
  "use strict";

  /* ── helpers ── */
  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function toast(msg, type) { if (window.appToast) window.appToast(msg, type); }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function localDatetimeString(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}` +
           `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  /** Colour with opacity via CSS color-mix – returns inline style string */
  function colorStyle(hex) {
    const c = hex || "#6b7280";
    return `background:color-mix(in srgb,${c} 18%,var(--card));` +
           `border-color:color-mix(in srgb,${c} 45%,var(--border));` +
           `color:${c}`;
  }

  /* ──────────────────────────────────────────────
   *  STATE
   * ────────────────────────────────────────────── */
  const state = {
    view: {
      loaded:   false,
      networks: [],   // [{id, frequency, mask, unit, label}]
      rows:     [],   // last loaded conclusion rows
    },
    settings: {
      loaded:        false,
      types:         [],
      deleteTargetId: null,
    },
  };

  /* ──────────────────────────────────────────────
   *  TAB SWITCHING
   * ────────────────────────────────────────────── */
  const tabBtns = document.querySelectorAll(".tab-btn[data-tab]");
  const tabPanels = { view: $("cnPaneView"), settings: $("cnPaneSettings"), quick: $("cnPaneQuick") };

  function activateTab(name) {
    tabBtns.forEach((btn) => {
      const active = btn.dataset.tab === name;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    Object.entries(tabPanels).forEach(([k, el]) => {
      if (el) el.classList.toggle("hidden", k !== name);
    });
    if (name === "view" && !state.view.loaded) {
      loadNetworksForFilter();
      loadTypesForFilter();
    }
    if (name === "settings" && !state.settings.loaded) loadTypes();
  }

  tabBtns.forEach((btn) => btn.addEventListener("click", () => activateTab(btn.dataset.tab)));

  /* ──────────────────────────────────────────────
   *  ПЕРЕГЛЯД — DOM refs
   * ────────────────────────────────────────────── */
  const filterForm     = $("cnFilterForm");
  const dateFrom       = $("cnDateFrom");
  const dateTo         = $("cnDateTo");
  const networkInput   = $("cnNetworkInput");
  const networkDrop    = $("cnNetworkDrop");
  const networkId      = $("cnNetworkId");
  const typeSel        = $("cnTypeSel");
  const cnShowBtn      = $("cnShowBtn");
  const cnLoadBtn      = $("cnLoadBtn");
  const cnCountVal     = $("cnCountVal");
  const cnMapToggleBtn = $("cnMapToggleBtn");
  const cnGeoPanel     = $("cnGeoPanel");
  const cnGeoMap       = $("cnGeoMap");
  const cnGeoInfo      = $("cnGeoInfo");
  const cnTable        = $("cnTable");
  const cnTableBody    = $("cnTableBody");
  const cnEmptyMsg     = $("cnEmptyMsg");
  const cnLoader       = $("cnLoader");

  /* ── date init ── */
  (function () {
    const now = new Date();
    const s   = new Date(now); s.setHours(0, 0, 0, 0);
    const e   = new Date(now); e.setHours(23, 59, 0, 0);
    dateFrom.value = localDatetimeString(s);
    dateTo.value   = localDatetimeString(e);
  })();

  /* ──────────────────────────────────────────────
   *  NETWORK AUTOCOMPLETE
   * ────────────────────────────────────────────── */
  async function loadNetworksForFilter() {
    try {
      const res  = await fetch("/api/conclusions/networks");
      if (!res.ok) return;
      const data = await res.json();
      state.view.networks = (data.rows || []).map((n) => ({
        id:    n.id,
        label: [n.frequency, n.mask, n.unit].filter(Boolean).join(" / ") || `#${n.id}`,
      }));
    } catch (_) { /* silent */ }
  }

  function showNetworkDrop(items) {
    networkDrop.innerHTML = "";
    if (!items.length) { networkDrop.classList.add("hidden"); return; }
    items.slice(0, 14).forEach((n) => {
      const div = document.createElement("div");
      div.className   = "cn-ac-item";
      div.textContent = n.label;
      div.addEventListener("mousedown", (e) => {
        e.preventDefault();
        networkInput.value = n.label;
        networkId.value    = n.id;
        networkDrop.classList.add("hidden");
      });
      networkDrop.appendChild(div);
    });
    networkDrop.classList.remove("hidden");
  }

  networkInput.addEventListener("input", () => {
    const q = networkInput.value.trim().toLowerCase();
    networkId.value = "";
    if (!q) { networkDrop.classList.add("hidden"); return; }
    showNetworkDrop(state.view.networks.filter((n) => n.label.toLowerCase().includes(q)));
  });
  networkInput.addEventListener("focus", () => {
    if (!networkInput.value.trim()) showNetworkDrop(state.view.networks.slice(0, 14));
  });
  networkInput.addEventListener("blur", () => {
    setTimeout(() => networkDrop.classList.add("hidden"), 150);
    if (!networkInput.value.trim()) networkId.value = "";
  });

  /* ──────────────────────────────────────────────
   *  TYPE FILTER (select)
   * ────────────────────────────────────────────── */
  async function loadTypesForFilter() {
    try {
      const res  = await fetch("/api/conclusions/types");
      if (!res.ok) return;
      const data = await res.json();
      (data.rows || []).forEach((t) => {
        const opt = document.createElement("option");
        opt.value       = t.id;
        opt.textContent = t.type || "невідомо";
        typeSel.appendChild(opt);
      });
    } catch (_) { /* silent */ }
  }

  /* ──────────────────────────────────────────────
   *  LOAD CONCLUSIONS
   * ────────────────────────────────────────────── */
  async function loadConclusions() {
    state.view.loaded = true;
    cnLoader.style.display   = "";
    cnTable.style.display    = "none";
    cnEmptyMsg.style.display = "none";
    cnCountVal.textContent   = "…";

    const params = new URLSearchParams();
    if (dateFrom.value) params.set("date_from", dateFrom.value);
    if (dateTo.value)   params.set("date_to",   dateTo.value);
    if (networkId.value) params.set("network_id", networkId.value);
    if (typeSel.value !== "-1") params.set("type_id", typeSel.value);

    try {
      const res  = await fetch("/api/conclusions?" + params);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      cnLoader.style.display = "none";

      const rows = data.rows || [];
      state.view.rows        = rows;
      cnCountVal.textContent = String(data.total ?? rows.length);

      if (!rows.length) {
        cnEmptyMsg.style.display = "";
        if (geoState.visible) plotMarkers();
        return;
      }

      cnTableBody.innerHTML = rows.map((r) => {
        const dt    = (r.created_at || "").replace("T", " ").slice(0, 16);
        const dateP = dt.slice(0, 10).replace(/(\d{4})-(\d{2})-(\d{2})/, "$3.$2");
        const timeP = dt.slice(11, 16);
        const net   = [r.frequency, r.mask, r.unit].filter(Boolean).join(" / ");
        const color = r.type_color || "#6b7280";
        const mgrs  = (r.mgrs || [])
          .map((m) => `<code class="cn-mgrs-code">${escapeHtml(m)}</code>`)
          .join(" ");

        return `<tr>
          <td style="text-align:center">
            <div class="small" style="font-weight:600;white-space:nowrap">${escapeHtml(dateP)} ${escapeHtml(timeP)}</div>
            ${net ? `<div class="small" style="opacity:.65;margin-top:2px;white-space:nowrap">${escapeHtml(net)}</div>` : ""}
          </td>
          <td style="text-align:center">
            <span class="cn-type-badge" style="${colorStyle(color)}">${escapeHtml(r.type_label || "невідомо")}</span>
          </td>
          <td class="small">${escapeHtml(r.conclusion_text || "")}</td>
          <td style="text-align:center">${mgrs || "<span style='opacity:.4'>—</span>"}</td>
        </tr>`;
      }).join("");

      cnTable.style.display = "";
      if (geoState.visible) plotMarkers();

    } catch (err) {
      cnLoader.style.display = "none";
      cnEmptyMsg.textContent = "Помилка завантаження: " + err.message;
      cnEmptyMsg.style.display = "";
      cnCountVal.textContent   = "—";
    }
  }

  filterForm.addEventListener("submit",  (e) => { e.preventDefault(); loadConclusions(); });
  cnLoadBtn.addEventListener("click",    () => loadConclusions());

  /* ──────────────────────────────────────────────
   *  GEO PANEL
   * ────────────────────────────────────────────── */
  const geoState = { visible: false, map: null, markers: [] };

  cnMapToggleBtn.addEventListener("click", toggleGeoPanel);

  function toggleGeoPanel() {
    geoState.visible = !geoState.visible;
    cnMapToggleBtn.setAttribute("aria-pressed", geoState.visible ? "true" : "false");
    cnMapToggleBtn.classList.toggle("active", geoState.visible);

    if (geoState.visible) {
      cnGeoPanel.classList.remove("hidden");
      requestAnimationFrame(() => { initMap(); plotMarkers(); });
    } else {
      cnGeoPanel.classList.add("hidden");
    }
  }

  function initMap() {
    if (geoState.map) { geoState.map.invalidateSize(); return; }
    if (!window.L)    { toast("Leaflet ще не завантажено", "warn"); return; }

    const map = window.L.map(cnGeoMap, { scrollWheelZoom: true });
    window.L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 19, attribution: "Tiles &copy; Esri" }
    ).addTo(map);
    map.setView([48.5, 32.5], 7);
    geoState.map = map;
  }

  function mgrsToLatLon(s) {
    if (!window.mgrs?.toPoint) return null;
    try {
      const p = window.mgrs.toPoint(String(s).replace(/\s+/g, "").toUpperCase());
      if (!Array.isArray(p) || p.length < 2) return null;
      const lon = Number(p[0]), lat = Number(p[1]);
      return (isFinite(lat) && isFinite(lon)) ? { lat, lon } : null;
    } catch (_) { return null; }
  }

  function plotMarkers() {
    if (!geoState.map) return;
    geoState.markers.forEach((m) => m.remove());
    geoState.markers = [];

    const allLL = [];
    state.view.rows.forEach((row) => {
      const color = row.type_color || "#6b7280";
      (row.mgrs || []).forEach((mgrsStr) => {
        const ll = mgrsToLatLon(mgrsStr);
        if (!ll) return;
        const latlng = window.L.latLng(ll.lat, ll.lon);
        allLL.push(latlng);

        const m = window.L.circleMarker(latlng, {
          radius:      9,
          color:       color,
          weight:      2,
          fillColor:   color,
          fillOpacity: 0.78,
        });
        m.bindTooltip(mgrsStr, { permanent: false, direction: "top" });
        m.on("click", () => showGeoInfo(row, mgrsStr));
        m.addTo(geoState.map);
        geoState.markers.push(m);
      });
    });

    if (allLL.length === 1)      geoState.map.setView(allLL[0], 13);
    else if (allLL.length > 1)   geoState.map.fitBounds(window.L.latLngBounds(allLL), { padding: [32, 32] });
    geoState.map.invalidateSize();
  }

  function showGeoInfo(row, mgrsStr) {
    const dt    = (row.created_at || "").replace("T", " ").slice(0, 16);
    const net   = [row.frequency, row.mask, row.unit].filter(Boolean).join(" / ");
    const color = row.type_color || "#6b7280";
    const body  = (row.body_text || row.conclusion_text || "").trim();

    cnGeoInfo.innerHTML = `
      <div style="margin-bottom:6px">
        <span class="cn-type-badge" style="${colorStyle(color)}">${escapeHtml(row.type_label || "невідомо")}</span>
      </div>
      <div class="cn-geo-info__dt small">${escapeHtml(dt)}</div>
      ${net ? `<div class="cn-geo-info__net small">${escapeHtml(net)}</div>` : ""}
      <div class="cn-geo-info__mgrs small">
        <strong>Координати:</strong> <code>${escapeHtml(mgrsStr)}</code>
      </div>
      <div class="cn-geo-info__body">${escapeHtml(body)}</div>
    `;
  }

  /* ──────────────────────────────────────────────
   *  НАЛАШТУВАННЯ — types CRUD
   * ────────────────────────────────────────────── */
  const typesLoader   = $("cnTypesLoader");
  const typesList     = $("cnTypesList");
  const newTypeName   = $("cnNewTypeName");
  const addTypeBtn    = $("cnAddTypeBtn");
  const addTypeErr    = $("cnAddTypeErr");
  const deleteModal      = $("cnDeleteModal");
  const deleteTypeName   = $("cnDeleteTypeName");
  const deleteConfirmBtn = $("cnDeleteConfirmBtn");

  [$("cnDeleteCancelBtn"), $("cnDeleteCancelBtn2"), $("cnDeleteBackdrop")].forEach((el) => {
    if (el) el.addEventListener("click", closeDeleteModal);
  });

  function openDeleteModal(typeId, typeName) {
    state.settings.deleteTargetId = typeId;
    deleteTypeName.textContent = typeName;
    deleteModal.classList.remove("hidden");
    deleteModal.setAttribute("aria-hidden", "false");
  }
  function closeDeleteModal() {
    state.settings.deleteTargetId = null;
    deleteModal.classList.add("hidden");
    deleteModal.setAttribute("aria-hidden", "true");
  }
  deleteConfirmBtn.addEventListener("click", async () => {
    const id = state.settings.deleteTargetId;
    if (!id) return;
    closeDeleteModal();
    await deleteType(id);
  });

  /* ─── load ─── */
  async function loadTypes() {
    state.settings.loaded = true;
    typesLoader.style.display = "";
    typesList.innerHTML = "";
    try {
      const res  = await fetch("/api/conclusions/types");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.settings.types = data.rows || [];
      typesLoader.style.display = "none";
      renderTypesList();
    } catch (err) {
      typesLoader.textContent = "Помилка завантаження: " + err.message;
    }
  }

  function renderTypesList() {
    typesList.innerHTML = "";
    state.settings.types.forEach((t) => typesList.appendChild(buildTypeCard(t)));
  }

  /* ─── type card ─── */
  function buildTypeCard(typeObj) {
    const card = document.createElement("div");
    card.className      = "cn-type-card";
    card.dataset.typeId = typeObj.id;

    const isProtected   = typeObj.id === 0;
    const cardColor     = typeObj.color || "#6b7280";

    card.innerHTML = `
      <div class="cn-type-card__head">
        <span class="cn-type-card__swatch" title="Колір типу на карті"></span>
        <input type="color" class="cn-type-color-inp" value="${escapeHtml(cardColor)}" title="Обрати колір" />
        <span class="cn-type-card__name">${escapeHtml(typeObj.type)}</span>
        ${isProtected
          ? `<span class="small" style="opacity:.5">(системний)</span>`
          : `<button type="button" class="secondary cn-type-del-btn"
               style="font-size:12px;padding:2px 8px;margin-left:auto;
                      color:var(--danger);border-color:color-mix(in srgb,var(--danger) 50%,var(--border))"
             >Видалити</button>`
        }
      </div>
      <div class="small" style="opacity:.7;margin:6px 0 4px">Ключові слова:</div>
      <div class="chips cn-type-chips" data-type-id="${typeObj.id}"></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <input type="text" class="cn-kw-input" placeholder="Додати ключове слово…"
               autocomplete="off" style="flex:1" />
        <button type="button" class="secondary cn-kw-add-btn" style="white-space:nowrap">Додати</button>
      </div>
    `;

    // Colour swatch reflects current value
    const swatch   = card.querySelector(".cn-type-card__swatch");
    const colorInp = card.querySelector(".cn-type-color-inp");
    swatch.style.background = cardColor;

    colorInp.addEventListener("input", () => {
      swatch.style.background = colorInp.value;
    });
    colorInp.addEventListener("change", async () => {
      await patchTypeColor(typeObj.id, colorInp.value, card);
    });

    // Keyword chips
    const chipsWrap = card.querySelector(".cn-type-chips");
    (typeObj.keywords || []).forEach((kw) => chipsWrap.appendChild(buildKeywordChip(kw, typeObj.id)));

    if (!isProtected) {
      card.querySelector(".cn-type-del-btn").addEventListener("click", () =>
        openDeleteModal(typeObj.id, typeObj.type)
      );
    }

    const kwInput  = card.querySelector(".cn-kw-input");
    const kwAddBtn = card.querySelector(".cn-kw-add-btn");
    function doAdd() {
      const kw = kwInput.value.trim();
      if (!kw) return;
      kwInput.value = "";
      addKeyword(typeObj.id, kw, chipsWrap);
    }
    kwAddBtn.addEventListener("click", doAdd);
    kwInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });

    return card;
  }

  /* ─── patch colour ─── */
  async function patchTypeColor(typeId, color, card) {
    const typeObj = state.settings.types.find((t) => t.id === typeId);
    if (typeObj) typeObj.color = color;
    try {
      const res = await fetch(`/api/conclusions/types/${typeId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ color }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast(d.error || "Помилка збереження кольору", "error");
      }
    } catch (err) {
      toast("Помилка: " + err.message, "error");
    }
  }

  /* ─── keyword chip ─── */
  function buildKeywordChip(kw, typeId) {
    const span = document.createElement("span");
    span.className = "chip";
    span.dataset.kw = kw;
    span.innerHTML = `<span>${escapeHtml(kw)}</span><button type="button" class="chip-x" aria-label="Видалити">×</button>`;
    span.querySelector(".chip-x").addEventListener("click", () => removeKeyword(typeId, kw, span));
    return span;
  }

  async function addKeyword(typeId, kw, chipsWrap) {
    const t = state.settings.types.find((x) => x.id === typeId);
    if (!t) return;
    if (t.keywords.includes(kw)) { toast("Таке ключове слово вже є", "warn"); return; }
    const nk = [...t.keywords, kw];
    t.keywords = nk;
    chipsWrap.appendChild(buildKeywordChip(kw, typeId));
    try {
      const res = await fetch(`/api/conclusions/types/${typeId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ keywords: nk }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast(d.error || "Помилка збереження", "error");
        t.keywords = nk.filter((k) => k !== kw);
        chipsWrap.querySelector(`.chip[data-kw="${CSS.escape(kw)}"]`)?.remove();
      }
    } catch (err) {
      toast("Помилка: " + err.message, "error");
      t.keywords = t.keywords.filter((k) => k !== kw);
      chipsWrap.querySelector(`.chip[data-kw="${CSS.escape(kw)}"]`)?.remove();
    }
  }

  async function removeKeyword(typeId, kw, chipEl) {
    const t = state.settings.types.find((x) => x.id === typeId);
    if (!t) return;
    const prev = [...t.keywords];
    t.keywords = prev.filter((k) => k !== kw);
    chipEl.remove();
    try {
      const res = await fetch(`/api/conclusions/types/${typeId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ keywords: t.keywords }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast(d.error || "Помилка збереження", "error");
        t.keywords = prev;
        const card = typesList.querySelector(`.cn-type-card[data-type-id="${typeId}"]`);
        card?.querySelector(".cn-type-chips")?.appendChild(buildKeywordChip(kw, typeId));
      }
    } catch (err) {
      toast("Помилка: " + err.message, "error");
      t.keywords = prev;
    }
  }

  /* ─── create type ─── */
  addTypeBtn.addEventListener("click", async () => {
    const name = newTypeName.value.trim();
    addTypeErr.style.display = "none";
    if (!name) { addTypeErr.textContent = "Введіть назву типу."; addTypeErr.style.display = ""; return; }
    addTypeBtn.disabled = true;
    try {
      const res  = await fetch("/api/conclusions/types", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ type: name }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        addTypeErr.textContent = data.error || "Помилка створення типу";
        addTypeErr.style.display = "";
        return;
      }
      const nt = { id: data.id, type: data.type, keywords: [], color: data.color || "" };
      state.settings.types.push(nt);
      typesList.appendChild(buildTypeCard(nt));
      newTypeName.value = "";
      toast("Тип «" + name + "» створено", "success");
      const opt = document.createElement("option");
      opt.value = data.id; opt.textContent = data.type;
      typeSel.appendChild(opt);
    } catch (err) {
      addTypeErr.textContent = "Помилка: " + err.message;
      addTypeErr.style.display = "";
    } finally { addTypeBtn.disabled = false; }
  });
  newTypeName.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTypeBtn.click(); } });

  /* ─── delete type ─── */
  async function deleteType(typeId) {
    try {
      const res  = await fetch(`/api/conclusions/types/${typeId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) { toast(data.error || "Помилка видалення", "error"); return; }
      state.settings.types = state.settings.types.filter((t) => t.id !== typeId);
      typesList.querySelector(`.cn-type-card[data-type-id="${typeId}"]`)?.remove();
      typeSel.querySelector(`option[value="${typeId}"]`)?.remove();
      toast("Тип видалено", "success");
    } catch (err) { toast("Помилка: " + err.message, "error"); }
  }

  /* ──────────────────────────────────────────────
   *  INITIAL
   * ────────────────────────────────────────────── */
  const activeBtn  = document.querySelector(".tab-btn[data-tab].active");
  const initialTab = activeBtn ? activeBtn.dataset.tab : "view";

  if (initialTab === "view") { loadNetworksForFilter(); loadTypesForFilter(); }
  else if (initialTab === "settings") loadTypes();

})();
