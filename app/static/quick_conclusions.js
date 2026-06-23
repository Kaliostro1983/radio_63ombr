/**
 * quick_conclusions.js — «Швидко» tab on the /conclusions page.
 * v11
 * Depends on: Leaflet (already on page), mgrs.min.js (already on page).
 * html2canvas is loaded lazily on first screenshot attempt.
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }
  function toast(msg, type, ms) {
    if (window.appToast) window.appToast(msg, type || "info", ms || 2000);
  }
  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ── Map / generation state ── */
  let activeConclusion = null;
  let activePoints     = [];
  let qcMap            = null;
  let qcTileLayer      = null;
  let qcMarkers        = [];
  let qcLabelMarkers   = [];
  let mapReady         = false;

  /* ── Platform / chat state (persisted in localStorage) ── */
  let activePlatform = localStorage.getItem("qcPlatform") || "whatsapp";
  let activeChatId   = localStorage.getItem("qcChatId")   || "";
  let activeChatName = localStorage.getItem("qcChatName") || "";
  let cachedChats    = {};   // { "whatsapp": [...], "signal": [...] }

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
      if (isFinite(v) && v >= 1 && v <= 18) localStorage.setItem(ZOOM_KEY, String(v));
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
    var sorted = items.slice().sort(function (a, b) {
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
    sorted.forEach(function (item) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "qc-toggle-btn";
      btn.dataset.id = String(item.id);
      btn.dataset.name = item.name;
      btn.textContent = item.name;
      btn.addEventListener("click", function () {
        const idx = activePoints.findIndex(function (p) { return p.id === item.id; });
        if (idx === -1) {
          activePoints.push(item);
        } else {
          activePoints.splice(idx, 1);
        }
        refreshPointButtonLabels();
        // Одразу показуємо/оновлюємо точки на карті при виборі (а не лише на
        // «Згенерувати») — інакше при кліку по пункту точка не з'являлась.
        setMapMarkers(activePoints);
      });
      pointBtnsWrap.appendChild(btn);
    });
  }

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

    // Google hybrid із crossOrigin — тайли вантажаться як CORS-чисті, тож
    // html2canvas НЕ перезавантажує їх під час зйомки (на великій площі саме
    // цей storm перезавантажень упирався в imageTimeout → «Timed out»).
    qcTileLayer = window.L.tileLayer(
      "https://mt1.google.com/vt/lyrs=y&hl=uk&x={x}&y={y}&z={z}",
      { maxZoom: 20, attribution: "Google", crossOrigin: "anonymous" }
    ).addTo(qcMap);

    window.L.control.attribution({ prefix: false })
      .addAttribution("Tiles &copy; Esri")
      .addTo(qcMap);

    loadMapLabels();
  }

  function mgrsToLatLon(s) {
    if (!window.mgrs || !window.mgrs.toPoint) return null;
    try {
      const p = window.mgrs.toPoint(String(s).replace(/\s+/g, "").toUpperCase());
      if (!Array.isArray(p) || p.length < 2) return null;
      const lon = Number(p[0]), lat = Number(p[1]);
      return (isFinite(lat) && isFinite(lon)) ? { lat, lon } : null;
    } catch (_) { return null; }
  }

  function makeNumberedIcon(num) {
    return window.L.divIcon({
      className: "",
      html: '<div class="qc-map-marker"><span class="qc-map-marker__num">' + num + "</span></div>",
      iconSize:   [28, 28],
      iconAnchor: [14, 14],
    });
  }

  function clearMapMarkers() {
    if (!qcMap) return;
    qcMarkers.forEach(function (m) { qcMap.removeLayer(m); });
    qcMarkers = [];
  }

  function makeTextLabelIcon(name) {
    return window.L.divIcon({
      className: "qc-map-label-icon",
      html: String(name),
      iconSize:   [0, 0],
      iconAnchor: [0, 0],
    });
  }

  function clearLabelMarkers() {
    if (!qcMap) return;
    qcLabelMarkers.forEach(function (m) { qcMap.removeLayer(m); });
    qcLabelMarkers = [];
  }

  function loadMapLabels() {
    if (!qcMap) return;
    fetch("/api/map-labels").then(function (r) { return r.json(); }).then(function (d) {
      clearLabelMarkers();
      (d.rows || []).forEach(function (item) {
        if (!item.mgrs) return;
        const ll = mgrsToLatLon(item.mgrs);
        if (!ll) return;
        const marker = window.L.marker([ll.lat, ll.lon], {
          icon: makeTextLabelIcon(item.name),
          interactive: false,
          keyboard: false,
        }).addTo(qcMap);
        qcLabelMarkers.push(marker);
      });
    }).catch(function () {});
  }

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
   *  GENERATE
   * ───────────────────────────────────────────── */
  function onGenerate() {
    if (!activeConclusion)    { toast("Оберіть тип висновку", "error"); return; }
    if (!activePoints.length) { toast("Оберіть точку",        "error"); return; }
    if (!textarea) return;

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
   *  COPY TEXT
   * ───────────────────────────────────────────── */
  function onCopy() {
    if (!textarea) return;
    if (!textarea.value) { toast("Поле порожнє", "error"); return; }
    window.clipboardWrite(textarea.value).then(function (ok) {
      if (ok) toast("Текст скопійовано!", "info", 1400);
      else toast("Помилка копіювання", "error");
    });
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

  /* Чекати, поки тайл-шар довантажить усі видимі тайли (з фолбеком по часу). */
  function waitForTiles(maxMs) {
    return new Promise(function (resolve) {
      if (!qcTileLayer || !qcTileLayer.isLoading || !qcTileLayer.isLoading()) { resolve(); return; }
      let done = false;
      const finish = function () { if (done) return; done = true; resolve(); };
      qcTileLayer.once("load", finish);
      setTimeout(finish, maxMs || 6000);
    });
  }

  async function onCopyMap() {
    if (!mapDiv) return;
    if (!window.html2canvas) {
      try { await loadScript("https://html2canvas.hertzen.com/dist/html2canvas.min.js"); }
      catch (e) { toast("Не вдалося завантажити бібліотеку скріншоту", "error", 3500); return; }
    }
    if (qcMap) qcMap.invalidateSize();
    await waitForTiles(6000);          // дочекатися тайлів перед зйомкою
    try {
      const canvas = await window.html2canvas(mapDiv, {
        // imageTimeout:0 — прибрати таймаут (тайли вже CORS-завантажені, повтор не потрібен)
        useCORS: true, allowTaint: false, logging: false, imageTimeout: 0,
      });
      canvas.toBlob(async function (blob) {
        if (!blob) { toast("Не вдалося створити зображення", "error"); return; }
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          toast("Скріншот карти скопійовано!", "success", 1800);
        } catch (e) {
          const dataUrl = canvas.toDataURL("image/png");
          const modal   = document.getElementById("mapImgModal");
          const preview = document.getElementById("mapImgPreview");
          const close   = document.getElementById("mapImgCloseBtn");
          const backdrop = document.getElementById("mapImgBackdrop");
          if (modal && preview) {
            preview.src = dataUrl;
            modal.classList.remove("hidden");
            modal.setAttribute("aria-hidden", "false");
            function closeModal() {
              modal.classList.add("hidden");
              modal.setAttribute("aria-hidden", "true");
              preview.src = "";
            }
            if (close)    close.onclick    = closeModal;
            if (backdrop) backdrop.onclick = closeModal;
          }
          toast("Правою кнопкою на карту → Копіювати зображення", "info", 4000);
        }
      }, "image/png");
    } catch (e) {
      toast("Помилка скріншоту: " + (e.message || e), "error", 3500);
    }
  }

  /* ─────────────────────────────────────────────
   *  PLATFORM TOGGLE
   * ───────────────────────────────────────────── */
  function savePlatform(p) {
    activePlatform = p;
    localStorage.setItem("qcPlatform", p);
  }

  function updatePlatformBtn() {
    const btn = $("qcPlatformBtn");
    if (!btn) return;
    if (activePlatform === "signal") {
      btn.textContent = "S";
      btn.className   = "qc-platform-btn qc-platform-btn--signal";
      btn.title       = "Signal (натисни для WhatsApp)";
    } else {
      btn.textContent = "W";
      btn.className   = "qc-platform-btn qc-platform-btn--wa";
      btn.title       = "WhatsApp (натисни для Signal)";
    }
  }

  function onPlatformToggle() {
    savePlatform(activePlatform === "whatsapp" ? "signal" : "whatsapp");
    updatePlatformBtn();
    // Clear chat selection — chats differ by platform
    activeChatId   = "";
    activeChatName = "";
    localStorage.removeItem("qcChatId");
    localStorage.removeItem("qcChatName");
    const inp = $("qcChatInput");
    if (inp) inp.value = "";
    // Preload chats for new platform
    loadChats(activePlatform);
  }

  /* ─────────────────────────────────────────────
   *  CHAT AUTOCOMPLETE
   * ───────────────────────────────────────────── */
  function saveChat(id, name) {
    activeChatId   = id;
    activeChatName = name;
    localStorage.setItem("qcChatId",   id);
    localStorage.setItem("qcChatName", name);
  }

  async function loadChats(platform) {
    if (cachedChats[platform]) return cachedChats[platform];
    try {
      const r = await fetch("/api/push/chats?platform=" + platform + "&only_groups=1");
      const d = await r.json();
      if (d.ok && Array.isArray(d.chats)) {
        cachedChats[platform] = d.chats;
        return d.chats;
      }
    } catch (_) {}
    return [];
  }

  function renderChatDrop(chats, query) {
    const drop = $("qcChatDrop");
    if (!drop) return;
    const q = (query || "").toLowerCase();
    const filtered = q
      ? chats.filter(function (c) { return c.name.toLowerCase().includes(q); })
      : chats;

    if (!filtered.length) { drop.classList.add("hidden"); return; }

    drop.innerHTML = "";
    filtered.slice(0, 40).forEach(function (chat) {
      const item = document.createElement("div");
      item.className = "qc-chat-drop-item";
      item.dataset.id   = chat.id;
      item.dataset.name = chat.name;
      item.innerHTML =
        '<span>' + esc(chat.name) + '</span>' +
        '<span class="qc-chat-drop-item__type">' +
        esc(chat.type === "group" ? "група" : "контакт") + '</span>';
      item.addEventListener("mousedown", function (e) {
        e.preventDefault();
        selectChat(chat.id, chat.name);
        drop.classList.add("hidden");
      });
      drop.appendChild(item);
    });
    drop.classList.remove("hidden");
  }

  function selectChat(id, name) {
    const inp = $("qcChatInput");
    if (inp) inp.value = name;
    saveChat(id, name);
  }

  function setupChatAutocomplete() {
    const input = $("qcChatInput");
    const drop  = $("qcChatDrop");
    if (!input || !drop) return;

    // Restore saved selection
    if (activeChatName) input.value = activeChatName;

    input.addEventListener("focus", async function () {
      const chats = await loadChats(activePlatform);
      renderChatDrop(chats, input.value);
    });

    input.addEventListener("input", async function () {
      // If user edits, clear stored chat_id
      if (input.value !== activeChatName) {
        activeChatId   = "";
        activeChatName = input.value;
      }
      const chats = await loadChats(activePlatform);
      renderChatDrop(chats, input.value);
    });

    input.addEventListener("blur", function () {
      setTimeout(function () { drop.classList.add("hidden"); }, 160);
    });

    input.addEventListener("keydown", function (e) {
      const items = drop.querySelectorAll(".qc-chat-drop-item");
      if (!items.length || drop.classList.contains("hidden")) return;
      const focused = drop.querySelector(".qc-chat-drop-item.focused");

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!focused) { items[0].classList.add("focused"); }
        else {
          focused.classList.remove("focused");
          (focused.nextElementSibling || items[0]).classList.add("focused");
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (!focused) { items[items.length - 1].classList.add("focused"); }
        else {
          focused.classList.remove("focused");
          (focused.previousElementSibling || items[items.length - 1]).classList.add("focused");
        }
      } else if (e.key === "Enter" && focused) {
        e.preventDefault();
        focused.dispatchEvent(new MouseEvent("mousedown"));
      } else if (e.key === "Escape") {
        drop.classList.add("hidden");
      }
    });
  }

  /* ─────────────────────────────────────────────
   *  SEND (text + map → bot service)
   * ───────────────────────────────────────────── */
  async function onSend() {
    const text = textarea ? textarea.value.trim() : "";
    if (!text)        { toast("Текст порожній — спочатку згенеруйте висновок", "error", 3000); return; }
    if (!activeChatId){ toast("Оберіть чат зі списку", "error", 2500); return; }

    const sendBtn = $("qcSendBtn");
    if (sendBtn) sendBtn.disabled = true;

    try {
      // Capture map screenshot as JPEG (scaled to ≤1200px)
      let imageb64 = "";
      if (mapDiv) {
        if (!window.html2canvas) {
          try { await loadScript("https://html2canvas.hertzen.com/dist/html2canvas.min.js"); }
          catch (_) { /* continue without image */ }
        }
        if (window.html2canvas) {
          try {
            if (qcMap) qcMap.invalidateSize();
            await waitForTiles(6000);
            const canvas = await window.html2canvas(mapDiv, {
              useCORS: true, allowTaint: false, logging: false, imageTimeout: 0,
            });
            const MAX_W = 1200;
            let out = canvas;
            if (canvas.width > MAX_W) {
              const scale = MAX_W / canvas.width;
              out = document.createElement("canvas");
              out.width  = MAX_W;
              out.height = Math.round(canvas.height * scale);
              out.getContext("2d").drawImage(canvas, 0, 0, out.width, out.height);
            }
            imageb64 = out.toDataURL("image/jpeg", 0.82).split(",")[1] || "";
          } catch (_) { /* skip image */ }
        }
      }

      const r = await fetch("/api/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform:     activePlatform,
          chat_id:      activeChatId,
          text:         text,
          image_base64: imageb64,
        }),
      });
      const d = await r.json();
      if (!d.ok) {
        const msg = (typeof d.error === "object")
          ? JSON.stringify(d.error)
          : (d.error || d.message || "Помилка відправки");
        toast(msg, "error", 5000);
        return;
      }
      toast("Надіслано! 📢", "success", 2500);
    } catch (e) {
      toast("Помилка: " + (e.message || e), "error", 4000);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }

  /* ─────────────────────────────────────────────
   *  MANAGEMENT BLOCKS — CRUD
   * ───────────────────────────────────────────── */

  function showMgmtErr(el, msg) {
    if (!el) return;
    if (msg) { el.textContent = msg; el.style.display = ""; }
    else     { el.style.display = "none"; el.textContent = ""; }
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
    items.forEach(function (item) { list.appendChild(buildConclRow(item)); });
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
    const list  = $("qcConclList");
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
    items.slice()
      .sort(function (a, b) {
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      })
      .forEach(function (item) { list.appendChild(buildPointRow(item)); });
  }

  function buildPointRow(item) {
    const row = document.createElement("div");
    row.className = "qc-mgmt-row";
    row.dataset.id = String(item.id);
    row.innerHTML =
      '<input class="qc-mgmt-inp qc-mgmt-inp--name"  type="text" value="' + esc(item.name)  + '" placeholder="Назва" />' +
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
    const list  = $("qcPointList");
    const errEl = $("qcPointErr");
    if (!list) return;
    showMgmtErr(errEl, "");

    const row = document.createElement("div");
    row.className = "qc-mgmt-row qc-mgmt-row--new";
    row.innerHTML =
      '<input class="qc-mgmt-inp qc-mgmt-inp--name"  type="text" placeholder="Назва (напр. 04)" />' +
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

  /* ── quick_map_labels management ── */

  function renderLabelsMgmt(items) {
    const list = $("qcLabelList");
    if (!list) return;
    list.innerHTML = "";
    if (!items.length) {
      list.innerHTML = '<span class="small" style="opacity:.5">Порожньо</span>';
      return;
    }
    items.forEach(function (item) { list.appendChild(buildLabelRow(item)); });
  }

  function buildLabelRow(item) {
    const row = document.createElement("div");
    row.className = "qc-mgmt-row";
    row.dataset.id = String(item.id);
    row.innerHTML =
      '<input class="qc-mgmt-inp qc-mgmt-inp--name"  type="text" value="' + esc(item.name) + '" placeholder="Назва" />' +
      '<input class="qc-mgmt-inp qc-mgmt-inp--point" type="text" value="' + esc(item.mgrs) + '" placeholder="MGRS координата" />' +
      '<button type="button" class="qc-mgmt-save">Зберегти</button>' +
      '<button type="button" class="qc-mgmt-del secondary">✕</button>';

    row.querySelector(".qc-mgmt-save").addEventListener("click", async function () {
      const name = row.querySelector(".qc-mgmt-inp--name").value.trim();
      const mgrs = row.querySelector(".qc-mgmt-inp--point").value.trim();
      if (!name) { toast("Назва не може бути порожньою", "error"); return; }
      const r = await fetch("/api/map-labels/" + item.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mgrs }),
      });
      const d = await r.json();
      if (!d.ok) { toast(d.error || "Помилка збереження", "error"); return; }
      item.name = d.name; item.mgrs = d.mgrs;
      toast("Збережено", "info", 1200);
      reloadAll();
    });

    row.querySelector(".qc-mgmt-del").addEventListener("click", async function () {
      if (!confirm('Видалити "' + item.name + '"?')) return;
      const r = await fetch("/api/map-labels/" + item.id, { method: "DELETE" });
      const d = await r.json();
      if (!d.ok) { toast(d.error || "Помилка видалення", "error"); return; }
      reloadAll();
    });

    return row;
  }

  function addLabelRow() {
    const list  = $("qcLabelList");
    const errEl = $("qcLabelErr");
    if (!list) return;
    showMgmtErr(errEl, "");

    const row = document.createElement("div");
    row.className = "qc-mgmt-row qc-mgmt-row--new";
    row.innerHTML =
      '<input class="qc-mgmt-inp qc-mgmt-inp--name"  type="text" placeholder="Назва (напр. Торське)" />' +
      '<input class="qc-mgmt-inp qc-mgmt-inp--point" type="text" placeholder="MGRS (напр. 37U DQ 29050 28377)" />' +
      '<button type="button" class="qc-mgmt-save">Зберегти</button>' +
      '<button type="button" class="qc-mgmt-del secondary">✕</button>';

    row.querySelector(".qc-mgmt-save").addEventListener("click", async function () {
      const name = row.querySelector(".qc-mgmt-inp--name").value.trim();
      const mgrs = row.querySelector(".qc-mgmt-inp--point").value.trim();
      if (!name) { showMgmtErr(errEl, "Назва не може бути порожньою"); return; }
      const r = await fetch("/api/map-labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mgrs }),
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
    showMgmtErr($("qcLabelErr"), "");
    try {
      const [cr, pr, lr] = await Promise.all([
        fetch("/api/quick-conclusions"),
        fetch("/api/quick-points"),
        fetch("/api/map-labels"),
      ]);
      const cd = await cr.json();
      const pd = await pr.json();
      const ld = await lr.json();

      renderConclButtons(cd.rows || []);
      renderPointButtons(pd.rows || []);
      activeConclusion = null;
      activePoints = [];

      renderConclMgmt(cd.rows || []);
      renderPointsMgmt(pd.rows || []);
      renderLabelsMgmt(ld.rows || []);

      loadMapLabels();
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
    (async function () {
      try {
        const [cr, pr, lr] = await Promise.all([
          fetch("/api/quick-conclusions"),
          fetch("/api/quick-points"),
          fetch("/api/map-labels"),
        ]);
        const cd = await cr.json();
        const pd = await pr.json();
        const ld = await lr.json();
        renderConclButtons(cd.rows || []);
        renderPointButtons(pd.rows || []);
        renderConclMgmt(cd.rows || []);
        renderPointsMgmt(pd.rows || []);
        renderLabelsMgmt(ld.rows || []);
      } catch (e) {
        console.error("quick_conclusions: init load failed", e);
      }
    })();

    // Platform button
    const platformBtn = $("qcPlatformBtn");
    updatePlatformBtn();
    if (platformBtn) platformBtn.addEventListener("click", onPlatformToggle);

    // Chat autocomplete
    setupChatAutocomplete();

    // Preload chats for current platform (background)
    loadChats(activePlatform);

    // Other buttons
    const generateBtn = $("qcGenerateBtn");
    const copyBtn     = $("qcCopyBtn");
    const copyMapBtn  = $("qcCopyMapBtn");
    const sendBtn     = $("qcSendBtn");
    const pasteBtn    = $("qcPasteBtn");
    const clearBtn    = $("qcClearBtn");
    const addConclBtn = $("qcAddConclBtn");
    const addPointBtn = $("qcAddPointBtn");
    const addLabelBtn = $("qcAddLabelBtn");

    initZoomInput();

    if (generateBtn) generateBtn.addEventListener("click", onGenerate);
    if (copyBtn)     copyBtn.addEventListener("click", onCopy);
    if (copyMapBtn)  copyMapBtn.addEventListener("click", onCopyMap);
    if (sendBtn)     sendBtn.addEventListener("click", onSend);

    if (pasteBtn) pasteBtn.addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (textarea) { textarea.value = text; textarea.focus(); }
      } catch (_) {
        toast("Немає доступу до буфера обміну", "warn");
      }
    });

    if (clearBtn) clearBtn.addEventListener("click", () => {
      if (textarea) { textarea.value = ""; textarea.focus(); }
    });
    if (addConclBtn) addConclBtn.addEventListener("click", addConclRow);
    if (addPointBtn) addPointBtn.addEventListener("click", addPointRow);
    if (addLabelBtn) addLabelBtn.addEventListener("click", addLabelRow);

    if (quickPanel && !quickPanel.classList.contains("hidden") && window.L) {
      setTimeout(initMap, 50);
    }

    // Команда із зовнішнього вікна (вкладка «Моніторинг» → «Швидкий висновок»):
    // очистити інпут+маркери карти і вставити переданий текст.
    window.addEventListener("message", function (e) {
      const d = e && e.data;
      if (!d || d.type !== "qc:reset-and-paste") return;
      if (textarea) { textarea.value = String(d.text || ""); }
      clearMapMarkers();
      if (qcMap) qcMap.invalidateSize();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
