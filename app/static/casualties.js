/* casualties.js – v1
 * Interactive casualties table for the home page "Втрати" tab.
 */

(function () {
  "use strict";

  // ── State ─────────────────────────────────────────────────────────────────
  let units   = [];   // [{id, name, sort_order}]
  let entries = {};   // {"irr_<id>": {morning, night}, "san_<id>": {...}}
  let currentDate = todayISO();
  let saveTimers  = {};

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const pane      = document.getElementById("homePaneCasualties");
  if (!pane) return; // tab not present

  const dateInput = document.getElementById("casDate");
  const tbody     = document.getElementById("casTbody");
  const tableWrap = document.getElementById("casTableWrap");

  // ── Init ──────────────────────────────────────────────────────────────────
  let _inited = false;
  async function init() {
    if (_inited) return;
    _inited = true;
    if (dateInput) dateInput.value = currentDate;
    await loadUnits();
    await loadEntries();
    render();
  }

  // Trigger on tab click or if already active
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
    const d = await apiFetch(`/api/cas/entries?date=${currentDate}`);
    if (d.ok) entries = d.entries;
  }

  function getEntry(cat, uid) {
    return entries[`${cat}_${uid}`] || { morning: 0, night: 0 };
  }

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    if (!tbody) return;
    tbody.innerHTML = "";

    if (units.length === 0) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="6" class="cas-empty">Підрозділів немає — натисніть «Додати».</td>`;
      tbody.appendChild(tr);
      return;
    }

    renderSection("irr", "Безповоротні");
    renderSection("san", "Санітарні");
  }

  function renderSection(cat, label) {
    // Section header row
    const hdrTr = document.createElement("tr");
    hdrTr.className = "cas-section-hdr";
    hdrTr.dataset.cat = cat;
    hdrTr.innerHTML = `<td colspan="6">${label}</td>`;
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

      // Input listeners
      tr.querySelector(".cas-col-morning input").addEventListener("input", () => onInput(tr, cat, unit.id));
      tr.querySelector(".cas-col-night input").addEventListener("input",   () => onInput(tr, cat, unit.id));

      // Arrow listeners
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

    // Also update the matching row in the other section (same unit, different cat)
    // (total cells only — inputs are per-section)

    const key = `${cat}_${uid}`;
    clearTimeout(saveTimers[key]);
    saveTimers[key] = setTimeout(() => {
      apiFetch("/api/cas/entry", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ unit_id: uid, date: currentDate, category: cat, morning: m, night: n }),
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

  // ── Date change ───────────────────────────────────────────────────────────
  dateInput?.addEventListener("change", async () => {
    currentDate = dateInput.value || todayISO();
    await loadEntries();
    render();
  });

  // ── Screenshots ───────────────────────────────────────────────────────────
  document.getElementById("casSSMorning")?.addEventListener("click", () => doScreenshot("morning"));
  document.getElementById("casSSNight")?.addEventListener("click",   () => doScreenshot("night"));

  function doScreenshot(mode) {
    if (typeof html2canvas === "undefined") {
      alert("html2canvas не завантажено — перевір підключення.");
      return;
    }

    // Collect rows to hide
    const hiddenRows = [];
    tbody.querySelectorAll(".cas-row").forEach(row => {
      const cat = row.dataset.category;
      const uid = row.dataset.unitId;
      const e   = getEntry(cat, uid);
      const hide = mode === "morning" ? !e.morning : (!e.night && !(e.morning + e.night));
      if (hide) {
        row.classList.add("cas-ss-hide");
        hiddenRows.push(row);
      }
    });

    // Apply layout class
    tableWrap.classList.add("cas-ss-active", `cas-ss-${mode}`);

    html2canvas(tableWrap, { scale: 2, useCORS: true, logging: false }).then(canvas => {
      // Restore
      tableWrap.classList.remove("cas-ss-active", `cas-ss-morning`, `cas-ss-night`);
      hiddenRows.forEach(r => r.classList.remove("cas-ss-hide"));

      // Show modal
      const modal = document.getElementById("casSSModal");
      const img   = document.getElementById("casSSImg");
      img.src = canvas.toDataURL("image/png");
      modal.classList.remove("hidden");
      modal.setAttribute("aria-hidden", "false");
    });
  }

  // Close screenshot modal
  document.getElementById("casSSModal")?.addEventListener("click", e => {
    if (e.target.closest("[data-close-ss]") || e.target.id === "casSSModal") {
      document.getElementById("casSSModal").classList.add("hidden");
      document.getElementById("casSSModal").setAttribute("aria-hidden", "true");
    }
  });

  // ── Util ──────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

})();
