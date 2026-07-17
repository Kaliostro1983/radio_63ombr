/* ============================================================
   Fullscreen analytical-conclusions map  (v4 — milsymbol icons)
   ============================================================ */
"use strict";

// ── URL params ────────────────────────────────────────────────
const _params    = new URLSearchParams(location.search);
const _dateFrom   = _params.get("date_from") || "";
const _dateTo     = _params.get("date_to")   || "";
const _networkId  = parseInt(_params.get("network_id") || "0", 10);
const _callsignId = parseInt(_params.get("callsign_id") || "0", 10);
const _callsign   = _params.get("callsign") || "";

// ── State ─────────────────────────────────────────────────────
let _map = null;
let _types = [];            // [{id, type, color, icon_filename, icon_sidc, ...}]
let _rows  = [];            // all conclusions with MGRS
let _hiddenTypeIds = new Set(); // types hidden individually; empty = all visible
let _allHidden     = false;     // true = all markers hidden via "Сховати всі"
let _layerGroups = {};      // typeId → L.LayerGroup
let _allMarkers  = [];      // [{row, marker, typeId}]
let _showFreq    = false;   // чекбокс «Частоти» — підпис біля кожного маркера
let _showUnit    = false;   // чекбокс «Підрозділ» — кольорове коло з номером
let _panelRow    = null;    // висновок, відкритий у правій панелі (для дій)

/** Витягнути НОМЕР бригади/полка з опису р/м (порт з peleng.js). */
function extractUnitNumber(unitText) {
  const s = String(unitText || "");
  if (!s) return null;
  const MARKERS = "(?:омсбр|мсбр|обр|омбр|обмбр|обмп|мсп|мп|тп|тбр|мбр|мсд|тд|обз|орб|оемб|оп|полк|бригад)";
  const re = new RegExp("(\\d{1,3})\\s*" + MARKERS, "i");
  const m = s.match(re);
  if (m) return m[1];
  const fallback = s.match(/\b(\d{1,3})\b/);
  return fallback ? fallback[1] : null;
}

/** Сталий колір номера підрозділу через HSL "золотий кут". */
function colorForUnit(num) {
  const n = Number(num);
  if (!isFinite(n) || n <= 0) return "#6b7280";
  const hue = (n * 137.508) % 360;
  return `hsl(${hue.toFixed(1)}, 70%, 45%)`;
}

/** Leaflet divIcon кольорового кола з номером підрозділу. */
function makeUnitIcon(unitNum) {
  const color = colorForUnit(unitNum);
  return L.divIcon({
    className: "cm-unit-icon",
    html: `<div class="cm-unit-circle" style="background:${color}">${String(unitNum || "?")}</div>`,
    iconSize:    [34, 34],
    iconAnchor:  [17, 17],
    popupAnchor: [0, -17],
  });
}

// ── MGRS helper ───────────────────────────────────────────────
function mgrsToLatLng(mgrsStr) {
  try {
    if (window.mgrs && window.mgrs.toPoint) {
      const clean = String(mgrsStr).replace(/\s+/g, "").toUpperCase();
      const pt = window.mgrs.toPoint(clean);
      if (!Array.isArray(pt) || pt.length < 2) return null;
      const lat = Number(pt[1]), lon = Number(pt[0]);
      return (isFinite(lat) && isFinite(lon)) ? [lat, lon] : null;
    }
  } catch (_) {}
  return null;
}

// ── Toast notification ────────────────────────────────────────
function mapToast(msg) {
  let el = document.getElementById("mapToastEl");
  if (!el) {
    el = document.createElement("div");
    el.id = "mapToastEl";
    el.style.cssText = [
      "position:fixed", "bottom:24px", "left:50%", "transform:translateX(-50%)",
      "background:#1e293b", "color:#e2e8f0", "font-size:13px",
      "padding:8px 18px", "border-radius:20px",
      "box-shadow:0 4px 16px rgba(0,0,0,.55)",
      "pointer-events:none", "z-index:9999",
      "transition:opacity .25s", "opacity:0",
    ].join(";");
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = "1";
  clearTimeout(el._tid);
  el._tid = setTimeout(() => { el.style.opacity = "0"; }, 1800);
}

// ── Icon URL builder (legacy SVG files) ───────────────────────
function iconUrl(filename) {
  return filename ? `/static/icons/${filename}` : `/static/icons/default.svg`;
}

// Cache: key = `${filename}::${color}`
const _svgIconCache = {};

async function getIconUrl(filename, color) {
  const key = `${filename || ""}::${color || "#6b7280"}`;
  if (_svgIconCache[key]) return _svgIconCache[key];

  const effectiveFile = filename || "default.svg";
  const url = `/static/icons/${effectiveFile}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error();
    let svg = await resp.text();
    svg = svg.replace(/FILL/g, color || "#6b7280");
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const blobUrl = URL.createObjectURL(blob);
    _svgIconCache[key] = blobUrl;
    return blobUrl;
  } catch (_) {
    _svgIconCache[key] = url;
    return url;
  }
}

// ── milsymbol icon generation (APP-6 / MIL-STD-2525) ─────────
// Cache: sidc → { url, w, h }
const _sidcCache = {};

// Усі іконки на карті рендеримо в 60% від «рідного» розміру milsymbol.
// Окремо керуємо саме візуальним масштабом, бо параметр size: у milsymbol
// масштабує не лінійно (через obvedення/тіні), і самого size:32 виявилось
// замало (зменшились лише fallback-кружечки, а SIDC лишились великими).
const SIDC_DISPLAY_SCALE = 0.75;

function getSidcIcon(sidc) {
  if (!sidc || !window.ms) return null;
  if (_sidcCache[sidc]) return _sidcCache[sidc];
  try {
    const sym = new ms.Symbol(sidc, { size: 32 });
    const sz  = sym.getSize();
    const svg = sym.asSVG();
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url  = URL.createObjectURL(blob);
    const result = {
      url,
      w: Math.max(8, Math.round(sz.width  * SIDC_DISPLAY_SCALE)),
      h: Math.max(8, Math.round(sz.height * SIDC_DISPLAY_SCALE)),
    };
    _sidcCache[sidc] = result;
    return result;
  } catch (_) {
    return null;
  }
}

// ── Build Leaflet DivIcon ─────────────────────────────────────
function makeLeafletIcon(imgUrl, w, h) {
  const sw = w || 22, sh = h || 22;
  return L.divIcon({
    className: "cm-icon",
    html: `<img src="${imgUrl}" alt="" width="${sw}" height="${sh}">`,
    iconSize:   [sw, sh],
    iconAnchor: [Math.round(sw / 2), Math.round(sh / 2)],
    popupAnchor:[0, -Math.round(sh / 2)],
  });
}

// ── Resolve icon data for a type ──────────────────────────────
async function resolveIconData(typeObj) {
  // Prefer SIDC → SVG file → colored default
  if (typeObj && typeObj.icon_sidc) {
    const info = getSidcIcon(typeObj.icon_sidc);
    if (info) return info;
  }
  const color = (typeObj && typeObj.color) || "#6b7280";
  const filename = (typeObj && typeObj.icon_filename) || "";
  const url = await getIconUrl(filename, color);
  return { url, w: 22, h: 22 };
}

// ── Map initialisation ────────────────────────────────────────
function initMap() {
  _map = L.map("map", {
    center: [48.5, 37.5],
    zoom: 10,
    zoomControl: true,
  });

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "Esri", maxZoom: 19 }
  ).addTo(_map);

  _map.on("click", () => { closeRightPanel(); closeClusterPicker(); });
}

// ── Load types ────────────────────────────────────────────────
async function loadTypes() {
  const resp = await fetch("/api/conclusions/types");
  const data = await resp.json();
  _types = data.rows || [];

  for (const t of _types) {
    if (!_layerGroups[t.id]) {
      _layerGroups[t.id] = L.layerGroup().addTo(_map);
    }
  }
  if (!_layerGroups[0]) {
    _layerGroups[0] = L.layerGroup().addTo(_map);
  }
  // chips rendered after placeMarkers() so counts are available
}

// ── Render type filter chips ──────────────────────────────────
function renderTypeChips() {
  const container = document.getElementById("chipContainer");
  container.innerHTML = "";

  // Count markers per typeId
  const countByType = {};
  for (const { typeId } of _allMarkers) {
    countByType[typeId] = (countByType[typeId] || 0) + 1;
  }

  // Only show types that actually have markers on the map
  const presentTypes = _types.filter(t => countByType[t.id] > 0);

  // "Всі" toggle button
  const allBtn = document.createElement("button");
  allBtn.className = "type-chip-all";
  allBtn.textContent = "Всі";
  allBtn.addEventListener("click", () => {
    _allHidden = !_allHidden;
    if (!_allHidden) _hiddenTypeIds.clear(); // "Показати всі" скидає індивідуальні сховання
    updateChipStates();
    applyTypeFilter();
  });
  container.appendChild(allBtn);

  const divider = document.createElement("span");
  divider.className = "chip-divider";
  container.appendChild(divider);

  for (const t of presentTypes) {
    const chip = document.createElement("div");
    chip.className = "type-chip";
    chip.dataset.typeId = t.id;
    chip.style.setProperty("--chip-color", t.color || "#6b7280");
    chip.style.background = `${t.color || "#6b7280"}33`;

    // Icon — milsymbol preferred, SVG file fallback
    const img = document.createElement("img");
    img.width = 22; img.height = 22;
    if (t.icon_sidc) {
      const info = getSidcIcon(t.icon_sidc);
      if (info) img.src = info.url;
      else getIconUrl(t.icon_filename, t.color || "#6b7280").then(u => img.src = u);
    } else {
      getIconUrl(t.icon_filename, t.color || "#6b7280").then(u => img.src = u);
    }
    chip.appendChild(img);

    const label = document.createElement("span");
    label.textContent = `${t.type} (${countByType[t.id]})`;
    chip.appendChild(label);

    chip.addEventListener("click", () => toggleTypeChip(t.id));
    container.appendChild(chip);
  }

  updateChipStates();
}

function toggleTypeChip(typeId) {
  if (_allHidden) {
    // Вихід із "сховати всі": заповнюємо _hiddenTypeIds усіма категоріями
    // крім натиснутої — показуємо лише її
    _allHidden = false;
    const presentIds = new Set(_allMarkers.map(m => m.typeId));
    _hiddenTypeIds = new Set([...presentIds].filter(id => id !== typeId));
  } else {
    if (_hiddenTypeIds.has(typeId)) {
      _hiddenTypeIds.delete(typeId); // було сховано → показуємо
    } else {
      _hiddenTypeIds.add(typeId);    // було видно → ховаємо
    }
  }
  closeRightPanel();
  updateChipStates();
  applyTypeFilter();
}

function updateChipStates() {
  document.querySelectorAll(".type-chip").forEach(chip => {
    const id = parseInt(chip.dataset.typeId, 10);
    // чіп підсвічений = категорія видима (не прихована і не "сховати всі")
    chip.classList.toggle("active", !_allHidden && !_hiddenTypeIds.has(id));
  });
  const allBtn = document.querySelector(".type-chip-all");
  if (allBtn) {
    allBtn.textContent      = _allHidden ? "Показати всі" : "Сховати всі";
    allBtn.style.background = _allHidden ? "transparent" : "rgba(255,255,255,.12)";
  }
}

function applyTypeFilter() {
  let visible = 0;
  for (const { marker, typeId } of _allMarkers) {
    const show = !_allHidden && !_hiddenTypeIds.has(typeId);
    if (show) {
      if (!_map.hasLayer(marker)) marker.addTo(_map);
      visible++;
    } else {
      if (_map.hasLayer(marker)) _map.removeLayer(marker);
    }
  }
  updateCountBadge(visible);
}

// ── Load conclusions ──────────────────────────────────────────
async function loadConclusions() {
  const qs = new URLSearchParams();
  if (_dateFrom)   qs.set("date_from",  _dateFrom);
  if (_dateTo)     qs.set("date_to",    _dateTo);
  if (_networkId)  qs.set("network_id", _networkId);
  if (_callsignId) qs.set("callsign_id", _callsignId);
  else if (_callsign) qs.set("callsign", _callsign);

  const resp = await fetch(`/api/conclusions?${qs}`);
  const data = await resp.json();
  _rows = (data.rows || []).filter(r => r.mgrs && r.mgrs.length > 0);
}

// ── Place markers on the map ──────────────────────────────────
async function placeMarkers(opts) {
  const skipFit = opts && opts.skipFit;
  // Прибираємо старі маркери (якщо це перерендер після зміни чекбокса).
  for (const m of _allMarkers) {
    try { m.marker.remove(); } catch (_) {}
  }
  _allMarkers = [];

  const typeMap = {};
  for (const t of _types) typeMap[t.id] = t;

  // Pre-resolve icon data for all unique type IDs
  const iconData = {};
  const uniqueTypeIds = [...new Set(_rows.map(r => r.type_id))];
  await Promise.all(uniqueTypeIds.map(async tid => {
    iconData[tid] = await resolveIconData(typeMap[tid]);
  }));

  const bounds = [];

  for (const row of _rows) {
    const data = iconData[row.type_id] || await resolveIconData(null);
    const defaultIcon = makeLeafletIcon(data.url, data.w, data.h);
    // Якщо вмикнено «Підрозділ» і номер вдалося розпізнати з опису р/м —
    // використовуємо кольорове коло. Інакше fallback на стандартну SIDC.
    let icon = defaultIcon;
    let unitNum = null;
    if (_showUnit) {
      unitNum = extractUnitNumber(row.unit);
      if (unitNum) icon = makeUnitIcon(unitNum);
    }

    for (const mgrsStr of row.mgrs) {
      const ll = mgrsToLatLng(mgrsStr);
      if (!ll) continue;

      bounds.push(ll);
      const marker = L.marker(ll, { icon });

      // Підпис частоти (праворуч, постійний) — лише якщо чекбокс «Частоти» on.
      if (_showFreq && row.frequency) {
        marker.bindTooltip(String(row.frequency), {
          permanent: true,
          direction: "right",
          offset: [12, 0],
          className: "cm-freq-label",
        });
      }

      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        handleMarkerClick(row, mgrsStr, marker);
      });

      marker.addTo(_map);
      _allMarkers.push({ row, marker, mgrs: mgrsStr, typeId: row.type_id });
    }
  }

  if (!skipFit && bounds.length > 0) {
    _map.fitBounds(bounds, { padding: [48, 48], maxZoom: 14 });
  }
  renderTypeChips();
  updateCountBadge(_allMarkers.length);
}

function updateCountBadge(n) {
  const badge = document.getElementById("markerCount");
  badge.textContent = `${n} точок`;
  badge.classList.toggle("hidden", n === 0);
}

// ── Cluster picker ─────────────────────────────────────────────
// Якщо в радіусі CLUSTER_RADIUS_PX від клікнутого маркера є інші маркери —
// показуємо модалку «Оберіть необхідний об'єкт» замість того, щоб мовчки
// відкривати лише верхній (Leaflet піднімає останній доданий на клік).
const CLUSTER_RADIUS_PX = 16;

function findNearbyMarkers(target) {
  if (!_map || !_allMarkers.length) return [target];
  const targetPt = _map.latLngToContainerPoint(target.marker.getLatLng());
  const out = [];
  for (const m of _allMarkers) {
    if (!_map.hasLayer(m.marker)) continue;
    const p = _map.latLngToContainerPoint(m.marker.getLatLng());
    const dx = p.x - targetPt.x, dy = p.y - targetPt.y;
    if (Math.sqrt(dx * dx + dy * dy) <= CLUSTER_RADIUS_PX) out.push(m);
  }
  return out;
}

function handleMarkerClick(row, mgrsStr, marker) {
  const me = _allMarkers.find(m => m.marker === marker)
          || { row, marker, mgrs: mgrsStr, typeId: row.type_id };
  const nearby = findNearbyMarkers(me);
  if (nearby.length <= 1) {
    closeClusterPicker();
    openDetailPanel(row, mgrsStr);
    return;
  }
  openClusterPicker(nearby);
}

function openClusterPicker(items) {
  const root = document.getElementById("cmClusterPicker");
  const list = document.getElementById("cmClusterList");
  const count = document.getElementById("cmClusterCount");
  if (!root || !list || !count) return;
  count.textContent = String(items.length);

  list.innerHTML = "";
  const typeMap = {};
  for (const t of _types) typeMap[t.id] = t;

  for (const it of items) {
    const r = it.row;
    const type = typeMap[r.type_id] || { type: "невідомо", color: "#6b7280", icon_filename: "", icon_sidc: "" };

    const created = (r.created_at || "").replace("T", " ").slice(0, 16);
    const detected = (r.detected_at || r.received_at || "").replace("T", " ").slice(0, 16);
    const freq = [r.frequency, r.mask].filter(Boolean).join(" / ");
    const unit = r.unit || "";

    const item = document.createElement("div");
    item.className = "cm-cluster-item";

    const iconWrap = document.createElement("div");
    iconWrap.className = "cm-cluster-item__icon";
    const img = document.createElement("img");
    if (type.icon_sidc) {
      const info = getSidcIcon(type.icon_sidc);
      if (info) { img.src = info.url; img.width = 36; img.height = 36; }
      else { img.src = iconUrl(type.icon_filename); }
    } else {
      img.src = iconUrl(type.icon_filename);
    }
    iconWrap.appendChild(img);

    const body = document.createElement("div");
    body.className = "cm-cluster-item__body";
    const title = document.createElement("div");
    title.className = "cm-cluster-item__title";
    title.textContent = [freq, type.type].filter(Boolean).join(" / ") || "—";
    const sub = document.createElement("div");
    sub.className = "cm-cluster-item__sub";
    sub.textContent = unit || "—";
    const meta = document.createElement("div");
    meta.className = "cm-cluster-item__meta";
    meta.innerHTML =
      `<div><span class="cm-cluster-item__meta-label">Створення</span>${created || "—"}</div>` +
      `<div><span class="cm-cluster-item__meta-label">Виявлення</span>${detected || "—"}</div>`;
    body.appendChild(title);
    body.appendChild(sub);
    body.appendChild(meta);

    item.appendChild(iconWrap);
    item.appendChild(body);
    item.addEventListener("click", () => {
      closeClusterPicker();
      openDetailPanel(it.row, it.mgrs);
    });
    list.appendChild(item);
  }

  root.classList.remove("hidden");
}

function closeClusterPicker() {
  document.getElementById("cmClusterPicker")?.classList.add("hidden");
}

// Wire close handlers (backdrop + X button) once at load
document.addEventListener("click", (e) => {
  if (e.target.closest?.("[data-cm-cluster-close]")) closeClusterPicker();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeClusterPicker();
});

// ── Right detail panel ────────────────────────────────────────
function openDetailPanel(row, clickedMgrs) {
  const panel = document.getElementById("rightPanel");
  panel.classList.add("open");

  const typeInfo = _types.find(t => t.id === row.type_id) || { type: "невідомо", color: "#6b7280", icon_filename: "", icon_sidc: "" };

  // Badge — use milsymbol or SVG file
  const badge = document.getElementById("rpTypeBadge");
  badge.style.background = `${typeInfo.color}33`;
  badge.style.border = `1px solid ${typeInfo.color}88`;
  const badgeIcon = badge.querySelector(".rp-badge-icon");
  if (typeInfo.icon_sidc) {
    const info = getSidcIcon(typeInfo.icon_sidc);
    if (info) { badgeIcon.src = info.url; badgeIcon.width = 24; badgeIcon.height = 24; }
    else        badgeIcon.src = iconUrl(typeInfo.icon_filename);
  } else {
    badgeIcon.src = iconUrl(typeInfo.icon_filename);
  }
  badge.querySelector(".rp-badge-label").textContent = typeInfo.type;

  // Meta
  const dt = (row.created_at || "").replace("T", " ").slice(0, 16);
  const freq = [row.frequency, row.mask, row.unit].filter(Boolean).join(" / ");
  document.getElementById("rpMetaDate").textContent = dt;
  document.getElementById("rpMetaNet").textContent = freq || "—";

  document.getElementById("rpConclusionText").textContent = (row.conclusion_text || "").trim();

  const bodySection = document.getElementById("rpBodySection");
  const bodyText = (row.body_text || "").trim();
  if (bodyText) {
    bodySection.style.display = "";
    document.getElementById("rpBodyText").textContent = bodyText;
  } else {
    bodySection.style.display = "none";
  }

  const coordsDiv = document.getElementById("rpCoords");
  coordsDiv.innerHTML = "";
  for (const m of row.mgrs) {
    const tag = document.createElement("span");
    tag.className = "rp-coord-tag" + (m === clickedMgrs ? " active" : "");
    tag.textContent = m;
    tag.title = "Натисніть, щоб скопіювати";
    tag.addEventListener("click", () => {
      navigator.clipboard.writeText(m).then(() => {
        mapToast(`✓ Скопійовано: ${m}`);
      }).catch(() => {
        // Fallback for non-HTTPS or blocked clipboard
        const ta = document.createElement("textarea");
        ta.value = m;
        ta.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        mapToast(`✓ Скопійовано: ${m}`);
      });
    });
    coordsDiv.appendChild(tag);
  }

  // ── Дії панелі: селектор типу + видалення ──
  _panelRow = row;
  const typeSel = document.getElementById("rpTypeSelect");
  if (typeSel) {
    const items = [{ id: 0, type: "невідомо" }, ..._types.filter(t => t.id !== 0)];
    typeSel.innerHTML = items
      .map(t => `<option value="${t.id}"${t.id === (row.type_id || 0) ? " selected" : ""}>${_escMap(t.type || "невідомо")}</option>`)
      .join("");
    typeSel.onchange = () => changeConclusionType(row.id, parseInt(typeSel.value, 10) || 0);
  }
  const delBtn = document.getElementById("rpDeleteBtn");
  if (delBtn) delBtn.onclick = () => deleteConclusion(row.id);
  const editBtn = document.getElementById("rpEditBtn");
  if (editBtn) editBtn.onclick = () => startEditPanel();
  const saveBtn = document.getElementById("rpEditSaveBtn");
  if (saveBtn) saveBtn.onclick = () => saveEditPanel();
  const cancelBtn = document.getElementById("rpEditCancelBtn");
  if (cancelBtn) cancelBtn.onclick = () => setEditMode(false);

  setEditMode(false);   // завжди відкриваємо панель у режимі перегляду
  document.getElementById("rightHandle").style.display = "none";
}

/** Перемкнути панель між переглядом і правкою. */
function setEditMode(on) {
  const show = (id, v) => { const el = document.getElementById(id); if (el) el.style.display = v; };
  show("rpConclusionText", on ? "none" : "");
  show("rpEditText",       on ? "" : "none");
  show("rpEditCoordsWrap", on ? "" : "none");
  const coordsSection = document.getElementById("rpCoords");
  if (coordsSection && coordsSection.parentElement) {
    coordsSection.parentElement.style.display = on ? "none" : "";  // ховаємо секцію «Координати MGRS»
  }
  const editBtn = document.getElementById("rpEditBtn");
  if (editBtn) editBtn.style.display = on ? "none" : "";
}

/** Увійти в режим правки — заповнити поля з поточного висновку. */
function startEditPanel() {
  if (!_panelRow) return;
  const ta = document.getElementById("rpEditText");
  const ci = document.getElementById("rpEditCoords");
  if (ta) ta.value = (_panelRow.conclusion_text || "").trim();
  if (ci) ci.value = (_panelRow.mgrs || []).join(", ");
  setEditMode(true);
  if (ta) ta.focus();
}

/** Зберегти правку — PUT, оновити рядок, перемалювати маркери за потреби. */
async function saveEditPanel() {
  if (!_panelRow) return;
  const text = (document.getElementById("rpEditText").value || "").trim();
  if (!text) { mapToast("Висновок не може бути порожнім"); return; }
  const coordsRaw = (document.getElementById("rpEditCoords").value || "").trim();
  const mgrsIn = coordsRaw ? coordsRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

  const saveBtn = document.getElementById("rpEditSaveBtn");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "…"; }
  try {
    const res = await fetch(`/api/conclusions/${_panelRow.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conclusion_text: text, mgrs: mgrsIn }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { mapToast(data.error || data.detail || "Помилка збереження"); return; }

    const oldMgrs = (_panelRow.mgrs || []).join("|");
    _panelRow.conclusion_text = data.conclusion_text != null ? data.conclusion_text : text;
    if (Array.isArray(data.mgrs)) _panelRow.mgrs = data.mgrs;

    // Оновлюємо перегляд.
    document.getElementById("rpConclusionText").textContent = (_panelRow.conclusion_text || "").trim();
    setEditMode(false);

    // Якщо координати змінились — перемальовуємо маркери (зберігаючи фільтри).
    if ((_panelRow.mgrs || []).join("|") !== oldMgrs) {
      await placeMarkers({ skipFit: true });
      applyTypeFilter();
      // Оновити перелік координат у панелі.
      openDetailPanel(_panelRow, (_panelRow.mgrs || [])[0] || "");
    }
    mapToast("Висновок збережено");
  } catch (e) {
    mapToast("Помилка: " + (e && e.message ? e.message : e));
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Зберегти"; }
  }
}

function _escMap(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Оновити бейдж типу в панелі (без перемалювання карти). */
function refreshPanelBadge(row) {
  const typeInfo = _types.find(t => t.id === row.type_id)
    || { type: "невідомо", color: "#6b7280", icon_filename: "", icon_sidc: "" };
  const badge = document.getElementById("rpTypeBadge");
  badge.style.background = `${typeInfo.color}33`;
  badge.style.border = `1px solid ${typeInfo.color}88`;
  const badgeIcon = badge.querySelector(".rp-badge-icon");
  if (typeInfo.icon_sidc) {
    const info = getSidcIcon(typeInfo.icon_sidc);
    badgeIcon.src = info ? info.url : iconUrl(typeInfo.icon_filename);
  } else {
    badgeIcon.src = iconUrl(typeInfo.icon_filename);
  }
  badge.querySelector(".rp-badge-label").textContent = typeInfo.type;
}

/** Зміна типу висновку — оновлюємо ЛИШЕ маркери цього об'єкта (без redraw карти). */
async function changeConclusionType(acId, typeId) {
  try {
    const res = await fetch(`/api/conclusions/${acId}/type`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type_id: typeId }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) { mapToast(data.error || "Помилка зміни типу"); return; }

    const newTypeId = data.type_id;
    const typeMap = {}; for (const t of _types) typeMap[t.id] = t;
    const icd = await resolveIconData(typeMap[newTypeId] || null);
    for (const m of _allMarkers) {
      if (m.row.id !== acId) continue;
      m.row.type_id = newTypeId;
      m.typeId = newTypeId;
      let icon = makeLeafletIcon(icd.url, icd.w, icd.h);
      if (_showUnit) { const n = extractUnitNumber(m.row.unit); if (n) icon = makeUnitIcon(n); }
      m.marker.setIcon(icon);
    }
    if (_panelRow && _panelRow.id === acId) { _panelRow.type_id = newTypeId; refreshPanelBadge(_panelRow); }
    renderTypeChips();
    mapToast("Тип оновлено: " + (data.type_label || "невідомо"));
  } catch (e) { mapToast("Помилка: " + (e && e.message ? e.message : e)); }
}

/** Видалення висновку — прибираємо ЛИШЕ його маркери + закриваємо панель. */
async function deleteConclusion(acId) {
  if (!confirm("Видалити цей аналітичний висновок?")) return;
  try {
    const res = await fetch(`/api/conclusions/${acId}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.ok === false)) { mapToast((data && data.error) || "Помилка видалення"); return; }
    for (let i = _allMarkers.length - 1; i >= 0; i--) {
      if (_allMarkers[i].row.id === acId) {
        try { _allMarkers[i].marker.remove(); } catch (_) {}
        _allMarkers.splice(i, 1);
      }
    }
    closeRightPanel();
    renderTypeChips();
    updateCountBadge(_allMarkers.length);
    mapToast("Висновок видалено");
  } catch (e) { mapToast("Помилка: " + (e && e.message ? e.message : e)); }
}

function closeRightPanel() {
  const panel = document.getElementById("rightPanel");
  panel.classList.remove("open");
  document.getElementById("rightHandle").style.display = "";
}

// ── Top panel toggle ──────────────────────────────────────────
function initTopPanel() {
  const panel  = document.getElementById("topPanel");
  const handle = document.getElementById("topHandle");
  handle.addEventListener("click", () => panel.classList.toggle("open"));
  panel.classList.add("open");
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const overlay = document.getElementById("mapOverlay");
  overlay.textContent = "Завантаження карти…";

  initMap();
  initTopPanel();

  try {
    await Promise.all([loadTypes(), loadConclusions()]);
    await placeMarkers();
  } catch (err) {
    overlay.textContent = `Помилка: ${err.message}`;
    return;
  }

  // Чекбокси «Частоти» / «Підрозділ» — перемальовують маркери без повторного fetch.
  const freqChk = document.getElementById("cmShowFreqChk");
  if (freqChk) {
    freqChk.checked = false;
    _showFreq = false;
    freqChk.addEventListener("change", async () => {
      _showFreq = freqChk.checked;
      await placeMarkers({ skipFit: true });
      applyTypeFilter();   // зберегти активний фільтр категорій (не показувати приховані)
    });
  }
  const unitChk = document.getElementById("cmShowUnitChk");
  if (unitChk) {
    unitChk.checked = false;
    _showUnit = false;
    unitChk.addEventListener("change", async () => {
      _showUnit = unitChk.checked;
      await placeMarkers({ skipFit: true });
      applyTypeFilter();   // зберегти активний фільтр категорій (не показувати приховані)
    });
  }

  overlay.classList.add("hidden");
}

document.addEventListener("DOMContentLoaded", main);
