(function () {
  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  /**
   * Attach frequency autocomplete to an input element.
   *
   * @param {HTMLInputElement} input  - the target input
   * @param {Function}        [onPick] - optional callback(item, value) called
   *   when the user picks a suggestion.  If omitted, the nearest <form> is
   *   submitted with form.submit().
   */
  function setupNetworkFreqLookup(input, onPick) {
    if (!input) return;
    const form = input.closest("form");
    const wrap = input.closest(".home-freq-input-wrap");
    if (!wrap) return;
    // Need either a form (for default submit) or an onPick callback
    if (!form && typeof onPick !== "function") return;

    let box = null;
    let items = [];
    let index = -1;
    let timer = null;

    function close() {
      if (box) box.remove();
      box = null;
      items = [];
      index = -1;
    }

    function highlight() {
      if (!box) return;
      const els = box.querySelectorAll(".callsign-autocomplete__item");
      els.forEach((el, idx) => el.classList.toggle("is-selected", idx === index));
    }

    function pick(it) {
      if (!it) return;
      const value = String(it.mask || it.frequency || "").trim();
      if (!value) return;
      input.value = value;
      close();
      if (typeof onPick === "function") {
        onPick(it, value);
      } else if (form) {
        form.submit();
      }
    }

    async function lookup(q) {
      const qs = String(q || "").trim();
      close();
      if (!qs || qs.length < 2) return;
      try {
        const resp = await fetch(`/api/networks/lookup?q=${encodeURIComponent(qs)}`, { headers: { Accept: "application/json" } });
        if (!resp.ok) return;
        const data = await resp.json();
        if (!data.ok) return;
        const rows = Array.isArray(data.rows) ? data.rows : [];
        if (!rows.length) return;

        items = rows;
        box = document.createElement("div");
        box.className = "callsign-autocomplete";
        box.innerHTML = rows.map((r, idx) => {
          const label = `${r.frequency || ""}${r.mask ? " / " + r.mask : ""} — ${r.unit || ""}`.trim();
          return `<button type="button" class="callsign-autocomplete__item" data-index="${idx}">${escapeHtml(label)}</button>`;
        }).join("");
        wrap.appendChild(box);
        index = -1;
      } catch (e) {
        close();
      }
    }

    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => lookup(input.value), 180);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (!items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        index = (index + 1) % items.length;
        highlight();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        index = (index - 1 + items.length) % items.length;
        highlight();
        return;
      }
      if (e.key === "Enter" && index >= 0 && items[index]) {
        e.preventDefault();
        pick(items[index]);
      }
    });

    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) {
        close();
        return;
      }
      const btn = e.target.closest(".callsign-autocomplete__item");
      if (!btn || !box || !box.contains(btn)) return;
      const idx = Number(btn.dataset.index || -1);
      if (idx >= 0 && items[idx]) pick(items[idx]);
    });
  }

  // Networks page: коли користувач обирає р/м з випадаючого автокомпліту,
  // навігуємо одразу на /networks?pick={id} — це не сабмітить форму
  // /networks/search (через яку могла б повертатись 0/багато збігів, без
  // авто-відкриття модалки) і гарантує, що модалка "Картка р/м" відкриється
  // саме з обраною мережею.
  setupNetworkFreqLookup(
    document.getElementById("netSearchQuery"),
    function (it) {
      if (it && it.id) window.location.href = "/networks?pick=" + encodeURIComponent(it.id);
    }
  );
  setupNetworkFreqLookup(document.getElementById("etalonsFreqQuery"));

  // Intercepts explorer — dispatch JS submit event (not form.submit which bypasses listeners)
  setupNetworkFreqLookup(
    document.getElementById("networkQuery"),
    function () {
      var f = document.getElementById("interceptsFilterForm");
      if (f) f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
  );

  // Callsigns "by frequency" tab — trigger the Показати button
  setupNetworkFreqLookup(
    document.getElementById("csFreq"),
    function () {
      var btn = document.getElementById("csShow");
      if (btn) btn.click();
    }
  );
})();
