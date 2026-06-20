/* Поле «Частоти» у фільтрі «Перегляд» — кілька частот як чіпи (автокомпліт
 * лишається на networks_autocomplete.js). Видимий інпут #networkQuery керує
 * введенням; список частот тримаємо в масиві й синхронізуємо у прихований
 * #networkHidden (name="network", через кому) — звідти його читає buildQuery.
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

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function updateHidden() {
    hidden.value = freqs.join(",");
  }

  function render() {
    // Прибрати наявні чіпи (інпут лишаємо на місці — він останній елемент).
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

  function commitPending() {
    const t = input.value.trim();
    if (t) { addFreq(t); input.value = ""; }
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

  // ── Ввід: Enter/кома → чіп; Enter на порожньому інпуті → сабміт форми. ──
  input.addEventListener("keydown", (e) => {
    if (e.key === "," ) { e.preventDefault(); commitPending(); return; }
    if (e.key === "Enter") {
      if (input.value.trim()) { e.preventDefault(); commitPending(); }
      // порожній інпут — не блокуємо: спрацює submit (Показати)
    }
    if (e.key === "Backspace" && !input.value && freqs.length) {
      freqs.pop(); render();
    }
  });
  // Втрата фокусу — зафіксувати недодану частоту як чіп.
  input.addEventListener("blur", () => { setTimeout(commitPending, 120); });

  // Видалення чіпа.
  container.addEventListener("click", (e) => {
    const btn = e.target.closest(".freq-chip__remove");
    if (btn) { removeFreq(btn.dataset.freq || ""); input.focus(); }
    else if (e.target === container) input.focus();
  });

  // Перед сабмітом — зафіксувати поточний текст інпута (capture, до buildQuery).
  if (form) {
    form.addEventListener("submit", () => { commitPending(); }, true);
  }

  // Клік по контейнеру фокусує інпут.
  container.addEventListener("mousedown", (e) => {
    if (e.target === container) { e.preventDefault(); input.focus(); }
  });

  // Ініціалізація: перетворити початкове значення hidden (з URL) на чіпи.
  if (hidden.value && hidden.value.trim()) addFreq(hidden.value);
  else updateHidden();

  window.itAddFreqChip = addFreq;
  window.itFreqChips = { set, add: addFreq, clear: () => set([]), getValues: () => freqs.slice() };
})();
