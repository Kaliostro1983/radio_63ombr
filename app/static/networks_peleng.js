(function () {
  function $(id) { return document.getElementById(id); }

  const root = $("netPelengGraph");
  if (!root) return;

  const networkId = Number(root.getAttribute("data-network-id") || 0);
  const daysInput = $("netPelengDays");
  const btn = $("netPelengShow");
  const out = $("netPelengOut");
  const mapStyleSelect = $("netPelengMapStyle");
  if (!networkId || !daysInput || !btn || !out) return;

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderEmpty(msg) {
    out.innerHTML = `<div class="small" style="opacity:.85">${escapeHtml(msg)}</div>`;
  }

  function mgrsToLatLon(mgrsStr) {
    // Uses external `mgrs` library from unpkg (global `window.mgrs`).
    // Expected input like: "37U DQ 32966 26558"
    // Library accepts: "37UDQ3296626558" (spaces removed).
    if (!window.mgrs || typeof window.mgrs.toPoint !== "function") return null;
    const raw = String(mgrsStr || "").trim().replace(/\s+/g, "").toUpperCase();
    if (!raw) return null;
    try {
      const p = window.mgrs.toPoint(raw);
      if (!Array.isArray(p) || p.length < 2) return null;
      const lon = Number(p[0]);
      const lat = Number(p[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { lat, lon };
    } catch {
      return null;
    }
  }

  function parseMgrsForPlot(mgrs) {
    // Input example: "37U DQ 32966 26558"
    // We do a "best-effort" parse and convert to pseudo-Cartesian coordinates
    // based on the 100km grid letters + 5-digit easting/northing.
    //
    // This is not a high-precision lat/lon conversion; it is enough to render
    // a "map-like" distribution of points in the UI.
    const s = String(mgrs || "").trim().replace(/\s+/g, " ").toUpperCase();
    // Allow missing spaces between grid letters and numeric parts.
    const re = /^(\d{1,2})([C-X])\s+([A-Z]{2})\s*([0-9]{5})\s*([0-9]{5})$/;
    const m = s.match(re);
    if (!m) return null;

    const zone = Number(m[1]); // 1..60
    const band = m[2]; // C..X
    const grid2 = m[3]; // 2 letters
    const easting5 = Number(m[4]);
    const northing5 = Number(m[5]);

    const letterSet = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I, O
    const col = letterSet.indexOf(grid2[0]);
    const row = letterSet.indexOf(grid2[1]);
    if (col < 0 || row < 0) return null;

    const e = easting5 * 10; // meters within 100km square
    const n = northing5 * 10;

    // Add band/zone offsets so different areas don't collapse into one cluster.
    const bandOrder = "CDEFGHJKLMNPQRSTUVWX"; // length 20
    const bandIdx = Math.max(0, bandOrder.indexOf(band));
    const zoneIdx = Math.max(0, zone);

    const x = col * 100000 + e + (zoneIdx % 10) * 1000000;
    const y = row * 100000 + n + bandIdx * 500000;
    return { x, y, zone, band, grid2, easting5, northing5 };
  }

  function createSvgEl(tag) {
    return document.createElementNS("http://www.w3.org/2000/svg", tag);
  }

  function renderSvgFallback(data) {
    // --- Existing SVG fallback (map-like grid) ---
    out.innerHTML = "";
    const batches = Array.isArray(data.batches) ? data.batches : [];
    const pointsTotal = Number(data?.meta?.points_total || 0);

    if (!batches.length) {
      renderEmpty("Пеленги за період не знайдено.");
      return;
    }

    const allPoints = [];
    for (const b of batches) {
      const pts = Array.isArray(b.points) ? b.points : [];
      for (const mgrs of pts) {
        const plot = parseMgrsForPlot(mgrs);
        if (!plot) continue;
        allPoints.push({
          mgrs,
          batchId: b.id,
          eventDt: b.event_dt || "",
          plot,
        });
      }
    }

    if (!allPoints.length) {
      renderEmpty("Пеленги знайдено, але не вдалося розпізнати MGRS координати для побудови карти.");
      return;
    }

    const viewW = 1000;
    const viewH = 620;
    const pad = 28;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of allPoints) {
      minX = Math.min(minX, p.plot.x);
      maxX = Math.max(maxX, p.plot.x);
      minY = Math.min(minY, p.plot.y);
      maxY = Math.max(maxY, p.plot.y);
    }

    const spanX = Math.max(1, maxX - minX);
    const spanY = Math.max(1, maxY - minY);

    const scaleX = (viewW - pad * 2) / spanX;
    const scaleY = (viewH - pad * 2) / spanY;

    const palette = ["#ef4444", "#f97316", "#22c55e", "#60a5fa", "#a78bfa", "#f472b6"];
    const getColor = (batchId) => palette[Math.abs(Number(batchId) || 0) % palette.length];

    const wrapper = document.createElement("div");
    wrapper.className = "peleng-map-wrap";

    const header = document.createElement("div");
    header.className = "small";
    header.style.opacity = ".92";
    header.style.marginBottom = "10px";
    header.innerHTML = `Точок: <b>${escapeHtml(pointsTotal)}</b>, на карті показано: <b>${escapeHtml(allPoints.length)}</b>`;

    const svg = createSvgEl("svg");
    svg.setAttribute("class", "peleng-map-svg");
    svg.setAttribute("viewBox", `0 0 ${viewW} ${viewH}`);

    const bg = createSvgEl("rect");
    bg.setAttribute("x", "0");
    bg.setAttribute("y", "0");
    bg.setAttribute("width", String(viewW));
    bg.setAttribute("height", String(viewH));
    bg.setAttribute("fill", "rgba(255,255,255,0.015)");
    svg.appendChild(bg);

    const gridStep = 100;
    const grid = createSvgEl("g");
    grid.setAttribute("opacity", "0.55");
    for (let x = pad; x <= viewW - pad; x += gridStep) {
      const l = createSvgEl("line");
      l.setAttribute("x1", String(x));
      l.setAttribute("y1", String(pad));
      l.setAttribute("x2", String(x));
      l.setAttribute("y2", String(viewH - pad));
      l.setAttribute("stroke", "rgba(255,255,255,0.12)");
      l.setAttribute("stroke-width", "1");
      grid.appendChild(l);
    }
    for (let y = pad; y <= viewH - pad; y += gridStep) {
      const l = createSvgEl("line");
      l.setAttribute("x1", String(pad));
      l.setAttribute("y1", String(y));
      l.setAttribute("x2", String(viewW - pad));
      l.setAttribute("y2", String(y));
      l.setAttribute("stroke", "rgba(255,255,255,0.12)");
      l.setAttribute("stroke-width", "1");
      grid.appendChild(l);
    }
    svg.appendChild(grid);

    const plotGroup = createSvgEl("g");
    svg.appendChild(plotGroup);

    for (const p of allPoints) {
      const sx = pad + (p.plot.x - minX) * scaleX;
      const sy = pad + (p.plot.y - minY) * scaleY;
      const circle = createSvgEl("circle");
      circle.setAttribute("cx", String(sx));
      circle.setAttribute("cy", String(sy));
      circle.setAttribute("r", "6.6");
      circle.setAttribute("fill", getColor(p.batchId));
      circle.setAttribute("fill-opacity", "0.95");
      circle.setAttribute("stroke", "rgba(255,255,255,0.38)");
      circle.setAttribute("stroke-width", "2.0");

      const title = createSvgEl("title");
      title.textContent = `${p.mgrs}\n${p.eventDt ? "batch: " + p.eventDt : ""}`;
      circle.appendChild(title);

      plotGroup.appendChild(circle);
    }

    const frame = createSvgEl("rect");
    frame.setAttribute("x", String(pad));
    frame.setAttribute("y", String(pad));
    frame.setAttribute("width", String(viewW - pad * 2));
    frame.setAttribute("height", String(viewH - pad * 2));
    frame.setAttribute("fill", "none");
    frame.setAttribute("stroke", "rgba(255,255,255,0.16)");
    frame.setAttribute("stroke-width", "1.2");
    svg.appendChild(frame);

    // Pan/Zoom for fallback.
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    function applyTransform() {
      plotGroup.setAttribute("transform", `translate(${tx} ${ty}) scale(${scale})`);
    }

    applyTransform();

    function clientToSvg(clientX, clientY) {
      const r = svg.getBoundingClientRect();
      const x = ((clientX - r.left) / r.width) * viewW;
      const y = ((clientY - r.top) / r.height) * viewH;
      return { x, y };
    }

    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const { x: px, y: py } = clientToSvg(e.clientX, e.clientY);
      const prevScale = scale;
      const zoom = e.deltaY < 0 ? 1.12 : 0.89;
      scale = Math.min(8, Math.max(0.35, scale * zoom));
      const k = scale / prevScale;
      tx = (tx - px) * k + px;
      ty = (ty - py) * k + py;
      applyTransform();
    }, { passive: false });

    svg.addEventListener("pointerdown", (e) => {
      dragging = true;
      svg.setPointerCapture(e.pointerId);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    svg.addEventListener("pointerup", () => { dragging = false; });
    svg.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const r = svg.getBoundingClientRect();
      const dxSvg = dx * (viewW / r.width);
      const dySvg = dy * (viewH / r.height);
      tx += dxSvg;
      ty += dySvg;
      applyTransform();
    });

    const note = document.createElement("div");
    note.className = "small";
    note.style.opacity = ".78";
    note.style.marginTop = "10px";
    note.innerHTML = `Порада: колесом можна збільшувати, перетягуванням переміщати.`;

    wrapper.appendChild(header);
    wrapper.appendChild(svg);
    wrapper.appendChild(note);

    out.appendChild(wrapper);
  }

  function renderLeafletMap(data) {
    out.innerHTML = "";
    const batches = Array.isArray(data.batches) ? data.batches : [];
    const pointsTotal = Number(data?.meta?.points_total || 0);
    if (!batches.length) {
      renderEmpty("Пеленги за період не знайдено.");
      return;
    }

    if (!window.L) {
      renderSvgFallback(data);
      return;
    }

    // Build geo points from MGRS.
    const geoPoints = [];
    const palette = ["#ef4444", "#f97316", "#22c55e", "#60a5fa", "#a78bfa", "#f472b6"];
    const getColor = (batchId) => palette[Math.abs(Number(batchId) || 0) % palette.length];

    for (const b of batches) {
      const pts = Array.isArray(b.points) ? b.points : [];
      for (const mgrsStr of pts) {
        const ll = mgrsToLatLon(mgrsStr);
        if (!ll) continue;
        geoPoints.push({
          lat: ll.lat,
          lon: ll.lon,
          mgrs: mgrsStr,
          batchId: b.id,
          eventDt: b.event_dt || "",
          color: getColor(b.id),
        });
      }
    }

    if (!geoPoints.length) {
      renderSvgFallback(data);
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "peleng-map-wrap";

    const header = document.createElement("div");
    header.className = "small";
    header.style.opacity = ".92";
    header.style.marginBottom = "10px";
    header.innerHTML = `Точок: <b>${escapeHtml(pointsTotal)}</b>, на карті показано: <b>${escapeHtml(geoPoints.length)}</b>`;
    wrapper.appendChild(header);

    const mapDiv = document.createElement("div");
    mapDiv.className = "peleng-leaflet";
    // Leaflet requires explicit size.
    mapDiv.style.height = "420px";
    mapDiv.style.width = "100%";
    wrapper.appendChild(mapDiv);

    out.appendChild(wrapper);

    // Init leaflet map.
    const map = window.L.map(mapDiv).setView([geoPoints[0].lat, geoPoints[0].lon], 6);

    const style = (mapStyleSelect?.value || "satellite").toString();
    if (style === "osm") {
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);
    } else {
      // Esri World Imagery (satellite).
      window.L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri',
      }).addTo(map);
    }

    const bounds = window.L.latLngBounds([]);
    geoPoints.forEach((p) => {
      const ll = window.L.latLng(p.lat, p.lon);
      bounds.extend(ll);

      const cm = window.L.circleMarker(ll, {
        radius: 5,
        color: "rgba(255,255,255,0.75)",
        weight: 1.5,
        fillColor: p.color,
        fillOpacity: 0.85,
      });
      cm.addTo(map);
      cm.bindTooltip(`${escapeHtml(p.mgrs)}${p.eventDt ? `<br/>${escapeHtml(p.eventDt)}` : ""}`, {
        direction: "top",
        sticky: true,
      });
    });

    if (geoPoints.length > 1) map.fitBounds(bounds.pad(0.2));

    // --- Coordinates table (below the map) ---
    const tableMax = 120;
    const shown = geoPoints.slice(0, tableMax);

    const tableNote = document.createElement("div");
    tableNote.className = "small peleng-map-hint";
    const totalStr = `Усього в періоді: ${escapeHtml(pointsTotal)}.`;
    const shownStr = shown.length < geoPoints.length
      ? `У таблиці показано: ${escapeHtml(shown.length)} (решта прихована для швидкості).`
      : `У таблиці показано: ${escapeHtml(shown.length)}.`;
    tableNote.innerHTML = `${totalStr} ${shownStr}`;
    wrapper.appendChild(tableNote);

    const table = document.createElement("table");
    table.className = "table peleng-coords-table";
    table.style.marginTop = "10px";

    table.innerHTML = `
      <thead>
        <tr>
          <th>#</th>
          <th>MGRS</th>
          <th>Lat</th>
          <th>Lon</th>
          <th>Batch</th>
          <th>DT</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector("tbody");
    for (let i = 0; i < shown.length; i++) {
      const p = shown[i];
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${escapeHtml(p.mgrs)}</td>
        <td>${Number(p.lat).toFixed(6)}</td>
        <td>${Number(p.lon).toFixed(6)}</td>
        <td>${escapeHtml(String(p.batchId))}</td>
        <td>${escapeHtml(String(p.eventDt || ""))}</td>
      `;
      tbody.appendChild(tr);
    }
    wrapper.appendChild(table);
  }

  function renderPelengMap(data) {
    // Prefer real geographic map via Leaflet.
    // If conversion/parsing or external libs fail - fall back to SVG grid.
    if (window.L && window.mgrs) {
      renderLeafletMap(data);
    } else {
      renderSvgFallback(data);
    }
  }

  async function load() {
    const days = Math.max(1, Math.min(365, Number(daysInput.value || 7)));
    daysInput.value = String(days);
    out.innerHTML = `<div class="small" style="opacity:.85">Завантаження пеленгів…</div>`;

    try {
      const resp = await fetch(`/api/networks/${encodeURIComponent(networkId)}/peleng?days=${encodeURIComponent(days)}`, {
        headers: { Accept: "application/json" },
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        renderEmpty(data?.error || "Не вдалося завантажити пеленги.");
        return;
      }
      renderPelengMap(data);
    } catch (e) {
      renderEmpty("Помилка завантаження пеленгів.");
    }
  }

  btn.addEventListener("click", load);
})();

