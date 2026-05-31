/**
 * monitor.js — Monitoring tab (v2)
 *
 * Features:
 *  - Playlist with polling (10 s)
 *  - Priority tags (keyword-based, stored in localStorage)
 *  - Clickable frequency / net_description → opens /networks?pick=ID in new tab
 *  - Clickable callsign tags → openCallsignEditModalById
 *  - "+" button → slide-in analytical panel from the right
 *  - Settings modal for managing tags
 */
(function () {
  "use strict";

  /* ─────────────────────────────────────────
     Constants
  ───────────────────────────────────────── */
  const POLL_MS   = 10_000;
  const PAGE_SIZE = 50;
  // Bump version key → forces fresh defaults when defaults change
  const LS_TAGS   = "monitorTags_v2";

  const DEFAULT_TAGS = [
    {
      id: "coords", name: "Координати", icon: "XY",
      keywords: ["икс","игрек","харитон","ульяна","уляна","коорд","записыв","дикту"],
    },
    {
      id: "square", name: "Квадрат", icon: "⬛",
      keywords: ["квадрат"],
    },
    {
      id: "point", name: "Точка", icon: "🟠",
      keywords: ["точка","красн","коричн","бирюзов","зелен","синя","желт"],
    },
    {
      id: "uav", name: "БпЛА", icon: "✈",
      keywords: ["бабка","яга","глазки"],
    },
  ];

  /* ─────────────────────────────────────────
     State
  ───────────────────────────────────────── */
  let _active      = false;
  let _pollTimer   = null;
  let _lastSeenAt  = "";
  let _offset      = 0;
  let _total       = 0;
  let _activeThumb = null;
  let _tags        = _loadTags();

  /* DOM refs (set in initMonitor) */
  let _playlist, _detail, _markAllBtn, _showMoreBtn, _unreadBadge, _settingsBtn;

  /* ═════════════════════════════════════════
     Tags helpers
  ═════════════════════════════════════════ */

  function _loadTags() {
    try {
      const s = localStorage.getItem(LS_TAGS);
      if (s) return JSON.parse(s);
    } catch (_) {}
    return DEFAULT_TAGS.map(t => ({ ...t }));
  }

  function _saveTags(tags) {
    _tags = tags;
    try { localStorage.setItem(LS_TAGS, JSON.stringify(tags)); } catch (_) {}
  }

  /** Case-insensitive keyword match against full lowercased text. */
  function _matchTags(text) {
    if (!text || !_tags.length) return [];
    const lower = text.toLowerCase(); // entire text → lowercase once
    return _tags.filter(tag =>
      (tag.keywords || []).some(kw => kw && lower.includes(kw.toLowerCase()))
    );
  }

  /* ═════════════════════════════════════════
     Public API
  ═════════════════════════════════════════ */

  window.initMonitor = function () {
    _playlist    = document.getElementById("monPlaylist");
    _detail      = document.getElementById("monDetail");
    _markAllBtn  = document.getElementById("monMarkAllBtn");
    _showMoreBtn = document.getElementById("monShowMoreBtn");
    _unreadBadge = document.getElementById("monUnreadBadge");
    _settingsBtn = document.getElementById("monSettingsBtn");

    if (!_playlist || !_detail) return;

    _markAllBtn?.addEventListener("click",  _markAllRead);
    _showMoreBtn?.addEventListener("click", () => _loadPage(_offset));
    _settingsBtn?.addEventListener("click", _openSettingsModal);

    _initAnalyticsColumn();
    _initMiddleToolbar();

    _active = true;
    _loadPage(0);
    _startPolling();
  };

  window.resumeMonitor = function () {
    _active = true;
    if (!_pollTimer) _startPolling();
    _pollNew();
  };

  window.pauseMonitor = function () {
    _active = false;
    _stopPolling();
  };

  /* ── Conclusion tab ── */
  let _conclMap    = null;
  let _conclMarker = null;

  window.initConclusionPanel = function () {
    // Render current intercept
    const detail = document.getElementById("conclDetail");
    if (detail && _currentItem) _renderDetailTo(detail, _currentItem);

    // Conclusion controls
    document.getElementById("conclTemplatesBtn")?.addEventListener("click", _openTemplatesModal);
    document.getElementById("conclPasteBtn")?.addEventListener("click", () => {
      if (!_currentItem) return;
      const ta = document.getElementById("conclText");
      if (ta) { ta.value = _buildPasteText(_currentItem); ta.focus(); }
    });
    document.getElementById("conclClearBtn")?.addEventListener("click", () => {
      const ta = document.getElementById("conclText");
      if (ta) { ta.value = ""; ta.focus(); }
    });

    // Coordinate input
    const coordIn = document.getElementById("conclCoordInput");
    document.getElementById("conclCoordCopyBtn")?.addEventListener("click", () => {
      const v = (coordIn?.value || "").trim();
      if (v && window.clipboardWrite) window.clipboardWrite(v).then(ok => { if (ok && window.appToast) window.appToast("Скопійовано", "success"); });
    });
    if (coordIn) {
      coordIn.addEventListener("input",   () => _onCoordChangeMap(coordIn.value, _conclMap, () => _conclMarker, m => { _conclMarker = m; }));
      coordIn.addEventListener("keydown", e => { if (e.key === "Enter") _onCoordChangeMap(coordIn.value, _conclMap, () => _conclMarker, m => { _conclMarker = m; }, true); });
    }

    // Send bar
    _syncAllSendBars();
    _initOneSendBar("conclPlatformBtn", "conclChatInput", "conclChatDrop", "conclSendBtn",
      () => (document.getElementById("conclText")?.value || "").trim(),
      () => (document.getElementById("conclCoordInput")?.value || "").trim()
    );

    // Map
    requestAnimationFrame(() => {
      if (typeof L === "undefined") return;
      const el = document.getElementById("conclMap");
      if (!el || _conclMap) return;
      _conclMap = L.map(el, { center: [48.5, 37.5], zoom: 10 });
      L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { attribution:"Esri", maxZoom:19 }).addTo(_conclMap);
    });
  };

  window.resumeConclusionPanel = function () {
    const detail = document.getElementById("conclDetail");
    if (detail && _currentItem) _renderDetailTo(detail, _currentItem);
    _syncAllSendBars();
    setTimeout(() => { _conclMap?.invalidateSize(); }, 100);
  };

  /* ═════════════════════════════════════════
     Data loading
  ═════════════════════════════════════════ */

  async function _loadPage(offset) {
    try {
      const res  = await fetch(`/api/monitor/playlist?limit=${PAGE_SIZE}&offset=${offset}`);
      const data = await res.json();
      if (!data.ok) return;

      _total = data.total;

      if (offset === 0) {
        _playlist.innerHTML = "";
        _activeThumb = null;
        if (data.items.length) _lastSeenAt = data.items[0].created_at;
      }

      data.items.forEach(item => _appendThumb(item));
      _offset = offset + data.items.length;

      _syncShowMore();
      _syncUnreadBadge();
    } catch (e) { console.error("[monitor] loadPage", e); }
  }

  async function _pollNew() {
    if (!_lastSeenAt) return;
    try {
      const res  = await fetch(
        `/api/monitor/playlist?limit=${PAGE_SIZE}&since=${encodeURIComponent(_lastSeenAt)}`
      );
      const data = await res.json();
      if (!data.ok || !data.items.length) return;

      /* items come newest-first; prepend so newest stays at top */
      for (let i = data.items.length - 1; i >= 0; i--) {
        _prependThumb(data.items[i]);
      }
      _lastSeenAt = data.items[0].created_at;
      _total     += data.items.length;
      _syncShowMore();
      _syncUnreadBadge();
    } catch (e) { console.error("[monitor] pollNew", e); }
  }

  /* ═════════════════════════════════════════
     Thumbnail rendering
  ═════════════════════════════════════════ */

  function _buildThumb(item) {
    const el  = document.createElement("div");
    el.className = "mon-thumb" + (item.is_read ? "" : " mon-thumb--unread");
    el.dataset.id = item.id;

    const time    = (item.created_at || "").slice(11, 16);
    const freqStr = item.frequency || "—";
    const matched = _matchTags(item.body_preview || "");

    const tagsHtml = matched.length
      ? matched.map(t =>
          `<span class="mon-tag-icon" title="${_esc(t.name)}">${_esc(t.icon)}</span>`
        ).join("")
      : "";

    // Single line: [time] [freq/mask] [tags...]
    el.innerHTML =
      `<span class="mon-thumb-time">${_esc(time)}</span>` +
      `<span class="mon-thumb-freq">${_esc(freqStr)}</span>` +
      (tagsHtml ? `<span class="mon-thumb-tags">${tagsHtml}</span>` : "");

    el.addEventListener("click", () => _openDetail(item.id, el));
    return el;
  }

  function _appendThumb(item) { _playlist.appendChild(_buildThumb(item)); }
  function _prependThumb(item) { _playlist.prepend(_buildThumb(item)); }

  /* ═════════════════════════════════════════
     Detail panel
  ═════════════════════════════════════════ */

  async function _openDetail(msgId, thumbEl) {
    _activeThumb?.classList.remove("mon-thumb--active");
    thumbEl.classList.remove("mon-thumb--unread");
    thumbEl.classList.add("mon-thumb--active");
    _activeThumb = thumbEl;

    fetch(`/api/monitor/${msgId}/read`, { method: "PATCH" }).catch(() => {});
    _syncUnreadBadge();
    _updateNavPos();
    _syncToolbarPos();

    // Mount full card (callsigns editor, landmarks, comment, copy — all from intercepts_explorer.js)
    if (window.interceptsExplorerMountCard) {
      await window.interceptsExplorerMountCard(msgId, _detail);
    } else {
      _detail.innerHTML = `<div class="mon-detail-loading">Завантаження…</div>`;
    }

    // Keep lightweight item copy for paste/analysis panel
    fetch(`/api/intercepts-explorer/${msgId}`)
      .then(r => r.json())
      .then(d => {
        if (!d.item) return;
        _currentItem = d.item;
        // Sync to conclusion tab if it's currently visible
        const paneConclusion = document.getElementById("itPaneConclusion");
        const conclDetail    = document.getElementById("conclDetail");
        if (conclDetail && paneConclusion && !paneConclusion.classList.contains("hidden")) {
          if (window.interceptsExplorerMountCard) window.interceptsExplorerMountCard(msgId, conclDetail);
        }
      })
      .catch(() => {});
  }

  function _renderDetail(item) {
    const dtFmt   = _fmtDatetime(item.created_at || "");
    const freq    = item.network?.frequency || "—";
    const unit    = item.network?.unit || "";
    const netDesc = item.net_description || "";
    const text    = item.text || "";
    const netId   = item.network_id;

    /* Clickable frequency */
    const freqHtml = netId
      ? `<a class="mon-freq-link" href="/networks?pick=${netId}" target="_blank" rel="noopener">${_esc(freq)}</a>`
      : `<span>${_esc(freq)}</span>`;

    /* Clickable net description */
    const netDescHtml = netDesc
      ? (netId
          ? `<a href="/networks?pick=${netId}" target="_blank" rel="noopener" class="mon-netdesc-link">${_esc(netDesc)}</a>`
          : `<span class="mon-netdesc-link">${_esc(netDesc)}</span>`)
      : "";

    /* Callsign chips with status icon (SVG by status_id) */
    const csHtml = (item.callsigns || []).map(c => {
      const iconSrc = c.status_id
        ? `/static/icons/callsign_statuses/${c.status_id}.svg`
        : `/static/icons/callsign_statuses/_default.svg`;
      return `<span class="mon-cs-tag" data-cs-id="${c.id}" data-msg-id="${item.id}">` +
               `<img class="mon-cs-status-icon" src="${iconSrc}" alt=""` +
               ` onerror="this.onerror=null;this.src='/static/icons/callsign_statuses/_default.svg'">` +
               _esc(c.name) +
             `</span>`;
    }).join("");

    /* Show "open network" button in toolbar if we have a network id */
    const openNetBtn = document.getElementById("monOpenNetBtn");
    if (openNetBtn) {
      if (netId) {
        openNetBtn.style.display = "";
        openNetBtn.onclick = () => window.open(`/networks?pick=${netId}`, "_blank", "noopener");
      } else {
        openNetBtn.style.display = "none";
      }
    }

    _detail.innerHTML =
      /* Content block matching the screenshot format */
      `<div class="mon-detail-content">` +
        `<div class="mon-detail-datetime">${_esc(dtFmt)}</div>` +
        `<div class="mon-detail-freq-big">${freqHtml}</div>` +
        (netDescHtml ? `<div class="mon-detail-netdesc-row">${netDescHtml}</div>` : "") +
        (csHtml      ? `<div class="mon-detail-callsigns">${csHtml}</div>` : "") +
        `<div class="mon-detail-divider"></div>` +
        `<div class="mon-detail-body">${_formatBody(text)}</div>` +
      `</div>`;

    /* ── bind events ── */

    _detail.querySelectorAll(".mon-cs-tag[data-cs-id]").forEach(el => {
      el.addEventListener("click", () => {
        const csId  = parseInt(el.dataset.csId,  10);
        const msgId = parseInt(el.dataset.msgId, 10);
        if (csId && window.openCallsignEditModalById) {
          window.openCallsignEditModalById(csId, { messageId: msgId });
        }
      });
    });
  }

  /** Render intercept detail into any container element */
  function _renderDetailTo(container, item) {
    if (!item || !item.id) return;
    if (window.interceptsExplorerMountCard) {
      window.interceptsExplorerMountCard(item.id, container);
    }
  }

  /** Build "paste" text block from item */
  function _buildPasteText(item) {
    const dt = _fmtDatetime(item.created_at || "");
    const freq = item.network?.frequency || "";
    const netDesc = item.net_description || "";
    const text = item.text || "";
    const cs = (item.callsigns || []).map(c => c.name).join(", ");
    return [dt, freq, netDesc, cs ? `Позивні: ${cs}` : "", "", text].filter(Boolean).join("\n");
  }

  /** Generic coord→map marker update */
  function _onCoordChangeMap(raw, map, getMarker, setMarker, jumpNow) {
    if (!map || typeof window.mgrs === "undefined" || !window.mgrs.toPoint) return;
    const clean = (raw || "").trim().replace(/\s+/g, "").toUpperCase();
    if (clean.length < 6) return;
    try {
      const pt = window.mgrs.toPoint(clean);
      if (!Array.isArray(pt) || pt.length < 2) return;
      const lat = Number(pt[1]), lon = Number(pt[0]);
      if (!isFinite(lat) || !isFinite(lon)) return;
      const prev = getMarker();
      if (prev) { prev.remove(); setMarker(null); }
      const m = L.circleMarker([lat, lon], { radius:8, color:"#f59e0b", fillColor:"#f59e0b", fillOpacity:.8, weight:2 }).addTo(map);
      setMarker(m);
      if (jumpNow) map.setView([lat, lon], Math.max(map.getZoom(), 13));
    } catch(_) {}
  }

  /** Toggle platform across all send bars */
  const _PLATFORMS = [
    { id: "signal",   label: "S", color: "#3a76f0" },
    { id: "whatsapp", label: "W", color: "#16a34a" },
  ];
  function _platformInfo(id) {
    return _PLATFORMS.find(p => p.id === id) || _PLATFORMS[0];
  }

  function _togglePlatformBtn() {
    const idx = _PLATFORMS.findIndex(p => p.id === _sendPlatform);
    const next = _PLATFORMS[(idx + 1) % _PLATFORMS.length];
    _sendPlatform = next.id;
    _allChats = null;
    _sendChatId = ""; _sendChatName = "";
    const { label, color } = next;
    ["monSendPlatformBtn","conclPlatformBtn"].forEach(id => {
      const b = document.getElementById(id);
      if (b) { b.textContent = label; b.style.background = color; }
    });
    ["monSendChatInput","conclChatInput"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
    ["monSendBtn","conclSendBtn"].forEach(id => { const el = document.getElementById(id); if (el) el.disabled = true; });
  }

  function _syncAllSendBars() {
    const { label, color } = _platformInfo(_sendPlatform);
    ["monSendPlatformBtn","conclPlatformBtn"].forEach(id => {
      const b = document.getElementById(id);
      if (b) { b.textContent = label; b.style.background = color; }
    });
    if (_sendChatName) {
      ["monSendChatInput","conclChatInput"].forEach(id => { const el = document.getElementById(id); if (el && !el.value) el.value = _sendChatName; });
    }
    ["monSendBtn","conclSendBtn"].forEach(id => { const el = document.getElementById(id); if (el) el.disabled = !_sendChatId; });
  }

  function _showDropLoadingEl(drop) {
    drop.innerHTML = `<div class="mon-chat-drop-item" style="opacity:.45">Завантаження…</div>`;
    drop.classList.remove("hidden");
  }

  function _renderChatDropEl(inp, drop, query) {
    if (!drop || !_allChats) return;
    const q = (query || "").trim().toLowerCase();
    const filtered = _allChats.filter(c => !q || c.name.toLowerCase().includes(q)).slice(0, 40);
    if (!filtered.length) {
      drop.innerHTML = `<div class="mon-chat-drop-item" style="opacity:.45">Чатів не знайдено</div>`;
      drop.classList.remove("hidden");
      return;
    }
    drop.innerHTML = "";
    filtered.forEach(chat => {
      const item = document.createElement("div");
      item.className = "mon-chat-drop-item";
      item.innerHTML = `<span>${_esc(chat.name)}</span><span class="mon-chat-drop-type">група</span>`;
      item.addEventListener("mousedown", e => {
        e.preventDefault();
        _sendChatId = chat.id; _sendChatName = chat.name;
        ["monSendChatInput","conclChatInput"].forEach(id => { const el = document.getElementById(id); if (el) el.value = chat.name; });
        ["monSendBtn","conclSendBtn"].forEach(id => { const el = document.getElementById(id); if (el) el.disabled = false; });
        try { localStorage.setItem(LS_SEND_CHAT, JSON.stringify({ id: chat.id, name: chat.name, platform: _sendPlatform })); } catch(_){}
        drop.classList.add("hidden");
      });
      drop.appendChild(item);
    });
    drop.classList.remove("hidden");
  }

  function _initOneSendBar(platformBtnId, chatInputId, chatDropId, sendBtnId, getTextFn, getCoordFn) {
    // Platform button
    document.getElementById(platformBtnId)?.addEventListener("click", _togglePlatformBtn);

    // Chat input autocomplete
    const inp  = document.getElementById(chatInputId);
    const drop = document.getElementById(chatDropId);
    if (inp && drop) {
      let closeTimer = null;
      inp.addEventListener("focus", async () => {
        if (!_allChats && !_chatsLoading) { _showDropLoadingEl(drop); await _loadChats(); }
        _renderChatDropEl(inp, drop, inp.value);
      });
      inp.addEventListener("input", () => {
        _sendChatId = "";
        const sb = document.getElementById(sendBtnId); if (sb) sb.disabled = true;
        if (_allChats) _renderChatDropEl(inp, drop, inp.value);
      });
      inp.addEventListener("blur", () => { closeTimer = setTimeout(() => drop.classList.add("hidden"), 200); });
      drop.addEventListener("mousedown", () => clearTimeout(closeTimer));
    }

    // Send button
    document.getElementById(sendBtnId)?.addEventListener("click", async () => {
      if (!_sendChatId) return;
      let text = getTextFn();
      const coord = getCoordFn ? getCoordFn() : "";
      if (coord) text = (text ? text + "\n\n" : "") + `📍 ${coord}`;
      if (!text) { if (window.appToast) window.appToast("Введіть текст висновку", "warn"); return; }
      const btn = document.getElementById(sendBtnId);
      if (btn) { btn.disabled = true; btn.textContent = "…"; }
      try {
        const res = await fetch("/api/push/send", {
          method: "POST", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({ platform: _sendPlatform, chat_id: _sendChatId, text }),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d.ok) { if (window.appToast) window.appToast("Надіслано", "success"); }
        else { if (window.appToast) window.appToast(d.error || "Помилка", "error"); }
      } catch(e) { if (window.appToast) window.appToast(e.message, "error"); }
      finally { const b = document.getElementById(sendBtnId); if (b) { b.disabled = !_sendChatId; b.textContent = "▶"; } }
    });
  }

  /** "2026-05-29 21:27:20" → "29.05.2026, 21:27:20" */
  function _fmtDatetime(raw) {
    const m = String(raw).replace("T", " ").match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})/);
    return m ? `${m[3]}.${m[2]}.${m[1]}, ${m[4]}` : raw.slice(0, 19);
  }

  function _formatBody(text) {
    if (!text) return `<em style="opacity:.4">Немає тексту</em>`;
    return text.split("\n").map(line => {
      const t = line.trim();
      if (!t) return "";
      const isSpeech = t.startsWith("—") || t.startsWith("–") || t.startsWith("-");
      return `<div class="mon-body-line${isSpeech ? " mon-body-line--speech" : ""}">${_esc(t)}</div>`;
    }).filter(Boolean).join("");
  }

  /* ═════════════════════════════════════════
     Analytical panel (right-side drawer)
  ═════════════════════════════════════════ */

  function _openAnalysisPanel(item) {
    let panel = document.getElementById("monAnalysisPanel");
    if (!panel) panel = _createAnalysisPanel();

    _fillAnalysisPanel(item);
    panel.classList.add("open");
    _updateNavPos();
  }

  function _fillAnalysisPanel(item) {
    const dt      = (item.created_at || "").replace("T", " ").slice(0, 19);
    const freq    = item.network?.frequency || "";
    const netDesc = item.net_description || "";
    const unit    = item.network?.unit || "";
    const text    = item.text || "";

    const body = document.getElementById("monAnalysisPanelBody");
    if (!body) return;

    body.innerHTML =
      _apRow("Дата / час",  dt) +
      _apRow("Частота",     freq) +
      (netDesc ? _apRow("Мережа",    netDesc) : "") +
      (unit    ? _apRow("Підрозділ", unit)    : "") +
      `<div class="ap-field">` +
        `<div class="ap-field-label">Повідомлення</div>` +
        `<div class="ap-field-val ap-field-val--text">${_esc(text)}</div>` +
      `</div>` +
      `<div class="ap-placeholder">Функціонал аналітики буде розширено…</div>`;
  }

  function _apRow(label, val) {
    return `<div class="ap-field"><div class="ap-field-label">${_esc(label)}</div>` +
           `<div class="ap-field-val">${_esc(val)}</div></div>`;
  }

  function _createAnalysisPanel() {
    const panel = document.createElement("div");
    panel.id        = "monAnalysisPanel";
    panel.className = "analysis-panel";

    panel.innerHTML =
      /* Handle tab — always visible, sticks out when panel is hidden */
      `<div class="analysis-panel-handle" id="monAnalysisHandle">Аналіз</div>` +
      /* Content — slides in/out */
      `<div class="analysis-panel-content">` +
        `<div class="analysis-panel-head">` +
          `<div class="ap-nav">` +
            `<button class="ap-nav-btn" id="monAnalysisPrev" title="Новіше">‹‹</button>` +
            `<span class="ap-nav-pos" id="monAnalysisPos">—</span>` +
            `<button class="ap-nav-btn" id="monAnalysisNext" title="Старіше">››</button>` +
          `</div>` +
          `<span class="analysis-panel-title">Аналітика</span>` +
        `</div>` +
        `<div class="analysis-panel-body" id="monAnalysisPanelBody"></div>` +
      `</div>`;

    /* Handle toggles panel open/closed */
    panel.querySelector("#monAnalysisHandle").addEventListener("click", () =>
      panel.classList.toggle("open")
    );

    /* Navigation buttons */
    panel.querySelector("#monAnalysisPrev").addEventListener("click", () => _navigatePanel(-1));
    panel.querySelector("#monAnalysisNext").addEventListener("click", () => _navigatePanel(+1));

    document.body.appendChild(panel);
    return panel;
  }

  /* Navigate prev (-1 = newer/up) or next (+1 = older/down) in playlist */
  function _navigatePanel(dir) {
    const thumbs = Array.from(_playlist.querySelectorAll(".mon-thumb"));
    if (!thumbs.length || !_activeThumb) return;
    const idx     = thumbs.indexOf(_activeThumb);
    if (idx === -1) return;
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= thumbs.length) return;
    thumbs[nextIdx].click();
    thumbs[nextIdx].scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function _updateNavPos() {
    const posEl = document.getElementById("monAnalysisPos");
    if (!posEl) return;
    const thumbs = _playlist.querySelectorAll(".mon-thumb");
    const idx    = _activeThumb ? Array.from(thumbs).indexOf(_activeThumb) : -1;
    posEl.textContent = idx >= 0 ? `${idx + 1} / ${thumbs.length}` : "—";
  }

  /* ═════════════════════════════════════════
     Settings modal (tag management)
  ═════════════════════════════════════════ */

  function _openSettingsModal() {
    let modal = document.getElementById("monTagsModal");
    if (!modal) modal = _createSettingsModal();
    _renderTagRows(modal);
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }

  function _createSettingsModal() {
    const modal = document.createElement("div");
    modal.id        = "monTagsModal";
    modal.className = "modal hidden";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML =
      `<div class="modal-backdrop" data-close-mon="1"></div>` +
      `<div class="modal-card" role="dialog" aria-modal="true" style="max-width:700px">` +
        `<div class="modal-head">` +
          `<div>` +
            `<div class="small" style="opacity:.65">Моніторинг</div>` +
            `<div style="font-weight:700">Налаштування тегів</div>` +
          `</div>` +
          `<button class="secondary" data-close-mon="1">Закрити</button>` +
        `</div>` +
        `<div class="modal-body">` +
          `<p class="small" style="opacity:.6;margin-bottom:12px">` +
            `Тег активується, якщо текст перехоплення містить хоча б одне із зазначених слів (без урахування регістру).` +
          `</p>` +
          `<table class="mon-tags-table">` +
            `<thead><tr>` +
              `<th>Іконка</th><th>Назва</th><th>Слова (через кому)</th><th></th>` +
            `</tr></thead>` +
            `<tbody id="monTagRows"></tbody>` +
          `</table>` +
          `<button class="secondary" id="monAddTagBtn" style="margin-top:10px;font-size:12px">+ Додати тег</button>` +
        `</div>` +
        `<div class="modal-foot">` +
          `<button id="monSaveTagsBtn">Зберегти</button>` +
          `<button class="secondary" data-close-mon="1">Скасувати</button>` +
        `</div>` +
      `</div>`;

    modal.addEventListener("click", e => {
      if (e.target.closest("[data-close-mon]"))   { _closeSettingsModal(modal); return; }
      if (e.target.closest(".mon-tag-del-btn"))    { e.target.closest("tr")?.remove(); }
    });
    modal.querySelector("#monAddTagBtn").addEventListener("click", () => _addTagRow(modal));
    modal.querySelector("#monSaveTagsBtn").addEventListener("click", () => _saveTagsFromModal(modal));

    document.body.appendChild(modal);
    return modal;
  }

  function _renderTagRows(modal) {
    const tbody = modal.querySelector("#monTagRows");
    if (!tbody) return;
    tbody.innerHTML = _tags.map(_tagRowHtml).join("");
  }

  function _tagRowHtml(tag) {
    return `<tr class="mon-tag-row" data-tag-id="${_esc(tag.id)}">` +
      `<td><input class="mon-tag-icon-in" type="text" value="${_esc(tag.icon || "")}" placeholder="🏷" maxlength="4"></td>` +
      `<td><input class="mon-tag-name-in" type="text" value="${_esc(tag.name || "")}" placeholder="Назва"></td>` +
      `<td><input class="mon-tag-kw-in" type="text" value="${_esc((tag.keywords || []).join(", "))}" placeholder="слово1, слово2, …"></td>` +
      `<td><button class="secondary mon-tag-del-btn" title="Видалити">✕</button></td>` +
    `</tr>`;
  }

  function _addTagRow(modal) {
    const tbody = modal.querySelector("#monTagRows");
    if (!tbody) return;
    const id = "tag_" + Date.now();
    const tr = document.createElement("tr");
    tr.className     = "mon-tag-row";
    tr.dataset.tagId = id;
    tr.innerHTML = _tagRowHtml({ id, icon: "🏷", name: "", keywords: [] });
    tbody.appendChild(tr);
  }

  function _saveTagsFromModal(modal) {
    const rows = modal.querySelectorAll(".mon-tag-row");
    const newTags = [];
    rows.forEach(row => {
      const icon = row.querySelector(".mon-tag-icon-in")?.value.trim() || "🏷";
      const name = row.querySelector(".mon-tag-name-in")?.value.trim() || "";
      const kwRaw = row.querySelector(".mon-tag-kw-in")?.value || "";
      const keywords = kwRaw.split(",").map(k => k.trim()).filter(Boolean);
      if (name) newTags.push({ id: row.dataset.tagId || ("tag_" + Date.now()), icon, name, keywords });
    });
    _saveTags(newTags);
    _closeSettingsModal(modal);
    _refreshThumbTags();
    if (window.appToast) window.appToast("Теги збережено", "success");
  }

  function _closeSettingsModal(modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }

  function _refreshThumbTags() {
    _playlist.querySelectorAll(".mon-thumb").forEach(thumb => {
      const previewEl = thumb.querySelector(".mon-thumb-preview");
      const previewText = previewEl?.textContent || "";
      const matched = _matchTags(previewText);
      let tagsEl = thumb.querySelector(".mon-thumb-tags");

      if (matched.length) {
        if (!tagsEl) { tagsEl = document.createElement("div"); tagsEl.className = "mon-thumb-tags"; thumb.appendChild(tagsEl); }
        tagsEl.innerHTML = matched.map(t =>
          `<span class="mon-tag-icon" title="${_esc(t.name)}">${_esc(t.icon)}</span>`
        ).join("");
      } else if (tagsEl) {
        tagsEl.remove();
      }
    });
  }

  /* ═════════════════════════════════════════
     Mark all read
  ═════════════════════════════════════════ */

  async function _markAllRead() {
    try {
      const res  = await fetch("/api/monitor/read-all", { method: "POST" });
      const data = await res.json();
      if (!data.ok) return;
      _playlist.querySelectorAll(".mon-thumb--unread").forEach(el => el.classList.remove("mon-thumb--unread"));
      _syncUnreadBadge();
      if (window.appToast) window.appToast(`Позначено прочитаними: ${data.count}`, "success");
    } catch (e) { console.error("[monitor] markAllRead", e); }
  }

  /* ═════════════════════════════════════════
     Polling
  ═════════════════════════════════════════ */

  function _startPolling() {
    _stopPolling();
    _pollTimer = setInterval(() => { if (_active) _pollNew(); }, POLL_MS);
  }
  function _stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  /* ═════════════════════════════════════════
     UI sync helpers
  ═════════════════════════════════════════ */

  function _syncShowMore() {
    if (!_showMoreBtn) return;
    _showMoreBtn.classList.toggle("hidden", _offset >= _total);
  }

  function _syncUnreadBadge() {
    if (!_unreadBadge) return;
    const n = _playlist.querySelectorAll(".mon-thumb--unread").length;
    _unreadBadge.textContent = n > 0 ? String(n) : "";
    _unreadBadge.style.display = n > 0 ? "inline-flex" : "none";
  }

  /* ─── escape HTML ─── */
  function _esc(s) {
    return String(s ?? "")
      .replace(/&/g,"&amp;").replace(/</g,"&lt;")
      .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  /* ═════════════════════════════════════════
     Analytics column
  ═════════════════════════════════════════ */

  const LS_TEMPLATES = "monitorTemplates_v1";
  const LS_SEND_CHAT = "monitorSendChat_v1";
  const DEFAULT_TEMPLATES = [
    { id: "bpla",  name: "БпЛА",     texts: [] },
    { id: "inf",   name: "Піхота",   texts: [] },
    { id: "tech",  name: "Техніка",  texts: [] },
    { id: "arty",  name: "Артилерія",texts: [] },
  ];

  let _analMap      = null;   // Leaflet map instance
  let _analMarker   = null;   // current marker
  let _sendChatId   = "";
  let _sendChatName = "";
  let _sendPlatform = "signal";
  let _templates    = _loadTemplates();

  function _loadTemplates() {
    try { const s = localStorage.getItem(LS_TEMPLATES); if (s) return JSON.parse(s); } catch(_){}
    return DEFAULT_TEMPLATES.map(t => ({...t}));
  }
  function _saveTemplates() {
    try { localStorage.setItem(LS_TEMPLATES, JSON.stringify(_templates)); } catch(_){}
  }

  /* ── Middle toolbar + playlist navigation ── */
  function _initMiddleToolbar() {
    document.getElementById("monNavPrev")?.addEventListener("click", () => _navigatePanel(-1));
    document.getElementById("monNavNext")?.addEventListener("click", () => _navigatePanel(+1));
    document.getElementById("monPlaylistPrev")?.addEventListener("click", () => _navigatePanel(-1));
    document.getElementById("monPlaylistNext")?.addEventListener("click", () => _navigatePanel(+1));

    // Share button
    document.getElementById("monShareBtn")?.addEventListener("click", _openShareModal);

    // Open Висновок tab with current intercept pre-filled
    document.getElementById("monOpenConclusion")?.addEventListener("click", () => {
      if (!_currentItem) return;
      // Switch to Висновок tab
      if (window.itSetTab) window.itSetTab("conclusion");
      // Pre-fill conclusion textarea with intercept text
      setTimeout(() => {
        const ta = document.getElementById("conclText");
        if (ta && !ta.value.trim()) {
          ta.value = _buildPasteText(_currentItem);
        }
        // Render intercept detail in conclusion tab
        const conclDetail = document.getElementById("conclDetail");
        if (conclDetail && window.interceptsExplorerMountCard) {
          window.interceptsExplorerMountCard(_currentItem.id, conclDetail);
        }
      }, 100);
    });
  }

  function _syncToolbarPos() { /* counter removed */ }

  /* ── Init analytics column (monitoring tab — coord+map only, no conclusion) ── */
  function _initAnalyticsColumn() {
    /* Send bar — monitoring tab (monSendPlatformBtn etc. no longer in HTML; skip gracefully) */
    _loadSendChat();
  }

  /* ── Map ── */
  function _initAnalMap() {
    const el = document.getElementById("monAnalMap");
    if (!el || _analMap || typeof L === "undefined") return;

    _analMap = L.map(el, { center: [48.5, 37.5], zoom: 10, zoomControl: true });
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Esri", maxZoom: 19 }
    ).addTo(_analMap);
  }

  function _onCoordChange(raw, jumpNow) {
    const clean = (raw || "").trim().replace(/\s+/g, "").toUpperCase();
    if (!clean || clean.length < 6) return;
    try {
      if (typeof window.mgrs === "undefined" || !window.mgrs.toPoint) return;
      const pt  = window.mgrs.toPoint(clean);
      if (!Array.isArray(pt) || pt.length < 2) return;
      const lat = Number(pt[1]), lon = Number(pt[0]);
      if (!isFinite(lat) || !isFinite(lon)) return;

      if (!_analMap) _initAnalMap();
      if (!_analMap) return;

      if (_analMarker) { _analMarker.remove(); _analMarker = null; }
      _analMarker = L.circleMarker([lat, lon], {
        radius: 8, color: "#f59e0b", fillColor: "#f59e0b",
        fillOpacity: .8, weight: 2,
      }).addTo(_analMap);

      if (jumpNow) _analMap.setView([lat, lon], Math.max(_analMap.getZoom(), 13));
    } catch(_) {}
  }

  /* ── Paste intercept info into conclusion ── */
  function _pasteIntercept() {
    if (!_currentItem) return;
    const ta = document.getElementById("monConclusionText");
    if (!ta) return;
    const dt      = _fmtDatetime(_currentItem.created_at || "");
    const freq    = _currentItem.network?.frequency || "";
    const netDesc = _currentItem.net_description || "";
    const unit    = _currentItem.network?.unit || "";
    const text    = _currentItem.text || "";
    const cs      = (_currentItem.callsigns || []).map(c => c.name).join(", ");

    const lines = [dt, freq, netDesc, unit, cs ? `Позивні: ${cs}` : "", "", text]
      .filter(Boolean).join("\n");
    ta.value = lines;
    ta.focus();
  }

  /* ── Templates modal ── */
  function _openTemplatesModal() {
    let modal = document.getElementById("monTemplatesModal");
    if (!modal) modal = _createTemplatesModal();
    _renderTemplatesModal(modal, 0, false);
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }

  function _createTemplatesModal() {
    const modal = document.createElement("div");
    modal.id = "monTemplatesModal";
    modal.className = "modal hidden";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML =
      `<div class="modal-backdrop" data-close-tmpl="1"></div>` +
      `<div class="modal-card" role="dialog" aria-modal="true" style="max-width:680px;min-height:420px">` +
        `<div class="modal-head">` +
          `<div><div class="small" style="opacity:.65">Моніторинг</div><div style="font-weight:700">Шаблони висновків</div></div>` +
          `<div style="display:flex;gap:8px">` +
            `<button class="secondary" id="monTmplEditToggle" style="font-size:12px">✏ Редагувати</button>` +
            `<button class="secondary" data-close-tmpl="1">Закрити</button>` +
          `</div>` +
        `</div>` +
        `<div class="modal-body" id="monTmplBody"></div>` +
      `</div>`;

    modal.addEventListener("click", e => {
      if (e.target.closest("[data-close-tmpl]")) {
        modal.classList.add("hidden");
        modal.setAttribute("aria-hidden", "true");
      }
    });
    document.getElementById("monTmplEditToggle")?.addEventListener("click", function() {
      const isEdit = this.dataset.mode === "edit";
      this.dataset.mode = isEdit ? "" : "edit";
      this.textContent  = isEdit ? "✏ Редагувати" : "✓ Готово";
      _renderTemplatesModal(modal, _tmplActiveCat, !isEdit);
    });

    document.body.appendChild(modal);
    return modal;
  }

  let _tmplActiveCat = 0;

  function _renderTemplatesModal(modal, catIdx, editMode) {
    _tmplActiveCat = catIdx;
    const body = modal.querySelector("#monTmplBody");
    if (!body) return;

    const cat = _templates[catIdx];

    /* Category tabs */
    const catTabsHtml = _templates.map((t, i) =>
      `<button class="mon-tmpl-cat-btn${i === catIdx ? " active" : ""}" data-cat="${i}">${_esc(t.name)}</button>`
    ).join("") + (editMode
      ? `<button class="mon-tmpl-cat-btn" id="monTmplAddCat" style="border-style:dashed">+ Категорія</button>`
      : "");

    /* Template texts */
    let textsHtml = "";
    if (cat) {
      if (editMode) {
        textsHtml = (cat.texts || []).map((txt, ti) =>
          `<div class="mon-tmpl-edit-row">` +
            `<input class="mon-tmpl-txt-in" data-ti="${ti}" value="${_esc(txt)}">` +
            `<button class="secondary mon-anal-sm-btn mon-tmpl-del-txt" data-ti="${ti}">✕</button>` +
          `</div>`
        ).join("") +
        `<div class="mon-tmpl-edit-row">` +
          `<button class="secondary mon-anal-sm-btn" id="monTmplAddTxt">+ Додати висновок</button>` +
          (editMode ? `<button class="secondary mon-anal-sm-btn mon-tmpl-del-cat" style="border-color:#7f1d1d;color:#fca5a5">🗑 Категорію</button>` : "") +
        `</div>`;
      } else {
        textsHtml = cat.texts.length
          ? cat.texts.map((txt, ti) =>
              `<button class="mon-tmpl-text-btn" data-ti="${ti}">${_esc(txt)}</button>`
            ).join("")
          : `<div class="mon-empty" style="padding:24px">Немає шаблонів. Перейдіть у «Редагувати».</div>`;
      }
    }

    body.innerHTML =
      `<div class="mon-tmpl-cats" id="monTmplCats">${catTabsHtml}</div>` +
      `<div class="mon-tmpl-texts" id="monTmplTexts">${textsHtml}</div>`;

    /* Bind category tabs */
    body.querySelectorAll(".mon-tmpl-cat-btn[data-cat]").forEach(btn => {
      btn.addEventListener("click", () => _renderTemplatesModal(modal, parseInt(btn.dataset.cat), editMode));
    });

    /* Bind "add category" */
    body.querySelector("#monTmplAddCat")?.addEventListener("click", () => {
      const name = prompt("Назва нової категорії:");
      if (!name?.trim()) return;
      _templates.push({ id: "cat_" + Date.now(), name: name.trim(), texts: [] });
      _saveTemplates();
      _renderTemplatesModal(modal, _templates.length - 1, editMode);
    });

    /* Bind "add text" */
    body.querySelector("#monTmplAddTxt")?.addEventListener("click", () => {
      cat.texts.push("");
      _saveTemplates();
      _renderTemplatesModal(modal, catIdx, editMode);
    });

    /* Bind "delete category" */
    body.querySelector(".mon-tmpl-del-cat")?.addEventListener("click", () => {
      if (!confirm(`Видалити категорію «${cat.name}»?`)) return;
      _templates.splice(catIdx, 1);
      _saveTemplates();
      _renderTemplatesModal(modal, Math.max(0, catIdx - 1), editMode);
    });

    /* Bind delete text buttons */
    body.querySelectorAll(".mon-tmpl-del-txt").forEach(btn => {
      btn.addEventListener("click", () => {
        cat.texts.splice(parseInt(btn.dataset.ti), 1);
        _saveTemplates();
        _renderTemplatesModal(modal, catIdx, editMode);
      });
    });

    /* Bind text inputs (save on blur) */
    body.querySelectorAll(".mon-tmpl-txt-in").forEach(inp => {
      inp.addEventListener("blur", () => {
        cat.texts[parseInt(inp.dataset.ti)] = inp.value;
        _saveTemplates();
      });
    });

    /* Bind click-to-insert (browse mode) */
    if (!editMode) {
      body.querySelectorAll(".mon-tmpl-text-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          const ta = document.getElementById("monConclusionText");
          if (ta) {
            const cur = ta.value.trim();
            ta.value = cur ? cur + "\n" + cat.texts[parseInt(btn.dataset.ti)] : cat.texts[parseInt(btn.dataset.ti)];
            ta.focus();
          }
          modal.classList.add("hidden");
          modal.setAttribute("aria-hidden", "true");
        });
      });
    }
  }

  /* ── Send functionality ── */
  function _loadSendChat() {
    // Restore from localStorage first (immediate)
    try {
      const saved = JSON.parse(localStorage.getItem(LS_SEND_CHAT) || "null");
      if (saved?.id) {
        _sendChatId   = saved.id;
        _sendChatName = saved.name || "";
        if (saved.platform) { _sendPlatform = saved.platform; _updatePlatformBtn(); }
        _syncSendBar();
      }
    } catch(_){}

    // Load platform + chat from server settings (authoritative)
    fetch("/api/settings?keys=delta_chat_id,delta_chat_name,delta_platform")
      .then(r => r.json())
      .then(d => {
        const srv = d.settings || {};
        if (srv.delta_platform) {
          _sendPlatform = srv.delta_platform;
          _allChats = null; // reset cache for correct platform
          _updatePlatformBtn();
        }
        if (srv.delta_chat_id && !_sendChatId) {
          _sendChatId   = srv.delta_chat_id;
          _sendChatName = srv.delta_chat_name || "";
          _syncSendBar();
        }
      })
      .catch(() => {});
  }

  let _allChats    = null;   // cached chat list
  let _chatsLoading = false;

  function _syncSendBar() { _syncAllSendBars(); }

  function _updatePlatformBtn() {
    const btn = document.getElementById("monSendPlatformBtn");
    if (!btn) return;
    const _pi = _platformInfo(_sendPlatform);
    btn.textContent = _pi.label; btn.style.background = _pi.color;
  }

  function _initChatInput() {
    const inp  = document.getElementById("monSendChatInput");
    const drop = document.getElementById("monSendChatDrop");
    if (!inp || !drop) return;

    let _closeTimer = null;

    inp.addEventListener("focus", async () => {
      if (!_allChats && !_chatsLoading) {
        _showDropLoading();
        await _loadChats();
      }
      _renderChatDrop(inp.value);
    });

    inp.addEventListener("input", () => {
      _sendChatId = "";
      const sendBtn = document.getElementById("monSendBtn");
      if (sendBtn) sendBtn.disabled = true;
      if (_allChats) _renderChatDrop(inp.value);
    });

    inp.addEventListener("blur", () => {
      _closeTimer = setTimeout(() => drop.classList.add("hidden"), 200);
    });

    drop.addEventListener("mousedown", () => clearTimeout(_closeTimer));
  }

  function _showDropLoading() {
    const drop = document.getElementById("monSendChatDrop");
    if (!drop) return;
    drop.innerHTML = `<div class="mon-chat-drop-item" style="opacity:.45">Завантаження…</div>`;
    drop.classList.remove("hidden");
  }

  async function _loadChats() {
    _chatsLoading = true;
    try {
      const r = await fetch(`/api/push/chats?platform=${_sendPlatform}&only_groups=1`);
      const d = await r.json();
      _allChats = (d.ok && Array.isArray(d.chats)) ? d.chats : [];
    } catch(_) { _allChats = []; }
    _chatsLoading = false;
  }

  /** Load chats for a given platform. Per-platform cache.
   *  only_groups=0 → contacts + groups (WhatsApp supports both)
   *  Signal may return empty if not configured on the server.
   */
  async function _loadChatsForPlatform(platform) {
    if (_shareChatsCache[platform]) return _shareChatsCache[platform];
    try {
      const r = await fetch(`/api/push/chats?platform=${platform}&only_groups=0`);
      const d = await r.json();
      _shareChatsCache[platform] = (d.ok && Array.isArray(d.chats)) ? d.chats : [];
    } catch(_) { _shareChatsCache[platform] = []; }
    return _shareChatsCache[platform];
  }

  function _renderChatDrop(query) {
    const drop = document.getElementById("monSendChatDrop");
    if (!drop || !_allChats) return;
    const q = (query || "").trim().toLowerCase();
    const filtered = _allChats.filter(c =>
      !q || c.name.toLowerCase().includes(q)
    ).slice(0, 40);

    if (!filtered.length) {
      drop.innerHTML = `<div class="mon-chat-drop-item" style="opacity:.45">Чатів не знайдено</div>`;
      drop.classList.remove("hidden");
      return;
    }

    drop.innerHTML = "";
    filtered.forEach(chat => {
      const item = document.createElement("div");
      item.className = "mon-chat-drop-item";
      item.innerHTML =
        `<span>${_esc(chat.name)}</span>` +
        `<span class="mon-chat-drop-type">група</span>`;
      item.addEventListener("mousedown", e => {
        e.preventDefault();
        _sendChatId   = chat.id;
        _sendChatName = chat.name;
        const inp = document.getElementById("monSendChatInput");
        if (inp) inp.value = chat.name;
        try { localStorage.setItem(LS_SEND_CHAT, JSON.stringify({ id: chat.id, name: chat.name, platform: _sendPlatform })); } catch(_){}
        const sendBtn = document.getElementById("monSendBtn");
        if (sendBtn) sendBtn.disabled = false;
        drop.classList.add("hidden");
      });
      drop.appendChild(item);
    });
    drop.classList.remove("hidden");
  }

  function _togglePlatform() {
    const idx  = _PLATFORMS.findIndex(p => p.id === _sendPlatform);
    const next = _PLATFORMS[(idx + 1) % _PLATFORMS.length];
    _sendPlatform = next.id;
    _allChats     = null;
    _sendChatId   = "";
    _sendChatName = "";
    _updatePlatformBtn();
    const inp = document.getElementById("monSendChatInput");
    if (inp) inp.value = "";
    const sendBtn = document.getElementById("monSendBtn");
    if (sendBtn) sendBtn.disabled = true;
  }

  async function _sendConclusion() {
    if (!_sendChatId) return;
    const ta    = document.getElementById("monConclusionText");
    const coord = (document.getElementById("monCoordInput")?.value || "").trim();
    let text    = (ta?.value || "").trim();
    if (coord) text = (text ? text + "\n\n" : "") + `📍 ${coord}`;
    if (!text) { if (window.appToast) window.appToast("Введіть текст висновку", "warn"); return; }

    const btn = document.getElementById("monSendBtn");
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    try {
      const res = await fetch("/api/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: _sendPlatform, chat_id: _sendChatId, text }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        if (window.appToast) window.appToast("Висновок надіслано", "success");
      } else {
        if (window.appToast) window.appToast(data.error || "Помилка надсилання", "error");
      }
    } catch(e) {
      if (window.appToast) window.appToast("Помилка: " + e.message, "error");
    } finally {
      if (btn) { btn.disabled = !_sendChatId; btn.textContent = "▶"; }
    }
  }

  /* ═════════════════════════════════════════
     Share modal — send intercept to multiple recipients
  ═════════════════════════════════════════ */

  const LS_RECIPIENTS = "monitorRecipients_v1";

  function _loadRecipients() {
    try { const s = localStorage.getItem(LS_RECIPIENTS); if (s) return JSON.parse(s); } catch(_){}
    return [];
  }
  function _saveRecipients(list) {
    try { localStorage.setItem(LS_RECIPIENTS, JSON.stringify(list)); } catch(_){}
  }

  // Share chats cache: platform → chats[]
  let _shareChatsCache = {};

  function _openShareModal() {
    let modal = document.getElementById("monShareModal");
    if (!modal) modal = _createShareModal();
    _renderShareRows(modal);
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }

  function _createShareModal() {
    const modal = document.createElement("div");
    modal.id        = "monShareModal";
    modal.className = "modal hidden";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML =
      `<div class="modal-backdrop" data-close-share="1"></div>` +
      `<div class="modal-card" role="dialog" aria-modal="true" style="max-width:600px">` +
        `<div class="modal-head">` +
          `<div>` +
            `<div class="small" style="opacity:.65">Моніторинг</div>` +
            `<div style="font-weight:700">Поширити перехоплення</div>` +
          `</div>` +
          `<button class="secondary" data-close-share="1" style="width:32px;height:32px;padding:0;font-size:14px">✕</button>` +
        `</div>` +
        `<div class="modal-body" style="padding-bottom:4px;overflow:visible">` +
          `<div id="monShareRows" class="mon-share-rows"></div>` +
        `</div>` +
        `<div class="modal-foot" style="justify-content:space-between">` +
          `<button class="secondary" id="monShareAddBtn" style="font-size:18px;width:36px;height:36px;padding:0">+</button>` +
          `<button class="mon-send-submit-btn" id="monShareSendBtn" title="Надіслати обраним" style="width:48px;border-radius:8px">▶</button>` +
        `</div>` +
      `</div>`;

    modal.addEventListener("click", e => {
      if (e.target.closest("[data-close-share]")) _closeShareModal(modal);
    });
    modal.querySelector("#monShareAddBtn")?.addEventListener("click",  () => _addShareRow(modal));
    modal.querySelector("#monShareSendBtn")?.addEventListener("click", () => _sendToRecipients(modal));
    document.body.appendChild(modal);
    return modal;
  }

  function _renderShareRows(modal) {
    const container = modal.querySelector("#monShareRows");
    if (!container) return;
    const list = _loadRecipients();
    if (!list.length) {
      list.push({ id: "r_" + Date.now(), platform: _sendPlatform, chatId: "", chatName: "", checked: true });
      _saveRecipients(list);
    }
    container.innerHTML = list.map(r => _shareRowHtml(r)).join("");
    _attachShareRowEvents(container, modal);
  }

  function _shareRowHtml(r) {
    const pi = _platformInfo(r.platform);
    return `<div class="mon-share-row" data-rid="${_esc(r.id)}">` +
      /* checkbox */
      `<input type="checkbox" class="mon-share-chk" ${r.checked ? "checked" : ""}>` +
      /* same send-bar structure: platform | input | delete */
      `<div class="mon-send-bar" style="flex:1;border-top:none">` +
        `<button class="mon-send-platform-btn mon-share-platform" data-rid="${_esc(r.id)}" ` +
                `style="background:${pi.color};border-radius:0">${pi.label}</button>` +
        `<div class="mon-send-middle" style="position:relative">` +
          `<input class="mon-send-chat-input mon-share-chat-in" type="text"` +
                 ` placeholder="Назва чату або контакта…"` +
                 ` value="${_esc(r.chatName)}" autocomplete="off" data-rid="${_esc(r.id)}">` +
          `<div class="mon-send-chat-drop mon-share-drop hidden" data-rid="${_esc(r.id)}"></div>` +
        `</div>` +
        /* red delete button in place of orange send */
        `<button class="mon-send-submit-btn mon-share-del" data-rid="${_esc(r.id)}" ` +
                `style="background:#dc2626" title="Видалити">✕</button>` +
      `</div>` +
    `</div>`;
  }

  function _attachShareRowEvents(container, modal) {
    // Platform toggle (cycles S→W→T)
    container.querySelectorAll(".mon-share-platform").forEach(btn => {
      btn.addEventListener("click", () => {
        const rid  = btn.dataset.rid;
        const list = _loadRecipients();
        const r    = list.find(x => x.id === rid);
        if (!r) return;
        const idx  = _PLATFORMS.findIndex(p => p.id === r.platform);
        const next = _PLATFORMS[(idx + 1) % _PLATFORMS.length];
        r.platform = next.id;
        r.chatId   = ""; r.chatName = "";
        _saveRecipients(list);
        _renderShareRows(modal);
      });
    });

    // Delete buttons
    container.querySelectorAll(".mon-share-del").forEach(btn => {
      btn.addEventListener("click", () => {
        const rid  = btn.dataset.rid;
        const list = _loadRecipients().filter(r => r.id !== rid);
        _saveRecipients(list);
        _renderShareRows(modal);
      });
    });

    // Checkbox save
    container.querySelectorAll(".mon-share-chk").forEach(chk => {
      const rid = chk.closest(".mon-share-row")?.dataset.rid;
      chk.addEventListener("change", () => {
        const list = _loadRecipients();
        const r    = list.find(x => x.id === rid);
        if (r) { r.checked = chk.checked; _saveRecipients(list); }
      });
    });

    // Chat input — autocomplete (reuse shared cache per platform)
    container.querySelectorAll(".mon-share-chat-in").forEach(inp => {
      const rid  = inp.dataset.rid;
      const drop = container.querySelector(`.mon-share-drop[data-rid="${rid}"]`);
      if (!drop) return;
      let closeTimer = null;

      inp.addEventListener("focus", async () => {
        const list = _loadRecipients();
        const r    = list.find(x => x.id === rid);
        if (!r) return;
        if (!_shareChatsCache[r.platform]) {
          _showDropLoadingEl(drop);
          await _loadChatsForPlatform(r.platform);
        }
        _renderShareDropEl(inp, drop, rid, inp.value, modal);
      });

      inp.addEventListener("input", () => {
        const list = _loadRecipients();
        const r    = list.find(x => x.id === rid);
        if (r) { r.chatId = ""; _saveRecipients(list); }
        const platform = r?.platform || "signal";
        if (_shareChatsCache[platform]) _renderShareDropEl(inp, drop, rid, inp.value, modal);
      });

      inp.addEventListener("blur",  () => { closeTimer = setTimeout(() => drop.classList.add("hidden"), 200); });
      drop.addEventListener("mousedown", () => clearTimeout(closeTimer));
    });
  }

  function _renderShareDropEl(inp, drop, rid, query, modal) {
    const list     = _loadRecipients();
    const r        = list.find(x => x.id === rid);
    const chats    = _shareChatsCache[r?.platform || "signal"] || [];
    const q        = (query || "").trim().toLowerCase();
    const filtered = chats.filter(c => !q || c.name.toLowerCase().includes(q)).slice(0, 40);

    if (!filtered.length) {
      drop.innerHTML = `<div class="mon-chat-drop-item" style="opacity:.45">Не знайдено</div>`;
      drop.classList.remove("hidden");
      return;
    }
    drop.innerHTML = "";
    filtered.forEach(chat => {
      const item = document.createElement("div");
      item.className = "mon-chat-drop-item";
      const typeLabel = chat.type === "private" ? "особист." : "група";
      item.innerHTML = `<span>${_esc(chat.name)}</span><span class="mon-chat-drop-type">${typeLabel}</span>`;
      item.addEventListener("mousedown", e => {
        e.preventDefault();
        inp.value = chat.name;
        const l = _loadRecipients();
        const rx = l.find(x => x.id === rid);
        if (rx) { rx.chatId = chat.id; rx.chatName = chat.name; _saveRecipients(l); }
        drop.classList.add("hidden");
      });
      drop.appendChild(item);
    });
    drop.classList.remove("hidden");
  }

  function _addShareRow(modal) {
    const list = _loadRecipients();
    // Default to currently active platform (same as Висновок bar)
    list.push({ id: "r_" + Date.now(), platform: _sendPlatform, chatId: "", chatName: "", checked: true });
    _saveRecipients(list);
    _renderShareRows(modal);
  }

  async function _sendToRecipients(modal) {
    if (!_currentItem) { if (window.appToast) window.appToast("Оберіть перехоплення", "warn"); return; }
    const list     = _loadRecipients();
    const selected = list.filter(r => r.checked && r.chatId);
    if (!selected.length) { if (window.appToast) window.appToast("Оберіть чати або введіть контакти", "warn"); return; }

    const text = _buildPasteText(_currentItem);
    const btn  = modal.querySelector("#monShareSendBtn");
    if (btn) { btn.disabled = true; btn.textContent = "…"; }

    let sent = 0, errors = 0;
    for (const r of selected) {
      try {
        const res = await fetch("/api/push/send", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: r.platform, chat_id: r.chatId, text }),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d.ok) sent++;
        else errors++;
      } catch(_) { errors++; }
    }

    if (btn) { btn.disabled = false; btn.textContent = "▶ Надіслати обраним"; }
    if (window.appToast) {
      if (sent > 0)    window.appToast(`Надіслано: ${sent}`, "success");
      if (errors > 0)  window.appToast(`Помилок: ${errors}`, "error");
    }
    if (errors === 0) _closeShareModal(modal);
  }

  function _closeShareModal(modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }

})();
