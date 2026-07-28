/* ============================================================================
 * Шар-референс висновків у модалці «Аналітичний висновок».
 * Переносить відображення з /conclusions/map: усі висновки за діапазоном як
 * маркери за категоріями + чіпи «категорії» + контроли (Частоти/Підрозділ +
 * діапазон). Клік по маркеру — попап із текстом висновку. Правки/видалення тут
 * НЕМАЄ (це референс поверх редагованої карти модалки).
 *
 * Ізольований від monitor.js: карту бере через window.__conclMap.
 * ==========================================================================*/
(function () {
  "use strict";

  var _map = null;
  var S = {
    types: [], rows: [], markers: [],
    hidden: new Set(), allHidden: false,
    showFreq: false, showUnit: false,
    from: "", to: "", loaded: false, loading: false,
  };
  var _layer = null;            // L.layerGroup з усіма маркерами референсу
  var _iconCache = {};          // key filename::color → blobUrl

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function mgrsToLatLng(m) {
    try {
      if (window.mgrs && window.mgrs.toPoint) {
        var p = window.mgrs.toPoint(String(m).replace(/\s+/g, "").toUpperCase());
        if (Array.isArray(p) && p.length >= 2) {
          var lat = Number(p[1]), lon = Number(p[0]);
          if (isFinite(lat) && isFinite(lon)) return [lat, lon];
        }
      }
    } catch (_) {}
    return null;
  }

  // ── Підрозділ: номер бригади/полка → колір/іконка ──
  function extractUnitNumber(t) {
    var s = String(t || ""); if (!s) return null;
    var MK = "(?:омсбр|мсбр|обр|омбр|обмбр|обмп|мсп|мп|тп|тбр|мбр|мсд|тд|обз|орб|оемб|оп|полк|бригад)";
    var m = s.match(new RegExp("(\\d{1,3})\\s*" + MK, "i"));
    if (m) return m[1];
    var f = s.match(/\b(\d{1,3})\b/);
    return f ? f[1] : null;
  }
  function colorForUnit(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return "#6b7280";
    return "hsl(" + ((v * 137.508) % 360).toFixed(1) + ", 70%, 45%)";
  }
  function makeUnitIcon(u) {
    return L.divIcon({
      className: "cm-unit-icon",
      html: '<div class="cm-unit-circle" style="background:' + colorForUnit(u) + '">' + esc(u || "?") + "</div>",
      iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -17],
    });
  }

  // ── Іконка типу: кольоровий SVG-файл (без залежності від milsymbol) ──
  function getIconUrl(filename, color) {
    var key = (filename || "default.svg") + "::" + (color || "#6b7280");
    if (_iconCache[key]) return Promise.resolve(_iconCache[key]);
    var url = "/static/icons/" + (filename || "default.svg");
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error();
      return r.text();
    }).then(function (svg) {
      svg = svg.replace(/FILL/g, color || "#6b7280");
      var u = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      _iconCache[key] = u; return u;
    }).catch(function () { _iconCache[key] = url; return url; });
  }
  function makeIcon(url, w, h) {
    var sw = w || 24, sh = h || 24;
    return L.divIcon({
      className: "cm-icon",
      html: '<img src="' + url + '" alt="" width="' + sw + '" height="' + sh + '">',
      iconSize: [sw, sh], iconAnchor: [Math.round(sw / 2), Math.round(sh / 2)],
      popupAnchor: [0, -Math.round(sh / 2)],
    });
  }

  // ── milsymbol (APP-6 / MIL-STD-2525) для типів з icon_sidc ──
  var _sidcCache = {};
  var SIDC_SCALE = 0.75;
  function getSidcIcon(sidc) {
    if (!sidc || !window.ms) return null;
    if (_sidcCache[sidc]) return _sidcCache[sidc];
    try {
      var sym = new ms.Symbol(sidc, { size: 32 });
      var sz = sym.getSize();
      var u = URL.createObjectURL(new Blob([sym.asSVG()], { type: "image/svg+xml" }));
      var r = { url: u, w: Math.max(8, Math.round(sz.width * SIDC_SCALE)), h: Math.max(8, Math.round(sz.height * SIDC_SCALE)) };
      _sidcCache[sidc] = r; return r;
    } catch (_) { return null; }
  }
  // Іконка типу: SIDC (milsymbol) → SVG-файл (кольоровий) → дефолт.
  function resolveTypeIcon(t) {
    if (t && t.icon_sidc) {
      var info = getSidcIcon(t.icon_sidc);
      if (info) return Promise.resolve(info);
    }
    return getIconUrl(t && t.icon_filename, (t && t.color) || "#6b7280")
      .then(function (u) { return { url: u, w: 24, h: 24 }; });
  }

  // ── Дані ──
  function loadTypes() {
    return fetch("/api/conclusions/types").then(function (r) { return r.json(); })
      .then(function (d) { S.types = (d && d.rows) || []; });
  }
  function loadConclusions() {
    var qs = new URLSearchParams();
    if (S.from) qs.set("date_from", S.from);
    if (S.to) qs.set("date_to", S.to);
    return fetch("/api/conclusions?" + qs.toString()).then(function (r) { return r.json(); })
      .then(function (d) {
        S.rows = ((d && d.rows) || []).filter(function (r) { return r.mgrs && r.mgrs.length; });
      });
  }

  // ── Рендер маркерів ──
  function placeMarkers() {
    if (_layer) { try { _map.removeLayer(_layer); } catch (_) {} }
    _layer = L.layerGroup().addTo(_map);
    S.markers = [];
    var typeMap = {}; S.types.forEach(function (t) { typeMap[t.id] = t; });

    // Прередер іконок за типами (SIDC → SVG-файл → дефолт)
    var uniq = {};
    S.rows.forEach(function (r) { uniq[r.type_id] = typeMap[r.type_id] || null; });
    var jobs = Object.keys(uniq).map(function (tid) {
      return resolveTypeIcon(uniq[tid]).then(function (info) { uniq[tid] = info; });
    });

    return Promise.all(jobs).then(function () {
      S.rows.forEach(function (row) {
        var idata = uniq[row.type_id] || { url: "/static/icons/default.svg", w: 24, h: 24 };
        var icon;
        if (S.showUnit) {
          var un = extractUnitNumber(row.unit);
          icon = un ? makeUnitIcon(un) : makeIcon(idata.url, idata.w, idata.h);
        } else {
          icon = makeIcon(idata.url, idata.w, idata.h);
        }
        row.mgrs.forEach(function (ms) {
          var ll = mgrsToLatLng(ms);
          if (!ll) return;
          var mk = L.marker(ll, { icon: icon });
          if (S.showFreq && row.frequency) {
            mk.bindTooltip(String(row.frequency), { permanent: true, direction: "right", offset: [12, 0], className: "cm-freq-label" });
          }
          mk.on("click", function (e) { L.DomEvent.stopPropagation(e); openPopup(row, mk); });
          mk.addTo(_layer);
          S.markers.push({ marker: mk, typeId: row.type_id });
        });
      });
      renderChips();
      applyFilter();
    });
  }

  function openPopup(row, mk) {
    var t = S.types.find(function (x) { return x.id === row.type_id; });
    var meta = [row.created_at || "", row.frequency || "", (t && t.type) || ""]
      .filter(Boolean).map(esc).join(" · ");
    var html = '<div class="cwref-pop"><div class="cwref-meta">' + meta + "</div>" +
      esc(row.conclusion_text || row.body_text || "") + "</div>";
    mk.bindPopup(html, { maxWidth: 340 }).openPopup();
  }

  // ── Чіпи категорій ──
  function renderChips() {
    var box = $("cwCatBar"); if (!box) return;
    box.innerHTML = "";
    var cnt = {}; S.markers.forEach(function (m) { cnt[m.typeId] = (cnt[m.typeId] || 0) + 1; });
    var present = S.types.filter(function (t) { return cnt[t.id] > 0; });
    if (!present.length) return;

    var all = document.createElement("button");
    all.className = "type-chip-all";
    all.addEventListener("click", function () {
      S.allHidden = !S.allHidden;
      if (!S.allHidden) S.hidden.clear();
      updateChips(); applyFilter();
    });
    box.appendChild(all);
    var div = document.createElement("span"); div.className = "chip-divider"; box.appendChild(div);

    present.forEach(function (t) {
      var chip = document.createElement("div");
      chip.className = "type-chip"; chip.dataset.typeId = t.id;
      chip.style.setProperty("--chip-color", t.color || "#6b7280");
      var img = document.createElement("img");
      var sidc = t.icon_sidc ? getSidcIcon(t.icon_sidc) : null;
      if (sidc) { img.src = sidc.url; }
      else { getIconUrl(t.icon_filename, t.color || "#6b7280").then(function (u) { img.src = u; }); }
      chip.appendChild(img);
      var lab = document.createElement("span");
      lab.textContent = t.type + " (" + cnt[t.id] + ")";
      chip.appendChild(lab);
      chip.addEventListener("click", function () { toggleChip(t.id); });
      box.appendChild(chip);
    });
    updateChips();
  }
  function toggleChip(id) {
    if (S.allHidden) {
      S.allHidden = false;
      var present = new Set(S.markers.map(function (m) { return m.typeId; }));
      S.hidden = new Set([].concat.apply([], [Array.from(present)]).filter(function (x) { return x !== id; }));
    } else if (S.hidden.has(id)) { S.hidden.delete(id); } else { S.hidden.add(id); }
    updateChips(); applyFilter();
  }
  function updateChips() {
    document.querySelectorAll("#cwCatBar .type-chip").forEach(function (c) {
      var id = parseInt(c.dataset.typeId, 10);
      c.classList.toggle("active", !S.allHidden && !S.hidden.has(id));
    });
    var all = document.querySelector("#cwCatBar .type-chip-all");
    if (all) all.textContent = S.allHidden ? "Показати всі" : "Сховати всі";
  }
  function applyFilter() {
    S.markers.forEach(function (m) {
      var show = !S.allHidden && !S.hidden.has(m.typeId);
      if (show) { if (!_layer.hasLayer(m.marker)) m.marker.addTo(_layer); }
      else { if (_layer.hasLayer(m.marker)) _layer.removeLayer(m.marker); }
    });
  }

  // ── Завантаження/перезавантаження ──
  function reload() {
    if (S.loading) return Promise.resolve();
    S.loading = true;
    var p = S.types.length ? Promise.resolve() : loadTypes();
    return p.then(loadConclusions).then(placeMarkers)
      .then(function () { S.loaded = true; S.loading = false; })
      .catch(function () { S.loading = false; });
  }

  // ── Контроли ──
  function defaultRange() {
    // Останні 5 днів (без «сьогодні» — до кінця вчора), формат datetime-local.
    function fmt(d) {
      var p = function (n) { return (n < 10 ? "0" : "") + n; };
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
    }
    var to = new Date(); to.setHours(23, 59, 0, 0);
    var from = new Date(); from.setDate(from.getDate() - 4); from.setHours(0, 0, 0, 0);
    return { from: fmt(from), to: fmt(to) };
  }
  function initControls() {
    var dr = defaultRange();
    var fEl = $("cwRefFrom"), tEl = $("cwRefTo");
    if (fEl && !fEl.value) fEl.value = dr.from;
    if (tEl && !tEl.value) tEl.value = dr.to;
    S.from = fEl ? fEl.value : dr.from;
    S.to = tEl ? tEl.value : dr.to;

    var freq = $("cwRefFreqChk"), unit = $("cwRefUnitChk");
    if (freq) freq.addEventListener("change", function () { S.showFreq = freq.checked; placeMarkers(); });
    if (unit) unit.addEventListener("change", function () { S.showUnit = unit.checked; placeMarkers(); });

    var btn = $("cwRefRefresh");
    if (btn) btn.addEventListener("click", function () {
      S.from = fEl ? fEl.value : S.from;
      S.to = tEl ? tEl.value : S.to;
      S.loaded = false; reload();
    });

    // «Показати/сховати позначення» (кнопка №4) — показує/ховає ВЕСЬ шар:
    // маркери + категорії + контроли.
    var marks = $("cwToggleMarksBtn");
    if (marks) marks.addEventListener("click", function () {
      setVisible(!_visible);
    });
  }

  // ── Показ/приховання всього шару-референсу ──
  var _visible = false;
  var _pendingMode = null;   // режим, заданий до готовності карти
  function setVisible(on) {
    _visible = !!on;
    // Клас/кнопку — одразу (без миготіння порожніх контейнерів).
    var modal = $("itModalConclusion");
    if (modal) modal.classList.toggle("cw-marks-hidden", !on);
    var btn = $("cwToggleMarksBtn");
    if (btn) btn.classList.toggle("is-active", !!on);
    // Роботу з шаром — лише коли карта готова.
    if (!_map) { _pendingMode = on ? "map" : "conclusion"; return; }
    if (on) {
      if (S.loaded && _layer) { if (!_map.hasLayer(_layer)) _layer.addTo(_map); }
      else reload();
    } else {
      if (_layer && _map.hasLayer(_layer)) _map.removeLayer(_layer);
    }
  }

  // ── Режим за точкою входу: яка група активна на старті ──
  //   conclusion (кнопка №3) — контейнер висновку; map (кнопка №4) — позначення;
  //   peleng (кнопка №5) — далі. Керує стартовою видимістю обох груп.
  window.setConclModalMode = function (mode) {
    var modal = $("itModalConclusion"); if (!modal) return;
    modal.dataset.conclMode = mode || "conclusion";
    var showLeft = (mode !== "map" && mode !== "peleng");
    modal.classList.toggle("cw-left-hidden", !showLeft);
    var lb = $("cwToggleLeftBtn"); if (lb) lb.classList.toggle("is-active", showLeft);
    setVisible(mode === "map");
  };

  // ── Старт: чекаємо карту модалки ──
  function boot(map) {
    if (_map) return;
    _map = map;
    initControls();
    if (_pendingMode) { var m = _pendingMode; _pendingMode = null; setVisible(m === "map"); }
  }

  if (window.__conclMap) boot(window.__conclMap);
  window.addEventListener("conclMapReady", function (e) { boot(e.detail); });
})();
