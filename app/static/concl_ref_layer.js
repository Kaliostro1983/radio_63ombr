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
          mk.on("click", function (e) { L.DomEvent.stopPropagation(e); openDetailPanel(row, ms); });
          mk.addTo(_layer);
          S.markers.push({ marker: mk, typeId: row.type_id, row: row, mgrs: ms });
        });
      });
      renderChips();
      applyFilter();
    });
  }

  // ── Бічна панель деталей (порт із /conclusions/map) ──
  var _panelRow = null;
  function toast(m) { if (window.appToast) window.appToast(m, "info", 1800); }
  function iconUrlPlain(fn) { return fn ? "/static/icons/" + fn : "/static/icons/default.svg"; }

  function setBadge(typeInfo) {
    var badge = $("rpTypeBadge"); if (!badge) return;
    badge.style.background = (typeInfo.color || "#6b7280") + "33";
    badge.style.border = "1px solid " + (typeInfo.color || "#6b7280") + "88";
    var img = badge.querySelector(".rp-badge-icon");
    if (img) {
      if (typeInfo.icon_sidc) { var i = getSidcIcon(typeInfo.icon_sidc); img.src = i ? i.url : iconUrlPlain(typeInfo.icon_filename); }
      else img.src = iconUrlPlain(typeInfo.icon_filename);
    }
    var lab = badge.querySelector(".rp-badge-label"); if (lab) lab.textContent = typeInfo.type || "невідомо";
  }

  function openDetailPanel(row, clickedMgrs) {
    var panel = $("rightPanel"); if (!panel) return;
    panel.classList.add("open");
    var ti = S.types.find(function (t) { return t.id === row.type_id; }) ||
      { type: "невідомо", color: "#6b7280", icon_filename: "", icon_sidc: "" };
    setBadge(ti);

    var dt = String(row.created_at || "").replace("T", " ").slice(0, 16);
    var net = [row.frequency, row.mask, row.unit].filter(Boolean).join(" / ");
    if ($("rpMetaDate")) $("rpMetaDate").textContent = dt;
    if ($("rpMetaNet")) $("rpMetaNet").textContent = net || "—";
    if ($("rpConclusionText")) $("rpConclusionText").textContent = String(row.conclusion_text || "").trim();

    var bodySec = $("rpBodySection"), body = String(row.body_text || "").trim();
    if (bodySec) { bodySec.style.display = body ? "" : "none"; if (body && $("rpBodyText")) $("rpBodyText").textContent = body; }

    var cd = $("rpCoords");
    if (cd) {
      cd.innerHTML = "";
      (row.mgrs || []).forEach(function (m) {
        var tag = document.createElement("span");
        tag.className = "rp-coord-tag" + (m === clickedMgrs ? " active" : "");
        tag.textContent = m; tag.title = "Натисніть, щоб скопіювати";
        tag.addEventListener("click", function () {
          try { navigator.clipboard.writeText(m); } catch (_) {}
          toast("✓ Скопійовано: " + m);
        });
        cd.appendChild(tag);
      });
    }

    _panelRow = row;
    var sel = $("rpTypeSelect");
    if (sel) {
      var items = [{ id: 0, type: "невідомо" }].concat(S.types.filter(function (t) { return t.id !== 0; }));
      sel.innerHTML = items.map(function (t) {
        return '<option value="' + t.id + '"' + (t.id === (row.type_id || 0) ? " selected" : "") + ">" + esc(t.type || "невідомо") + "</option>";
      }).join("");
      sel.onchange = function () { changeConclusionType(row.id, parseInt(sel.value, 10) || 0); };
    }
    if ($("rpDeleteBtn")) $("rpDeleteBtn").onclick = function () { deleteConclusion(row.id); };
    if ($("rpEditBtn")) $("rpEditBtn").onclick = function () { startEditPanel(); };
    if ($("rpDeltaBtn")) $("rpDeltaBtn").onclick = function () { quickSendDelta(row.id); };
    if ($("rpEditSaveBtn")) $("rpEditSaveBtn").onclick = function () { saveEditPanel(); };
    if ($("rpEditCancelBtn")) $("rpEditCancelBtn").onclick = function () { setEditMode(false); };
    setEditMode(false);
    if ($("rightHandle")) $("rightHandle").style.display = "none";
  }

  function setEditMode(on) {
    var sh = function (id, v) { var el = $(id); if (el) el.style.display = v; };
    sh("rpConclusionText", on ? "none" : "");
    sh("rpEditText", on ? "" : "none");
    sh("rpEditCoordsWrap", on ? "" : "none");
    var cd = $("rpCoords");
    if (cd && cd.parentElement) cd.parentElement.style.display = on ? "none" : "";
    if ($("rpEditBtn")) $("rpEditBtn").style.display = on ? "none" : "";
  }
  function startEditPanel() {
    if (!_panelRow) return;
    if ($("rpEditText")) $("rpEditText").value = String(_panelRow.conclusion_text || "").trim();
    if ($("rpEditCoords")) $("rpEditCoords").value = (_panelRow.mgrs || []).join(", ");
    setEditMode(true);
    if ($("rpEditText")) $("rpEditText").focus();
  }
  function saveEditPanel() {
    if (!_panelRow) return;
    var text = ($("rpEditText").value || "").trim();
    if (!text) { toast("Висновок не може бути порожнім"); return; }
    var raw = ($("rpEditCoords").value || "").trim();
    var mgrsIn = raw ? raw.split(",").map(function (s) { return s.trim(); }).filter(Boolean) : [];
    var btn = $("rpEditSaveBtn");
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    fetch("/api/conclusions/" + _panelRow.id, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conclusion_text: text, mgrs: mgrsIn }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) { toast(res.d.error || res.d.detail || "Помилка збереження"); return; }
        var old = (_panelRow.mgrs || []).join("|");
        _panelRow.conclusion_text = res.d.conclusion_text != null ? res.d.conclusion_text : text;
        if (Array.isArray(res.d.mgrs)) _panelRow.mgrs = res.d.mgrs;
        if ($("rpConclusionText")) $("rpConclusionText").textContent = String(_panelRow.conclusion_text || "").trim();
        setEditMode(false);
        if ((_panelRow.mgrs || []).join("|") !== old) {
          placeMarkers().then(function () { applyFilter(); openDetailPanel(_panelRow, (_panelRow.mgrs || [])[0] || ""); });
        }
        toast("Висновок збережено");
      }).catch(function (e) { toast("Помилка: " + (e && e.message || e)); })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = "Зберегти"; } });
  }
  function refreshBadge(row) {
    var ti = S.types.find(function (t) { return t.id === row.type_id; }) ||
      { type: "невідомо", color: "#6b7280", icon_filename: "", icon_sidc: "" };
    setBadge(ti);
  }
  function changeConclusionType(acId, typeId) {
    fetch("/api/conclusions/" + acId + "/type", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type_id: typeId }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) { toast(res.d.error || "Помилка зміни типу"); return; }
        var nt = res.d.type_id;
        var typeMap = {}; S.types.forEach(function (t) { typeMap[t.id] = t; });
        resolveTypeIcon(typeMap[nt] || null).then(function (icd) {
          S.markers.forEach(function (m) {
            if (m.row.id !== acId) return;
            m.row.type_id = nt; m.typeId = nt;
            var icon = makeIcon(icd.url, icd.w, icd.h);
            if (S.showUnit) { var n = extractUnitNumber(m.row.unit); if (n) icon = makeUnitIcon(n); }
            m.marker.setIcon(icon);
          });
          if (_panelRow && _panelRow.id === acId) { _panelRow.type_id = nt; refreshBadge(_panelRow); }
          renderChips();
          toast("Тип оновлено: " + (res.d.type_label || "невідомо"));
        });
      }).catch(function (e) { toast("Помилка: " + (e && e.message || e)); });
  }
  function deleteConclusion(acId) {
    if (!confirm("Видалити цей аналітичний висновок?")) return;
    fetch("/api/conclusions/" + acId, { method: "DELETE" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || (res.d && res.d.ok === false)) { toast((res.d && res.d.error) || "Помилка видалення"); return; }
        for (var i = S.markers.length - 1; i >= 0; i--) {
          if (S.markers[i].row.id === acId) { try { S.markers[i].marker.remove(); } catch (_) {} S.markers.splice(i, 1); }
        }
        closeRightPanel(); renderChips();
        toast("Висновок видалено");
      }).catch(function (e) { toast("Помилка: " + (e && e.message || e)); });
  }
  function quickSendDelta(acId) {
    var btn = $("rpDeltaBtn");
    if (btn) { btn.disabled = true; btn.style.opacity = ".5"; }
    var done = function () { if (btn) { btn.disabled = false; btn.style.opacity = ""; } };
    fetch("/api/conclusions/" + acId + "/delta-text")
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) { toast(res.d.error || res.d.detail || "Не вдалося сформувати звіт"); done(); return; }
        var t = res.d;
        if (!confirm("Надіслати звіт у Delta?\nЧат: " + (t.chat_name || t.chat_id))) { done(); return; }
        fetch("/api/push/send", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: t.platform, chat_id: t.chat_id, text: t.text }),
        }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (sr) {
            if (!sr.ok || !sr.d.ok) { toast(sr.d.error || sr.d.detail || "Помилка надсилання"); done(); return; }
            fetch("/api/conclusions/" + acId + "/mark-sended", { method: "POST" }).catch(function () {});
            if (_panelRow && _panelRow.id === acId) _panelRow.sended = 1;
            toast("✓ Надіслано в Delta"); done();
          }).catch(function (e) { toast("Помилка: " + (e && e.message || e)); done(); });
      }).catch(function (e) { toast("Помилка: " + (e && e.message || e)); done(); });
  }
  function closeRightPanel() {
    var p = $("rightPanel"); if (p) p.classList.remove("open");
    if ($("rightHandle")) $("rightHandle").style.display = "";
  }
  function initDetailPanel() {
    if ($("rpCloseBtn")) $("rpCloseBtn").addEventListener("click", closeRightPanel);
    if ($("rightHandle")) $("rightHandle").addEventListener("click", function () {
      var p = $("rightPanel"); if (p && _panelRow) { p.classList.add("open"); $("rightHandle").style.display = "none"; }
    });
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
    initDetailPanel();
    if (_pendingMode) { var m = _pendingMode; _pendingMode = null; setVisible(m === "map"); }
  }

  if (window.__conclMap) boot(window.__conclMap);
  window.addEventListener("conclMapReady", function (e) { boot(e.detail); });
})();
