(function () {
  const tbody = document.getElementById("netAliasTableBody");
  const addBtn = document.getElementById("netAliasAddOpen");
  const addModal = document.getElementById("netAliasAddModal");
  const editModal = document.getElementById("netAliasEditModal");
  if (!tbody || !addBtn || !addModal || !editModal) return;

  let lastRows = [];

  function toast(msg, type) {
    if (typeof window.appToast === "function") window.appToast(msg, type || "error");
    else alert(msg);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function openModal(el) {
    el.classList.remove("hidden");
    el.setAttribute("aria-hidden", "false");
  }

  function closeModal(el) {
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
  }

  function wireModalClose(modal) {
    modal.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-close") === "1") {
        closeModal(modal);
      }
    });
  }
  wireModalClose(addModal);
  wireModalClose(editModal);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!addModal.classList.contains("hidden")) closeModal(addModal);
    if (!editModal.classList.contains("hidden")) closeModal(editModal);
  });

  async function fetchRows() {
    const resp = await fetch("/api/network-aliases", { headers: { Accept: "application/json" } });
    const data = await resp.json();
    if (!data.ok) throw new Error("load_failed");
    return Array.isArray(data.rows) ? data.rows : [];
  }

  function renderTable(rows) {
    lastRows = rows;
    tbody.innerHTML = "";
    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="3" class="small" style="opacity:.75">Немає аліасів.</td></tr>';
      return;
    }
    rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" +
        (i + 1) +
        '</td><td><a href="/networks?pick=' +
        encodeURIComponent(r.network_id) +
        '&tab=card" class="net-alias-freq-link">' +
        escapeHtml(r.frequency) +
        '</a></td><td><button type="button" class="net-alias-alias-btn" data-alias-id="' +
        escapeHtml(String(r.id)) +
        '">' +
        escapeHtml(r.alias_text) +
        "</button></td>";
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll("[data-alias-id]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-alias-id"));
        const row = lastRows.find((x) => x.id === id);
        if (row) openEdit(row);
      });
    });
  }

  async function loadTable() {
    try {
      const rows = await fetchRows();
      renderTable(rows);
    } catch (e) {
      tbody.innerHTML =
        '<tr><td colspan="3" class="small" style="color:var(--danger)">Не вдалося завантажити список. Перезапусти сервер (start.bat / start_localhost.bat).</td></tr>';
      toast("Не вдалося завантажити аліаси. Перезапусти сервер.", "error");
    }
  }

  const addFreqInput = document.getElementById("netAliasAddFreq");
  const addNetId = document.getElementById("netAliasAddNetworkId");
  const addText = document.getElementById("netAliasAddText");

  function setupFreqAutocomplete(input, hiddenIdInput) {
    if (!input || !hiddenIdInput) return;
    const wrap = input.closest(".home-freq-input-wrap");
    if (!wrap) return;
    let box = null;
    let items = [];
    let index = -1;
    let timer = null;
    let syncingFromPick = false;

    function closeAc() {
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
      const value = String(it.frequency || "").trim();
      if (!value) return;
      syncingFromPick = true;
      input.value = value;
      hiddenIdInput.value = String(it.id);
      hiddenIdInput.dispatchEvent(new Event("change"));
      queueMicrotask(() => {
        syncingFromPick = false;
      });
      closeAc();
    }

    async function lookup(q) {
      const qs = String(q || "").trim();
      closeAc();
      if (!qs || qs.length < 2) return;
      try {
        const resp = await fetch(`/api/networks/lookup?q=${encodeURIComponent(qs)}`, {
          headers: { Accept: "application/json" },
        });
        if (!resp.ok) return;
        const data = await resp.json();
        if (!data.ok) return;
        const rows = Array.isArray(data.rows) ? data.rows : [];
        if (!rows.length) return;
        items = rows;
        box = document.createElement("div");
        box.className = "callsign-autocomplete";
        box.innerHTML = rows
          .map((r, idx) => {
            const label = `${r.frequency || ""}${r.mask ? " / " + r.mask : ""} — ${r.unit || ""}`.trim();
            return `<button type="button" class="callsign-autocomplete__item" data-index="${idx}">${escapeHtml(
              label
            )}</button>`;
          })
          .join("");
        wrap.appendChild(box);
        index = -1;
      } catch (e) {
        closeAc();
      }
    }

    input.addEventListener("input", () => {
      if (syncingFromPick) return;
      hiddenIdInput.value = "";
      clearTimeout(timer);
      timer = setTimeout(() => lookup(input.value), 180);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeAc();
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
        closeAc();
        return;
      }
      const btn = e.target.closest(".callsign-autocomplete__item");
      if (!btn || !box || !box.contains(btn)) return;
      const idx = Number(btn.dataset.index || -1);
      if (idx >= 0 && items[idx]) pick(items[idx]);
    });
  }

  setupFreqAutocomplete(addFreqInput, addNetId);

  addBtn.addEventListener("click", () => {
    addFreqInput.value = "";
    addNetId.value = "";
    addText.value = "";
    openModal(addModal);
    addFreqInput.focus();
  });

  const addSave = document.getElementById("netAliasAddSave");
  if (addSave) {
    addSave.addEventListener("click", async () => {
      const nid = parseInt(addNetId.value, 10);
      const aliasText = String(addText.value || "").trimEnd();
      if (!nid) {
        toast("Обери радіомережу з підказок (частота).", "error");
        return;
      }
      if (!aliasText.trim()) {
        toast("Введи текст аліасу.", "error");
        return;
      }
      try {
        const resp = await fetch("/api/network-aliases", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ network_id: nid, alias_text: aliasText }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          toast(data.error || "Не вдалося зберегти.", "error");
          return;
        }
        closeModal(addModal);
        toast("Аліас додано.", "info");
        await loadTable();
      } catch (e) {
        toast("Помилка збереження.", "error");
      }
    });
  }

  const editId = document.getElementById("netAliasEditId");
  const editNetworkId = document.getElementById("netAliasEditNetworkId");
  const editText = document.getElementById("netAliasEditText");
  const editFreqInput = document.getElementById("netAliasEditFreq");
  const editFreqLink = document.getElementById("netAliasEditFreqLink");
  setupFreqAutocomplete(editFreqInput, editNetworkId);

  function openEdit(row) {
    if (!editId || !editNetworkId || !editText || !editFreqInput || !editFreqLink) return;
    editId.value = String(row.id);
    editNetworkId.value = String(row.network_id || "");
    editText.value = row.alias_text;
    editFreqInput.value = row.frequency || "";
    editFreqLink.textContent = row.frequency || "Відкрити картку радіомережі";
    editFreqLink.href = "/networks?pick=" + encodeURIComponent(row.network_id) + "&tab=card";
    openModal(editModal);
    editFreqInput.focus();
  }

  if (editFreqInput && editNetworkId && editFreqLink) {
    editFreqInput.addEventListener("input", () => {
      if (!editNetworkId.value) {
        editFreqLink.textContent = "Відкрити картку радіомережі";
        editFreqLink.href = "#";
      }
    });
    editNetworkId.addEventListener("change", () => {
      const nid = String(editNetworkId.value || "").trim();
      if (!nid) return;
      editFreqLink.href = "/networks?pick=" + encodeURIComponent(nid) + "&tab=card";
      if (!String(editFreqLink.textContent || "").trim()) {
        editFreqLink.textContent = "Відкрити картку радіомережі";
      }
    });
  }

  const editSave = document.getElementById("netAliasEditSave");
  if (editSave) {
    editSave.addEventListener("click", async () => {
      const id = parseInt(editId && editId.value ? editId.value : "", 10);
      const nid = parseInt(editNetworkId && editNetworkId.value ? editNetworkId.value : "", 10);
      const aliasText = String(editText && editText.value ? editText.value : "").trimEnd();
      if (!id) return;
      if (!nid) {
        toast("Обери радіомережу з підказок (частота).", "error");
        return;
      }
      if (!aliasText.trim()) {
        toast("Аліас не може бути порожнім.", "error");
        return;
      }
      try {
        const resp = await fetch("/api/network-aliases/" + encodeURIComponent(id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ alias_text: aliasText, network_id: nid }),
        });
        const data = await resp.json();
        if (!resp.ok || !data.ok) {
          toast(data.error || "Не вдалося зберегти.", "error");
          return;
        }
        closeModal(editModal);
        toast("Збережено.", "info");
        await loadTable();
      } catch (e) {
        toast("Помилка збереження.", "error");
      }
    });
  }

  loadTable();
})();
