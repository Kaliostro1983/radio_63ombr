/**
 * conclusions.js — Висновки page (v4 / map icons).
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
      types:    [],   // [{id, type, color, delta_*}] — loaded for type picker
      rows:     [],   // last loaded conclusion rows
    },
    settings: {
      loaded:        false,
      types:         [],
      deleteTargetId: null,
    },
  };

  /* Delta modal state */
  let _deltaModalRow = null;

  /* ──────────────────────────────────────────────
   *  CONCLUSION TEXT FORMATTER
   *  - strips leading location-prefix lines (ALL-CAPS or in parentheses)
   *  - returns cleaned text (coordinates already stripped by parser)
   * ────────────────────────────────────────────── */
  function formatConclusion(text) {
    if (!text) return "";
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l);
    // Strip leading lines that are location names:
    //   ALL-CAPS: no lowercase letters + at least 2 uppercase Ukrainian letters
    //   Parenthesised: entire line wrapped in ( ... )
    let start = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      const isAllCaps  = !/[а-яіїєґa-z]/.test(line) && /[А-ЯІЇЄҐ]{2}/.test(line);
      const isInParens = /^\(.+\)$/.test(line);
      if (isAllCaps || isInParens) { start = i + 1; }
      else { break; }
    }
    return lines.slice(start).join(" ").trim();
  }

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
   *  TYPE FILTER (select) + type-picker data
   * ────────────────────────────────────────────── */
  async function loadTypesForFilter() {
    try {
      const res  = await fetch("/api/conclusions/types");
      if (!res.ok) return;
      const data = await res.json();
      state.view.types = data.rows || [];
      state.view.types.forEach((t) => {
        const opt = document.createElement("option");
        opt.value       = t.id;
        opt.textContent = t.type || "невідомо";
        typeSel.appendChild(opt);
      });
    } catch (_) { /* silent */ }
    // Ensure chat from localStorage is persisted to server for auto-send
    syncChatToServer();
  }

  /** Refresh only the types color/name cache — no DOM changes to the filter select. */
  async function refreshTypesCache() {
    try {
      const res = await fetch("/api/conclusions/types");
      if (!res.ok) return;
      const data = await res.json();
      state.view.types = data.rows || [];
    } catch (_) { /* silent */ }
  }

  /**
   * Ensure the current chat (from localStorage) is persisted to the server.
   * Called on every page load so that auto-send works even if the user never
   * opens the Settings tab.
   */
  async function syncChatToServer() {
    if (!cnSettingsChatId) return;          // nothing to sync
    try {
      const res  = await fetch("/api/settings?keys=delta_chat_id");
      if (!res.ok) return;
      const data = await res.json();
      const srvChatId = (data.settings || {}).delta_chat_id || "";
      if (!srvChatId) {
        // Server doesn't have the chat — push from localStorage
        await saveAppSettings({
          delta_chat_id:   cnSettingsChatId,
          delta_chat_name: cnSettingsChatName,
          delta_platform:  cnSettingsPlatform,
        });
      }
    } catch (_) { /* best-effort */ }
  }

  /* ──────────────────────────────────────────────
   *  TYPE PICKER DROPDOWN
   * ────────────────────────────────────────────── */
  const typePicker    = $("cnTypePicker");
  let   _pickerBadge  = null;   // badge element currently being edited

  function openTypePicker(badge) {
    if (_pickerBadge === badge) { closeTypePicker(); return; }
    _pickerBadge = badge;

    // Build items: "невідомо" (id=0) + all user types
    const items = [
      { id: 0, type: "невідомо", color: "#6b7280" },
      ...state.view.types.filter((t) => t.id !== 0),
    ];

    typePicker.innerHTML = items.map((t) => `
      <div class="cn-type-picker-item" data-type-id="${t.id}" style="${colorStyle(t.color || "#6b7280")}">
        ${escapeHtml(t.type || "невідомо")}
      </div>
    `).join("");

    typePicker.querySelectorAll(".cn-type-picker-item").forEach((el) =>
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        applyTypeFromPicker(parseInt(el.dataset.typeId, 10));
      })
    );

    // Position below the badge (position:fixed → viewport coords, no scroll offset).
    // Falls back to opening upward if there is not enough room below.
    const rect    = badge.getBoundingClientRect();
    typePicker.classList.remove("hidden");          // unhide so dimensions are available
    const pickerW = typePicker.offsetWidth  || 180;
    const pickerH = typePicker.offsetHeight || 200;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const topPos  = spaceBelow >= pickerH
      ? (rect.bottom + 4)
      : Math.max(4, rect.top - pickerH - 4);
    typePicker.style.top  = topPos + "px";
    typePicker.style.left = Math.min(rect.left, window.innerWidth - pickerW - 8) + "px";
  }

  function closeTypePicker() {
    typePicker.classList.add("hidden");
    _pickerBadge = null;
  }

  document.addEventListener("click", (e) => {
    if (!_pickerBadge) return;
    if (!typePicker.contains(e.target) && !e.target.closest(".cn-type-badge--pick")) {
      closeTypePicker();
    }
  });

  async function applyTypeFromPicker(typeId) {
    const badge  = _pickerBadge;
    const tr     = badge?.closest("tr");
    const acId   = tr ? parseInt(tr.dataset.acId, 10) : null;
    closeTypePicker();
    if (!acId) return;

    try {
      const res  = await fetch(`/api/conclusions/${acId}/type`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ type_id: typeId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { toast(data.error || "Помилка збереження типу", "error"); return; }
      updateBadge(tr, data.type_id, data.type_label, data.type_color);
    } catch (err) { toast("Помилка: " + err.message, "error"); }
  }

  /* ──────────────────────────────────────────────
   *  RE-CLASSIFY (keyword matching)
   * ────────────────────────────────────────────── */
  async function reclassifyConclusion(btn) {
    const tr   = btn.closest("tr");
    const acId = tr ? parseInt(tr.dataset.acId, 10) : null;
    if (!acId) return;

    btn.textContent = "⏳";
    btn.disabled    = true;
    try {
      const res  = await fetch(`/api/conclusions/${acId}/reclassify`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) { toast(data.error || "Помилка", "error"); return; }
      updateBadge(tr, data.type_id, data.type_label, data.type_color);
      toast("Тип оновлено: " + (data.type_label || "невідомо"), "success", 2000);
    } catch (err) { toast("Помилка: " + err.message, "error"); }
    finally { btn.textContent = "♻"; btn.disabled = false; }
  }

  function updateBadge(tr, typeId, typeLabel, typeColor) {
    const badge = tr?.querySelector(".cn-type-badge--pick");
    if (!badge) return;
    badge.textContent        = typeLabel || "невідомо";
    badge.dataset.typeId     = typeId;
    badge.style.cssText      = colorStyle(typeColor || "#6b7280");
  }

  /* ──────────────────────────────────────────────
   *  DELTA MODAL
   * ────────────────────────────────────────────── */
  async function openDeltaModal(row) {
    _deltaModalRow = row;

    // Lazy-load delta type options if not yet populated
    if (!_deltaTypeOptions.length) {
      await loadDeltaTypeOptions();
    }

    const typeObj = state.view.types.find((t) => t.id === row.type_id) || {};

    // Populate Тип select
    const cdmType = $("cdmType");
    if (cdmType) {
      const currentType = typeObj.delta_type || (_deltaTypeOptions[0] && _deltaTypeOptions[0].value) || "";
      cdmType.innerHTML = _deltaTypeOptions.map((opt) =>
        `<option value="${escapeHtml(opt.value)}"${opt.value === currentType ? " selected" : ""}>${escapeHtml(opt.value)}</option>`
      ).join("");
      if (!cdmType.value && currentType) {
        // if no option matched, add one
        const fb = document.createElement("option");
        fb.value = currentType; fb.textContent = currentType; fb.selected = true;
        cdmType.prepend(fb);
      }
    }

    // Ідентифікація
    const cdmIdent = $("cdmIdent");
    if (cdmIdent) cdmIdent.value = typeObj.delta_identification || "Ворожий";

    // Джерело
    const cdmSource = $("cdmSource");
    if (cdmSource) cdmSource.value = typeObj.delta_source || "Радіорозвідка (РР)";

    // Присутність
    const cdmPresence = $("cdmPresence");
    if (cdmPresence) cdmPresence.value = typeObj.delta_presence || "присутній";

    // Назва — pre-fill from frequency
    const cdmName = $("cdmName");
    if (cdmName) cdmName.value = row.frequency || "";

    // Підрозділ — pre-fill from unit
    const cdmUnit = $("cdmUnit");
    if (cdmUnit) cdmUnit.value = row.unit || "";

    // Час виявлення — convert "2026-05-25 09:58:42" → datetime-local "2026-05-25T09:58"
    const cdmDatetime = $("cdmDatetime");
    if (cdmDatetime) {
      const raw = (row.created_at || "").replace(" ", "T");
      cdmDatetime.value = raw.slice(0, 16);
    }

    // Радіус дії — empty by default
    const cdmRadius = $("cdmRadius");
    if (cdmRadius) cdmRadius.value = "";

    // MGRS — compact (no spaces), comma-separated
    const cdmMgrs = $("cdmMgrs");
    if (cdmMgrs) {
      cdmMgrs.value = (row.mgrs || []).map((m) => m.replace(/\s+/g, "")).join(", ");
    }

    const modal = $("cnDeltaModal");
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeDeltaModal() {
    _deltaModalRow = null;
    const modal = $("cnDeltaModal");
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }

  async function sendDeltaReport() {
    if (!_deltaModalRow) return;

    const type      = $("cdmType")?.value?.trim()     || "";
    const name      = $("cdmName")?.value?.trim()     || "";
    const ident     = $("cdmIdent")?.value            || "";
    const unit      = $("cdmUnit")?.value?.trim()     || "";
    const source    = $("cdmSource")?.value           || "";
    const presence  = $("cdmPresence")?.value         || "";
    const dtRaw     = $("cdmDatetime")?.value         || "";
    const radius    = $("cdmRadius")?.value?.trim()   || "";
    const mgrs      = $("cdmMgrs")?.value?.trim()     || "";

    // Format datetime-local "2026-05-25T09:58" → "25.05.2026 09:58:00"
    let dtFmt = "";
    if (dtRaw) {
      const [datePart, timePart] = dtRaw.split("T");
      if (datePart && timePart) {
        const [y, mo, d] = datePart.split("-");
        dtFmt = `${d}.${mo}.${y} ${timePart}:00`;
      }
    }

    const lines = [];
    if (type)    lines.push(`Тип: ${type}`);
    if (name)    lines.push(`Назва: ${name}`);
    if (ident)   lines.push(`Ідентифікація: ${ident}`);
    if (unit)    lines.push(`Підрозділ: ${unit}`);
    if (presence) lines.push(`Присутність: ${presence}`);
    if (source)  lines.push(`Джерело: ${source}`);
    if (dtFmt)   lines.push(`Час виявлення: ${dtFmt}`);
    if (radius)  lines.push(`Радіус дії: ${radius}`);
    if (mgrs)    lines.push(`MGRS: ${mgrs}`);

    const conclusion = (_deltaModalRow.conclusion_text || "").trim();
    const body       = (_deltaModalRow.body_text       || "").trim();
    const text       = [lines.join("\n"), conclusion, body].filter(Boolean).join("\n\n");

    if (!cnSettingsChatId) {
      toast("Оберіть цільовий чат у вкладці «Налаштування»", "warn");
      return;
    }

    const sendBtn = $("cnDeltaSendBtn");
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = "…"; }

    try {
      const res = await fetch("/api/push/send", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          platform: cnSettingsPlatform,
          chat_id:  cnSettingsChatId,
          text,
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok) {
        toast("Дельта-звіт надіслано", "success");
        // Persist chat to server so auto-send can use it
        saveAppSettings({
          delta_chat_id:   cnSettingsChatId,
          delta_chat_name: cnSettingsChatName,
          delta_platform:  cnSettingsPlatform,
        });
        // Mark sended in DB + update button in table
        const rowId = _deltaModalRow.id;
        fetch(`/api/conclusions/${rowId}/mark-sended`, { method: "POST" }).catch(() => {});
        const rowObj = state.view.rows.find((r) => r.id === rowId);
        if (rowObj) rowObj.sended = 1;
        const tr = cnTableBody.querySelector(`tr[data-ac-id="${rowId}"]`);
        const dBtn = tr?.querySelector(".cn-delta-btn");
        if (dBtn) {
          dBtn.className = "cn-delta-btn cn-delta-btn--on";
          dBtn.title = "Дельта-звіт надіслано";
        }
        closeDeltaModal();
      } else {
        toast(d.error || "Помилка надсилання", "error");
      }
    } catch (err) {
      toast("Помилка: " + err.message, "error");
    } finally {
      if (sendBtn) { sendBtn.disabled = false; sendBtn.innerHTML = "&#10148; Надіслати"; }
    }
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
        const conclusionFmt = escapeHtml(formatConclusion(r.conclusion_text || ""));
        const interceptHtml = r.body_text
          ? `<div class="cn-intercept-cell">${escapeHtml(r.body_text)}</div>`
          : `<span style="opacity:.4">—</span>`;

        // Delta button: gray = already sent, red = not yet sent
        const deltaBtnClass = r.sended ? "cn-delta-btn--on" : "cn-delta-btn--off";
        const deltaBtnTitle = r.sended ? "Дельта-звіт надіслано" : "Надіслати Дельта-звіт";

        return `<tr data-ac-id="${r.id}">
          <td style="text-align:center">
            <div class="small" style="font-weight:600;white-space:nowrap">${escapeHtml(dateP)} ${escapeHtml(timeP)}</div>
            ${net ? `<div class="small" style="opacity:.65;margin-top:2px;white-space:nowrap">${escapeHtml(net)}</div>` : ""}
          </td>
          <td style="text-align:center">
            <span class="cn-type-badge cn-type-badge--pick"
                  data-type-id="${r.type_id}"
                  style="${colorStyle(color)}"
                  title="Клікніть щоб змінити тип">${escapeHtml(r.type_label || "невідомо")}</span>
          </td>
          <td class="small">${conclusionFmt}</td>
          <td>${interceptHtml}</td>
          <td style="text-align:center">${mgrs || "<span style='opacity:.4'>—</span>"}</td>
          <td style="text-align:center;white-space:nowrap">
            <button class="cn-reclassify-btn" title="Повторно проаналізувати тип">♻</button>
            <button class="cn-delta-btn ${deltaBtnClass}" title="${deltaBtnTitle}">⊡</button>
          </td>
        </tr>`;
      }).join("");

      // Event delegation: type picker + reclassify + delta
      cnTableBody.onclick = (e) => {
        const badge = e.target.closest(".cn-type-badge--pick");
        if (badge) { openTypePicker(badge); return; }
        const reBtn = e.target.closest(".cn-reclassify-btn");
        if (reBtn) { reclassifyConclusion(reBtn); return; }
        const deltaBtn = e.target.closest(".cn-delta-btn");
        if (deltaBtn) {
          const tr  = deltaBtn.closest("tr");
          const acId = tr ? parseInt(tr.dataset.acId, 10) : null;
          if (acId) {
            const row = state.view.rows.find((r) => r.id === acId);
            if (row) openDeltaModal(row);
          }
        }
      };

      cnTable.style.display = "";
      if (geoState.visible) plotMarkers();
      refreshTypesCache();   // keep colour data fresh for the type picker

    } catch (err) {
      cnLoader.style.display = "none";
      cnEmptyMsg.textContent = "Помилка завантаження: " + err.message;
      cnEmptyMsg.style.display = "";
      cnCountVal.textContent   = "—";
    }
  }

  filterForm.addEventListener("submit",  (e) => { e.preventDefault(); loadConclusions(); });

  /* ──────────────────────────────────────────────
   *  GEO PANEL
   * ────────────────────────────────────────────── */
  const geoState = { visible: false, map: null, markers: [] };

  cnMapToggleBtn.addEventListener("click", toggleGeoPanel);

  // Full-map button — opens /conclusions/map in a new tab with current filters
  const cnFullMapBtn = $("cnFullMapBtn");
  if (cnFullMapBtn) {
    cnFullMapBtn.addEventListener("click", () => {
      const qs = new URLSearchParams();
      if (dateFrom.value)   qs.set("date_from",  dateFrom.value);
      if (dateTo.value)     qs.set("date_to",    dateTo.value);
      if (networkId.value)  qs.set("network_id", networkId.value);
      window.open("/conclusions/map?" + qs.toString(), "_blank");
    });
  }

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
   *  НАЛАШТУВАННЯ — Settings chat selector (Delta target)
   * ────────────────────────────────────────────── */
  let cnSettingsPlatform = localStorage.getItem("cnSettingsPlatform") || "whatsapp";
  let cnSettingsChatId   = localStorage.getItem("cnSettingsChatId")   || "";
  let cnSettingsChatName = localStorage.getItem("cnSettingsChatName") || "";
  let _cnSettingsChatsCache = {};  // { platform: [...] }
  let _deltaTypeOptions = [];      // shared list loaded once

  /** Persist key-value pairs to server app_settings */
  async function saveAppSettings(pairs) {
    try {
      await fetch("/api/settings", {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(pairs),
      });
    } catch (_) { /* best-effort */ }
  }

  function cnSettingsSavePlatform(p) {
    cnSettingsPlatform = p;
    localStorage.setItem("cnSettingsPlatform", p);
    saveAppSettings({ delta_platform: p });
  }
  function cnSettingsSaveChat(id, name) {
    cnSettingsChatId   = id;   cnSettingsChatName = name;
    localStorage.setItem("cnSettingsChatId",   id);
    localStorage.setItem("cnSettingsChatName", name);
    saveAppSettings({ delta_chat_id: id, delta_chat_name: name });
  }
  function updateCnSettingsPlatformBtn() {
    const btn = $("cnSettingsPlatformBtn");
    if (!btn) return;
    if (cnSettingsPlatform === "signal") {
      btn.textContent = "S"; btn.className = "qc-platform-btn qc-platform-btn--signal";
      btn.title = "Signal (натисни для WhatsApp)";
    } else {
      btn.textContent = "W"; btn.className = "qc-platform-btn qc-platform-btn--wa";
      btn.title = "WhatsApp (натисни для Signal)";
    }
  }
  async function cnSettingsLoadChats(platform) {
    if (_cnSettingsChatsCache[platform]) return _cnSettingsChatsCache[platform];
    try {
      const r = await fetch("/api/push/chats?platform=" + platform + "&only_groups=1");
      const d = await r.json();
      if (d.ok && Array.isArray(d.chats)) { _cnSettingsChatsCache[platform] = d.chats; return d.chats; }
    } catch (_) {}
    return [];
  }
  function renderCnSettingsChatDrop(chats, query) {
    const drop = $("cnSettingsChatDrop");
    if (!drop) return;
    const q = (query || "").toLowerCase();
    const filtered = q ? chats.filter(c => c.name.toLowerCase().includes(q)) : chats;
    if (!filtered.length) { drop.classList.add("hidden"); return; }
    drop.innerHTML = "";
    filtered.slice(0, 40).forEach(chat => {
      const item = document.createElement("div");
      item.className = "qc-chat-drop-item";
      item.innerHTML = `<span>${escapeHtml(chat.name)}</span><span class="qc-chat-drop-item__type">група</span>`;
      item.addEventListener("mousedown", e => {
        e.preventDefault();
        const inp = $("cnSettingsChatInput");
        if (inp) inp.value = chat.name;
        cnSettingsSaveChat(chat.id, chat.name);
        drop.classList.add("hidden");
      });
      drop.appendChild(item);
    });
    drop.classList.remove("hidden");
  }
  function setupCnSettingsChatSelector() {
    const input = $("cnSettingsChatInput");
    const drop  = $("cnSettingsChatDrop");
    const platBtn = $("cnSettingsPlatformBtn");
    if (!input) return;
    updateCnSettingsPlatformBtn();
    if (cnSettingsChatName) input.value = cnSettingsChatName;

    if (platBtn) platBtn.addEventListener("click", () => {
      cnSettingsSavePlatform(cnSettingsPlatform === "whatsapp" ? "signal" : "whatsapp");
      updateCnSettingsPlatformBtn();
      cnSettingsChatId = ""; cnSettingsChatName = "";
      localStorage.removeItem("cnSettingsChatId"); localStorage.removeItem("cnSettingsChatName");
      if (input) input.value = "";
      _cnSettingsChatsCache = {};
      cnSettingsLoadChats(cnSettingsPlatform);
    });

    input.addEventListener("focus", async () => {
      const chats = await cnSettingsLoadChats(cnSettingsPlatform);
      renderCnSettingsChatDrop(chats, input.value);
    });
    input.addEventListener("input", async () => {
      if (input.value !== cnSettingsChatName) { cnSettingsChatId = ""; cnSettingsChatName = input.value; }
      const chats = await cnSettingsLoadChats(cnSettingsPlatform);
      renderCnSettingsChatDrop(chats, input.value);
    });
    input.addEventListener("blur", () => {
      setTimeout(() => drop && drop.classList.add("hidden"), 160);
    });
    input.addEventListener("keydown", e => {
      if (!drop || drop.classList.contains("hidden")) return;
      const items = drop.querySelectorAll(".qc-chat-drop-item");
      const focused = drop.querySelector(".qc-chat-drop-item.focused");
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!focused) items[0]?.classList.add("focused");
        else { focused.classList.remove("focused"); (focused.nextElementSibling || items[0])?.classList.add("focused"); }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!focused) items[items.length-1]?.classList.add("focused");
        else { focused.classList.remove("focused"); (focused.previousElementSibling || items[items.length-1])?.classList.add("focused"); }
      } else if (e.key === "Enter" && focused) {
        e.preventDefault(); focused.dispatchEvent(new MouseEvent("mousedown"));
      } else if (e.key === "Escape") drop.classList.add("hidden");
    });

    cnSettingsLoadChats(cnSettingsPlatform);
  }

  /* Load delta type options (global, shared list) */
  async function loadDeltaTypeOptions() {
    try {
      const r = await fetch("/api/delta/type-options");
      const d = await r.json();
      _deltaTypeOptions = d.ok ? (d.rows || []) : [];
    } catch (_) { _deltaTypeOptions = []; }
  }

  /* Available SVG icons for map markers (loaded once when Settings tab opens) */
  let _availableIcons = [];
  async function loadAvailableIcons() {
    if (_availableIcons.length) return;
    try {
      const r = await fetch("/api/conclusions/icons");
      const d = await r.json();
      _availableIcons = d.ok ? (d.icons || []) : [];
    } catch (_) { _availableIcons = []; }
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
      await Promise.all([loadDeltaTypeOptions(), loadAvailableIcons()]);
      const [typesRes, settingsRes] = await Promise.all([
        fetch("/api/conclusions/types"),
        fetch("/api/settings?keys=delta_send_enabled,delta_chat_id,delta_platform,delta_chat_name"),
      ]);
      if (!typesRes.ok) throw new Error(`HTTP ${typesRes.status}`);
      const data = await typesRes.json();
      state.settings.types = data.rows || [];

      // Apply server-side settings
      if (settingsRes.ok) {
        const sData = await settingsRes.json();
        const srv   = sData.settings || {};

        // delta_send_enabled
        const chk = $("cnDeltaSendEnabled");
        if (chk) chk.checked = (srv.delta_send_enabled ?? "1") === "1";

        // Bidirectional sync:
        //   • server has value  → push to localStorage
        //   • localStorage has value, server is empty → push to server
        if (srv.delta_chat_id) {
          cnSettingsChatId   = srv.delta_chat_id;
          cnSettingsChatName = srv.delta_chat_name || "";
          localStorage.setItem("cnSettingsChatId",   cnSettingsChatId);
          localStorage.setItem("cnSettingsChatName", cnSettingsChatName);
        } else if (cnSettingsChatId) {
          // localStorage has a chat that server doesn't know about yet — sync up
          saveAppSettings({
            delta_chat_id:   cnSettingsChatId,
            delta_chat_name: cnSettingsChatName,
            delta_platform:  cnSettingsPlatform,
          });
        }
        if (srv.delta_platform) {
          cnSettingsPlatform = srv.delta_platform;
          localStorage.setItem("cnSettingsPlatform", cnSettingsPlatform);
        } else if (cnSettingsPlatform) {
          saveAppSettings({ delta_platform: cnSettingsPlatform });
        }
      }

      typesLoader.style.display = "none";
      renderTypesList();
      setupCnSettingsChatSelector();
      setupDeltaSendEnabledCheckbox();
    } catch (err) {
      typesLoader.textContent = "Помилка завантаження: " + err.message;
    }
  }

  function setupDeltaSendEnabledCheckbox() {
    const chk = $("cnDeltaSendEnabled");
    if (!chk) return;
    chk.addEventListener("change", () => {
      saveAppSettings({ delta_send_enabled: chk.checked ? "1" : "0" });
    });
  }

  let _dragDropSetUp = false;
  function renderTypesList() {
    typesList.innerHTML = "";
    state.settings.types.forEach((t) => typesList.appendChild(buildTypeCard(t)));
    if (!_dragDropSetUp) { setupTypeDragDrop(); _dragDropSetUp = true; }
  }

  /* ─── drag-and-drop reorder ─── */
  let _dragSrc = null;

  function setupTypeDragDrop() {
    typesList.addEventListener("dragstart", (e) => {
      const card = e.target.closest(".cn-type-card[draggable='true']");
      if (!card) { e.preventDefault(); return; }
      _dragSrc = card;
      card.classList.add("cn-card-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", card.dataset.typeId);
    });

    typesList.addEventListener("dragend", () => {
      typesList.querySelectorAll(".cn-type-card").forEach((c) =>
        c.classList.remove("cn-card-dragging", "cn-card-over")
      );
      _dragSrc = null;
    });

    typesList.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const card = e.target.closest(".cn-type-card[draggable='true']");
      if (!card || card === _dragSrc) return;
      typesList.querySelectorAll(".cn-type-card").forEach((c) => c.classList.remove("cn-card-over"));
      card.classList.add("cn-card-over");
    });

    typesList.addEventListener("dragleave", (e) => {
      if (!typesList.contains(e.relatedTarget)) {
        typesList.querySelectorAll(".cn-type-card").forEach((c) => c.classList.remove("cn-card-over"));
      }
    });

    typesList.addEventListener("drop", (e) => {
      e.preventDefault();
      const target = e.target.closest(".cn-type-card[draggable='true']");
      if (!target || !_dragSrc || target === _dragSrc) return;

      // Insert in DOM
      const allCards = [...typesList.querySelectorAll(".cn-type-card")];
      const srcIdx = allCards.indexOf(_dragSrc);
      const tgtIdx = allCards.indexOf(target);
      if (srcIdx < tgtIdx) typesList.insertBefore(_dragSrc, target.nextSibling);
      else                 typesList.insertBefore(_dragSrc, target);

      // Sync state array order
      const srcId = parseInt(_dragSrc.dataset.typeId, 10);
      const srcType = state.settings.types.find((t) => t.id === srcId);
      if (srcType) {
        state.settings.types = state.settings.types.filter((t) => t.id !== srcId);
        const newOrder = [...typesList.querySelectorAll(".cn-type-card[draggable='true']")];
        const newIdx   = newOrder.indexOf(_dragSrc);
        // Insert after the protected card(s) at front of state
        const protectedCount = state.settings.types.filter((t) => t.id === 0).length;
        state.settings.types.splice(protectedCount + newIdx, 0, srcType);
      }

      saveTypeOrder();
    });
  }

  async function saveTypeOrder() {
    const cards = [...typesList.querySelectorAll(".cn-type-card[draggable='true']")];
    const order = cards.map((c, i) => ({
      id:         parseInt(c.dataset.typeId, 10),
      sort_order: i + 1,   // 1-based; id=0 keeps sort_order=0 (always first)
    }));
    // Update state
    order.forEach(({ id, sort_order }) => {
      const t = state.settings.types.find((x) => x.id === id);
      if (t) t.sort_order = sort_order;
    });
    try {
      const res = await fetch("/api/conclusions/types/order", {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(order),
      });
      if (!res.ok) toast("Помилка збереження порядку", "error");
    } catch (err) {
      toast("Помилка: " + err.message, "error");
    }
  }

  /* ─── type card ─── */
  function buildTypeCard(typeObj) {
    const card = document.createElement("div");
    card.className      = "cn-type-card";
    card.dataset.typeId = typeObj.id;

    const isProtected   = typeObj.id === 0;
    const cardColor     = typeObj.color || "#6b7280";

    if (!isProtected) card.draggable = true;

    // Build Delta "Тип" options
    const dtypeOptionsHtml = _deltaTypeOptions.map(opt =>
      `<option value="${escapeHtml(opt.value)}"${opt.value === typeObj.delta_type ? " selected" : ""}>${escapeHtml(opt.value)}</option>`
    ).join("");

    // Build icon options
    const iconOptionsHtml = [
      `<option value="">— без іконки (за замовчуванням) —</option>`,
      ..._availableIcons.map(f =>
        `<option value="${escapeHtml(f)}"${f === typeObj.icon_filename ? " selected" : ""}>${escapeHtml(f)}</option>`
      )
    ].join("");

    card.innerHTML = `
      <div class="cn-type-card__head">
        ${isProtected ? "" : `<span class="cn-drag-handle" title="Перетягнути для зміни порядку">⠿</span>`}
        <span class="cn-type-card__swatch" title="Колір типу на карті"></span>
        <input type="color" class="cn-type-color-inp" value="${escapeHtml(cardColor)}" title="Обрати колір" draggable="false" />
        <span class="cn-type-card__name">${escapeHtml(typeObj.type)}</span>
        ${isProtected
          ? `<span class="small" style="opacity:.5">(системний)</span>`
          : `<button type="button" class="secondary cn-type-del-btn"
               style="font-size:12px;padding:2px 8px;margin-left:auto;
                      color:var(--danger);border-color:color-mix(in srgb,var(--danger) 50%,var(--border))"
             >Видалити</button>`
        }
      </div>

      <!-- Icon selector -->
      <div style="display:flex;align-items:center;gap:8px;margin:6px 0 2px">
        <span class="small" style="opacity:.7;white-space:nowrap">Іконка на карті:</span>
        <select class="cn-icon-sel" style="flex:1;font-size:12px;padding:2px 6px">${iconOptionsHtml}</select>
        <img class="cn-icon-preview" src="${typeObj.icon_filename ? `/static/icons/${escapeHtml(typeObj.icon_filename)}` : '/static/icons/default.svg'}"
             width="22" height="22" style="flex-shrink:0;opacity:.85" alt="" />
      </div>

      <div class="small" style="opacity:.7;margin:6px 0 4px">Ключові слова:</div>
      <div class="chips cn-type-chips" data-type-id="${typeObj.id}"></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
        <input type="text" class="cn-kw-input" placeholder="Додати ключове слово…"
               autocomplete="off" style="flex:1" />
        <button type="button" class="secondary cn-kw-add-btn" style="white-space:nowrap">Додати</button>
      </div>

      <!-- Delta section -->
      <div class="cn-delta-section">
        <div class="cn-delta-head">
          <strong class="small">Дельта</strong>
          <label class="cn-delta-autosend-label">
            <input type="checkbox" class="cn-delta-autosend-chk" ${typeObj.delta_auto_send ? "checked" : ""} />
            <span class="small">Автоматично надсилати</span>
          </label>
        </div>
        <div class="cn-delta-fields">
          <div class="cn-delta-field">
            <span class="cn-delta-field__label small">Тип</span>
            <div class="cn-delta-type-wrap">
              <select class="cn-delta-sel cn-delta-type-sel">${dtypeOptionsHtml}</select>
              <input type="text" class="cn-delta-add-inp" placeholder="Новий варіант…" autocomplete="off" />
              <button type="button" class="secondary cn-delta-add-btn" style="white-space:nowrap;padding:3px 10px">+</button>
            </div>
          </div>
          <div class="cn-delta-field">
            <span class="cn-delta-field__label small">Ідентифікація</span>
            <select class="cn-delta-sel cn-delta-identification-sel">
              ${["Ворожий","Дружній","Невідомий"].map(v =>
                `<option${v === typeObj.delta_identification ? " selected" : ""}>${escapeHtml(v)}</option>`
              ).join("")}
            </select>
          </div>
          <div class="cn-delta-field">
            <span class="cn-delta-field__label small">Джерело</span>
            <select class="cn-delta-sel cn-delta-source-sel">
              ${["Радіорозвідка (РР)"].map(v =>
                `<option${v === typeObj.delta_source ? " selected" : ""}>${escapeHtml(v)}</option>`
              ).join("")}
            </select>
          </div>
          <div class="cn-delta-field">
            <span class="cn-delta-field__label small">Присутність</span>
            <select class="cn-delta-sel cn-delta-presence-sel">
              ${["присутній","очікуваний, імовірний"].map(v =>
                `<option${v === typeObj.delta_presence ? " selected" : ""}>${escapeHtml(v)}</option>`
              ).join("")}
            </select>
          </div>
        </div>
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

    // ── Icon selector handler ──
    const iconSel     = card.querySelector(".cn-icon-sel");
    const iconPreview = card.querySelector(".cn-icon-preview");
    if (iconSel && iconPreview) {
      iconSel.addEventListener("change", () => {
        const fn = iconSel.value;
        iconPreview.src = fn ? `/static/icons/${fn}` : "/static/icons/default.svg";
        patchTypeIcon(typeObj.id, fn);
      });
    }

    // ── Delta section handlers ──
    const deltaSection      = card.querySelector(".cn-delta-section");
    const autoSendChk       = card.querySelector(".cn-delta-autosend-chk");
    const typeSel           = card.querySelector(".cn-delta-type-sel");
    const identSel          = card.querySelector(".cn-delta-identification-sel");
    const sourceSel         = card.querySelector(".cn-delta-source-sel");
    const presenceSel       = card.querySelector(".cn-delta-presence-sel");
    const deltaAddInp       = card.querySelector(".cn-delta-add-inp");
    const deltaAddBtn       = card.querySelector(".cn-delta-add-btn");

    async function saveDelta() {
      const payload = {
        delta_auto_send:      autoSendChk ? autoSendChk.checked : true,
        delta_type:           typeSel ? typeSel.value : "",
        delta_identification: identSel ? identSel.value : "",
        delta_source:         sourceSel ? sourceSel.value : "",
        delta_presence:       presenceSel ? presenceSel.value : "",
      };
      try {
        const res = await fetch(`/api/conclusions/types/${typeObj.id}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) { const d = await res.json().catch(() => ({})); toast(d.error || "Помилка збереження Дельта", "error"); }
      } catch (err) { toast("Помилка: " + err.message, "error"); }
    }

    if (autoSendChk) autoSendChk.addEventListener("change", saveDelta);
    if (typeSel)     typeSel.addEventListener("change", saveDelta);
    if (identSel)    identSel.addEventListener("change", saveDelta);
    if (sourceSel)   sourceSel.addEventListener("change", saveDelta);
    if (presenceSel) presenceSel.addEventListener("change", saveDelta);

    // Add new "Тип" option
    async function addDeltaTypeOption() {
      const val = deltaAddInp ? deltaAddInp.value.trim() : "";
      if (!val) return;
      const res = await fetch("/api/delta/type-options", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: val }),
      });
      const d = await res.json();
      if (!d.ok) { toast(d.error || "Помилка", "error"); return; }
      // Add to global cache + all visible selects
      _deltaTypeOptions.push({ id: d.id, value: val });
      document.querySelectorAll(".cn-delta-type-sel").forEach(sel => {
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = val;
        sel.appendChild(opt);
      });
      if (deltaAddInp) deltaAddInp.value = "";
      toast("Додано", "info", 1200);
    }
    if (deltaAddBtn) deltaAddBtn.addEventListener("click", addDeltaTypeOption);
    if (deltaAddInp) deltaAddInp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); addDeltaTypeOption(); } });

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

  /* ─── patch icon ─── */
  async function patchTypeIcon(typeId, iconFilename) {
    const typeObj = state.settings.types.find((t) => t.id === typeId);
    if (typeObj) typeObj.icon_filename = iconFilename;
    try {
      const res = await fetch(`/api/conclusions/types/${typeId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ icon_filename: iconFilename }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast(d.error || "Помилка збереження іконки", "error");
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
   *  DELTA MODAL WIRING
   * ────────────────────────────────────────────── */
  [$("cnDeltaCloseBtn"), $("cnDeltaCancelBtn"), $("cnDeltaBackdrop")].forEach((el) => {
    if (el) el.addEventListener("click", closeDeltaModal);
  });
  const cnDeltaSendBtn = $("cnDeltaSendBtn");
  if (cnDeltaSendBtn) cnDeltaSendBtn.addEventListener("click", sendDeltaReport);

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _deltaModalRow) closeDeltaModal();
  });

  /* ──────────────────────────────────────────────
   *  INITIAL
   * ────────────────────────────────────────────── */
  const activeBtn  = document.querySelector(".tab-btn[data-tab].active");
  const initialTab = activeBtn ? activeBtn.dataset.tab : "view";

  if (initialTab === "view") { loadNetworksForFilter(); loadTypesForFilter(); }
  else if (initialTab === "settings") loadTypes();

})();
