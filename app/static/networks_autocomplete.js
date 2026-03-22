(function () {
  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function setupNetworkFreqLookup(input) {
    if (!input) return;
    const form = input.closest("form");
    const wrap = input.closest(".home-freq-input-wrap");
    if (!form || !wrap) return;

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
      form.submit();
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

  setupNetworkFreqLookup(document.getElementById("netSearchQuery"));
  setupNetworkFreqLookup(document.getElementById("etalonsFreqQuery"));
})();
