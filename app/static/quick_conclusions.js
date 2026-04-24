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
  let activeConclusion = null;  // { id, name, text }
  let activePoint      = null;  // { id, name, point }
  let qcMap            = null;
  let qcMarker         = null;
  let mapReady         = false;

  /* ── DOM refs ── */
  const conclBtnsWrap = $("qcConclBtns");
  const pointBtnsWrap = $("qcPointBtns");
  const textarea      = $("qcTextarea");
  const mapDiv        = $("qcMapDiv");
  const quickPanel    = $("cnPaneQuick");

  /* ─────────────────────────────────────────────
   *  DATA LOADING
   * ───────────────────────────────────────────── */
  async function loadData() {
    try {
      const [cr, pr] = await Promise.all([
        fetch("/api/quick-conclusions"),
        fetch("/api/quick-points"),
      ]);
      const cd = await cr.json();
      const pd = await pr.json();
      renderConclButtons(cd.rows || []);
      renderPointButtons(pd.rows || []);
    } catch (e) {
      console.error("quick_conclusions: load failed", e);
    }
  }

  /* ─────────────────────────────────────────────
   *  TOGGLE BUTTON ROWS
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
      btn.textContent = item.name;
      btn.addEventListener("click", function () {
        pointBtnsWrap.querySelectorAll(".qc-toggle-btn").forEach(function (b) {
          b.classList.remove("active");
        });
        btn.classList.add("active");
        activePoint = item;
      });
      pointBtnsWrap.appendChild(btn);
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
      zoom: 10,
      zoomControl: true,
      attributionControl: false,
    });

    window.L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 18, crossOrigin: "anonymous" }
    ).addTo(qcMap);

    // Small attribution
    window.L.control.attribution({ prefix: false })
      .addAttribution("Tiles &copy; Esri")
      .addTo(qcMap);
  }

  /** Convert MGRS string (with or without spaces) → { lat, lon } or null */
  function mgrsToLatLon(s) {
    if (!window.mgrs && !window.mgrs?.toPoint) return null;
    try {
      const p = window.mgrs.toPoint(String(s).replace(/\s+/g, "").toUpperCase());
      if (!Array.isArray(p) || p.length < 2) return null;
      const lon = Number(p[0]), lat = Number(p[1]);
      return (isFinite(lat) && isFinite(lon)) ? { lat, lon } : null;
    } catch (_) { return null; }
  }

  /** Bullseye divIcon matching the screenshot style */
  function makeBullseyeIcon() {
    return window.L.divIcon({
      className: "",
      html: '<div class="qc-map-marker"><div class="qc-map-marker__inner"></div></div>',
      iconSize:   [24, 24],
      iconAnchor: [12, 12],
    });
  }

  function setMapMarker(pointStr) {
    if (!qcMap) return;
    if (qcMarker) { qcMap.removeLayer(qcMarker); qcMarker = null; }
    if (!pointStr) return;

    const ll = mgrsToLatLon(pointStr);
    if (!ll) return;

    qcMarker = window.L.marker([ll.lat, ll.lon], { icon: makeBullseyeIcon() })
      .addTo(qcMap);

    qcMap.flyTo([ll.lat, ll.lon], 14, { animate: false, duration: 0 });
  }

  function clearMapMarker() {
    if (qcMap && qcMarker) {
      qcMap.removeLayer(qcMarker);
      qcMarker = null;
    }
  }

  /* ─────────────────────────────────────────────
   *  TEXT OPERATIONS
   * ───────────────────────────────────────────── */
  function resetIfDirty() {
    if (!textarea) return;
    if (textarea.value.trim()) {
      textarea.value = "";
      clearMapMarker();
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
    navigator.clipboard.writeText(textarea.value).then(function () {
      toast("Текст скопійовано!", "info", 1400);
    }).catch(function () {
      toast("Помилка копіювання", "error");
    });
  }

  function onClear() {
    resetIfDirty();
  }

  function onGenerate() {
    if (!activeConclusion) { toast("Оберіть тип висновку", "error"); return; }
    if (!activePoint)      { toast("Оберіть точку",        "error"); return; }
    if (!textarea) return;

    const prev = textarea.value.trim();
    let text = "ТОРСЬКЕ\n" + activeConclusion.text + "\n\n" + activePoint.point +
               "\n\n-------  🦁 63 ОМБр 🦁 -------";
    if (prev) text += "\n\n" + prev;
    textarea.value = text;

    setMapMarker(activePoint.point);
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

    // Force tile re-render with crossOrigin before capturing
    if (qcMap) qcMap.invalidateSize();

    try {
      const canvas = await window.html2canvas(mapDiv, {
        useCORS:       true,
        allowTaint:    false,
        logging:       false,
        imageTimeout:  15000,
      });

      canvas.toBlob(async function (blob) {
        if (!blob) { toast("Не вдалося створити зображення", "error"); return; }
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          toast("Скріншот карти скопійовано!", "success", 1800);
        } catch (e) {
          // Fallback: offer download
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
   *  TAB VISIBILITY HOOK
   *  Leaflet needs a visible container to init.
   *  Watch for the hidden class being removed.
   * ───────────────────────────────────────────── */
  if (quickPanel && window.MutationObserver) {
    const obs = new MutationObserver(function () {
      if (!quickPanel.classList.contains("hidden")) {
        if (!mapReady && window.L) {
          setTimeout(function () {
            initMap();
          }, 30);
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
    loadData();

    const pasteBtn    = $("qcPasteBtn");
    const copyBtn     = $("qcCopyBtn");
    const clearBtn    = $("qcClearBtn");
    const generateBtn = $("qcGenerateBtn");
    const copyMapBtn  = $("qcCopyMapBtn");

    if (pasteBtn)    pasteBtn.addEventListener("click", onPaste);
    if (copyBtn)     copyBtn.addEventListener("click", onCopy);
    if (clearBtn)    clearBtn.addEventListener("click", onClear);
    if (generateBtn) generateBtn.addEventListener("click", onGenerate);
    if (copyMapBtn)  copyMapBtn.addEventListener("click", onCopyMap);

    // If the tab is already active on page load (e.g. ?tab=quick), init map now.
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
