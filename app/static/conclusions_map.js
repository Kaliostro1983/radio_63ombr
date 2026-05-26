/* ============================================================
   Fullscreen analytical-conclusions map  (v4 — milsymbol icons)
   ============================================================ */
"use strict";

// ── URL params ────────────────────────────────────────────────
const _params    = new URLSearchParams(location.search);
const _dateFrom  = _params.get("date_from") || "";
const _dateTo    = _params.get("date_to")   || "";
const _networkId = parseInt(_params.get("network_id") || "0", 10);

// ── State ─────────────────────────────────────────────────────
let _map = null;
let _types = [];            // [{id, type, color, icon_filename, icon_sidc, ...}]
let _rows  = [];            // all conclusions with MGRS
let _activeTypeIds = new Set(); // empty = show all
let _allHidden    = false;      // "Всі" toggle — true = all markers hidden
let _layerGroups = {};      // typeId → L.LayerGroup
let _allMarkers  = [];      // [{row, marker, typeId}]

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

function getSidcIcon(sidc) {
  if (!sidc || !window.ms) return null;
  if (_sidcCache[sidc]) return _sidcCache[sidc];
  try {
    const sym = new ms.Symbol(sidc, { size: 40 });
    const sz  = sym.getSize();
    const svg = sym.asSVG();
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url  = URL.createObjectURL(blob);
    const result = { url, w: Math.round(sz.width), h: Math.round(sz.height) };
    _sidcCache[sidc] = result;
    return result;
  } catch (_) {
    return null;
  }
}

// ── Build Leaflet DivIcon ─────────────────────────────────────
function makeLeafletIcon(imgUrl, w, h) {
  const sw = w || 36, sh = h || 36;
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
  return { url, w: 36, h: 36 };
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

  _map.on("click", () => closeRightPanel());
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
    if (!_allHidden) _activeTypeIds.clear();
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
  _allHidden = false;
  if (_activeTypeIds.has(typeId)) {
    _activeTypeIds.delete(typeId);
  } else {
    _activeTypeIds.add(typeId);
  }
  updateChipStates();
  applyTypeFilter();
}

function updateChipStates() {
  const allActive = _activeTypeIds.size === 0 && !_allHidden;
  document.querySelectorAll(".type-chip").forEach(chip => {
    const id = parseInt(chip.dataset.typeId, 10);
    chip.classList.toggle("active", !_allHidden && (allActive || _activeTypeIds.has(id)));
  });
  const allBtn = document.querySelector(".type-chip-all");
  if (allBtn) {
    allBtn.textContent      = _allHidden ? "Показати всі" : "Всі";
    allBtn.style.background = allActive ? "rgba(255,255,255,.12)" : "transparent";
  }
}

function applyTypeFilter() {
  let visible = 0;
  const showAll = _activeTypeIds.size === 0 && !_allHidden;
  for (const { marker, typeId } of _allMarkers) {
    const show = !_allHidden && (showAll || _activeTypeIds.has(typeId));
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
  if (_dateFrom)  qs.set("date_from",  _dateFrom);
  if (_dateTo)    qs.set("date_to",    _dateTo);
  if (_networkId) qs.set("network_id", _networkId);

  const resp = await fetch(`/api/conclusions?${qs}`);
  const data = await resp.json();
  _rows = (data.rows || []).filter(r => r.mgrs && r.mgrs.length > 0);
}

// ── Place markers on the map ──────────────────────────────────
async function placeMarkers() {
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
    const leafIcon = makeLeafletIcon(data.url, data.w, data.h);

    for (const mgrsStr of row.mgrs) {
      const ll = mgrsToLatLng(mgrsStr);
      if (!ll) continue;

      bounds.push(ll);
      const marker = L.marker(ll, { icon: leafIcon });

      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        openDetailPanel(row, mgrsStr);
      });

      marker.addTo(_map);
      _allMarkers.push({ row, marker, typeId: row.type_id });
    }
  }

  if (bounds.length > 0) {
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
    coordsDiv.appendChild(tag);
  }

  document.getElementById("rightHandle").style.display = "none";
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

  overlay.classList.add("hidden");
}

document.addEventListener("DOMContentLoaded", main);
