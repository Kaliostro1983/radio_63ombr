(function () {
  function $(id) { return document.getElementById(id); }

  const tabOverview = $("homeTabOverview");
  const tabActivity = $("homeTabActivity");
  const tabReports = $("homeTabReports");
  const paneOverview = $("homePaneOverview");
  const paneActivity = $("homePaneActivity");
  const paneReports = $("homePaneReports");

  const freqInput = $("homeFreqInput");
  const chipsWrap = $("homeFreqChips");
  const daysInput = $("homeDays");
  const cbAdvanced = $("homeAdvanced");
  const cbIncludeToday = $("homeIncludeToday");
  const btnShow = $("homeShowActivity");
  const info = $("homeActivityInfo");
  const tables = $("homeActivityTables");

  if (!tabOverview || !tabActivity || !tabReports || !paneReports) return;

  const state = {
    freqs: [], // list of frequency strings
    acBox: null,
    acItems: [],
    acIndex: -1,
  };

  const tabCasualties  = $("homeTabCasualties");
  const paneCasualties = $("homePaneCasualties");

  /* ── Modal-based navigation ───────────────────────────────────
   *  Огляд / Звіти / Втрати тепер відкриваються як модальні вікна
   *  через кнопки у шапці. Activity-вкладка лишається завжди видимою
   *  як основний контент. Tab-кнопки (homeTabOverview тощо) — скриті,
   *  але живі: модалка-opener тригерить їхній click(), щоб ініціювати
   *  overview.js / casualties.js за існуючими bindings. */
  const modalMap = {
    overview:   { modal: document.getElementById("homeModalOverview"),   tabBtn: tabOverview },
    reports:    { modal: document.getElementById("homeModalReports"),    tabBtn: tabReports },
    casualties: { modal: document.getElementById("homeModalCasualties"), tabBtn: tabCasualties },
    network:    { modal: document.getElementById("homeModalNetwork"),    tabBtn: null, iframeId: "homeModalNetworkFrame" },
    intercepts: { modal: document.getElementById("homeModalIntercepts"), tabBtn: null, iframeId: "homeModalInterceptsFrame" },
  };

  function openHomeModal(which, opts) {
    const skipHistory = opts && opts.skipHistory;
    const m = modalMap[which];
    if (!m || !m.modal) return;
    m.modal.classList.remove("hidden");
    m.modal.removeAttribute("aria-hidden");
    // Триггеримо click на прихованій tab-кнопці — це активує ліниву
    // ініціалізацію в overview.js / casualties.js (вони слухають саме її).
    try { m.tabBtn?.click(); } catch (_) {}
    if (!skipHistory) {
      const u = new URL(location.href);
      u.searchParams.set("tab", which);
      history.replaceState(null, "", u.pathname + "?" + u.searchParams.toString() + u.hash);
    }
  }

  function closeHomeModal(which, opts) {
    const skipHistory = opts && opts.skipHistory;
    const m = modalMap[which];
    if (!m || !m.modal) return;
    m.modal.classList.add("hidden");
    m.modal.setAttribute("aria-hidden", "true");
    // iframe-модалки — щоб не тримати ресурси (live-pings, мапи) у фоні,
    // скидаємо src на закритті. Наступне відкриття перевиставить його.
    if (m.iframeId) {
      const ifr = document.getElementById(m.iframeId);
      if (ifr) ifr.src = "about:blank";
    }
    if (!skipHistory && !m.iframeId) {
      // Для табів (overview/reports/casualties) — синхронізуємо ?tab у URL.
      // Iframe-модалки в URL не пишемо: вони не є «вкладкою» сторінки.
      const u = new URL(location.href);
      u.searchParams.delete("tab");
      const qs = u.searchParams.toString();
      history.replaceState(null, "", u.pathname + (qs ? `?${qs}` : "") + u.hash);
    }
  }

  function openHomeNetworkModal(netId) {
    const m = modalMap.network;
    if (!m || !m.modal) return;
    const id = String(netId || "").trim();
    if (!id) return;
    const ifr = document.getElementById(m.iframeId);
    if (ifr) ifr.src = `/networks?pick=${encodeURIComponent(id)}&embed=1&_=${Date.now()}`;
    m.modal.classList.remove("hidden");
    m.modal.removeAttribute("aria-hidden");
  }

  function openHomeInterceptsModal(dayIso, networkToken) {
    const m = modalMap.intercepts;
    if (!m || !m.modal) return;
    const day = String(dayIso || "").trim();
    if (!day) return;
    const periodStart = `${day}T00:00`;
    const periodEnd   = `${day}T23:59`;
    const qs = new URLSearchParams();
    qs.set("period_start", periodStart);
    qs.set("period_end",   periodEnd);
    if (networkToken) qs.set("network", String(networkToken));
    qs.set("tab",   "view");
    qs.set("embed", "1");
    qs.set("_", String(Date.now()));   // cache-bust — щоб після оновлень CSS не лишався застарілий HTML iframe
    const ifr = document.getElementById(m.iframeId);
    if (ifr) ifr.src = `/intercepts-explorer?${qs.toString()}`;
    m.modal.classList.remove("hidden");
    m.modal.removeAttribute("aria-hidden");
  }

  // Відкрити модалку перехоплень із готовим embed-URL (виклик із картки позивного).
  window.homeOpenInterceptsUrl = function (embedUrl) {
    const m = modalMap.intercepts;
    if (!m || !m.modal) return false;
    const ifr = document.getElementById(m.iframeId);
    if (ifr) ifr.src = embedUrl;
    m.modal.classList.remove("hidden");
    m.modal.removeAttribute("aria-hidden");
    return true;
  };

  function closeAllHomeModals() {
    Object.keys(modalMap).forEach((k) => closeHomeModal(k, { skipHistory: true }));
  }

  // Header buttons → open respective modal
  document.getElementById("homeOpenOverview")?.addEventListener("click", () => openHomeModal("overview"));
  document.getElementById("homeOpenReports")?.addEventListener("click", () => openHomeModal("reports"));
  document.getElementById("homeOpenCasualties")?.addEventListener("click", () => openHomeModal("casualties"));

  // Close handlers: X / backdrop / Esc
  document.querySelectorAll("[data-home-modal-close]").forEach((el) => {
    el.addEventListener("click", (e) => {
      const which = el.getAttribute("data-home-modal-close");
      if (which) { e.stopPropagation(); closeHomeModal(which); }
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    Object.keys(modalMap).forEach((k) => {
      const m = modalMap[k].modal;
      if (m && !m.classList.contains("hidden")) closeHomeModal(k);
    });
  });

  // Initial URL state — ?tab=X відкриває відповідну модалку.
  const _initialTab = (window.__homeInitialTab || "").toLowerCase();
  if (_initialTab && _initialTab in modalMap) {
    openHomeModal(_initialTab, { skipHistory: true });
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderChips() {
    chipsWrap.innerHTML = "";
    state.freqs.forEach((f) => {
      const el = document.createElement("span");
      el.className = "chip";
      el.innerHTML = `<span>${escapeHtml(f)}</span><button type="button" class="chip-x" data-f="${escapeHtml(f)}">×</button>`;
      chipsWrap.appendChild(el);
    });
  }

  chipsWrap.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip-x");
    if (!btn) return;
    const f = btn.getAttribute("data-f") || "";
    state.freqs = state.freqs.filter((x) => x !== f);
    renderChips();
  });

  function closeAutocomplete() {
    if (state.acBox) state.acBox.remove();
    state.acBox = null;
    state.acItems = [];
    state.acIndex = -1;
  }

  function highlightAutocomplete() {
    if (!state.acBox) return;
    const items = state.acBox.querySelectorAll(".callsign-autocomplete__item");
    items.forEach((el, idx) => el.classList.toggle("is-selected", idx === state.acIndex));
  }

  let timer = null;
  async function lookupNetworks(q) {
    const qs = (q || "").trim();
    closeAutocomplete();
    if (!qs || qs.length < 2) return;

    try {
      const resp = await fetch(`/api/networks/lookup?q=${encodeURIComponent(qs)}`, { headers: { Accept: "application/json" } });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.ok) return;
      const rows = Array.isArray(data.rows) ? data.rows : [];
      if (!rows.length) return;

      state.acItems = rows;
      const box = document.createElement("div");
      box.className = "callsign-autocomplete";
      box.innerHTML = rows.map((r, idx) => {
        const label = `${r.frequency || ""}${r.mask ? " / " + r.mask : ""} — ${r.unit || ""}`.trim();
        const value = r.mask || r.frequency || "";
        return `<button type="button" class="callsign-autocomplete__item" data-index="${idx}" data-f="${escapeHtml(value)}">${escapeHtml(label)}</button>`;
      }).join("");

      const wrap = freqInput.closest(".home-freq-input-wrap");
      if (!wrap) return;
      wrap.appendChild(box);
      state.acBox = box;
      state.acIndex = -1;
    } catch (e) {
      closeAutocomplete();
    }
  }

  function addFreq(value) {
    const f = String(value || "").trim();
    if (!f) return;
    if (state.freqs.includes(f)) return;
    state.freqs.push(f);
    renderChips();
  }

  freqInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => lookupNetworks(freqInput.value), 200);
  });

  freqInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && state.acItems.length) {
      e.preventDefault();
      state.acIndex = (state.acIndex + 1) % state.acItems.length;
      highlightAutocomplete();
      return;
    }
    if (e.key === "ArrowUp" && state.acItems.length) {
      e.preventDefault();
      state.acIndex = (state.acIndex - 1 + state.acItems.length) % state.acItems.length;
      highlightAutocomplete();
      return;
    }
    if (e.key === "Escape") {
      closeAutocomplete();
      return;
    }
    if (e.key === "Enter") {
      if (state.acItems.length && state.acIndex >= 0 && state.acItems[state.acIndex]) {
        e.preventDefault();
        addFreq(state.acItems[state.acIndex].mask || state.acItems[state.acIndex].frequency);
        freqInput.value = "";
        closeAutocomplete();
        return;
      }
      // Manual entry: allow masks or exact frequencies
      const raw = (freqInput.value || "").trim();
      if (raw) {
        e.preventDefault();
        addFreq(raw);
        freqInput.value = "";
        closeAutocomplete();
        return;
      }
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".home-freq-input-wrap")) closeAutocomplete();
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".callsign-autocomplete__item");
    if (!btn || !state.acBox) return;
    const f = btn.getAttribute("data-f") || "";
    addFreq(f);
    freqInput.value = "";
    closeAutocomplete();
  });

  function heatClass(cnt) {
    const n = Number(cnt || 0);
    if (n <= 0) return "heat-0";
    if (n <= 10) return "heat-1";
    return "heat-2";
  }

  function renderTables(data) {
    tables.innerHTML = "";
    if (!data || !data.ok) {
      tables.innerHTML = `<div class="small" style="color:var(--danger)">Помилка даних</div>`;
      return;
    }

    const dayKeys = Array.isArray(data.days) ? data.days : []; // YYYY-MM-DD
    const dayLabels = data.day_labels || [];
    const summary = data.summary || [];
    const meta = (data.meta || {});

    // Summary table
    let html = `
      <div class="card">
        <div style="font-weight:800; margin-bottom:4px">Підсумок</div>
        <div class="small home-activity-meta">
          Період: ${escapeHtml(meta.start_human || "")} – ${escapeHtml(meta.end_human || "")}.
          Мереж: ${escapeHtml(meta.networks || 0)}
        </div>
        <div class="table-wrap">
          <table class="table home-activity-table home-activity-summary">
            <thead>
              <tr>
                <th>День</th>
                ${dayLabels.map((d) => `<th>${escapeHtml(d)}</th>`).join("")}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="text-align:center; font-size:1.2em"><b>Σ</b></td>
                ${summary.map((c, idx) => {
                  const n = Number(c || 0);
                  const cls = heatClass(n);
                  const label = Number.isFinite(n) ? String(n) : "0";
                  const day = dayKeys[idx] || "";
                  const attrs = day ? ` data-day="${escapeHtml(day)}"` : "";
                  return `<td><span class="heat-pill is-link ${cls}"${attrs} data-kind="summary" title="Відкрити перехоплення за день">${escapeHtml(label)}</span></td>`;
                }).join("")}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `;

    (data.groups || []).forEach((g) => {
      const rows = g.rows || [];
      html += `
        <div class="card" style="margin-top:12px">
          <div style="font-weight:800; margin-bottom:10px">${escapeHtml(g.group_name || "—")}</div>
          <div class="table-wrap">
            <table class="table home-activity-table">
              <thead>
                <tr>
                  <th style="min-width:120px">Частота</th>
                  <th style="min-width:120px">Маска</th>
                  <th style="min-width:260px">Підрозділ</th>
                  <th style="min-width:120px">Теги</th>
                  ${dayLabels.map((d) => `<th style="width:70px">${escapeHtml(d)}</th>`).join("")}
                </tr>
              </thead>
              <tbody>
                ${rows.map((r) => {
                  const baseStyle = `display:block; text-align:center; border-radius:8px; padding:4px 8px; margin:2px 0; background:${r.status_bg || "transparent"}; border:1px solid ${r.status_border || "transparent"}`;
                  // Clicking frequency/mask/subdivision should open the network card.
                  const netId = String(r.id || "");
                  const c0 = `<span class="home-net-card-link" data-net-id="${escapeHtml(
                    netId
                  )}" style="${baseStyle}" title="Відкрити картку р/м">${escapeHtml(
                    r.frequency
                  )}</span>`;
                  const c1 = `<span class="home-net-card-link" data-net-id="${escapeHtml(
                    netId
                  )}" style="${baseStyle}" title="Відкрити картку р/м">${escapeHtml(
                    r.mask || "—"
                  )}</span>`;
                  const c2 = `<span class="home-net-card-link" data-net-id="${escapeHtml(
                    netId
                  )}" style="${baseStyle}" title="Відкрити картку р/м">${escapeHtml(
                    r.unit || ""
                  )}</span>`;
                  const token = (r.mask || r.frequency || "").trim();
                  const tagIds = Array.isArray(r.tag_ids) ? r.tag_ids : [];
                  const tagsCell = tagIds.length
                    ? tagIds
                        .map((tid) => {
                          const t = String(tid);
                          return `<img
                            class="net-tag-icon"
                            src="/static/icons/network_tags/${escapeHtml(t)}.svg"
                            alt="Тег ${escapeHtml(t)}"
                            onerror="this.onerror=null; this.src='/static/icons/network_tags/_default.svg';"
                          />`;
                        })
                        .join("")
                    : "—";
                  return `
                    <tr>
                      <td>${c0}</td>
                      <td>${c1}</td>
                      <td>${c2}</td>
                      <td>${tagsCell}</td>
                      ${(r.counts || []).map((c, idx) => {
                        const n = Number(c || 0);
                        const cls = heatClass(n);
                        const label = Number.isFinite(n) ? String(n) : "0";
                        const day = dayKeys[idx] || "";
                        const attrs = ` data-day="${escapeHtml(day)}" data-net="${escapeHtml(token)}"`;
                        return `<td><span class="heat-pill is-link ${cls}"${attrs} data-kind="network" title="Відкрити перехоплення за день">${escapeHtml(label)}</span></td>`;
                      }).join("")}
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
    });

    tables.innerHTML = html;
  }

  tables.addEventListener("click", (e) => {
    const cardLink = e.target.closest(".home-net-card-link");
    if (cardLink) {
      const netId = cardLink.getAttribute("data-net-id") || "";
      if (netId) openHomeNetworkModal(netId);
      return;
    }

    const pill = e.target.closest(".heat-pill.is-link");
    if (!pill) return;
    const day  = pill.getAttribute("data-day") || "";
    const kind = pill.getAttribute("data-kind") || "";
    const net  = pill.getAttribute("data-net") || "";
    openHomeInterceptsModal(day, kind === "summary" ? "" : net);
  });

  async function loadActivity() {
    tables.innerHTML = `<div class="small" style="opacity:.8">Завантаження…</div>`;
    info.textContent = "";

    const days = (daysInput.value || "5").trim();
    const advanced = cbAdvanced.checked ? "1" : "0";
    const includeToday = cbIncludeToday.checked ? "1" : "0";
    const freqs = state.freqs.join(",");

    try {
      const url = `/api/home/activity?days=${encodeURIComponent(days)}&advanced=${encodeURIComponent(advanced)}&include_today=${encodeURIComponent(includeToday)}&freqs=${encodeURIComponent(freqs)}`;
      const resp = await fetch(url, { headers: { Accept: "application/json" } });
      const data = await resp.json();
      // Верхній info-блок зараз не дублює період/кількість мереж –
      // вся інформація показується у картці "Підсумок".
      info.textContent = "";
      renderTables(data);
    } catch (e) {
      tables.innerHTML = `<div class="small" style="color:var(--danger)">Помилка завантаження</div>`;
    }
  }

  btnShow.addEventListener("click", () => {
    // Activity тепер постійно видима як основний контент — просто
    // підвантажуємо таблицю.
    loadActivity();
  });

  // Автозавантаження при відкритті сторінки — щоб не виглядало порожньо.
  // Викликаємо одразу після того, як DOM прив'язаний, з дефолтами
  // (Розширений = on, Враховувати сьогодні = off, Днів = 5).
  loadActivity();

  // --- Переміщення 36 мсп ---
  (function () {
    const btnDay      = $("movBtnDay");
    const btnNight    = $("movBtnNight");
    const loader      = $("movLoader");
    const wordsEl     = $("movWords");
    const modal       = $("movModal");
    const modalText   = $("movModalText");
    const modalCopy   = $("movModalCopy");
    const modalClose  = $("movModalClose");
    const modalClose2 = $("movModalClose2");
    const backdrop    = $("movModalBackdrop");
    if (!btnDay || !btnNight || !modal) return;

    function openModal(text) {
      modalText.textContent = text;
      modal.classList.remove("hidden");
      modal.removeAttribute("aria-hidden");
    }

    function closeModal() {
      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");
    }

    [modalClose, modalClose2, backdrop].forEach(el => {
      if (el) el.addEventListener("click", closeModal);
    });

    if (modalCopy) {
      modalCopy.addEventListener("click", async () => {
        const text = modalText.textContent || "";
        const ok = await window.clipboardWrite(text);
        if (ok) {
          if (window.appToast) window.appToast("Скопійовано в буфер.", "success", 1600);
        } else {
          if (window.appToast) window.appToast("Не вдалося скопіювати.", "error", 1600);
        }
      });
    }

    async function fetchCount(p) {
      const words = (wordsEl ? wordsEl.value : "мот,квадр,короб,вел").trim();
      if (loader) loader.style.display = "";
      try {
        const res  = await fetch(`/api/home/movement-count?period=${p}&words=${encodeURIComponent(words)}`);
        const data = await res.json();
        if (loader) loader.style.display = "none";
        if (!data.ok) {
          openModal(data.error || "Помилка запиту");
        } else {
          const text = `З ${data.period_start} по ${data.period_end} виявлено перехоплень щодо:\nпереміщення т/з - ${data.count}`;
          openModal(text);
        }
      } catch (e) {
        if (loader) loader.style.display = "none";
        openModal("Помилка запиту до сервера.");
      }
    }

    btnDay.addEventListener("click",   () => fetchCount("day"));
    btnNight.addEventListener("click", () => fetchCount("night"));
  })();
})();

