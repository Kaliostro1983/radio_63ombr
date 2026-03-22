(function () {
  const form = document.getElementById("interceptsFilterForm");
  const warningBox = document.getElementById("interceptsWarning");
  const mainCard = document.querySelector(".intercepts-main-card");
  const foundCountPill = document.getElementById("interceptsFoundCount");
  const paneView = document.getElementById("itPaneView");

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
    loadingMore: false,
    loadingDetail: false,
    savingComment: false,
    detailById: {},
    landmarkMatchesByMessageId: {},
    autocompleteBox: null,
    autocompleteInput: null,
    autocompleteItems: [],
    autocompleteIndex: -1,
    hoverRefreshByMessageId: {},
    hoverRefreshInFlight: {},
    infiniteObserver: null,
    paneWasHidden: true,
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

  function setFoundCount(value) {
    if (!foundCountPill) return;
    if (value == null || value === "") {
      foundCountPill.textContent = "—";
      return;
    }
    foundCountPill.textContent = String(value);
  }

  function buildQuery() {
    const formData = new FormData(form);
    const params = new URLSearchParams();

    const startDt = String(formData.get("period_start") || "").trim();
    const endDt = String(formData.get("period_end") || "").trim();
    const network = String(formData.get("network") || "").trim();
    const callsign = String(formData.get("callsign") || "").trim();

    if (startDt) {
      params.set("start_dt", startDt);
    }

    if (endDt) {
      params.set("end_dt", endDt);
    }

    if (network) {
      params.set("network", network);
    }

    if (callsign) {
      params.set("callsign", callsign);
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

    const frequency = String(network.frequency || "").trim();
    const mask = String(network.mask || "").trim();
    const freqMask = frequency
      ? (mask ? `${frequency} (${mask})` : frequency)
      : (mask ? `(${mask})` : "");

    // Keep only the detailed description line to avoid duplicate prefixes.
    const rest = String(item.net_description || "").trim();

    return {
      dt,
      freqMask,
      rest,
    };
  }

  async function copyTextToClipboard(text) {
    const value = String(text ?? "");
    if (!value) return false;

    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (e) {}

    // Fallback for older browsers / clipboard restrictions.
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "true");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.left = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e2) {
      return false;
    }
  }

  function buildInterceptCopyText(messageId) {
    const mid = Number(messageId || 0);
    if (!mid) return "";

    const item = (state.items || []).find((x) => Number(x.id) === mid) || null;
    if (!item) return "";

    const detail = state.detailById[mid] || {};
    const callsigns = Array.isArray(detail.callsigns) ? detail.callsigns : [];

    const callerNames = callsigns
      .filter((x) => String(x.role || "") === "caller")
      .map((x) => String(x.name || "").trim())
      .filter(Boolean);

    // In the standard template we treat both "callee" and "mentioned"
    // as "callees" list to output a single 2nd callsign line.
    const calleeNames = callsigns
      .filter((x) => {
        const r = String(x.role || "");
        return r === "callee" || r === "mentioned";
      })
      .map((x) => String(x.name || "").trim())
      .filter(Boolean);

    const callerLine = callerNames.join(", ");
    const calleesLine = calleeNames.join(", ");

    const header = getHeaderParts(item);

    const network = item.network || {};
    const freq = String(network.frequency || "").trim();
    const mask = String(network.mask || "").trim();
    // Standard requirement:
    // 2nd line is ONLY mask if present, otherwise ONLY frequency.
    const secondLine = mask ? mask : freq;

    const netLine = String(item.net_description || "").trim();
    const body = String(detail.text || item.text || "").trimEnd();

    const parts = [
      header.dt,
      secondLine,
      netLine,
      callerLine,
      calleesLine,
    ];

    if (body) {
      parts.push("");
      parts.push(body);
    }
    return parts.join("\n");
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

  function disconnectInfiniteScrollObserver() {
    if (state.infiniteObserver) {
      state.infiniteObserver.disconnect();
      state.infiniteObserver = null;
    }
  }

  function setupInfiniteScrollObserver() {
    disconnectInfiniteScrollObserver();
    if (!paneView || paneView.classList.contains("hidden")) return;
    if (!listHasMore()) return;
    const sentinel = document.getElementById("interceptsInfiniteSentinel");
    if (!sentinel) return;

    if (!("IntersectionObserver" in window)) {
      return;
    }

    state.infiniteObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          if (paneView.classList.contains("hidden")) return;
          loadMoreIntercepts();
        }
      },
      { root: null, rootMargin: "0px 0px 480px 0px", threshold: 0 }
    );
    state.infiniteObserver.observe(sentinel);
  }

  function renderLoading() {
    disconnectInfiniteScrollObserver();
    mainCard.innerHTML = `
      <div class="intercepts-main-card__empty">Завантаження...</div>
    `;
  }

  function renderEmpty() {
    disconnectInfiniteScrollObserver();
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

  function normalizeMatches(matches) {
    if (!Array.isArray(matches)) return [];
    return matches
      .map((m, source_index) => ({
        source_index,
        id: Number(m.id || 0),
        id_message: Number(m.id_message || 0),
        id_landmark: Number(m.id_landmark || 0),
        matched_text: String(m.matched_text || ""),
        start_pos: Number(m.start_pos),
        end_pos: Number(m.end_pos),
        landmark: m.landmark || {},
      }))
      .filter(
        (m) =>
          Number.isFinite(m.start_pos) &&
          Number.isFinite(m.end_pos) &&
          m.start_pos >= 0 &&
          m.end_pos > m.start_pos
      )
      .sort((a, b) => a.start_pos - b.start_pos);
  }

  function renderTextWithLandmarkHighlights(messageId, text, matchesRaw) {
    const src = String(text || "");
    if (!src) return "";

    const matches = normalizeMatches(matchesRaw);
    if (!matches.length) return escapeHtml(src);

    let out = "";
    let cursor = 0;
    let rendered = 0;

    for (let idx = 0; idx < matches.length; idx += 1) {
      const m = matches[idx];
      if (m.start_pos < cursor || m.end_pos > src.length) {
        continue;
      }

      out += escapeHtml(src.slice(cursor, m.start_pos));

      const chunk = src.slice(m.start_pos, m.end_pos);
      const landmarkName = String((m.landmark && m.landmark.name) || "");
      const title = landmarkName ? `Орієнтир: ${landmarkName}` : "Орієнтир";

      // Important: do not add newlines/indentation around the <span>,
      // otherwise pre-wrap layout will render them as extra "enters".
      out += `<span class="intercepts-landmark-hit" data-message-id="${messageId}" data-match-index="${m.source_index}" title="${escapeHtml(title)}">${escapeHtml(chunk)}</span>`;
      cursor = m.end_pos;
      rendered += 1;
    }

    out += escapeHtml(src.slice(cursor));
    return rendered ? out : escapeHtml(src);
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

  function listHasMore() {
    return state.total > 0 && state.items.length < state.total;
  }

  function renderListFooterHtml() {
    if (!state.items.length) return "";
    const shown = state.items.length;
    const total = state.total;
    if (shown >= total) {
      return `<div class="intercepts-list-footer"><p class="intercepts-list-footer__done small">Усі перехоплення показано (${total}).</p></div>`;
    }
    return `<div class="intercepts-list-footer">
      <button type="button" class="secondary" id="interceptsLoadMoreBtn">Завантажити ще</button>
      <p class="intercepts-list-footer__hint small">Показано ${shown} з ${total}</p>
    </div>`;
  }

  function replaceListFooter() {
    const prev = mainCard.querySelector(".intercepts-list-footer");
    if (prev) prev.remove();
    if (!state.items.length) return;
    const listEl = mainCard.querySelector(".intercepts-list");
    if (!listEl) return;
    listEl.insertAdjacentHTML("afterend", renderListFooterHtml());
  }

  function renderInterceptCardHtml(item) {
    const header = getHeaderParts(item);
    const detail = state.detailById[item.id] || {
      id: item.id,
      network_id: item.network_id,
      text: item.text || "",
      comment: item.comment || "",
      callsigns: [],
    };
    const matches = state.landmarkMatchesByMessageId[item.id] || [];
    const highlightedText = renderTextWithLandmarkHighlights(
      item.id,
      detail.text || item.text || "",
      matches
    );

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
                <div style="display:flex; justify-content:flex-end; margin-bottom:8px">
                  <button
                    type="button"
                    class="intercepts-copy-btn secondary"
                    data-message-id="${item.id}"
                    title="Скопіювати перехоплення у стандартному форматі"
                  >Копіювати</button>
                </div>
                <div class="intercept-card__text">${highlightedText}</div>
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

                <section class="intercepts-lm-panel intercepts-lm-panel--inside" aria-label="Орієнтири">
                  <div class="intercepts-lm-panel__row">
                    <div class="field intercepts-lm-panel__field">
                      <label for="ieLmName-${detail.id}">Орієнтири</label>
                      <input
                        id="ieLmName-${detail.id}"
                        class="ie-lm-name-input"
                        type="text"
                        placeholder="пошук за назвою..."
                        autocomplete="off"
                        data-message-id="${detail.id}"
                      />
                    </div>
                    <div class="intercepts-lm-panel__actions">
                      <button
                        type="button"
                        class="icon-btn ie-lm-search-btn"
                        title="Шукати орієнтири"
                        aria-label="Шукати орієнтири"
                        data-message-id="${detail.id}"
                      >
                        <img src="/static/icons/ui/search.svg" alt="" width="20" height="20" />
                      </button>
                      <button
                        type="button"
                        class="icon-btn icon-btn--accent ie-lm-create-btn"
                        title="Додати орієнтир"
                        aria-label="Додати орієнтир"
                      >
                        <img src="/static/icons/ui/plus.svg" alt="" width="20" height="20" />
                      </button>
                    </div>
                  </div>
                  <div class="intercepts-lm-panel__result" data-message-id="${detail.id}"></div>
                </section>
              </div>
            </aside>
          </div>
        </article>
      `;
  }

  function renderList() {
    if (!state.items.length) {
      renderEmpty();
      return;
    }

    const itemsHtml = state.items.map((item) => renderInterceptCardHtml(item)).join("");
    mainCard.innerHTML = `<div class="intercepts-list">${itemsHtml}<div class="intercepts-infinite-sentinel" id="interceptsInfiniteSentinel" aria-hidden="true"></div></div>${renderListFooterHtml()}`;
    setupInfiniteScrollObserver();
  }

  async function loadDetail(messageId) {
    if (!messageId || state.loadingDetail) {
      return;
    }

    state.loadingDetail = true;

    try {
      const [detailResponse, landmarksResponse] = await Promise.all([
        fetch(`/api/intercepts-explorer/${messageId}`, {
          method: "GET",
          headers: { Accept: "application/json" },
        }),
        fetch(`/api/intercepts-explorer/${messageId}/landmarks`, {
          method: "GET",
          headers: { Accept: "application/json" },
        }),
      ]);

      if (!detailResponse.ok) {
        throw new Error(`HTTP ${detailResponse.status}`);
      }

      const data = await detailResponse.json();
      state.detailById[messageId] = data.item || null;

      if (landmarksResponse.ok) {
        const lmData = await landmarksResponse.json();
        state.landmarkMatchesByMessageId[messageId] = Array.isArray(lmData.matches)
          ? lmData.matches
          : [];
      } else {
        state.landmarkMatchesByMessageId[messageId] = [];
      }
      renderList();
    } catch (error) {
      console.error(error);
      renderWarning("Не вдалося завантажити деталі перехоплення.");
    } finally {
      state.loadingDetail = false;
    }
  }

  async function refreshCallsignsOnHover(messageId) {
    if (!messageId) return;

    const now = Date.now();
    const last = Number(state.hoverRefreshByMessageId[messageId] || 0);
    // Protect API from noisy mouse movement.
    if (now - last < 3000) return;
    if (state.hoverRefreshInFlight[messageId]) return;

    state.hoverRefreshInFlight[messageId] = true;
    try {
      const response = await fetch(`/api/intercepts-explorer/${messageId}`, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) return;

      const data = await response.json();
      const item = data && data.item ? data.item : null;
      if (!item) return;

      const prev = state.detailById[messageId] || {};
      state.detailById[messageId] = item;
      state.hoverRefreshByMessageId[messageId] = now;

      const prevCallsigns = JSON.stringify(prev.callsigns || []);
      const newCallsigns = JSON.stringify(item.callsigns || []);
      if (prevCallsigns !== newCallsigns) {
        renderList();
      }
    } catch (error) {
      console.error(error);
    } finally {
      state.hoverRefreshInFlight[messageId] = false;
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
        let detail = "";
        try {
          const data = await response.json();
          detail =
            data.detail ||
            data.error ||
            data.message ||
            (typeof data === "string" ? data : "") ||
            "";
        } catch (e) {
          try {
            detail = await response.text();
          } catch (e2) {
            detail = "";
          }
        }
        throw new Error(detail ? detail : `HTTP ${response.status}`);
      }

      const data = await response.json();

      if (state.detailById[messageId]) {
        state.detailById[messageId].callsigns = data.callsigns || [];
      }

      closeAutocomplete();
      renderList();
      focusCallsignInput(messageId, role);
    } catch (error) {
      console.error(error);
      renderWarning(String(error?.message || "Не вдалося додати позивний."));
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
        let detail = "";
        try {
          const data = await response.json();
          detail =
            data.detail ||
            data.error ||
            data.message ||
            (typeof data === "string" ? data : "") ||
            "";
        } catch (e) {
          try {
            detail = await response.text();
          } catch (e2) {
            detail = "";
          }
        }
        throw new Error(detail ? detail : `HTTP ${response.status}`);
      }

      const data = await response.json();

      if (state.detailById[messageId]) {
        state.detailById[messageId].callsigns = data.callsigns || [];
      }

      renderList();
      focusCallsignInput(messageId, role);
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
    state.landmarkMatchesByMessageId = {};
    closeAutocomplete();
    renderWarning("");
    renderLoading();
    setFoundCount("—");

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
      state.offset = state.items.length;
      setFoundCount(state.total);

      renderList();
      // Lazy-load detail for only the first visible card.
      // Previously we fetched detail+landmarks for *every* item sequentially,
      // which caused long waits and "database is locked" under load.
      if (state.items && state.items.length) {
        const firstId = Number(state.items[0].id || 0);
        if (firstId) {
          loadDetail(firstId).catch(() => {});
        }
      }
    } catch (error) {
      console.error(error);
      renderWarning("Не вдалося завантажити перехоплення.");
      renderEmpty();
      setFoundCount("—");
    } finally {
      state.loadingList = false;
    }
  }

  async function loadMoreIntercepts() {
    if (state.loadingMore || state.loadingList || !listHasMore()) {
      return;
    }

    state.loadingMore = true;
    const prevBtn = document.getElementById("interceptsLoadMoreBtn");
    if (prevBtn) {
      prevBtn.disabled = true;
      prevBtn.textContent = "Завантаження…";
    }

    state.offset = state.items.length;
    closeAutocomplete();
    renderWarning("");

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
      state.total = Number(data.total || state.total);
      const newItems = Array.isArray(data.items) ? data.items : [];

      if (!newItems.length) {
        state.total = state.items.length;
        replaceListFooter();
        if (!listHasMore()) disconnectInfiniteScrollObserver();
        return;
      }

      state.items.push(...newItems);
      state.offset = state.items.length;

      const listEl = mainCard.querySelector(".intercepts-list");
      if (listEl) {
        const sentinel = document.getElementById("interceptsInfiniteSentinel");
        const chunk = newItems.map((item) => renderInterceptCardHtml(item)).join("");
        if (sentinel) {
          sentinel.insertAdjacentHTML("beforebegin", chunk);
        } else {
          listEl.insertAdjacentHTML("beforeend", chunk);
        }
        replaceListFooter();
        if (listHasMore()) {
          setupInfiniteScrollObserver();
        } else {
          disconnectInfiniteScrollObserver();
        }
      } else {
        renderList();
      }
    } catch (error) {
      console.error(error);
      renderWarning("Не вдалося дозавантажити перехоплення.");
      replaceListFooter();
    } finally {
      state.loadingMore = false;
      const btn = document.getElementById("interceptsLoadMoreBtn");
      if (btn && listHasMore()) {
        btn.disabled = false;
        btn.textContent = "Завантажити ще";
      }
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

  function focusCallsignInput(messageId, role) {
    // `renderList()` re-creates inline editors and inputs, which makes the
    // browser drop focus. Restore focus to the input after re-render.
    requestAnimationFrame(function () {
      const selector =
        '.callsign-input[data-message-id="' +
        String(messageId) +
        '"][data-role="' +
        String(role) +
        '"]';
      const inputEl = document.querySelector(selector);
      if (!inputEl) return;

      inputEl.focus();
      try {
        const v = String(inputEl.value || "");
        inputEl.setSelectionRange(v.length, v.length);
      } catch {}
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    state.offset = 0;
    loadIntercepts();
  });

  mainCard.addEventListener("click", async function (event) {
    const loadMoreHit = event.target.closest("#interceptsLoadMoreBtn");
    if (loadMoreHit) {
      event.preventDefault();
      loadMoreIntercepts();
      return;
    }

    async function runLandmarkSearch(panel) {
      if (!panel) return;
      const input = panel.querySelector(".ie-lm-name-input");
      const out = panel.querySelector(".intercepts-lm-panel__result");
      if (!input || !out) return;

      const query = String(input.value || "").trim();
      if (!query) {
        out.innerHTML = `<div class="intercepts-lm-panel__hint">Введіть слово для пошуку</div>`;
        return;
      }

      out.innerHTML = `<div class="intercepts-lm-panel__hint">Пошук...</div>`;
      try {
        const card = panel.closest(".intercept-card");
        const messageId = card ? Number(card.dataset.id || 0) : 0;
        const row = messageId
          ? state.items.find((x) => Number(x.id) === messageId)
          : null;
        const netGroupId =
          row && row.network && row.network.group_id != null
            ? Number(row.network.group_id)
            : null;

        const url = `/api/landmarks/search?name=${encodeURIComponent(query)}&limit=20&offset=0`;
        const response = await fetch(url, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const items = Array.isArray(data.items) ? data.items : [];
        const qNorm = query.toLocaleLowerCase();
        const sortedItems = items
          .slice()
          .sort((a, b) => {
            const an = String(a?.name || "").trim();
            const bn = String(b?.name || "").trim();
            const al = an.toLocaleLowerCase();
            const bl = bn.toLocaleLowerCase();

            const ai = al.indexOf(qNorm);
            const bi = bl.indexOf(qNorm);

            const aExact = ai === 0 && al.length === qNorm.length;
            const bExact = bi === 0 && bl.length === qNorm.length;
            if (aExact !== bExact) return aExact ? -1 : 1;

            const aPrefix = ai === 0;
            const bPrefix = bi === 0;
            if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;

            const aHas = ai >= 0;
            const bHas = bi >= 0;
            if (aHas !== bHas) return aHas ? -1 : 1;

            if (aHas && bHas && ai !== bi) return ai - bi;

            return an.localeCompare(bn, "uk");
          });
        if (!sortedItems.length) {
          out.innerHTML = `<div class="intercepts-lm-panel__hint">Нічого не знайдено</div>`;
          return;
        }

        function highlightMatch(name, queryText) {
          const raw = String(name || "");
          const q = String(queryText || "");
          if (!raw || !q) return escapeHtml(raw);

          const lower = raw.toLocaleLowerCase();
          const qLower = q.toLocaleLowerCase();
          const idx = lower.indexOf(qLower);
          if (idx < 0) return escapeHtml(raw);

          const before = escapeHtml(raw.slice(0, idx));
          const match = escapeHtml(raw.slice(idx, idx + q.length));
          const after = escapeHtml(raw.slice(idx + q.length));
          return `${before}<span class="intercepts-lm-chip__hl">${match}</span>${after}`;
        }

        out.innerHTML = sortedItems
          .map((item) => {
            const id = Number(item.id || 0);
            const rawName = String(item.name || "").trim();
            const name = highlightMatch(rawName, query);
            const gId = item.group_id != null ? Number(item.group_id) : null;
            const sameGroup =
              netGroupId != null && gId != null && Number(netGroupId) === Number(gId);
            const cls = sameGroup
              ? "intercepts-lm-chip intercepts-lm-chip--same-group"
              : "intercepts-lm-chip";
            return `<button type="button" class="${cls}" data-lm-id="${id}" title="Відкрити орієнтир">${name}</button>`;
          })
          .join("");
      } catch (error) {
        console.error(error);
        out.innerHTML = `<div class="intercepts-lm-panel__hint">Помилка пошуку</div>`;
      }
    }

    const copyBtn = event.target.closest(".intercepts-copy-btn");
    if (copyBtn) {
      const messageId = Number(copyBtn.dataset.messageId || 0);
      if (!messageId) return;

      const text = buildInterceptCopyText(messageId);
      if (!text) {
        renderWarning("Немає даних для копіювання.");
        return;
      }

      const ok = await copyTextToClipboard(text);
      renderWarning(ok ? "Скопійовано в буфер." : "Не вдалося скопіювати.");
      return;
    }

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

    const lmSearchBtn = event.target.closest(".ie-lm-search-btn");
    if (lmSearchBtn) {
      const panel = lmSearchBtn.closest(".intercepts-lm-panel");
      await runLandmarkSearch(panel);
      return;
    }

    const lmCreateBtn = event.target.closest(".ie-lm-create-btn");
    if (lmCreateBtn) {
      if (typeof window.openLandmarkCreateModal === "function") {
        window.openLandmarkCreateModal();
      }
      return;
    }

    const lmChip = event.target.closest(".intercepts-lm-chip");
    if (lmChip) {
      const landmarkId = Number(lmChip.dataset.lmId || 0);
      if (landmarkId && typeof window.openLandmarkEditModalById === "function") {
        try {
          await window.openLandmarkEditModalById(landmarkId);
        } catch (error) {
          console.error(error);
          renderWarning(String(error?.message || "Не вдалося відкрити орієнтир."));
        }
      }
      return;
    }

    const landmarkHit = event.target.closest(".intercepts-landmark-hit");
    if (landmarkHit) {
      const messageId = Number(landmarkHit.dataset.messageId || 0);
      const matchIndex = Number(landmarkHit.dataset.matchIndex || -1);
      const list = state.landmarkMatchesByMessageId[messageId] || [];
      const match = list[matchIndex];
      if (messageId && match) {
        window.dispatchEvent(
          new CustomEvent("interceptsLandmarkSelected", {
            detail: {
              messageId,
              match,
              location_wkt: (match.landmark && match.landmark.location_wkt) || "",
              location_kind: (match.landmark && match.landmark.location_kind) || "",
            },
          })
        );
      }
      return;
    }

  });

  mainCard.addEventListener("mouseover", function (event) {
    const card = event.target.closest(".intercept-card");
    if (!card) return;

    // Fire only when cursor enters the card from outside, not on every child move.
    const from = event.relatedTarget;
    if (from && card.contains(from)) return;

    const messageId = Number(card.dataset.id || 0);
    if (!messageId) return;
    refreshCallsignsOnHover(messageId).catch(() => {});
  });

  window.addEventListener("callsignModalDeleted", function (ev) {
    const data = ev && ev.detail ? ev.detail.data : null;
    if (!data || !data.callsign_id) return;
    const mids = Object.keys(state.detailById)
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0);
    if (!mids.length) return;

    Promise.all(
      mids.map((messageId) =>
        fetch(`/api/intercepts-explorer/${messageId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (!d || !d.item) return;
            state.detailById[messageId] = d.item;
          })
          .catch(() => {})
      )
    ).then(() => {
      renderList();
    });
  });

  mainCard.addEventListener("input", function (event) {
    const input = event.target.closest(".callsign-input");
    if (input) {
      showAutocomplete(input);
    }
  });

  mainCard.addEventListener("keydown", async function (event) {
    const lmInput = event.target.closest(".ie-lm-name-input");
    if (lmInput && event.key === "Enter") {
      event.preventDefault();
      const panel = lmInput.closest(".intercepts-lm-panel");
      const lmSearchBtn = panel ? panel.querySelector(".ie-lm-search-btn") : null;
      if (lmSearchBtn) lmSearchBtn.click();
      return;
    }

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

  function onWindowScrollLoadMore() {
    if (!paneView || paneView.classList.contains("hidden")) return;
    if (state.loadingMore || state.loadingList || !listHasMore()) return;
    const doc = document.documentElement;
    if (doc.scrollHeight <= window.innerHeight + 120) return;
    const scrollBottom = window.scrollY + window.innerHeight;
    const threshold = doc.scrollHeight - 400;
    if (scrollBottom >= threshold) {
      loadMoreIntercepts();
    }
  }

  let scrollLoadMoreRaf = 0;
  function scheduleScrollLoadMore() {
    if (scrollLoadMoreRaf) return;
    scrollLoadMoreRaf = requestAnimationFrame(() => {
      scrollLoadMoreRaf = 0;
      onWindowScrollLoadMore();
    });
  }

  if (!("IntersectionObserver" in window)) {
    window.addEventListener("scroll", scheduleScrollLoadMore, { passive: true });
  }

  if (paneView && "MutationObserver" in window) {
    new MutationObserver(() => {
      const hidden = paneView.classList.contains("hidden");
      if (hidden) {
        state.paneWasHidden = true;
        return;
      }
      if (state.paneWasHidden) {
        state.paneWasHidden = false;
        setupInfiniteScrollObserver();
      }
    }).observe(paneView, { attributes: true, attributeFilter: ["class"] });
  }

  loadIntercepts();
})();