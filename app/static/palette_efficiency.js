/**
 * Ефективність палітр — модалка на сторінці «Висновки».
 * Для кожної палітри показує, скільки аналітичних висновків за останні N днів
 * (за замовч. 90) геометрично потрапили в її регіони. Рахунок — на клієнті
 * (на сервері конвертера MGRS немає), як і в панелі палітр редактора висновку.
 */
(function () {
  "use strict";

  const DAYS = 90;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* MGRS-рядок → {lat, lon} (через window.mgrs) */
  function mgrsToLatLon(code) {
    if (typeof window.mgrs === "undefined" || !window.mgrs.toPoint) return null;
    try {
      const pt = window.mgrs.toPoint(String(code).replace(/\s+/g, "").toUpperCase());
      const lat = Number(pt[1]), lon = Number(pt[0]);
      if (isFinite(lat) && isFinite(lon)) return { lat, lon };
    } catch (_) {}
    return null;
  }

  /* WKT POLYGON → зовнішнє кільце [[lat,lon],...] (null, якщо не розпарсилось) */
  function parseWktPolygon(wkt) {
    const m = String(wkt || "").match(/POLYGON\s*\(\s*\(\s*([^)]+?)\s*\)/i);
    if (!m) return null;
    const ring = m[1].split(",").map((pair) => {
      const xy = pair.trim().split(/\s+/);
      const lon = parseFloat(xy[0]), lat = parseFloat(xy[1]);
      return (isFinite(lat) && isFinite(lon)) ? [lat, lon] : null;
    }).filter(Boolean);
    return ring.length >= 3 ? ring : null;
  }

  /* Ray-casting: чи точка (lat,lon) всередині кільця */
  function pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* Скільки висновкових груп (уже у вигляді [{lat,lon}]) мають ≥1 точку
   * всередині регіонів палітри. Координати конвертуються з MGRS один раз
   * заздалегідь (groupPts), тож тут лише дешевий point-in-ring. */
  function palConclCount(regionWkts, groupPts) {
    const rings = (regionWkts || []).map(parseWktPolygon).filter(Boolean);
    if (!rings.length || !groupPts || !groupPts.length) return 0;
    let n = 0;
    for (const pts of groupPts) {
      if (pts.some((ll) => rings.some((r) => pointInRing(ll.lat, ll.lon, r)))) n++;
    }
    return n;
  }

  function heatClass(n) {
    if (n <= 0) return "pe-cnt--zero";
    if (n <= 10) return "pe-cnt--low";
    return "pe-cnt--high";
  }

  const modal = document.getElementById("cnPaletteEffModal");
  const body = document.getElementById("cnPaletteEffBody");
  const openBtn = document.getElementById("cnOpenPaletteEff");
  if (!modal || !body || !openBtn) return;

  function show() {
    modal.classList.remove("hidden");
    modal.removeAttribute("aria-hidden");
    if (window.__modalToFront) window.__modalToFront(modal);
  }
  function hide() {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }

  async function load() {
    body.innerHTML = `<div class="pe-empty">Завантаження…</div>`;
    let data;
    try {
      const r = await fetch(`/api/palettes/efficiency?days=${DAYS}`);
      data = await r.json();
    } catch (_) {
      body.innerHTML = `<div class="pe-empty">Помилка завантаження.</div>`;
      return;
    }
    if (!data || !data.ok) {
      body.innerHTML = `<div class="pe-empty">Помилка завантаження.</div>`;
      return;
    }
    if (typeof window.mgrs === "undefined") {
      body.innerHTML = `<div class="pe-empty">Бібліотека MGRS не завантажилась. Оновіть сторінку.</div>`;
      return;
    }
    const groups = data.conclusion_groups || [];
    // Конвертуємо MGRS кожного висновку в lat/lon ОДИН раз (а не на кожну палітру).
    const groupPts = groups.map((codes) => (codes || []).map(mgrsToLatLon).filter(Boolean));
    const rows = (data.palettes || []).map((p) => ({
      name: p.name || "",
      units: (p.units || []).join(", "),
      count: palConclCount(p.regions, groupPts),
    }));
    rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const totalConcl = groups.length;
    if (!rows.length) {
      body.innerHTML = `<div class="pe-empty">Палітр немає.</div>`;
      return;
    }
    const trs = rows.map((r, i) => `
      <tr>
        <td class="pe-idx">${i + 1}</td>
        <td class="pe-name">${esc(r.name)}</td>
        <td class="pe-units">${esc(r.units) || "—"}</td>
        <td class="pe-cnt-cell"><span class="pe-cnt ${heatClass(r.count)}">${r.count}</span></td>
      </tr>`).join("");
    body.innerHTML = `
      <div class="pe-sub small">Висновків за ${data.days || DAYS} днів усього: <b>${totalConcl}</b> ·
        рахунок — скільки з них геометрично потрапили в регіони палітри.</div>
      <table class="table pe-table">
        <thead>
          <tr>
            <th style="width:44px">#</th>
            <th>Палітра</th>
            <th style="width:160px">Підрозділи</th>
            <th style="width:90px; text-align:center">Висновків</th>
          </tr>
        </thead>
        <tbody>${trs}</tbody>
      </table>`;
  }

  openBtn.addEventListener("click", () => { show(); load(); });
  modal.querySelectorAll("[data-cn-pe-close]").forEach((el) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); hide(); });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) hide();
  });
})();
