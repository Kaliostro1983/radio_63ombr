(function () {
  function $(id) {
    return document.getElementById(id);
  }

  const elFreq = $("csFreq");
  const elDays = $("csDays");
  const elShow = $("csShow");
  const elInfo = $("csInfo");
  const elTbody = $("csTbody");

  const tabFreq = $("csTabFreq");
  const tabSearch = $("csTabSearch");
  const paneFreq = $("csPaneFreq");
  const paneSearch = $("csPaneSearch");

  const elQuery = $("csQuery");
  const elSearch = $("csSearch");
  const elAdd = $("csAdd");
  const elSearchInfo = $("csSearchInfo");
  const elSearchTbody = $("csSearchTbody");

  function setInfo(text) {
    if (elInfo) elInfo.textContent = text || "";
  }

  function setSearchInfo(text) {
    if (elSearchInfo) elSearchInfo.textContent = text || "";
  }

  function escapeHtml(s) {
    return (s || "").replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  function renderCallsignNameCell(row) {
    return `
      <div class="callsign-name" style="font-weight:700">
        <img
          class="callsign-ico"
          src="/static/icons/callsign_statuses/${row.status_id || "_default"}.svg"
          alt=""
        >
        <span>${escapeHtml(row.name || "")}</span>
      </div>
    `;
  }

  function updateRowInFreqTable(updated) {
    if (!elTbody) return;
    const tr = elTbody.querySelector(
      `tr[data-callsign-id="${updated.callsign_id}"]`
    );
    if (!tr) return;

    tr.children[1].innerHTML = renderCallsignNameCell(updated);
    tr.children[2].textContent = updated.status_label || "";
    tr.children[3].textContent = updated.source_label || "";
    tr.children[4].textContent = updated.comment || "";
    tr.dataset.row = JSON.stringify(updated);
  }

  function updateRowInSearchTable(updated) {
    if (!elSearchTbody) return;
    const tr = elSearchTbody.querySelector(
      `tr[data-callsign-id="${updated.callsign_id}"]`
    );
    if (!tr) return;

    tr.children[1].innerHTML = renderCallsignNameCell(updated);
    tr.children[2].textContent = updated.status_label || "";
    tr.children[3].textContent = updated.frequency || "Невідомо";
    tr.children[4].textContent = updated.unit || "Невідомо";
    tr.dataset.row = JSON.stringify(updated);
  }

  function updateRowInTables(updated) {
    updateRowInFreqTable(updated);
    updateRowInSearchTable(updated);
  }

  function renderTable(rows) {
    if (!rows || rows.length === 0) {
      elTbody.innerHTML =
        '<tr><td colspan="5" class="small" style="opacity:.8">Нічого не знайдено.</td></tr>';
      return;
    }

    elTbody.innerHTML = "";
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      tr.dataset.callsignId = row.callsign_id;
      tr.dataset.row = JSON.stringify(row);

      const statusText = row.status_label || "";
      const sourceText = row.source_label || "";

      tr.innerHTML = `
        <td>${row.n}</td>
        <td>${renderCallsignNameCell(row)}</td>
        <td>${escapeHtml(statusText)}</td>
        <td>${escapeHtml(sourceText)}</td>
        <td>${escapeHtml(row.comment || "")}</td>
      `;

      tr.addEventListener("click", () => {
        if (window.openCallsignEditModalById) {
          window.openCallsignEditModalById(row.callsign_id);
        }
      });
      elTbody.appendChild(tr);
    });
  }

  function renderSearchTable(rows) {
    if (!rows || rows.length === 0) {
      elSearchTbody.innerHTML =
        '<tr><td colspan="5" class="small" style="opacity:.8">Нічого не знайдено.</td></tr>';
      return;
    }

    elSearchTbody.innerHTML = "";
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      tr.dataset.callsignId = row.callsign_id;
      tr.dataset.row = JSON.stringify(row);

      const statusText = row.status_label || "";
      tr.innerHTML = `
        <td>${row.n}</td>
        <td>${renderCallsignNameCell(row)}</td>
        <td>${escapeHtml(statusText)}</td>
        <td>${escapeHtml(row.frequency || "Невідомо")}</td>
        <td>${escapeHtml(row.unit || "Невідомо")}</td>
      `;

      tr.addEventListener("click", () => {
        if (window.openCallsignEditModalById) {
          window.openCallsignEditModalById(row.callsign_id);
        }
      });
      elSearchTbody.appendChild(tr);
    });
  }

  async function runQuery() {
    const frequency = (elFreq.value || "").trim();
    const days = (elDays.value || "7").trim();

    if (!frequency) {
      setInfo("Вкажіть частоту");
      return;
    }

    setInfo("Завантаження...");

    try {
      const url = `/api/callsigns/by-frequency?frequency=${encodeURIComponent(frequency)}&days=${encodeURIComponent(days)}`;
      const r = await fetch(url);

      if (!r.ok) throw new Error("HTTP " + r.status);

      const data = await r.json();

      if (!data.ok) {
        setInfo("Помилка");
        elTbody.innerHTML = `<tr><td colspan="5" class="small" style="color:var(--danger)">${escapeHtml(data.error || "Помилка")}</td></tr>`;
        return;
      }

      const rows = data.rows || [];
      if (rows.length === 0 && data.message) {
        setInfo(data.message);
        elTbody.innerHTML = `<tr><td colspan="5" class="small" style="opacity:.85">${escapeHtml(data.message)}</td></tr>`;
        return;
      }

      setInfo(`Знайдено: ${rows.length}`);
      renderTable(rows);
    } catch (e) {
      console.error(e);
      setInfo("Помилка запиту");
      elTbody.innerHTML = `<tr><td colspan="5" class="small" style="color:var(--danger)">Помилка запиту. Перевірте лог сервера.</td></tr>`;
    }
  }

  async function runSearch() {
    let q = (elQuery.value || "").trim();
    q = q.toUpperCase();
    elQuery.value = q;

    if (!q) {
      setSearchInfo("Вкажіть позивний");
      return;
    }

    setSearchInfo("Завантаження...");

    try {
      const url = `/api/callsigns/search?q=${encodeURIComponent(q)}`;
      const r = await fetch(url);

      if (!r.ok) throw new Error("HTTP " + r.status);

      const data = await r.json();

      if (!data.ok) {
        setSearchInfo("Помилка");
        elSearchTbody.innerHTML = `<tr><td colspan="5" class="small" style="color:var(--danger)">${escapeHtml(data.error || "Помилка")}</td></tr>`;
        return;
      }

      const rows = data.rows || [];
      setSearchInfo(`Знайдено: ${rows.length}`);
      renderSearchTable(rows);
    } catch (e) {
      console.error(e);
      setSearchInfo("Помилка запиту");
      elSearchTbody.innerHTML = `<tr><td colspan="5" class="small" style="color:var(--danger)">Помилка запиту. Перевірте лог сервера.</td></tr>`;
    }
  }

  function setTab(which) {
    const isFreq = which === "freq";

    if (tabFreq) {
      tabFreq.classList.toggle("active", isFreq);
      tabFreq.setAttribute("aria-selected", isFreq ? "true" : "false");
    }
    if (tabSearch) {
      tabSearch.classList.toggle("active", !isFreq);
      tabSearch.setAttribute("aria-selected", isFreq ? "false" : "true");
    }
    if (paneFreq) paneFreq.classList.toggle("hidden", !isFreq);
    if (paneSearch) paneSearch.classList.toggle("hidden", isFreq);

    if (!isFreq) setInfo("");
    if (isFreq) setSearchInfo("");
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (!elShow) return;

    if (window.setCallsignModalOnSave) {
      window.setCallsignModalOnSave(updateRowInTables);
    }

    if (tabFreq) tabFreq.addEventListener("click", () => setTab("freq"));
    if (tabSearch) tabSearch.addEventListener("click", () => setTab("search"));

    elShow.addEventListener("click", runQuery);
    if (elFreq) elFreq.addEventListener("keydown", (e) => { if (e.key === "Enter") runQuery(); });
    if (elDays) elDays.addEventListener("keydown", (e) => { if (e.key === "Enter") runQuery(); });

    if (elSearch) elSearch.addEventListener("click", runSearch);
    if (elAdd) {
      elAdd.addEventListener("click", () => {
        if (window.openCallsignCreateModal) window.openCallsignCreateModal();
      });
    }

    if (elQuery) elQuery.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
    if (elQuery) {
      elQuery.addEventListener("blur", () => {
        const v = (elQuery.value || "").trim().toUpperCase();
        elQuery.value = v;
      });
    }
  });
})();
