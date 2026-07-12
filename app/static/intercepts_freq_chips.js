/* Поле «Частоти» у фільтрі «Перегляд» — кілька частот як чіпи + власний
 * автокомпліт (через /api/networks/lookup). Вибраний пункт додається чіпом із
 * ПРАВИЛЬНОЮ частотою (а не з того, що набрано). Видимий список частот тримаємо
 * в масиві й синхронізуємо у прихований #networkHidden (name="network", через
 * кому) — звідти його читає buildQuery.
 *
 * Публічне API (window.itFreqChips): set(list) / add(val) / clear() / getValues().
 */
(function () {
  "use strict";

  const container = document.getElementById("freqChips");
  const input     = document.getElementById("networkQuery");
  const hidden    = document.getElementById("networkHidden");
  const form      = document.getElementById("interceptsFilterForm");
  if (!container || !input || !hidden) return;

  let freqs = [];

  // Автокомпліт
  let acBox = null;
  let acItems = [];
  let acIndex = -1;
  let acTimer = null;
  // acSeq — генерація запиту: захист від гонки, коли асинхронний lookup()
  // завершується вже після вибору чіпа/закриття й знову домальовує меню.
  let acSeq = 0;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function updateHidden() {
    hidden.value = freqs.join(",");
  }

  function render() {
    container.querySelectorAll(".freq-chip").forEach((el) => el.remove());
    freqs.forEach((f) => {
      const chip = document.createElement("span");
      chip.className = "freq-chip";
      chip.innerHTML =
        `<span class="freq-chip__name">${esc(f)}</span>` +
        `<button type="button" class="freq-chip__remove" data-freq="${esc(f)}" ` +
        `title="Прибрати" aria-label="Прибрати">×</button>`;
      container.insertBefore(chip, input);
    });
    updateHidden();
  }

  function addFreq(raw) {
    String(raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((tok) => {
        if (!freqs.some((x) => x.toLowerCase() === tok.toLowerCase())) freqs.push(tok);
      });
    render();
  }

  function removeFreq(val) {
    freqs = freqs.filter((x) => x.toLowerCase() !== String(val).toLowerCase());
    render();
  }

  function set(list) {
    freqs = [];
    (Array.isArray(list) ? list : [list]).forEach((v) => {
      String(v || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((tok) => {
        if (!freqs.some((x) => x.toLowerCase() === tok.toLowerCase())) freqs.push(tok);
      });
    });
    input.value = "";
    render();
  }

  function commitPending() {
    const t = input.value.trim();
    if (t) { addFreq(t); input.value = ""; }
  }

  // ── Автокомпліт ──────────────────────────────────────────────
  function closeAc() {
    acSeq++;   // інвалідуємо lookup, що ще «в польоті»
    if (acBox) acBox.remove();
    acBox = null;
    acItems = [];
    acIndex = -1;
  }

  function highlight() {
    if (!acBox) return;
    acBox.querySelectorAll(".callsign-autocomplete__item").forEach((el, i) => {
      el.classList.toggle("is-selected", i === acIndex);
    });
  }

  // Частота для чіпа: беремо саме частоту (а не маску), як її обрав користувач.
  function freqOf(it) {
    return String((it && (it.frequency || it.mask)) || "").trim();
  }

  function pickItem(it) {
    const f = freqOf(it);
    if (f) addFreq(f);
    input.value = "";
    clearTimeout(acTimer);   // скасувати відкладений lookup від набору
    closeAc();
    input.focus();
  }

  async function lookup(q) {
    const qs = String(q || "").trim();
    closeAc();
    if (qs.length < 2) return;
    const s = acSeq;   // генерація цього запиту (після closeAc — поточна)
    let rows = [];
    try {
      const r = await fetch("/api/networks/lookup?q=" + encodeURIComponent(qs),
                            { headers: { Accept: "application/json" } });
      const d = await r.json();
      rows = (d && d.ok && Array.isArray(d.rows)) ? d.rows : [];
    } catch (_) { return; }
    if (s !== acSeq) return;   // застарілий запит (був вибір/закриття/новий набір) → не малюємо
    if (!rows.length) return;

    acItems = rows;
    acIndex = -1;
    acBox = document.createElement("div");
    acBox.className = "callsign-autocomplete";
    acBox.innerHTML = rows.map((row, i) => {
      const label = `${row.frequency || ""}${row.mask ? " / " + row.mask : ""} — ${row.unit || ""}`.trim();
      return `<button type="button" class="callsign-autocomplete__item" data-idx="${i}">${esc(label)}</button>`;
    }).join("");
    container.appendChild(acBox);
  }

  // Клік по пункту автокомпліту (делегуємо на контейнер) + видалення чіпа.
  container.addEventListener("click", (e) => {
    const acItem = e.target.closest(".callsign-autocomplete__item");
    if (acItem) {
      const i = Number(acItem.dataset.idx);
      if (Number.isFinite(i) && acItems[i]) pickItem(acItems[i]);
      return;
    }
    const rm = e.target.closest(".freq-chip__remove");
    if (rm) { removeFreq(rm.dataset.freq || ""); input.focus(); return; }
    if (e.target === container) input.focus();
  });

  // Запобігаємо втраті фокуса/блюру до того, як обробимо клік по пункту.
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
      if (acIndex >= 0 && acItems[acIndex]) { e.preventDefault(); pickItem(acItems[acIndex]); return; }
      if (input.value.trim()) { e.preventDefault(); commitPending(); closeAc(); return; }
      // порожній інпут без вибору — не блокуємо: спрацює submit (Показати)
    }
    if (e.key === "Backspace" && !input.value && freqs.length) { freqs.pop(); render(); }
  });

  // Закрити автокомпліт при кліку поза контейнером.
  document.addEventListener("click", (e) => {
    if (!container.contains(e.target)) closeAc();
  });

  // Перед сабмітом — зафіксувати поточний текст інпута (capture, до buildQuery).
  if (form) {
    form.addEventListener("submit", () => { commitPending(); closeAc(); }, true);
  }

  // Ініціалізація: перетворити початкове значення hidden (з URL) на чіпи.
  if (hidden.value && hidden.value.trim()) addFreq(hidden.value);
  else updateHidden();

  window.itAddFreqChip = addFreq;
  window.itFreqChips = { set, add: addFreq, clear: () => set([]), getValues: () => freqs.slice() };
})();
