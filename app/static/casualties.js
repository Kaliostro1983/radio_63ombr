/* casualties.js – v3
 * Interactive casualties table for the home page "Втрати" tab.
 */

(function () {
  "use strict";

  // ── State ─────────────────────────────────────────────────────────────────
  let units       = [];   // [{id, name, sort_order}]
  let entries     = {};   // {"irr_<id>": {morning, night}, "san_<id>": {...}}
  let currentDate = todayISO();
  let saveTimers  = {};
  let compactMode = null; // null | "morning" | "night"

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
    if (dateInput) dateInput.value = currentDate;
    await loadUnits();
    await loadEntries();
    render();
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

    // Apply / remove compact-mode CSS classes on the wrapper
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

      // Hide row in compact mode when value is 0
      if (compactMode === "morning" && !morning) tr.classList.add("cas-ss-hide");
      if (compactMode === "night"   && !night && !total) tr.classList.add("cas-ss-hide");

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

  // ── Clear column ──────────────────────────────────────────────────────────
  async function clearColumn(col) {
    const label = col === "morning" ? "08:00–16:00" : "16:00–08:00";
    if (!confirm(`Обнулити всі значення колонки «${label}» за ${currentDate}?`)) return;
    // Cancel any pending debounce saves so they don't override the clear
    Object.keys(saveTimers).forEach(k => { clearTimeout(saveTimers[k]); delete saveTimers[k]; });
    await apiFetch("/api/cas/clear-column", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ date: currentDate, column: col }),
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
    // Switch to compact mode (persists after screenshot)
    compactMode = mode;
    render();

    // Small delay so browser repaints before capture
    requestAnimationFrame(() => requestAnimationFrame(() => {
      html2canvas(tableWrap, { scale: 2, useCORS: true, logging: false }).then(canvas => {
        canvas.toBlob(blob => {
          // Try modern Clipboard API first
          if (navigator.clipboard?.write && window.ClipboardItem) {
            navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])
              .then(() => toast("Скопійовано у буфер!", "success", 3000))
              .catch(() => autoDownload(canvas, mode));
          } else {
            autoDownload(canvas, mode);
          }
        }, "image/png");
      });
    }));
  }

  function autoDownload(canvas, mode) {
    const a = document.createElement("a");
    a.download = `zvit-${mode}-${currentDate}.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
    toast("Збережено як файл (HTTP не дозволяє буфер)", "info", 4000);
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
