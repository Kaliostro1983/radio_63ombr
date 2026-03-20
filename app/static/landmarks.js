(function () {
  function $(id) {
    return document.getElementById(id);
  }

  const modal = $("lmModal");
  if (!modal) return;

  const searchForm = $("lmSearchForm");
  const nameInput = $("lmName");
  const nameList = $("lmNameList");
  const groupSelect = $("lmGroupId");
  const typeSelect = $("lmTypeId");
  const searchBtn = $("lmSearchBtn");
  const createBtn = $("lmCreateBtn");
  const tbody = $("lmTbody");
  const metaEl = $("lmMeta");
  const loadingEl = $("lmLoading");
  const loadMoreBtn = $("lmLoadMoreBtn");

  const editIdInput = $("lmEditId");
  const editNameInput = $("lmEditName");
  const editIsActiveInput = $("lmEditIsActive");
  const editLocationWktInput = $("lmEditLocationWkt");
  const editLocationKindInput = $("lmEditLocationKind");
  const editCommentInput = $("lmEditComment");
  const editGroupSelect = $("lmEditGroupId");
  const editTypeSelect = $("lmEditTypeId");
  const editErr = $("lmEditErr");
  const editDeleteBtn = $("lmEditDeleteBtn");
  const editSaveBtn = $("lmEditSaveBtn");

  const state = {
    groups: [],
    types: [],
    unknownTypeId: null,
    lastAutocompleteTimer: null,
    lastAutocompleteQuery: "",
    limit: 50,
    offset: 0,
    total: 0,
    hasMore: false,
    isLoading: false,
  };

  function openModal() {
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    editErr.style.display = "none";
    editErr.textContent = "";
  }

  function clearEditInputs() {
    if (editNameInput) editNameInput.value = "";
    if (editIsActiveInput) editIsActiveInput.checked = true;
    if (editLocationWktInput) editLocationWktInput.value = "";
    if (editLocationKindInput) editLocationKindInput.value = "";
    if (editCommentInput) editCommentInput.value = "";
    if (editGroupSelect) editGroupSelect.value = "";
    if (editTypeSelect) editTypeSelect.value = "";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function apiGet(url) {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || data.error || "Помилка запиту");
    return data;
  }

  async function apiPost(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || data.error || "Помилка збереження");
    return data;
  }

  function renderMeta() {
    const shown = tbody ? tbody.children.length : 0;
    metaEl.textContent = `Знайдено: ${state.total}. Показано: ${shown}.`;
  }

  function renderRows(items, append = false) {
    if (!tbody) return;
    if (!append) tbody.innerHTML = "";

    if (!items || !items.length) {
      if (!append) {
        tbody.innerHTML = `<tr><td colspan="4" class="small" style="opacity:.8">Немає результатів</td></tr>`;
      }
      return;
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const idx = state.offset + i + 1;
      const tr = document.createElement("tr");
      tr.className = "lm-row";
      tr.dataset.id = String(it.id);
      tr.innerHTML = `
        <td>${idx}</td>
        <td>${escapeHtml(it.type_name)}</td>
        <td>${escapeHtml(it.name)}</td>
        <td>${escapeHtml(it.group_name ?? "—")}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  function setLoading(isLoading) {
    state.isLoading = !!isLoading;
    if (loadingEl) loadingEl.style.display = isLoading ? "block" : "none";
    if (searchBtn && isLoading) searchBtn.disabled = true;
    if (loadMoreBtn && isLoading) loadMoreBtn.disabled = true;
  }

  function setLoadMoreVisible() {
    if (!loadMoreBtn) return;
    loadMoreBtn.style.display = state.hasMore ? "inline-block" : "none";
  }

  function buildSearchParams() {
    const params = new URLSearchParams();

    const nameVal = String(nameInput?.value || "").trim();
    const groupVal = String(groupSelect?.value || "").trim();
    const typeVal = String(typeSelect?.value || "").trim();

    if (nameVal) params.set("name", nameVal);
    if (groupVal) params.set("group_id", groupVal);
    if (typeVal) params.set("type_id", typeVal);

    params.set("limit", String(state.limit));
    params.set("offset", String(state.offset));

    return params;
  }

  async function loadSearchPage(reset) {
    if (state.isLoading) return;
    if (reset) state.offset = 0;

    const params = buildSearchParams();
    const url = `/api/landmarks/search?${params.toString()}`;

    setLoading(true);
    try {
      const data = await apiGet(url);
      const items = Array.isArray(data.items) ? data.items : [];
      const meta = data.meta || {};

      state.total = Number(meta.total || 0);
      state.hasMore = !!meta.has_more;

      // Render and append.
      renderRows(items, !reset);
      renderMeta();
      setLoadMoreVisible();
    } finally {
      setLoading(false);
      if (searchBtn) searchBtn.disabled = false;
      if (loadMoreBtn) loadMoreBtn.disabled = false;
    }
  }

  async function loadAutocomplete(q) {
    if (!nameInput || !nameList) return;

    const query = String(q || "").trim();
    if (query.length < 2) {
      nameList.innerHTML = "";
      return;
    }

    const data = await apiGet(`/api/landmarks/autocomplete?q=${encodeURIComponent(query)}`);
    const rows = Array.isArray(data.rows) ? data.rows : [];

    // Only update for the latest query (avoid race conditions).
    if (state.lastAutocompleteQuery !== query) return;

    nameList.innerHTML = "";
    for (const r of rows) {
      const opt = document.createElement("option");
      opt.value = r.name || "";
      nameList.appendChild(opt);
    }
  }

  function setupAutocomplete() {
    if (!nameInput) return;
    nameInput.addEventListener("input", () => {
      const q = String(nameInput.value || "").trim();
      if (state.lastAutocompleteTimer) clearTimeout(state.lastAutocompleteTimer);
      state.lastAutocompleteQuery = q;
      state.lastAutocompleteTimer = setTimeout(() => {
        loadAutocomplete(q).catch(() => {});
      }, 250);
    });
  }

  function populateSelect(selectEl, items, includeAllOption, allLabel = "Усі") {
    if (!selectEl) return;
    selectEl.innerHTML = "";
    if (includeAllOption) {
      const optAll = document.createElement("option");
      optAll.value = "";
      optAll.textContent = allLabel;
      selectEl.appendChild(optAll);
    }
    for (const it of items) {
      const opt = document.createElement("option");
      opt.value = String(it.id);
      opt.textContent = it.name || "";
      selectEl.appendChild(opt);
    }
  }

  async function loadReference() {
    const data = await apiGet("/api/landmarks/reference");
    state.groups = Array.isArray(data.groups) ? data.groups : [];
    state.types = Array.isArray(data.types) ? data.types : [];
    state.unknownTypeId = data.unknown_type_id ? Number(data.unknown_type_id) : null;

    populateSelect(groupSelect, state.groups, true, "Усі");
    populateSelect(typeSelect, state.types, true, "Усі");
    populateSelect(editGroupSelect, state.groups, true, "Без підрозділу");
    populateSelect(editTypeSelect, state.types, true, "Оберіть тип");
  }

  function fillEditModal(landmark) {
    if (!landmark) return;
    editIdInput.value = String(landmark.id);
    editNameInput.value = landmark.name || "";
    if (editIsActiveInput) editIsActiveInput.checked = !!landmark.is_active;

    const gId = landmark.id_group == null ? "" : String(landmark.id_group);
    const tId = String(landmark.id_type);

    if (editGroupSelect) editGroupSelect.value = gId;
    if (editTypeSelect) {
      const nt = state.unknownTypeId;
      const idTypeNum = Number(landmark.id_type);
      editTypeSelect.value = nt != null && idTypeNum === nt ? "" : tId;
    }

    if (editLocationWktInput) editLocationWktInput.value = landmark.location_wkt || "";
    if (editLocationKindInput) editLocationKindInput.value = landmark.location_kind || "";
    if (editCommentInput) editCommentInput.value = landmark.comment || "";

    $("lmModalTitle").textContent = landmark.name || "—";
  }

  async function openEditModal(landmarkId) {
    editErr.style.display = "none";
    editErr.textContent = "";
    editIdInput.value = String(landmarkId);

    const data = await apiGet(`/api/landmarks/${encodeURIComponent(landmarkId)}`);
    if (!data.landmark) throw new Error("Орієнтир не знайдено");

    fillEditModal(data.landmark);
    if (editDeleteBtn) editDeleteBtn.style.display = "inline-block";
    openModal();
  }

  function openCreateModal() {
    editErr.style.display = "none";
    editErr.textContent = "";
    editIdInput.value = "";
    clearEditInputs();
    $("lmModalTitle").textContent = "Створення орієнтира";
    if (editDeleteBtn) editDeleteBtn.style.display = "none";
    openModal();
  }

  async function saveEdit() {
    const id = String(editIdInput.value || "").trim();

    editSaveBtn.disabled = true;
    try {
      const name = String(editNameInput.value || "").trim();
      const location_wkt = String(editLocationWktInput?.value || "").trim();
      const id_type = editTypeSelect?.value || "";
      const id_group = editGroupSelect?.value || "";
      const comment = String(editCommentInput?.value || "").trim();
      const isCreate = !id;
      const is_active = editIsActiveInput?.checked ? 1 : 0;

      if (!name) throw new Error("Назва не може бути порожньою");
      // For creation only `name` is mandatory.
      // For editing we keep stricter validation (backend still requires WKT).
      if (!isCreate && !location_wkt) throw new Error("Координати (WKT) обов'язкові");

      const payload = {
        name: name,
        location_wkt: location_wkt,
        id_type: id_type ? Number(id_type) : null,
        id_group: id_group ? Number(id_group) : null,
        comment: comment || "",
        is_active: is_active,
      };

      if (id) {
        await apiPost(`/api/landmarks/${encodeURIComponent(id)}`, payload);
      } else {
        await apiPost(`/api/landmarks`, payload);
      }
      closeModal();
      await loadSearchPage(true);
    } catch (e) {
      editErr.textContent = e.message || "Помилка";
      editErr.style.display = "block";
    } finally {
      editSaveBtn.disabled = false;
    }
  }

  function setupEvents() {
    // If user presses Enter inside any input, browser submits the form and navigates.
    // We intercept it and run our async search.
    if (searchForm) {
      searchForm.addEventListener("submit", (ev) => {
        ev.preventDefault();
        loadSearchPage(true).catch(() => {});
      });
    }

    if (searchBtn) searchBtn.addEventListener("click", () => loadSearchPage(true));
    if (createBtn) createBtn.addEventListener("click", openCreateModal);
    if (loadMoreBtn)
      loadMoreBtn.addEventListener("click", () => {
        state.offset += state.limit;
        loadSearchPage(false).catch(() => {});
      });

    // Row click -> open edit modal.
    if (tbody) {
      tbody.addEventListener("click", (ev) => {
        const tr = ev.target.closest("tr");
        if (!tr || !tr.dataset || !tr.dataset.id) return;
        const id = tr.dataset.id;
        openEditModal(id).catch((e) => {
          alert(e.message || "Помилка");
        });
      });
    }

    // Modal close handlers.
    modal.addEventListener("click", (ev) => {
      const t = ev.target;
      if (!t) return;
      const close = t.getAttribute && t.getAttribute("data-close") === "1";
      if (close) closeModal();
      if (t === modal) closeModal();
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && modal && !modal.classList.contains("hidden")) closeModal();
    });

    if (editSaveBtn) editSaveBtn.addEventListener("click", saveEdit);
    if (editDeleteBtn) {
      editDeleteBtn.addEventListener("click", async () => {
        const id = String(editIdInput.value || "").trim();
        if (!id) return;
        if (!confirm("Видалити орієнтир?")) return;
        editDeleteBtn.disabled = true;
        try {
          await apiPost(`/api/landmarks/${encodeURIComponent(id)}/delete`, {});
          closeModal();
          await loadSearchPage(true);
        } catch (e) {
          editErr.textContent = e.message || "Помилка";
          editErr.style.display = "block";
        } finally {
          editDeleteBtn.disabled = false;
        }
      });
    }
  }

  // Init
  (async function init() {
    try {
      await loadReference();
      setupAutocomplete();
      setupEvents();

      // If the page is opened with query params (e.g. /landmarks?name=ябло),
      // reflect them in inputs and auto-run search.
      const qs = new URLSearchParams(window.location.search);
      const qName = String(qs.get("name") || "").trim();
      const qGroup = String(qs.get("group_id") || "").trim();
      const qType = String(qs.get("type_id") || "").trim();

      if (nameInput && qName) nameInput.value = qName;
      if (groupSelect && (qGroup || qGroup === "0")) groupSelect.value = qGroup;
      if (typeSelect && (qType || qType === "0")) typeSelect.value = qType;

      // Lazy load: initial render starts empty; user presses "Шукати".
      // (Still, we can load default list if you prefer - but requirement says lazy.)
      renderRows([], false);

      if (metaEl) {
        const hasAny = !!(qName || qGroup || qType);
        metaEl.textContent = hasAny
          ? "Завантаження..."
          : "Заповни фільтри та натисни “Шукати” (або залиш порожнім — показує все).";
      }

      if (nameInput && (qName || qGroup || qType)) {
        await loadSearchPage(true);
      }
    } catch (e) {
      if (metaEl) metaEl.textContent = `Помилка: ${e.message || e}`;
    }
  })();
})();

