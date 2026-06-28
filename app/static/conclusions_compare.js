/**
 * conclusions_compare.js — модалка «Порівняння висновків».
 *
 * Порівнює аналітичні висновки двох груп — «Аналітика 63» та «Батальйони 63» —
 * за перехопленням, до якого вони зроблені (ключ: частота + дата/час).
 * Таблиця: Перехоплення | Аналітика 63 | Батальйони 63. Рядки кольоруються:
 *   match — координати збігаються (зелений), diff — відрізняються (червоний),
 *   only_one — висновок лише в одній групі (нейтральний).
 */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function pad2(n) { return String(n).padStart(2, "0"); }
  function localDatetimeString(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
           `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  /** "2026-06-12 20:34:12" → "12.06.2026 20:34:12" (best-effort, else as-is). */
  function fmtDt(s) {
    const v = String(s || "").replace("T", " ").trim();
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}:\d{2}(?::\d{2})?)/);
    return m ? `${m[3]}.${m[2]}.${m[1]} ${m[4]}` : v;
  }

  const MARKER_LABELS = { obtvr: "ОБТВР", "60ombr": "60 ОМБр" };

  /** Render one side's stacked conclusions into a table cell's innerHTML. */
  function renderConclusions(list, withMarker) {
    if (!list || !list.length) {
      return '<span class="cn-cmp-empty-cell">—</span>';
    }
    return list.map(function (c) {
      const marker = withMarker && c.source_marker
        ? `<div class="cn-cmp-marker">${escapeHtml(MARKER_LABELS[c.source_marker] || c.source_marker)}</div>`
        : "";
      const mgrs = (c.mgrs && c.mgrs.length)
        ? `<div class="cn-cmp-mgrs">${c.mgrs.map(escapeHtml).join("<br>")}</div>`
        : "";
      return `<div class="cn-cmp-concl">${marker}${escapeHtml(c.conclusion_text)}${mgrs}</div>`;
    }).join("");
  }

  function rowHtml(r) {
    const cls = r.category === "match" ? "cn-cmp-row--match"
              : r.category === "diff"  ? "cn-cmp-row--diff"
              : "";
    const txt = r.intercept_text || "";
    const cell = txt
      ? `<div class="cn-cmp-intercept-wrap">` +
          `<button type="button" class="cn-cmp-copy-btn" title="Копіювати перехоплення" data-intercept="${escapeHtml(txt)}">` +
            `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
              `<rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3 11V3a1 1 0 0 1 1-1h7"/></svg>` +
          `</button>` +
          `<div class="cn-cmp-intercept">${escapeHtml(txt)}</div>` +
        `</div>`
      : '<span class="cn-cmp-empty-cell">—</span>';
    return `<tr class="${cls}">` +
      `<td>${cell}</td>` +
      `<td>${renderConclusions(r.analytics, false)}</td>` +
      `<td>${renderConclusions(r.battalions, true)}</td>` +
      `</tr>`;
  }

  function setDisplay(el, on) { if (el) el.style.display = on ? "" : "none"; }

  function load() {
    const from = $("cnCmpFrom") ? $("cnCmpFrom").value : "";
    const to   = $("cnCmpTo")   ? $("cnCmpTo").value   : "";
    const loader = $("cnCmpLoader");
    const empty  = $("cnCmpEmpty");
    const table  = $("cnCmpTable");
    const body   = $("cnCmpBody");
    const count  = $("cnCmpCount");

    setDisplay(loader, true);
    setDisplay(empty, false);
    setDisplay(table, false);

    const qs = new URLSearchParams();
    if (from) qs.set("date_from", from);
    if (to)   qs.set("date_to", to);

    fetch("/api/conclusions/compare?" + qs.toString(), { headers: { Accept: "application/json" } })
      .then(function (resp) { return resp.json(); })
      .then(function (data) {
        setDisplay(loader, false);
        const rows = (data && data.rows) || [];
        if (count) count.textContent = String(rows.length);
        if (!rows.length) {
          setDisplay(empty, true);
          return;
        }
        body.innerHTML = rows.map(rowHtml).join("");
        setDisplay(table, true);
      })
      .catch(function (err) {
        setDisplay(loader, false);
        setDisplay(empty, true);
        if (empty) empty.textContent = "Помилка завантаження: " + err;
      });
  }

  function openModal() {
    const modal = $("cnCompareModal");
    if (!modal) return;
    // Defaults: from = now − 8h, to = now (only if fields are empty).
    const now = new Date();
    const from = new Date(now.getTime() - 8 * 3600 * 1000);
    if ($("cnCmpFrom") && !$("cnCmpFrom").value) $("cnCmpFrom").value = localDatetimeString(from);
    if ($("cnCmpTo")   && !$("cnCmpTo").value)   $("cnCmpTo").value   = localDatetimeString(now);
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    load();
  }

  function closeModal() {
    const modal = $("cnCompareModal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }

  function init() {
    const openBtn = $("cnOpenCompare");
    if (openBtn) openBtn.addEventListener("click", openModal);

    document.querySelectorAll("[data-cn-compare-close]").forEach(function (el) {
      el.addEventListener("click", closeModal);
    });

    const form = $("cnCompareFilter");
    if (form) form.addEventListener("submit", function (e) { e.preventDefault(); load(); });

    // Кнопка-іконка «Копіювати» в контейнері перехоплення (делеговано на tbody).
    const bodyEl = $("cnCmpBody");
    if (bodyEl) bodyEl.addEventListener("click", function (e) {
      const btn = e.target.closest(".cn-cmp-copy-btn");
      if (!btn) return;
      const text = btn.dataset.intercept || "";
      if (!text) return;
      const done = function (ok) {
        if (window.appToast) window.appToast(ok ? "Скопійовано" : "Помилка копіювання", ok ? "success" : "error", 1500);
      };
      if (window.clipboardWrite) window.clipboardWrite(text).then(done);
      else if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    });

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        const modal = $("cnCompareModal");
        if (modal && !modal.classList.contains("hidden")) closeModal();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
