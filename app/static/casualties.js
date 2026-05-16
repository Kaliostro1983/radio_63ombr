/* casualties.js – v8
 * Interactive casualties table for the home page "Втрати" tab.
 * v8: entries are undated (no date param in API); date used only for report
 *     header and snapshot. Polling syncs undated working values.
 */

(function () {
  "use strict";

  // ── State ─────────────────────────────────────────────────────────────────
  let units       = [];   // [{id, name, sort_order}]
  let entries     = {};   // {"irr_<id>": {morning, night}, "san_<id>": {...}}
  let reportDate  = localStorage.getItem("cas_date") || todayISO(); // used for image header + snapshot only
  let saveTimers  = {};
  let compactMode = null; // null | "morning" | "night"

  // ── Auto-sync ─────────────────────────────────────────────────────────────
  const POLL_MS = 30_000;
  let _pollTimer = null;

  function startPolling() {
    stopPolling();
    _pollTimer = setInterval(pollSync, POLL_MS);
  }
  function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }
  async function pollSync() {
    if (document.hidden) return;
    if (Object.keys(saveTimers).length > 0) return;
    if (document.activeElement?.classList.contains("cas-input")) return;
    await loadEntries();
    render();
  }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const pane      = document.getElementById("homePaneCasualties");
  if (!pane) return;

  const dateInput  = document.getElementById("casDate");
  const tbody      = document.getElementById("casTbody");
  const tableWrap  = document.getElementById("casTableWrap");
  const showAllBtn = document.getElementById("casShowAll");

  // ── Init ──────────────────────────────────────────────────────────────────
  let _inited = false;
  async function init() {
    if (_inited) return;
    _inited = true;
    if (dateInput) dateInput.value = reportDate;
    await loadUnits();
    await loadEntries();
    render();
    startPolling();
  }

  document.getElementById("homeTabCasualties")?.addEventListener("click", init);
  if (!pane.classList.contains("hidden")) init();

  // ── API helpers ───────────────────────────────────────────────────────────
  async function apiFetch(url, opts) {
    const res = await fetch(url, opts);
    return res.json().catch(() => ({}));
  }

  async function loadUnits() {
    const d = await apiFetch("/api/cas/units");
    if (d.ok) units = d.units;
  }

  async function loadEntries() {
    // Entries are not date-keyed — always fetch the current working state
    const d = await apiFetch("/api/cas/entries");
    if (d.ok) entries = d.entries;
  }

  function getEntry(cat, uid) {
    return entries[`${cat}_${uid}`] || { morning: 0, night: 0 };
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    if (!tbody) return;
    tbody.innerHTML = "";

    tableWrap.classList.toggle("cas-ss-active",  compactMode !== null);
    tableWrap.classList.toggle("cas-ss-morning", compactMode === "morning");
    tableWrap.classList.toggle("cas-ss-night",   compactMode === "night");
    if (showAllBtn) showAllBtn.style.display = compactMode ? "" : "none";

    if (units.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="5" class="cas-empty">Підрозділів немає — натисніть «+ Підрозділ».</td>`;
      tbody.appendChild(tr);
      return;
    }

    renderSection("irr", "Безповоротні");
    renderSection("san", "Санітарні");
  }

  function renderSection(cat, label) {
    const hdrTr = document.createElement("tr");
    hdrTr.className = "cas-section-hdr";
    hdrTr.dataset.cat = cat;
    hdrTr.innerHTML = `<td colspan="5">${label}</td>`;
    tbody.appendChild(hdrTr);

    units.forEach((unit, idx) => {
      const entry   = getEntry(cat, unit.id);
      const morning = entry.morning || 0;
      const night   = entry.night   || 0;
      const total   = morning + night;

      const tr = document.createElement("tr");
      tr.className = "cas-row";
      tr.dataset.unitId   = unit.id;
      tr.dataset.category = cat;

      if (compactMode === "morning" && !morning) tr.classList.add("cas-ss-hide");
      if (compactMode === "night"   && !total)   tr.classList.add("cas-ss-hide");

      tr.innerHTML = `
        <td class="cas-col-name">${escHtml(unit.name)}</td>
        <td class="cas-col-morning">
          <input type="number" min="0" class="cas-input" value="${morning || ""}" placeholder="0" />
        </td>
        <td class="cas-col-night">
          <input type="number" min="0" class="cas-input" value="${night || ""}" placeholder="0" />
        </td>
        <td class="cas-col-total">${total || ""}</td>
        <td class="cas-col-arrows">
          <button class="cas-arrow" data-dir="-1" title="Вгору"${idx === 0 ? " disabled" : ""}>↑</button>
          <button class="cas-arrow" data-dir="1"  title="Вниз"${idx === units.length - 1 ? " disabled" : ""}>↓</button>
        </td>`;

      tr.querySelector(".cas-col-morning input").addEventListener("input", () => onInput(tr, cat, unit.id));
      tr.querySelector(".cas-col-night   input").addEventListener("input", () => onInput(tr, cat, unit.id));
      tr.querySelectorAll(".cas-arrow").forEach(btn => {
        btn.addEventListener("click", () => moveUnit(idx, Number(btn.dataset.dir)));
      });

      tbody.appendChild(tr);
    });
  }

  // ── Input + save ──────────────────────────────────────────────────────────
  function onInput(tr, cat, uid) {
    const m = parseInt(tr.querySelector(".cas-col-morning input").value) || 0;
    const n = parseInt(tr.querySelector(".cas-col-night   input").value) || 0;
    tr.querySelector(".cas-col-total").textContent = (m + n) || "";
    entries[`${cat}_${uid}`] = { morning: m, night: n };

    const key = `${cat}_${uid}`;
    clearTimeout(saveTimers[key]);
    saveTimers[key] = setTimeout(() => {
      delete saveTimers[key];
      apiFetch("/api/cas/entry", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ unit_id: uid, category: cat, morning: m, night: n }),
      });
    }, 700);
  }

  // ── Reorder ───────────────────────────────────────────────────────────────
  function moveUnit(idx, dir) {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= units.length) return;
    [units[idx], units[newIdx]] = [units[newIdx], units[idx]];
    render();
    apiFetch("/api/cas/units/reorder", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ order: units.map(u => u.id) }),
    });
  }

  // ── Clear column ──────────────────────────────────────────────────────────
  async function clearColumn(col) {
    const label = col === "morning" ? "08:00–16:00" : "16:00–08:00";
    if (!confirm(`Обнулити всі значення колонки «${label}»?`)) return;
    Object.keys(saveTimers).forEach(k => { clearTimeout(saveTimers[k]); delete saveTimers[k]; });
    await apiFetch("/api/cas/clear-column", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ column: col }),
    });
    await loadEntries();
    render();
  }

  document.getElementById("casClearMorning")?.addEventListener("click", () => clearColumn("morning"));
  document.getElementById("casClearNight")?.addEventListener("click",   () => clearColumn("night"));

  // ── Add / remove unit ─────────────────────────────────────────────────────
  document.getElementById("casAddUnit")?.addEventListener("click", async () => {
    const name = prompt("Назва підрозділу:");
    if (!name?.trim()) return;
    const d = await apiFetch("/api/cas/units", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ name: name.trim() }),
    });
    if (d.ok) { await loadUnits(); render(); }
    else alert("Помилка: " + (d.error || "?"));
  });

  document.getElementById("casRemoveUnit")?.addEventListener("click", async () => {
    if (!units.length) return;
    const list = units.map((u, i) => `${i + 1}. ${u.name}`).join("\n");
    const val  = prompt(`Номер підрозділу для видалення:\n${list}`);
    const idx  = parseInt(val) - 1;
    if (isNaN(idx) || idx < 0 || idx >= units.length) return;
    const unit = units[idx];
    if (!confirm(`Видалити «${unit.name}»?`)) return;
    await apiFetch(`/api/cas/units/${unit.id}`, { method: "DELETE" });
    await loadUnits();
    render();
  });

  // ── Show all ──────────────────────────────────────────────────────────────
  showAllBtn?.addEventListener("click", () => {
    compactMode = null;
    render();
  });

  // ── Date (report header only — does not affect which entries are loaded) ──
  dateInput?.addEventListener("change", () => {
    reportDate = dateInput.value || todayISO();
    localStorage.setItem("cas_date", reportDate);
    // No reload needed — entries are not date-keyed
  });

  // ── Screenshots ───────────────────────────────────────────────────────────
  document.getElementById("casSSMorning")?.addEventListener("click", () => doScreenshot("morning"));
  document.getElementById("casSSNight")?.addEventListener("click", () => {
    // Save daily total snapshot under the current report date
    apiFetch("/api/cas/snapshot", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ date: reportDate }),
    });
    doScreenshot("night");
  });

  const ssModal  = document.getElementById("casSSModal");
  const ssImg    = document.getElementById("casSSImg");
  let   ssObjUrl = null;

  document.querySelectorAll("[data-close-ss]").forEach(el =>
    el.addEventListener("click", () => {
      ssModal?.classList.add("hidden");
      if (ssModal) ssModal.setAttribute("aria-hidden", "true");
      if (ssObjUrl) { URL.revokeObjectURL(ssObjUrl); ssObjUrl = null; }
    })
  );

  function doScreenshot(mode) {
    compactMode = mode;
    render();

    const url = `/api/cas/image?date=${encodeURIComponent(reportDate)}&mode=${mode}`;
    fetch(url)
      .then(r => { if (!r.ok) throw new Error("server error"); return r.blob(); })
      .then(blob => {
        if (ssObjUrl) URL.revokeObjectURL(ssObjUrl);
        ssObjUrl = URL.createObjectURL(blob);
        if (ssImg) ssImg.src = ssObjUrl;
        if (ssModal) {
          ssModal.classList.remove("hidden");
          ssModal.setAttribute("aria-hidden", "false");
        }
        if (navigator.clipboard?.write && window.ClipboardItem) {
          navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
            .then(() => toast("Скопійовано у буфер!", "success", 3000))
            .catch(() => {});
        }
      })
      .catch(() => toast("Помилка генерації зображення", "error", 4000));
  }

  function toast(msg, type, ms) {
    const stack = document.getElementById("appToastStack");
    if (!stack) return;
    const el = document.createElement("div");
    el.className = "app-toast app-toast--" + (type || "info");
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), ms || 3000);
  }

  // ── Util ──────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

})();
