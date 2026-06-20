/* Крос-аналіз спільних позивних р/м у межах бригадно-полкової групи.
 * Кнопка на картці р/м (#netCrossBtn) відкриває модалку #netCrossModal:
 *   - частота з автокомплітом (за замовч. — р/м із картки);
 *   - чекбокс «Активні р/м» (лише статус «Спостерігається»);
 *   - мінімальна к-сть співпадінь;
 *   - зведення + таблиця з іконками статусів позивних (клік → картка позивного).
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const modal    = $("netCrossModal");
  const btn      = $("netCrossBtn");
  if (!modal) return;

  const freqInp   = $("xaFreq");
  const netIdInp  = $("xaNetId");
  const acList    = $("xaAcList");
  const activeChk = $("xaActiveOnly");
  const minInp    = $("xaMinMatches");
  const showBtn   = $("xaShowBtn");
  const summary   = $("xaSummary");
  const msg       = $("xaMsg");
  const tableWrap = $("xaTableWrap");

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function statusIcon(statusId) {
    return statusId
      ? `/static/icons/callsign_statuses/${statusId}.svg`
      : "/static/icons/callsign_statuses/_default.svg";
  }

  /* Іконка-мініатюра статусу позивного. Клік → картка позивного. */
  function csIcon(cell, name) {
    const title = `${esc(name)}${cell.status_label ? " · " + esc(cell.status_label) : " · без статусу"}`;
    return (
      `<img class="xa-cs-icon" src="${statusIcon(cell.status_id)}" alt="" ` +
      `title="${title}" data-cs-id="${cell.callsign_id}" ` +
      `onerror="this.onerror=null;this.src='/static/icons/callsign_statuses/_default.svg';">`
    );
  }

  function openModal() {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    if (window.__modalToFront) window.__modalToFront(modal);
  }
  function closeModal() {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    hideAc();
  }

  /* ── Автокомпліт частоти (через /api/networks/lookup) ── */
  let acTimer = null;
  function hideAc() { if (acList) { acList.classList.add("hidden"); acList.innerHTML = ""; } }

  async function runAc(q) {
    if (!q.trim()) { hideAc(); return; }
    try {
      const r = await fetch("/api/networks/lookup?q=" + encodeURIComponent(q.trim()));
      const d = await r.json();
      const rows = (d && d.ok ? d.rows : []) || [];
      if (!rows.length) { hideAc(); return; }
      acList.innerHTML = rows.slice(0, 40).map((row) =>
        `<div class="xa-ac-item" data-id="${row.id}" data-freq="${esc(row.frequency)}">` +
        `<b>${esc(row.frequency)}</b>` +
        (row.mask ? ` <span class="xa-ac-mask">${esc(row.mask)}</span>` : "") +
        (row.unit ? ` <span class="xa-ac-unit">${esc(row.unit)}</span>` : "") +
        `</div>`,
      ).join("");
      acList.classList.remove("hidden");
    } catch (_) { hideAc(); }
  }

  if (freqInp) {
    freqInp.addEventListener("input", () => {
      if (netIdInp) netIdInp.value = "";   // частота змінилась — id більше не дійсний
      clearTimeout(acTimer);
      acTimer = setTimeout(() => runAc(freqInp.value), 200);
    });
    freqInp.addEventListener("focus", () => { if (freqInp.value.trim()) runAc(freqInp.value); });
  }
  if (acList) {
    acList.addEventListener("click", (e) => {
      const it = e.target.closest(".xa-ac-item");
      if (!it) return;
      freqInp.value = it.dataset.freq || "";
      netIdInp.value = it.dataset.id || "";
      hideAc();
      load();
    });
  }
  document.addEventListener("click", (e) => {
    if (acList && !acList.contains(e.target) && e.target !== freqInp) hideAc();
  });

  /* Визначити network_id: з hidden, або з точного збігу частоти через lookup. */
  async function resolveNetId() {
    const id = parseInt(netIdInp.value, 10);
    if (Number.isFinite(id) && id > 0) return id;
    const freq = (freqInp.value || "").trim();
    if (!freq) return null;
    try {
      const r = await fetch("/api/networks/lookup?q=" + encodeURIComponent(freq));
      const d = await r.json();
      const rows = (d && d.ok ? d.rows : []) || [];
      const exact = rows.find((x) => (x.frequency || "").trim() === freq) || rows[0];
      if (exact) { netIdInp.value = String(exact.id); return exact.id; }
    } catch (_) {}
    return null;
  }

  /* ── Завантаження + рендер ── */
  async function load() {
    hideAc();
    const netId = await resolveNetId();
    if (!netId) {
      msg.textContent = "Оберіть радіомережу зі списку.";
      summary.classList.add("hidden");
      tableWrap.innerHTML = "";
      return;
    }
    const activeOnly = activeChk && activeChk.checked ? 1 : 0;
    const minMatches = Math.max(1, parseInt(minInp.value, 10) || 1);
    msg.textContent = "Завантаження…";
    summary.classList.add("hidden");
    tableWrap.innerHTML = "";

    let d;
    try {
      const r = await fetch(
        `/api/networks/${netId}/cross-analysis?active_only=${activeOnly}&min_matches=${minMatches}`,
      );
      d = await r.json();
    } catch (_) { d = null; }
    if (!d || !d.ok) {
      msg.textContent = (d && d.error) || "Помилка завантаження.";
      return;
    }
    render(d);
  }

  function render(d) {
    const t = d.target || {};
    // ── Зведення ──
    const peerLines = (d.peers || []).map((p) => {
      const pass = p.common >= d.min_matches;
      return (
        `<span class="xa-peer ${pass ? "xa-peer--pass" : ""}" ` +
        `title="${esc(p.unit)}">${esc(p.frequency)} ` +
        `<b>${p.common}</b></span>`
      );
    }).join("");
    summary.innerHTML =
      `<div class="xa-sum-head">Ціль: <b>${esc(t.frequency)}</b> ` +
      `<span class="small" style="opacity:.7">${esc(t.unit)}</span> · ` +
      `група «${esc(t.group_name) || "—"}» · позивних: ${t.total_callsigns}</div>` +
      `<div class="xa-sum-sub small">Спільні позивні з р/м групи` +
      ` (зелені — пройшли поріг ≥ ${d.min_matches}):</div>` +
      `<div class="xa-peer-list">${peerLines || "<span class='small' style='opacity:.6'>немає р/м у групі</span>"}</div>`;
    summary.classList.remove("hidden");

    const cols = d.columns || [];
    const rows = d.rows || [];
    if (!cols.length || !rows.length) {
      msg.textContent = "Немає р/м, що проходять поріг співпадінь (або спільних позивних).";
      tableWrap.innerHTML = "";
      return;
    }
    msg.textContent = "";

    const head =
      `<tr><th class="xa-th-name">Позивний</th>` +
      cols.map((c) =>
        `<th class="xa-th-col" title="${esc(c.unit)}">` +
        `<div>${esc(c.frequency)}</div>` +
        `<div class="xa-th-cnt">${c.common}</div></th>`,
      ).join("") +
      `</tr>`;

    const body = rows.map((row) => {
      const first =
        `<td class="xa-td-name">` +
        csIcon(row.target, row.name) +
        `<span class="xa-name-txt">${esc(row.name)}</span></td>`;
      const cells = cols.map((c) => {
        const cell = row.cells ? row.cells[c.network_id] : null;
        return `<td class="xa-td-cell">${cell ? csIcon(cell, row.name) : ""}</td>`;
      }).join("");
      return `<tr>${first}${cells}</tr>`;
    }).join("");

    tableWrap.innerHTML =
      `<table class="xa-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
  }

  // Клік по іконці позивного → картка позивного.
  tableWrap.addEventListener("click", (e) => {
    const ic = e.target.closest(".xa-cs-icon");
    if (!ic) return;
    const csId = parseInt(ic.dataset.csId, 10);
    if (Number.isFinite(csId) && window.openCallsignEditModalById) {
      window.openCallsignEditModalById(csId, { source: "cross-analysis" });
    }
  });

  // ── Відкриття/закриття ──
  if (btn) {
    btn.addEventListener("click", () => {
      if (freqInp)  freqInp.value  = btn.dataset.netFreq || "";
      if (netIdInp) netIdInp.value = btn.dataset.netId || "";
      if (minInp && !minInp.value) minInp.value = "5";
      summary.classList.add("hidden");
      tableWrap.innerHTML = "";
      msg.textContent = "";
      openModal();
      if (netIdInp.value) load();
    });
  }
  if (showBtn) showBtn.addEventListener("click", load);
  if (minInp) minInp.addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
  modal.addEventListener("click", (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[data-cross-close="1"]') : null;
    if (t) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
  });
})();
