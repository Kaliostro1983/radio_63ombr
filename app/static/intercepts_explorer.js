(function () {
  const form = document.getElementById("interceptsFilterForm");
  const warningBox = document.getElementById("interceptsWarning");
  const mainCard = document.querySelector(".intercepts-main-card");

  if (!form || !mainCard) {
    return;
  }

  const state = {
    limit: 50,
    offset: 0,
    total: 0,
    items: [],
    selectedId: null,
    loadingList: false,
    loadingDetail: false,
    savingComment: false,
    detailById: {},
    autocompleteBox: null,
    autocompleteInput: null,
    autocompleteItems: [],
    autocompleteIndex: -1,
  };

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderWarning(message) {
    if (!message) {
      warningBox.style.display = "none";
      warningBox.textContent = "";
      return;
    }

    warningBox.style.display = "block";
    warningBox.textContent = message;
  }

  function buildQuery() {
    const formData = new FormData(form);
    const params = new URLSearchParams();

    const startDt = String(formData.get("period_start") || "").trim();
    const endDt = String(formData.get("period_end") || "").trim();
    const network = String(formData.get("network") || "").trim();

    if (startDt) {
      params.set("start_dt", startDt);
    }

    if (endDt) {
      params.set("end_dt", endDt);
    }

    if (network) {
      params.set("network", network);
    }

    params.set("limit", String(state.limit));
    params.set("offset", String(state.offset));

    return params.toString();
  }

  function formatDateTime(value) {
    if (!value) {
      return "";
    }

    let raw = String(value).trim();
    raw = raw.replace("Z", "");

    const directDate = new Date(raw);
    if (!Number.isNaN(directDate.getTime())) {
      const dd = String(directDate.getDate()).padStart(2, "0");
      const mm = String(directDate.getMonth() + 1).padStart(2, "0");
      const yyyy = directDate.getFullYear();
      const hh = String(directDate.getHours()).padStart(2, "0");
      const mi = String(directDate.getMinutes()).padStart(2, "0");
      const ss = String(directDate.getSeconds()).padStart(2, "0");
      return `${dd}.${mm}.${yyyy}, ${hh}:${mi}:${ss}`;
    }

    const normalized = raw.replace("T", " ");
    if (normalized.length >= 19) {
      const datePart = normalized.slice(0, 10);
      const timePart = normalized.slice(11, 19);
      const [yyyy, mm, dd] = datePart.split("-");
      return `${dd}.${mm}.${yyyy}, ${timePart}`;
    }

    return raw;
  }

  function getHeaderParts(item) {
    const network = item.network || {};
    const dt = formatDateTime(item.created_at || item.received_at || "");

    const freqMaskParts = [];
    if (network.frequency) {
      freqMaskParts.push(network.frequency);
    }
    if (network.mask) {
      freqMaskParts.push(network.mask);
    }

    const restParts = [];
    if (network.unit) {
      restParts.push(network.unit);
    }
    if (network.zone) {
      restParts.push(network.zone);
    }
    if (item.net_description) {
      restParts.push(item.net_description);
    }

    return {
      dt,
      freqMask: freqMaskParts.join(" • "),
      rest: restParts.join(" • "),
    };
  }

  function closeAutocomplete() {
    if (state.autocompleteBox) {
      state.autocompleteBox.remove();
    }
    state.autocompleteBox = null;
    state.autocompleteInput = null;
    state.autocompleteItems = [];
    state.autocompleteIndex = -1;
  }

  function renderLoading() {
    mainCard.innerHTML = `
      <div class="intercepts-main-card__empty">Завантаження...</div>
    `;
  }

  function renderEmpty() {
    mainCard.innerHTML = `
      <div class="intercepts-main-card__empty">
        За вибраними фільтрами нічого не знайдено.
      </div>
    `;
  }

  function renderCallsignChips(items, role) {
    return items
      .map(
        (item) => {
          const statusId = (item.status_id != null && item.status_id !== "") ? item.status_id : "_default";
          return `
          <div class="callsign-chip callsign-chip--clickable" data-id="${item.id}" data-role="${role}" title="Редагувати позивний">
            <img class="callsign-chip__icon" src="/static/icons/callsign_statuses/${statusId}.svg" alt="">
            <span class="callsign-chip__name">${escapeHtml(item.name)}</span>
            <button
              type="button"
              class="callsign-chip__remove"
              title="Видалити"
              aria-label="Видалити"
            >×</button>
          </div>
        `;
        }
      )
      .join("");
  }

  function renderInlineEditor(detail) {
    const callsigns = Array.isArray(detail.callsigns) ? detail.callsigns : [];
    const caller = callsigns.filter((x) => x.role === "caller");
    const callee = callsigns.filter((x) => x.role === "callee");
    const mentioned = callsigns.filter((x) => x.role === "mentioned");

    function renderCompactRole(title, role, items) {
      return `
        <div class="compact-role-block">
          <label class="compact-role-label">${title}</label>
          <div class="compact-role-input-wrap">
            <input
              class="callsign-input callsign-input--compact"
              data-role="${role}"
              data-message-id="${detail.id}"
              placeholder="Позивний + Enter"
              autocomplete="off"
            >
          </div>
          <div class="compact-role-chips">
            ${renderCallsignChips(items, role)}
          </div>
        </div>
      `;
    }

    return `
      <div class="intercepts-inline-editor intercepts-inline-editor--compact" data-message-id="${detail.id}">
        <div class="compact-callsigns-grid">
          ${renderCompactRole("Хто викликає", "caller", caller)}
          ${renderCompactRole("Кого викликають", "callee", callee)}
          ${renderCompactRole("Згадувані", "mentioned", mentioned)}
        </div>

        <form class="intercepts-comment-form intercepts-comment-form--compact" data-message-id="${detail.id}">
          <label class="intercepts-editor-label">Висновок / коментар</label>
          <textarea
            class="intercepts-comment-textarea intercepts-comment-textarea--compact"
            name="comment"
            placeholder="Коментар"
          >${escapeHtml(detail.comment || "")}</textarea>
          <div class="intercepts-comment-actions intercepts-comment-actions--compact">
            <button type="submit" class="intercepts-save-btn">Зберегти</button>
          </div>
        </form>
      </div>
    `;
  }

  function renderList() {
  if (!state.items.length) {
    renderEmpty();
    return;
  }

  const itemsHtml = state.items
    .map((item) => {
      const header = getHeaderParts(item);
      const detail = state.detailById[item.id] || {
        id: item.id,
        network_id: item.network_id,
        comment: item.comment || "",
        callsigns: [],
      };

      const callsigns = Array.isArray(detail.callsigns) ? detail.callsigns : [];
      const caller = callsigns.filter((x) => x.role === "caller");
      const callee = callsigns.filter((x) => x.role === "callee");
      const mentioned = callsigns.filter((x) => x.role === "mentioned");

      return `
        <article class="intercept-card" data-id="${item.id}">
          <div class="intercept-card__body intercept-card__body--compact">
            <section class="intercept-card__main">
              <div
                class="intercept-card__left intercept-card__left--static"
                data-action="select"
                data-id="${item.id}"
              >
                <div class="intercept-card__line intercept-card__line--dt">
                  ${escapeHtml(header.dt)}
                </div>
                <div class="intercept-card__line intercept-card__line--freq">
                  ${escapeHtml(header.freqMask)}
                </div>
                <div class="intercept-card__line intercept-card__line--net">
                  ${escapeHtml(header.rest)}
                </div>
                <div class="intercept-card__text">${escapeHtml(item.text || "")}</div>
              </div>

              <div class="intercept-card__comment-under">
                <form class="intercepts-comment-form intercepts-comment-form--under" data-message-id="${detail.id}">
                  <label class="intercepts-editor-label">Висновок / коментар</label>
                  <textarea
                    class="intercepts-comment-textarea intercepts-comment-textarea--under"
                    name="comment"
                    placeholder="Коментар"
                  >${escapeHtml(detail.comment || "")}</textarea>
                  <div class="intercepts-comment-actions intercepts-comment-actions--compact">
                    <button type="submit" class="intercepts-save-btn">Зберегти</button>
                  </div>
                </form>
              </div>
            </section>

            <aside class="intercept-card__right intercept-card__right--compact">
              <div class="intercepts-inline-editor intercepts-inline-editor--compact" data-message-id="${detail.id}">
                <div class="compact-callsigns-stack">
                  ${renderCallsignField("Хто викликає", "caller", caller, detail.id)}
                  ${renderCallsignField("Кого викликають", "callee", callee, detail.id)}
                  ${renderCallsignField("Згадувані", "mentioned", mentioned, detail.id)}
                </div>
              </div>
            </aside>
          </div>
        </article>
      `;
    })
    .join("");

  mainCard.innerHTML = `<div class="intercepts-list">${itemsHtml}</div>`;
}

  async function loadDetail(messageId) {
    if (!messageId || state.loadingDetail) {
      return;
    }

    state.loadingDetail = true;

    try {
      const response = await fetch(`/api/intercepts-explorer/${messageId}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      state.detailById[messageId] = data.item || null;
      renderList();
    } catch (error) {
      console.error(error);
      renderWarning("Не вдалося завантажити деталі перехоплення.");
    } finally {
      state.loadingDetail = false;
    }
  }

  async function saveComment(messageId, comment) {
    if (!messageId || state.savingComment) {
      return;
    }

    state.savingComment = true;
    renderWarning("");

    try {
      const response = await fetch(`/api/intercepts-explorer/${messageId}/comment`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ comment }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const savedComment = String(data.comment || "");

      if (state.detailById[messageId]) {
        state.detailById[messageId].comment = savedComment;
      }

      const listItem = state.items.find((x) => x.id === messageId);
      if (listItem) {
        listItem.comment = savedComment;
      }

      renderWarning("Коментар збережено.");
      renderList();
    } catch (error) {
      console.error(error);
      renderWarning("Не вдалося зберегти коментар.");
    } finally {
      state.savingComment = false;
    }
  }

  async function addCallsign(messageId, role, name) {
    try {
      const response = await fetch(`/api/intercepts-explorer/${messageId}/callsigns`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          name,
          role,
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (state.detailById[messageId]) {
        state.detailById[messageId].callsigns = data.callsigns || [];
      }

      closeAutocomplete();
      renderList();
    } catch (error) {
      console.error(error);
      renderWarning("Не вдалося додати позивний.");
    }
  }

  async function deleteCallsign(messageId, callsignId, role) {
    try {
      const response = await fetch(
        `/api/intercepts-explorer/${messageId}/callsigns/${callsignId}?role=${encodeURIComponent(role)}`,
        {
          method: "DELETE",
          headers: { Accept: "application/json" },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (state.detailById[messageId]) {
        state.detailById[messageId].callsigns = data.callsigns || [];
      }

      renderList();
    } catch (error) {
      console.error(error);
      renderWarning("Не вдалося видалити позивний.");
    }
  }

  function highlightAutocomplete() {
    if (!state.autocompleteBox) {
      return;
    }

    const items = state.autocompleteBox.querySelectorAll(".callsign-autocomplete__item");
    items.forEach((el, index) => {
      el.classList.toggle("is-selected", index === state.autocompleteIndex);
    });
  }

  async function showAutocomplete(input) {
  const value = input.value.trim();
  const messageId = Number(input.dataset.messageId || 0);
  const detail = state.detailById[messageId];

  if (!detail || value.length < 2) {
    closeAutocomplete();
    return;
  }

  try {
    let url = `/api/callsigns/autocomplete?q=${encodeURIComponent(value)}`;
    if (detail.network_id) {
      url += `&network_id=${detail.network_id}`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      closeAutocomplete();
      return;
    }

    const data = await response.json();
    const items = Array.isArray(data.items) ? data.items : [];

    closeAutocomplete();

    if (!items.length) {
      return;
    }

    const wrap = input.closest(".callsign-field-wrap");
    if (!wrap) {
      return;
    }

    state.autocompleteBox = document.createElement("div");
    state.autocompleteBox.className = "callsign-autocomplete";
    state.autocompleteInput = input;
    state.autocompleteItems = items;
    state.autocompleteIndex = -1;

    state.autocompleteBox.innerHTML = items
      .map(
        (item, index) => `
          <button
            type="button"
            class="callsign-autocomplete__item"
            data-index="${index}"
            data-name="${escapeHtml(item.name)}"
          >
            ${escapeHtml(item.name)}
          </button>
        `
      )
      .join("");

    wrap.appendChild(state.autocompleteBox);
  } catch (error) {
    console.error(error);
    closeAutocomplete();
  }
}

  function renderCallsignField(title, role, items, messageId) {
    return `
      <div class="compact-role-block">
        <label class="compact-role-label">${title}</label>

        <div class="callsign-field-wrap">
          <div class="callsign-field-input-wrap">
            ${items.length ? renderCallsignChips(items, role) : ""}
            <input
              class="callsign-input callsign-input--compact callsign-input--embedded"
              data-role="${role}"
              data-message-id="${messageId}"
              placeholder="${items.length ? "" : "Позивний + Enter"}"
              autocomplete="off"
            >
          </div>
        </div>
      </div>
    `;
  }

  async function loadIntercepts() {
    if (state.loadingList) {
      return;
    }

    state.loadingList = true;
    state.detailById = {};
    closeAutocomplete();
    renderWarning("");
    renderLoading();

    try {
      const query = buildQuery();
      const response = await fetch(`/api/intercepts-explorer?${query}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      const data = await response.json();
      state.total = Number(data.total || 0);
      state.items = Array.isArray(data.items) ? data.items : [];

      renderList();

      for (const item of state.items) {
        try {
          const detailResponse = await fetch(`/api/intercepts-explorer/${item.id}`, {
            method: "GET",
            headers: { Accept: "application/json" },
          });

          if (!detailResponse.ok) {
            continue;
          }

          const detailData = await detailResponse.json();
          state.detailById[item.id] = detailData.item || {
            id: item.id,
            network_id: item.network_id,
            comment: item.comment || "",
            callsigns: [],
          };
        } catch (error) {
          console.error(error);
        }
      }

      renderList();
    } catch (error) {
      console.error(error);
      renderWarning("Не вдалося завантажити перехоплення.");
      renderEmpty();
    } finally {
      state.loadingList = false;
    }
  }

  function updateCallsignIconInCard(messageId, callsignId, statusId) {
    const editor = mainCard.querySelector(
      ".intercepts-inline-editor[data-message-id=\"" + messageId + "\"]"
    );
    if (!editor) return;
    const chip = editor.querySelector(".callsign-chip[data-id=\"" + callsignId + "\"]");
    if (!chip) return;
    const icon = chip.querySelector(".callsign-chip__icon");
    if (!icon) return;
    const sid = (statusId != null && statusId !== "") ? statusId : "_default";
    icon.src = "/static/icons/callsign_statuses/" + sid + ".svg";
  }

  function onCallsignModalSaved(ev) {
    const detail = ev && ev.detail;
    if (!detail || !detail.data) return;
    const data = detail.data;
    const context = detail.context || {};
    const messageId = context.messageId;
    if (messageId == null) return;
    const cid = Number(data.callsign_id);
    const statusId = data.status_id != null && data.status_id !== "" ? Number(data.status_id) : null;
    updateCallsignIconInCard(messageId, cid, statusId);
    if (state.detailById[messageId]) {
      const list = state.detailById[messageId].callsigns || [];
      const idx = list.findIndex(function (c) { return Number(c.id) === cid; });
      if (idx !== -1) {
        const prev = list[idx];
        list[idx] = {
          id: cid,
          name: data.name != null && data.name !== "" ? data.name : prev.name,
          comment: data.comment != null ? data.comment : prev.comment,
          status_id: statusId !== null ? statusId : prev.status_id,
          role: prev.role,
        };
      }
    }
  }

  window.addEventListener("callsignModalSaved", onCallsignModalSaved);

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    state.offset = 0;
    loadIntercepts();
  });

  mainCard.addEventListener("click", async function (event) {
    const chipClick = event.target.closest(".callsign-chip--clickable");
    if (chipClick && !event.target.closest(".callsign-chip__remove")) {
      const chip = chipClick;
      const editor = chip.closest(".intercepts-inline-editor");
      const messageId = editor ? Number(editor.dataset.messageId || 0) : 0;
      const callsignId = Number(chip.dataset.id || 0);
      if (callsignId && window.openCallsignEditModalById) {
        window.openCallsignEditModalById(callsignId, { messageId: messageId });
      }
      return;
    }

    const selectBtn = event.target.closest('[data-action="select"]');
    if (selectBtn) {
      const messageId = Number(selectBtn.dataset.id || 0);
      if (!messageId) {
        return;
      }

      if (state.selectedId !== messageId) {
        state.selectedId = messageId;
        renderWarning("");
        renderList();

        if (!state.detailById[messageId]) {
          await loadDetail(messageId);
        }
      }
      return;
    }

    const removeBtn = event.target.closest(".callsign-chip__remove");
    if (removeBtn) {
      const chip = removeBtn.closest(".callsign-chip");
      const editor = removeBtn.closest(".intercepts-inline-editor");
      if (!chip || !editor) {
        return;
      }

      const messageId = Number(editor.dataset.messageId || 0);
      const callsignId = Number(chip.dataset.id || 0);
      const role = String(chip.dataset.role || "");

      if (messageId && callsignId && role) {
        await deleteCallsign(messageId, callsignId, role);
      }
      return;
    }

    const autocompleteBtn = event.target.closest(".callsign-autocomplete__item");
    if (autocompleteBtn && state.autocompleteInput) {
      const name = String(autocompleteBtn.dataset.name || "").trim();
      const input = state.autocompleteInput;
      const messageId = Number(input.dataset.messageId || 0);
      const role = String(input.dataset.role || "").trim();

      if (name && messageId && role) {
        await addCallsign(messageId, role, name);
      }
    }
  });

  mainCard.addEventListener("input", function (event) {
    const input = event.target.closest(".callsign-input");
    if (input) {
      showAutocomplete(input);
    }
  });

  mainCard.addEventListener("keydown", async function (event) {
    const input = event.target.closest(".callsign-input");
    if (!input) {
      return;
    }

    if (event.key === "ArrowDown" && state.autocompleteItems.length) {
      event.preventDefault();
      state.autocompleteIndex =
        (state.autocompleteIndex + 1) % state.autocompleteItems.length;
      highlightAutocomplete();
      return;
    }

    if (event.key === "ArrowUp" && state.autocompleteItems.length) {
      event.preventDefault();
      state.autocompleteIndex =
        (state.autocompleteIndex - 1 + state.autocompleteItems.length) %
        state.autocompleteItems.length;
      highlightAutocomplete();
      return;
    }

    if (event.key === "Escape") {
      closeAutocomplete();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();

      const messageId = Number(input.dataset.messageId || 0);
      const role = String(input.dataset.role || "").trim();

      let name = input.value.trim();
      if (
        state.autocompleteIndex >= 0 &&
        state.autocompleteItems[state.autocompleteIndex]
      ) {
        name = String(state.autocompleteItems[state.autocompleteIndex].name || "").trim();
      }

      if (messageId && role && name) {
        await addCallsign(messageId, role, name);
      }
    }
  });

  mainCard.addEventListener("submit", async function (event) {
    const formEl = event.target.closest(".intercepts-comment-form");
    if (!formEl) {
      return;
    }

    event.preventDefault();

    const messageId = Number(formEl.dataset.messageId || 0);
    const textarea = formEl.querySelector('textarea[name="comment"]');
    const comment = textarea ? textarea.value : "";

    if (messageId) {
      await saveComment(messageId, comment);
    }
  });

    document.addEventListener("click", function (event) {
    if (!event.target.closest(".callsign-field-wrap")) {
      closeAutocomplete();
    }
  });

  loadIntercepts();
})();