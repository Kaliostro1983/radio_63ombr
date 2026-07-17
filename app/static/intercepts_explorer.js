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
    autocompleteSeq: 0,
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
    const callsign2 = String(formData.get("callsign2") || "").trim();

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

    if (callsign2) {
      params.set("callsign2", callsign2);
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
    // Інвалідуємо запит, що ще «в польоті» (гонка: асинхронний showAutocomplete
    // домальовував меню вже після вибору позивного / закриття).
    state.autocompleteSeq = (state.autocompleteSeq || 0) + 1;
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
            <span class="cs-ico-wrap" data-concl-cs-id="${item.id}"><img class="callsign-chip__icon" src="/static/icons/callsign_statuses/${statusId}.svg" alt=""></span>
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
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              data-form-type="other"
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

    // Іконки-теги радіомережі (з detail.network.tags; з'являються після
    // підвантаження деталей — дешевий індексований запит на бекенді).
    const netTags = (detail.network && Array.isArray(detail.network.tags) && detail.network.tags)
      || (item.network && Array.isArray(item.network.tags) && item.network.tags) || [];
    const netTagsHtml = netTags.length
      ? `<div class="intercept-card__nettags">${netTags.map((t) =>
          `<img class="net-tag-icon" src="/static/icons/network_tags/${Number(t.id)}.svg" ` +
          `title="${escapeHtml(t.name || "")}" alt="${escapeHtml(t.name || "")}" ` +
          `onerror="this.onerror=null;this.src='/static/icons/network_tags/_default.svg'">`
        ).join("")}</div>`
      : "";

    // Частота/маска та назва р/м клікабельні → відкривають картку цієї р/м.
    const netId = detail.network_id || item.network_id || "";
    const netLinkCls  = netId ? " intercept-card__netlink" : "";
    const netLinkData = netId ? ` data-network-id="${netId}" title="Відкрити картку р/м"` : "";

    return `
        <article class="intercept-card" data-id="${item.id}">
          <div class="intercept-card__body intercept-card__body--compact">
            <section class="intercept-card__main">
              <div
                class="intercept-card__left intercept-card__left--static"
                data-action="select"
                data-id="${item.id}"
              >
                <button
                  type="button"
                  class="intercepts-copy-btn intercepts-copy-icon-btn"
                  data-message-id="${item.id}"
                  title="Скопіювати перехоплення у стандартному форматі"
                  aria-label="Копіювати"
                ><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M3 11V3a1 1 0 0 1 1-1h7"/></svg></button>
                <div class="intercept-card__line intercept-card__line--dt">
                  ${escapeHtml(header.dt)}
                </div>
                <div class="intercept-card__line intercept-card__line--freq${netLinkCls}"${netLinkData}>
                  ${escapeHtml(header.freqMask)}
                </div>
                <div class="intercept-card__line intercept-card__line--net${netLinkCls}"${netLinkData}>
                  ${escapeHtml(header.rest)}
                </div>
                ${netTagsHtml}
                <div class="intercept-card__text">${highlightedText}</div>
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
    // Оверлеї на іконках позивних (зелена крапка — є висновки; стан 200/300) —
    // так само як у моніторингу.
    if (window.decorateCallsignConclusions) window.decorateCallsignConclusions(mainCard);
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
      if (window.appToast) window.appToast("Збережено.", "info", 1400);
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
      state._lastRole = role;
      renderList();
      _refreshMountedCard(messageId);
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

      state._lastRole = role;
      renderList();
      _refreshMountedCard(messageId);
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

  // Генерація цього запиту — щоб застаріла відповідь (гонка) не домальовувала
  // меню після вибору позивного / закриття / новішого набору.
  const seq = ++state.autocompleteSeq;

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
    if (seq !== state.autocompleteSeq) return;   // застарілий запит → не малюємо
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
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              data-lpignore="true"
              data-1p-ignore="true"
              data-bwignore="true"
              data-form-type="other"
            >
          </div>
        </div>
      </div>
    `;
  }

  /* GET JSON з повторами — короткі розриви зв'язку (нестабільний Tailscale на
     сервері) інакше валили список «Не вдалося завантажити перехоплення».
     Повторюємо мережеві збої та 5xx, але НЕ 4xx (реальна відповідь сервера). */
  /* fetch із тайм-аутом. Нативний fetch не має тайм-ауту: коли Tailscale-лінк
     «підвисає» (stall, а не reset), запит висить безкінечно на «Завантаження…»,
     і повтор не спрацьовує (немає помилки). AbortController перериває запит через
     ms → stall стає помилкою → цикл повтору відпрацьовує нормально. */
  function _fetchWithTimeout(url, opts, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 8000);
    return fetch(url, Object.assign({}, opts || {}, { signal: ctl.signal }))
      .finally(() => clearTimeout(t));
  }

  async function _getJsonWithRetry(url, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      let res;
      try {
        res = await _fetchWithTimeout(url, { method: "GET", headers: { Accept: "application/json" } }, 8000);
      } catch (e) {
        lastErr = e;  // мережевий збій (розрив зв'язку) → повтор
        if (i < tries - 1) { await new Promise((r) => setTimeout(r, 500 * (i + 1))); continue; }
        throw lastErr;
      }
      if (res.ok) return await res.json();
      if (res.status < 500) {
        const t = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${t}`);
      }
      lastErr = new Error(`HTTP ${res.status}`);  // 5xx → повтор
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
    throw lastErr;
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
      const data = await _getJsonWithRetry(`/api/intercepts-explorer?${query}`);
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
      const data = await _getJsonWithRetry(`/api/intercepts-explorer?${query}`);
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
        if (window.decorateCallsignConclusions) window.decorateCallsignConclusions(listEl);
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
    // Картка може бути одночасно і в mainCard (Перегляд), і у замонтованих
    // _mountedCards (Моніторинг). Шукаємо ВСІ збіги по селектору,
    // інакше іконка оновиться лише на одній з них.
    const sid = (statusId != null && statusId !== "") ? statusId : "_default";
    const selector =
      '.intercepts-inline-editor[data-message-id="' + messageId + '"] ' +
      '.callsign-chip[data-id="' + callsignId + '"] .callsign-chip__icon';
    document.querySelectorAll(selector).forEach((icon) => {
      icon.src = "/static/icons/callsign_statuses/" + sid + ".svg";
    });
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
    // На Моніторингу картка змонтована в окремому контейнері, але інпут з
    // .callsign-input може існувати ОДНОЧАСНО в mainCard (Перегляд) і у
    // mounted-картці. Беремо querySelectorAll і фокусуємо ПЕРШИЙ ВИДИМИЙ —
    // інакше фокус ловить інпут на прихованому табі.
    const tryFocus = function () {
      const selector =
        '.callsign-input[data-message-id="' +
        String(messageId) +
        '"][data-role="' +
        String(role) +
        '"]';
      const all = document.querySelectorAll(selector);
      let inputEl = null;
      for (const el of all) {
        if (el.offsetParent !== null) { inputEl = el; break; }
      }
      // Fallback: якщо жоден не пройшов offsetParent-перевірку (буває коли
      // інпут у щойно перерендереному модальному вікні з position:fixed
      // батьком — браузер тимчасово рапортує offsetParent=null), беремо
      // просто перший знайдений елемент.
      if (!inputEl && all.length) inputEl = all[0];
      if (!inputEl) return false;
      if (document.activeElement === inputEl) return true; // вже сфокусовано
      try { inputEl.focus({ preventScroll: false }); } catch (_) { inputEl.focus(); }
      try {
        const v = String(inputEl.value || "");
        inputEl.setSelectionRange(v.length, v.length);
      } catch {}
      return document.activeElement === inputEl;
    };

    // Три фази спроб, щоб подолати:
    //  - innerHTML-перерендер (rAF — після того, як DOM застосовано);
    //  - microtask-черга з focusout-ами після Enter (setTimeout 0);
    //  - відкладені reflow / повторні рендери (setTimeout 60ms).
    requestAnimationFrame(function () {
      if (tryFocus()) return;
      setTimeout(function () {
        if (tryFocus()) return;
        setTimeout(tryFocus, 60);
      }, 0);
    });
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    state.offset = 0;
    loadIntercepts();
  });

  /* ── Shared landmark search (used by mainCard and mounted cards) ── */
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

  mainCard.addEventListener("click", async function (event) {
    const loadMoreHit = event.target.closest("#interceptsLoadMoreBtn");
    if (loadMoreHit) {
      event.preventDefault();
      loadMoreIntercepts();
      return;
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
      if (window.appToast) {
        window.appToast(ok ? "Скопійовано в буфер." : "Не вдалося скопіювати.", ok ? "success" : "error", 1600);
      } else {
        renderWarning(ok ? "Скопійовано в буфер." : "Не вдалося скопіювати.");
      }
      return;
    }

    const netLink = event.target.closest(".intercept-card__netlink");
    if (netLink && netLink.dataset.networkId) {
      event.preventDefault();
      openNetworkCardModal(netLink.dataset.networkId);
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
        const scope = input.closest("#itModalView, #itPaneMonitor, .modal-card") || document;
        await addCallsign(messageId, role, name);
        _refocusInputInScope(scope, messageId, role);
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
        // Захоплюємо логічний контейнер ДО addCallsign — після перерендеру
        // фокус треба повернути САМЕ в той інпут, де користувач набирав,
        // а не в його дубль у іншій панелі (Monitor mounted vs View modal).
        const scope = input.closest("#itModalView, #itPaneMonitor, .modal-card") || document;
        await addCallsign(messageId, role, name);
        _refocusInputInScope(scope, messageId, role);
      }
    }
  });

  /** Re-focus the callsign input inside a known scope, defending against
   *  re-render race conditions AND late asynchronous focus theft.
   *  - Up to 10 attempts spaced by 50ms (covers ~500ms of rebuild noise).
   *  - On successful focus, installs a focusout watchdog for ~600ms that
   *    immediately re-focuses if focus is removed (e.g., by a delayed
   *    `refreshCallsignsOnHover` re-render). */
  function _refocusInputInScope(scope, messageId, role) {
    const selector =
      '.callsign-input[data-message-id="' + String(messageId) +
      '"][data-role="' + String(role) + '"]';
    let attempts = 0;
    const maxAttempts = 10;

    function tryFocus() {
      attempts += 1;
      const target = (scope || document).querySelector(selector);
      if (!target) {
        if (attempts < maxAttempts) setTimeout(tryFocus, 50);
        return;
      }
      if (document.activeElement === target) {
        _installFocusWatchdog(target, 600);
        return;
      }
      try { target.focus({ preventScroll: false }); } catch (_) { target.focus(); }
      try {
        const v = String(target.value || "");
        target.setSelectionRange(v.length, v.length);
      } catch {}
      if (document.activeElement === target) {
        _installFocusWatchdog(target, 600);
      } else if (attempts < maxAttempts) {
        setTimeout(tryFocus, 50);
      }
    }

    requestAnimationFrame(tryFocus);
  }

  /** Захист від «віддачі фокусу» після rebuild: якщо протягом durationMs
   *  фокус залишає `input`, повертаємо його назад. Захищає від випадків,
   *  коли асинхронний re-render знімає фокус після того, як ми його встановили. */
  function _installFocusWatchdog(input, durationMs) {
    let alive = true;
    const startedAt = Date.now();
    function onFocusOut() {
      if (!alive) return;
      if (Date.now() - startedAt > durationMs) {
        alive = false;
        input.removeEventListener("focusout", onFocusOut);
        return;
      }
      // Невелика затримка, щоб rebuild завершився.
      requestAnimationFrame(function () {
        if (!alive) return;
        // Спочатку пробуємо той самий input; якщо він вже не в DOM —
        // шукаємо новий з тими ж data-атрибутами.
        let target = input;
        if (!document.body.contains(target)) {
          const mid = input.dataset && input.dataset.messageId;
          const role = input.dataset && input.dataset.role;
          if (mid && role) {
            target = document.querySelector(
              '.callsign-input[data-message-id="' + mid + '"][data-role="' + role + '"]'
            );
          }
        }
        if (target && document.body.contains(target)) {
          try { target.focus(); } catch (_) {}
        }
      });
    }
    input.addEventListener("focusout", onFocusOut);
    setTimeout(function () {
      alive = false;
      input.removeEventListener("focusout", onFocusOut);
    }, durationMs);
  }

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

  /* ─────────────────────────────────────────────────────────
     Registry of cards mounted outside mainCard (Monitoring/Висновок tabs).
     Key: messageId (Number), Value: container element.
     Used to re-render mounted cards after callsign changes.
  ───────────────────────────────────────────────────────── */
  const _mountedCards = new Map();

  function _refreshMountedCard(messageId) {
    const container = _mountedCards.get(Number(messageId));
    if (!container || !document.body.contains(container)) {
      _mountedCards.delete(Number(messageId));
      return;
    }
    const item = state.items.find((x) => Number(x.id) === Number(messageId));
    if (!item) return;
    container.innerHTML = renderInterceptCardHtml(item);
    _attachCardEvents(container);
    if (window.decorateCallsignConclusions) window.decorateCallsignConclusions(container);
    focusCallsignInput(messageId, state._lastRole || "");
  }

  /* ─────────────────────────────────────────────────────────
     Public API: mount a single intercept card into any container.
     Used by the Monitoring / Висновок tabs in monitor.js.
  ───────────────────────────────────────────────────────── */

  /**
   * Attach the same event delegation used by mainCard to any container.
   * Handlers work via event.target.closest() so they are container-agnostic.
   */
  /* Модалка «Картка р/м» (iframe → /networks?pick=ID&embed=1). Створюється
     ліниво і кладеться в <body>, тож працює всюди, де рендериться картка
     перехоплення (Перегляд, Пошук, Моніторинг, вбудовані модалки). */
  function closeNetworkCardModal() {
    const overlay = document.getElementById("itNetCardModal");
    if (!overlay) return;
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
    if (_netCardTimer) { clearTimeout(_netCardTimer); _netCardTimer = null; }
    const frame = document.getElementById("itNetCardFrame");
    if (frame) frame.src = "about:blank";
  }
  function openNetworkCardModal(networkId) {
    const nid = Number(networkId) || 0;
    if (!nid) return;
    let overlay = document.getElementById("itNetCardModal");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "itNetCardModal";
      overlay.className = "modal hidden it-netcard-modal";
      overlay.setAttribute("aria-hidden", "true");
      overlay.innerHTML =
        '<div class="modal-backdrop" data-netcard-close="1"></div>' +
        '<div class="modal-card it-netcard-card" role="dialog" aria-modal="true" style="max-width:1120px; width:96vw">' +
          '<div class="modal-head">' +
            '<div class="modal-title">Картка р/м</div>' +
            '<button type="button" class="secondary cs-icon-btn" data-netcard-close="1" title="Закрити" aria-label="Закрити">' +
              '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>' +
            '</button>' +
          '</div>' +
          '<div class="modal-body" style="padding:0; position:relative">' +
            '<div id="itNetCardLoader" class="it-netcard-loader">' +
              '<div class="it-netcard-spinner" aria-hidden="true"></div>' +
              '<div class="it-netcard-loader__text">Завантаження картки…</div>' +
              '<button type="button" id="itNetCardRetry" class="secondary it-netcard-retry" style="display:none">Повторити</button>' +
            '</div>' +
            '<iframe id="itNetCardFrame" src="about:blank" title="Картка р/м" style="width:100%; height:82vh; border:0; display:block; background:var(--bg)"></iframe>' +
          '</div>' +
        '</div>';
      document.body.appendChild(overlay);
      overlay.addEventListener("click", (e) => {
        if (e.target.closest && e.target.closest('[data-netcard-close="1"]')) closeNetworkCardModal();
        if (e.target.closest && e.target.closest("#itNetCardRetry")) {
          const nid = Number(overlay.dataset.networkId || 0);
          if (nid) _netCardLoad(nid);
        }
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !overlay.classList.contains("hidden")) closeNetworkCardModal();
      });
    }
    overlay.dataset.networkId = String(nid);
    _netCardLoad(nid);
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
    if (window.__modalToFront) window.__modalToFront(overlay);
  }

  /* Завантажити iframe картки: показати спінер, зняти його на onload,
     а якщо лінк «завис» (нестабільний Tailscale) — за 12 с показати «Повторити». */
  let _netCardTimer = null;
  function _netCardLoad(nid) {
    const frame = document.getElementById("itNetCardFrame");
    const loader = document.getElementById("itNetCardLoader");
    const retry = document.getElementById("itNetCardRetry");
    const txt = loader ? loader.querySelector(".it-netcard-loader__text") : null;
    const spin = loader ? loader.querySelector(".it-netcard-spinner") : null;
    if (!frame) return;

    if (loader) loader.style.display = "";
    if (retry) retry.style.display = "none";
    if (spin) spin.style.display = "";
    if (txt) txt.textContent = "Завантаження картки…";

    if (_netCardTimer) clearTimeout(_netCardTimer);
    _netCardTimer = setTimeout(() => {
      // Не завантажилось вчасно — ймовірно обрив/флап лінку.
      if (txt) txt.textContent = "Не вдалося завантажити (нестабільний зв'язок).";
      if (spin) spin.style.display = "none";
      if (retry) retry.style.display = "";
    }, 12000);

    frame.onload = () => {
      // about:blank теж дає onload — реагуємо лише на реальний src.
      if (frame.src.indexOf("about:blank") !== -1) return;
      if (_netCardTimer) { clearTimeout(_netCardTimer); _netCardTimer = null; }
      if (loader) loader.style.display = "none";
    };
    frame.src = "/networks?pick=" + encodeURIComponent(nid) + "&embed=1&_=" + Date.now();
  }
  window.openNetworkCardModal = openNetworkCardModal;

  function _attachCardEvents(container) {
    if (container.__cardEventsAttached) return;
    container.__cardEventsAttached = true;

    container.addEventListener("click", async function (event) {
      const copyBtn = event.target.closest(".intercepts-copy-btn");
      if (copyBtn) {
        const messageId = Number(copyBtn.dataset.messageId || 0);
        if (!messageId) return;
        const text = buildInterceptCopyText(messageId);
        if (!text) return;
        const ok = await copyTextToClipboard(text);
        if (window.appToast) window.appToast(ok ? "Скопійовано в буфер." : "Не вдалося скопіювати.", ok ? "success" : "error", 1600);
        return;
      }

      const netLink = event.target.closest(".intercept-card__netlink");
      if (netLink && netLink.dataset.networkId) {
        event.preventDefault();
        openNetworkCardModal(netLink.dataset.networkId);
        return;
      }

      const chipClick = event.target.closest(".callsign-chip--clickable");
      if (chipClick && !event.target.closest(".callsign-chip__remove")) {
        const editor = chipClick.closest(".intercepts-inline-editor");
        const messageId = editor ? Number(editor.dataset.messageId || 0) : 0;
        const callsignId = Number(chipClick.dataset.id || 0);
        if (callsignId && window.openCallsignEditModalById) window.openCallsignEditModalById(callsignId, { messageId });
        return;
      }

      const removeBtn = event.target.closest(".callsign-chip__remove");
      if (removeBtn) {
        const chip = removeBtn.closest(".callsign-chip");
        const editor = removeBtn.closest(".intercepts-inline-editor");
        if (!chip || !editor) return;
        const messageId = Number(editor.dataset.messageId || 0);
        const callsignId = Number(chip.dataset.id || 0);
        const role = String(chip.dataset.role || "");
        if (messageId && callsignId && role) await deleteCallsign(messageId, callsignId, role);
        return;
      }

      const autocompleteBtn = event.target.closest(".callsign-autocomplete__item");
      if (autocompleteBtn && state.autocompleteInput) {
        const name = String(autocompleteBtn.dataset.name || "").trim();
        const input = state.autocompleteInput;
        const messageId = Number(input.dataset.messageId || 0);
        const role = String(input.dataset.role || "").trim();
        if (name && messageId && role) {
          const scope = input.closest("#itModalView, #itPaneMonitor, .modal-card") || document;
          await addCallsign(messageId, role, name);
          _refocusInputInScope(scope, messageId, role);
        }
        return;
      }

      const lmSearchBtn = event.target.closest(".ie-lm-search-btn");
      if (lmSearchBtn) { await runLandmarkSearch(lmSearchBtn.closest(".intercepts-lm-panel")); return; }

      const lmCreateBtn = event.target.closest(".ie-lm-create-btn");
      if (lmCreateBtn) { if (typeof window.openLandmarkCreateModal === "function") window.openLandmarkCreateModal(); return; }

      const lmChip = event.target.closest(".intercepts-lm-chip");
      if (lmChip) {
        const landmarkId = Number(lmChip.dataset.lmId || 0);
        if (landmarkId && typeof window.openLandmarkEditModalById === "function") {
          try { await window.openLandmarkEditModalById(landmarkId); } catch (e) { console.error(e); }
        }
        return;
      }
    });

    container.addEventListener("input", function (event) {
      const input = event.target.closest(".callsign-input");
      if (input) showAutocomplete(input);
    });

    container.addEventListener("keydown", async function (event) {
      const lmInput = event.target.closest(".ie-lm-name-input");
      if (lmInput && event.key === "Enter") {
        event.preventDefault();
        const panel = lmInput.closest(".intercepts-lm-panel");
        const btn = panel ? panel.querySelector(".ie-lm-search-btn") : null;
        if (btn) btn.click();
        return;
      }

      const input = event.target.closest(".callsign-input");
      if (!input) return;

      if (event.key === "ArrowDown" && state.autocompleteItems.length) {
        event.preventDefault();
        state.autocompleteIndex = (state.autocompleteIndex + 1) % state.autocompleteItems.length;
        highlightAutocomplete(); return;
      }
      if (event.key === "ArrowUp" && state.autocompleteItems.length) {
        event.preventDefault();
        state.autocompleteIndex = (state.autocompleteIndex - 1 + state.autocompleteItems.length) % state.autocompleteItems.length;
        highlightAutocomplete(); return;
      }
      if (event.key === "Escape") { closeAutocomplete(); return; }

      if (event.key === "Enter") {
        event.preventDefault();
        const messageId = Number(input.dataset.messageId || 0);
        const role = String(input.dataset.role || "").trim();
        let name = input.value.trim();
        if (state.autocompleteIndex >= 0 && state.autocompleteItems[state.autocompleteIndex]) {
          name = String(state.autocompleteItems[state.autocompleteIndex].name || "").trim();
        }
        if (messageId && role && name) {
          const scope = input.closest("#itModalView, #itPaneMonitor, .modal-card") || document;
          await addCallsign(messageId, role, name);
          _refocusInputInScope(scope, messageId, role);
        }
      }
    });

    container.addEventListener("submit", async function (event) {
      const formEl = event.target.closest(".intercepts-comment-form");
      if (!formEl) return;
      event.preventDefault();
      const messageId = Number(formEl.dataset.messageId || 0);
      const textarea = formEl.querySelector('textarea[name="comment"]');
      const comment = textarea ? textarea.value : "";
      if (messageId) await saveComment(messageId, comment);
    });
  }

  /**
   * Fetch and render a single intercept card into `container`.
   * Attaches all event handlers (callsigns, landmarks, comment, copy).
   * Called by monitor.js when displaying an intercept in Monitoring / Висновок.
   */
  /* Завантаження картки з повторами: короткі розриви зв'язку (нестабільний
     Tailscale на сервері) спричиняли «Помилка: Failed to fetch» при кліку.
     Повторюємо мережеві збої та 5xx, але НЕ 4xx (реальна відповідь сервера). */
  async function _fetchItemWithRetry(messageId, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      let res;
      try {
        res = await _fetchWithTimeout(`/api/intercepts-explorer/${messageId}`, {}, 8000);
      } catch (e) {
        lastErr = e;  // мережевий збій (розрив зв'язку) → повтор
        if (i < tries - 1) { await new Promise(r => setTimeout(r, 500 * (i + 1))); continue; }
        throw lastErr;
      }
      if (res.ok) return await res.json();
      if (res.status < 500) {  // 4xx — не повторюємо
        const d = await res.json().catch(() => ({}));
        throw new Error(d.detail || "HTTP " + res.status);
      }
      lastErr = new Error("HTTP " + res.status);  // 5xx → повтор
      if (i < tries - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
    throw lastErr;
  }

  window.interceptsExplorerMountCard = async function (messageId, container) {
    if (!container) return;
    _mountedCards.set(Number(messageId), container);
    container.innerHTML = '<div class="intercepts-main-card__empty">Завантаження…</div>';

    try {
      const data = await _fetchItemWithRetry(messageId);

      const apiItem = data.item;

      /* Ensure item is in state.items (needed by renderInterceptCardHtml) */
      if (!state.items.find((x) => Number(x.id) === Number(apiItem.id))) {
        state.items.push({
          id:              apiItem.id,
          network_id:      apiItem.network_id,
          created_at:      apiItem.created_at  || "",
          received_at:     apiItem.received_at  || "",
          text:            apiItem.text         || "",
          comment:         apiItem.comment      || "",
          net_description: apiItem.net_description || "",
          network:         apiItem.network      || {},
        });
      }

      /* Store full detail (callsigns + network, з тегами для іконок). */
      state.detailById[apiItem.id] = {
        id:         apiItem.id,
        network_id: apiItem.network_id,
        text:       apiItem.text    || "",
        comment:    apiItem.comment || "",
        callsigns:  apiItem.callsigns || [],
        network:    apiItem.network  || {},
      };
      state.landmarkMatchesByMessageId[apiItem.id] =
        state.landmarkMatchesByMessageId[apiItem.id] || [];

      /* Render */
      const item = state.items.find((x) => Number(x.id) === Number(apiItem.id));
      container.innerHTML = renderInterceptCardHtml(item);

      /* Wire up all events */
      _attachCardEvents(container);

      /* Оверлей-крапка на іконках позивних, по яких є аналітичні висновки. */
      if (window.decorateCallsignConclusions) window.decorateCallsignConclusions(container);

    } catch (e) {
      // «Failed to fetch» = розрив зв'язку, abort/timeout = запит «підвис» і був
      // перерваний за тайм-аутом — усе це нестабільний Tailscale, а не помилка
      // даних. Показуємо зрозуміле повідомлення + кнопку повтору.
      const em = String(e && (e.name + " " + e.message) || "").toLowerCase();
      const isNet = /fetch|abort|timeout|network|signal/.test(em);
      const msg = isNet
        ? "Втрачено зв'язок із сервером (нестабільний Tailscale). Повторіть."
        : "Помилка: " + escapeHtml(String(e.message || e));
      container.innerHTML =
        `<div class="intercepts-main-card__empty">${msg}` +
        `<div style="margin-top:10px"><button type="button" class="secondary" data-mount-retry="${escapeHtml(String(messageId))}">Повторити</button></div></div>`;
      const btn = container.querySelector("[data-mount-retry]");
      if (btn) btn.addEventListener("click", () => window.interceptsExplorerMountCard(messageId, container));
    }
  };

  loadIntercepts();
})();