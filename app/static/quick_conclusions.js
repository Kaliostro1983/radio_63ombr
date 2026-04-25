/**
 * quick_conclusions.js — «Швидко» tab on the /conclusions page.
 *
 * Depends on: Leaflet (already on page), mgrs.min.js (already on page).
 * html2canvas is loaded lazily on first screenshot attempt.
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }
  function toast(msg, type, ms) {
    if (window.appToast) window.appToast(msg, type || "info", ms || 2000);
  }

  /* ── State ── */
  let activeConclusion = null;   // { id, name, text }
  let activePoints     = [];     // ordered array of { id, name, point } — multi-select
  let qcMap            = null;
  let qcMarkers        = [];     // array of L.Marker, one per activePoints entry
  let mapReady         = false;

  /* ── DOM refs ── */
  const conclBtnsWrap = $("qcConclBtns");
  const pointBtnsWrap = $("qcPointBtns");
  const textarea      = $("qcTextarea");
  const mapDiv        = $("qcMapDiv");
  const quickPanel    = $("cnPaneQuick");

  /* ── Zoom helpers ── */
  const ZOOM_KEY     = "qcMapZoom";
  const ZOOM_DEFAULT = 12;

  function getZoom() {
    const inp = $("qcMapZoom");
    const v = inp ? parseInt(inp.value, 10) : NaN;
    return (isFinite(v) && v >= 1 && v <= 18) ? v : ZOOM_DEFAULT;
  }

  function initZoomInput() {
    const inp = $("qcMapZoom");
    if (!inp) return;
    const saved = parseInt(localStorage.getItem(ZOOM_KEY), 10);
    if (isFinite(saved) && saved >= 1 && saved <= 18) inp.value = String(saved);
    inp.addEventListener("change", function () {
      const v = parseInt(inp.value, 10);
      if (isFinite(v) && v >= 1 && v <= 18) {
        localStorage.setItem(ZOOM_KEY, String(v));
      }
    });
  }

  /* ─────────────────────────────────────────────
   *  CONCLUSION BUTTONS — single select
   * ───────────────────────────────────────────── */
  function renderConclButtons(items) {
    if (!conclBtnsWrap) return;
    conclBtnsWrap.innerHTML = "";
    if (!items.length) {
      conclBtnsWrap.innerHTML = '<span class="small" style="opacity:.5">Немає даних</span>';
      return;
    }
    items.forEach(function (item) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "qc-toggle-btn";
      btn.textContent = item.name;
      btn.addEventListener("click", function () {
        conclBtnsWrap.querySelectorAll(".qc-toggle-btn").forEach(function (b) {
          b.classList.remove("active");
        });
        btn.classList.add("active");
        activeConclusion = item;
      });
      conclBtnsWrap.appendChild(btn);
    });
  }

  /* ─────────────────────────────────────────────
   *  POINT BUTTONS — multi-select with order numbers
   * ───────────────────────────────────────────── */
  function renderPointButtons(items) {
    if (!pointBtnsWrap) return;
    pointBtnsWrap.innerHTML = "";
    if (!items.length) {
      pointBtnsWrap.innerHTML = '<span class="small" style="opacity:.5">Немає даних</span>';
      return;
    }
    items.forEach(function (item) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "qc-toggle-btn";
      btn.dataset.id = String(item.id);
      btn.dataset.name = item.name;
      btn.textContent = item.name;
      btn.addEventListener("click", function () {
        const idx = activePoints.findIndex(function (p) { return p.id === item.id; });
        if (idx === -1) {
          // Add to selection
          activePoints.push(item);
        } else {
          // Remove from selection
          activePoints.splice(idx, 1);
        }
        refreshPointButtonLabels();
      });
      pointBtnsWrap.appendChild(btn);
    });
  }

  /** Re-draw order numbers on all point buttons after selection change */
  function refreshPointButtonLabels() {
    if (!pointBtnsWrap) return;
    pointBtnsWrap.querySelectorAll(".qc-toggle-btn[data-id]").forEach(function (btn) {
      const id = parseInt(btn.dataset.id, 10);
      const idx = activePoints.findIndex(function (p) { return p.id === id; });
      if (idx === -1) {
        btn.classList.remove("active");
        btn.textContent = btn.dataset.name;
      } else {
        btn.classList.add("active");
        btn.textContent = btn.dataset.name + " (" + (idx + 1) + ")";
      }
    });
  }

  /* ─────────────────────────────────────────────
   *  MAP (Leaflet + Esri World Imagery)
   * ───────────────────────────────────────────── */
  function initMap() {
    if (mapReady || !mapDiv || !window.L) return;
    mapReady = true;

    qcMap = window.L.map(mapDiv, {
      center: [48.65, 38.15],
      zoom: 12,
      zoomControl: true,
      attributionControl: false,
    });

    window.L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 18, crossOrigin: "anonymous" }
    ).addTo(qcMap);

    window.L.control.attribution({ prefix: false })
      .addAttribution("Tiles &copy; Esri")
      .addTo(qcMap);
  }

  /** Convert MGRS string (with or without spaces) → { lat, lon } or null */
  function mgrsToLatLon(s) {
    if (!window.mgrs || !window.mgrs.toPoint) return null;
    try {
      const p = window.mgrs.toPoint(String(s).replace(/\s+/g, "").toUpperCase());
      if (!Array.isArray(p) || p.length < 2) return null;
      const lon = Number(p[0]), lat = Number(p[1]);
      return (isFinite(lat) && isFinite(lon)) ? { lat, lon } : null;
    } catch (_) { return null; }
  }

  /** Numbered divIcon — red circle with white order number */
  function makeNumberedIcon(num) {
    return window.L.divIcon({
      className: "",
      html: '<div class="qc-map-marker"><span class="qc-map-marker__num">' + num + "</span></div>",
      iconSize:   [28, 28],
      iconAnchor: [14, 14],
    });
  }

  /** Remove all existing map markers */
  function clearMapMarkers() {
    if (!qcMap) return;
    qcMarkers.forEach(function (m) { qcMap.removeLayer(m); });
    qcMarkers = [];
  }

  /** Place numbered markers for all activePoints; fit map to bounds */
  function setMapMarkers(points) {
    if (!qcMap) return;
    clearMapMarkers();
    if (!points.length) return;

    const latlngs = [];
    points.forEach(function (pt, i) {
      const ll = mgrsToLatLon(pt.point);
      if (!ll) return;
      const marker = window.L.marker([ll.lat, ll.lon], {
        icon: makeNumberedIcon(i + 1),
      }).addTo(qcMap);
      qcMarkers.push(marker);
      latlngs.push([ll.lat, ll.lon]);
    });

    if (!latlngs.length) return;

    const zoom = getZoom();
    if (latlngs.length === 1) {
      qcMap.flyTo(latlngs[0], zoom, { animate: false, duration: 0 });
    } else {
      qcMap.fitBounds(latlngs, { animate: false, padding: [60, 60], maxZoom: zoom });
    }
  }

  /* ─────────────────────────────────────────────
   *  TEXT OPERATIONS
   * ───────────────────────────────────────────── */
  function resetIfDirty() {
    if (!textarea) return;
    if (textarea.value.trim()) {
      textarea.value = "";
      clearMapMarkers();
    }
  }

  function onPaste() {
    resetIfDirty();
    if (!navigator.clipboard?.readText) {
      toast("Браузер не підтримує читання буферу. Натисніть Ctrl+V у полі нижче.", "error", 3000);
      if (textarea) textarea.focus();
      return;
    }
    navigator.clipboard.readText().then(function (text) {
      if (textarea) textarea.value = text;
    }).catch(function () {
      toast("Немає доступу до буферу обміну. Вставте вручну (Ctrl+V).", "error", 3000);
      if (textarea) textarea.focus();
    });
  }

  function onCopy() {
    if (!textarea) return;
    if (!textarea.value) { toast("Поле порожнє", "error"); return; }
    window.clipboardWrite(textarea.value).then(function (ok) {
      if (ok) toast("Текст скопійовано!", "info", 1400);
      else toast("Помилка копіювання", "error");
    });
  }

  function onClear() {
    resetIfDirty();
  }

  function onGenerate() {
    if (!activeConclusion)    { toast("Оберіть тип висновку", "error"); return; }
    if (!activePoints.length) { toast("Оберіть точку",        "error"); return; }
    if (!textarea) return;

    // Build points block
    let pointsBlock;
    if (activePoints.length === 1) {
      pointsBlock = activePoints[0].point;
    } else {
      pointsBlock = activePoints.map(function (pt, i) {
        return (i + 1) + " - " + pt.point;
      }).join("\n");
    }

    const prev = textarea.value.trim();
    let text = "ТОРСЬКЕ\n" + activeConclusion.text + "\n\n" + pointsBlock +
               "\n\n-------  🦁 63 ОМБр 🦁 -------";
    if (prev) text += "\n\n" + prev;
    textarea.value = text;

    setMapMarkers(activePoints);
  }

  /* ─────────────────────────────────────────────
   *  MAP SCREENSHOT → CLIPBOARD
   * ───────────────────────────────────────────── */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function onCopyMap() {
    if (!mapDiv) return;

    if (!window.html2canvas) {
      try {
        await loadScript("https://html2canvas.hertzen.com/dist/html2canvas.min.js");
      } catch (e) {
        toast("Не вдалося завантажити бібліотеку скріншоту", "error", 3500);
        return;
      }
    }

    if (qcMap) qcMap.invalidateSize();

    try {
      const canvas = await window.html2canvas(mapDiv, {
        useCORS:      true,
        allowTaint:   false,
        logging:      false,
        imageTimeout: 15000,
      });

      canvas.toBlob(async function (blob) {
        if (!blob) { toast("Не вдалося створити зображення", "error"); return; }
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          toast("Скріншот карти скопійовано!", "success", 1800);
        } catch (e) {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "map_" + Date.now() + ".png";
          a.click();
          setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
          toast("Копіювання недоступне — файл завантажено", "info", 2500);
        }
      }, "image/png");
    } catch (e) {
      toast("Помилка скріншоту: " + (e.message || e), "error", 3500);
    }
  }

  /* ─────────────────────────────────────────────
   *  MANAGEMENT BLOCKS — CRUD
   * ───────────────────────────────────────────── */

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** Show/hide an error div */
  function showMgmtErr(el, msg) {
    if (!el) return;
    if (msg) { el.textContent = msg; el.style.display = ""; }
    else { el.style.display = "none"; el.textContent = ""; }
  }

  /* ── quick_conclusions management ── */

  function renderConclMgmt(items) {
    const list = $("qcConclList");
    if (!list) return;
    list.innerHTML = "";
    if (!items.length) {
      list.innerHTML = '<span class="small" style="opacity:.5">Порожньо</span>';
      return;
    }
    items.forEach(function (item) {
      list.appendChild(buildConclRow(item));
    });
  }

  function buildConclRow(item) {
    const row = document.createElement("div");
    row.className = "qc-mgmt-row";
    row.dataset.id = String(item.id);
    row.innerHTML =
      '<input class="qc-mgmt-inp qc-mgmt-inp--name" type="text" value="' + esc(item.name) + '" placeholder="Назва" />' +
      '<input class="qc-mgmt-inp qc-mgmt-inp--text" type="text" value="' + esc(item.text) + '" placeholder="Текст шаблону" />' +
      '<button type="button" class="qc-mgmt-save">Зберегти</button>' +
      '<button type="button" class="qc-mgmt-del secondary">✕</button>';

    row.querySelector(".qc-mgmt-save").addEventListener("click", async function () {
      const name = row.querySelector(".qc-mgmt-inp--name").value.trim();
      const text = row.querySelector(".qc-mgmt-inp--text").value.trim();
      if (!name) { toast("Назва не може бути порожньою", "error"); return; }
      const r = await fetch("/api/quick-conclusions/" + item.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, text }),
      });
      const d = await r.json();
      if (!d.ok) { toast(d.error || "Помилка збереження", "error"); return; }
      item.name = d.name; item.text = d.text;
      toast("Збережено", "info", 1200);
      reloadAll();
    });

    row.querySelector(".qc-mgmt-del").addEventListener("click", async function () {
      if (!confirm('Видалити "' + item.name + '"?')) return;
      const r = await fetch("/api/quick-conclusions/" + item.id, { method: "DELETE" });
      const d = await r.json();
      if (!d.ok) { toast(d.error || "Помилка видалення", "error"); return; }
      reloadAll();
    });

    return row;
  }

  function addConclRow() {
    const list = $("qcConclList");
    const errEl = $("qcConclErr");
    if (!list) return;
    showMgmtErr(errEl, "");

    const row = document.createElement("div");
    row.className = "qc-mgmt-row qc-mgmt-row--new";
    row.innerHTML =
      '<input class="qc-mgmt-inp qc-mgmt-inp--name" type="text" placeholder="Назва" />' +
      '<input class="qc-mgmt-inp qc-mgmt-inp--text" type="text" placeholder="Текст шаблону" />' +
      '<button type="button" class="qc-mgmt-save">Зберегти</button>' +
      '<button type="button" class="qc-mgmt-del secondary">✕</button>';

    row.querySelector(".qc-mgmt-save").addEventListener("click", async function () {
      const name = row.querySelector(".qc-mgmt-inp--name").value.trim();
      const text = row.querySelector(".qc-mgmt-inp--text").value.trim();
      if (!name) { showMgmtErr(errEl, "Назва не може бути порожньою"); return; }
      const r = await fetch("/api/quick-conclusions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, text }),
      });
      const d = await r.json();
      if (!d.ok) { showMgmtErr(errEl, d.error || "Помилка"); return; }
      reloadAll();
    });

    row.querySelector(".qc-mgmt-del").addEventListener("click", function () {
      row.remove();
      showMgmtErr(errEl, "");
    });

    list.insertBefore(row, list.firstChild);
    row.querySelector(".qc-mgmt-inp--name").focus();
  }

  /* ── quick_points management ── */

  function renderPointsMgmt(items) {
    const list = $("qcPointList");
    if (!list) return;
    list.innerHTML = "";
    if (!items.length) {
      list.innerHTML = '<span class="small" style="opacity:.5">Порожньо</span>';
      return;
    }
    items.forEach(function (item) {
      list.appendChild(buildPointRow(item));
    });
  }

  function buildPointRow(item) {
    const row = document.createElement("div");
    row.className = "qc-mgmt-row";
    row.dataset.id = String(item.id);
    row.innerHTML =
      '<input class="qc-mgmt-inp qc-mgmt-inp--name" type="text" value="' + esc(item.name) + '" placeholder="Назва" />' +
      '<input class="qc-mgmt-inp qc-mgmt-inp--point" type="text" value="' + esc(item.point) + '" placeholder="MGRS координата" />' +
      '<button type="button" class="qc-mgmt-save">Зберегти</button>' +
      '<button type="button" class="qc-mgmt-del secondary">✕</button>';

    row.querySelector(".qc-mgmt-save").addEventListener("click", async function () {
      const name  = row.querySelector(".qc-mgmt-inp--name").value.trim();
      const point = row.querySelector(".qc-mgmt-inp--point").value.trim();
      if (!name) { toast("Назва не може бути порожньою", "error"); return; }
      const r = await fetch("/api/quick-points/" + item.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, point }),
      });
      const d = await r.json();
      if (!d.ok) { toast(d.error || "Помилка збереження", "error"); return; }
      item.name = d.name; item.point = d.point;
      toast("Збережено", "info", 1200);
      reloadAll();
    });

    row.querySelector(".qc-mgmt-del").addEventListener("click", async function () {
      if (!confirm('Видалити "' + item.name + '"?')) return;
      const r = await fetch("/api/quick-points/" + item.id, { method: "DELETE" });
      const d = await r.json();
      if (!d.ok) { toast(d.error || "Помилка видалення", "error"); return; }
      reloadAll();
    });

    return row;
  }

  function addPointRow() {
    const list = $("qcPointList");
    const errEl = $("qcPointErr");
    if (!list) return;
    showMgmtErr(errEl, "");

    const row = document.createElement("div");
    row.className = "qc-mgmt-row qc-mgmt-row--new";
    row.innerHTML =
      '<input class="qc-mgmt-inp qc-mgmt-inp--name" type="text" placeholder="Назва (напр. 04)" />' +
      '<input class="qc-mgmt-inp qc-mgmt-inp--point" type="text" placeholder="MGRS (напр. 37U DQ 29050 28377)" />' +
      '<button type="button" class="qc-mgmt-save">Зберегти</button>' +
      '<button type="button" class="qc-mgmt-del secondary">✕</button>';

    row.querySelector(".qc-mgmt-save").addEventListener("click", async function () {
      const name  = row.querySelector(".qc-mgmt-inp--name").value.trim();
      const point = row.querySelector(".qc-mgmt-inp--point").value.trim();
      if (!name) { showMgmtErr(errEl, "Назва не може бути порожньою"); return; }
      const r = await fetch("/api/quick-points", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, point }),
      });
      const d = await r.json();
      if (!d.ok) { showMgmtErr(errEl, d.error || "Помилка"); return; }
      reloadAll();
    });

    row.querySelector(".qc-mgmt-del").addEventListener("click", function () {
      row.remove();
      showMgmtErr(errEl, "");
    });

    list.insertBefore(row, list.firstChild);
    row.querySelector(".qc-mgmt-inp--name").focus();
  }

  /* ── Reload everything after any mutation ── */
  async function reloadAll() {
    showMgmtErr($("qcConclErr"), "");
    showMgmtErr($("qcPointErr"), "");
    try {
      const [cr, pr] = await Promise.all([
        fetch("/api/quick-conclusions"),
        fetch("/api/quick-points"),
      ]);
      const cd = await cr.json();
      const pd = await pr.json();

      // Refresh selector buttons (top of tab)
      renderConclButtons(cd.rows || []);
      renderPointButtons(pd.rows || []);
      activeConclusion = null;
      activePoints = [];

      // Refresh management lists
      renderConclMgmt(cd.rows || []);
      renderPointsMgmt(pd.rows || []);
    } catch (e) {
      console.error("reloadAll failed", e);
    }
  }

  /* ─────────────────────────────────────────────
   *  TAB VISIBILITY HOOK
   * ───────────────────────────────────────────── */
  if (quickPanel && window.MutationObserver) {
    const obs = new MutationObserver(function () {
      if (!quickPanel.classList.contains("hidden")) {
        if (!mapReady && window.L) {
          setTimeout(function () { initMap(); }, 30);
        } else if (qcMap) {
          setTimeout(function () { qcMap.invalidateSize(); }, 30);
        }
      }
    });
    obs.observe(quickPanel, { attributes: true, attributeFilter: ["class"] });
  }

  /* ─────────────────────────────────────────────
   *  INIT
   * ───────────────────────────────────────────── */
  function init() {
    // Load selector buttons + management lists together
    (async function () {
      try {
        const [cr, pr] = await Promise.all([
          fetch("/api/quick-conclusions"),
          fetch("/api/quick-points"),
        ]);
        const cd = await cr.json();
        const pd = await pr.json();
        renderConclButtons(cd.rows || []);
        renderPointButtons(pd.rows || []);
        renderConclMgmt(cd.rows || []);
        renderPointsMgmt(pd.rows || []);
      } catch (e) {
        console.error("quick_conclusions: init load failed", e);
      }
    })();

    const pasteBtn      = $("qcPasteBtn");
    const copyBtn       = $("qcCopyBtn");
    const clearBtn      = $("qcClearBtn");
    const generateBtn   = $("qcGenerateBtn");
    const copyMapBtn    = $("qcCopyMapBtn");
    const addConclBtn   = $("qcAddConclBtn");
    const addPointBtn   = $("qcAddPointBtn");

    initZoomInput();

    if (pasteBtn)    pasteBtn.addEventListener("click", onPaste);
    if (copyBtn)     copyBtn.addEventListener("click", onCopy);
    if (clearBtn)    clearBtn.addEventListener("click", onClear);
    if (generateBtn) generateBtn.addEventListener("click", onGenerate);
    if (copyMapBtn)  copyMapBtn.addEventListener("click", onCopyMap);
    if (addConclBtn) addConclBtn.addEventListener("click", addConclRow);
    if (addPointBtn) addPointBtn.addEventListener("click", addPointRow);

    if (quickPanel && !quickPanel.classList.contains("hidden") && window.L) {
      setTimeout(initMap, 50);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
