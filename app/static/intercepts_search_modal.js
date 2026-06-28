/* Модалка «Пошук» на сторінці «Перехоплення».
 *
 * Раніше це був iframe із спрощеними картками. Тепер пошук рендерить ТІ САМІ
 * повноцінні блоки перехоплень, що й «Моніторинг»/«Перегляд» — через
 * window.interceptsExplorerMountCard(id, container), визначений в
 * intercepts_explorer.js (ініціалізований на цій сторінці).
 */
(function () {
  "use strict";

  const form    = document.getElementById("itSearchForm");
  const results = document.getElementById("itSearchResults");
  const warn    = document.getElementById("itSearchWarning");
  const moreBtn = document.getElementById("itSearchMore");
  if (!form || !results) return;

  const phraseI = document.getElementById("itSearchPhrase");
  const freqI   = document.getElementById("itSearchFreq");
  const daysI   = document.getElementById("itSearchDays");

  const LIMIT = 20;
  let offset = 0;
  let loading = false;
  let reachedEnd = false;

  function setWarn(msg) {
    if (!warn) return;
    warn.textContent = msg || "";
    warn.style.display = msg ? "block" : "none";
  }

  function mountCard(id) {
    const cell = document.createElement("div");
    cell.className = "it-search-result";
    results.appendChild(cell);
    if (window.interceptsExplorerMountCard) {
      window.interceptsExplorerMountCard(id, cell);
    } else {
      cell.textContent = "Не вдалося відобразити картку.";
    }
  }

  async function load(reset) {
    if (loading) return;
    const phrase = (phraseI && phraseI.value.trim()) || "";
    const frequency = (freqI && freqI.value.trim()) || "";
    const days = (daysI && daysI.value) || "70";

    if (reset) { offset = 0; reachedEnd = false; results.innerHTML = ""; }
    if (!phrase && !frequency) {
      setWarn("Вкажіть слово або частоту/маску для пошуку.");
      if (moreBtn) moreBtn.classList.add("hidden");
      return;
    }

    loading = true;
    setWarn("");
    try {
      const params = new URLSearchParams({
        phrase, frequency, days: String(days),
        limit: String(LIMIT), offset: String(offset),
      });
      const r = await fetch(`/api/intercepts/search?${params.toString()}`, { headers: { Accept: "application/json" } });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && d.detail) || ("HTTP " + r.status));
      if (d && d.warning) setWarn(d.warning);

      const items = Array.isArray(d && d.items) ? d.items : [];
      items.forEach((it) => { if (it && it.id) mountCard(it.id); });

      offset += items.length;
      reachedEnd = items.length < LIMIT;
      if (reset && !items.length) setWarn("За вибраними фільтрами нічого не знайдено.");
      if (moreBtn) moreBtn.classList.toggle("hidden", reachedEnd || !items.length);
    } catch (e) {
      setWarn("Помилка пошуку: " + (e && e.message ? e.message : e));
    } finally {
      loading = false;
    }
  }

  form.addEventListener("submit", (e) => { e.preventDefault(); load(true); });
  if (moreBtn) moreBtn.addEventListener("click", () => load(false));
})();
