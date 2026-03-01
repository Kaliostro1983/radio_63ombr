(function(){
  function $(id){ return document.getElementById(id); }

  const elFreq = $("csFreq");
  const elDays = $("csDays");
  const elShow = $("csShow");
  const elInfo = $("csInfo");
  const elTbody = $("csTbody");

  // tabs
  const tabFreq = $("csTabFreq");
  const tabSearch = $("csTabSearch");
  const tabLabel = $("csTabLabel");
  const paneFreq = $("csPaneFreq");
  const paneSearch = $("csPaneSearch");

  // search pane
  const elQuery = $("csQuery");
  const elSearch = $("csSearch");
  const elAdd = $("csAdd");
  const elSearchInfo = $("csSearchInfo");
  const elSearchTbody = $("csSearchTbody");

  const modal = $("csModal");
  const modalId = $("csModalId");
  const modalTitle = $("csModalTitle");
  const modalName = $("csModalName");
  const modalStatus = $("csModalStatus");
  const modalComment = $("csModalComment");
  const modalNetworkQuery = $("csModalNetworkQuery");
  const modalNetwork = $("csModalNetwork");
  const modalErr = $("csModalErr");
  const btnSave = $("csSave");

  const statusModal = $("csStatusModal");
  const newStatusName = $("csNewStatusName");
  const newStatusErr = $("csNewStatusErr");
  const btnCreateStatus = $("csCreateStatus");

  let STATUS_LIST = []; // [{id, name}]
  let CURRENT_ROW = null; // row object
  let CURRENT_STATUS_ID = null;
  let CURRENT_NETWORK_ID = null; // single status id

  function setInfo(text){
    if(elInfo) elInfo.textContent = text || "";
  }

  function setSearchInfo(text){
    if(elSearchInfo) elSearchInfo.textContent = text || "";
  }

  function escapeHtml(s){
    return (s || "").replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  
  function openCreateModal(){
    CURRENT_ROW = null;
    modalId.value = "";
    modalTitle.textContent = "Новий позивний";
    modalName.value = "";
    modalComment.value = "";
    CURRENT_STATUS_ID = null;
    CURRENT_NETWORK_ID = null;
    renderStatusSelect(CURRENT_STATUS_ID);
    modalNetworkQuery.value = "";
    renderNetworkSelect([], CURRENT_NETWORK_ID);
    openModal();
    setTimeout(() => modalName.focus(), 0);
  }
function openModal(){
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal(){
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    CURRENT_ROW = null;
    CURRENT_STATUS_ID = null;
    modalErr.style.display = "none";
    modalErr.textContent = "";
  }

  function openStatusModal(){
    if(!statusModal) return;
    newStatusErr.style.display = "none";
    newStatusErr.textContent = "";
    newStatusName.value = "";
    statusModal.classList.remove("hidden");
    statusModal.setAttribute("aria-hidden", "false");
    setTimeout(() => newStatusName.focus(), 0);
  }

  function closeStatusModal(){
    if(!statusModal) return;
    statusModal.classList.add("hidden");
    statusModal.setAttribute("aria-hidden", "true");
  }

  function showStatusError(msg){
    newStatusErr.textContent = msg;
    newStatusErr.style.display = "block";
  }

  function showError(msg){
    modalErr.textContent = msg;
    modalErr.style.display = "block";
  }

  async function loadStatuses(){
    try{
      const r = await fetch("/api/callsigns/statuses");
      if(!r.ok) throw new Error("HTTP " + r.status);
      STATUS_LIST = await r.json();
    } catch(e){
      console.error(e);
      STATUS_LIST = [];
    }
  }

  
  function renderNetworkSelect(networks, selectedId){
    const sel = modalNetwork;
    const keepUnknown = sel.options.length && sel.options[0].value === "";
    sel.innerHTML = "";
    // Unknown
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "Невідомо";
    sel.appendChild(opt0);

    (networks || []).forEach(n => {
      const opt = document.createElement("option");
      opt.value = String(n.id);
      opt.textContent = `${n.frequency || '—'} / ${n.mask || '—'} — ${n.unit || ''}`.trim();
      sel.appendChild(opt);
    });

    if (selectedId){
      sel.value = String(selectedId);
    } else {
      sel.value = "";
    }
  }

  let NET_LOOKUP_TIMER = null;
  async function lookupNetworks(q){
    const qs = (q || "").trim();
    if (!qs){
      renderNetworkSelect([], CURRENT_NETWORK_ID);
      return;
    }
    try{
      const resp = await fetch(`/api/networks/lookup?q=${encodeURIComponent(qs)}`);
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "lookup failed");
      renderNetworkSelect(data.rows || [], CURRENT_NETWORK_ID);
    }catch(e){
      // keep unknown only
      renderNetworkSelect([], CURRENT_NETWORK_ID);
    }
  }
function renderStatusSelect(selectedId){
    if(!modalStatus) return;
    modalStatus.innerHTML = "";

    const optEmpty = document.createElement("option");
    optEmpty.value = "";
    optEmpty.textContent = "— не вказано —";
    modalStatus.appendChild(optEmpty);

    STATUS_LIST.forEach(s => {
      const opt = document.createElement("option");
      opt.value = String(s.id);
      opt.textContent = s.name;
      modalStatus.appendChild(opt);
    });

    const optAdd = document.createElement("option");
    optAdd.value = "__add__";
    optAdd.textContent = "— Додати статус —";
    modalStatus.appendChild(optAdd);

    if(selectedId){
      modalStatus.value = String(selectedId);
    } else {
      modalStatus.value = "";
    }
  }

  function renderTable(rows){
    if(!rows || rows.length === 0){
      elTbody.innerHTML = '<tr><td colspan="4" class="small" style="opacity:.8">Нічого не знайдено.</td></tr>';
      return;
    }
    elTbody.innerHTML = "";
    rows.forEach(row => {
      const tr = document.createElement("tr");
      tr.dataset.callsignId = row.callsign_id;
      tr.dataset.row = JSON.stringify(row);

      const statusText = row.status_label || "";
      tr.innerHTML = `
        <td>${row.n}</td>
        <td style="font-weight:700">${escapeHtml(row.name)}</td>
        <td>${escapeHtml(statusText)}</td>
        <td>${escapeHtml(row.comment || "")}</td>
      `;

      tr.addEventListener("click", () => openEditModal(row));
      elTbody.appendChild(tr);
    });
  }

  function renderSearchTable(rows){
    if(!rows || rows.length === 0){
      elSearchTbody.innerHTML = '<tr><td colspan="5" class="small" style="opacity:.8">Нічого не знайдено.</td></tr>';
      return;
    }
    elSearchTbody.innerHTML = "";
    rows.forEach(row => {
      const tr = document.createElement("tr");
      tr.dataset.callsignId = row.callsign_id;
      tr.dataset.row = JSON.stringify(row);

      const statusText = row.status_label || "";
      tr.innerHTML = `
        <td>${row.n}</td>
        <td style="font-weight:700">${escapeHtml(row.name)}</td>
        <td>${escapeHtml(statusText)}</td>
        <td>${escapeHtml(row.frequency || "Невідомо")}</td>
        <td>${escapeHtml(row.unit || "Невідомо")}</td>
      `;
      tr.addEventListener("click", () => openEditModal(row));
      elSearchTbody.appendChild(tr);
    });
  }

  function updateRowInFreqTable(updated){
    const tr = elTbody && elTbody.querySelector(`tr[data-callsign-id="${updated.callsign_id}"]`);
    if(!tr) return;
    tr.children[1].textContent = updated.name;
    tr.children[2].textContent = updated.status_label || "";
    tr.children[3].textContent = updated.comment || "";
  }

  function updateRowInSearchTable(updated){
    const tr = elSearchTbody && elSearchTbody.querySelector(`tr[data-callsign-id="${updated.callsign_id}"]`);
    if(!tr) return;
    tr.children[1].textContent = updated.name;
    tr.children[2].textContent = updated.status_label || "";
    tr.children[3].textContent = updated.frequency || "Невідомо";
    tr.children[4].textContent = updated.unit || "Невідомо";
  }

  function updateRowInTables(updated){
    updateRowInFreqTable(updated);
    updateRowInSearchTable(updated);
  }

  function openEditModal(row){
    CURRENT_ROW = row;
    modalId.value = row.callsign_id || "";
    modalTitle.textContent = row.name;
    modalName.value = row.name;
    modalComment.value = row.comment || "";
    CURRENT_STATUS_ID = row.status_id || null;
    CURRENT_NETWORK_ID = row.network_id || null;
    // network UI
    modalNetworkQuery.value = "";
    renderNetworkSelect([], CURRENT_NETWORK_ID);

    renderStatusSelect(CURRENT_STATUS_ID);
    openModal();
    setTimeout(() => modalName.focus(), 0);
  }

  async function runQuery(){
    const frequency = (elFreq.value || "").trim();
    const days = (elDays.value || "7").trim();
    if(!frequency){
      setInfo("Вкажіть частоту");
      return;
    }
    setInfo("Завантаження...");
    try{
      const url = `/api/callsigns/by-frequency?frequency=${encodeURIComponent(frequency)}&days=${encodeURIComponent(days)}`;
      const r = await fetch(url);
      if(!r.ok){
        throw new Error("HTTP " + r.status);
      }
      const data = await r.json();
      if(!data.ok){
        setInfo("Помилка");
        elTbody.innerHTML = `<tr><td colspan="4" class="small" style="color:var(--danger)">${escapeHtml(data.error || "Помилка")}</td></tr>`;
        return;
      }
      const rows = data.rows || [];
      setInfo(`Знайдено: ${rows.length}`);
      renderTable(rows);
    } catch(e){
      console.error(e);
      setInfo("Помилка запиту");
      elTbody.innerHTML = `<tr><td colspan="4" class="small" style="color:var(--danger)">Помилка запиту. Перевірте лог сервера.</td></tr>`;
    }
  }

  async function runSearch(){
    let q = (elQuery.value || "").trim();
    q = q.toUpperCase();
    elQuery.value = q;
    if(!q){
      setSearchInfo("Вкажіть позивний");
      return;
    }
    setSearchInfo("Завантаження...");
    try{
      const url = `/api/callsigns/search?q=${encodeURIComponent(q)}`;
      const r = await fetch(url);
      if(!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      if(!data.ok){
        setSearchInfo("Помилка");
        elSearchTbody.innerHTML = `<tr><td colspan="5" class="small" style="color:var(--danger)">${escapeHtml(data.error || "Помилка")}</td></tr>`;
        return;
      }
      const rows = data.rows || [];
      setSearchInfo(`Знайдено: ${rows.length}`);
      renderSearchTable(rows);
    } catch(e){
      console.error(e);
      setSearchInfo("Помилка запиту");
      elSearchTbody.innerHTML = `<tr><td colspan="5" class="small" style="color:var(--danger)">Помилка запиту. Перевірте лог сервера.</td></tr>`;
    }
  }

  async function saveModal(){
    modalErr.style.display = "none";
    const callsign_id = parseInt(modalId.value, 10);
    const name = (modalName.value || "").trim();
    const comment = (modalComment.value || "").trim();
    const status_id = (modalStatus && modalStatus.value && modalStatus.value !== "__add__") ? parseInt(modalStatus.value, 10) : null;

    if(!name){
      showError("Позивний не може бути порожнім");
      return;
    }

    btnSave.disabled = true;
    try{
      const r = await fetch("/api/callsigns/save", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({callsign_id, name, comment, status_id, network_id: (modalNetwork && modalNetwork.value) ? parseInt(modalNetwork.value, 10) : null})
      });
      const data = await r.json();
      if(!data.ok){
        showError(data.error || "Помилка збереження");
        return;
      }
      updateRowInTables(data);
      closeModal();
    } finally {
      btnSave.disabled = false;
    }
  }

  function setTab(which){
    const isFreq = which === "freq";
    if(tabFreq) tabFreq.classList.toggle("active", isFreq);
    if(tabSearch) tabSearch.classList.toggle("active", !isFreq);
    if(paneFreq) paneFreq.classList.toggle("hidden", !isFreq);
    if(paneSearch) paneSearch.classList.toggle("hidden", isFreq);
    if(tabLabel) tabLabel.textContent = isFreq ? "Позивні р/м" : "Пошук/правка";
    // reset small infos
    if(!isFreq) setInfo("");
    if(isFreq) setSearchInfo("");
  }

  // wire
  document.addEventListener("DOMContentLoaded", async () => {
    if(!elShow) return;
    await loadStatuses();

    if(modalNetwork){ modalNetwork.addEventListener('change', () => { CURRENT_NETWORK_ID = modalNetwork.value ? parseInt(modalNetwork.value,10) : null; }); }

    // tabs
    if(tabFreq) tabFreq.addEventListener("click", () => setTab("freq"));
    if(tabSearch) tabSearch.addEventListener("click", () => setTab("search"));

    elShow.addEventListener("click", runQuery);
    elFreq.addEventListener("keydown", (e) => { if(e.key === "Enter") runQuery(); });
    elDays.addEventListener("keydown", (e) => { if(e.key === "Enter") runQuery(); });

    if(elSearch) elSearch.addEventListener("click", runSearch);
  if (elAdd){ elAdd.addEventListener("click", openCreateModal); }

    if(elQuery) elQuery.addEventListener("keydown", (e) => { if(e.key === "Enter") runSearch(); });
    if(elQuery) elQuery.addEventListener("blur", () => {
      const v = (elQuery.value || "").trim().toUpperCase();
      elQuery.value = v;
    });

    btnSave.addEventListener("click", saveModal);

    if(modalStatus){
      modalNetworkQuery.addEventListener("input", ()=>{
    clearTimeout(NET_LOOKUP_TIMER);
    const q = modalNetworkQuery.value || "";
    NET_LOOKUP_TIMER = setTimeout(()=> lookupNetworks(q), 250);
  });
  modalNetwork.addEventListener("change", ()=>{
    const v = modalNetwork.value;
    CURRENT_NETWORK_ID = v ? parseInt(v,10) : null;
  });

  modalStatus.addEventListener("change", () => {
        if(modalStatus.value === "__add__"){
          // reset selection visually and open mini-modal
          modalStatus.value = CURRENT_STATUS_ID ? String(CURRENT_STATUS_ID) : "";
          openStatusModal();
        } else {
          const v = parseInt(modalStatus.value, 10);
          CURRENT_STATUS_ID = Number.isFinite(v) ? v : null;
        }
      });
    }

    if(btnCreateStatus){
      btnCreateStatus.addEventListener("click", async () => {
        const name = (newStatusName.value || "").trim();
        if(!name){
          showStatusError("Вкажіть назву статусу");
          return;
        }
        btnCreateStatus.disabled = true;
        try{
          const r = await fetch("/api/callsigns/statuses", {
            method: "POST",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify({name})
          });
          const data = await r.json();
          if(!data.ok){
            showStatusError(data.error || "Не вдалося створити статус");
            return;
          }
          await loadStatuses();

    if(modalNetwork){ modalNetwork.addEventListener('change', () => { CURRENT_NETWORK_ID = modalNetwork.value ? parseInt(modalNetwork.value,10) : null; }); }
          CURRENT_STATUS_ID = data.id;
          renderStatusSelect(CURRENT_STATUS_ID);
          closeStatusModal();
        } catch(e){
          console.error(e);
          showStatusError("Помилка запиту");
        } finally {
          btnCreateStatus.disabled = false;
        }
      });
    }

    modal.addEventListener("click", (e) => {
      const t = e.target;
      if(t && t.getAttribute && t.getAttribute("data-close") === "1") closeModal();
    });

    if(statusModal){
      statusModal.addEventListener("click", (e) => {
        const t = e.target;
        if(t && t.getAttribute && t.getAttribute("data-close-status") === "1") closeStatusModal();
      });
    }
    document.addEventListener("keydown", (e) => {
      if(e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
      if(e.key === "Escape" && statusModal && !statusModal.classList.contains("hidden")) closeStatusModal();
    });
  });
})();
