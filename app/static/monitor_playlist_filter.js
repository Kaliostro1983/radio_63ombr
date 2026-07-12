/* Фільтр плейлиста «Моніторинг» за частотами/масками.
 *
 * Кнопка-іконка «Фільтр» під плейлистом відкриває МОДАЛКУ поверх плейлиста
 * (раніше була вбудована панель — її автокомпліт ховався за маскою/overflow
 * контейнера плейлиста). У модалці:
 *   • вводять по одному значенню — з автокомплітом (/api/networks/lookup);
 *   • або пакетно — через кому чи в стовпчик (Enter / вставка); нормалізується.
 * Значення можуть бути частотами або масками. Кожне зберігається чіпом. Якщо
 * радіомережу не знайдено — чіп позначається попередженням.
 *
 * Кожне валідне значення резолвиться у network_id (їх може бути кілька). Набір
 * застосовується НЕ на кожну зміну, а кнопкою «Застосувати» (бо частот може
 * бути багато — пакетне введення), і передається в monitor.js для серверної
 * фільтрації (працює з пагінацією/полінгом).
 */
(function () {
  "use strict";

  const btn       = document.getElementById("monFilterBtn");
  const modal     = document.getElementById("monFilterModal");
  const container = document.getElementById("monFilterChips");
  const input     = document.getElementById("monFilterInput");
  const warnBox   = document.getElementById("monFilterWarn");
  const applyBtn  = document.getElementById("monFilterApply");
  const resetBtn  = document.getElementById("monFilterReset");
  if (!btn || !modal || !container || !input) return;

  // chips: [{ key, label, ids:[], found:bool }]
  let chips = [];

  // Автокомпліт
  // acSeq — генерація запиту: захист від гонки, коли асинхронний lookup()
  // завершується вже після вибору чіпа/закриття й знову домальовує меню.
  let acBox = null, acItems = [], acIndex = -1, acTimer = null, acSeq = 0;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* Нормалізація: обрізаємо, кома→крапка (для частот), схлопуємо пробіли. */
  function normalize(raw) {
    return String(raw || "").trim().replace(",", ".").replace(/\s+/g, " ");
  }

  /* Серед знайдених рядків лишаємо ті, що ТОЧНО збігаються за частотою (число)
     або маскою (рядок). Повертає { ids:[], canon }. */
  function matchNetworks(token, rows) {
    const t = normalize(token).toLowerCase();
    const tNum = parseFloat(t);
    const ids = [];
    let canon = "";
    (rows || []).forEach((r) => {
      const f = String(r.frequency || "").trim();
      const fNum = parseFloat(f.replace(",", "."));
      const m = String(r.mask || "").trim();
      const freqEq = isFinite(tNum) && isFinite(fNum) && Math.abs(tNum - fNum) < 1e-9;
      const maskEq = m && m.toLowerCase() === t;
      if (freqEq || maskEq) {
        ids.push(Number(r.id));
        if (!canon) canon = freqEq ? f : m;
      }
    });
    return { ids, canon };
  }

  async function lookupRows(q) {
    try {
      const r = await fetch("/api/networks/lookup?q=" + encodeURIComponent(q),
                            { headers: { Accept: "application/json" } });
      const d = await r.json();
      return (d && d.ok && Array.isArray(d.rows)) ? d.rows : [];
    } catch (_) { return []; }
  }

  function collectIds() {
    const ids = [];
    chips.forEach((c) => c.ids.forEach((id) => { if (!ids.includes(id)) ids.push(id); }));
    return ids;
  }

  /* Застосувати поточні чіпи до плейлиста. Якщо чіпи є, але жодна мережа не
     знайдена — порожній плейлист (id=-1); без чіпів — без фільтра. */
  function applyNow() {
    const ids = collectIds();
    let payload;
    if (!chips.length) payload = [];
    else payload = ids.length ? ids : [-1];
    if (window.monApplyPlaylistFilter) window.monApplyPlaylistFilter(payload);
    const active = chips.length > 0;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  }

  function renderWarn() {
    if (!warnBox) return;
    const bad = chips.filter((c) => !c.found).map((c) => c.label);
    if (bad.length) {
      warnBox.textContent = "Радіомережу не знайдено: " + bad.join(", ");
      warnBox.style.display = "";
    } else {
      warnBox.style.display = "none";
      warnBox.textContent = "";
    }
  }

  /* Перемальовуємо чіпи. НЕ застосовуємо фільтр (це робить «Застосувати»). */
  function render() {
    container.querySelectorAll(".freq-chip").forEach((el) => el.remove());
    chips.forEach((c) => {
      const chip = document.createElement("span");
      chip.className = "freq-chip" + (c.found ? "" : " freq-chip--warn");
      if (!c.found) chip.title = "Радіомережу не знайдено";
      chip.innerHTML =
        `<span class="freq-chip__name">${esc(c.label)}</span>` +
        `<button type="button" class="freq-chip__remove" data-key="${esc(c.key)}" ` +
        `title="Прибрати" aria-label="Прибрати">×</button>`;
      container.insertBefore(chip, input);
    });
    renderWarn();
  }

  function hasKey(key) { return chips.some((c) => c.key === key); }

  /* Додати одне значення (резолвимо у мережі). */
  async function addToken(value) {
    const norm = normalize(value);
    if (!norm) return;
    const key = norm.toLowerCase();
    if (hasKey(key)) return;
    const entry = { key, label: norm, ids: [], found: false };
    chips.push(entry);
    render();
    const rows = await lookupRows(norm);
    const { ids, canon } = matchNetworks(norm, rows);
    entry.ids = ids;
    entry.found = ids.length > 0;
    if (canon) entry.label = canon;
    render();
  }

  /* Пакетне додавання: по комах і нових рядках. */
  function addBatch(text) {
    String(text || "")
      .split(/[,\n\r;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((tok) => { addToken(tok); });
  }

  function removeKey(key) {
    chips = chips.filter((c) => c.key !== key);
    render();
  }

  function commitPending() {
    const t = input.value.trim();
    if (t) { addBatch(t); input.value = ""; }
  }

  // ── Автокомпліт ──────────────────────────────────────────────
  function closeAc() {
    acSeq++;                 // інвалідуємо будь-який lookup, що ще «в польоті»
    if (acBox) acBox.remove();
    acBox = null; acItems = []; acIndex = -1;
  }
  function highlight() {
    if (!acBox) return;
    acBox.querySelectorAll(".callsign-autocomplete__item").forEach((el, i) => {
      el.classList.toggle("is-selected", i === acIndex);
    });
  }
  function pickItem(it) {
    const label = String(it.frequency || it.mask || "").trim();
    const key = normalize(label).toLowerCase();
    if (label && !hasKey(key)) {
      chips.push({ key, label, ids: [Number(it.id)], found: true });
      render();
    }
    input.value = "";
    clearTimeout(acTimer);   // скасувати відкладений lookup від набору тексту
    closeAc();
    input.focus();
  }
  async function lookup(q) {
    const qs = String(q || "").trim();
    closeAc();
    if (qs.length < 2) return;
    const seq = acSeq;       // генерація цього запиту (після closeAc — поточна)
    const rows = await lookupRows(qs);
    if (seq !== acSeq) return;  // застарілий запит (був вибір/закриття/новий набір) → не малюємо
    if (!rows.length) return;
    acItems = rows; acIndex = -1;
    acBox = document.createElement("div");
    acBox.className = "callsign-autocomplete";
    acBox.innerHTML = rows.map((row, i) => {
      const label = `${row.frequency || ""}${row.mask ? " / " + row.mask : ""} — ${row.unit || ""}`.trim();
      return `<button type="button" class="callsign-autocomplete__item" data-idx="${i}">${esc(label)}</button>`;
    }).join("");
    container.appendChild(acBox);
  }

  container.addEventListener("click", (e) => {
    const acItem = e.target.closest(".callsign-autocomplete__item");
    if (acItem) {
      const i = Number(acItem.dataset.idx);
      if (Number.isFinite(i) && acItems[i]) pickItem(acItems[i]);
      return;
    }
    const rm = e.target.closest(".freq-chip__remove");
    if (rm) { removeKey(rm.dataset.key || ""); input.focus(); return; }
    if (e.target === container) input.focus();
  });
  container.addEventListener("mousedown", (e) => {
    if (e.target.closest(".callsign-autocomplete__item")) { e.preventDefault(); return; }
    if (e.target === container) { e.preventDefault(); input.focus(); }
  });

  input.addEventListener("input", () => {
    clearTimeout(acTimer);
    acTimer = setTimeout(() => lookup(input.value), 180);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && acItems.length) {
      e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; highlight(); return;
    }
    if (e.key === "ArrowUp" && acItems.length) {
      e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; highlight(); return;
    }
    if (e.key === "Escape") {
      if (acBox) { closeAc(); return; }   // спершу закрити автокомпліт
      closeModal(); return;
    }
    if (e.key === ",") { e.preventDefault(); commitPending(); closeAc(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (acIndex >= 0 && acItems[acIndex]) { pickItem(acItems[acIndex]); return; }
      commitPending(); closeAc(); return;
    }
    if (e.key === "Backspace" && !input.value && chips.length) { chips.pop(); render(); }
  });
  input.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    if (/[,\n\r;]/.test(text)) {
      e.preventDefault();
      closeAc();
      addBatch(text);
      input.value = "";
    }
  });

  // ── Модалка ──────────────────────────────────────────────────
  function openModal() {
    modal.classList.remove("hidden");        // __modalToFront портує у <body> і підніме z-index
    modal.setAttribute("aria-hidden", "false");
    setTimeout(() => input.focus(), 0);
  }
  function closeModal() {
    closeAc();
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }

  btn.addEventListener("click", openModal);

  if (applyBtn) applyBtn.addEventListener("click", () => { commitPending(); applyNow(); closeModal(); });
  if (resetBtn) resetBtn.addEventListener("click", () => {
    chips = [];
    input.value = "";
    render();
    applyNow();   // зняти фільтр (показати всі)
  });

  // Кнопки/бекдроп закриття (× і фон) — без застосування.
  modal.querySelectorAll("[data-mon-filter-close]").forEach((el) => {
    el.addEventListener("click", closeModal);
  });
})();
