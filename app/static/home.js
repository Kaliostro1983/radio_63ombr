(function () {
  function $(id) { return document.getElementById(id); }

  const tabOverview = $("homeTabOverview");
  const tabActivity = $("homeTabActivity");
  const paneOverview = $("homePaneOverview");
  const paneActivity = $("homePaneActivity");

  const freqInput = $("homeFreqInput");
  const chipsWrap = $("homeFreqChips");
  const daysInput = $("homeDays");
  const cbAdvanced = $("homeAdvanced");
  const cbIncludeToday = $("homeIncludeToday");
  const btnShow = $("homeShowActivity");
  const info = $("homeActivityInfo");
  const tables = $("homeActivityTables");

  if (!tabOverview || !tabActivity) return;

  const state = {
    freqs: [], // list of frequency strings
    acBox: null,
    acItems: [],
    acIndex: -1,
  };

  function setTab(which) {
    const isOverview = which === "overview";
    tabOverview.classList.toggle("active", isOverview);
    tabOverview.setAttribute("aria-selected", isOverview ? "true" : "false");
    tabActivity.classList.toggle("active", !isOverview);
    tabActivity.setAttribute("aria-selected", isOverview ? "false" : "true");
    paneOverview.classList.toggle("hidden", !isOverview);
    paneActivity.classList.toggle("hidden", isOverview);
  }

  tabOverview.addEventListener("click", () => setTab("overview"));
  tabActivity.addEventListener("click", () => setTab("activity"));

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
                  ${dayLabels.map((d) => `<th style="width:70px">${escapeHtml(d)}</th>`).join("")}
                </tr>
              </thead>
              <tbody>
                ${rows.map((r) => {
                  const baseStyle = `display:block; text-align:center; border-radius:8px; padding:4px 8px; margin:2px 0; background:${r.status_bg || "transparent"}; border:1px solid ${r.status_border || "transparent"}`;
                  const c0 = `<span style="${baseStyle}">${escapeHtml(r.frequency)}</span>`;
                  const c1 = `<span style="${baseStyle}">${escapeHtml(r.mask || "—")}</span>`;
                  const c2 = `<span style="${baseStyle}">${escapeHtml(r.unit || "")}</span>`;
                  const token = (r.mask || r.frequency || "").trim();
                  return `
                    <tr>
                      <td>${c0}</td>
                      <td>${c1}</td>
                      <td>${c2}</td>
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

  function openInterceptsForDay(dayIso, networkToken) {
    const day = String(dayIso || "").trim(); // YYYY-MM-DD
    if (!day) return;
    const periodStart = `${day}T00:00`;
    const periodEnd = `${day}T23:59`;
    const qs = new URLSearchParams();
    qs.set("period_start", periodStart);
    qs.set("period_end", periodEnd);
    if (networkToken) qs.set("network", String(networkToken));
    const url = `/intercepts-explorer?${qs.toString()}`;
    window.open(url, "_blank", "noopener");
  }

  tables.addEventListener("click", (e) => {
    const pill = e.target.closest(".heat-pill.is-link");
    if (!pill) return;
    const day = pill.getAttribute("data-day") || "";
    const kind = pill.getAttribute("data-kind") || "";
    const net = pill.getAttribute("data-net") || "";
    if (kind === "summary") {
      openInterceptsForDay(day, "");
      return;
    }
    openInterceptsForDay(day, net);
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
    setTab("activity");
    loadActivity();
  });

  // default load when opening Activity tab
  tabActivity.addEventListener("click", () => {
    setTimeout(loadActivity, 0);
  });
})();

