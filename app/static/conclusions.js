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

  /** Fill empty numbered rows ("1.", "2.", …) with MGRS points in document order.
   *  Used when building the Delta post text so an analytical conclusion's route
   *  numbering shows the actual coordinates instead of bare digits. */
  function _fillRoutePoints(text, mgrsList) {
    if (!text || !mgrsList || !mgrsList.length) return text;
    const points = mgrsList
      .map((m) => String(m || "").replace(/\s+/g, ""))
      .filter(Boolean);
    if (!points.length) return text;
    const re = /^(\s*\d+\.)\s*$/;
    const lines = text.split("\n");
    let idx = 0;
    for (let i = 0; i < lines.length && idx < points.length; i++) {
      const m = lines[i].match(re);
      if (m) {
        lines[i] = `${m[1]} ${points[idx]}`;
        idx++;
      }
    }
    return lines.join("\n");
  }
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
   *  TAB / MODAL SWITCHING
   *  Налаштування винесено в модалку; Перегляд — основний контент.
   * ────────────────────────────────────────────── */
  const tabBtns = document.querySelectorAll(".tab-btn[data-tab]");
  const tabPanels = { view: $("cnPaneView"), settings: $("cnPaneSettings"), quick: $("cnPaneQuick") };

  function _setSettingsModal(open) {
    const m = $("cnModalSettings");
    if (!m) return;
    m.classList.toggle("hidden", !open);
    m.setAttribute("aria-hidden", open ? "false" : "true");
  }

  function activateTab(name) {
    tabBtns.forEach((btn) => {
      const active = btn.dataset.tab === name;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });

    if (name === "settings") {
      _setSettingsModal(true);
      if (!state.settings.loaded) loadTypes();
      return;
    }

    if (name === "view") {
      _setSettingsModal(false);
      if (!state.view.loaded) {
        loadNetworksForFilter();
        loadTypesForFilter();
      }
      return;
    }

    // "quick" та інші (тільки в embed) — оригінальна логіка
    Object.entries(tabPanels).forEach(([k, el]) => {
      if (el) el.classList.toggle("hidden", k !== name);
    });
  }

  tabBtns.forEach((btn) => btn.addEventListener("click", () => activateTab(btn.dataset.tab)));

  // Header button → відкриває модалку Налаштування
  const cnOpenSettingsBtn = $("cnOpenSettings");
  if (cnOpenSettingsBtn) {
    cnOpenSettingsBtn.addEventListener("click", () => activateTab("settings"));
  }

  // Закриття модалки Налаштування: X / backdrop
  document.querySelectorAll('[data-cn-modal-close="settings"]').forEach((el) => {
    el.addEventListener("click", () => _setSettingsModal(false));
  });
  // Esc закриває модалку Налаштування (Delta modal має свій окремий Esc-handler нижче)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const m = $("cnModalSettings");
      if (m && !m.classList.contains("hidden")) _setSettingsModal(false);
    }
  });

  /* ──────────────────────────────────────────────
   *  ПЕРЕГЛЯД — DOM refs
   * ────────────────────────────────────────────── */
  const filterForm     = $("cnFilterForm");
  const dateFrom       = $("cnDateFrom");
  const dateTo         = $("cnDateTo");
  const networkInput   = $("cnNetworkInput");
  const networkDrop    = $("cnNetworkDrop");
  const networkId      = $("cnNetworkId");
  const callsignInput  = $("cnCallsign");
  const callsignId     = $("cnCallsignId");
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

  /* ── Редагування висновку (текст + координати) ── */
  let _editAcId = null, _editWired = false;
  function _wireEditModal() {
    if (_editWired) return;
    _editWired = true;
    $("cnEditCloseBtn")?.addEventListener("click", closeEditModal);
    $("cnEditCancelBtn")?.addEventListener("click", closeEditModal);
    $("cnEditBackdrop")?.addEventListener("click", closeEditModal);
    $("cnEditSaveBtn")?.addEventListener("click", saveEdit);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("cnEditModal")?.classList.contains("hidden")) closeEditModal();
    });
  }
  function openEditModal(row) {
    _wireEditModal();
    _editAcId = row.id;
    $("cnEditText").value   = row.conclusion_text || "";
    $("cnEditCoords").value = (row.mgrs || []).join("\n");
    const err = $("cnEditErr"); if (err) err.style.display = "none";
    $("cnEditModal").classList.remove("hidden");
    setTimeout(() => $("cnEditText")?.focus(), 0);
  }
  function closeEditModal() {
    $("cnEditModal")?.classList.add("hidden");
    _editAcId = null;
  }
  async function saveEdit() {
    if (!_editAcId) return;
    const text   = ($("cnEditText").value || "").trim();
    const coords = ($("cnEditCoords").value || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const err = $("cnEditErr");
    if (!text) { if (err) { err.textContent = "Висновок не може бути порожнім"; err.style.display = ""; } return; }
    const btn = $("cnEditSaveBtn"); if (btn) btn.disabled = true;
    try {
      const res  = await fetch(`/api/conclusions/${_editAcId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conclusion_text: text, mgrs: coords }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) { if (err) { err.textContent = data.error || "Помилка"; err.style.display = ""; } return; }
      const row = state.view.rows.find((r) => r.id === _editAcId);
      if (row) { row.conclusion_text = text; row.mgrs = coords; }
      const tr = cnTableBody.querySelector(`tr[data-ac-id="${_editAcId}"]`);
      if (tr && tr.children.length >= 5) {
        tr.children[2].innerHTML = escapeHtml(formatConclusion(text));
        tr.children[4].innerHTML = coords.length
          ? coords.map((m) => `<code class="cn-mgrs-code">${escapeHtml(m)}</code>`).join(" ")
          : "<span style='opacity:.4'>—</span>";
      }
      toast("Висновок оновлено", "success", 2000);
      closeEditModal();
    } catch (e) {
      if (err) { err.textContent = "Помилка з'єднання"; err.style.display = ""; }
    } finally { if (btn) btn.disabled = false; }
  }

  /* ── Видалення висновку ── */
  async function deleteConclusion(acId, tr) {
    if (!window.confirm("Видалити цей аналітичний висновок?")) return;
    try {
      const res  = await fetch(`/api/conclusions/${acId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.ok) { toast(data.error || "Помилка видалення", "error"); return; }
      const idx = state.view.rows.findIndex((r) => r.id === acId);
      if (idx !== -1) state.view.rows.splice(idx, 1);
      tr?.remove();
      const cnt = $("cnCountVal"); if (cnt) cnt.textContent = String(state.view.rows.length);
      if (!state.view.rows.length) {
        const t = $("cnTable"); if (t) t.style.display = "none";
        const em = $("cnEmptyMsg"); if (em) em.style.display = "";
      }
      toast("Висновок видалено", "success", 2000);
    } catch (e) { toast("Помилка з'єднання", "error"); }
  }

  function updateBadge(tr, typeId, typeLabel, typeColor) {
    const badge = tr?.querySelector(".cn-type-badge--pick");
    if (!badge) return;
    badge.textContent        = typeLabel || "невідомо";
    badge.dataset.typeId     = typeId;
    badge.style.cssText      = colorStyle(typeColor || "#6b7280");
    // Sync state.view.rows so Delta modal reads the updated type_id
    const acId = tr ? parseInt(tr.dataset.acId, 10) : NaN;
    if (!isNaN(acId)) {
      const rowObj = state.view.rows.find((r) => r.id === acId);
      if (rowObj) {
        rowObj.type_id    = typeId;
        rowObj.type_label = typeLabel || "невідомо";
        rowObj.type_color = typeColor || "#6b7280";
      }
    }
  }

  /* ──────────────────────────────────────────────
   *  DELTA MODAL
   * ────────────────────────────────────────────── */
  async function openDeltaModal(row) {
    _deltaModalRow = row;

    // Always fetch fresh type data so icon/settings changes are reflected immediately
    await refreshTypesCache();

    const typeObj = state.view.types.find((t) => t.id === row.type_id)
                 || state.settings.types.find((t) => t.id === row.type_id)
                 || {};

    // Populate Тип input from SIDC icon label
    const cdmType      = $("cdmType");
    const cdmTypeWarn  = $("cdmTypeWarn");
    const cdmSendBtn   = $("cnDeltaSendBtn");

    // Normalize pos-4 to '6' before lookup (library stores all icons as Hostile)
    const iconSidc = typeObj.icon_sidc || "";
    const normSidc = iconSidc.length >= 4
      ? iconSidc.slice(0, 3) + "6" + iconSidc.slice(4)
      : iconSidc;
    const sidcEntry    = normSidc ? _SIDC_ICONS.find(e => e.s === normSidc) : null;
    const sidcIconLabel = sidcEntry ? sidcEntry.l : "";

    if (cdmType) cdmType.value = sidcIconLabel;

    // Block sending if no icon is configured
    const hasIcon = !!sidcIconLabel;
    if (cdmTypeWarn) {
      cdmTypeWarn.classList.toggle("hidden", hasIcon);
      const warnName = document.getElementById("cdmTypeWarnName");
      if (warnName) warnName.textContent = typeObj.type || "";
    }
    if (cdmSendBtn) cdmSendBtn.disabled = !hasIcon;

    // Ідентифікація — лише два канонічні значення.
    // Будь-яке legacy ('Невизначений', 'Невідомий', порожнє…) трактуємо як «Дружній»,
    // окрім явного «Ворожий» (відповідає чекбоксу в Налаштуваннях).
    const cdmIdent = $("cdmIdent");
    if (cdmIdent) cdmIdent.value = (typeObj.delta_identification === "Ворожий") ? "Ворожий" : "Дружній";

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

  /* SIDC-іконка → людська назва типу для рядка «Тип:» у Дельта-звіті. */
  function sidcLabelForType(typeObj) {
    const iconSidc = (typeObj && typeObj.icon_sidc) || "";
    const normSidc = iconSidc.length >= 4
      ? iconSidc.slice(0, 3) + "6" + iconSidc.slice(4)
      : iconSidc;
    const sidcEntry = normSidc ? _SIDC_ICONS.find((e) => e.s === normSidc) : null;
    return sidcEntry ? sidcEntry.l : "";
  }

  /* Зібрати текст Дельта-звіту з полів + рядка висновку. fields:
     {type,name,ident,unit,source,presence,dtFmt,radius,mgrs}. */
  function buildDeltaText(fields, row) {
    const lines = [];
    if (fields.type)     lines.push(`Тип: ${fields.type}`);
    if (fields.name)     lines.push(`Назва: ${fields.name}`);
    if (fields.ident)    lines.push(`Ідентифікація: ${fields.ident}`);
    if (fields.unit)     lines.push(`Підрозділ: ${fields.unit}`);
    if (fields.presence) lines.push(`Присутність: ${fields.presence}`);
    if (fields.source)   lines.push(`Джерело: ${fields.source}`);
    if (fields.dtFmt)    lines.push(`Час виявлення: ${fields.dtFmt}`);
    if (fields.radius)   lines.push(`Радіус дії: ${fields.radius}`);
    if (fields.mgrs)     lines.push(`MGRS: ${fields.mgrs}`);

    const conclusion = _fillRoutePoints(
      (row.conclusion_text || "").trim(),
      row.mgrs || [],
    );
    const body = (row.body_text || "").trim();

    // ── Шапка перехоплення ──
    let createdAtFmt = "";
    const _dtm = (row.created_at || "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2}:\d{2})/);
    if (_dtm) createdAtFmt = `${_dtm[3]}.${_dtm[2]}.${_dtm[1]}, ${_dtm[4]}`;
    const _freq = (row.frequency || "").trim();
    const _netDesc = (row.net_description || "").trim();
    const _mask = (row.mask || "").trim();
    const _csMatch = body.match(/—\s*(\S+)/);
    const _firstCS = _csMatch ? _csMatch[1].replace(/,$/, "").toUpperCase() : "";
    const header = [createdAtFmt, _freq, _netDesc, _mask, _firstCS].filter(Boolean).join("\n");

    return [lines.join("\n"), conclusion, header, body].filter(Boolean).join("\n\n");
  }

  /* Дефолтні поля Дельти з рядка + типу (як їх заповнює openDeltaModal).
     Повертає null, якщо у типу немає налаштованої іконки (надсилати не можна). */
  function deltaFieldsFromRow(row, typeObj) {
    const typeLabel = sidcLabelForType(typeObj || {});
    if (!typeLabel) return null;   // без іконки звіт не формуємо
    let dtFmt = "";
    const _dtm = (row.created_at || "").match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})/);
    if (_dtm) dtFmt = `${_dtm[3]}.${_dtm[2]}.${_dtm[1]} ${_dtm[4]}:00`;
    return {
      type:     typeLabel,
      name:     row.frequency || "",
      ident:    (typeObj && typeObj.delta_identification === "Ворожий") ? "Ворожий" : "Дружній",
      unit:     row.unit || "",
      source:   (typeObj && typeObj.delta_source)   || "Радіорозвідка (РР)",
      presence: (typeObj && typeObj.delta_presence) || "присутній",
      dtFmt,
      radius:   "",
      mgrs:     (row.mgrs || []).map((m) => m.replace(/\s+/g, "")).join(", "),
    };
  }

  /* Надіслати текст у цільовий чат. Повертає {ok, error}. */
  async function pushDeltaText(text) {
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
      if (res.ok && d.ok) return { ok: true };
      return { ok: false, error: d.error || "Помилка надсилання" };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /* Позначити висновок як надісланий: БД + стан + кнопка в таблиці. */
  function markRowSended(rowId) {
    fetch(`/api/conclusions/${rowId}/mark-sended`, { method: "POST" }).catch(() => {});
    const rowObj = state.view.rows.find((r) => r.id === rowId);
    if (rowObj) rowObj.sended = 1;
    const tr = cnTableBody.querySelector(`tr[data-ac-id="${rowId}"]`);
    const dBtn = tr?.querySelector(".cn-delta-btn");
    if (dBtn) {
      dBtn.className = "cn-delta-btn cn-delta-btn--on";
      dBtn.title = "Дельта-звіт надіслано";
    }
  }

  async function sendDeltaReport() {
    if (!_deltaModalRow) return;

    const dtRaw = $("cdmDatetime")?.value || "";
    let dtFmt = "";
    if (dtRaw) {
      const [datePart, timePart] = dtRaw.split("T");
      if (datePart && timePart) {
        const [y, mo, d] = datePart.split("-");
        dtFmt = `${d}.${mo}.${y} ${timePart}:00`;
      }
    }
    const fields = {
      type:     $("cdmType")?.value?.trim()     || "",
      name:     $("cdmName")?.value?.trim()     || "",
      ident:    $("cdmIdent")?.value            || "",
      unit:     $("cdmUnit")?.value?.trim()     || "",
      source:   $("cdmSource")?.value           || "",
      presence: $("cdmPresence")?.value         || "",
      dtFmt,
      radius:   $("cdmRadius")?.value?.trim()   || "",
      mgrs:     $("cdmMgrs")?.value?.trim()     || "",
    };
    const text = buildDeltaText(fields, _deltaModalRow);

    if (!cnSettingsChatId) {
      toast("Оберіть цільовий чат у вкладці «Налаштування»", "warn");
      return;
    }

    // Дубль: подію вже надіслано іншим висновком — підтверджуємо, щоб не
    // продублювати звіт у технічному чаті випадково.
    if (_deltaModalRow.twin_sended && !_deltaModalRow.sended) {
      if (!window.confirm(
            "Цю подію вже надіслано іншим висновком (дубль).\n" +
            "Надіслати Дельта-звіт усе одно?")) {
        return;
      }
    }

    const sendBtn = $("cnDeltaSendBtn");
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = "…"; }

    const res = await pushDeltaText(text);
    if (res.ok) {
      toast("Дельта-звіт надіслано", "success");
      saveAppSettings({
        delta_chat_id:   cnSettingsChatId,
        delta_chat_name: cnSettingsChatName,
        delta_platform:  cnSettingsPlatform,
      });
      markRowSended(_deltaModalRow.id);
      closeDeltaModal();
    } else {
      toast(res.error || "Помилка надсилання", "error");
    }
    if (sendBtn) { sendBtn.disabled = false; sendBtn.innerHTML = "&#10148; Надіслати"; }
  }

  /* Гуртове надсилання всіх невідісланих висновків поточної вибірки.
     Пропускаємо: вже надіслані; дублі, чия подія вже надіслана іншим
     висновком (twin_sended); типи без іконки (звіт сформувати не можна). */
  async function sendAllUnsent() {
    if (!cnSettingsChatId) {
      toast("Оберіть цільовий чат у вкладці «Налаштування»", "warn");
      return;
    }
    await refreshTypesCache();
    const typeById = (id) =>
      state.view.types.find((t) => t.id === id) ||
      state.settings.types.find((t) => t.id === id) || {};

    const candidates = (state.view.rows || []).filter(
      (r) => !r.sended && !r.twin_sended,
    );
    if (!candidates.length) {
      toast("Невідісланих висновків немає", "info");
      return;
    }
    if (!window.confirm(
          `Надіслати Дельта-звіти для ${candidates.length} висновк(ів)?\n` +
          `Дублі вже надісланих подій і типи без іконки буде пропущено.`)) {
      return;
    }

    const btn = $("cnSendAllUnsent");
    const total = candidates.length;
    if (btn) { btn.disabled = true; btn.dataset._t = btn.textContent; }

    let sent = 0, skipped = 0, failed = 0, done = 0;
    for (const row of candidates) {
      done++;
      if (btn) btn.textContent = `Надсилання… ${done}/${total}`;
      const fields = deltaFieldsFromRow(row, typeById(row.type_id));
      if (!fields) { skipped++; continue; }   // немає іконки
      const res = await pushDeltaText(buildDeltaText(fields, row));
      if (res.ok) { markRowSended(row.id); sent++; }
      else { failed++; }
    }

    if (btn) { btn.disabled = false; btn.textContent = btn.dataset._t || "Надіслати всі невідіслані"; }
    toast(
      `Надіслано: ${sent}` +
        (skipped ? ` · пропущено (без іконки): ${skipped}` : "") +
        (failed ? ` · помилок: ${failed}` : ""),
      failed ? "warn" : "success",
    );
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
    // Позивний: точний id (із префільтра) має пріоритет над введеним ім'ям.
    if (callsignId && callsignId.value) params.set("callsign_id", callsignId.value);
    else if (callsignInput && callsignInput.value.trim()) params.set("callsign", callsignInput.value.trim());

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
        const csLine = r.callsigns
          ? `<div class="cn-cs-line" title="Позивні перехоплення">${escapeHtml(r.callsigns)}</div>`
          : "";
        const interceptHtml = (r.body_text || r.callsigns)
          ? `<div class="cn-intercept-cell">${csLine}${escapeHtml(r.body_text || "")}</div>`
          : `<span style="opacity:.4">—</span>`;

        // Delta button: сірий = надіслано; бурштин = дубль (подію вже надіслано
        // іншим висновком); червоний = не надіслано. Підказка пояснює причину.
        let deltaBtnClass, deltaBtnTitle;
        if (r.sended) {
          deltaBtnClass = "cn-delta-btn--on";
          deltaBtnTitle = "Дельта-звіт надіслано";
        } else if (r.twin_sended) {
          deltaBtnClass = "cn-delta-btn--dup";
          deltaBtnTitle = "Дубль: цю подію вже надіслано іншим висновком. Натисніть, щоб надіслати все одно";
        } else if (r.delta_auto_send === false) {
          deltaBtnClass = "cn-delta-btn--off";
          deltaBtnTitle = "Не надіслано (авто-надсилання вимкнено для цього типу). Натисніть, щоб надіслати";
        } else {
          deltaBtnClass = "cn-delta-btn--off";
          deltaBtnTitle = "Надіслати Дельта-звіт";
        }
        const dupTag = (r.dup_count > 0)
          ? `<span class="cn-dup-tag" title="Висновків на цю подію: ${r.dup_count + 1}">дубль</span>`
          : "";

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
            ${dupTag}
            <button class="cn-edit-btn" title="Редагувати висновок">✏</button>
            <button class="cn-reclassify-btn" title="Повторно проаналізувати тип">♻</button>
            <button class="cn-delta-btn ${deltaBtnClass}" title="${deltaBtnTitle}">⊡</button>
            <button class="cn-del-btn" title="Видалити висновок">🗑</button>
          </td>
        </tr>`;
      }).join("");

      // Event delegation: type picker + reclassify + delta
      cnTableBody.onclick = (e) => {
        const badge = e.target.closest(".cn-type-badge--pick");
        if (badge) { openTypePicker(badge); return; }
        const editBtn = e.target.closest(".cn-edit-btn");
        if (editBtn) {
          const tr = editBtn.closest("tr");
          const acId = tr ? parseInt(tr.dataset.acId, 10) : null;
          const row = acId ? state.view.rows.find((r) => r.id === acId) : null;
          if (row) openEditModal(row);
          return;
        }
        const delBtn = e.target.closest(".cn-del-btn");
        if (delBtn) {
          const tr = delBtn.closest("tr");
          const acId = tr ? parseInt(tr.dataset.acId, 10) : null;
          if (acId) deleteConclusion(acId, tr);
          return;
        }
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
      if (callsignId && callsignId.value) qs.set("callsign_id", callsignId.value);
      else if (callsignInput && callsignInput.value.trim()) qs.set("callsign", callsignInput.value.trim());
      window.open("/conclusions/map?" + qs.toString(), "_blank");
    });
  }

  const cnSendAllUnsentBtn = $("cnSendAllUnsent");
  if (cnSendAllUnsentBtn) cnSendAllUnsentBtn.addEventListener("click", sendAllUnsent);

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

  /* ── SIDC icons catalogue (APP-6 / MIL-STD-2525) ─────────── */
  const _SIDC_ICONS = [
    { l:"Піхотний підрозділ",             g:"Тактика",    s:"10061000001211000000" },
    { l:"Укриття",                         g:"Тактика",    s:"10062500002809000000" },
    { l:"Наземне укриття",                 g:"Тактика",    s:"10062500002810000000" },
    { l:"Підземне укриття",                g:"Тактика",    s:"10062500002811000000" },
    { l:"БпЛА вертикального зльоту",       g:"Тактика",    s:"10060100001104000000" },
    { l:"Безпілотний літак",               g:"Тактика",    s:"10060100001103000000" },
    { l:"БПЛА/БПАК/ДПЛА",                 g:"Тактика",    s:"10062500001821000000" },
    { l:"Безпілотний наземний ТЗ",         g:"Тактика",    s:"10061500001201050000" },
    { l:"Спостережний пункт / застава",    g:"Тактика",    s:"10062500001601000000" },
    { l:"Пункт рекогностування",           g:"Тактика",    s:"10062500001602010000" },
    { l:"Командування",                    g:"Тактика",    s:"10061000001100000000" },
    { l:"Вогнева позиція",                 g:"Тактика",    s:"10062500002501000000" },
    { l:"Наметовий табір",                 g:"Тактика",    s:"10062000001119000000" },
    { l:"Опорний пункт",                   g:"Тактика",    s:"10062500001512030000" },
    { l:"Укріплений рубіж",                g:"Тактика",    s:"10062500002909000000" },
    { l:"Район зосередження",              g:"Тактика",    s:"10062500001502000000" },
    { l:"Наземна споруда",                 g:"Тактика",    s:"10062000000000000000" },
    { l:"Підрозділ БпЛА",                  g:"Тактика",    s:"10061000001219000000" },
    { l:"Дистанційно пілотований апарат",  g:"Тактика",    s:"10060120001103000000" },
    { l:"Орієнтир для засобів ураження",   g:"Тактика",    s:"10062500001603000000" },
    { l:"Малорозмірна або одиночна ціль",  g:"Тактика",    s:"10062500002406010000" },
    { l:"Піхотинець (о/с)",                g:"Тактика",    s:"10062700001101010000" },
    { l:"Снайперський підрозділ",          g:"Тактика",    s:"10061000001215000000" },
    { l:"Підрозділ розмінування",          g:"Тактика",    s:"10061000001414000000" },
    { l:"Підрозділ супутникового зв'язку", g:"Тактика",    s:"10061000001110040000" },
    { l:"Інженерна техніка та обладнання", g:"Техніка",    s:"10061500001300000000" },
    { l:"ВАТ (важка авто техніка)",        g:"Техніка",    s:"10061500001408000000" },
    { l:"Мала вантажівка",                 g:"Техніка",    s:"10061500001604020000" },
    { l:"Вантажівка підв. прохідності",    g:"Техніка",    s:"10061500001408000000" },
    { l:"ЛАТ (легка авто техніка)",        g:"Техніка",    s:"10061500001601000000" },
    { l:"ББМ",                             g:"Техніка",    s:"10061500001201010000" },
    { l:"Бронеавтомобіль",                 g:"Техніка",    s:"10061500001201050000" },
    { l:"БТР",                             g:"Техніка",    s:"10061500001201010000" },
    { l:"Танк",                            g:"Техніка",    s:"10061500001202000000" },
    { l:"Паливозаправник",                 g:"Техніка",    s:"10061500001409000000" },
    { l:"Автомобіль",                      g:"Техніка",    s:"10061500001401000000" },
    { l:"Невеликий автобус",               g:"Техніка",    s:"10061500001603020000" },
    { l:"Великий автобус",                 g:"Техніка",    s:"10061500001603030000" },
    { l:"Гелікоптер",                      g:"Техніка",    s:"10060100001102000000" },
    { l:"Літак",                           g:"Техніка",    s:"10060100001101000000" },
    { l:"Сухопутна ОВТ",                   g:"Техніка",    s:"10061500000000000000" },
    { l:"Медевак",                         g:"Логістика",  s:"10062500003211000000" },
    { l:"Склад боєприпасів",               g:"Логістика",  s:"10062000001103000000" },
    { l:"Склад/пункт зберігання майна",    g:"Логістика",  s:"10062000001120000000" },
    { l:"Склад ПММ",                       g:"Логістика",  s:"10061000001620000000" },
    { l:"Схованка",                        g:"Логістика",  s:"10062000001117000000" },
    { l:"Міст",                            g:"Логістика",  s:"10061500001301000000" },
    { l:"Електростанція",                  g:"Логістика",  s:"10062000001205020000" },
    { l:"Генераторна установка",           g:"Логістика",  s:"10061500002007000000" },
    { l:"Транспортний засіб",              g:"Логістика",  s:"10061500001200000000" },
    { l:"ТЗ тилового забезпечення",        g:"Логістика",  s:"10061500001201090000" },
    { l:"Тягач",                           g:"Логістика",  s:"10061500001412000000" },
    { l:"Екскаватор",                      g:"Логістика",  s:"10061500001314000000" },
    { l:"Позашляховик (SUV)",              g:"Логістика",  s:"10061500001604010000" },
    { l:"Пікап",                           g:"Логістика",  s:"10061500001602010000" },
    { l:"Джип",                            g:"Логістика",  s:"10061500001605000000" },
    { l:"Мотоцикл",                        g:"Логістика",  s:"10051500001200000000" },
    { l:"Квадроцикл",                      g:"Логістика",  s:"10061500001605010000" },
    { l:"Багі",                            g:"Логістика",  s:"10061500001605000000" },
    { l:"Точка на маршруті",               g:"Логістика",  s:"10062500001318000000" },
    { l:"Пункт загального постачання",     g:"Логістика",  s:"10062500003217000000" },
    { l:"Пункт управління",                g:"Логістика",  s:"10062500001301000000" },
    { l:"Орієнтир (точка інтересу)",       g:"Логістика",  s:"10012500001313000000" },
    { l:"ПТРК",                            g:"Артилерія",  s:"10061500001112000000" },
    { l:"Міномет",                         g:"Артилерія",  s:"10061500001114000000" },
    { l:"САУ",                             g:"Артилерія",  s:"10061500331109000000" },
    { l:"РСЗВ",                            g:"Артилерія",  s:"10061500001116000000" },
    { l:"Гаубиця",                         g:"Артилерія",  s:"10061500001109000000" },
    { l:"Підрозділ польової артилерії",    g:"Артилерія",  s:"10061000001303000030" },
    { l:"Пускова установка ЗРК",          g:"ППО",         s:"10061500001111000000" },
    { l:"Зенітна гармата",                 g:"ППО",         s:"10061500001105000000" },
    { l:"Радіоелектронна боротьба (РЕБ)", g:"РТО",         s:"10061000001505000000" },
    { l:"Бойова камера",                   g:"РТО",         s:"10061000001112000000" },
    { l:"Створення перешкод",              g:"РТО",         s:"10061000001505040000" },
    { l:"Антена",                          g:"РТО",         s:"10061500002001000000" },
    { l:"Телекомунікаційна вежа",          g:"РТО",         s:"10062000001212030000" },
    { l:"Антена радіопередавача",          g:"РТО",         s:"10061000001101000000" },
    { l:"Пожежа",                          g:"Подія",       s:"10064000001400000000" },
    { l:"Дим",                             g:"Подія",       s:"10064000001402000000" },
    { l:"Вибух",                           g:"Подія",       s:"10064000001106000000" },
    { l:"Вибух мінометного снаряда",       g:"Подія",       s:"10064000001106040000" },
    { l:"Вибух бомби",                     g:"Подія",       s:"10064000001106060000" },
    { l:"Вибух ракети",                    g:"Подія",       s:"10064000001106050000" },
    { l:"Транспортний інцидент",           g:"Подія",       s:"10064000001600000000" },
    { l:"Точка виявлення ракети",          g:"Подія",       s:"10062500002111000000" },
    { l:"Стрілянина",                      g:"Подія",       s:"10064000001104000000" },
    { l:"Точка злету/посадки БпЛА",       g:"Подія",       s:"10051000001206000000" },
    { l:"Загиблий",                        g:"Подія",       s:"10064000001101210000" },
    { l:"Полонений",                       g:"Подія",       s:"10050100001400000000" },
    { l:"Кулемет",                         g:"Зброя",       s:"10061500001102000000" },
    { l:"Протитанкова гармата",            g:"Зброя",       s:"10061500001106000000" },
    { l:"Протитанкова міна (ПТМ)",        g:"Зброя",       s:"10061500002103000000" },
    { l:"Міна",                            g:"Зброя",       s:"10061500002101000000" },
    { l:"Протипіхотна міна",               g:"Зброя",       s:"10062500002802000000" },
    { l:"Точка влучання",                  g:"Зброя",       s:"10062500002108000000" },
    { l:"Гранатомет",                      g:"Зброя",       s:"10061500001103000000" },
    { l:"Військовий бойовий корабель",     g:"ВМС",         s:"10063000001200000000" },
    { l:"Військовий надводний засіб",      g:"ВМС",         s:"10063000001100000000" },
    { l:"Військовий небойовий корабель",   g:"ВМС",         s:"10063000001300000000" },
    { l:"Цивільний надводний засіб",       g:"ВМС",         s:"10013000001400000000" },
  ];

  /* ── milsymbol helpers ───────────────────────────────────── */
  const _sidcBlobCache = {};

  function sidcToBlobUrl(sidc) {
    if (!sidc || !window.ms) return null;
    if (_sidcBlobCache[sidc]) return _sidcBlobCache[sidc];
    try {
      const sym = new ms.Symbol(sidc, { size: 40 });
      const svg = sym.asSVG();
      const blob = new Blob([svg], { type: "image/svg+xml" });
      const url  = URL.createObjectURL(blob);
      _sidcBlobCache[sidc] = url;
      return url;
    } catch (_) { return null; }
  }

  function sidcLabel(sidc) {
    const entry = _SIDC_ICONS.find(e => e.s === sidc);
    return entry ? entry.l : sidc;
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
      await loadDeltaTypeOptions();
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

  /* ─── SVG icon literals (used in type card action buttons) ─── */
  const _SVG_PENCIL = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>`;
  const _SVG_TRASH  = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
  const _SVG_CHECK  = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

  /* ─── type card ─── */
  function buildTypeCard(typeObj) {
    const card = document.createElement("div");
    card.className      = "cn-type-card";
    card.dataset.typeId = typeObj.id;

    const isProtected   = typeObj.id === 0;
    const cardColor     = typeObj.color || "#6b7280";

    if (!isProtected) card.draggable = true;

    // Resolve current SIDC label for display (normalize pos-4 → '6' before lookup)
    const _rawSidcForLabel = typeObj.icon_sidc || "";
    const _normSidcForLabel = _rawSidcForLabel.length >= 4
      ? _rawSidcForLabel.slice(0, 3) + "6" + _rawSidcForLabel.slice(4)
      : _rawSidcForLabel;
    const _sidcLabelFound = _normSidcForLabel ? _SIDC_ICONS.find(e => e.s === _normSidcForLabel) : null;
    const curSidcLabel = _sidcLabelFound ? _sidcLabelFound.l : "";

    card.innerHTML = `
      <div class="cn-type-card__head">
        ${isProtected ? "" : `<span class="cn-drag-handle" title="Перетягнути для зміни порядку">⠿</span>`}
        <span class="cn-type-card__swatch" title="Колір типу на карті"></span>
        <input type="color" class="cn-type-color-inp" value="${escapeHtml(cardColor)}" title="Обрати колір" draggable="false" />
        <span class="cn-type-card__name">${escapeHtml(typeObj.type)}</span>
        ${isProtected ? "" : `<input type="text" class="cn-type-name-inp"
               value="${escapeHtml(typeObj.type)}"
               style="display:none;flex:1;font-size:14px;font-weight:600;
                      padding:2px 6px;background:var(--input-bg,#1e293b);
                      color:inherit;border:1px solid var(--border);border-radius:4px" />`}
        ${isProtected
          ? `<span class="small" style="opacity:.5">(системний)</span>`
          : `<button type="button" class="cn-icon-btn cn-type-rename-btn" title="Перейменувати" style="margin-left:auto">${_SVG_PENCIL}</button>
             <button type="button" class="cn-icon-btn cn-icon-btn--danger cn-type-del-btn" title="Видалити">${_SVG_TRASH}</button>`
        }
      </div>

      <!-- SIDC icon picker -->
      <div class="cn-sidc-row">
        <span class="small" style="opacity:.7;white-space:nowrap;flex-shrink:0">Іконка на карті:</span>
        <img class="cn-sidc-img" width="44" height="44" alt=""
             style="flex-shrink:0;${typeObj.icon_sidc ? '' : 'display:none'}" />
        <span class="cn-sidc-lbl small"
              style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85">
          ${escapeHtml(curSidcLabel || "— без іконки (за замовчуванням) —")}
        </span>
        <button type="button" class="secondary cn-sidc-pick-btn"
                style="font-size:11px;padding:3px 10px;white-space:nowrap;flex-shrink:0">Обрати</button>
      </div>

      <!-- Keywords compact bar -->
      <div class="cn-kw-bar">
        <div class="cn-type-chips" data-type-id="${typeObj.id}"></div>
        <button type="button" class="cn-kw-toggle-btn" title="Додати ключове слово">+</button>
        <input type="text" class="cn-kw-inline-inp" placeholder="Нове слово…" autocomplete="off" style="display:none" />
      </div>

      <!-- Delta section -->
      <div class="cn-delta-section">
        <div class="cn-delta-head">
          <strong class="small">Дельта</strong>
          <label class="cn-delta-autosend-label">
            <input type="checkbox" class="cn-delta-autosend-chk" ${typeObj.delta_auto_send ? "checked" : ""} />
            <span class="small">Авто надсилати</span>
          </label>
          <label class="cn-delta-autosend-label">
            <input type="checkbox" class="cn-delta-hostile-chk" ${typeObj.delta_identification === "Ворожий" || !typeObj.delta_identification ? "checked" : ""} />
            <span class="small">Ворожий</span>
          </label>
        </div>
        <div class="cn-delta-fields">
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

    // ── SIDC picker handlers ──
    const sidcImg      = card.querySelector(".cn-sidc-img");
    const sidcLbl      = card.querySelector(".cn-sidc-lbl");
    const sidcPickBtn  = card.querySelector(".cn-sidc-pick-btn");

    // Render initial SIDC preview
    if (typeObj.icon_sidc && sidcImg) {
      const blobUrl = sidcToBlobUrl(typeObj.icon_sidc);
      if (blobUrl) sidcImg.src = blobUrl;
    }

    function applySidc(sidc, label) {
      typeObj.icon_sidc = sidc;
      if (sidcImg) {
        const blobUrl = sidc ? sidcToBlobUrl(sidc) : null;
        sidcImg.src           = blobUrl || "";
        sidcImg.style.display = blobUrl ? "" : "none";
      }
      if (sidcLbl) sidcLbl.textContent = label || "— без іконки (за замовчуванням) —";
    }

    if (sidcPickBtn) {
      sidcPickBtn.addEventListener("click", () => {
        openSidcPicker((sidc, label) => {
          applySidc(sidc, label);
          patchTypeSidc(typeObj.id, sidc, label); // also updates delta_type
        });
      });
    }

    // ── Delta section handlers ──
    const autoSendChk = card.querySelector(".cn-delta-autosend-chk");
    const hostileChk  = card.querySelector(".cn-delta-hostile-chk");
    const sourceSel   = card.querySelector(".cn-delta-source-sel");
    const presenceSel = card.querySelector(".cn-delta-presence-sel");

    async function saveDelta() {
      const payload = {
        delta_auto_send:      autoSendChk ? autoSendChk.checked : true,
        delta_identification: hostileChk && hostileChk.checked ? "Ворожий" : "Дружній",
        delta_source:         sourceSel   ? sourceSel.value   : "",
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
    if (hostileChk) {
      hostileChk.addEventListener("change", async () => {
        // Flip SIDC affiliation (position 4): 6 = Hostile, 3 = Friend
        if (typeObj.icon_sidc) {
          const arr = typeObj.icon_sidc.split("");
          arr[3] = hostileChk.checked ? "6" : "3";
          const updatedSidc = arr.join("");
          typeObj.icon_sidc = updatedSidc;
          if (sidcImg) {
            const blobUrl = sidcToBlobUrl(updatedSidc);
            if (blobUrl) { sidcImg.src = blobUrl; sidcImg.style.display = ""; }
          }
          await patchTypeSidc(typeObj.id, updatedSidc);
        }
        await saveDelta();
      });
    }
    if (sourceSel)   sourceSel.addEventListener("change",   saveDelta);
    if (presenceSel) presenceSel.addEventListener("change", saveDelta);

    // ── Keyword chips ──
    const chipsWrap   = card.querySelector(".cn-type-chips");
    const kwToggleBtn = card.querySelector(".cn-kw-toggle-btn");
    const kwInput     = card.querySelector(".cn-kw-inline-inp");

    (typeObj.keywords || []).forEach((kw) => chipsWrap.appendChild(buildKeywordChip(kw, typeObj.id)));

    function doAdd() {
      const kw = (kwInput ? kwInput.value : "").trim();
      if (!kw) return;
      if (kwInput)     kwInput.value        = "";
      if (kwInput)     kwInput.style.display = "none";
      if (kwToggleBtn) { kwToggleBtn.textContent = "+"; kwToggleBtn.classList.remove("active"); }
      addKeyword(typeObj.id, kw, chipsWrap);
    }

    if (kwToggleBtn) {
      kwToggleBtn.addEventListener("click", () => {
        const open = kwInput && getComputedStyle(kwInput).display !== "none";
        if (open) {
          doAdd(); // save if something typed, else just close
        } else {
          if (kwInput) { kwInput.style.display = "inline-block"; kwInput.focus(); }
          kwToggleBtn.textContent = "✓";
          kwToggleBtn.classList.add("active");
        }
      });
    }
    if (kwInput) {
      kwInput.addEventListener("keydown", e => {
        if (e.key === "Enter")  { e.preventDefault(); doAdd(); }
        if (e.key === "Escape") {
          kwInput.style.display = "none";
          kwInput.value = "";
          if (kwToggleBtn) { kwToggleBtn.textContent = "+"; kwToggleBtn.classList.remove("active"); }
        }
      });
      kwInput.addEventListener("blur", () => {
        setTimeout(() => {
          if (getComputedStyle(kwInput).display !== "none") {
            if (kwInput.value.trim()) doAdd();
            else {
              kwInput.style.display = "none";
              if (kwToggleBtn) { kwToggleBtn.textContent = "+"; kwToggleBtn.classList.remove("active"); }
            }
          }
        }, 150);
      });
    }

    if (!isProtected) {
      card.querySelector(".cn-type-del-btn").addEventListener("click", () =>
        openDeleteModal(typeObj.id, typeObj.type)
      );

      const nameSpan  = card.querySelector(".cn-type-card__name");
      const nameInp   = card.querySelector(".cn-type-name-inp");
      const renameBtn = card.querySelector(".cn-type-rename-btn");

      function enterRenameMode() {
        nameInp.value          = typeObj.type;
        nameSpan.style.display = "none";
        nameInp.style.display  = "";
        renameBtn.innerHTML    = _SVG_CHECK;
        renameBtn.title        = "Зберегти";
        nameInp.focus();
        nameInp.select();
      }

      async function exitRenameMode(save) {
        const newName = nameInp.value.trim();
        nameSpan.style.display = "";
        nameInp.style.display  = "none";
        renameBtn.innerHTML    = _SVG_PENCIL;
        renameBtn.title        = "Перейменувати";
        if (save && newName && newName !== typeObj.type) {
          await patchTypeName(typeObj.id, newName, nameSpan);
        }
      }

      renameBtn.addEventListener("click", () => {
        if (nameInp.style.display === "none") {
          enterRenameMode();
        } else {
          exitRenameMode(true);
        }
      });

      nameInp.addEventListener("keydown", e => {
        if (e.key === "Enter")  { e.preventDefault(); exitRenameMode(true);  }
        if (e.key === "Escape") { e.preventDefault(); exitRenameMode(false); }
      });

      nameInp.addEventListener("blur", () => {
        // small timeout so click on "Зберегти" fires first
        setTimeout(() => { if (nameInp.style.display !== "none") exitRenameMode(true); }, 120);
      });
    }

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

  /* ─── patch sidc (+ optionally set delta_type from icon label) ─── */
  async function patchTypeSidc(typeId, sidc, deltaType) {
    const typeObj = state.settings.types.find((t) => t.id === typeId);
    if (typeObj) typeObj.icon_sidc = sidc;
    const payload = { icon_sidc: sidc };
    if (deltaType !== undefined) {
      payload.delta_type = deltaType;
      if (typeObj) typeObj.delta_type = deltaType;
    }
    try {
      const res = await fetch(`/api/conclusions/types/${typeId}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast(d.error || "Помилка збереження іконки", "error");
      }
    } catch (err) {
      toast("Помилка: " + err.message, "error");
    }
  }

  /* ─── SIDC picker modal ─── */
  let _sidcModalCallback = null;

  function openSidcPicker(callback) {
    _sidcModalCallback = callback;
    const modal = document.getElementById("cnSidcModal");
    if (!modal) return;
    const search = document.getElementById("cnSidcSearch");
    if (search) search.value = "";
    renderSidcGrid("");
    modal.classList.remove("hidden");
    modal.removeAttribute("aria-hidden");
    if (search) setTimeout(() => search.focus(), 50);
  }

  function closeSidcModal() {
    const modal = document.getElementById("cnSidcModal");
    if (modal) { modal.classList.add("hidden"); modal.setAttribute("aria-hidden", "true"); }
    _sidcModalCallback = null;
  }

  function renderSidcGrid(query) {
    const grid = document.getElementById("cnSidcGrid");
    if (!grid) return;

    const q = (query || "").toLowerCase().trim();
    const filtered = q ? _SIDC_ICONS.filter(e => e.l.toLowerCase().includes(q)) : _SIDC_ICONS;

    const groups = {};
    for (const entry of filtered) {
      (groups[entry.g] = groups[entry.g] || []).push(entry);
    }

    grid.innerHTML = "";
    for (const [groupName, entries] of Object.entries(groups)) {
      const hdr = document.createElement("div");
      hdr.className   = "cn-sidc-group-header";
      hdr.textContent = groupName;
      grid.appendChild(hdr);

      const row = document.createElement("div");
      row.className = "cn-sidc-group-row";

      for (const entry of entries) {
        const item = document.createElement("div");
        item.className = "cn-sidc-item";
        item.title     = entry.l;

        const img = document.createElement("img");
        img.width = 44; img.height = 44; img.alt = "";
        const blobUrl = sidcToBlobUrl(entry.s);
        if (blobUrl) img.src = blobUrl;

        const lbl = document.createElement("span");
        lbl.className   = "cn-sidc-item-lbl";
        lbl.textContent = entry.l;

        item.appendChild(img);
        item.appendChild(lbl);
        item.addEventListener("click", () => {
          const cb = _sidcModalCallback;
          closeSidcModal();
          if (cb) cb(entry.s, entry.l);
        });
        row.appendChild(item);
      }
      grid.appendChild(row);
    }
  }

  // Wire up SIDC modal controls
  (function initSidcModal() {
    const closeBtn  = document.getElementById("cnSidcModalClose");
    const backdrop  = document.getElementById("cnSidcBackdrop");
    const searchInp = document.getElementById("cnSidcSearch");
    if (closeBtn)  closeBtn.addEventListener("click",  closeSidcModal);
    if (backdrop)  backdrop.addEventListener("click",  closeSidcModal);
    if (searchInp) searchInp.addEventListener("input", () => renderSidcGrid(searchInp.value));
  })();

  /* ─── patch name ─── */
  async function patchTypeName(typeId, name, nameSpan) {
    const typeObj = state.settings.types.find(t => t.id === typeId);
    if (typeObj) typeObj.type = name;
    if (nameSpan) nameSpan.textContent = name;
    try {
      const res = await fetch(`/api/conclusions/types/${typeId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: name }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast(d.error || "Помилка перейменування", "error");
      } else {
        toast("Перейменовано", "info", 1200);
      }
    } catch (err) {
      toast("Помилка: " + err.message, "error");
    }
  }

  /* ─── keyword chip ─── */
  function buildKeywordChip(kw, typeId) {
    const chip = document.createElement("span");
    chip.className  = "cn-kw-chip";
    chip.dataset.kw = kw;
    const text = document.createElement("span");
    text.textContent = kw;
    const xBtn = document.createElement("button");
    xBtn.type = "button";
    xBtn.className   = "cn-kw-chip__x";
    xBtn.textContent = "×";
    xBtn.setAttribute("aria-label", "Видалити");
    xBtn.addEventListener("click", () => removeKeyword(typeId, kw, chip));
    chip.appendChild(text);
    chip.appendChild(xBtn);
    return chip;
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
   *  Перегляд — головний контент і одразу завантажується ("ніби клацнули Показати").
   *  Налаштування — відкривається в модалці за кліком "Налаштування" в шапці.
   *  ?tab=settings у URL — відкриваємо модалку одразу при заході.
   *  embed-режим (cnPaneQuick присутній) — нічого не авто-завантажуємо.
   * ────────────────────────────────────────────── */
  const usp = new URLSearchParams(location.search);
  const urlTab = usp.get("tab");
  const wantView = usp.get("pane") === "view";   // embed-перегляд висновків (модалка)
  const isEmbedMode = !!$("cnPaneQuick");

  // Ручне редагування поля «Позивний» скидає точний id (фільтр за ім'ям).
  if (callsignInput) {
    callsignInput.addEventListener("input", () => { if (callsignId) callsignId.value = ""; });
  }
  // Кнопка «Пошук» у шапці — відкрити модалку перегляду висновків.
  const cnOpenSearchBtn = $("cnOpenSearch");
  if (cnOpenSearchBtn) {
    cnOpenSearchBtn.addEventListener("click", () => {
      if (window.openConclusionsView) window.openConclusionsView({});
    });
  }

  function applyUrlFiltersAndLoad() {
    const dfrom = usp.get("date_from");
    const dto   = usp.get("date_to");
    // Без явних дат у модалці — широке вікно (рік), щоб показати всі висновки.
    if (dfrom) { dateFrom.value = dfrom; }
    else { const d = new Date(); d.setFullYear(d.getFullYear() - 1); d.setHours(0, 0, 0, 0); dateFrom.value = localDatetimeString(d); }
    if (dto) { dateTo.value = dto; }
    else { const d = new Date(); d.setHours(23, 59, 0, 0); dateTo.value = localDatetimeString(d); }
    if (usp.get("network_id") && networkId) networkId.value = usp.get("network_id");
    if (usp.get("type_id") && typeSel) typeSel.value = usp.get("type_id");
    if (usp.get("callsign_id") && callsignId) callsignId.value = usp.get("callsign_id");
    if (usp.get("callsign") && callsignInput) callsignInput.value = usp.get("callsign");
    loadConclusions();
  }

  if (wantView) {
    // Embed-режим перегляду висновків: префіл фільтрів з URL + завантаження.
    loadNetworksForFilter();
    loadTypesForFilter().then(applyUrlFiltersAndLoad).catch(applyUrlFiltersAndLoad);
  } else if (isEmbedMode) {
    // quick-embed (iframe /conclusions?embed=1&tab=quick) — quick_conclusions.js
    // самостійно піклується про свою ініціалізацію.
  } else {
    loadNetworksForFilter();
    loadTypesForFilter();
    loadConclusions();
    if (urlTab === "settings") activateTab("settings");
  }

})();
