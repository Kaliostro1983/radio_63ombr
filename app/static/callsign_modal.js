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
  const modalLifeToggle = $("csModalLifeToggle");
  const modalStatus = $("csModalStatus");
  const modalSource = $("csModalSource");
  const modalComment = $("csModalComment");
  const modalIsPosition = $("csModalIsPosition");
  const modalHasAA = $("csModalHasAA");
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
  const btnOpenConclusions = $("csOpenConclusions");
  const btnOpenLinks = $("csOpenLinks");
  const quickWrap = $("csQuickId");

  const statusManageBtn = $("csModalStatusManage");
  const stMgrModal = $("csStatusManagerModal");
  const stMgrNewName = $("csStMgrNewName");
  const stMgrAddBtn = $("csStMgrAdd");
  const stMgrErr = $("csStMgrErr");
  const stMgrList = $("csStMgrList");

  const statusModal = $("csStatusModal");
  const newStatusName = $("csNewStatusName");
  const newStatusErr = $("csNewStatusErr");
  const btnCreateStatus = $("csCreateStatus");
  const btnDeleteStatus = $("csDeleteStatus");
  const statusEditId = $("csStatusEditId");
  const statusModalTitle = $("csStatusModalTitle");
  const statusModalSub = $("csStatusModalSub");

  let STATUS_LIST = [];
  let SOURCE_LIST = [];
  let CURRENT_STATUS_ID = null;
  let CURRENT_SOURCE_ID = null;
  let CURRENT_NETWORK_ID = null;
  let CURRENT_LIFE = "alive";

  // Перемикач «Живий» → 200 → 300 (клік по колу). Логіка вигляду — у CallsignStatus.
  function renderLifeToggle() {
    if (!modalLifeToggle || !window.CallsignStatus) return;
    const m = window.CallsignStatus.meta(CURRENT_LIFE);
    modalLifeToggle.textContent = m.label;
    modalLifeToggle.className = "cs-life-toggle cs-life--" + m.key;
    modalLifeToggle.title = "Стан: " + m.title + " — клік: живий → 200 → 300";
  }
  if (modalLifeToggle) {
    modalLifeToggle.addEventListener("click", function () {
      CURRENT_LIFE = window.CallsignStatus
        ? window.CallsignStatus.next(CURRENT_LIFE)
        : (CURRENT_LIFE === "alive" ? "200" : CURRENT_LIFE === "200" ? "300" : "alive");
      renderLifeToggle();
    });
  }
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
    params.set("tab", "view");
    const url = `/intercepts-explorer?${params.toString()}`;

    // Якщо ми вже на /intercepts-explorer — заповнюємо форму та відкриваємо
    // модалку «Перегляд» напряму через API сторінки. Без перезавантаження,
    // тож активне перехоплення в Моніторингу й позивний-модалка лишаються.
    if (window.location.pathname === "/intercepts-explorer" && typeof window.itSetTab === "function") {
      const startEl = document.getElementById("periodStart");
      const endEl   = document.getElementById("periodEnd");
      const netEl   = document.getElementById("networkQuery");
      const csEl    = document.getElementById("callsignQuery");
      if (startEl) startEl.value = start;
      if (endEl)   endEl.value   = end;
      // «Частоти» — чіпи: заповнюємо через API контролера (очищає попередні).
      if (window.itFreqChips) window.itFreqChips.set(networkToken ? [networkToken] : []);
      else if (netEl) netEl.value = networkToken;
      if (csEl)    csEl.value    = callsignName;
      window.itSetTab("view");
      const form = document.getElementById("interceptsFilterForm");
      if (form && typeof form.requestSubmit === "function") {
        try { form.requestSubmit(); } catch (_) { form.submit(); }
      } else if (form) {
        form.submit();
      }
      return;
    }

    // На /callsigns — відкриваємо iframe-модалку Перехоплень (з embed=1)
    // прямо на сторінці, не плодимо нові вкладки браузера.
    if (window.location.pathname === "/callsigns" && typeof window.csOpenInterceptsModal === "function") {
      // Для embed-варіанта URL формуємо з тими ж параметрами + embed=1, щоб
      // intercepts-explorer відрендерився без шапки і одразу відкрив "Перегляд".
      const embedParams = new URLSearchParams(params.toString());
      embedParams.set("embed", "1");
      const embedUrl = `/intercepts-explorer?${embedParams.toString()}`;
      if (window.csOpenInterceptsModal(embedUrl)) return;
    }

    // На /home — відкриваємо iframe-модалку Перехоплень прямо на сторінці.
    if (window.location.pathname === "/home" && typeof window.homeOpenInterceptsUrl === "function") {
      const embedParams = new URLSearchParams(params.toString());
      embedParams.set("embed", "1");
      const embedUrl = `/intercepts-explorer?${embedParams.toString()}`;
      if (window.homeOpenInterceptsUrl(embedUrl)) return;
    }

    // Якщо картка позивного відкрита всередині iframe (напр. модалка
    // «Картка р/м» на /home → /networks?embed=1, де pathname === "/networks"),
    // делегуємо відкриття батьківському вікну /home — без нової вкладки браузера.
    try {
      if (
        window.parent &&
        window.parent !== window &&
        typeof window.parent.homeOpenInterceptsUrl === "function"
      ) {
        const embedParams = new URLSearchParams(params.toString());
        embedParams.set("embed", "1");
        const embedUrl = `/intercepts-explorer?${embedParams.toString()}`;
        if (window.parent.homeOpenInterceptsUrl(embedUrl)) return;
      }
    } catch (e) {
      /* cross-origin або помічник відсутній — йдемо у fallback нижче */
    }

    const w = window.open(url, "_blank", "noopener");
    if (!w) {
      showError("Браузер заблокував відкриття вкладки. Дозволь popups для цього сайту.");
    }
  }

  async function openLinksForCurrent() {
    const callsignId = modalId && modalId.value ? parseInt(modalId.value, 10) : 0;
    if (!callsignId) return;
    const callsignName = (modalName && modalName.value ? String(modalName.value) : "").trim();

    // Граф зв'язків відкриваємо в модальному вікні на поточній вкладці (iframe)
    // — однаково на всіх сторінках, зокрема й на /callsigns (раніше там граф
    // перемальовував усю сторінку в головну Зв'язки-секцію).
    if (window.openLinksView && window.openLinksView(callsignId, callsignName)) return;

    // Якщо модалку викликано всередині iframe — делегуємо батьківському вікну.
    try {
      if (window.parent && window.parent !== window &&
          typeof window.parent.openLinksView === "function" &&
          window.parent.openLinksView(callsignId, callsignName)) return;
    } catch (e) { /* cross-origin — у fallback */ }

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
    const target = statusId ? (base + String(statusId) + ".webp") : defWebp;

    // Вже показуємо потрібне фото й воно завантажене — нічого не робимо.
    if (modalPhoto.getAttribute("src") === target && modalPhoto.dataset.photoReady === "1") return;

    // Ховаємо поточне фото ДО завантаження нового, щоб не блимало попереднім
    // позивним; показуємо (плавно) лише коли нове реально завантажилось.
    modalPhoto.style.transition = "opacity .18s ease";
    modalPhoto.style.opacity = "0";
    modalPhoto.dataset.photoReady = "0";
    modalPhoto.onload = function () {
      modalPhoto.dataset.photoReady = "1";
      modalPhoto.style.opacity = "1";
    };

    if (!statusId) {
      modalPhoto.dataset.photoTry = "default";
      modalPhoto.onerror = function () {
        modalPhoto.onerror = null;
        modalPhoto.src = defPng;
      };
      modalPhoto.src = defWebp;
      return;
    }

    modalPhoto.dataset.photoTry = "webp";
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
    modalPhoto.src = base + String(statusId) + ".webp";
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
      btn.addEventListener("click", function (e) {
        // Ctrl+клік — редагувати назву статусу (а не обирати його).
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          openStatusEditModal(sid, s.name || "");
          return;
        }
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
    // Картка позивного — одна спільна модалка. Якщо її викликають, коли вона
    // вже відкрита позаду (напр. з модалки перехоплень) — підняти на передній
    // план (дані вже оновлено через fillEditModal).
    if (window.__modalToFront) window.__modalToFront(modal);
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
    if (statusEditId) statusEditId.value = "";   // режим створення
    if (statusModalSub) statusModalSub.textContent = "Новий статус";
    if (statusModalTitle) statusModalTitle.textContent = "Додати статус";
    if (btnCreateStatus) btnCreateStatus.textContent = "Створити";
    if (btnDeleteStatus) btnDeleteStatus.style.display = "none";
    if (newStatusName) newStatusName.value = "";
    statusModal.classList.remove("hidden");
    statusModal.setAttribute("aria-hidden", "false");
    if (window.__modalToFront) window.__modalToFront(statusModal);
    setTimeout(function () {
      if (newStatusName) { newStatusName.focus(); newStatusName.select(); }
    }, 0);
  }

  // Режим редагування назви існуючого статусу (Ctrl+клік по статусу).
  function openStatusEditModal(id, name) {
    if (!statusModal || !id) return;
    if (newStatusErr) { newStatusErr.style.display = "none"; newStatusErr.textContent = ""; }
    if (statusEditId) statusEditId.value = String(id);
    if (statusModalSub) statusModalSub.textContent = "Редагування статусу";
    if (statusModalTitle) statusModalTitle.textContent = "Перейменувати статус";
    if (btnCreateStatus) btnCreateStatus.textContent = "Зберегти";
    if (btnDeleteStatus) btnDeleteStatus.style.display = "inline-block";
    if (newStatusName) newStatusName.value = String(name || "");
    statusModal.classList.remove("hidden");
    statusModal.setAttribute("aria-hidden", "false");
    if (window.__modalToFront) window.__modalToFront(statusModal);
    setTimeout(function () {
      if (newStatusName) { newStatusName.focus(); newStatusName.select(); }
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

  /* ── Керування статусами (додати / редагувати / видалити) ── */

  function showStMgrError(msg) {
    if (!stMgrErr) return;
    stMgrErr.textContent = msg || "";
    stMgrErr.style.display = msg ? "block" : "none";
  }

  function renderStatusManager() {
    if (!stMgrList) return;
    stMgrList.innerHTML = "";
    if (!Array.isArray(STATUS_LIST) || !STATUS_LIST.length) {
      const empty = document.createElement("div");
      empty.className = "small";
      empty.style.opacity = ".6";
      empty.textContent = "Статусів ще немає.";
      stMgrList.appendChild(empty);
      return;
    }
    STATUS_LIST.forEach(function (s) {
      const sid = Number(s.id);
      const row = document.createElement("div");
      row.className = "cs-stmgr-row";
      row.dataset.id = String(sid);

      const img = document.createElement("img");
      img.src = "/static/icons/callsign_statuses/" + sid + ".svg";
      img.alt = "";
      img.onerror = function () {
        this.onerror = null;
        this.src = "/static/icons/callsign_statuses/_default.svg";
      };

      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "cs-stmgr-name";
      inp.value = String(s.name || "");

      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "cs-stmgr-btn cs-stmgr-btn--save";
      saveBtn.title = "Зберегти назву";
      saveBtn.setAttribute("data-act", "save");
      saveBtn.innerHTML =
        '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg>';

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "cs-stmgr-btn cs-stmgr-btn--del";
      delBtn.title = "Видалити статус";
      delBtn.setAttribute("data-act", "del");
      delBtn.innerHTML =
        '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h12M8 6V4.5h4V6M6 6l.7 9.5a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L15 6"/></svg>';

      row.appendChild(img);
      row.appendChild(inp);
      row.appendChild(saveBtn);
      row.appendChild(delBtn);
      stMgrList.appendChild(row);
    });
  }

  function openStatusManager() {
    if (!stMgrModal) return;
    showStMgrError("");
    if (stMgrNewName) stMgrNewName.value = "";
    renderStatusManager();
    stMgrModal.classList.remove("hidden");
    stMgrModal.setAttribute("aria-hidden", "false");
    if (window.__modalToFront) window.__modalToFront(stMgrModal);
  }

  function closeStatusManager() {
    if (!stMgrModal) return;
    stMgrModal.classList.add("hidden");
    stMgrModal.setAttribute("aria-hidden", "true");
  }

  // Після будь-якої зміни статусів — перечитати список і оновити всі вью.
  async function refreshAfterStatusChange() {
    await loadStatuses();
    renderStatusSelect(CURRENT_STATUS_ID);
    renderQuickIdButtons();
    setPhotoForStatus(CURRENT_STATUS_ID);
    renderStatusManager();
  }

  async function stMgrCreate() {
    const name = (stMgrNewName && stMgrNewName.value ? stMgrNewName.value : "").trim();
    if (!name) { showStMgrError("Вкажіть назву статусу"); return; }
    showStMgrError("");
    if (stMgrAddBtn) stMgrAddBtn.disabled = true;
    try {
      const r = await fetch("/api/callsigns/statuses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await r.json();
      if (!data.ok) { showStMgrError(data.error || "Не вдалося створити статус"); return; }
      if (stMgrNewName) stMgrNewName.value = "";
      await refreshAfterStatusChange();
    } catch (e) {
      console.error(e);
      showStMgrError("Помилка запиту");
    } finally {
      if (stMgrAddBtn) stMgrAddBtn.disabled = false;
    }
  }

  async function stMgrRename(id, name) {
    const nm = (name || "").trim();
    if (!nm) { showStMgrError("Назва не може бути порожньою"); return; }
    showStMgrError("");
    try {
      const r = await fetch("/api/callsigns/statuses/" + id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nm }),
      });
      const data = await r.json();
      if (!data.ok) { showStMgrError(data.error || "Не вдалося перейменувати статус"); return; }
      await refreshAfterStatusChange();
    } catch (e) {
      console.error(e);
      showStMgrError("Помилка запиту");
    }
  }

  async function stMgrDelete(id) {
    const st = STATUS_LIST.find(function (s) { return Number(s.id) === Number(id); });
    const nm = st ? st.name : "";
    if (!window.confirm(
          "Видалити статус «" + nm + "»?\n" +
          "Усім позивним із цим статусом буде присвоєно «Не вказано».")) {
      return;
    }
    showStMgrError("");
    try {
      const r = await fetch("/api/callsigns/statuses/" + id, { method: "DELETE" });
      const data = await r.json();
      if (!data.ok) { showStMgrError(data.error || "Не вдалося видалити статус"); return; }
      if (Number(CURRENT_STATUS_ID) === Number(id)) CURRENT_STATUS_ID = null;
      await refreshAfterStatusChange();
      if (window.appToast) {
        window.appToast(
          "Статус видалено" +
            (data.reassigned ? " · перепризначено: " + data.reassigned : ""),
          "success", 2200);
      }
    } catch (e) {
      console.error(e);
      showStMgrError("Помилка запиту");
    }
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
    if (modalIsPosition) modalIsPosition.checked = !!row.is_position;
    if (modalHasAA) modalHasAA.checked = !!row.has_air_defense;
    CURRENT_LIFE = window.CallsignStatus ? window.CallsignStatus.norm(row.life_status) : "alive";
    renderLifeToggle();
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

    // Кнопка «Висновки» — лише якщо по позивному є аналітичні висновки.
    if (btnOpenConclusions) {
      btnOpenConclusions.classList.toggle("hidden", !row.has_conclusions);
    }

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
      // НВ — це позначка «позивний не визначений», а не позивний: без картки.
      if (String(data.row.name || "").trim().toUpperCase() === "НВ") {
        if (window.appToast) window.appToast("«НВ» — невизначений позивний, картки немає", "info", 2200);
        return;
      }
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
    if (modalIsPosition) modalIsPosition.checked = false;
    if (modalHasAA) modalHasAA.checked = false;
    CURRENT_LIFE = "alive";
    renderLifeToggle();
    CURRENT_STATUS_ID = null;
    CURRENT_SOURCE_ID = null;
    CURRENT_NETWORK_ID = null;

    renderStatusSelect(CURRENT_STATUS_ID);
    renderSourceSelect(CURRENT_SOURCE_ID);
    setPhotoForStatus(CURRENT_STATUS_ID);
    if (btnDelete) btnDelete.style.display = "none";
    if (btnOpenConclusions) btnOpenConclusions.classList.add("hidden");

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
          is_position: !!(modalIsPosition && modalIsPosition.checked),
          has_air_defense: !!(modalHasAA && modalHasAA.checked),
          life_status: CURRENT_LIFE,
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
      // Оновити оверлеї-точки (зелена — висновки, червона — ППО) на видимих іконках.
      if (window.decorateCallsignConclusions) window.decorateCallsignConclusions(document);
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

        // Always restrict to the same network as the callsign being edited.
        const networkId = CURRENT_NETWORK_ID || 0;

        try {
          const params = new URLSearchParams({ q, limit: 12 });
          if (networkId) params.set("network_id", networkId);
          const r = await fetch(`/api/callsigns/search?${params}`);
          const data = await r.json();
          const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
          const items = Array.isArray(data) ? data : (data.rows || data.items || []);
          const sourceId = parseInt(modalId && modalId.value ? modalId.value : "0", 10);
          const filtered = items.filter(it => it.callsign_id !== sourceId);
          if (!filtered.length || !mergeSuggestions) return;
          mergeSuggestions.style.display = "";
          mergeSuggestions.innerHTML = filtered.map(it =>
            `<div class="cs-merge-suggestion" data-id="${esc(it.callsign_id)}" data-name="${esc(it.name)}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--border)">
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
    if (btnOpenConclusions) {
      btnOpenConclusions.addEventListener("click", function () {
        const cid = modalId && modalId.value ? parseInt(modalId.value, 10) : 0;
        const cname = (modalName && modalName.value ? String(modalName.value) : "").trim();
        if (!cid) return;
        if (window.openConclusionsView) {
          window.openConclusionsView({ callsign_id: cid, callsign: cname });
        }
      });
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
      // Ctrl+клік по полю статусу — редагувати назву обраного статусу.
      modalStatus.addEventListener("mousedown", function (e) {
        if (!(e.ctrlKey || e.metaKey)) return;
        const v = parseInt(modalStatus.value, 10);
        if (!Number.isFinite(v) || v <= 0) return;
        e.preventDefault();   // не відкривати випадаючий список
        const st = STATUS_LIST.find(function (s) { return Number(s.id) === v; });
        openStatusEditModal(v, st ? st.name : "");
        try { modalStatus.blur(); } catch (_) {}
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

        const editId = statusEditId && statusEditId.value ? parseInt(statusEditId.value, 10) : 0;
        btnCreateStatus.disabled = true;

        try {
          const r = editId
            ? await fetch("/api/callsigns/statuses/" + editId, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
              })
            : await fetch("/api/callsigns/statuses", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
              });

          const data = await r.json();

          if (!data.ok) {
            showStatusError(data.error || (editId ? "Не вдалося перейменувати статус" : "Не вдалося створити статус"));
            return;
          }

          await loadStatuses();
          // Перейменування — лишаємо поточний обраний статус; створення — обираємо новий.
          if (!editId) CURRENT_STATUS_ID = data.id;
          renderStatusSelect(CURRENT_STATUS_ID);
          renderQuickIdButtons();
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

    if (btnDeleteStatus) {
      btnDeleteStatus.addEventListener("click", async function () {
        const id = statusEditId && statusEditId.value ? parseInt(statusEditId.value, 10) : 0;
        if (!id) return;
        const st = STATUS_LIST.find(function (s) { return Number(s.id) === id; });
        const nm = st ? st.name : "";
        if (!window.confirm(
              "Видалити статус «" + nm + "»?\n" +
              "Усім позивним із цим статусом буде присвоєно «Не вказано».")) {
          return;
        }
        btnDeleteStatus.disabled = true;
        try {
          const r = await fetch("/api/callsigns/statuses/" + id, { method: "DELETE" });
          const data = await r.json();
          if (!data.ok) {
            showStatusError(data.error || "Не вдалося видалити статус");
            return;
          }
          // Якщо видалили поточно обраний статус — скидаємо на «Не вказано».
          if (Number(CURRENT_STATUS_ID) === id) CURRENT_STATUS_ID = null;
          await loadStatuses();
          renderStatusSelect(CURRENT_STATUS_ID);
          renderQuickIdButtons();
          setPhotoForStatus(CURRENT_STATUS_ID);
          closeStatusModal();
          if (window.appToast) {
            window.appToast(
              "Статус видалено" +
                (data.reassigned ? " · перепризначено: " + data.reassigned : ""),
              "success", 2200);
          }
        } catch (e) {
          console.error(e);
          showStatusError("Помилка запиту");
        } finally {
          btnDeleteStatus.disabled = false;
        }
      });
    }

    // Кнопка-іконка «Керування статусами» поряд із полем «Статус».
    if (statusManageBtn) {
      statusManageBtn.addEventListener("click", function () {
        openStatusManager();
      });
    }

    if (stMgrAddBtn) {
      stMgrAddBtn.addEventListener("click", function () { stMgrCreate(); });
    }
    if (stMgrNewName) {
      stMgrNewName.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); stMgrCreate(); }
      });
    }
    if (stMgrList) {
      // Делегування: «save» (перейменувати) та «del» (видалити) по рядках.
      stMgrList.addEventListener("click", function (e) {
        const btn = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
        if (!btn) return;
        const row = btn.closest(".cs-stmgr-row");
        if (!row) return;
        const id = parseInt(row.dataset.id, 10);
        if (!Number.isFinite(id)) return;
        const act = btn.getAttribute("data-act");
        if (act === "save") {
          const inp = row.querySelector(".cs-stmgr-name");
          stMgrRename(id, inp ? inp.value : "");
        } else if (act === "del") {
          stMgrDelete(id);
        }
      });
      // Enter у полі назви — зберегти перейменування цього рядка.
      stMgrList.addEventListener("keydown", function (e) {
        if (e.key !== "Enter") return;
        const inp = e.target && e.target.classList && e.target.classList.contains("cs-stmgr-name")
          ? e.target : null;
        if (!inp) return;
        e.preventDefault();
        const row = inp.closest(".cs-stmgr-row");
        if (!row) return;
        const id = parseInt(row.dataset.id, 10);
        if (Number.isFinite(id)) stMgrRename(id, inp.value);
      });
    }
    if (stMgrModal) {
      stMgrModal.addEventListener("click", function (e) {
        const t = e.target && e.target.closest
          ? e.target.closest('[data-close-stmgr="1"]') : null;
        if (t) closeStatusManager();
      });
    }

    modal.addEventListener("click", function (e) {
      // closest — бо клік може потрапити на <svg>/<path> усередині кнопки-іконки.
      const t = e.target && e.target.closest ? e.target.closest('[data-close="1"]') : null;
      if (t) closeModal();
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
      if (e.key !== "Escape") return;
      // Закриваємо лише верхню модалку (менеджер → форма статусу → картка).
      if (stMgrModal && !stMgrModal.classList.contains("hidden")) {
        closeStatusManager();
        return;
      }
      if (statusModal && !statusModal.classList.contains("hidden")) {
        closeStatusModal();
        return;
      }
      if (modal && !modal.classList.contains("hidden")) {
        closeModal();
      }
    });
  }

  window.openCallsignEditModalById = openEditModalById;
  window.openCallsignCreateModal = openCreateModal;
  window.setCallsignModalOnSave = setCallsignModalOnSave;
  window.fillCallsignEditModal = fillEditModal;

  // Позначити іконки позивних оверлей-точками: зелена (.cs-has-concl) — є
  // аналітичні висновки; червона (.cs-has-aa) — наявне ППО. Шукає елементи з
  // data-concl-cs-id у `root` (за замовч. document) і пакетно питає сервер.
  window.decorateCallsignConclusions = async function (root) {
    try {
      root = root || document;
      const nodes = Array.prototype.slice.call(root.querySelectorAll("[data-concl-cs-id]"));
      if (!nodes.length) return;
      const ids = Array.from(new Set(
        nodes.map((n) => parseInt(n.getAttribute("data-concl-cs-id"), 10)).filter(Boolean)
      ));
      if (!ids.length) return;
      const r = await fetch("/api/callsigns/conclusion-flags?ids=" + ids.join(","));
      const d = await r.json();
      const concl = new Set((d && d.ok && d.with_conclusions) ? d.with_conclusions : []);
      const aa = new Set((d && d.ok && d.with_aa) ? d.with_aa : []);
      const life = (d && d.ok && d.life) ? d.life : {};
      nodes.forEach((n) => {
        const id = parseInt(n.getAttribute("data-concl-cs-id"), 10);
        n.classList.toggle("cs-has-concl", concl.has(id));
        n.classList.toggle("cs-has-aa", aa.has(id));
        if (window.CallsignStatus) window.CallsignStatus.applyChipBadge(n, life[String(id)] || "alive");
      });
    } catch (_) { /* мовчки — оверлей не критичний */ }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
