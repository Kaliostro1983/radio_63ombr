/* ============================================================
   Fullscreen analytical-conclusions map
   ============================================================ */
"use strict";

// ── URL params ────────────────────────────────────────────────
const _params    = new URLSearchParams(location.search);
const _dateFrom  = _params.get("date_from") || "";
const _dateTo    = _params.get("date_to")   || "";
const _networkId = parseInt(_params.get("network_id") || "0", 10);

// ── State ─────────────────────────────────────────────────────
let _map = null;
let _types = [];            // [{id, type, color, icon_filename, ...}]
let _rows  = [];            // all conclusions with MGRS
let _activeTypeIds = new Set(); // empty = show all
let _layerGroups = {};      // typeId → L.LayerGroup
let _allMarkers  = [];      // [{row, marker, typeId}]

// ── MGRS helper (uses window.mgrs if loaded, else stub) ───────
function mgrsToLatLng(mgrsStr) {
  try {
    if (window.mgrs && window.mgrs.toPoint) {
      const pt = window.mgrs.toPoint(mgrsStr.trim());
      // toPoint returns [lon, lat]
      return [pt[1], pt[0]];
    }
  } catch (_) {}
  return null;
}

// ── Icon URL builder ──────────────────────────────────────────
function iconUrl(filename) {
  if (filename) return `/static/icons/${filename}`;
  return `/static/icons/default.svg`;
}

// Replace FILL placeholder in SVG with the type color
async function buildColoredIconUrl(filename, color) {
  const url = iconUrl(filename);
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("fetch failed");
    let svg = await resp.text();
    svg = svg.replace(/FILL/g, encodeURIComponent(color));
    // re-encode back for use as data URI
    svg = svg.replace(/%23/g, "#"); // undo any double-encoding
    const blob = new Blob([svg.replace(/FILL/g, color)], { type: "image/svg+xml" });
    return URL.createObjectURL(blob);
  } catch (_) {
    return url;
  }
}

// Cache of colored icon blob URLs: key = `${filename}::${color}`
const _iconCache = {};

async function getIconUrl(filename, color) {
  const key = `${filename || ""}::${color || "#6b7280"}`;
  if (_iconCache[key]) return _iconCache[key];

  const effectiveFile = filename || "default.svg";
  const url = `/static/icons/${effectiveFile}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error();
    let svg = await resp.text();
    svg = svg.replace(/FILL/g, color || "#6b7280");
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const blobUrl = URL.createObjectURL(blob);
    _iconCache[key] = blobUrl;
    return blobUrl;
  } catch (_) {
    _iconCache[key] = url; // fallback to raw file
    return url;
  }
}

// ── Build Leaflet DivIcon ─────────────────────────────────────
function makeLeafletIcon(imgUrl) {
  return L.divIcon({
    className: "cm-icon",
    html: `<img src="${imgUrl}" alt="">`,
    iconSize:   [36, 36],
    iconAnchor: [18, 18],
    popupAnchor:[0, -20],
  });
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

  // Click on map closes right panel
  _map.on("click", () => closeRightPanel());
}

// ── Load types ────────────────────────────────────────────────
async function loadTypes() {
  const resp = await fetch("/api/conclusions/types");
  const data = await resp.json();
  _types = data.rows || [];

  // Build layer groups
  for (const t of _types) {
    const lg = L.layerGroup().addTo(_map);
    _layerGroups[t.id] = lg;
  }
  // Also a group for type 0 (невідомо) in case not listed
  if (!_layerGroups[0]) {
    _layerGroups[0] = L.layerGroup().addTo(_map);
  }

  renderTypeChips();
}

// ── Render type filter chips ──────────────────────────────────
function renderTypeChips() {
  const container = document.getElementById("chipContainer");
  container.innerHTML = "";

  // "Всі" button
  const allBtn = document.createElement("button");
  allBtn.className = "type-chip-all";
  allBtn.textContent = "Всі";
  allBtn.addEventListener("click", () => {
    _activeTypeIds.clear();
    updateChipStates();
    applyTypeFilter();
  });
  container.appendChild(allBtn);

  const divider = document.createElement("span");
  divider.className = "chip-divider";
  container.appendChild(divider);

  for (const t of _types) {
    const chip = document.createElement("div");
    chip.className = "type-chip";
    chip.dataset.typeId = t.id;
    chip.style.setProperty("--chip-color", t.color || "#6b7280");
    chip.style.background = `${t.color || "#6b7280"}33`;

    // Icon img (load async, set src later)
    const img = document.createElement("img");
    img.width = 18; img.height = 18;
    getIconUrl(t.icon_filename, t.color || "#6b7280").then(u => img.src = u);
    chip.appendChild(img);

    const label = document.createElement("span");
    label.textContent = t.type;
    chip.appendChild(label);

    chip.addEventListener("click", () => toggleTypeChip(t.id));
    container.appendChild(chip);
  }

  updateChipStates();
}

function toggleTypeChip(typeId) {
  if (_activeTypeIds.has(typeId)) {
    _activeTypeIds.delete(typeId);
    if (_activeTypeIds.size === 0) {
      // nothing selected = show all (same as clicking "Всі")
    }
  } else {
    _activeTypeIds.add(typeId);
  }
  updateChipStates();
  applyTypeFilter();
}

function updateChipStates() {
  const allActive = _activeTypeIds.size === 0;
  document.querySelectorAll(".type-chip").forEach(chip => {
    const id = parseInt(chip.dataset.typeId, 10);
    chip.classList.toggle("active", allActive || _activeTypeIds.has(id));
  });
  // "Всі" button always visible, highlight when nothing selected
  const allBtn = document.querySelector(".type-chip-all");
  if (allBtn) {
    allBtn.style.background = allActive ? "rgba(255,255,255,.12)" : "transparent";
  }
}

function applyTypeFilter() {
  let visible = 0;
  const showAll = _activeTypeIds.size === 0;
  for (const { row, marker, typeId } of _allMarkers) {
    const show = showAll || _activeTypeIds.has(typeId);
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

  // Batch: resolve all icon URLs first
  const typeMap = {};
  for (const t of _types) typeMap[t.id] = t;

  const iconUrls = {};
  const uniqueTypeIds = [...new Set(_rows.map(r => r.type_id))];
  await Promise.all(uniqueTypeIds.map(async tid => {
    const t = typeMap[tid] || { color: "#6b7280", icon_filename: "" };
    iconUrls[tid] = await getIconUrl(t.icon_filename, t.color);
  }));

  const bounds = [];

  for (const row of _rows) {
    const iconBlobUrl = iconUrls[row.type_id] || await getIconUrl("", "#6b7280");
    const leafIcon = makeLeafletIcon(iconBlobUrl);

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

  const typeInfo = _types.find(t => t.id === row.type_id) || { type: "невідомо", color: "#6b7280", icon_filename: "" };

  // Badge
  const badge = document.getElementById("rpTypeBadge");
  badge.style.background = `${typeInfo.color}33`;
  badge.style.borderColor = `${typeInfo.color}88`;
  badge.style.border = `1px solid`;
  badge.querySelector(".rp-badge-icon").src = iconUrl(typeInfo.icon_filename);
  badge.querySelector(".rp-badge-label").textContent = typeInfo.type;

  // Meta
  const dt = (row.created_at || "").replace("T", " ").slice(0, 16);
  const freq = [row.frequency, row.mask, row.unit].filter(Boolean).join(" / ");
  document.getElementById("rpMetaDate").textContent = dt;
  document.getElementById("rpMetaNet").textContent = freq || "—";

  // Conclusion text
  document.getElementById("rpConclusionText").textContent = (row.conclusion_text || "").trim();

  // Body text
  const bodySection = document.getElementById("rpBodySection");
  const bodyText = (row.body_text || "").trim();
  if (bodyText) {
    bodySection.style.display = "";
    document.getElementById("rpBodyText").textContent = bodyText;
  } else {
    bodySection.style.display = "none";
  }

  // MGRS coords
  const coordsDiv = document.getElementById("rpCoords");
  coordsDiv.innerHTML = "";
  for (const m of row.mgrs) {
    const tag = document.createElement("span");
    tag.className = "rp-coord-tag" + (m === clickedMgrs ? " active" : "");
    tag.textContent = m;
    coordsDiv.appendChild(tag);
  }

  // Hide right handle when panel is open
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
  // Open by default
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
