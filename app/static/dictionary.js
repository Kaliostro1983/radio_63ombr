/* dictionary.js — права off-canvas панель словника на /intercepts-explorer.
 *
 * Інтеграція з monitor.js:
 *   - читає window.getActiveInterceptContext() для дефолтного scope
 *   - слухає CustomEvent "monitor:active-intercept" і апдейтить scope inputs
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ── Refs ───────────────────────────────────────────────────────────
  const panel       = $("dictPanel");
  const openBtn     = $("monOpenDictionary");
  const closeBtn    = $("dictPanelClose");
  const searchInp   = $("dictSearchInput");
  const searchBtn   = $("dictSearchBtn");
  const scopeCb     = $("dictScopeGroup");
  const scopeInp    = $("dictScopeInput");
  const scopeDrop   = $("dictScopeDrop");
  const scopeIdHid  = $("dictScopeId");
  const addBtn      = $("dictAddBtn");
  const listEl      = $("dictList");

  // Edit-modal refs
  const editModal     = $("dictEditModal");
  const editTitle     = $("dictEditTitle");
  const editId        = $("dictEditId");
  const editTerm      = $("dictEditTerm");
  const editDef       = $("dictEditDefinition");
  const editNetInp    = $("dictEditNetworkInput");
  const editNetDrop   = $("dictEditNetworkDrop");
  const editNetIdHid  = $("dictEditNetworkId");
  const editErr       = $("dictEditErr");
  const editSaveBtn   = $("dictEditSaveBtn");
  const editDelBtn    = $("dictEditDeleteBtn");

  if (!panel || !openBtn || !listEl) return;

  // ── State ──────────────────────────────────────────────────────────
  const state = {
    activeIntercept: null,    // {networkId, frequency, groupId, groupName, ...}
    scopeMode:       "network", // "network" | "group" (mirrors checkbox)
    scopeId:         null,    // id of the picked network OR group
    scopeLabel:      "",      // human-readable label shown in input
    query:           "",
    listAbort:       null,
    acAbort:         null,
  };

  // ── Helpers ────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function fmtNetLabel(it) {
    const bits = [];
    if (it.frequency) bits.push(it.frequency);
    if (it.mask)      bits.push(`(${it.mask})`);
    if (it.unit)      bits.push(it.unit);
    return bits.join(" ").trim() || "—";
  }

  async function fetchJSON(url, opts) {
    const r = await fetch(url, opts);
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) {
      const detail = (data && (data.detail || data.error)) || `HTTP ${r.status}`;
      throw new Error(detail);
    }
    return data;
  }

  // ── Scope ──────────────────────────────────────────────────────────
  function applyActiveInterceptToScope() {
    const ctx = state.activeIntercept;
    if (!ctx) {
      scopeInp.value = "";
      scopeIdHid.value = "";
      state.scopeId = null;
      state.scopeLabel = "";
      return;
    }
    if (state.scopeMode === "group") {
      state.scopeId    = ctx.groupId || null;
      state.scopeLabel = ctx.groupName || (ctx.groupId ? `Група #${ctx.groupId}` : "");
    } else {
      state.scopeId    = ctx.networkId || null;
      state.scopeLabel = fmtNetLabel(ctx);
    }
    scopeInp.value = state.scopeLabel;
    scopeIdHid.value = state.scopeId == null ? "" : String(state.scopeId);
  }

  function onScopeCheckboxChange() {
    state.scopeMode = scopeCb.checked ? "group" : "network";
    applyActiveInterceptToScope();
    loadList();
  }

  // ── Network autocomplete (for scope when group mode is off, AND for add/edit modal) ──
  async function fetchNetworkAc(q) {
    if (state.acAbort) state.acAbort.abort();
    const ctrl = new AbortController();
    state.acAbort = ctrl;
    try {
      const data = await fetchJSON(
        "/api/dictionary/networks?q=" + encodeURIComponent(q || "") + "&limit=20",
        { signal: ctrl.signal }
      );
      return data.items || [];
    } catch (_) {
      return [];
    }
  }

  function renderAcDrop(dropEl, items, onPick) {
    if (!items.length) {
      dropEl.classList.add("hidden");
      dropEl.innerHTML = "";
      return;
    }
    dropEl.innerHTML = items
      .map((it) => `
        <div class="dict-ac-item" data-id="${it.id}">
          <div class="dict-ac-item__primary">${escapeHtml(it.frequency || "—")} ${it.mask ? `<span class="small" style="opacity:.6">(${escapeHtml(it.mask)})</span>` : ""}</div>
          <div class="dict-ac-item__sub small" style="opacity:.65">${escapeHtml(it.unit || "")}${it.group_name ? ` · ${escapeHtml(it.group_name)}` : ""}</div>
        </div>
      `).join("");
    dropEl.classList.remove("hidden");
    dropEl.querySelectorAll(".dict-ac-item").forEach((row) => {
      row.addEventListener("click", () => {
        const id = Number(row.getAttribute("data-id"));
        const item = items.find((x) => x.id === id);
        if (item) onPick(item);
        dropEl.classList.add("hidden");
      });
    });
  }

  function wireNetworkAc(inp, drop, idHid, onPickExtra) {
    let t = null;
    inp.addEventListener("input", () => {
      clearTimeout(t);
      const v = inp.value.trim();
      t = setTimeout(async () => {
        const items = await fetchNetworkAc(v);
        renderAcDrop(drop, items, (picked) => {
          inp.value = picked.label || fmtNetLabel(picked);
          idHid.value = String(picked.id);
          if (typeof onPickExtra === "function") onPickExtra(picked);
        });
      }, 180);
    });
    inp.addEventListener("focus", async () => {
      if (!inp.value.trim()) {
        const items = await fetchNetworkAc("");
        renderAcDrop(drop, items, (picked) => {
          inp.value = picked.label || fmtNetLabel(picked);
          idHid.value = String(picked.id);
          if (typeof onPickExtra === "function") onPickExtra(picked);
        });
      }
    });
    document.addEventListener("click", (e) => {
      if (!drop.contains(e.target) && e.target !== inp) drop.classList.add("hidden");
    });
  }

  // ── List ───────────────────────────────────────────────────────────
  async function loadList() {
    if (state.listAbort) state.listAbort.abort();
    const ctrl = new AbortController();
    state.listAbort = ctrl;

    listEl.innerHTML = `<div class="dict-list__empty small" style="opacity:.55">Завантаження…</div>`;

    const qs = new URLSearchParams();
    const q = state.query.trim();
    if (q) qs.set("q", q);
    if (state.scopeId != null) {
      qs.set(state.scopeMode === "group" ? "group_id" : "network_id", String(state.scopeId));
    }
    if (!q) qs.set("limit", "10"); else qs.set("limit", "50");

    try {
      const data = await fetchJSON("/api/dictionary?" + qs.toString(), { signal: ctrl.signal });
      renderList(data.items || []);
    } catch (e) {
      if (e.name === "AbortError") return;
      listEl.innerHTML = `<div class="dict-list__empty small" style="color:var(--danger)">Помилка: ${escapeHtml(e.message)}</div>`;
    }
  }

  function renderList(items) {
    if (!items.length) {
      listEl.innerHTML = `<div class="dict-list__empty small" style="opacity:.55">Нічого не знайдено.</div>`;
      return;
    }
    listEl.innerHTML = items.map((it) => {
      const netLabel = it.network_label || fmtNetLabel(it);
      return `
        <div class="dict-item" data-id="${it.id}">
          <div class="dict-item__head">
            <div class="dict-item__term">${escapeHtml(it.term)}</div>
            <button type="button" class="dict-item__edit secondary" title="Редагувати">✎</button>
          </div>
          ${it.definition ? `<div class="dict-item__def">${escapeHtml(it.definition)}</div>` : ""}
          <div class="dict-item__meta small" style="opacity:.6">
            ${escapeHtml(netLabel)}${it.group_name ? ` · ${escapeHtml(it.group_name)}` : ""}
          </div>
        </div>
      `;
    }).join("");

    listEl.querySelectorAll(".dict-item").forEach((row) => {
      const id = Number(row.getAttribute("data-id"));
      const item = items.find((x) => x.id === id);
      row.querySelector(".dict-item__edit").addEventListener("click", () => openEditModal(item));
    });
  }

  // ── Add/edit modal ─────────────────────────────────────────────────
  function openEditModal(existing) {
    editErr.style.display = "none";
    editErr.textContent = "";

    if (existing) {
      editTitle.textContent = "Редагувати термін";
      editId.value          = String(existing.id);
      editTerm.value        = existing.term || "";
      editDef.value         = existing.definition || "";
      editNetInp.value      = existing.network_label || fmtNetLabel(existing);
      editNetIdHid.value    = String(existing.network_id);
      editDelBtn.style.display = "";
    } else {
      editTitle.textContent = "Новий термін";
      editId.value          = "";
      editTerm.value        = "";
      editDef.value         = "";
      const ctx = state.activeIntercept;
      if (ctx && ctx.networkId) {
        editNetInp.value   = fmtNetLabel(ctx);
        editNetIdHid.value = String(ctx.networkId);
      } else {
        editNetInp.value   = "";
        editNetIdHid.value = "";
      }
      editDelBtn.style.display = "none";
    }
    editModal.classList.remove("hidden");
    editModal.removeAttribute("aria-hidden");
    setTimeout(() => editTerm.focus(), 30);
  }

  function closeEditModal() {
    editModal.classList.add("hidden");
    editModal.setAttribute("aria-hidden", "true");
  }

  async function saveTerm() {
    const term       = editTerm.value.trim();
    const definition = editDef.value.trim();
    const networkId  = editNetIdHid.value.trim();
    const id         = editId.value.trim();

    if (!term) {
      editErr.textContent = "Термін не може бути порожнім.";
      editErr.style.display = "";
      return;
    }
    if (!networkId) {
      editErr.textContent = "Оберіть радіомережу (зі списку автокомпліту).";
      editErr.style.display = "";
      return;
    }
    editErr.style.display = "none";
    editSaveBtn.disabled = true;
    try {
      if (id) {
        await fetchJSON("/api/dictionary/" + encodeURIComponent(id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ term, definition, network_id: Number(networkId) }),
        });
      } else {
        await fetchJSON("/api/dictionary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ term, definition, network_id: Number(networkId) }),
        });
      }
      closeEditModal();
      loadList();
    } catch (e) {
      editErr.textContent = "Помилка: " + e.message;
      editErr.style.display = "";
    } finally {
      editSaveBtn.disabled = false;
    }
  }

  async function deleteTerm() {
    const id = editId.value.trim();
    if (!id) return;
    if (!confirm("Видалити цей термін?")) return;
    editDelBtn.disabled = true;
    try {
      await fetchJSON("/api/dictionary/" + encodeURIComponent(id), { method: "DELETE" });
      closeEditModal();
      loadList();
    } catch (e) {
      editErr.textContent = "Помилка: " + e.message;
      editErr.style.display = "";
    } finally {
      editDelBtn.disabled = false;
    }
  }

  // ── Panel open/close ───────────────────────────────────────────────
  function openPanel() {
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    // Pull active intercept context (might be null if nothing selected)
    state.activeIntercept = (typeof window.getActiveInterceptContext === "function")
      ? window.getActiveInterceptContext()
      : null;
    applyActiveInterceptToScope();
    loadList();
  }

  function closePanel() {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  }

  // ── Wiring ─────────────────────────────────────────────────────────
  openBtn.addEventListener("click", () => {
    if (panel.classList.contains("open")) closePanel();
    else openPanel();
  });
  closeBtn.addEventListener("click", closePanel);

  scopeCb.addEventListener("change", onScopeCheckboxChange);

  // Search
  let _searchT = null;
  searchInp.addEventListener("input", () => {
    clearTimeout(_searchT);
    state.query = searchInp.value;
    _searchT = setTimeout(loadList, 220);
  });
  searchBtn.addEventListener("click", () => { state.query = searchInp.value; loadList(); });
  searchInp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); state.query = searchInp.value; loadList(); }
  });

  // Add button → opens modal
  addBtn.addEventListener("click", () => openEditModal(null));

  // Edit modal handlers
  editSaveBtn.addEventListener("click", saveTerm);
  editDelBtn.addEventListener("click", deleteTerm);
  document.querySelectorAll('[data-dict-modal-close]').forEach((el) => {
    el.addEventListener("click", closeEditModal);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (editModal && !editModal.classList.contains("hidden")) closeEditModal();
    else if (panel.classList.contains("open")) closePanel();
  });

  // Wire network autocomplete for scope input (only meaningful when checkbox OFF)
  // та для модалки редагування.
  wireNetworkAc(scopeInp, scopeDrop, scopeIdHid, (picked) => {
    if (state.scopeMode === "group") {
      state.scopeId    = picked.group_id || null;
      state.scopeLabel = picked.group_name || picked.label;
      scopeInp.value   = state.scopeLabel;
      scopeIdHid.value = state.scopeId == null ? "" : String(state.scopeId);
    } else {
      state.scopeId    = picked.id;
      state.scopeLabel = picked.label;
    }
    loadList();
  });
  wireNetworkAc(editNetInp, editNetDrop, editNetIdHid);

  // Live-sync scope when user picks another intercept in Monitor
  window.addEventListener("monitor:active-intercept", () => {
    state.activeIntercept = (typeof window.getActiveInterceptContext === "function")
      ? window.getActiveInterceptContext()
      : null;
    if (panel.classList.contains("open")) {
      applyActiveInterceptToScope();
      loadList();
    }
  });
})();
