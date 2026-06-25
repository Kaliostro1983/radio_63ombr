/* Фільтр плейлиста «Моніторинг» за частотами/масками.
 *
 * Кнопка-іконка «Фільтр» під плейлистом показує/ховає панель з інпутом. Туди
 * вводять значення:
 *   • по одному — з автокомплітом (через /api/networks/lookup);
 *   • пакетно — через кому або в стовпчик (Enter/вставка); значення
 *     нормалізуються.
 * Значення можуть бути частотами або масками. Кожне зберігається чіпом. Якщо
 * радіомережу для значення не знайдено — чіп позначається попередженням.
 *
 * Кожне валідне значення резолвиться у network_id (їх може бути кілька на одне
 * значення). Об'єднаний набір id передаємо в monitor.js — серверна фільтрація
 * плейлиста (працює і з пагінацією/полінгом).
 */
(function () {
  "use strict";

  const btn       = document.getElementById("monFilterBtn");
  const panel     = document.getElementById("monFilterPanel");
  const container = document.getElementById("monFilterChips");
  const input     = document.getElementById("monFilterInput");
  const warnBox   = document.getElementById("monFilterWarn");
  if (!btn || !panel || !container || !input) return;

  // chips: [{ key, label, ids:[], found:bool }]
  let chips = [];

  // Автокомпліт
  let acBox = null, acItems = [], acIndex = -1, acTimer = null;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* Нормалізація введеного значення: обрізаємо, кома→крапка (для частот),
     схлопуємо пробіли. Маски лишаються як є (порівняння без регістру). */
  function normalize(raw) {
    return String(raw || "").trim().replace(",", ".").replace(/\s+/g, " ");
  }

  /* Серед знайдених рядків лишаємо ті, що ТОЧНО збігаються за частотою (як число)
     або маскою (як рядок). Повертає { ids:[], canon } — id мереж і канонічний
     підпис для чіпа. */
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

  /* Застосувати фільтр до плейлиста (об'єднання id усіх валідних чіпів).
     Якщо чіпи є, але жодна мережа не знайдена — показуємо порожній плейлист
     (id=-1), а не «всі». Без чіпів — знімаємо фільтр. */
  function apply() {
    const ids = [];
    chips.forEach((c) => c.ids.forEach((id) => { if (!ids.includes(id)) ids.push(id); }));
    let payload;
    if (!chips.length) payload = [];
    else payload = ids.length ? ids : [-1];
    if (window.monApplyPlaylistFilter) window.monApplyPlaylistFilter(payload);
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
    apply();
  }

  function hasKey(key) {
    return chips.some((c) => c.key === key);
  }

  /* Додати одне значення (резолвимо у мережі). value — сирий токен. */
  async function addToken(value) {
    const norm = normalize(value);
    if (!norm) return;
    const key = norm.toLowerCase();
    if (hasKey(key)) return;
    // Резервуємо місце, щоб не дублювати при швидкому вводі.
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

  /* Пакетне додавання: розбиваємо по комах і нових рядках. */
  function addBatch(text) {
    String(text || "")
      .split(/[,\n\r]+/)
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
    // Обрано конкретну мережу — id відомий, без повторного резолву.
    const label = String(it.frequency || it.mask || "").trim();
    const key = normalize(label).toLowerCase();
    if (label && !hasKey(key)) {
      chips.push({ key, label, ids: [Number(it.id)], found: true });
      render();
    }
    input.value = "";
    closeAc();
    input.focus();
  }
  async function lookup(q) {
    const qs = String(q || "").trim();
    closeAc();
    if (qs.length < 2) return;
    const rows = await lookupRows(qs);
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

  // Клік: пункт автокомпліту або видалення чіпа.
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
  // Не втрачати фокус до обробки кліку (модалку портують у <body>).
  container.addEventListener("mousedown", (e) => {
    if (e.target.closest(".callsign-autocomplete__item")) { e.preventDefault(); return; }
    if (e.target === container) { e.preventDefault(); input.focus(); }
  });

  // ── Ввід ─────────────────────────────────────────────────────
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
    if (e.key === "Escape") { closeAc(); return; }
    if (e.key === ",") { e.preventDefault(); commitPending(); closeAc(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (acIndex >= 0 && acItems[acIndex]) { pickItem(acItems[acIndex]); return; }
      commitPending(); closeAc(); return;
    }
    if (e.key === "Backspace" && !input.value && chips.length) { chips.pop(); render(); }
  });
  // Пакетна вставка (стовпчик / через кому).
  input.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
    if (/[,\n\r]/.test(text)) {
      e.preventDefault();
      closeAc();
      addBatch(text);
      input.value = "";
    }
  });
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) closeAc();
  });

  // ── Кнопка-перемикач панелі ──────────────────────────────────
  btn.addEventListener("click", () => {
    const show = panel.classList.contains("hidden");
    panel.classList.toggle("hidden", !show);
    btn.classList.toggle("is-active", show);
    btn.setAttribute("aria-pressed", show ? "true" : "false");
    if (show) setTimeout(() => input.focus(), 0);
  });
})();
