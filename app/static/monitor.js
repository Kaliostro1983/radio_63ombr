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
  let _maxLoadedId  = 0;    // найбільший id, який клієнт уже бачив у плейлисті
                            // (за ним polling запитує нові — будь-які INSERT id>X,
                            // незалежно від created_at у тілі; це ловить «запізнілі»
                            // повідомлення, у яких час із тіла — у минулому)
  const _loadedIds  = new Set();   // дедуп при змішуванні pagination та polling
  let _offset      = 0;
  let _total       = 0;
  let _activeThumb = null;
  let _currentItem = null;
  let _tags        = _loadTags();

  /* DOM refs (set in initMonitor) */
  let _playlist, _detail, _markAllBtn, _showMoreBtn, _unreadBadge, _settingsBtn;

  /* ═════════════════════════════════════════
     Tags helpers
     Storage: server (app_settings.monitor_tags_json) — shared across users.
     localStorage = lokal cache для миттєвого UI до приходу даних з сервера.
     Race protection: _tagsServerLoaded flag блокує push, доки не довантажено
     авторитетний стан (інакше кеш з DEFAULTS перетер би чужі зміни).
  ═════════════════════════════════════════ */

  let _tagsServerLoaded = false;
  let _tagsPushTimer    = null;
  let _tagsPushPending  = false;

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
    _tagsPushServer();
  }

  /* Push поточний _tags на сервер. Debounce 300 мс. Якщо ще не довантажились
   * з сервера — буферизуємо до моменту завершення _tagsServerLoad. */
  function _tagsPushServer() {
    if (!_tagsServerLoaded) {
      _tagsPushPending = true;
      return;
    }
    if (_tagsPushTimer) clearTimeout(_tagsPushTimer);
    _tagsPushTimer = setTimeout(_tagsPushNow, 300);
  }

  function _tagsPushNow() {
    _tagsPushTimer = null;
    fetch("/api/monitor-tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: _tags }),
    })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
      .catch(err => {
        if (window.appToast) {
          window.appToast(`Теги не збережено: ${err.message || err}`, "error", 4000);
        }
        console.warn("[monitor] _tagsPushServer failed:", err);
      });
  }

  /* Завантажити спільні теги з сервера. При першому відвідуванні (server
   * повертає null) — лишаємо локальні DEFAULTS і піднімаємо прапорець:
   * перший save цього клієнта запишеться як початковий стан. */
  async function _tagsServerLoad() {
    try {
      const r = await fetch("/api/monitor-tags");
      const j = await r.json();
      if (!j || !j.ok) return;
      if (Array.isArray(j.tags)) {
        _tags = j.tags;
        try { localStorage.setItem(LS_TAGS, JSON.stringify(_tags)); } catch (_) {}
        _refreshThumbTags?.();
        // Якщо tags-модалка відкрита — перерендерити з новими даними.
        const modal = document.getElementById("monTagsModal");
        if (modal && !modal.classList.contains("hidden")) _renderTagRows(modal);
      }
      _tagsServerLoaded = true;
      if (_tagsPushPending) {
        _tagsPushPending = false;
        _tagsPushServer();
      }
    } catch (err) {
      console.warn("[monitor] _tagsServerLoad failed, push disabled:", err);
      if (window.appToast) {
        window.appToast("Не вдалось завантажити теги з сервера. Зміни не зберігатимуться, поки зв'язок не відновиться.", "warn", 6000);
      }
    }
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

    // Спільні (серверні) теги плейлиста — перетерти локальний кеш
    _tagsServerLoad();

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
  let _conclMap          = null;
  let _conclMarker       = null;   // legacy (unused now)
  let _conclClickMarker  = null;   // Interactive marker (map click)
  let _conclMarkerPicked = false;  // interactive marker state
  let _conclCoordFmt     = "MGRS"; // "MGRS" | "УСК"
  let _conclFixedMarkers = [];     // [{marker, lat, lon, chipEl}] — фіксовані точки
  let _conclSaved = false;         // чи збережено поточний висновок у БД
  let _conclSaveWired = false;     // одноразова прив'язка save-кнопки/слухачів
  let _zoneLayers = { freq: null, unit: null };  // шари зон-«очей» (по частоті / підрозділу)
  let _unitPalLayers = {};                       // палітра_id -> шар регіонів (перелік палітр підрозділу)
  let _lastPalCtxKey = null;                     // ключ останнього контексту палітр (unit|network) для скидання scope
  let _conclDrawn        = [];     // [{type, layers:[...]}] — стрілки/зони/орієнтири
  let _conclBelowRenderer = null;  // canvas-рендерер нижче квадратів/точок (Зона, Орієнтир)
  let _conclAboveRenderer = null;  // canvas-рендерер вище всього (Стрілка)

  /* Convert lat/lon → MGRS string ("37U DQ 23795 23032") */
  function _latLonToMgrs(lat, lon) {
    try {
      const raw = window.mgrs.forward([lon, lat], 5);
      const m   = raw.match(/^(\d{1,2}[A-Z])([A-Z]{2})(\d+)$/);
      if (!m) return raw;
      const [, gzd, sq, nums] = m;
      const half = Math.floor(nums.length / 2);
      return `${gzd} ${sq} ${nums.slice(0, half)} ${nums.slice(half)}`;
    } catch(_) { return ""; }
  }

  /* Convert lat/lon → УСК-2000 прямокутні (X northing, Y easting із зоною) */
  function _latLonToUsk(lat, lon) {
    if (typeof proj4 === "undefined") return "";
    const zone = Math.floor(lon / 6) + 1;          // 6° зони
    const lon0 = zone * 6 - 3;
    const x0   = zone * 1000000 + 500000;
    const def  = `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${x0} +y_0=0 ` +
                 `+ellps=krass +towgs84=24,-123,-94,0.02,-0.25,-0.13,1.1 +units=m +no_defs`;
    const wgs  = "+proj=longlat +datum=WGS84 +no_defs";
    try {
      const out = proj4(wgs, def, [lon, lat]); // → [easting(Y), northing(X)]
      return `${Math.round(out[1])} ${Math.round(out[0])}`;
    } catch(_) { return ""; }
  }

  function _getConclCoord(lat, lon) {
    return _conclCoordFmt === "MGRS" ? _latLonToMgrs(lat, lon) : _latLonToUsk(lat, lon);
  }

  /* ── СК-42 (Pulkovo 1942 / Gauss-Krüger) → WGS84 ──
     x = northing (5428000), y = easting із префіксом зони (7417000) */
  function _sk42ToLatLon(x, y) {
    if (typeof proj4 === "undefined") return null;
    const zone = Math.floor(y / 1000000);            // 7417000 → зона 7
    const lon0 = zone * 6 - 3;                        // зона 7 → ЦМ 39°
    const x0   = zone * 1000000 + 500000;            // хибний схід 7500000
    const sk42 = `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${x0} +y_0=0 ` +
                 `+ellps=krass +towgs84=23.92,-141.27,-80.9,0,0.35,0.82,-0.12 +units=m +no_defs`;
    const wgs  = "+proj=longlat +datum=WGS84 +no_defs";
    try {
      const out = proj4(sk42, wgs, [y, x]); // [easting, northing] → [lon, lat]
      return { lat: out[1], lon: out[0] };
    } catch(_) { return null; }
  }

  /* УСК-2000 прямокутні (X northing, Y easting із зоною) → WGS84 */
  function _usk2000ToLatLon(x, y) {
    if (typeof proj4 === "undefined") return null;
    const zone = Math.floor(y / 1000000);
    const lon0 = zone * 6 - 3;
    const x0   = zone * 1000000 + 500000;
    const def  = `+proj=tmerc +lat_0=0 +lon_0=${lon0} +k=1 +x_0=${x0} +y_0=0 ` +
                 `+ellps=krass +towgs84=24,-123,-94,0.02,-0.25,-0.13,1.1 +units=m +no_defs`;
    const wgs  = "+proj=longlat +datum=WGS84 +no_defs";
    try {
      const out = proj4(def, wgs, [y, x]); // [easting, northing] → [lon, lat]
      return { lat: out[1], lon: out[0] };
    } catch(_) { return null; }
  }

  /* Равлик (snail) 3×3 нумерація в кілометровому квадраті:
       1 2 3
       8 9 4
       7 6 5   (row 0 = верх = більший northing) */
  function _snailCell(n) {
    const map = {
      1:[0,0], 2:[1,0], 3:[2,0],
      4:[2,1], 5:[2,2], 6:[1,2],
      7:[0,2], 8:[0,1], 9:[1,1],
    };
    return map[n] || null;
  }

  /* Малює квадрат за двома двозначними числами (+ опц. равлик).
     "28 17"   → X 5428000–5429000, Y 7417000–7418000 (1×1 км)
     "28 17 4" → менший квадрат (1/3 км) у комірці равлика 4 */
  function _addGridSquare(map, nn, mm, snail) {
    let xBase = 5400000 + nn * 1000; // northing (нижній)
    let yBase = 7400000 + mm * 1000; // easting (лівий)
    let size  = 1000;

    if (snail) {
      const cell = _snailCell(snail);
      if (!cell) return;
      const third = 1000 / 3;
      yBase = yBase + cell[0] * third;          // col зліва направо
      xBase = xBase + (2 - cell[1]) * third;    // row 0 = верх
      size  = third;
    }

    const corners = [
      _sk42ToLatLon(xBase,        yBase),        // BL
      _sk42ToLatLon(xBase,        yBase + size), // BR
      _sk42ToLatLon(xBase + size, yBase + size), // TR
      _sk42ToLatLon(xBase + size, yBase),        // TL
    ];
    if (corners.some(c => !c)) {
      if (window.appToast) window.appToast("Не вдалося побудувати квадрат", "error", 1600);
      return;
    }
    const latlngs = corners.map(c => [c.lat, c.lon]);
    const center  = _sk42ToLatLon(xBase + size / 2, yBase + size / 2);

    const layer = L.polygon(latlngs, {
      color: "#ef4444", weight: 2, fillColor: "#ef4444", fillOpacity: 0.35,
    }).addTo(map);

    // Червона точка в центрі квадрата
    const centerDot = center
      ? L.marker([center.lat, center.lon], {
          icon: L.divIcon({ className:"", iconSize:[12,12], iconAnchor:[6,6], html:`<div class="concl-square-dot"></div>` }),
          interactive: false,
        }).addTo(map)
      : null;

    const nnS = String(nn).padStart(2,"0");
    const mmS = String(mm).padStart(2,"0");
    const label = snail ? `${nnS} ${mmS} ${snail}` : `${nnS} ${mmS}`;

    const entry = { layer, centerDot, chipEl: null, isSquare: true, centerLatLon: center };
    const chipEl = _createSquareChip(label, () => {
      entry.layer.remove();
      if (entry.centerDot) entry.centerDot.remove();
      const idx = _conclFixedMarkers.indexOf(entry);
      if (idx !== -1) _conclFixedMarkers.splice(idx, 1);
      entry.chipEl.remove();
      _refreshConclCoords();
    });
    entry.chipEl = chipEl;
    _conclFixedMarkers.push(entry);

    const chipsContainer = document.getElementById("conclCoordChips");
    if (chipsContainer) chipsContainer.appendChild(chipEl);

    map.fitBounds(layer.getBounds(), { maxZoom: 15, padding: [40, 40] });
    _refreshConclCoords();
  }

  /* Перебудовує текстове поле "Координати" з усіх об'єктів карти */
  function _refreshConclCoords() {
    const ta = document.getElementById("conclCoords");
    if (!ta) return;
    const lines = _conclFixedMarkers.map((entry, i) => {
      let c;
      if (entry.isSquare) c = entry.centerLatLon;
      else                c = { lat: entry.lat, lon: entry.lon };
      const mgrs = c ? _latLonToMgrs(c.lat, c.lon) : "";
      return `${i + 1}. ${mgrs}`;
    });
    ta.value = lines.join("\n");
    _conclSaved = false;   // координати змінились → висновок не збережено
  }

  /* Chip для квадрата (показує "28 17") */
  function _createSquareChip(label, onDelete) {
    const el = document.createElement("div");
    el.className = "concl-coord-chip concl-coord-chip--square";
    el.innerHTML =
      `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".55">` +
        `<rect x="2.5" y="2.5" width="11" height="11" rx="1"/>` +
      `</svg>` +
      `<span class="concl-coord-chip-text">${_esc(label)}</span>` +
      `<button class="concl-coord-chip-close" title="Видалити">×</button>`;
    el.querySelector(".concl-coord-chip-close").addEventListener("click", onDelete);
    return el;
  }

  /* SVG icon factory */
  function _mkCrosshairIcon(lineColor, dotColor) {
    return L.divIcon({
      className: "",
      html: `<svg width="26" height="26" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg">
        <line x1="0"  y1="13" x2="8"  y2="13" stroke="${lineColor}" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="18" y1="13" x2="26" y2="13" stroke="${lineColor}" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="13" y1="0"  x2="13" y2="8"  stroke="${lineColor}" stroke-width="2.5" stroke-linecap="round"/>
        <line x1="13" y1="18" x2="13" y2="26" stroke="${lineColor}" stroke-width="2.5" stroke-linecap="round"/>
        <circle cx="13" cy="13" r="5" fill="${dotColor}" stroke="#fff" stroke-width="1.5"/>
      </svg>`,
      iconSize: [26, 26], iconAnchor: [13, 13],
    });
  }
  function _iconInitial() { return _mkCrosshairIcon("#f59e0b", "#ef4444"); } // жовті лінії, червона крапка

  // Вибрана точка — велике червоне кільце + жовта крапка всередині
  function _iconPicked() {
    return L.divIcon({
      className: "",
      html: `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <circle cx="16" cy="16" r="14" fill="rgba(239,68,68,0.22)" stroke="#ef4444" stroke-width="3"/>
        <circle cx="16" cy="16" r="5.5" fill="#f59e0b" stroke="#fff" stroke-width="2"/>
      </svg>`,
      iconSize:   [32, 32],
      iconAnchor: [16, 16],
    });
  }

  /* Створити chip-елемент для фіксованої точки */
  function _createCoordChip(lat, lon, onDelete, label) {
    const el   = document.createElement("div");
    el.className = "concl-coord-chip";
    const mgrs = _latLonToMgrs(lat, lon);
    const text = label ? label : mgrs;          // назва точки палітри або координата
    el.title   = label ? `${label} · ${mgrs}` : mgrs;
    el.innerHTML =
      `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".55">` +
        `<path d="M8 1.5a4.5 4.5 0 014.5 4.5c0 3.5-4.5 8.5-4.5 8.5S3.5 9.5 3.5 6A4.5 4.5 0 018 1.5z"/>` +
        `<circle cx="8" cy="6" r="1.5" fill="currentColor" stroke="none"/>` +
      `</svg>` +
      `<span class="concl-coord-chip-text">${_esc(text)}</span>` +
      `<button class="concl-coord-chip-close" title="Видалити">×</button>`;
    el.querySelector(".concl-coord-chip-close").addEventListener("click", onDelete);
    return el;
  }

  /* Відкрити popup фіксованого маркера (з "Видалити точку") */
  function _openFixedMarkerPopup(map, marker, lat, lon) {
    const popup = L.popup({
      closeButton: false, className: "concl-map-popup",
      maxWidth: 260, offset: L.point(0, -10),
    }).setContent(_buildConclPopupHtml(lat, lon, true));

    marker.unbindPopup().bindPopup(popup).openPopup();

    setTimeout(() => {
      const el = popup.getElement();
      if (!el) return;

      el.querySelector(".concl-cp-close")?.addEventListener("click", () => marker.closePopup());

      el.querySelector(".concl-cp-delete")?.addEventListener("click", () => {
        const idx = _conclFixedMarkers.findIndex(f => f.marker === marker);
        if (idx !== -1) {
          _conclFixedMarkers[idx].chipEl.remove();
          _conclFixedMarkers.splice(idx, 1);
        }
        marker.remove();
        _refreshConclCoords();
      });

      el.querySelector(".concl-cp-fmt")?.addEventListener("click", (e) => {
        e.stopPropagation();
        _conclCoordFmt = _conclCoordFmt === "MGRS" ? "УСК" : "MGRS";
        const coordEl = el.querySelector(".concl-cp-coord");
        const fmtEl   = el.querySelector(".concl-cp-fmt");
        if (coordEl) coordEl.textContent = _getConclCoord(lat, lon);
        if (fmtEl)   fmtEl.textContent   = _conclCoordFmt;
      });

      el.querySelector(".concl-cp-coord")?.addEventListener("click", (e) => {
        e.preventDefault();
        const c = _getConclCoord(lat, lon);
        if (window.clipboardWrite) window.clipboardWrite(c).then(ok => {
          if (ok && window.appToast) window.appToast("Скопійовано", "success", 1400);
        });
      });
    }, 0);
  }

  /* Додати фіксовану точку (з Enter або з "Вибрати точку").
     label — назва точки палітри (показується в чипі замість координати). */
  function _addFixedMarker(map, lat, lon, label) {
    const marker = L.marker([lat, lon], {
      icon: _iconPicked(),
      bubblingMouseEvents: false,
    }).addTo(map);

    const entry = { marker, lat, lon, chipEl: null, label: label || null };

    const chipEl = _createCoordChip(lat, lon, () => {
      entry.marker.remove();
      const idx = _conclFixedMarkers.indexOf(entry);
      if (idx !== -1) _conclFixedMarkers.splice(idx, 1);
      entry.chipEl.remove();
      _refreshConclCoords();
    }, label);

    entry.chipEl = chipEl;
    _conclFixedMarkers.push(entry);

    marker.on("click", () => _openFixedMarkerPopup(map, marker, lat, lon));

    const chipsContainer = document.getElementById("conclCoordChips");
    if (chipsContainer) chipsContainer.appendChild(chipEl);
    _refreshConclCoords();
  }

  /* Build popup HTML */
  function _buildConclPopupHtml(lat, lon, picked) {
    const coord  = _getConclCoord(lat, lon);
    const btnCls = picked ? "concl-cp-btn concl-cp-delete" : "concl-cp-btn concl-cp-select";
    const btnTxt = picked ? "ВИДАЛИТИ ТОЧКУ" : "ВИБРАТИ ТОЧКУ";
    const btnSvg = picked
      ? '<line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/>'
      : '<circle cx="10" cy="10" r="7"/><line x1="10" y1="3" x2="10" y2="7"/><line x1="10" y1="13" x2="10" y2="17"/><line x1="3" y1="10" x2="7" y2="10"/><line x1="13" y1="10" x2="17" y2="10"/>';
    return `<div class="concl-cp">
      <button class="concl-cp-close" title="Закрити">×</button>
      <button class="${btnCls}">
        <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${btnSvg}</svg>
        ${btnTxt}
      </button>
      <div class="concl-cp-coord-row">
        <div class="concl-cp-coord" title="Клік — скопіювати">${_esc(coord)}</div>
        <button class="concl-cp-fmt">${_conclCoordFmt}</button>
      </div>
    </div>`;
  }

  /* Bind popup events — викликається через setTimeout після openPopup */
  function _bindConclPopupEvents(el, lat, lon, picked) {
    el.querySelector(".concl-cp-close")?.addEventListener("click", () => {
      _conclClickMarker?.closePopup();
    });

    if (picked) {
      el.querySelector(".concl-cp-delete")?.addEventListener("click", () => {
        _conclClickMarker?.remove();
        _conclClickMarker  = null;
        _conclMarkerPicked = false;
      });
    } else {
      el.querySelector(".concl-cp-select")?.addEventListener("click", () => {
        if (!_conclMap) return;
        // Перевести інтерактивний маркер у фіксований (без авто-видалення)
        if (_conclClickMarker) _conclClickMarker._converted = true;
        _conclClickMarker?.remove();
        _conclClickMarker  = null;
        _conclMarkerPicked = false;
        _addFixedMarker(_conclMap, lat, lon);
      });
    }

    el.querySelector(".concl-cp-fmt")?.addEventListener("click", (e) => {
      e.stopPropagation();
      _conclCoordFmt = _conclCoordFmt === "MGRS" ? "УСК" : "MGRS";
      const coordEl = el.querySelector(".concl-cp-coord");
      const fmtEl   = el.querySelector(".concl-cp-fmt");
      if (coordEl) coordEl.textContent = _getConclCoord(lat, lon);
      if (fmtEl)   fmtEl.textContent   = _conclCoordFmt;
    });

    el.querySelector(".concl-cp-coord")?.addEventListener("click", (e) => {
      e.preventDefault();
      const c = _getConclCoord(lat, lon);
      if (window.clipboardWrite) window.clipboardWrite(c).then(ok => {
        if (ok && window.appToast) window.appToast("Скопійовано", "success", 1400);
      });
    });
  }

  /* Open popup on current marker */
  function _openConclPopup(lat, lon) {
    if (!_conclClickMarker) return;
    const picked = _conclMarkerPicked;
    const popup  = L.popup({
      closeButton: false,
      className:   "concl-map-popup",
      maxWidth:    260,
      offset:      L.point(0, -10),
    }).setContent(_buildConclPopupHtml(lat, lon, picked));

    _conclClickMarker.unbindPopup().bindPopup(popup).openPopup();
    // setTimeout(0) — popup DOM гарантовано готовий
    setTimeout(() => {
      const el = popup.getElement();
      if (el) _bindConclPopupEvents(el, lat, lon, picked);
    }, 0);
  }

  /* Place new interactive marker — auto-removed when its popup closes (if not picked) */
  function _placeConclClickMarker(map, lat, lon) {
    if (_conclClickMarker) {
      _conclClickMarker._converted = true;  // не запускати авто-видалення на старому
      _conclClickMarker.remove();
      _conclClickMarker = null;
    }
    _conclMarkerPicked = false;

    const m = L.marker([lat, lon], { icon: _iconInitial(), bubblingMouseEvents: false });
    m._converted = false;
    _conclClickMarker = m;
    m.addTo(map);

    const popup = L.popup({
      closeButton: false, className: "concl-map-popup",
      maxWidth: 260, offset: L.point(0, -10),
    }).setContent(_buildConclPopupHtml(lat, lon, false));
    m.bindPopup(popup);

    m.on("popupopen", () => {
      const el = popup.getElement();
      if (el) _bindConclPopupEvents(el, lat, lon, false);
    });
    // Закриття меню → прибрати не-вибрану точку
    m.on("popupclose", () => {
      if (!m._converted) {
        m.remove();
        if (_conclClickMarker === m) _conclClickMarker = null;
      }
    });

    m.openPopup();
  }

  /* Place marker already in "picked" state (з інпута Enter) */
  function _placePickedMarker(map, lat, lon) {
    if (_conclClickMarker) { _conclClickMarker.remove(); _conclClickMarker = null; }
    _conclMarkerPicked = true;
    _conclClickMarker  = L.marker([lat, lon], {
      icon: _iconPicked(),
      bubblingMouseEvents: false,
    }).addTo(map);
    _conclClickMarker.on("click", () => _openConclPopup(lat, lon));
    map.setView([lat, lon], Math.max(map.getZoom(), 13));
  }

  /* Очистити всі об'єкти карти + поле координат */
  function _clearMapObjects() {
    _conclFixedMarkers.forEach(e => {
      if (e.marker)    e.marker.remove();
      if (e.layer)     e.layer.remove();
      if (e.centerDot) e.centerDot.remove();
      if (e.chipEl)    e.chipEl.remove();
    });
    _conclFixedMarkers = [];
    // Намальовані елементи (стрілки/зони/орієнтири)
    _conclDrawn.forEach(d => {
      if (d._onZoom && _conclMap) _conclMap.off("zoomend", d._onZoom);
      (d.layers || []).forEach(l => l.remove && l.remove());
      (d.vMarkers || []).forEach(l => l.remove && l.remove());
      (d.mMarkers || []).forEach(l => l.remove && l.remove());
    });
    _conclDrawn = [];
    if (_conclClickMarker) {
      _conclClickMarker._converted = true;
      _conclClickMarker.remove();
      _conclClickMarker = null;
    }
    _conclMarkerPicked = false;
    // Тимчасові варіанти палітрового пошуку
    if (typeof _palClearMatchMarkers === "function") _palClearMatchMarkers();
    const inp = document.getElementById("conclCoordInput");
    if (inp) inp.value = "";
    _refreshConclCoords();
  }

  /* Повне очищення робочої області "Висновок" (поля + карта) */
  function _clearConclWorkspace() {
    _clearMapObjects();
    ["conclText", "conclInterceptTa", "conclCoords"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
  }
  window.clearConclWorkspace = _clearConclWorkspace;

  /* Завантажити зовнішній скрипт один раз */
  function _loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  /* Скопіювати карту з об'єктами у буфер (html2canvas → clipboard) */
  /* Захопити карту в canvas (з прихованими якорями/кнопками) */
  async function _captureConclMapCanvas() {
    const mapDiv = document.getElementById("conclMap");
    if (!mapDiv) return null;
    if (!window.html2canvas) {
      try { await _loadScript("https://html2canvas.hertzen.com/dist/html2canvas.min.js"); }
      catch (e) { return null; }
    }
    if (_conclMap) _conclMap.invalidateSize();
    const anchorsPane = _conclMap && _conclMap.getPane("conclAnchors");
    const chrome = Array.from(mapDiv.parentElement
      ? mapDiv.parentElement.querySelectorAll(".concl-map-tool-btn, .concl-map-add-menu")
      : []);
    if (anchorsPane) anchorsPane.style.display = "none";
    chrome.forEach(el => { el.dataset._prevDisp = el.style.display; el.style.display = "none"; });
    let canvas = null;
    try {
      canvas = await window.html2canvas(mapDiv, { useCORS: true, allowTaint: false, logging: false, imageTimeout: 15000 });
    } catch (e) { canvas = null; }
    if (anchorsPane) anchorsPane.style.display = "";
    chrome.forEach(el => { el.style.display = el.dataset._prevDisp || ""; });
    return canvas;
  }

  /* JPEG base64 (без префіксу) карти, масштаб ≤1200px — для надсилання */
  async function _captureConclMapBase64() {
    const canvas = await _captureConclMapCanvas();
    if (!canvas) return "";
    const MAX_W = 1200;
    let out = canvas;
    if (canvas.width > MAX_W) {
      const s = MAX_W / canvas.width;
      out = document.createElement("canvas");
      out.width = MAX_W; out.height = Math.round(canvas.height * s);
      out.getContext("2d").drawImage(canvas, 0, 0, out.width, out.height);
    }
    return out.toDataURL("image/jpeg", 0.82).split(",")[1] || "";
  }

  async function _copyConclMap() {
    const canvas = await _captureConclMapCanvas();
    if (!canvas) { if (window.appToast) window.appToast("Помилка створення скріншоту", "error", 2600); return; }
    try {
      canvas.toBlob(async (blob) => {
        if (!blob) { if (window.appToast) window.appToast("Не вдалося створити зображення", "error"); return; }
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          if (window.appToast) window.appToast("Карту скопійовано!", "success", 1800);
        } catch (e) {
          if (window.appToast) window.appToast("Браузер заблокував копіювання зображення", "error", 2600);
        }
      }, "image/png");
    } catch (e) {
      if (window.appToast) window.appToast("Помилка створення скріншоту", "error", 2600);
    }
  }

  /* Повний текст висновку: усі поля через порожній рядок */
  function _buildConclFullText() {
    const conclusion = (document.getElementById("conclText")?.value        || "").trim();
    const coords     = (document.getElementById("conclCoords")?.value      || "").trim();
    const separator  = (document.getElementById("conclSepInput")?.value    || "").trim();
    const intercept  = (document.getElementById("conclInterceptTa")?.value || "").trim();
    const parts = [];
    if (conclusion) parts.push(conclusion);
    if (coords)     parts.push(coords);
    if (separator)  parts.push(separator);
    if (intercept)  parts.push(intercept);
    return parts.join("\n\n");
  }

  /* ═════════════════════════════════════════
     Збереження висновку в БД (POST /api/conclusions)
  ═════════════════════════════════════════ */

  /* MGRS-координати висновку з поля "Координати" (рядки виду "1. 37UDQ...") */
  function _collectConclMgrs() {
    const raw = document.getElementById("conclCoords")?.value || "";
    const out = [];
    raw.split("\n").forEach(line => {
      const m = line.replace(/^\s*\d+\.\s*/, "").trim();
      if (m) out.push(m);
    });
    return out;
  }

  /* Перелік незаповнених обов'язкових полів лівої колонки */
  function _conclMissingFields() {
    const miss = [];
    if (!(document.getElementById("conclText")?.value || "").trim())        miss.push("Висновок");
    if (!_collectConclMgrs().length)                                        miss.push("Координати");
    if (!(document.getElementById("conclInterceptTa")?.value || "").trim()) miss.push("Перехоплення");
    return miss;
  }

  function _conclComplete() { return _conclMissingFields().length === 0; }

  /* Зберегти/оновити висновок. Повертає Promise<bool> (успіх). */
  function _saveConclusion() {
    if (!_currentItem || !_currentItem.id) {
      if (window.appToast) window.appToast("Спершу оберіть перехоплення у «Моніторингу»", "warn", 2800);
      return Promise.resolve(false);
    }
    const miss = _conclMissingFields();
    if (miss.length) {
      if (window.appToast) window.appToast("Заповніть поля для збереження: " + miss.join(", "), "warn", 3400);
      return Promise.resolve(false);
    }
    const body = {
      message_id:      _currentItem.id,
      conclusion_text: (document.getElementById("conclText").value || "").trim(),
      mgrs:            _collectConclMgrs(),
      intercept_text:  (document.getElementById("conclInterceptTa")?.value || "").trim(),
    };
    return fetch("/api/conclusions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(d => {
        if (!d || !d.ok) {
          if (window.appToast) window.appToast(d && d.error ? d.error : "Помилка збереження", "error", 3400);
          return false;
        }
        _conclSaved = true;
        if (window.appToast) window.appToast(d.created ? "Висновок збережено" : "Висновок оновлено", "success", 1800);
        return true;
      })
      .catch(() => {
        if (window.appToast) window.appToast("Помилка з'єднання при збереженні", "error", 2800);
        return false;
      });
  }

  /* Запит на збереження при закритті модалки, якщо все заповнено й не збережено.
     Capture-фаза — спрацьовує до основного обробника закриття. */
  function _initConclCloseGuard() {
    const modal = document.getElementById("itModalConclusion");
    if (!modal) return;
    function maybeOffer() {
      if (_conclSaved || !_conclComplete()) return;
      if (window.confirm("Висновок заповнено, але не збережено. Зберегти?")) _saveConclusion();
      else _conclSaved = true;   // користувач відмовився — не питати повторно при цьому закритті
    }
    modal.querySelectorAll("[data-it-modal-close]").forEach(el => {
      el.addEventListener("click", maybeOffer, true);
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) maybeOffer();
    }, true);
  }

  /* ═════════════════════════════════════════
     Зони-«очі»: точки висновків по частоті / підрозділу + опукла оболонка
  ═════════════════════════════════════════ */

  function _mgrsToLatLon(code) {
    if (typeof window.mgrs === "undefined" || !window.mgrs.toPoint) return null;
    try {
      const pt = window.mgrs.toPoint(String(code).replace(/\s+/g, "").toUpperCase());
      const lat = Number(pt[1]), lon = Number(pt[0]);
      if (isFinite(lat) && isFinite(lon)) return { lat, lon };
    } catch (_) {}
    return null;
  }

  /* Опукла оболонка (monotone chain). pts: [{lat,lon}] → [{lat,lon}] за контуром. */
  function _convexHull(pts) {
    if (pts.length < 3) return pts.slice();
    const p = pts.slice().sort((a, b) => (a.lon - b.lon) || (a.lat - b.lat));
    const cross = (o, a, b) => (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon);
    const lower = [];
    for (const q of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
      lower.push(q);
    }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) {
      const q = p[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
      upper.push(q);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  function _clearZone(kind) {
    if (_zoneLayers[kind]) {
      try { _conclMap && _conclMap.removeLayer(_zoneLayers[kind]); } catch (_) {}
      _zoneLayers[kind] = null;
    }
  }

  function _setEyeActive(kind, on) {
    const btn = document.getElementById(kind === "freq" ? "conclEyeFreqBtn" : "conclEyeUnitBtn");
    if (btn) btn.classList.toggle("is-active", !!on);
  }

  function _showConclEyes(show) {
    ["conclEyeFreqBtn", "conclEyeUnitBtn"].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.classList.toggle("hidden", !show);
    });
    // Зони скидаються при зміні перехоплення → кнопки завжди неактивні на старті.
    _setEyeActive("freq", false);
    _setEyeActive("unit", false);
  }

  function _drawZone(kind, codes, color, qctx) {
    _clearZone(kind);
    if (!_conclMap) return;
    const latlngs = [];
    const layers = [];
    codes.forEach(c => {
      const ll = _mgrsToLatLon(c);
      if (!ll) return;
      latlngs.push(ll);
      const cm = L.circleMarker([ll.lat, ll.lon], {
        radius: 4, color: color, weight: 1, fillColor: color, fillOpacity: 0.9,
        bubblingMouseEvents: false,   // клік по точці не створює новий маркер на карті
      });
      cm.on("click", () => _showPointConclusions(cm, c, qctx));
      layers.push(cm);
    });
    if (!latlngs.length) return;
    if (latlngs.length >= 3) {
      const hull = _convexHull(latlngs).map(p => [p.lat, p.lon]);
      layers.unshift(L.polygon(hull, {
        color: color, weight: 2, fillColor: color, fillOpacity: 0.12,
        pane: "conclBelow", renderer: _conclBelowRenderer,
      }));
    }
    _zoneLayers[kind] = L.layerGroup(layers).addTo(_conclMap);
    try { _conclMap.fitBounds(L.latLngBounds(latlngs.map(p => [p.lat, p.lon])).pad(0.2)); } catch (_) {}
  }

  function _toggleZone(kind) {
    if (!_conclMap || !_currentItem) return;
    if (_zoneLayers[kind]) { _clearZone(kind); _setEyeActive(kind, false); return; }

    let url;
    const color = kind === "freq" ? "#2563eb" : "#d97706";
    if (kind === "freq") {
      if (!_currentItem.network_id) return;
      url = `/api/conclusions/zone-points?network_id=${_currentItem.network_id}`;
    } else {
      const unit = (_currentItem.network && _currentItem.network.unit || "").trim();
      if (!unit) { if (window.appToast) window.appToast("У перехоплення немає підрозділу", "warn", 2400); return; }
      url = `/api/conclusions/zone-points?unit=${encodeURIComponent(unit)}`;
    }
    fetch(url)
      .then(r => r.json())
      .then(d => {
        if (!d || !d.ok) {
          if (window.appToast) window.appToast(d && d.error ? d.error : "Помилка завантаження зони", "error", 2800);
          return;
        }
        if (!d.points.length) {
          if (window.appToast) window.appToast("Немає точок у висновках", "warn", 2200);
          return;
        }
        const qctx = kind === "freq"
          ? { kind: "freq", network_id: _currentItem.network_id }
          : { kind: "unit", unit: (_currentItem.network && _currentItem.network.unit || "").trim() };
        _drawZone(kind, d.points, color, qctx);
        _setEyeActive(kind, true);
      })
      .catch(() => { if (window.appToast) window.appToast("Помилка завантаження зони", "error", 2800); });
  }

  /* Клік по точці зони → попап зі списком висновків, що поставили цю точку */
  function _showPointConclusions(marker, mgrs, qctx) {
    const params = new URLSearchParams();
    params.set("mgrs", mgrs);
    if (qctx && qctx.kind === "freq") params.set("network_id", qctx.network_id || 0);
    else if (qctx) params.set("unit", qctx.unit || "");
    marker.bindPopup('<div class="concl-zone-pop">Завантаження…</div>',
      { maxWidth: 360, className: "concl-zone-popup", autoPan: true }).openPopup();
    fetch("/api/conclusions/by-point?" + params.toString())
      .then(r => r.json())
      .then(d => {
        if (!d || !d.ok) { marker.setPopupContent('<div class="concl-zone-pop">Помилка</div>'); return; }
        if (!d.rows || !d.rows.length) {
          marker.setPopupContent('<div class="concl-zone-pop">Немає висновків для цієї точки</div>');
          return;
        }
        const head = `<div class="czp-head">Висновків: ${d.total}</div>`;
        const items = d.rows.map(c => {
          const meta = _esc(c.created_at) +
            (c.frequency ? " · " + _esc(c.frequency) : "") +
            (c.type_label ? " · " + _esc(c.type_label) : "");
          const intercept = c.intercept_text
            ? `<div class="czp-intercept"><div class="czp-ilabel">Перехоплення</div>${_esc(c.intercept_text)}</div>`
            : "";
          return `<div class="czp-item"><div class="czp-meta">${meta}</div>` +
                 `<div class="czp-text">${_esc(c.conclusion_text)}</div>${intercept}</div>`;
        }).join("");
        marker.setPopupContent(`<div class="concl-zone-pop">${head}${items}</div>`);
      })
      .catch(() => marker.setPopupContent('<div class="concl-zone-pop">Помилка завантаження</div>'));
  }

  /* ═════════════════════════════════════════
     Палітри підрозділу (лівий нижній кут карти)
  ═════════════════════════════════════════ */

  /* WKT POLYGON → зовнішнє кільце [[lat,lon],...] (null, якщо не розпарсилось) */
  function _parseWktPolygon(wkt) {
    const m = String(wkt || "").match(/POLYGON\s*\(\s*\(\s*([^)]+?)\s*\)/i);
    if (!m) return null;
    const ring = m[1].split(",").map(pair => {
      const xy = pair.trim().split(/\s+/);
      const lon = parseFloat(xy[0]), lat = parseFloat(xy[1]);
      return (isFinite(lat) && isFinite(lon)) ? [lat, lon] : null;
    }).filter(Boolean);
    return ring.length >= 3 ? ring : null;
  }

  /* Ray-casting: чи точка (lat,lon) всередині кільця [[lat,lon],...] */
  function _pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* Скільки висновкових груп мають ≥1 точку всередині регіонів палітри */
  function _palConclCount(regionWkts, groups) {
    const rings = (regionWkts || []).map(_parseWktPolygon).filter(Boolean);
    if (!rings.length || !groups || !groups.length) return 0;
    let n = 0;
    groups.forEach(codes => {
      const hit = (codes || []).some(code => {
        const ll = _mgrsToLatLon(code);
        return ll && rings.some(r => _pointInRing(ll.lat, ll.lon, r));
      });
      if (hit) n++;
    });
    return n;
  }

  /* Увімкнути/вимкнути регіони палітри на карті */
  function _togglePaletteRegions(pid, wkts, on) {
    if (_unitPalLayers[pid]) {
      try { _conclMap && _conclMap.removeLayer(_unitPalLayers[pid]); } catch (_) {}
      _unitPalLayers[pid] = null;
    }
    if (!on || !_conclMap) return;
    const layers = [];
    (wkts || []).forEach(w => {
      const ring = _parseWktPolygon(w);
      if (ring) layers.push(L.polygon(ring, {
        color: "#7c3aed", weight: 2, fillColor: "#7c3aed", fillOpacity: 0.14,
        pane: "conclBelow", renderer: _conclBelowRenderer,
      }));
    });
    if (layers.length) {
      _unitPalLayers[pid] = L.featureGroup(layers).addTo(_conclMap);
      try { _conclMap.fitBounds(_unitPalLayers[pid].getBounds().pad(0.2)); } catch (_) {}
    }
  }

  function _renderConclPalettes(palettes, freqGroups, otherGroups) {
    const host = document.getElementById("conclPalList");
    if (!host) return;
    if (!palettes || !palettes.length) { host.classList.add("hidden"); host.innerHTML = ""; return; }

    // Для кожної палітри рахуємо висновки по ЦІЙ частоті та по ІНШИХ частотах
    // і визначаємо «ярус» (tier):
    //   1 — є висновки саме по цій частоті;
    //   2 — висновків по цій частоті нема, але є по інших;
    //   3 — висновків нема взагалі (просто палітра підрозділу).
    const enriched = palettes.map(p => {
      const cntFreq  = _palConclCount(p.regions, freqGroups);
      const cntOther = _palConclCount(p.regions, otherGroups);
      const tier = cntFreq > 0 ? 1 : (cntOther > 0 ? 2 : 3);
      return { p, cntFreq, cntOther, tier };
    });
    // Стабільне сортування лише за tier: у межах ярусу зберігається порядок
    // зі сервера (найдетальніший підрозділ → масштабніший).
    enriched.sort((a, b) => a.tier - b.tier);

    const SEC = {
      1: "Висновки по цій частоті",
      2: "Висновки по інших частотах",
      3: "Палітри підрозділу",
    };
    let html = "";
    let lastTier = 0;
    enriched.forEach(e => {
      if (e.tier !== lastTier) {
        html += `<div class="cpl-sec">${SEC[e.tier]}</div>`;
        lastTier = e.tier;
      }
      const hot = e.cntFreq > 0 ? " cpl-cnt--hot" : "";
      // У 2-му ярусі показуємо приглушений лічильник «інших» висновків —
      // щоб було видно, чому палітра стоїть вище за «просто палітри підрозділу».
      const other = (e.tier === 2)
        ? `<span class="cpl-cnt cpl-cnt--other" title="Висновки по інших частотах">${e.cntOther}</span>`
        : "";
      // Чекбокс керує областю пошуку (_palScope), як і в панелі «Палітри» —
      // позначені палітри обмежують пошук точок. Регіони на карті НЕ малюємо.
      const checked = _palScope.has(e.p.id) ? " checked" : "";
      html += `<label class="cpl-row" title="${_esc(e.p.unit || "")}">` +
        `<input type="checkbox" data-pid="${e.p.id}"${checked}>` +
        `<span class="cpl-name">${_esc(e.p.name || "")}</span>` +
        other +
        `<span class="cpl-cnt${hot}">${e.cntFreq}</span>` +
        `</label>`;
    });

    host.innerHTML = `<div class="cpl-title">Палітри для частоти</div>${html}`;
    host.classList.remove("hidden");
    host.querySelectorAll('input[type="checkbox"][data-pid]').forEach(cb => {
      cb.addEventListener("change", () => {
        const pid = parseInt(cb.getAttribute("data-pid"), 10);
        if (cb.checked) _palScope.add(pid); else _palScope.delete(pid);
        _palSaveScope();
        _palRefreshSearchChips();   // перепошук по кодах із чіпів під новий scope
      });
    });
  }

  /* Завантажити перелік палітр для частоти/підрозділу.
   * ctx (необов'язково): { unit, network_id } — для перехоплення, вставленого
   * у поле «Перехоплення». Без ctx — беремо активне перехоплення _currentItem. */
  function _loadConclPalettes(ctx) {
    const host = document.getElementById("conclPalList");
    if (host) { host.classList.add("hidden"); host.innerHTML = ""; }
    Object.keys(_unitPalLayers).forEach(pid => _togglePaletteRegions(pid, [], false));
    _unitPalLayers = {};

    let unit = "", nid = 0;
    if (ctx) {
      unit = (ctx.unit || "").trim();
      nid  = ctx.network_id || 0;
    } else if (_currentItem) {
      unit = (_currentItem.network && _currentItem.network.unit || "").trim();
      nid  = _currentItem.network_id || 0;
    }
    if (!unit) { _lastPalCtxKey = null; return; }

    // Нове перехоплення (інша частота/підрозділ) → скидаємо область пошуку
    // (_palScope): чекбокси стартують порожніми, тож «жодна не виділена = пошук
    // по всіх палітрах». Це також прибирає застарілий scope зі сховища (від
    // попередніх перехоплень/сеансів), який інакше непомітно фільтрував пошук.
    const ctxKey = unit + "|" + nid;
    if (ctxKey !== _lastPalCtxKey) {
      _palScope.clear(); _palSaveScope();
      _lastPalCtxKey = ctxKey;
    }

    fetch(`/api/palettes/for-unit?unit=${encodeURIComponent(unit)}&network_id=${nid}&days=60`)
      .then(r => r.json())
      .then(d => {
        if (d && d.ok) _renderConclPalettes(d.palettes || [], d.conclusion_groups || [], d.other_groups || []);
      })
      .catch(() => {});
  }

  /* Витягти частоту із шапки перехоплення (число виду 146.6350 / 30.150). */
  function _extractFreqFromText(text) {
    const head = String(text || "").split(/\r?\n\s*\r?\n/)[0] || "";
    const lines = head.split(/\r?\n/).slice(0, 5);
    for (const ln of lines) {
      const m = ln.match(/\b\d{2,3}[.,]\d{2,4}\b/);
      if (m) return m[0].replace(",", ".");
    }
    return "";
  }

  /* Підібрати контекст { unit, network_id } для палітр із довільного тексту
   * перехоплення: unit — із шапки; network_id — через пошук мережі за частотою
   * (пріоритет рядку з тим самим підрозділом, що в шапці). */
  async function _palCtxFromText(text) {
    const unit = (_buildPseudoItem(text).network.unit || "").trim();
    const freq = _extractFreqFromText(text);
    let networkId = 0, canonUnit = unit;
    if (freq) {
      try {
        const r = await fetch(`/api/networks/lookup?q=${encodeURIComponent(freq)}`);
        const d = await r.json();
        const rows = (d && d.ok && Array.isArray(d.rows)) ? d.rows : [];
        const exact = rows.filter(x => String(x.frequency || "").trim() === freq);
        const pool = exact.length ? exact : rows;
        const byUnit = unit ? pool.find(x => (x.unit || "").trim() === unit) : null;
        const pick = byUnit || pool[0] || null;
        if (pick) { networkId = pick.id || 0; if (pick.unit) canonUnit = String(pick.unit).trim(); }
      } catch (_) {}
    }
    return { unit: canonUnit || unit, network_id: networkId };
  }

  /* ═════════════════════════════════════════
     Map drawing tools: Стрілка / Зона / Орієнтир
  ═════════════════════════════════════════ */

  function _anchorIcon(kind){
    return L.divIcon({ className:"", html:`<div class="concl-anchor concl-anchor--${kind}"></div>`, iconSize:[16,16], iconAnchor:[8,8] });
  }
  function _delHandleIcon(){
    return L.divIcon({ className:"", iconSize:[18,18], iconAnchor:[9,9], html:`<div class="concl-del-handle" title="Видалити елемент">×</div>` });
  }
  function _polyCentroid(verts){
    let lat = 0, lng = 0; verts.forEach(v => { lat += v.lat; lng += v.lng; });
    return L.latLng(lat / verts.length, lng / verts.length);
  }
  /* Видалити один намальований об'єкт */
  function _removeDrawn(entry){
    if (entry._onZoom && _conclMap) _conclMap.off("zoomend", entry._onZoom);
    (entry.layers   || []).forEach(l => l.remove && l.remove());
    (entry.vMarkers || []).forEach(l => l.remove && l.remove());
    (entry.mMarkers || []).forEach(l => l.remove && l.remove());
    const i = _conclDrawn.indexOf(entry);
    if (i !== -1) _conclDrawn.splice(i, 1);
  }
  function _midLatLng(a, b){ return L.latLng((a.lat+b.lat)/2, (a.lng+b.lng)/2); }
  /* Трикутник вістря (3 latlng) для лінії A→B, вершина точно в B */
  function _arrowHead(map, A, B){
    const pa = map.latLngToLayerPoint(A), pb = map.latLngToLayerPoint(B);
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx/len, uy = dy/len;   // вздовж
    const px = -uy, py = ux;          // перпендикуляр
    const HL = 17, HW = 8;            // довжина та півширина вістря (px)
    const bx = pb.x - ux*HL, by = pb.y - uy*HL;
    return [
      map.layerPointToLatLng(pb),                                   // вершина
      map.layerPointToLatLng(L.point(bx + px*HW, by + py*HW)),      // лівий ріг
      map.layerPointToLatLng(L.point(bx - px*HW, by - py*HW)),      // правий ріг
    ];
  }

  /* ── Стрілка ── */
  function _addArrow(map){
    let A, B;
    // Якщо на карті є ≥2 точки — стрілка від першої до другої (із відступом від кругів)
    const pts = _conclFixedMarkers.filter(e => e.marker && !e.isSquare);
    if (pts.length >= 2){
      const A0 = L.latLng(pts[0].lat, pts[0].lon);
      const B0 = L.latLng(pts[1].lat, pts[1].lon);
      const pa = map.latLngToLayerPoint(A0), pb = map.latLngToLayerPoint(B0);
      const dx = pb.x - pa.x, dy = pb.y - pa.y;
      const len = Math.hypot(dx, dy) || 1;
      const m = 22, ux = dx/len, uy = dy/len; // відступ ~22px ≈ радіус кола + зазор
      A = map.layerPointToLatLng(L.point(pa.x + ux*m, pa.y + uy*m));
      B = map.layerPointToLatLng(L.point(pb.x - ux*m, pb.y - uy*m));
    } else {
      const c = map.getCenter();
      const span = (map.getBounds().getEast() - map.getBounds().getWest()) / 6;
      A = L.latLng(c.lat, c.lng - span);
      B = L.latLng(c.lat, c.lng + span);
    }
    const aM = L.marker(A, { draggable:true, icon:_anchorIcon("end"), bubblingMouseEvents:false, pane:"conclAnchors" }).addTo(map);
    const bM = L.marker(B, { draggable:true, icon:_anchorIcon("end"), bubblingMouseEvents:false, pane:"conclAnchors" }).addTo(map);
    const line = L.polyline([aM.getLatLng(), bM.getLatLng()], { color:"#ef4444", weight:3, renderer:_conclAboveRenderer }).addTo(map);
    const head = L.polygon(_arrowHead(map, aM.getLatLng(), bM.getLatLng()), { color:"#ef4444", weight:1, fillColor:"#ef4444", fillOpacity:1, renderer:_conclAboveRenderer }).addTo(map);
    const del  = L.marker(_midLatLng(aM.getLatLng(), bM.getLatLng()), { icon:_delHandleIcon(), pane:"conclAnchors", bubblingMouseEvents:false }).addTo(map);

    function update(){
      const A = aM.getLatLng(), B = bM.getLatLng();
      line.setLatLngs([A, B]);
      head.setLatLngs(_arrowHead(map, A, B));
      del.setLatLng(_midLatLng(A, B));
    }
    aM.on("drag", update); bM.on("drag", update);
    map.on("zoomend", update);
    update();
    const entry = { type:"arrow", layers:[line, head, aM, bM, del], _onZoom:update };
    del.on("click", (e) => { if (e.originalEvent) L.DomEvent.stop(e.originalEvent); _removeDrawn(entry); });
    _conclDrawn.push(entry);
  }

  /* ── Зона (полігон з якорями вершин і середин сторін) ── */
  function _addZone(map){
    const c = map.getCenter();
    const d = (map.getBounds().getNorth() - map.getBounds().getSouth()) / 8;
    const verts = [
      L.latLng(c.lat + d, c.lng),
      L.latLng(c.lat - d, c.lng - d),
      L.latLng(c.lat - d, c.lng + d),
    ];
    const poly = L.polygon(verts, { color:"#ef4444", weight:2, fillColor:"#ef4444", fillOpacity:0.3, renderer:_conclBelowRenderer }).addTo(map);
    const del  = L.marker(_polyCentroid(verts), { icon:_delHandleIcon(), pane:"conclAnchors", bubblingMouseEvents:false }).addTo(map);
    const entry = { type:"zone", poly, verts, vMarkers:[], mMarkers:[], delHandle:del, layers:[poly, del] };
    del.on("click", (e) => { if (e.originalEvent) L.DomEvent.stop(e.originalEvent); _removeDrawn(entry); });
    _conclDrawn.push(entry);
    _rebuildZoneAnchors(map, entry);
  }

  function _updateZoneMids(entry){
    const n = entry.verts.length;
    entry.mMarkers.forEach((mm, i) => {
      const a = entry.verts[i], b = entry.verts[(i+1)%n];
      mm.setLatLng(_midLatLng(a, b));
    });
    if (entry.delHandle) entry.delHandle.setLatLng(_polyCentroid(entry.verts));
  }

  function _rebuildZoneAnchors(map, entry){
    entry.vMarkers.forEach(m => m.remove());
    entry.mMarkers.forEach(m => m.remove());
    entry.vMarkers = []; entry.mMarkers = [];
    const n = entry.verts.length;

    // Вершини
    entry.verts.forEach((v, i) => {
      const m = L.marker(v, { draggable:true, icon:_anchorIcon("vertex"), bubblingMouseEvents:false, pane:"conclAnchors" }).addTo(map);
      m.on("drag", () => {
        entry.verts[i] = m.getLatLng();
        entry.poly.setLatLngs(entry.verts);
        _updateZoneMids(entry);
      });
      m.on("click", (ev) => {
        const oe = ev.originalEvent;
        if ((oe.ctrlKey || oe.metaKey) && entry.verts.length > 3){
          L.DomEvent.stop(oe);
          entry.verts.splice(i, 1);
          entry.poly.setLatLngs(entry.verts);
          _rebuildZoneAnchors(map, entry);
        }
      });
      entry.vMarkers.push(m);
    });

    // Середини сторін
    for (let i = 0; i < n; i++){
      const a = entry.verts[i], b = entry.verts[(i+1)%n];
      const mm = L.marker(_midLatLng(a, b), { draggable:true, icon:_anchorIcon("mid"), bubblingMouseEvents:false, pane:"conclAnchors" }).addTo(map);
      const edge = i;
      mm.on("dragstart", () => {
        entry.verts.splice(edge+1, 0, mm.getLatLng());
        entry._dragIdx = edge+1;
        entry.poly.setLatLngs(entry.verts);
      });
      mm.on("drag", () => {
        if (entry._dragIdx != null){ entry.verts[entry._dragIdx] = mm.getLatLng(); entry.poly.setLatLngs(entry.verts); }
      });
      mm.on("dragend", () => { entry._dragIdx = null; _rebuildZoneAnchors(map, entry); });
      entry.mMarkers.push(mm);
    }
    if (entry.delHandle) entry.delHandle.setLatLng(_polyCentroid(entry.verts));
  }

  /* ── Орієнтир: парсер WKT → шар ── */
  function _landmarkIcon(){
    return L.divIcon({ className:"", iconSize:[20,28], iconAnchor:[10,28], tooltipAnchor:[0,-30],
      html:`<svg width="20" height="28" viewBox="0 0 20 28"><path d="M10 1a8 8 0 018 8c0 6-8 18-8 18S2 15 2 9a8 8 0 018-8z" fill="#ef4444" stroke="#fff" stroke-width="1.5"/><circle cx="10" cy="9" r="3" fill="#fff"/></svg>` });
  }
  function _wktToLayer(wkt, name){
    const s = String(wkt || "").trim(); const up = s.toUpperCase();
    const tip = name ? { permanent:true, direction:"top", className:"concl-square-label" } : null;
    function pts(str){ return str.split(",").map(p => { const xy = p.trim().split(/\s+/); return [parseFloat(xy[1]), parseFloat(xy[0])]; }); }
    let layer = null;
    if (up.startsWith("POINT")){
      const m = s.match(/POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
      if (m) layer = L.marker([+m[2], +m[1]], { icon:_landmarkIcon(), pane:"conclBelow" });
    } else if (up.startsWith("POLYGON")){
      const inner = s.match(/POLYGON\s*\(\s*\(\s*(.+?)\s*\)\s*\)/i);
      if (inner) layer = L.polygon(pts(inner[1]), { color:"#ef4444", weight:2, fillColor:"#ef4444", fillOpacity:0.22, renderer:_conclBelowRenderer });
    } else if (up.startsWith("LINESTRING")){
      const inner = s.match(/LINESTRING\s*\(\s*(.+?)\s*\)/i);
      if (inner) layer = L.polyline(pts(inner[1]), { color:"#ef4444", weight:3, renderer:_conclBelowRenderer });
    }
    if (layer && name && tip) layer.bindTooltip(name, tip);
    return layer;
  }

  function _placeLandmark(map, lm){
    let layer = _wktToLayer(lm.location_wkt, lm.name);
    if (!layer && lm.location_mgrs && typeof window.mgrs !== "undefined"){
      try {
        const pt = window.mgrs.toPoint(String(lm.location_mgrs).replace(/\s+/g,"").toUpperCase());
        layer = L.marker([pt[1], pt[0]], { icon:_landmarkIcon(), pane:"conclBelow" });
        if (lm.name) layer.bindTooltip(lm.name, { permanent:true, direction:"top", className:"concl-square-label" });
      } catch(_){}
    }
    if (!layer){ if (window.appToast) window.appToast("В орієнтира немає геометрії", "warn", 1800); return; }
    layer.addTo(map);
    const at  = layer.getLatLng ? layer.getLatLng() : layer.getBounds().getCenter();
    const del = L.marker(at, { icon:_delHandleIcon(), pane:"conclAnchors", bubblingMouseEvents:false }).addTo(map);
    const entry = { type:"landmark", layers:[layer, del] };
    del.on("click", (e) => { if (e.originalEvent) L.DomEvent.stop(e.originalEvent); _removeDrawn(entry); });
    _conclDrawn.push(entry);
    try { map.fitBounds(layer.getBounds ? layer.getBounds() : L.latLngBounds([layer.getLatLng(), layer.getLatLng()]), { maxZoom:14, padding:[40,40] }); } catch(_){}
  }

  /* ── Модал вибору орієнтира ── */
  function _openLandmarkPicker(map){
    let modal = document.getElementById("conclLmPicker");
    if (!modal){
      modal = document.createElement("div");
      modal.id = "conclLmPicker";
      modal.className = "modal hidden";
      modal.innerHTML =
        `<div class="modal-backdrop" data-close-lmp="1"></div>` +
        `<div class="modal-card" role="dialog" aria-modal="true" style="max-width:480px">` +
          `<div class="modal-head"><div style="font-weight:700">Вибір орієнтира</div>` +
            `<button class="mon-tmpl-close-btn" data-close-lmp="1" title="Закрити"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg></button>` +
          `</div>` +
          `<div class="modal-body">` +
            `<input id="conclLmSearch" type="text" placeholder="Пошук за назвою…" autocomplete="off" style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);outline:none">` +
            `<div id="conclLmResults" class="concl-lm-results"></div>` +
          `</div>` +
        `</div>`;
      modal.addEventListener("click", e => { if (e.target.closest("[data-close-lmp]")) modal.classList.add("hidden"); });
      document.body.appendChild(modal);

      const inp = modal.querySelector("#conclLmSearch");
      const out = modal.querySelector("#conclLmResults");
      let t = null;
      inp.addEventListener("input", () => {
        clearTimeout(t);
        const q = inp.value.trim();
        if (q.length < 2){ out.innerHTML = ""; return; }
        t = setTimeout(async () => {
          try {
            const r = await fetch(`/api/landmarks/search?name=${encodeURIComponent(q)}&limit=20`, { headers:{Accept:"application/json"} });
            const d = await r.json();
            const items = Array.isArray(d.items) ? d.items : [];
            out.innerHTML = items.length
              ? items.map(it => `<button type="button" class="concl-lm-item" data-id="${it.id}">${_esc(it.name)}</button>`).join("")
              : `<div class="mon-empty" style="padding:16px">Нічого не знайдено</div>`;
          } catch(_){ out.innerHTML = `<div class="mon-empty" style="padding:16px">Помилка пошуку</div>`; }
        }, 220);
      });
      out.addEventListener("click", async (e) => {
        const btn = e.target.closest(".concl-lm-item");
        if (!btn) return;
        const id = Number(btn.dataset.id || 0);
        if (!id) return;
        try {
          const r = await fetch(`/api/landmarks/${id}`, { headers:{Accept:"application/json"} });
          const d = await r.json();
          if (d && d.landmark) _placeLandmark(map, d.landmark);
        } catch(_){}
        modal.classList.add("hidden");
      });
    }
    modal.querySelector("#conclLmResults").innerHTML = "";
    const si = modal.querySelector("#conclLmSearch"); if (si) si.value = "";
    modal.classList.remove("hidden");
    setTimeout(() => si?.focus(), 0);
  }

  window.initConclusionPanel = function () {
    // Render current intercept
    const detail = document.getElementById("conclDetail");
    if (detail && _currentItem) _renderDetailTo(detail, _currentItem);

    // Conclusion controls
    document.getElementById("conclTemplatesBtn")?.addEventListener("click", _openTemplatesModal);

    // Збереження висновку: кнопка 💾, відстеження змін, запит при закритті (одноразово)
    if (!_conclSaveWired) {
      _conclSaveWired = true;
      document.getElementById("conclSaveBtn")?.addEventListener("click", _saveConclusion);
      ["conclText", "conclInterceptTa", "conclCoords"].forEach(id => {
        document.getElementById(id)?.addEventListener("input", () => { _conclSaved = false; });
      });
      _initConclCloseGuard();

      // Кнопки-«очі»: зони точок висновків по частоті / підрозділу
      document.getElementById("conclEyeFreqBtn")?.addEventListener("click", () => _toggleZone("freq"));
      document.getElementById("conclEyeUnitBtn")?.addEventListener("click", () => _toggleZone("unit"));
    }

    // Copy button: висновок + координати + роздільник + перехоплення (через порожній рядок)
    document.getElementById("conclCopyBtn")?.addEventListener("click", () => {
      const text = _buildConclFullText();
      if (!text) { if (window.appToast) window.appToast("Нічого копіювати", "warn", 1400); return; }
      if (window.clipboardWrite) {
        window.clipboardWrite(text).then(ok => {
          if (window.appToast) window.appToast(ok ? "Скопійовано" : "Помилка копіювання", ok ? "success" : "error", 1600);
        });
      }
    });

    // Поширити-кнопка ⤴: відкриває ту саму multi-recipient панель, що й на
    // Моніторингу, але payload — повний текст висновку + зображення карти.
    document.getElementById("conclShareBtn")?.addEventListener("click", () => {
      _openShareModal({
        btnId: "conclShareBtn",
        buildPayload: async () => ({
          text: _buildConclFullText(),
          image_base64: await _captureConclMapBase64(),
        }),
      });
    });

    // Coordinate input
    const coordIn = document.getElementById("conclCoordInput");
    // × — очистити всі введені дані (поле + об'єкти карти)
    document.getElementById("conclCoordClearBtn")?.addEventListener("click", () => {
      _clearMapObjects();
    });
    if (coordIn) {
      // Enter → квадрат / квадрат+равлик / фіксована точка (MGRS)
      // Обробка одного токена (без ком). Повертає true, якщо було розпізнано.
      function _processCoordToken(val) {
        if (!_conclMap || !val) return false;

        // Квадрат із равликом: "25 17 4"
        const sqSnail = val.match(/^(\d{2})\s+(\d{2})\s+([1-9])$/);
        if (sqSnail) {
          _addGridSquare(_conclMap, parseInt(sqSnail[1],10), parseInt(sqSnail[2],10), parseInt(sqSnail[3],10));
          return true;
        }
        // Квадрат: "28 17"
        const sq = val.match(/^(\d{2})\s+(\d{2})$/);
        if (sq) {
          _addGridSquare(_conclMap, parseInt(sq[1],10), parseInt(sq[2],10));
          return true;
        }

        // УСК-2000: дві пари по 7 цифр (повні) або по 5 (додаємо 54 / 74)
        let uskX = null, uskY = null;
        const usk7 = val.match(/^(\d{7})\s+(\d{7})$/);
        const usk5 = val.match(/^(\d{5})\s+(\d{5})$/);
        if (usk7) { uskX = parseInt(usk7[1],10); uskY = parseInt(usk7[2],10); }
        else if (usk5) { uskX = parseInt("54"+usk5[1],10); uskY = parseInt("74"+usk5[2],10); }
        if (uskX !== null) {
          const c = _usk2000ToLatLon(uskX, uskY);
          if (c && isFinite(c.lat) && isFinite(c.lon)) {
            _addFixedMarker(_conclMap, c.lat, c.lon, `${uskX} ${uskY}`);
            _conclMap.setView([c.lat, c.lon], Math.max(_conclMap.getZoom(), 13));
            return true;
          }
          if (window.appToast) window.appToast("Не вдалося розпізнати координату УСК-2000", "error", 1600);
          return false;
        }

        // Точка: MGRS (один токен, формат [zone]+2-3 латинські літери+цифри)
        if (typeof window.mgrs !== "undefined") {
          const raw = val.replace(/\s+/g, "").toUpperCase();
          if (raw.length >= 6 && /^\d{0,3}[A-Z]{2,3}\d/.test(raw)) {
            try {
              const pt  = window.mgrs.toPoint(raw);
              const lat = Number(pt[1]), lon = Number(pt[0]);
              if (isFinite(lat) && isFinite(lon)) {
                _addFixedMarker(_conclMap, lat, lon);
                _conclMap.setView([lat, lon], Math.max(_conclMap.getZoom(), 13));
                return true;
              }
            } catch(_) {}
          }
        }

        // Інакше — код точки палітри / маска (один токен)
        _paletteLookupAndPlace(val);
        return true; // дозволяємо палітрі мовчазно нічого не знайти
      }

      coordIn.addEventListener("keydown", e => {
        if (e.key !== "Enter") return;
        if (!_conclMap) return;
        const raw = coordIn.value.trim();
        if (!raw) return;

        // Якщо є коми — розбиваємо і обробляємо кожну частину окремо.
        if (raw.includes(",")) {
          const tokens = raw.split(",").map(t => t.trim()).filter(Boolean);
          let okCount = 0;
          tokens.forEach(t => { if (_processCoordToken(t)) okCount++; });
          coordIn.value = "";
          if (window.appToast && tokens.length > 1) {
            window.appToast(`Оброблено: ${okCount} / ${tokens.length}`, okCount === tokens.length ? "success" : "warn", 1800);
          }
          return;
        }

        if (_processCoordToken(raw)) {
          coordIn.value = "";
        }
      });
    }

    // Кнопка копіювання карти (поверх зображення)
    document.getElementById("conclMapCopyBtn")?.addEventListener("click", _copyConclMap);

    // Кнопка "+" та меню елементів карти
    const addBtn  = document.getElementById("conclMapAddBtn");
    const addMenu = document.getElementById("conclMapAddMenu");
    if (addBtn && addMenu){
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        addMenu.classList.toggle("hidden");
      });
      addMenu.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-tool]");
        if (!btn) return;
        addMenu.classList.add("hidden");
        if (!_conclMap) return;
        const tool = btn.dataset.tool;
        if (tool === "arrow")    _addArrow(_conclMap);
        else if (tool === "zone")     _addZone(_conclMap);
        else if (tool === "landmark") _openLandmarkPicker(_conclMap);
      });
      document.addEventListener("click", (e) => {
        if (!addMenu.classList.contains("hidden") && !addMenu.contains(e.target) && e.target !== addBtn && !addBtn.contains(e.target)){
          addMenu.classList.add("hidden");
        }
      });
    }

    // Палітри (висувна панель + scope пошуку)
    _paletteInit();

    // Екстрактори квадрата / координат із поля «Перехоплення»
    _initInterceptExtractors();

    // Спільні (серверні) шаблони висновків — перетерти локальний кеш
    _tmplServerLoad();

    // Send bar
    _syncAllSendBars();
    _initOneSendBar("conclPlatformBtn", "conclChatInput", "conclChatDrop", "conclSendBtn",
      () => _buildConclFullText(),   // повний текст: усі поля
      null,                          // координати вже в тексті (поле "Координати")
      () => _captureConclMapBase64() // зображення карти
    );

    // Map. Leaflet вантажиться як defer-скрипт із CDN, тож на момент першого
    // кадру глобальний L може бути ще не визначений. Раніше одноразовий RAF у
    // такому разі мовчки виходив — і карта не створювалась ЗОВСІМ до наступного
    // перезавантаження (чорна карта + не працював пошук, бо обробник Enter
    // перевіряє _conclMap). Тепер чекаємо появи L і лише тоді будуємо карту.
    function _buildConclMap() {
      const el = document.getElementById("conclMap");
      if (!el || _conclMap || typeof L === "undefined") return;
      // preferCanvas — щоб квадрати (полігони) рендерилися на <canvas>
      // і потрапляли у скріншот html2canvas (SVG він не захоплює)
      _conclMap = L.map(el, { center: [48.5, 37.5], zoom: 10, preferCanvas: true });
      // Шари z-index: Зона/Орієнтир (350) < квадрати (overlayPane 400) < точки (markerPane 600) < Стрілка (620)
      _conclMap.createPane("conclBelow");   _conclMap.getPane("conclBelow").style.zIndex   = 350;
      _conclMap.createPane("conclAbove");   _conclMap.getPane("conclAbove").style.zIndex   = 620;
      _conclMap.createPane("conclAnchors"); _conclMap.getPane("conclAnchors").style.zIndex = 650;
      // Візуальні pane'и Зони/Стрілки — прозорі для миші (лише малюють),
      // щоб canvas не перехоплював кліки по точках/якорях.
      _conclMap.getPane("conclBelow").style.pointerEvents = "none";
      _conclMap.getPane("conclAbove").style.pointerEvents = "none";
      _conclBelowRenderer = L.canvas({ pane: "conclBelow" });
      _conclAboveRenderer = L.canvas({ pane: "conclAbove" });
      // Google hybrid — супутник + українські підписи населених пунктів
      L.tileLayer(
        "https://mt1.google.com/vt/lyrs=y&hl=uk&x={x}&y={y}&z={z}",
        { attribution: "Google", maxZoom: 20 }
      ).addTo(_conclMap);
      // Click → place new interactive marker (завжди дозволено)
      _conclMap.on("click", e => {
        _placeConclClickMarker(_conclMap, e.latlng.lat, e.latlng.lng);
      });
      setTimeout(() => { try { _conclMap.invalidateSize(); } catch (_) {} }, 60);
    }
    (function _waitLeaflet(n) {
      if (_conclMap) return;
      if (typeof L !== "undefined") { requestAnimationFrame(_buildConclMap); return; }
      if (n > 0) setTimeout(() => _waitLeaflet(n - 1), 100);   // ~12с очікування Leaflet
    })(120);
  };

  function _fillConclIntercept(item) {
    const ta = document.getElementById("conclInterceptTa");
    if (!ta) return;
    ta.value = item ? _buildPasteText(item) : "";
    _conclSaved = false;   // нове перехоплення → новий незбережений висновок
    // Зони-«очі»: скинути попередні зони й показати кнопки за наявності перехоплення
    _clearZone("freq"); _clearZone("unit");
    _showConclEyes(!!item);
    // Палітри підрозділу: перезавантажити перелік для нового перехоплення
    _loadConclPalettes();
  }

  /**
   * Підставляє змінні з перехоплення у дефолтний шаблон.
   * %ЛОКАЦІЯ  → net_description (опис мережі / місцевість)
   * %ПІДРОЗДІЛ → network.unit (позначення підрозділу)
   * %КООРД    → залишається для ручного заповнення
   */
  /** Витягує "(р-н ЗАРІЧНЕ - ДІБРОВА)" → "р-н ЗАРІЧНЕ - ДІБРОВА" */
  function _extractLocation(netDesc) {
    const m = String(netDesc || "").match(/\(([^)]+)\)\s*$/);
    return m ? m[1].trim() : (netDesc || "").trim();
  }

  function _substituteVars(tmpl, item) {
    const location = _extractLocation(item.net_description || "");
    const unit     = (item.network?.unit || "").trim();
    return String(tmpl || "")
      .replace(/%ЛОКАЦІЯ/g,   location)
      .replace(/%ПІДРОЗДІЛ/g, unit)
      .replace(/%КООРД/g,     "");
  }

  function _applyDefaultTemplate(item) {
    return _substituteVars(_loadDefaultTmpl(), item);
  }

  window.resumeConclusionPanel = function () {
    if (_currentItem) _fillConclIntercept(_currentItem);
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
        _loadedIds.clear();
        _maxLoadedId = 0;
      }

      data.items.forEach(item => {
        if (_loadedIds.has(item.id)) return;
        _appendThumb(item);
        _loadedIds.add(item.id);
        if (item.id > _maxLoadedId) _maxLoadedId = item.id;
      });
      _offset = offset + data.items.length;

      _syncShowMore();
      _syncUnreadBadge();
    } catch (e) { console.error("[monitor] loadPage", e); }
  }

  async function _pollNew() {
    if (!_maxLoadedId) return;
    try {
      // ID-курсор: ловить будь-який INSERT з id > _maxLoadedId. Це покриває
      // і нові повідомлення (created_at — зараз), і запізнілі (SWBot прислав
      // повідомлення з минулим часом у тілі, бо парсить header). Сервер у
      // цьому режимі сортує за id DESC — щоб _maxLoadedId зростав монотонно
      // і нічого не пропускалось між запитами.
      const url = `/api/monitor/playlist?limit=200&min_id=${encodeURIComponent(_maxLoadedId)}`;
      const res  = await fetch(url);
      const data = await res.json();
      if (!data.ok || !data.items.length) return;

      let added = 0;
      data.items.forEach(item => {
        if (_loadedIds.has(item.id)) return;
        _insertThumbByDate(item);
        _loadedIds.add(item.id);
        if (item.id > _maxLoadedId) _maxLoadedId = item.id;
        added++;
      });
      if (added) {
        _total += added;
        _syncShowMore();
        _syncUnreadBadge();
      }
    } catch (e) { console.error("[monitor] pollNew", e); }
  }

  /* Вставити thumb у позицію, що відповідає created_at (плейлист
     впорядкований DESC). Якщо запізніле повідомлення — потрапляє в середину;
     якщо звичайне нове — префіксує. */
  function _insertThumbByDate(item) {
    const thumb = _buildThumb(item);
    const at    = item.created_at || "";
    const thumbs = _playlist.querySelectorAll(".mon-thumb");
    for (const el of thumbs) {
      const elAt = el.dataset.createdAt || "";
      if (at > elAt) { _playlist.insertBefore(thumb, el); return; }
    }
    _playlist.appendChild(thumb);
  }

  /* ═════════════════════════════════════════
     Thumbnail rendering
  ═════════════════════════════════════════ */

  function _buildThumb(item) {
    const el  = document.createElement("div");
    el.className = "mon-thumb" + (item.is_read ? "" : " mon-thumb--unread");
    el.dataset.id = item.id;
    el.dataset.createdAt = item.created_at || "";  // потрібно для _insertThumbByDate
    el.title = "Клік — відкрити перехоплення\nCtrl+Клік — Перегляд по цій частоті (−5 год / +10 хв)";

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

    el.addEventListener("click", (ev) => {
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        _openInViewByFrequency(item.frequency || "");
        return;
      }
      _openDetail(item.id, el);
    });
    return el;
  }

  /* Ctrl+Click на мініатюрі: відкрити вкладку «Перегляд» з фільтром
   * по частоті та періодом [now−5h ; now+10min]. */
  function _openInViewByFrequency(freq) {
    const pad2 = (n) => String(n).padStart(2, "0");
    const fmt  = (d) =>
      `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}` +
      `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const now   = new Date();
    const start = new Date(now.getTime() - 5 * 60 * 60 * 1000);
    const end   = new Date(now.getTime() + 10 * 60 * 1000);

    const startInput = document.getElementById("periodStart");
    const endInput   = document.getElementById("periodEnd");
    const netInput   = document.getElementById("networkQuery");
    const form       = document.getElementById("interceptsFilterForm");

    if (startInput) startInput.value = fmt(start);
    if (endInput)   endInput.value   = fmt(end);
    if (netInput)   netInput.value   = String(freq || "").trim();

    if (window.itSetTab) window.itSetTab("view");

    if (form) {
      // Submit form через подію — її обробник в intercepts_explorer.js скине offset
      // і перезавантажить список з новими фільтрами.
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    }
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
        // Auto-fill intercept textarea in conclusion tab
        _fillConclIntercept(_currentItem);
        // Notify auxiliary panels (e.g. dictionary side panel) — це дозволяє
        // їм підтягнути контекст активного перехоплення без власних опитувань.
        try {
          window.dispatchEvent(new CustomEvent("monitor:active-intercept", { detail: _currentItem }));
        } catch (_) {}
      })
      .catch(() => {});
  }

  // Public read-only accessor for the currently selected intercept. Used by
  // the dictionary side panel to pre-fill network/group scope.
  window.getActiveInterceptContext = function () {
    const it = _currentItem;
    if (!it || !it.network) return null;
    return {
      messageId:   it.id || null,
      networkId:   it.network.id || null,
      frequency:   it.network.frequency || null,
      mask:        it.network.mask || null,
      unit:        it.network.unit || null,
      groupId:     it.network.group_id || null,
      groupName:   it.network.group_name || null,
    };
  };

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
               `<span class="cs-ico-wrap" data-concl-cs-id="${c.id}">` +
                 `<img class="mon-cs-status-icon" src="${iconSrc}" alt=""` +
                 ` onerror="this.onerror=null;this.src='/static/icons/callsign_statuses/_default.svg'">` +
               `</span>` +
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

    // Оверлей-крапка на іконках позивних, по яких є аналітичні висновки.
    if (window.decorateCallsignConclusions) window.decorateCallsignConclusions(_detail);

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
    const dt      = _fmtDatetime(item.created_at || "");
    const freq    = item.network?.frequency || "";
    const netDesc = item.net_description || "";
    const text    = item.text || "";

    const callsigns = Array.isArray(item.callsigns) ? item.callsigns : [];
    const callers   = callsigns.filter(c => c.role === "caller").map(c => c.name);
    const callees   = callsigns.filter(c => c.role === "callee" || c.role === "mentioned").map(c => c.name);

    const lines = [];
    if (dt)      lines.push(dt);
    if (freq)    lines.push(freq);
    if (netDesc) lines.push(netDesc);
    callers.forEach(n => lines.push(n));
    callees.forEach(n => lines.push(n));
    if (text) {
      lines.push("");   // порожній рядок перед текстом
      lines.push(text);
    }
    return lines.join("\n");
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
    const filtered = _allChats
      .filter(c => c && c.name)
      .filter(c => !q || String(c.name).toLowerCase().includes(q))
      .slice(0, 40);
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

  function _initOneSendBar(platformBtnId, chatInputId, chatDropId, sendBtnId, getTextFn, getCoordFn, getImageFn) {
    // Platform button
    document.getElementById(platformBtnId)?.addEventListener("click", _togglePlatformBtn);

    // Chat input autocomplete
    const inp  = document.getElementById(chatInputId);
    const drop = document.getElementById(chatDropId);
    if (inp && drop) {
      let closeTimer = null;
      async function _ensureChatsAndRender() {
        // Підвантажуємо чати, якщо ще не завантажено (наприклад, після
        // перемикання платформи _allChats=null). Інакше input-handler
        // мовчки не показував би автокомпліт, поки користувач не клацнув
        // фокус удруге.
        if (!_allChats && !_chatsLoading) {
          _showDropLoadingEl(drop);
          await _loadChats();
        }
        try {
          _renderChatDropEl(inp, drop, inp.value);
        } catch (e) {
          // На випадок битих даних (chat.name=null тощо) — показуємо
          // зрозумілий стан замість мовчазного збою.
          drop.innerHTML = `<div class="mon-chat-drop-item" style="opacity:.5">Помилка списку</div>`;
          drop.classList.remove("hidden");
        }
      }
      inp.addEventListener("focus", _ensureChatsAndRender);
      inp.addEventListener("input", async () => {
        _sendChatId = "";
        const sb = document.getElementById(sendBtnId); if (sb) sb.disabled = true;
        await _ensureChatsAndRender();
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
      let image_base64 = "";
      if (getImageFn) {
        try { image_base64 = await getImageFn(); }
        catch(e) {
          window.reportClientError?.({
            action: "screenshot", category: "screenshot_failed",
            detail: String(e && e.message || e),
            extra: { source: sendBtnId },
          });
        }
      }
      const t0 = performance.now();
      try {
        const res = await fetch("/api/push/send", {
          method: "POST", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({ platform: _sendPlatform, chat_id: _sendChatId, text, image_base64 }),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d.ok) { if (window.appToast) window.appToast("Надіслано", "success"); }
        else {
          const errMsg = d.error || d.detail || `HTTP ${res.status}`;
          window.reportClientError?.({
            action: "send",
            category: res.status >= 500 ? "server_5xx" : (res.status >= 400 ? "server_4xx" : "bad_response"),
            detail: String(errMsg).slice(0, 300),
            extra: { platform: _sendPlatform, chat_id: _sendChatId, image_size: image_base64.length, http_status: res.status, duration_ms: Math.round(performance.now() - t0), source: sendBtnId },
          });
          if (window.appToast) window.appToast(errMsg, "error");
        }
      } catch(e) {
        const msg = String(e && e.message || e);
        window.reportClientError?.({
          action: "send", category: /timeout/i.test(msg) ? "timeout" : "network",
          detail: msg.slice(0, 300),
          extra: { platform: _sendPlatform, chat_id: _sendChatId, image_size: image_base64.length, duration_ms: Math.round(performance.now() - t0), source: sendBtnId },
        });
        if (window.appToast) window.appToast(msg, "error");
      }
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

  /* Keyboard handler: працює тільки коли таб «Моніторинг» активний (_active)
   * та фокус НЕ в полі введення (input/textarea/contenteditable). */
  function _onMonKeyboardNav(e) {
    if (!_active) return;
    // Не перехоплюємо модифіковані комбінації (Ctrl/Alt/Meta) — це системні шорткати.
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target;
    if (t && (t.matches?.("input, textarea, select, [contenteditable=true]") ||
              t.closest?.("[contenteditable=true]"))) return;
    let dir = 0;
    switch (e.key) {
      case "ArrowUp":
      case "ArrowRight":
        dir = -1; break;       // попереднє (новіше)
      case "ArrowDown":
      case "ArrowLeft":
        dir = +1; break;       // наступне (старіше)
      default:
        return;
    }
    e.preventDefault();
    _navigatePanel(dir);
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
    const n = _playlist ? _playlist.querySelectorAll(".mon-thumb--unread").length : 0;
    // Старий значок у прихованих legacy-табах (для зворотньої сумісності).
    if (_unreadBadge) {
      _unreadBadge.textContent = n > 0 ? String(n) : "";
      _unreadBadge.style.display = n > 0 ? "inline-flex" : "none";
    }
    // Новий видимий індикатор у mon-settings внизу плейлиста.
    const inline = document.getElementById("monUnreadInline");
    if (inline) {
      inline.textContent = n > 0 ? String(n) : "";
      inline.classList.toggle("hidden", n === 0);
    }
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

  // Захист від race condition: НЕ пушимо на сервер, поки не довантажились
  // авторитетні дані з нього. Інакше клієнт з кешем DEFAULTS перетре чужі
  // зміни. Прапорець ставиться в true ТІЛЬКИ після успішного fetch у
  // _tmplServerLoad. Поки flag=false, _tmplPushServer тихо скіпає POST.
  let _tmplServerLoaded = false;
  let _tmplPushTimer    = null;     // debounce таймер для частих _tmplPushServer
  let _tmplPushPending  = false;    // запит push був, але ще чекаємо server load

  function _loadTemplates() {
    try { const s = localStorage.getItem(LS_TEMPLATES); if (s) return JSON.parse(s); } catch(_){}
    return DEFAULT_TEMPLATES.map(t => ({...t}));
  }
  function _saveTemplates() {
    try { localStorage.setItem(LS_TEMPLATES, JSON.stringify(_templates)); } catch(_){}
    _tmplPushServer();
  }

  /* Зберегти весь стан шаблонів на сервер (спільні між комп'ютерами).
   * Debounced (300 мс) щоб серії викликів (input event на textarea, batch
   * редагувань) не били сервер на кожен символ. Якщо ще не відбулась
   * первинна синхронізація — відмічає pending і виконує одразу після неї. */
  function _tmplPushServer() {
    if (!_tmplServerLoaded) {
      _tmplPushPending = true;
      return;
    }
    if (_tmplPushTimer) clearTimeout(_tmplPushTimer);
    _tmplPushTimer = setTimeout(_tmplPushNow, 300);
  }

  function _tmplPushNow() {
    _tmplPushTimer = null;
    fetch("/api/conclusion-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        templates: _templates,
        autodetect: _loadAutoDetect(),
        default_text: _loadDefaultTmpl(),
      }),
    })
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      })
      .catch(err => {
        if (window.appToast) {
          window.appToast(`Шаблони не збережено: ${err.message || err}`, "error", 4000);
        }
        console.warn("[monitor] _tmplPushServer failed:", err);
      });
  }

  /* Завантажити спільні шаблони із сервера (перетирає локальний кеш). */
  async function _tmplServerLoad() {
    try {
      const r = await fetch("/api/conclusion-templates");
      const j = await r.json();
      if (!j || !j.ok) return;
      if (Array.isArray(j.templates)) {
        _templates = j.templates;
        try { localStorage.setItem(LS_TEMPLATES, JSON.stringify(_templates)); } catch (_) {}
      }
      try { localStorage.setItem(LS_TMPL_AUTODETECT, j.autodetect ? "1" : "0"); } catch (_) {}
      if (typeof j.default_text === "string") {
        try { localStorage.setItem(LS_DEFAULT_TMPL, j.default_text); } catch (_) {}
      }
      const modal = document.getElementById("monTemplatesModal");
      if (modal && !modal.classList.contains("hidden")) _renderTemplatesModal(modal);
      const adCb = document.getElementById("monTmplAutoDetect");
      if (adCb) adCb.checked = !!j.autodetect;

      // Авторитетний стан отриманий — дозволяємо push, виконуємо відкладений
      _tmplServerLoaded = true;
      if (_tmplPushPending) {
        _tmplPushPending = false;
        _tmplPushServer();
      }
    } catch (err) {
      // Сервер недоступний — НЕ ставимо _tmplServerLoaded=true, щоб клієнт
      // не зміг перетерти серверні дані локальним кешем.
      console.warn("[monitor] _tmplServerLoad failed, push disabled:", err);
      if (window.appToast) {
        window.appToast("Не вдалось завантажити шаблони з сервера. Зміни не зберігатимуться, поки зв'язок не відновиться.", "warn", 6000);
      }
    }
  }

  /* ── Middle toolbar + playlist navigation ── */
  function _initMiddleToolbar() {
    document.getElementById("monNavPrev")?.addEventListener("click", () => _navigatePanel(-1));
    document.getElementById("monNavNext")?.addEventListener("click", () => _navigatePanel(+1));
    document.getElementById("monPlaylistPrev")?.addEventListener("click", () => _navigatePanel(-1));
    document.getElementById("monPlaylistNext")?.addEventListener("click", () => _navigatePanel(+1));

    // Keyboard navigation: ↑/→ — попереднє (новіше), ↓/← — наступне (старіше).
    // Слухаємо глобально, але реагуємо тільки коли таб «Моніторинг» активний
    // і фокус НЕ всередині поля введення (input/textarea/contenteditable),
    // інакше будемо ламати редагування тексту.
    if (!window.__monKbdNavBound) {
      window.__monKbdNavBound = true;
      document.addEventListener("keydown", _onMonKeyboardNav);
    }

    // Share button
    document.getElementById("monShareBtn")?.addEventListener("click", _openShareModal);

    // Швидкий висновок: відкрити вкладку «Швидко», очистити інпут+карту,
    // вставити поточне перехоплення у багатолінійне поле.
    document.getElementById("monOpenQuick")?.addEventListener("click", () => {
      // Дозволяємо відкривати «Швидко» навіть БЕЗ обраного перехоплення —
      // тоді просто відкривається порожній iframe (форма для ручного вводу).
      if (window.itSetTab) window.itSetTab("quick");
      if (!_currentItem) return;
      const text = _buildPasteText(_currentItem);
      const iframe = document.querySelector('#itPaneQuick iframe');
      // iframe може ще завантажуватися — повторимо постмесидж, поки готовий
      let tries = 0;
      const send = () => {
        const win = iframe && iframe.contentWindow;
        if (!win) return;
        win.postMessage({ type: "qc:reset-and-paste", text }, "*");
      };
      const onLoad = () => { send(); iframe.removeEventListener("load", onLoad); };
      if (iframe) {
        iframe.addEventListener("load", onLoad);
        const t = setInterval(() => {
          tries++;
          send();
          if (tries > 20) clearInterval(t);   // ~2 с
        }, 100);
      }
    });

    // Open Висновок tab with current intercept pre-filled
    document.getElementById("monOpenConclusion")?.addEventListener("click", () => {
      // Дозволяємо відкривати Висновок навіть БЕЗ обраного перехоплення —
      // тоді модалка відкривається з порожніми полями (форма для ручного
      // введення/вставки). Якщо є _currentItem — заповнюємо як раніше.
      if (window.itSetTab) window.itSetTab("conclusion");
      setTimeout(() => {
        if (typeof window.clearConclWorkspace === "function") window.clearConclWorkspace();
        if (!_currentItem) return;
        _fillConclIntercept(_currentItem);
        const conclTa = document.getElementById("conclText");
        if (conclTa) {
          let text = _applyDefaultTemplate(_currentItem);
          if (_loadAutoDetect()) {
            const matched = _findMatchingTemplate(_currentItem);
            if (matched) {
              text = _substituteVars(_tmplText(matched), _currentItem);
              if (window.appToast) window.appToast(`Шаблон: ${_tmplName(matched) || "знайдено"}`, "success", 1600);
            }
          }
          conclTa.value = text;
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
  let _editingTmpl = null; // { catIdx, textIdx } | null

  /* Шаблон може бути рядком (legacy) або { name, text, keywords[] } */
  function _tmplName(e){ return (e && typeof e === "object") ? (e.name || "") : ""; }
  function _tmplText(e){ return (e && typeof e === "object") ? (e.text || "") : String(e || ""); }
  function _tmplKeywords(e){ return (e && typeof e === "object" && Array.isArray(e.keywords)) ? e.keywords : []; }
  function _tmplLabel(e){ const n = _tmplName(e); const t = _tmplText(e); return n || (t.length > 40 ? t.slice(0,40) + "…" : t); }

  /* Прапорець "Автовизначення" */
  const LS_TMPL_AUTODETECT = "monitorTmplAutoDetect_v1";
  function _loadAutoDetect(){ try { return localStorage.getItem(LS_TMPL_AUTODETECT) === "1"; } catch(_){ return false; } }
  function _saveAutoDetect(v){ try { localStorage.setItem(LS_TMPL_AUTODETECT, v ? "1" : "0"); } catch(_){} _tmplPushServer(); }

  /* Знайти шаблон, чиї ключові слова найкраще збігаються з текстом перехоплення */
  function _findMatchingTemplate(item){
    const text = ((item.text || "") + " " + (item.net_description || "")).toLowerCase();
    if (!text.trim()) return null;
    let best = null, bestCount = 0;
    _templates.forEach(cat => (cat.texts || []).forEach(entry => {
      const kws = _tmplKeywords(entry);
      if (!kws.length) return;
      let count = 0;
      kws.forEach(kw => { const k = String(kw || "").trim().toLowerCase(); if (k && text.includes(k)) count++; });
      if (count > bestCount) { bestCount = count; best = entry; }
    }));
    return bestCount > 0 ? best : null;
  }

  function _openTemplatesModal() {
    let modal = document.getElementById("monTemplatesModal");
    if (!modal) modal = _createTemplatesModal();
    _renderTemplatesModal(modal);
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }

  function _createTemplatesModal() {
    const modal = document.createElement("div");
    modal.id        = "monTemplatesModal";
    modal.className = "modal hidden";
    modal.setAttribute("aria-hidden", "true");
    modal.innerHTML =
      `<div class="modal-backdrop" data-close-tmpl="1"></div>` +
      `<div class="modal-card mon-tmpl-card" role="dialog" aria-modal="true">` +
        `<div class="modal-head">` +
          `<div style="font-weight:700">Шаблони висновків</div>` +
          `<div style="display:flex;align-items:center;gap:12px">` +
            `<label class="mon-tmpl-autodetect" title="Автоматично підбирати шаблон за ключовими словами при «Оформити аналітичний висновок»">` +
              `<input type="checkbox" id="monTmplAutoDetect"> Автовизначення` +
            `</label>` +
            `<button class="mon-tmpl-close-btn" data-close-tmpl="1" title="Закрити">` +
              `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>` +
            `</button>` +
          `</div>` +
        `</div>` +
        `<div class="modal-body mon-tmpl-body" id="monTmplBody"></div>` +
        `<div class="mon-tmpl-edit-panel hidden" id="monTmplEditPanel">` +
          `<div class="mon-tmpl-edit-head">` +
            `<span class="small" style="opacity:.65">Назва і текст шаблону</span>` +
            `<div style="display:flex;gap:6px">` +
              `<button class="secondary mon-anal-sm-btn" id="monTmplSave">Зберегти</button>` +
              `<button class="secondary mon-anal-sm-btn" id="monTmplDel" style="color:var(--danger);border-color:color-mix(in srgb,var(--danger) 35%,var(--border))">Видалити</button>` +
              `<button class="secondary mon-anal-sm-btn" id="monTmplEditClose">✕</button>` +
            `</div>` +
          `</div>` +
          `<input class="mon-tmpl-edit-name" id="monTmplEditName" type="text" placeholder="Назва шаблону (показується на кнопці)" autocomplete="off">` +
          `<textarea class="mon-tmpl-edit-ta" id="monTmplEditTa" rows="4" placeholder="Текст висновку, що вставляється"></textarea>` +
          `<input class="mon-tmpl-edit-kw" id="monTmplEditKw" type="text" placeholder="Слова автовизначення через кому (напр. бабка, мавік, скид)" autocomplete="off">` +
        `</div>` +
      `</div>`;

    modal.addEventListener("click", e => {
      if (e.target.closest("[data-close-tmpl]")) {
        _editingTmpl = null;
        modal.classList.add("hidden");
        modal.setAttribute("aria-hidden", "true");
      }
    });

    modal.querySelector("#monTmplEditClose").addEventListener("click", () => {
      _editingTmpl = null;
      modal.querySelector("#monTmplEditPanel").classList.add("hidden");
    });

    // Чекбокс "Автовизначення"
    const autoCb = modal.querySelector("#monTmplAutoDetect");
    if (autoCb) {
      autoCb.checked = _loadAutoDetect();
      autoCb.addEventListener("change", () => _saveAutoDetect(autoCb.checked));
    }

    modal.querySelector("#monTmplSave").addEventListener("click", () => {
      if (!_editingTmpl) return;
      const ta    = modal.querySelector("#monTmplEditTa");
      const nameI = modal.querySelector("#monTmplEditName");
      const kwI   = modal.querySelector("#monTmplEditKw");
      const txt   = (ta?.value || "").trim();
      const name  = (nameI?.value || "").trim();
      const keywords = (kwI?.value || "").split(",").map(s => s.trim()).filter(Boolean);
      const { catIdx, textIdx } = _editingTmpl;
      if (!txt) {
        if (window.appToast) window.appToast("Введіть текст шаблону", "warn", 1600);
        return;
      }
      if (!name) {
        if (window.appToast) window.appToast("Введіть назву шаблону", "warn", 1600);
        nameI?.focus();
        return;
      }
      const entry = { name, text: txt, keywords };
      if (textIdx === -1) _templates[catIdx].texts.push(entry);
      else                _templates[catIdx].texts[textIdx] = entry;
      _saveTemplates();
      _editingTmpl = null;
      modal.querySelector("#monTmplEditPanel").classList.add("hidden");
      _renderTemplatesModal(modal);
    });

    modal.querySelector("#monTmplDel").addEventListener("click", () => {
      if (!_editingTmpl || _editingTmpl.textIdx === -1) return;
      const { catIdx, textIdx } = _editingTmpl;
      _templates[catIdx].texts.splice(textIdx, 1);
      _saveTemplates();
      _editingTmpl = null;
      modal.querySelector("#monTmplEditPanel").classList.add("hidden");
      _renderTemplatesModal(modal);
    });

    document.body.appendChild(modal);
    return modal;
  }

  /* ── Default template (stored in localStorage) ── */
  const LS_DEFAULT_TMPL = "monitorDefaultTemplate_v1";
  const DEFAULT_TMPL_TEXT =
    "%ЛОКАЦІЯ\nПротивник зі складу %ПІДРОЗДІЛ здійснює переміщення в р-ні точки:";

  function _loadDefaultTmpl() {
    try { const s = localStorage.getItem(LS_DEFAULT_TMPL); if (s !== null) return s; } catch(_){}
    return DEFAULT_TMPL_TEXT;
  }
  function _saveDefaultTmpl(t) {
    try { localStorage.setItem(LS_DEFAULT_TMPL, t); } catch(_){}
    _tmplPushServer();
  }

  function _renderTemplatesModal(modal) {
    const body = modal.querySelector("#monTmplBody");
    if (!body) return;
    body.innerHTML = "";

    /* ── 0. Default template section (top) ── */
    const defSection = document.createElement("div");
    defSection.className = "mon-tmpl-default-section";
    defSection.innerHTML =
      `<div class="mon-tmpl-cat-header">` +
        `<span class="mon-tmpl-cat-name">Шаблон за замовчуванням</span>` +
        `<button class="secondary mon-tmpl-add-chip-btn mon-tmpl-default-insert" title="Вставити у висновок">📋</button>` +
      `</div>` +
      `<textarea class="mon-tmpl-default-ta" id="monTmplDefaultTa" rows="5" ` +
               `placeholder="%ЛОКАЦІЯ\n%ПІДРОЗДІЛ"></textarea>`;
    body.appendChild(defSection);

    const defTa = defSection.querySelector("#monTmplDefaultTa");
    defTa.value = _loadDefaultTmpl();
    defTa.addEventListener("blur",  () => _saveDefaultTmpl(defTa.value));
    defTa.addEventListener("input", () => _saveDefaultTmpl(defTa.value));

    defSection.querySelector(".mon-tmpl-default-insert").addEventListener("click", () => {
      const conclTa = document.getElementById("conclText");
      const txt = defTa.value.trim();
      if (conclTa && txt) {
        // Підставити змінні: _currentItem або текст з поля "Перехоплення".
        const item = _resolveSubstitutionItem();
        conclTa.value = item ? _substituteVars(txt, item) : txt;
        conclTa.focus();
      }
      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");
    });

    /* ── 1. Divider ── */
    const hr = document.createElement("hr");
    hr.className = "mon-tmpl-divider";
    body.appendChild(hr);

    /* ── 2. Categories ── */
    _templates.forEach((cat, catIdx) => {
      const section = document.createElement("div");
      section.className = "mon-tmpl-section";

      /* Category header: [NAME] [×] */
      const header = document.createElement("div");
      header.className = "mon-tmpl-cat-header";
      header.innerHTML =
        `<span class="mon-tmpl-cat-name">${_esc(cat.name)}</span>` +
        `<button class="secondary mon-tmpl-del-cat-btn" title="Видалити категорію">×</button>`;

      /* Chips row: [chip…] [+] */
      const chips = document.createElement("div");
      chips.className = "mon-tmpl-chips";

      if (!cat.texts.length) {
        const empty = document.createElement("span");
        empty.className = "mon-tmpl-no-items";
        empty.textContent = "Немає шаблонів";
        chips.appendChild(empty);
      } else {
        cat.texts.forEach((entry, textIdx) => {
          const label = _tmplLabel(entry);
          const text  = _tmplText(entry);
          const chip = document.createElement("button");
          chip.className   = "mon-tmpl-chip";
          chip.title       = "Клік — вставити · Ctrl+Клік — редагувати";
          chip.textContent = label;
          chip.addEventListener("click", e => {
            if (e.ctrlKey || e.metaKey) {
              _editingTmpl = { catIdx, textIdx };
              const ta    = modal.querySelector("#monTmplEditTa");
              const nameI = modal.querySelector("#monTmplEditName");
              const kwI   = modal.querySelector("#monTmplEditKw");
              if (ta)    ta.value = text;
              if (nameI) nameI.value = _tmplName(entry);
              if (kwI)   kwI.value = _tmplKeywords(entry).join(", ");
              modal.querySelector("#monTmplEditPanel").classList.remove("hidden");
              nameI?.focus();
            } else {
              const conclTa = document.getElementById("conclText");
              if (conclTa) {
                // Підставити змінні з активного перехоплення (_currentItem) АБО
                // з тексту, який щойно вставлений у поле "Перехоплення" у самій
                // модалці Висновок — інакше шаблон вставлявся з {ЗМІННИМИ} як є.
                const item = _resolveSubstitutionItem();
                conclTa.value = item ? _substituteVars(text, item) : text;
                conclTa.focus();
              }
              _editingTmpl = null;
              modal.querySelector("#monTmplEditPanel").classList.add("hidden");
              modal.classList.add("hidden");
              modal.setAttribute("aria-hidden", "true");
            }
          });
          chips.appendChild(chip);
        });
      }

      /* "+" button — always last in chips row */
      const addBtn = document.createElement("button");
      addBtn.className = "secondary mon-tmpl-add-chip-btn";
      addBtn.title     = "Додати шаблон";
      addBtn.textContent = "+";
      addBtn.addEventListener("click", () => {
        _editingTmpl = { catIdx, textIdx: -1 };
        const ta    = modal.querySelector("#monTmplEditTa");
        const nameI = modal.querySelector("#monTmplEditName");
        const kwI   = modal.querySelector("#monTmplEditKw");
        if (ta)    ta.value = "";
        if (nameI) nameI.value = "";
        if (kwI)   kwI.value = "";
        modal.querySelector("#monTmplEditPanel").classList.remove("hidden");
        nameI?.focus();
      });
      chips.appendChild(addBtn);

      section.appendChild(header);
      section.appendChild(chips);
      body.appendChild(section);

      /* Delete category */
      header.querySelector(".mon-tmpl-del-cat-btn").addEventListener("click", () => {
        if (!confirm(`Видалити категорію «${cat.name}»?`)) return;
        _templates.splice(catIdx, 1);
        _saveTemplates();
        _renderTemplatesModal(modal);
      });
    });

    /* Add category button */
    const addCat = document.createElement("button");
    addCat.className = "secondary mon-tmpl-add-cat-btn";
    addCat.innerHTML = `<span>+</span> ДОДАТИ КАТЕГОРІЮ`;
    addCat.addEventListener("click", () => {
      const name = prompt("Назва нової категорії:");
      if (!name?.trim()) return;
      _templates.push({ id: "cat_" + Date.now(), name: name.trim(), texts: [] });
      _saveTemplates();
      _renderTemplatesModal(modal);
    });
    body.appendChild(addCat);
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

  let _shareOutsideHandler = null;

  // Стан останнього виклику Share-панелі — звідки відкрили та як зібрати
  // текст (опційно картинку) для відправки. Дозволяє перевикорстовувати
  // ту саму панель з Моніторингу і з Висновку.
  let _shareOpts = null;

  function _openShareModal(opts) {
    opts = opts || {};
    const btnId = opts.btnId || "monShareBtn";
    _shareOpts = opts;

    let panel = document.getElementById("monSharePanel");
    if (!panel) panel = _createShareModal();

    if (!panel.classList.contains("hidden")) {
      _closeShareModal(panel);
      return;
    }

    _renderShareRows(panel);
    panel.classList.remove("hidden");

    // Position below the originating button, aligned to its right edge
    const btn = document.getElementById(btnId);
    if (btn) {
      const r = btn.getBoundingClientRect();
      panel.style.top   = (r.bottom + 6) + "px";
      panel.style.right = (window.innerWidth - r.right) + "px";
    }

    // Close on outside click — обробник тримає посилання на конкретну кнопку,
    // щоб клік по ній знову не вважався «outside».
    if (_shareOutsideHandler) document.removeEventListener("click", _shareOutsideHandler);
    _shareOutsideHandler = function(e) {
      const p = document.getElementById("monSharePanel");
      const b = document.getElementById(btnId);
      if (!p || p.classList.contains("hidden")) {
        document.removeEventListener("click", _shareOutsideHandler);
        return;
      }
      if (!p.contains(e.target) && !b?.contains(e.target)) {
        _closeShareModal(p);
        document.removeEventListener("click", _shareOutsideHandler);
      }
    };
    setTimeout(() => document.addEventListener("click", _shareOutsideHandler), 0);
  }

  function _shareSetError(msg) {
    const el = document.getElementById("monShareErr");
    if (!el) return;
    el.textContent = msg || "";
    el.style.display = msg ? "block" : "none";
  }

  function _createShareModal() {
    const panel = document.createElement("div");
    panel.id        = "monSharePanel";
    panel.className = "mon-share-panel hidden";
    panel.innerHTML =
      `<div id="monShareRows" class="mon-share-rows"></div>` +
      `<div id="monShareErr" class="mon-share-err" style="display:none"></div>` +
      `<div class="mon-share-panel-foot">` +
        `<button class="icon-btn" id="monShareAddBtn" title="Додати отримувача">` +
          `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="10" y1="4" x2="10" y2="16"/><line x1="4" y1="10" x2="16" y2="10"/></svg>` +
        `</button>` +
        `<button class="icon-btn icon-btn--accent" id="monShareSendBtn" title="Надіслати обраним">` +
          `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="10" x2="17" y2="10"/><polyline points="12 5 17 10 12 15"/></svg>` +
        `</button>` +
      `</div>`;

    panel.querySelector("#monShareAddBtn").addEventListener("click",  () => _addShareRow(panel));
    panel.querySelector("#monShareSendBtn").addEventListener("click", () => _sendToRecipients(panel));
    document.body.appendChild(panel);
    return panel;
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
    // Drop винесений із .mon-share-bar (де overflow:hidden обрізав варіанти).
    return `<div class="mon-share-row" data-rid="${_esc(r.id)}">` +
      `<input type="checkbox" class="mon-share-chk" ${r.checked ? "checked" : ""}>` +
      `<div class="mon-share-bar">` +
        `<button class="mon-share-platform-btn mon-share-platform" data-rid="${_esc(r.id)}" ` +
                `style="background:${pi.color}">${pi.label}</button>` +
        `<div class="mon-share-middle">` +
          `<input class="mon-share-chat-in" type="text"` +
                 ` placeholder="Назва чату або контакта…"` +
                 ` value="${_esc(r.chatName)}" autocomplete="off" data-rid="${_esc(r.id)}">` +
        `</div>` +
        `<button class="mon-share-del-btn mon-share-del" data-rid="${_esc(r.id)}" title="Видалити">✕</button>` +
      `</div>` +
      `<div class="mon-share-drop hidden" data-rid="${_esc(r.id)}"></div>` +
    `</div>`;
  }

  function _attachShareRowEvents(container, modal) {
    // Platform toggle (cycles S→W→T)
    container.querySelectorAll(".mon-share-platform").forEach(btn => {
      btn.addEventListener("click", (e) => {
        // stopPropagation: ре-рендер видаляє цю кнопку з DOM, тож
        // глобальний outside-click handler побачив би e.target поза
        // панеллю і закрив би модалку.
        e.stopPropagation();
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
      btn.addEventListener("click", (e) => {
        // stopPropagation: див. коментар до toggle вище.
        e.stopPropagation();
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
    _shareSetError("");
    const list     = _loadRecipients();
    const selected = list.filter(r => r.checked && r.chatId);
    if (!selected.length) { _shareSetError("Оберіть чат зі списку (введіть назву та виберіть варіант)"); return; }

    // Збір payload — або через кастомний builder з опцій, або стандартно
    // з поточного перехоплення на Моніторингу.
    let text = "";
    let image_base64 = "";
    if (_shareOpts && typeof _shareOpts.buildPayload === "function") {
      try {
        const payload = await _shareOpts.buildPayload();
        text = String(payload?.text || "").trim();
        image_base64 = String(payload?.image_base64 || "");
      } catch (e) {
        _shareSetError("Помилка підготовки тексту");
        return;
      }
      if (!text && !image_base64) {
        _shareSetError("Текст та зображення порожні");
        return;
      }
    } else {
      if (!_currentItem) { _shareSetError("Спочатку оберіть перехоплення зі списку"); return; }
      text = _buildPasteText(_currentItem);
    }

    const btn  = modal.querySelector("#monShareSendBtn");
    if (btn) { btn.disabled = true; btn.style.opacity = ".4"; }

    let sent = 0, errors = 0;
    for (const r of selected) {
      try {
        const body = { platform: r.platform, chat_id: r.chatId, text };
        if (image_base64) body.image_base64 = image_base64;
        const res = await fetch("/api/push/send", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d.ok) sent++;
        else errors++;
      } catch(_) { errors++; }
    }

    if (btn) { btn.disabled = false; btn.style.opacity = ""; }
    if (errors > 0) {
      _shareSetError(`Помилка надсилання (${errors} з ${selected.length})`);
    } else {
      if (window.appToast) window.appToast(`Надіслано: ${sent}`, "success");
      _closeShareModal(modal);
    }
  }

  function _closeShareModal(panel) {
    panel.classList.add("hidden");
  }

  /* ===================================================================
   *  ЕКСТРАКТОРИ з тексту перехоплення — квадрат і координати УСК-2000.
   *  Радіоперехоплення «брудні»: числа диктують групами (39 966 = 39966),
   *  повторюють для підтвердження, інколи з відбоями. v1 надійно бере
   *  чисті випадки; складні (відбої/кілька координат) — для доопрацювання.
   * =================================================================== */

  /* Вирізає шапку перехоплення (дата/частота/мережа/позивні) — усе до першого
     порожнього рядка. Без цього reassembler склеює цифри часу й частоти
     (напр. "19" з 18:38:19 + "156" з 156.4750 → 19156) і зміщує пари. */
  function _bodyOnly(text) {
    const s = String(text || "");
    const m = s.match(/\n\s*\n([\s\S]*)$/);
    return m ? m[1] : s;
  }

  /* Квадрати: усі унікальні пари двозначних чисел.
     Два проходи:
       1) у радіусі ±40 символів від слова «квадрат*» дозволяємо роздільником
          також кому/тире (диктують "27, 18", "27-18");
       2) глобальний строгий пробіл "XX XX" — як підстраховка, коли індикатора
          поруч немає.
     Без прив'язки до «квадрат» комою не парсимо — інакше будь-які два
     двозначні в тілі давали б хибні матчі. */
  function _extractSquares(text) {
    const s = String(text || "");
    const out = [], seen = new Set();
    const add = (k) => { if (!seen.has(k)) { seen.add(k); out.push(k); } };

    const indicators = /квадрат\S*/gi;
    let m;
    while ((m = indicators.exec(s)) !== null) {
      const start = Math.max(0, m.index - 40);
      const end   = Math.min(s.length, m.index + m[0].length + 40);
      const ctx   = s.slice(start, end);
      const wide  = /(?<!\d)(\d{2})[\s,\-]+(\d{2})(?!\d)/g;
      let mm;
      while ((mm = wide.exec(ctx)) !== null) add(`${mm[1]} ${mm[2]}`);
    }

    const strict = /(?<!\d)(\d{2})\s+(\d{2})(?!\d)/g;
    while ((m = strict.exec(s)) !== null) add(`${m[1]} ${m[2]}`);

    return out;
  }

  /* Збирає 5-значні числа з груп цифр: "39 966" (2+3) → 39966; "10403" → 10403. */
  function _reassemble5(text) {
    const groups = (String(text || "").match(/\d+/g) || []);
    const nums = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.length === 5) nums.push(g);
      else if (g.length === 2 && i + 1 < groups.length && groups[i + 1].length === 3) {
        nums.push(g + groups[i + 1]); i++;
      }
    }
    return nums;
  }

  /* Схлопує підряд однакові числа (підтвердження) або з однаковими
     першими 2 цифрами (повтор тієї самої координати з обмовкою). */
  function _collapse5(nums) {
    const out = [];
    for (const n of nums) {
      const prev = out[out.length - 1];
      if (prev && (prev === n || prev.slice(0, 2) === n.slice(0, 2))) continue;
      out.push(n);
    }
    return out;
  }

  /* Повертає масив {x,y} пар (5-значні рядки) УСК-2000. */
  function _extractUskPairs(text) {
    const nums = _collapse5(_reassemble5(text));
    const pairs = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pairs.push({ x: nums[i], y: nums[i + 1] });
    const seen = new Set(), out = [];
    for (const p of pairs) { const k = p.x + "_" + p.y; if (seen.has(k)) continue; seen.add(k); out.push(p); }
    return out;
  }

  /* Розширений екстрактор УСК-2000 координат. Повертає {x,y} пари.
   *
   * Алгоритм:
   *   1. Lowercase. Цифрові групи з позиціями (без перетворення тексту).
   *   2. Склеюємо ПОСЛІДОВНІ цифрові групи, які розділені ЛИШЕ пробілами/
   *      табами (без переноса рядка, без коми/крапки/інших знаків). Це
   *      ловить побукно-диктовку: "54 24 6 2 7" → "5424627".
   *   3. Класифікуємо кластери за довжиною:
   *        14: якщо a==b → повтор; інакше пара "X+Y" якщо префікси 54/74 валідні
   *        10: якщо a==b → нейтральне X або Y; інакше пара (5+5)
   *        7:  має починатись на "54" (X) або "74" (Y), інакше відкинути
   *        5:  нейтральний кандидат для іменної логіки
   *   4. "харитон"=X, "уляна"=Y витягують найближчий 5-значний з нейтралів.
   *   5. Пари формуються жадібним парним зіставленням найближчих за позицією.
   *   6. Fallback: якщо ні X, ні Y не знайдено, але є нейтральні —
   *      попарно зв'язуємо (1-2, 3-4, …).
   *
   * Завдяки обов'язковому префіксу 54/74 для 7-цифрових і пунктуаційному
   * бар'єру для склейок шапка "03.06.2026, 15:04:12" та частоти на кшталт
   * "166.8000" НЕ дають хибно-позитивних результатів.
   */
  function _extractUskPairsV2(text) {
    const lower = String(text || "").toLowerCase();
    if (!lower) return [];

    // 1. Усі raw-послідовності цифр з позиціями.
    const rawRuns = [];
    for (const m of lower.matchAll(/\d+/g)) {
      rawRuns.push({ value: m[0], idx: m.index, end: m.index + m[0].length });
    }

    // 1b. Згортання послідовних задвоєних 2-3-значних груп, розділених лише
    //     пунктуацією/пробілами. Радіоператор часто диктує
    //     "74, 74 19, 19 8 4 7" — повторюючи короткі частини. Інакше
    //     склеювання дасть кашу (бо коми розривають кластери).
    //     Дозволяємо до K послідовних однакових повторень.
    const dedupedRuns = [];
    let k = 0;
    while (k < rawRuns.length) {
      const cur = rawRuns[k];
      let j = k;
      while (
        j + 1 < rawRuns.length &&
        rawRuns[j + 1].value === cur.value &&
        (cur.value.length === 2 || cur.value.length === 3) &&
        /^[,\s]+$/.test(lower.slice(rawRuns[j].end, rawRuns[j + 1].idx))
      ) {
        j++;
      }
      dedupedRuns.push({ value: cur.value, idx: cur.idx, end: rawRuns[j].end });
      k = j + 1;
    }

    // 2. Склеювання через пробіли/таби АБО крапку (без \n / коми / інших знаків)
    //    і не більше ніж до 14 цифр (повний XY = 7+7 = 14). Крапка важлива бо
    //    радіооператори часто диктують "25. 2 2 8 07. 151" — без неї такі
    //    послідовності розривалися на ізольовані "25", "22807", "151" і пара
    //    координат (25228, 07151) не формувалась.
    //    ⚠ Передавати сюди слід лише ТІЛО (без шапки) — інакше "06.06.2026"
    //    зіллється у фейковий 10-значний кластер.
    const clusters = [];
    for (const r of dedupedRuns) {
      const last = clusters[clusters.length - 1];
      if (last) {
        const between = lower.slice(last.end, r.idx);
        if (/^[. \t]+$/.test(between) && last.value.length + r.value.length <= 14) {
          last.value += r.value;
          last.end = r.end;
          continue;
        }
      }
      clusters.push({ value: r.value, idx: r.idx, end: r.end });
    }

    const isX7 = v => v.length === 7 && v.startsWith("54");
    const isY7 = v => v.length === 7 && v.startsWith("74");

    const directPairs = [];      // готові пари (з 14- і 10-цифрових склейок)
    const xList = [];            // 7-цифрові X-кандидати
    const yList = [];            // 7-цифрові Y-кандидати
    const neutrals = [];         // 5-цифрові кандидати (без префікса)

    for (const c of clusters) {
      const v = c.value, L = v.length;
      if (L === 14) {
        const a = v.slice(0, 7), b = v.slice(7);
        if (a === b) {
          if (isX7(a))      xList.push({ value: a, idx: c.idx });
          else if (isY7(a)) yList.push({ value: a, idx: c.idx });
        } else if (isX7(a) && isY7(b)) {
          directPairs.push({ x: a, y: b });
        } else if (isY7(a) && isX7(b)) {
          directPairs.push({ x: b, y: a });
        } else {
          if (isX7(a))      xList.push({ value: a, idx: c.idx });
          else if (isY7(a)) yList.push({ value: a, idx: c.idx });
          if (isX7(b))      xList.push({ value: b, idx: c.end });
          else if (isY7(b)) yList.push({ value: b, idx: c.end });
        }
      } else if (L === 10) {
        const a = v.slice(0, 5), b = v.slice(5);
        if (a === b) neutrals.push({ value: a, idx: c.idx });
        else         directPairs.push({ x: a, y: b });
      } else if (L === 7) {
        if (isX7(v))      xList.push({ value: v, idx: c.idx });
        else if (isY7(v)) yList.push({ value: v, idx: c.idx });
      } else if (L === 5) {
        neutrals.push({ value: v, idx: c.idx });
      }
    }

    // 3. Чистимо нейтралі: якщо 5-значне число є хвостом якогось вже
    //    зафіксованого 7-значного X/Y — це не окрема координата, а шматок
    //    повної (наприклад "19847" як суфікс "7419847"). Викидаємо.
    const tailsX = new Set(xList.map(x => x.value.slice(2)));
    const tailsY = new Set(yList.map(y => y.value.slice(2)));
    const cleanNeutrals = neutrals.filter(n => !tailsX.has(n.value) && !tailsY.has(n.value));

    // 4. Іменна логіка: маркер→найближчий нейтральний СПРАВА, але не далі
    //    ніж MARKER_MAX_DIST символів (одне-два слова). Без цього обмеження
    //    "харитон" з'являється у багатьох позиціях і може зловити чужий
    //    нейтральний за кілометри тексту.
    const MARKER_MAX_DIST = 40;
    function findMarkerNeutral(markerRe, ns) {
      if (!ns.length) return null;
      const matches = [...lower.matchAll(markerRe)];
      if (!matches.length) return null;
      let best = null, bestDist = Infinity;
      for (const m of matches) {
        for (const n of ns) {
          if (n.idx <= m.index) continue;
          const d = n.idx - m.index;
          if (d > MARKER_MAX_DIST) continue;
          if (d < bestDist) { bestDist = d; best = n; }
        }
      }
      return best;
    }

    const xNeutral = findMarkerNeutral(/харитон/g, cleanNeutrals);
    const yNeutral = findMarkerNeutral(/уляна/g,   cleanNeutrals);
    if (xNeutral) xList.push({ value: xNeutral.value, idx: xNeutral.idx });
    if (yNeutral && yNeutral !== xNeutral) yList.push({ value: yNeutral.value, idx: yNeutral.idx });

    // 4. Дедуплікація послідовних дублів (повтор для підтвердження).
    const dedupConsec = (list) => {
      list.sort((a, b) => a.idx - b.idx);
      const out = [];
      for (const t of list) {
        const prev = out[out.length - 1];
        if (prev && prev.value === t.value) continue;
        out.push(t);
      }
      return out;
    };
    const xClean = dedupConsec(xList);
    const yClean = dedupConsec(yList);

    // 5. Жадібне парне зіставлення X-Y за близькістю в тексті.
    //    Сортуємо всі (X,Y)-комбінації за відстанню; беремо найменші, маркуючи
    //    вибрані вершини як зайняті. Це коректно ловить випадок, коли X1 не
    //    отримав свого Y (диктовка обірвалась), а Y3 ближчий до X2.
    const pairOpts = [];
    for (const x of xClean) {
      for (const y of yClean) {
        pairOpts.push({ x, y, dist: Math.abs(x.idx - y.idx) });
      }
    }
    pairOpts.sort((a, b) => a.dist - b.dist);

    const proximityPairs = [];
    const usedX = new Set(), usedY = new Set();
    for (const o of pairOpts) {
      if (usedX.has(o.x) || usedY.has(o.y)) continue;
      proximityPairs.push({ x: o.x.value, y: o.y.value });
      usedX.add(o.x); usedY.add(o.y);
    }

    // 6. Fallback: лише нейтральні без префіксів і без directPairs/X/Y.
    const fallbackPairs = [];
    if (!directPairs.length && !xClean.length && !yClean.length) {
      const dn = dedupConsec(cleanNeutrals);
      for (let i = 0; i + 1 < dn.length; i += 2) {
        fallbackPairs.push({ x: dn[i].value, y: dn[i + 1].value });
      }
    }

    // 7. Об'єднання та глобальна дедуплікація.
    const seen = new Set();
    const result = [];
    for (const p of [...directPairs, ...proximityPairs, ...fallbackPairs]) {
      const k = `${p.x}_${p.y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      result.push({ x: p.x, y: p.y, full: p.x.length === 7 || p.y.length === 7 });
    }
    return result;
  }

  /* Ставить точку УСК-2000, приймаючи 5- або 7-значні X та Y.
   * 5-значні автоматично доповнюються префіксами 54 / 74. */
  function _placeUskPair(x, y) {
    if (!_conclMap || !x || !y) return false;
    const fx = x.length === 7 ? x : ("54" + x);
    const fy = y.length === 7 ? y : ("74" + y);
    const c  = _usk2000ToLatLon(parseInt(fx, 10), parseInt(fy, 10));
    if (c && isFinite(c.lat) && isFinite(c.lon)) {
      _addFixedMarker(_conclMap, c.lat, c.lon, `${fx} ${fy}`);
      _conclMap.setView([c.lat, c.lon], Math.max(_conclMap.getZoom(), 13));
      return true;
    }
    return false;
  }

  /* Ставить точку УСК-2000 з двох 5-значних чисел (54xxxxx / 74xxxxx).
     НЕ чіпає пошукове поле — щоб у ньому лишився УСК-рядок для перевірки. */
  function _placeUsk5(x5, y5) {
    if (!_conclMap) return false;
    const fx = "54" + x5, fy = "74" + y5;          // повний формат УСК-2000
    const c = _usk2000ToLatLon(parseInt(fx, 10), parseInt(fy, 10));
    if (c && isFinite(c.lat) && isFinite(c.lon)) {
      _addFixedMarker(_conclMap, c.lat, c.lon, `${fx} ${fy}`);
      _conclMap.setView([c.lat, c.lon], Math.max(_conclMap.getZoom(), 13));
      return true;
    }
    return false;
  }

  /* Підставляє значення в інпут над картою й імітує Enter (повторно використовує
     наявну логіку розбору квадрат/УСК/MGRS). */
  function _submitCoordInput(val) {
    const ci = document.getElementById("conclCoordInput");
    if (!ci) return;
    ci.value = val;
    ci.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }

  /* Зібрати "pseudoItem" з довільного тексту перехоплення:
   * витягти UNIT і LOCATION з шапки формату
   *   "<emoji> укх р/м <UNIT> (<NET_DESCRIPTION>)"
   * щоб _substituteVars міг підставити %ПІДРОЗДІЛ та %ЛОКАЦІЯ.
   * Якщо шапку не знайдено — повертаємо item з порожніми UNIT/LOCATION
   * (змінні в шаблоні будуть замінені на "").
   */
  function _buildPseudoItem(text) {
    const txt = String(text || "");
    let unit = "";
    let netDesc = "";
    // "р/м" може писатися як "р/м" / "р/c" / з пробілами; ловимо мінімум через "р/м".
    const m = txt.match(/р\/м\s+([^()\n\r]+?)\s*\(([^)\n\r]+)\)/i);
    if (m) {
      unit    = m[1].trim();
      netDesc = m[2].trim();
    }
    return { text: txt, net_description: netDesc, network: { unit } };
  }

  /* Спроба підібрати "контекст" для підстановки в шаблон:
   * 1) _currentItem (якщо обрано перехоплення в моніторі);
   * 2) інакше — текст з #conclInterceptTa у модалці Висновок.
   * Повертає null якщо ні те ні інше не дає корисного контексту.
   */
  function _resolveSubstitutionItem() {
    if (_currentItem) return _currentItem;
    const ta = document.getElementById("conclInterceptTa");
    const txt = (ta?.value || "").trim();
    if (!txt) return null;
    return _buildPseudoItem(txt);
  }

  /* Згенерувати текст висновку з довільного тексту перехоплення (без _currentItem). */
  function _generateConclFromText(text) {
    const pseudoItem = _buildPseudoItem(text);
    const matched = _findMatchingTemplate(pseudoItem);
    if (matched) {
      return {
        text: _substituteVars(_tmplText(matched), pseudoItem),
        templateName: _tmplName(matched) || "",
      };
    }
    return {
      text: _applyDefaultTemplate(pseudoItem),
      templateName: "",
    };
  }

  function _initInterceptExtractors() {
    const ta = document.getElementById("conclInterceptTa");

    document.getElementById("conclPasteInterceptBtn")?.addEventListener("click", async () => {
      let pasted = "";
      try {
        pasted = await navigator.clipboard.readText();
      } catch (_) {
        if (window.appToast) window.appToast("Немає доступу до буфера обміну", "warn", 2200);
        return;
      }
      pasted = String(pasted || "").trim();
      if (!pasted) {
        if (window.appToast) window.appToast("Буфер порожній", "info", 1400);
        return;
      }
      if (ta) { ta.value = pasted; ta.focus(); }
      // Очистити карту: попередні точки/чіпи/намальовані об'єкти з минулого
      // запуску більше не актуальні, бо паста — це новий контекст.
      _clearMapObjects();
      // Згенерувати висновок у верхньому полі.
      const conclTa = document.getElementById("conclText");
      if (conclTa) {
        const { text: out, templateName } = _generateConclFromText(pasted);
        conclTa.value = out;
        if (window.appToast) {
          const msg = templateName
            ? `Шаблон: ${templateName}`
            : "Категорію не визначено — дефолтний шаблон";
          window.appToast(msg, "success", 1800);
        }
      }
      // Палітри для частоти: підвантажити перелік для вставленого перехоплення
      // (немає активного _currentItem — резолвимо контекст із тексту).
      if (!_currentItem) {
        _palCtxFromText(pasted).then(ctx => _loadConclPalettes(ctx)).catch(() => {});
      }
    });

    // Ручна вставка/набір у поле «Перехоплення» (без активного перехоплення) —
    // також оновлюємо перелік палітр (з невеликою затримкою).
    if (ta) {
      let _palTextTimer = null;
      ta.addEventListener("input", () => {
        if (_currentItem) return;   // активне перехоплення керує палітрами саме
        clearTimeout(_palTextTimer);
        const val = ta.value;
        _palTextTimer = setTimeout(() => {
          const t = (val || "").trim();
          if (!t) { _loadConclPalettes({ unit: "", network_id: 0 }); return; }
          _palCtxFromText(t).then(ctx => _loadConclPalettes(ctx)).catch(() => {});
        }, 650);
      });
    }

    document.getElementById("conclFindSquareBtn")?.addEventListener("click", () => {
      const squares = _extractSquares(_bodyOnly(ta ? ta.value : ""));
      if (!squares.length) { if (window.appToast) window.appToast("Квадрат не знайдено", "info", 1600); return; }
      squares.forEach(sq => _submitCoordInput(sq));
      if (window.appToast && squares.length > 1) window.appToast(`Знайдено квадратів: ${squares.length}`, "success", 1800);
    });
    document.getElementById("conclFindCoordBtn")?.addEventListener("click", () => {
      const fullText = ta ? ta.value : "";
      // Тільки тіло перехоплення (без шапки з датою/частотою). Шапку
      // вирізаємо тому що "." тепер входить у роздільник склейки —
      // інакше "06.06.2026 13:01:37" склеїлось би у фейковий 10-значний
      // кластер з фейковою парою X/Y.
      const body = _bodyOnly(fullText);
      let pairs = _extractUskPairsV2(body);
      // Fallback на старий, якщо новий нічого не знайшов.
      if (!pairs.length) pairs = _extractUskPairs(body);
      if (!pairs.length) { if (window.appToast) window.appToast("Координати не знайдено", "info", 1600); return; }
      pairs.forEach(p => _placeUskPair(p.x, p.y));
      const ci = document.getElementById("conclCoordInput");
      if (ci) ci.value = "";
      if (window.appToast && pairs.length > 1) window.appToast(`Знайдено координат: ${pairs.length}`, "success", 1800);
    });
  }

  /* ===================================================================
   *  ПАЛІТРИ — висувна панель (адміністрування + scope), пошук по коду,
   *  рендеринг областей на карті.
   * =================================================================== */
  const PAL_SCOPE_KEY = "concl_palette_scope";   // Set<id> у localStorage
  let _palScope = _palLoadScope();               // обрані палітри для пошуку
  let _palList  = [];                            // кеш списку палітр
  const _palRegionLayers = new Map();            // palette_id → [layers] на карті
  let _palMatchMarkers = [];                     // тимчасові маркери збігів (legacy fallback)
  // Активні пошуки точок палітри. Кожен запис відповідає одному чіпу в
  // конт-інпуті "Координати" і утримує всі рендернуті варіанти на карті:
  //   { code, markers: [L.marker], chipEl, mapRef }
  let _palSearchChips = [];
  let _palRefreshToken = 0;                       // захист від гонки при перепошуку чіпів

  function _palLoadScope() {
    try { return new Set(JSON.parse(localStorage.getItem(PAL_SCOPE_KEY) || "[]")); }
    catch (_) { return new Set(); }
  }
  function _palSaveScope() {
    try { localStorage.setItem(PAL_SCOPE_KEY, JSON.stringify([..._palScope])); } catch (_) {}
  }

  function _paletteInit() {
    const panel = document.getElementById("palPanel");
    const btn   = document.getElementById("palPanelBtn");
    if (!panel || !btn) return;

    btn.addEventListener("click", () => {
      const willOpen = panel.classList.contains("hidden");
      panel.classList.toggle("hidden");
      panel.setAttribute("aria-hidden", willOpen ? "false" : "true");
      if (willOpen) {
        _palScope.clear(); _palSaveScope();   // при відкритті — жодна палітра не виділена (пошук по всіх)
        _palLoadUnits(); _palLoadList();
      }
    });
    document.getElementById("palPanelClose")?.addEventListener("click", () => {
      panel.classList.add("hidden");
      panel.setAttribute("aria-hidden", "true");
    });

    document.getElementById("palUnitFilter")?.addEventListener("change", _palLoadList);
    document.getElementById("palIncludeArchived")?.addEventListener("change", _palLoadList);

    // Імпорт
    const fileInput = document.getElementById("palFileInput");
    document.getElementById("palImportBtn")?.addEventListener("click", () => fileInput?.click());
    fileInput?.addEventListener("change", () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) _palAnalyzeFile(f);
      fileInput.value = "";
    });
    document.getElementById("palImportCancel")?.addEventListener("click", _palCloseDialog);
  }

  async function _palLoadUnits() {
    const sel = document.getElementById("palUnitFilter");
    if (!sel || sel.dataset.loaded) return;
    try {
      const r = await fetch("/api/palettes/units");
      const j = await r.json();
      (j.units || []).forEach(u => {
        const o = document.createElement("option");
        o.value = u.id; o.textContent = u.name; sel.appendChild(o);
      });
      sel.dataset.loaded = "1";
    } catch (_) {}
  }

  async function _palLoadList() {
    const host = document.getElementById("palList");
    if (!host) return;
    const inclArch = document.getElementById("palIncludeArchived")?.checked ? 1 : 0;
    const unitId   = document.getElementById("palUnitFilter")?.value || "";
    const qs = new URLSearchParams({ include_archived: String(inclArch) });
    if (unitId) qs.set("unit_id", unitId);
    host.innerHTML = '<div class="pal-empty">Завантаження…</div>';
    try {
      const r = await fetch("/api/palettes?" + qs.toString());
      const j = await r.json();
      _palList = j.palettes || [];
      _palRenderList();
    } catch (_) {
      host.innerHTML = '<div class="pal-empty">Помилка завантаження</div>';
    }
  }

  function _palStaleBadge(p) {
    // Неактуальна: не використовувалась і імпортована давно (>120 днів).
    const ref = p.last_used_at || p.imported_at;
    if (!ref) return "";
    const days = (Date.now() - new Date(ref).getTime()) / 86400000;
    if (p.use_count === 0 && days > 120)
      return ' · <span class="pal-stale">неактуальна?</span>';
    return "";
  }

  function _palRenderList() {
    const host = document.getElementById("palList");
    if (!host) return;
    if (!_palList.length) { host.innerHTML = '<div class="pal-empty">Палітр немає. Імпортуйте KMZ/KML.</div>'; return; }
    host.innerHTML = "";
    _palList.forEach(p => {
      const item = document.createElement("div");
      item.className = "pal-item" + (p.is_archived ? " is-archived" : "");
      const inScope = _palScope.has(p.id);
      const units = (p.units || []).map(u => `<span class="pal-unit-chip">${_esc(u.name)}</span>`).join("");
      item.innerHTML = `
        <div class="pal-item-top">
          <input type="checkbox" class="pal-item-check" ${inScope ? "checked" : ""} title="Шукати в цій палітрі">
          <span class="pal-item-name" title="${_esc(p.name)}">${_esc(p.name)}</span>
          <button class="pal-btn pal-show" title="Показати області на карті">🗺</button>
        </div>
        <div class="pal-item-meta">
          <span>${p.point_count} тчк · ${p.region_count} обл.</span>
          <span>викор.: ${p.use_count}${_palStaleBadge(p)}</span>
        </div>
        <div class="pal-item-units">${units}</div>
        <div class="pal-item-actions">
          ${p.is_archived
            ? `<button class="pal-btn pal-unarch">Розархівувати</button>`
            : `<button class="pal-btn pal-arch">Архівувати</button>`}
          <button class="pal-btn pal-btn--danger pal-del">Видалити</button>
          <button class="pal-btn pal-edit">Редагувати</button>
        </div>`;
      item.querySelector(".pal-item-check").addEventListener("change", (e) => {
        if (e.target.checked) _palScope.add(p.id); else _palScope.delete(p.id);
        _palSaveScope();
        _palRefreshSearchChips();   // перепошук по кодах із чіпів під новий scope
      });
      item.querySelector(".pal-show").addEventListener("click", () => _palToggleRegions(p.id));
      item.querySelector(".pal-arch")?.addEventListener("click", () => _palAction(p.id, "archive"));
      item.querySelector(".pal-unarch")?.addEventListener("click", () => _palAction(p.id, "unarchive"));
      item.querySelector(".pal-del")?.addEventListener("click", () => {
        if (confirm(`Видалити палітру «${p.name}» назавжди?`)) _palAction(p.id, "delete");
      });
      item.querySelector(".pal-edit")?.addEventListener("click", () => _palOpenEditDialog(p));
      host.appendChild(item);
    });
  }

  async function _palAction(id, action) {
    try {
      const r = await fetch(`/api/palettes/${id}/${action}`, { method: "POST" });
      if (!r.ok) throw new Error();
      if (action === "delete") { _palScope.delete(id); _palSaveScope(); _palClearRegions(id); }
      _palLoadList();
    } catch (_) {
      if (window.appToast) window.appToast("Помилка операції", "error", 1800);
    }
  }

  /* ---- Редагування кольорів палітри ---- */
  let _palEditState = null;  // { paletteId, original: Map<rid,color>, current: Map<rid,color> }

  /* Список усіх підрозділів-тегів з фільтра панелі (id + назва) */
  function _palUnitOptions() {
    const sel = document.getElementById("palUnitFilter");
    if (!sel) return [];
    return [...sel.options].filter(o => o.value).map(o => ({ id: o.value, name: o.textContent }));
  }

  async function _palOpenEditDialog(p) {
    const dlg  = document.getElementById("palEditDialog");
    const body = document.getElementById("palEditBody");
    const title = document.getElementById("palEditTitle");
    if (!dlg || !body) return;
    title.textContent = `Редагувати: ${p.name}`;
    body.innerHTML = '<div class="pal-empty">Завантаження…</div>';
    dlg.classList.remove("hidden");

    try {
      const r = await fetch(`/api/palettes/${p.id}/regions`);
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.detail || "Помилка");
      const regions = j.regions || [];
      const orig = new Map();
      const cur  = new Map();
      regions.forEach(r => { orig.set(r.id, r.color || "#000000"); cur.set(r.id, r.color || "#000000"); });
      const curUnitIds = new Set((p.units || []).map(u => Number(u.id)));
      _palEditState = {
        paletteId: p.id, original: orig, current: cur,
        origUnits: new Set(curUnitIds), curUnits: new Set(curUnitIds),
      };

      const unitChips = _palUnitOptions().map(o =>
        `<label class="pal-unit-chip" style="cursor:pointer"><input type="checkbox" value="${o.id}" ${curUnitIds.has(Number(o.id)) ? "checked" : ""} style="margin-right:4px">${_esc(o.name)}</label>`
      ).join("") || '<span class="pal-empty">—</span>';

      const colorList = regions.length
        ? `<div style="font-size:12px;color:#667085;margin:4px 0 4px">Кольори областей</div><div class="pal-edit-list">${
            regions.map(r => `
              <div class="pal-edit-row" data-rid="${r.id}">
                <input type="color" class="pal-edit-color" value="${_esc(r.color || "#000000")}" title="Обрати колір">
                <div class="pal-edit-label">
                  <div class="pal-edit-label-main">${_esc(r.label || "—")}</div>
                  <div class="pal-edit-label-meta">${r.point_count} тчк</div>
                </div>
              </div>`).join("")
          }</div>`
        : '<div class="pal-empty" style="margin-top:6px">У палітрі немає регіонів.</div>';

      body.innerHTML =
        `<label style="display:block;font-size:12px;color:#667085;margin-bottom:3px">Підрозділи (теги)</label>` +
        `<div id="palEditUnits" class="pal-item-units" style="margin-bottom:8px">${unitChips}</div>` +
        colorList;

      body.querySelectorAll("#palEditUnits input[type=checkbox]").forEach(cb => {
        cb.addEventListener("change", () => {
          const id = Number(cb.value);
          if (cb.checked) _palEditState.curUnits.add(id); else _palEditState.curUnits.delete(id);
        });
      });
      body.querySelectorAll(".pal-edit-color").forEach(inp => {
        inp.addEventListener("input", (e) => {
          const row = e.target.closest(".pal-edit-row");
          const rid = Number(row?.dataset.rid);
          if (rid) _palEditState.current.set(rid, e.target.value);
        });
      });
    } catch (e) {
      body.innerHTML = `<div class="pal-empty">Помилка: ${_esc(String(e.message || e))}</div>`;
    }
  }

  function _palCloseEditDialog() {
    document.getElementById("palEditDialog")?.classList.add("hidden");
    _palEditState = null;
  }

  async function _palSaveEdit() {
    if (!_palEditState) return _palCloseEditDialog();
    const { paletteId, original, current, origUnits, curUnits } = _palEditState;

    const changes = [];
    current.forEach((color, rid) => {
      if ((original.get(rid) || "").toLowerCase() !== (color || "").toLowerCase()) {
        changes.push({ region_id: rid, color });
      }
    });
    const unitsChanged = !origUnits || origUnits.size !== curUnits.size ||
      [...curUnits].some(id => !origUnits.has(id));

    if (!changes.length && !unitsChanged) { _palCloseEditDialog(); return; }

    try {
      if (changes.length) {
        const r = await fetch(`/api/palettes/${paletteId}/colors`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ colors: changes }),
        });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.detail || "Помилка кольорів");
      }
      if (unitsChanged) {
        const r = await fetch(`/api/palettes/${paletteId}/units`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unit_ids: [...curUnits] }),
        });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.detail || "Помилка тегів");
      }
      if (window.appToast) window.appToast("Палітру оновлено", "success", 1600);
      _palCloseEditDialog();
      if (changes.length) _palClearRegions(paletteId);
      _palLoadList();
    } catch (e) {
      if (window.appToast) window.appToast("Помилка збереження: " + (e.message || e), "error", 2400);
    }
  }

  document.getElementById("palEditCancel")?.addEventListener("click", _palCloseEditDialog);
  document.getElementById("palEditSave")?.addEventListener("click", _palSaveEdit);

  /* ---- Імпорт: analyze → діалог → commit ---- */
  let _palPendingFile = null;

  async function _palAnalyzeFile(file) {
    _palPendingFile = file;
    const fd = new FormData(); fd.append("file", file);
    if (window.appToast) window.appToast("Аналіз файлу…", "info", 1200);
    try {
      const r = await fetch("/api/palettes/import/analyze", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) { if (window.appToast) window.appToast(j.detail || "Помилка аналізу", "error", 2400); return; }
      _palShowImportDialog(j);
    } catch (_) {
      if (window.appToast) window.appToast("Помилка аналізу файлу", "error", 2400);
    }
  }

  function _palShowImportDialog(data) {
    const dlg = document.getElementById("palImportDialog");
    const body = document.getElementById("palImportBody");
    if (!dlg || !body) return;
    const s = data.summary || {};
    const regs = (s.regions || []).map(rg =>
      `<div class="pal-region-prev"><span class="pal-match-dot" style="background:${_esc(rg.color || "#888")}"></span>${_esc(rg.label || "—")} <span style="color:#888">(${rg.point_count})</span></div>`
    ).join("");

    let dupHtml = "";
    const dups = data.duplicates || [];
    if (dups.length) {
      const rows = dups.map(d => {
        const kind = d.kind === "exact" ? "точний дубль" : "схожа";
        const sup  = d.new_is_superset ? " · нова ⊇ старої (розширення)" : "";
        return `<label><input type="checkbox" class="pal-replace" value="${d.palette_id}"> Замінити «${_esc(d.name)}» <span style="color:#888">(${kind}, кольори ${Math.round((d.color_jaccard||0)*100)}%${sup})</span></label>`;
      }).join("");
      dupHtml = `<div class="pal-dup-warn"><b>Знайдено схожі палітри:</b>${rows}<div style="margin-top:6px;color:#888">Позначені будуть видалені при імпорті.</div></div>`;
    }

    body.innerHTML = `
      <div style="margin-bottom:8px"><b>${_esc(s.name || "Палітра")}</b> · ${s.point_count || 0} точок · ${s.region_count || 0} областей</div>
      <label style="display:block;font-size:12px;color:#667085;margin-bottom:3px">Назва палітри</label>
      <input id="palImportName" class="pal-select" value="${_esc(s.name || "")}" style="margin-bottom:8px">
      <label style="display:block;font-size:12px;color:#667085;margin-bottom:3px">Підрозділи (теги)</label>
      <div id="palImportUnits" class="pal-item-units" style="margin-bottom:8px"></div>
      <div style="font-size:12px;color:#667085;margin-bottom:4px">Області:</div>
      ${regs || '<div class="pal-empty">—</div>'}
      ${dupHtml}`;

    // Чипи-теги підрозділів (мультивибір)
    const unitsHost = body.querySelector("#palImportUnits");
    const sel = document.getElementById("palUnitFilter");
    if (sel && unitsHost) {
      [...sel.options].filter(o => o.value).forEach(o => {
        const chip = document.createElement("label");
        chip.className = "pal-unit-chip"; chip.style.cursor = "pointer";
        chip.innerHTML = `<input type="checkbox" value="${o.value}" style="margin-right:4px">${_esc(o.textContent)}`;
        unitsHost.appendChild(chip);
      });
    }

    document.getElementById("palImportConfirm").onclick = _palCommitImport;
    dlg.classList.remove("hidden");
  }

  function _palCloseDialog() {
    document.getElementById("palImportDialog")?.classList.add("hidden");
    _palPendingFile = null;
  }

  async function _palCommitImport() {
    if (!_palPendingFile) return;
    const body = document.getElementById("palImportBody");
    const fd = new FormData();
    fd.append("file", _palPendingFile);
    fd.append("name", body.querySelector("#palImportName")?.value || "");
    const units = [...body.querySelectorAll("#palImportUnits input:checked")].map(c => c.value);
    const replace = [...body.querySelectorAll(".pal-replace:checked")].map(c => c.value);
    fd.append("unit_ids", units.join(","));
    fd.append("replace_ids", replace.join(","));
    try {
      const r = await fetch("/api/palettes/import/commit", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) { if (window.appToast) window.appToast(j.detail || "Помилка імпорту", "error", 2400); return; }
      if (window.appToast) window.appToast("Палітру імпортовано", "success", 1600);
      _palCloseDialog();
      _palLoadList();
    } catch (_) {
      if (window.appToast) window.appToast("Помилка імпорту", "error", 2400);
    }
  }

  /* ---- Рендеринг областей на карті ---- */
  function _palClearRegions(id) {
    const layers = _palRegionLayers.get(id);
    if (layers) { layers.forEach(l => l.remove()); _palRegionLayers.delete(id); }
  }

  async function _palToggleRegions(id) {
    if (_palRegionLayers.has(id)) { _palClearRegions(id); return; }
    if (!_conclMap) return;
    try {
      const r = await fetch(`/api/palettes/${id}/regions`);
      const j = await r.json();
      const layers = [];
      (j.regions || []).forEach(reg => {
        const latlngs = _wktPolyToLatLngs(reg.hull_wkt);
        if (latlngs && latlngs.length >= 3) {
          const poly = L.polygon(latlngs, {
            color: reg.color || "#888", weight: 1.5, fillColor: reg.color || "#888",
            fillOpacity: 0.18, renderer: _conclBelowRenderer, interactive: false,
          }).addTo(_conclMap);
          layers.push(poly);
        }
        if (reg.center && reg.label) {
          const lbl = L.marker([reg.center[0], reg.center[1]], {
            icon: L.divIcon({ className: "pal-region-label-wrap", html: `<div class="pal-region-label">${_esc(reg.label)}</div>`, iconSize: [0, 0] }),
            interactive: false, pane: "conclBelow",
          }).addTo(_conclMap);
          layers.push(lbl);
        }
      });
      _palRegionLayers.set(id, layers);
      const bb = j.palette && j.palette.bbox;
      if (bb && bb[0] != null) _conclMap.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { maxZoom: 13, padding: [20, 20] });
    } catch (_) {
      if (window.appToast) window.appToast("Не вдалося завантажити області", "error", 1800);
    }
  }

  function _wktPolyToLatLngs(wkt) {
    // "POLYGON((lon lat, lon lat, ...))" → [[lat,lon],...]
    const m = /POLYGON\s*\(\(([^)]+)\)\)/i.exec(wkt || "");
    if (!m) return null;
    return m[1].split(",").map(pair => {
      const [lon, lat] = pair.trim().split(/\s+/).map(Number);
      return [lat, lon];
    });
  }

  /* ---- Пошук точки по коду / масці (з інпута над картою) ---- */
  /** Повне очищення — прибирає ВСІ активні пошукові чіпи та їхні маркери.
   *  Викликається з reset-операцій робочої області. */
  function _palClearMatchMarkers() {
    _palSearchChips.slice().forEach(entry => _palRemoveSearchChip(entry));
    // Підстраховка для legacy-додавальників, що пушили в _palMatchMarkers напряму.
    _palMatchMarkers.forEach(m => { try { m.remove(); } catch (_) {} });
    _palMatchMarkers = [];
  }

  /** Прибирає окремий чіп-пошук разом із усіма його маркерами з карти. */
  function _palRemoveSearchChip(entry) {
    if (!entry) return;
    entry.markers.forEach(m => { try { m.remove(); } catch (_) {} });
    entry.markers = [];
    if (entry.chipEl && entry.chipEl.parentNode) entry.chipEl.parentNode.removeChild(entry.chipEl);
    const idx = _palSearchChips.indexOf(entry);
    if (idx !== -1) _palSearchChips.splice(idx, 1);
  }

  /** Чіп для пошуку точки палітри (відрізняється стилем від MGRS-чипа). */
  function _palCreateSearchChip(code, onDelete) {
    const el = document.createElement("div");
    el.className = "concl-coord-chip concl-coord-chip--palette";
    el.title = `Точка палітри: ${code}`;
    el.innerHTML =
      `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".55">` +
        `<circle cx="8" cy="8" r="5.5"/>` +
        `<circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none"/>` +
      `</svg>` +
      `<span class="concl-coord-chip-text">${_esc(code)}</span>` +
      `<button class="concl-coord-chip-close" title="Сховати варіанти точки">×</button>`;
    el.querySelector(".concl-coord-chip-close").addEventListener("click", onDelete);
    return el;
  }

  function _palVariantIcon(color, hoverTitle) {
    const t = hoverTitle ? ` title="${_esc(hoverTitle)}"` : "";
    return L.divIcon({
      className: "",
      iconSize: [14, 14], iconAnchor: [7, 7],
      html: `<div class="pal-variant-dot"${t} style="background:${color || "#f59e0b"}"></div>`,
    });
  }

  /* Інтерактивний маркер-варіант: клік → попап «ВИБРАТИ ТОЧКУ» + координата.
     Hover-підказка — назва палітри (нативний browser title; з'являється поверх
     постійного підпису коду точки, який тримає Leaflet-tooltip).
     `chipEntry` — посилання на пошуковий чіп, до якого належить цей варіант
     (потрібне щоб при виборі точки автоматично "натиснути хрестик" чіпа). */
  function _palPlaceVariant(map, p, chipEntry) {
    const hoverTitle = p.palette_name
      ? (p.code ? `${p.code} · ${p.palette_name}` : p.palette_name)
      : "";
    const m = L.marker([p.lat, p.lon], {
      icon: _palVariantIcon(p.color, hoverTitle),
      bubblingMouseEvents: false,
    }).addTo(map);
    // Постійний підпис коду точки — над точкою
    m.bindTooltip(String(p.code || ""), {
      permanent: true, direction: "top", offset: [0, -8],
      className: "pal-variant-tip",
    });

    m.on("click", () => {
      const popup = L.popup({
        closeButton: false, className: "concl-map-popup",
        maxWidth: 260, offset: L.point(0, -10),
      }).setContent(_buildConclPopupHtml(p.lat, p.lon, false));
      m.unbindPopup().bindPopup(popup).openPopup();
      setTimeout(() => {
        const el = popup.getElement();
        if (!el) return;
        el.querySelector(".concl-cp-close")?.addEventListener("click", () => m.closePopup());
        el.querySelector(".concl-cp-select")?.addEventListener("click", () => {
          // Зафіксувати обрану точку. На чіпі — КООРДИНАТА (MGRS), бо
          // користувач уже знайшов потрібну з кількох варіантів і код
          // ("18", "Т-3") в чіпі більше не несе нової інформації.
          // Інші варіанти ТОГО Ж пошуку прибираються разом із своїм
          // search-чіпом; інші пошуки (інші коди) лишаються на карті.
          _addFixedMarker(map, p.lat, p.lon);
          if (chipEntry) _palRemoveSearchChip(chipEntry);
          else _palClearMatchMarkers();  // legacy fallback
          const ci = document.getElementById("conclCoordInput");
          if (ci) ci.value = "";
        });
        el.querySelector(".concl-cp-fmt")?.addEventListener("click", (e) => {
          e.stopPropagation();
          _conclCoordFmt = _conclCoordFmt === "MGRS" ? "УСК" : "MGRS";
          const cEl = el.querySelector(".concl-cp-coord");
          const fEl = el.querySelector(".concl-cp-fmt");
          if (cEl) cEl.textContent = _getConclCoord(p.lat, p.lon);
          if (fEl) fEl.textContent = _conclCoordFmt;
        });
        el.querySelector(".concl-cp-coord")?.addEventListener("click", (e) => {
          e.preventDefault();
          const c = _getConclCoord(p.lat, p.lon);
          if (window.clipboardWrite) window.clipboardWrite(c).then(ok => {
            if (ok && window.appToast) window.appToast("Скопійовано", "success", 1400);
          });
        });
      }, 0);
    });

    if (chipEntry) chipEntry.markers.push(m);
    else           _palMatchMarkers.push(m);   // legacy fallback
    return m;
  }

  /* Повторно знайти точки для всіх кодів, що вже стоять чіпами, під поточну
   * область пошуку (_palScope). Викликається при перемиканні галочок палітр.
   * Самі чіпи лишаються (навіть якщо під новим scope точок нема) — щоб зворотне
   * перемикання галочки знову показало маркери. */
  async function _palRefreshSearchChips() {
    if (!_conclMap || !_palSearchChips.length) return;
    const myToken = ++_palRefreshToken;
    const inclArch = document.getElementById("palIncludeArchived")?.checked ? 1 : 0;
    const unitId   = document.getElementById("palUnitFilter")?.value || "";
    const allMarkers = [];
    for (const entry of _palSearchChips) {
      // прибрати старі маркери цього чіпа (сам чіп лишаємо)
      entry.markers.forEach(m => { try { m.remove(); } catch (_) {} });
      entry.markers = [];
      const qs = new URLSearchParams({ q: entry.code, include_archived: String(inclArch) });
      if (unitId) qs.set("unit_id", unitId);
      let results = [];
      try {
        const r = await fetch("/api/palettes/search?" + qs.toString());
        const j = await r.json();
        results = j.results || [];
      } catch (_) { continue; }
      if (myToken !== _palRefreshToken) return;   // запустили новіший перепошук
      const pts = [];
      results.forEach(g => {
        if (_palScope.size && !_palScope.has(g.palette_id)) return;
        g.points.forEach(pt => { if (pt.lat != null && pt.lon != null) pts.push({ ...pt, palette_name: g.palette_name }); });
      });
      pts.forEach(p => { const m = _palPlaceVariant(_conclMap, p, entry); if (m) allMarkers.push(m); });
    }
    if (myToken !== _palRefreshToken) return;
    if (allMarkers.length) {
      try { _conclMap.fitBounds(L.featureGroup(allMarkers).getBounds(), { maxZoom: 15, padding: [40, 40] }); } catch (_) {}
    }
  }

  async function _paletteLookupAndPlace(query) {
    if (!_conclMap || !query) return;
    const code = String(query).trim();
    if (!code) return;

    // Якщо для цього коду вже є чіп — оновлюємо його (видаляємо старе й
    // ствостворюємо). Інші чіпи (інших кодів) лишаються на карті.
    const existing = _palSearchChips.find(c => c.code === code);
    if (existing) _palRemoveSearchChip(existing);

    const inclArch = document.getElementById("palIncludeArchived")?.checked ? 1 : 0;
    const unitId   = document.getElementById("palUnitFilter")?.value || "";
    const qs = new URLSearchParams({ q: code, include_archived: String(inclArch) });
    if (unitId) qs.set("unit_id", unitId);

    let results;
    try {
      const r = await fetch("/api/palettes/search?" + qs.toString());
      const j = await r.json();
      results = j.results || [];
    } catch (_) {
      if (window.appToast) window.appToast("Помилка пошуку палітри", "error", 1800);
      return;
    }

    // Фільтр по scope (якщо обрано хоч одну палітру).
    let pts = [];
    results.forEach(g => {
      if (_palScope.size && !_palScope.has(g.palette_id)) return;
      g.points.forEach(pt => pts.push({ ...pt, palette_name: g.palette_name }));
    });
    pts = pts.filter(p => p.lat != null && p.lon != null);

    if (!pts.length) {
      if (window.appToast) window.appToast(`«${code}»: не знайдено жодної точки`, "info", 1900);
      return;
    }

    // Створити чіп ДО рендеру маркерів — щоб варіанти одразу прив'язались до нього.
    const entry = { code, markers: [], chipEl: null };
    entry.chipEl = _palCreateSearchChip(code, () => _palRemoveSearchChip(entry));
    const chipsContainer = document.getElementById("conclCoordChips");
    if (chipsContainer) chipsContainer.appendChild(entry.chipEl);
    _palSearchChips.push(entry);

    // Показати всі варіанти як підписані інтерактивні маркери (НЕ фіксуємо автоматично).
    const grp = L.featureGroup();
    pts.forEach(p => grp.addLayer(_palPlaceVariant(_conclMap, p, entry)));
    try {
      if (pts.length === 1) _conclMap.setView([pts[0].lat, pts[0].lon], Math.max(_conclMap.getZoom(), 14));
      else _conclMap.fitBounds(grp.getBounds(), { maxZoom: 15, padding: [40, 40] });
    } catch (_) {}

    if (window.appToast) window.appToast(`«${code}»: знайдено точок — ${pts.length}`, "success", 1800);

    // Очищуємо інпут — пошук тепер "зафіксовано" чіпом.
    const ci = document.getElementById("conclCoordInput");
    if (ci) ci.value = "";
  }

})();
