/**
 * Shared callsign edit modal. Used on /callsigns and /intercepts-explorer.
 * Exposes: openCallsignEditModalById(id, context), openCallsignCreateModal(), setCallsignModalOnSave(fn).
 * context is optional and passed to the onSave callback when user saves.
 */
(function () {
  function $(id) {
    return document.getElementById(id);
  }

  const modal = $("csModal");
  const modalId = $("csModalId");
  const modalTitle = $("csModalTitle");
  const modalName = $("csModalName");
  const modalStatus = $("csModalStatus");
  const modalSource = $("csModalSource");
  const modalComment = $("csModalComment");
  const modalNetworkQuery = $("csModalNetworkQuery");
  const modalNetwork = $("csModalNetwork");
  const modalPhoto = $("csModalPhoto");
  const modalErr = $("csModalErr");
  const btnSave = $("csSave");
  const btnDelete = $("csDelete");
  const btnMerge = $("csMerge");
  const mergePanel = $("csMergePanel");
  const mergeQuery = $("csMergeQuery");
  const mergeSuggestions = $("csMergeSuggestions");
  const mergeTargetName = $("csMergeTargetName");
  const mergeTargetId = $("csMergeTargetId");
  const mergeErr = $("csMergeErr");
  const mergeConfirm = $("csMergeConfirm");
  const mergeCancel = $("csMergeCancel");
  const btnOpenIntercepts = $("csOpenIntercepts");
  const btnOpenLinks = $("csOpenLinks");
  const quickWrap = $("csQuickId");

  const statusModal = $("csStatusModal");
  const newStatusName = $("csNewStatusName");
  const newStatusErr = $("csNewStatusErr");
  const btnCreateStatus = $("csCreateStatus");

  let STATUS_LIST = [];
  let SOURCE_LIST = [];
  let CURRENT_STATUS_ID = null;
  let CURRENT_SOURCE_ID = null;
  let CURRENT_NETWORK_ID = null;
  let OPEN_CONTEXT = null; // passed to onSave when saving
  let onSaveCallback = null;

  // Optional: limit quick buttons to specific status ids.
  // Set to null to show all statuses.
  const QUICK_STATUS_WHITELIST = null;

  function toDatetimeLocalValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  async function openInterceptsForCurrent() {
    const callsignName = (modalName && modalName.value ? String(modalName.value) : "").trim();
    if (!callsignName) return;

    const now = new Date();
    const end = toDatetimeLocalValue(now);
    const startDate = new Date(now);
    startDate.setDate(startDate.getDate() - 10);
    const start = toDatetimeLocalValue(startDate);

    const params = new URLSearchParams();
    params.set("period_start", start);
    params.set("period_end", end);
    params.set("callsign", callsignName);

    // Try to derive a compact network token without async calls.
    // Prefer frequency, fall back to mask, from the select option label.
    let networkToken = "";
    try {
      if (modalNetwork && modalNetwork.value) {
        const opt = modalNetwork.options ? modalNetwork.options[modalNetwork.selectedIndex] : null;
        const txt = opt && opt.textContent ? String(opt.textContent) : "";
        // Format: "146.6350 / 300.3010 — unit"
        const head = txt.split("—")[0] || "";
        const parts = head.split("/").map((s) => s.trim()).filter(Boolean);
        const freq = parts[0] && parts[0] !== "—" ? parts[0] : "";
        const mask = parts[1] && parts[1] !== "—" ? parts[1] : "";
        networkToken = freq || mask || "";
      }
    } catch (e) {
      networkToken = "";
    }
    if (networkToken) params.set("network", networkToken);

    // Open directly with final URL (sync) to avoid popup blockers and blank tabs.
    const url = `/intercepts-explorer?${params.toString()}`;
    const w = window.open(url, "_blank", "noopener");
    if (!w) {
      showError("Браузер заблокував відкриття вкладки. Дозволь popups для цього сайту.");
    }
  }

  function openLinksForCurrent() {
    const callsignId = modalId && modalId.value ? parseInt(modalId.value, 10) : 0;
    if (!callsignId) return;
    const days = 14;
    const adv = 0;
    const url = `/callsigns?tab=links&callsign_id=${encodeURIComponent(callsignId)}&days=${encodeURIComponent(days)}&advanced=${encodeURIComponent(adv)}`;
    const w = window.open(url, "_blank", "noopener");
    if (!w) {
      showError("Браузер заблокував відкриття вкладки. Дозволь popups для цього сайту.");
    }
  }

  function setPhotoForStatus(statusId) {
    if (!modalPhoto) return;
    const base = "/static/photos/callsign_statuses/";
    const defWebp = base + "_default.webp";
    const defPng = base + "_default.png";

    if (!statusId) {
      modalPhoto.src = defWebp;
      modalPhoto.dataset.photoTry = "default";
      return;
    }

    modalPhoto.dataset.photoTry = "webp";
    modalPhoto.src = base + String(statusId) + ".webp";

    modalPhoto.onerror = function () {
      const t = modalPhoto.dataset.photoTry || "";
      if (t === "webp") {
        modalPhoto.dataset.photoTry = "png";
        modalPhoto.src = base + String(statusId) + ".png";
        return;
      }
      modalPhoto.onerror = null;
      modalPhoto.src = defWebp;
      modalPhoto.addEventListener("error", function () {
        modalPhoto.src = defPng;
      }, { once: true });
    };
  }

  async function preselectNetworkById(networkId) {
    if (!modalNetwork) return;
    if (!networkId) {
      renderNetworkSelect([], null);
      return;
    }
    try {
      const resp = await fetch(
        `/api/networks/by-id?id=${encodeURIComponent(networkId)}`
      );
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "by-id failed");
      if (data.row) {
        renderNetworkSelect([data.row], networkId);
      } else {
        renderNetworkSelect([], null);
      }
    } catch (e) {
      renderNetworkSelect([], networkId);
    }
  }

  function renderNetworkSelect(networks, selectedId) {
    const sel = modalNetwork;
    if (!sel) return;
    sel.innerHTML = "";

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "Невідомо";
    sel.appendChild(opt0);

    (networks || []).forEach(function (n) {
      const opt = document.createElement("option");
      opt.value = String(n.id);
      opt.textContent = `${n.frequency || "—"} / ${n.mask || "—"} — ${n.unit || ""}`.trim();
      sel.appendChild(opt);
    });

    if (selectedId) {
      sel.value = String(selectedId);
    } else {
      sel.value = "";
    }
  }

  let NET_LOOKUP_TIMER = null;

  async function lookupNetworks(q) {
    const qs = (q || "").trim();
    if (!qs) {
      renderNetworkSelect([], CURRENT_NETWORK_ID);
      return;
    }
    try {
      const resp = await fetch(
        `/api/networks/lookup?q=${encodeURIComponent(qs)}`
      );
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "lookup failed");
      renderNetworkSelect(data.rows || [], CURRENT_NETWORK_ID);
    } catch (e) {
      renderNetworkSelect([], CURRENT_NETWORK_ID);
    }
  }

  function renderStatusSelect(selectedId) {
    if (!modalStatus) return;
    modalStatus.innerHTML = "";

    const optEmpty = document.createElement("option");
    optEmpty.value = "";
    optEmpty.textContent = "— не вказано —";
    modalStatus.appendChild(optEmpty);

    STATUS_LIST.forEach(function (s) {
      const opt = document.createElement("option");
      opt.value = String(s.id);
      opt.textContent = s.name;
      modalStatus.appendChild(opt);
    });

    const optAdd = document.createElement("option");
    optAdd.value = "__add__";
    optAdd.textContent = "— Додати статус —";
    modalStatus.appendChild(optAdd);

    if (selectedId) {
      modalStatus.value = String(selectedId);
    } else {
      modalStatus.value = "";
    }
  }

  function renderSourceSelect(selectedId) {
    if (!modalSource) return;
    modalSource.innerHTML = "";

    const optEmpty = document.createElement("option");
    optEmpty.value = "";
    optEmpty.textContent = "— не вказано —";
    modalSource.appendChild(optEmpty);

    SOURCE_LIST.forEach(function (s) {
      const opt = document.createElement("option");
      opt.value = String(s.id);
      opt.textContent = s.name;
      modalSource.appendChild(opt);
    });

    if (selectedId) {
      modalSource.value = String(selectedId);
    } else {
      modalSource.value = "";
    }
  }

  function getSourceIdByName(sourceName) {
    const n = String(sourceName || "").trim().toLowerCase();
    if (!n) return null;
    for (const s of SOURCE_LIST) {
      if (String(s?.name || "").trim().toLowerCase() === n) return s.id;
    }
    return null;
  }

  function renderQuickIdButtons() {
    if (!quickWrap) return;
    if (!Array.isArray(STATUS_LIST) || !STATUS_LIST.length) return;

    const rerSourceId = getSourceIdByName("РЕР");
    if (rerSourceId == null) return;

    const list = QUICK_STATUS_WHITELIST
      ? STATUS_LIST.filter((s) => QUICK_STATUS_WHITELIST.includes(Number(s.id)))
      : STATUS_LIST;

    quickWrap.innerHTML = "";

    for (const s of list) {
      const sid = Number(s.id);
      if (!Number.isFinite(sid)) continue;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cs-quickid-btn";
      btn.dataset.statusId = String(sid);
      btn.title = String(s.name || sid);

      const img = document.createElement("img");
      img.alt = String(s.name || sid);
      img.src = `/static/icons/callsign_statuses/${sid}.svg`;
      img.onerror = function () {
        this.onerror = null;
        this.src = "/static/icons/callsign_statuses/_default.svg";
      };

      btn.appendChild(img);
      btn.addEventListener("click", function () {
        CURRENT_STATUS_ID = sid;
        if (modalStatus) modalStatus.value = String(sid);
        setPhotoForStatus(CURRENT_STATUS_ID);

        CURRENT_SOURCE_ID = Number(rerSourceId);
        if (modalSource) modalSource.value = String(CURRENT_SOURCE_ID);
        try {
          modalSource.dispatchEvent(new Event("change"));
        } catch (e) {}
      });

      quickWrap.appendChild(btn);
    }
  }

  function openModal() {
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    CURRENT_STATUS_ID = null;
    CURRENT_SOURCE_ID = null;
    OPEN_CONTEXT = null;
    if (modalErr) {
      modalErr.style.display = "none";
      modalErr.textContent = "";
    }
    hideMergePanel();
  }

  function showError(msg) {
    if (!modalErr) return;
    modalErr.textContent = msg;
    modalErr.style.display = "block";
  }

  function openStatusModal() {
    if (!statusModal) return;
    if (newStatusErr) {
      newStatusErr.style.display = "none";
      newStatusErr.textContent = "";
    }
    if (newStatusName) newStatusName.value = "";
    statusModal.classList.remove("hidden");
    statusModal.setAttribute("aria-hidden", "false");
    setTimeout(function () {
      if (newStatusName) newStatusName.focus();
    }, 0);
  }

  function closeStatusModal() {
    if (!statusModal) return;
    statusModal.classList.add("hidden");
    statusModal.setAttribute("aria-hidden", "true");
  }

  function showStatusError(msg) {
    if (!newStatusErr) return;
    newStatusErr.textContent = msg;
    newStatusErr.style.display = "block";
  }

  async function loadStatuses() {
    try {
      const r = await fetch("/api/callsigns/statuses");
      if (!r.ok) throw new Error("HTTP " + r.status);
      STATUS_LIST = await r.json();
    } catch (e) {
      console.error(e);
      STATUS_LIST = [];
    }
  }

  async function loadSources() {
    try {
      const r = await fetch("/api/callsigns/sources");
      if (!r.ok) throw new Error("HTTP " + r.status);
      SOURCE_LIST = await r.json();
    } catch (e) {
      console.error(e);
      SOURCE_LIST = [];
    }
  }

  function fillEditModal(row, context) {
    OPEN_CONTEXT = context || null;
    if (modalId) modalId.value = row.callsign_id || "";
    if (modalTitle) modalTitle.textContent = row.name || "—";
    if (modalName) modalName.value = row.name || "";
    if (modalComment) modalComment.value = row.comment || "";
    CURRENT_STATUS_ID = row.status_id || null;
    CURRENT_SOURCE_ID = row.source_id || null;
    CURRENT_NETWORK_ID = row.network_id || null;

    if (modalNetworkQuery) modalNetworkQuery.value = "";
    renderNetworkSelect([], CURRENT_NETWORK_ID);
    preselectNetworkById(CURRENT_NETWORK_ID);

    setPhotoForStatus(CURRENT_STATUS_ID);
    renderStatusSelect(CURRENT_STATUS_ID);
    renderSourceSelect(CURRENT_SOURCE_ID);
    renderQuickIdButtons();
    if (btnDelete) btnDelete.style.display = "inline-block";

    openModal();
    setTimeout(function () {
      if (modalName) modalName.focus();
    }, 0);
  }

  async function openEditModalById(callsignId, context) {
    const cid = callsignId || "";
    if (!cid) return;

    try {
      const resp = await fetch(
        `/api/callsigns/by-id?id=${encodeURIComponent(cid)}`
      );
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "by-id failed");
      if (!data.row) return;
      fillEditModal(data.row, context);
    } catch (e) {
      console.error(e);
    }
  }

  function openCreateModal() {
    OPEN_CONTEXT = null;
    if (modalId) modalId.value = "";
    if (modalTitle) modalTitle.textContent = "Новий позивний";
    if (modalName) modalName.value = "";
    if (modalComment) modalComment.value = "";
    CURRENT_STATUS_ID = null;
    CURRENT_SOURCE_ID = null;
    CURRENT_NETWORK_ID = null;

    renderStatusSelect(CURRENT_STATUS_ID);
    renderSourceSelect(CURRENT_SOURCE_ID);
    setPhotoForStatus(CURRENT_STATUS_ID);
    if (btnDelete) btnDelete.style.display = "none";

    if (modalNetworkQuery) modalNetworkQuery.value = "";
    renderNetworkSelect([], CURRENT_NETWORK_ID);

    openModal();
    setTimeout(function () {
      if (modalName) modalName.focus();
    }, 0);

    renderQuickIdButtons();
  }

  async function saveModal() {
    if (!modalErr) return;
    modalErr.style.display = "none";

    const callsign_id = parseInt(modalId.value, 10);
    const name = (modalName.value || "").trim();
    const comment = (modalComment.value || "").trim();
    const status_id =
      modalStatus &&
      modalStatus.value &&
      modalStatus.value !== "__add__"
        ? parseInt(modalStatus.value, 10)
        : null;
    const source_id =
      modalSource && modalSource.value
        ? parseInt(modalSource.value, 10)
        : null;

    if (!name) {
      showError("Позивний не може бути порожнім");
      return;
    }

    if (btnSave) btnSave.disabled = true;

    try {
      const r = await fetch("/api/callsigns/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callsign_id,
          name,
          comment,
          status_id,
          source_id,
          network_id:
            modalNetwork && modalNetwork.value
              ? parseInt(modalNetwork.value, 10)
              : null,
        }),
      });

      const data = await r.json();

      if (!data.ok) {
        showError(data.error || "Помилка збереження");
        return;
      }

      const context = OPEN_CONTEXT;
      closeModal();
      if (window.appToast) window.appToast("Збережено.", "info", 1400);
      if (typeof onSaveCallback === "function") {
        onSaveCallback(data, context);
      }
      try {
        window.dispatchEvent(new CustomEvent("callsignModalSaved", { detail: { data: data, context: context || {} } }));
      } catch (e) {}
    } finally {
      if (btnSave) btnSave.disabled = false;
    }
  }

  async function deleteModalCallsign() {
    if (!modalErr) return;
    modalErr.style.display = "none";

    const callsign_id = parseInt(modalId && modalId.value ? modalId.value : "0", 10);
    if (!callsign_id) {
      showError("Видалення доступне лише для існуючого позивного");
      return;
    }

    const callsignName = (modalName && modalName.value ? String(modalName.value) : "").trim();
    const ok = window.confirm(
      `Видалити позивний "${callsignName || callsign_id}" з БД та очистити пов'язані зв'язки?`
    );
    if (!ok) return;

    if (btnDelete) btnDelete.disabled = true;
    if (btnSave) btnSave.disabled = true;

    try {
      const r = await fetch("/api/callsigns/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callsign_id }),
      });
      const data = await r.json();
      if (!data.ok) {
        showError(data.error || "Помилка видалення");
        return;
      }

      const context = OPEN_CONTEXT;
      closeModal();
      try {
        window.dispatchEvent(
          new CustomEvent("callsignModalDeleted", { detail: { data: data, context: context || {} } })
        );
      } catch (e) {}
    } catch (e) {
      console.error(e);
      showError("Помилка запиту");
    } finally {
      if (btnDelete) btnDelete.disabled = false;
      if (btnSave) btnSave.disabled = false;
    }
  }

  function hideMergePanel() {
    if (mergePanel) mergePanel.style.display = "none";
    if (mergeQuery) mergeQuery.value = "";
    if (mergeSuggestions) { mergeSuggestions.style.display = "none"; mergeSuggestions.innerHTML = ""; }
    if (mergeTargetId) mergeTargetId.value = "";
    if (mergeTargetName) mergeTargetName.textContent = "—";
    if (mergeErr) mergeErr.style.display = "none";
  }

  async function mergeCallsign() {
    const source_id = parseInt(modalId && modalId.value ? modalId.value : "0", 10);
    const target_id = parseInt(mergeTargetId && mergeTargetId.value ? mergeTargetId.value : "0", 10);
    const sourceName = (modalName && modalName.value ? modalName.value : "").trim();
    const targetName = (mergeTargetName ? mergeTargetName.textContent : "").trim();

    if (!source_id || !target_id) {
      if (mergeErr) { mergeErr.textContent = "Обери правильний позивний зі списку."; mergeErr.style.display = ""; }
      return;
    }
    if (!window.confirm(`Злити "${sourceName}" → "${targetName}"?\n\nВсі перехоплення будуть переписані на "${targetName}", а "${sourceName}" видалено.`)) return;

    if (mergeConfirm) mergeConfirm.disabled = true;

    try {
      const r = await fetch("/api/callsigns/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_id, target_id }),
      });
      const data = await r.json();
      if (!data.ok) {
        if (mergeErr) { mergeErr.textContent = data.error || "Помилка злиття"; mergeErr.style.display = ""; }
        return;
      }
      const context = OPEN_CONTEXT;
      closeModal();
      if (window.appToast) window.appToast(`"${sourceName}" злито в "${targetName}".`, "success", 2500);
      try {
        window.dispatchEvent(new CustomEvent("callsignModalDeleted", { detail: { data, context: context || {} } }));
      } catch (e) {}
    } catch (e) {
      if (mergeErr) { mergeErr.textContent = "Помилка запиту"; mergeErr.style.display = ""; }
    } finally {
      if (mergeConfirm) mergeConfirm.disabled = false;
    }
  }

  function setCallsignModalOnSave(fn) {
    onSaveCallback = typeof fn === "function" ? fn : null;
  }

  function init() {
    if (!modal || !btnSave) return;

    Promise.all([loadStatuses(), loadSources()])
      .then(function () {
        renderQuickIdButtons();
      })
      .catch(function () {
        // ignore
      });

    btnSave.addEventListener("click", saveModal);
    if (btnDelete) {
      btnDelete.addEventListener("click", deleteModalCallsign);
    }
    if (btnMerge) {
      btnMerge.addEventListener("click", function () {
        if (!mergePanel) return;
        const isVisible = mergePanel.style.display !== "none";
        if (isVisible) {
          hideMergePanel();
        } else {
          mergePanel.style.display = "";
          mergePanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
          if (mergeQuery) mergeQuery.focus();
        }
      });
    }
    if (mergeCancel) mergeCancel.addEventListener("click", hideMergePanel);
    if (mergeConfirm) mergeConfirm.addEventListener("click", mergeCallsign);
    if (mergeQuery) {
      mergeQuery.addEventListener("input", async function () {
        const q = mergeQuery.value.trim();
        if (mergeSuggestions) { mergeSuggestions.innerHTML = ""; mergeSuggestions.style.display = "none"; }
        if (mergeTargetId) mergeTargetId.value = "";
        if (mergeTargetName) mergeTargetName.textContent = "—";
        if (!q || q.length < 2) return;

        // Get current network_id from modal network select
        const networkSelect = $("csModalNetwork");
        const networkId = networkSelect ? parseInt(networkSelect.value || "0", 10) : 0;

        try {
          const params = new URLSearchParams({ q, limit: 12 });
          if (networkId) params.set("network_id", networkId);
          const r = await fetch(`/api/callsigns/search?${params}`);
          const data = await r.json();
          const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
          const items = Array.isArray(data) ? data : (data.rows || data.items || []);
          const sourceId = parseInt(modalId && modalId.value ? modalId.value : "0", 10);
          const filtered = items.filter(it => it.id !== sourceId);
          if (!filtered.length || !mergeSuggestions) return;
          mergeSuggestions.style.display = "";
          mergeSuggestions.innerHTML = filtered.map(it =>
            `<div class="cs-merge-suggestion" data-id="${esc(it.id)}" data-name="${esc(it.name)}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--border)">
              <strong>${esc(it.name)}</strong>
              <span class="small" style="opacity:.6; margin-left:6px">${esc(it.frequency || "")}</span>
            </div>`
          ).join("");
          mergeSuggestions.querySelectorAll(".cs-merge-suggestion").forEach(el => {
            el.addEventListener("click", function () {
              if (mergeTargetId) mergeTargetId.value = this.dataset.id;
              if (mergeTargetName) mergeTargetName.textContent = this.dataset.name;
              if (mergeQuery) mergeQuery.value = this.dataset.name;
              mergeSuggestions.style.display = "none";
            });
          });
        } catch (e) { /* ignore */ }
      });
    }
    if (btnOpenIntercepts) {
      btnOpenIntercepts.addEventListener("click", openInterceptsForCurrent);
    }
    if (btnOpenLinks) {
      btnOpenLinks.addEventListener("click", openLinksForCurrent);
    }

    if (modalNetworkQuery) {
      modalNetworkQuery.addEventListener("input", function () {
        clearTimeout(NET_LOOKUP_TIMER);
        const q = modalNetworkQuery.value || "";
        NET_LOOKUP_TIMER = setTimeout(function () {
          lookupNetworks(q);
        }, 250);
      });
    }

    if (modalNetwork) {
      modalNetwork.addEventListener("change", function () {
        const v = modalNetwork.value;
        CURRENT_NETWORK_ID = v ? parseInt(v, 10) : null;
      });
    }

    if (modalStatus) {
      modalStatus.addEventListener("change", function () {
        if (modalStatus.value === "__add__") {
          modalStatus.value = CURRENT_STATUS_ID ? String(CURRENT_STATUS_ID) : "";
          openStatusModal();
        } else {
          const v = parseInt(modalStatus.value, 10);
          CURRENT_STATUS_ID = Number.isFinite(v) ? v : null;
          setPhotoForStatus(CURRENT_STATUS_ID);
        }
      });
    }

    if (modalSource) {
      modalSource.addEventListener("change", function () {
        const v = parseInt(modalSource.value, 10);
        CURRENT_SOURCE_ID = Number.isFinite(v) ? v : null;
      });
    }

    if (btnCreateStatus) {
      btnCreateStatus.addEventListener("click", async function () {
        const name = (newStatusName.value || "").trim();

        if (!name) {
          showStatusError("Вкажіть назву статусу");
          return;
        }

        btnCreateStatus.disabled = true;

        try {
          const r = await fetch("/api/callsigns/statuses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });

          const data = await r.json();

          if (!data.ok) {
            showStatusError(data.error || "Не вдалося створити статус");
            return;
          }

          await loadStatuses();
          CURRENT_STATUS_ID = data.id;
          renderStatusSelect(CURRENT_STATUS_ID);
          setPhotoForStatus(CURRENT_STATUS_ID);
          closeStatusModal();
        } catch (e) {
          console.error(e);
          showStatusError("Помилка запиту");
        } finally {
          btnCreateStatus.disabled = false;
        }
      });
    }

    modal.addEventListener("click", function (e) {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-close") === "1") {
        closeModal();
      }
    });

    if (statusModal) {
      statusModal.addEventListener("click", function (e) {
        const t = e.target;
        if (
          t &&
          t.getAttribute &&
          t.getAttribute("data-close-status") === "1"
        ) {
          closeStatusModal();
        }
      });
    }

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modal && !modal.classList.contains("hidden")) {
        closeModal();
      }
      if (
        e.key === "Escape" &&
        statusModal &&
        !statusModal.classList.contains("hidden")
      ) {
        closeStatusModal();
      }
    });
  }

  window.openCallsignEditModalById = openEditModalById;
  window.openCallsignCreateModal = openCreateModal;
  window.setCallsignModalOnSave = setCallsignModalOnSave;
  window.fillCallsignEditModal = fillEditModal;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
