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
    // Взаємне виключення: на екрані одна таблиця — ховаємо трансферну.
    if (trMsg) trMsg.textContent = "";
    if (trWrap) trWrap.innerHTML = "";
    if (trActions) trActions.style.display = "none";
    _trPairs = [];

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
      // Чистий старт трансферу при кожному відкритті модалки.
      if (trFreqInp) trFreqInp.value = "";
      if (trNetIdInp) trNetIdInp.value = "";
      if (trMsg) trMsg.textContent = "";
      if (trWrap) trWrap.innerHTML = "";
      if (trActions) trActions.style.display = "none";
      _trPairs = [];
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

  /* ══════════════════════════════════════════════════════════════════
     Трансфер даних між одноіменними позивними двох р/м
     ══════════════════════════════════════════════════════════════════ */
  const trFreqInp  = $("xaTrFreq");
  const trNetIdInp = $("xaTrNetId");
  const trAcList   = $("xaTrAcList");
  const transferBtn = $("xaTransferBtn");
  const trMsg      = $("xaTransferMsg");
  const trWrap     = $("xaTransferWrap");
  const trActions  = $("xaTransferActions");
  const doTransferBtn = $("xaDoTransferBtn");

  let _trPairs = [];  // [{name, source:{callsign_id,status_id,status_label}, target:{...}, dir}]

  /* ── Автокомпліт частоти для трансферної р/м ── */
  let trAcTimer = null;
  function hideTrAc() { if (trAcList) { trAcList.classList.add("hidden"); trAcList.innerHTML = ""; } }
  async function runTrAc(q) {
    if (!q.trim()) { hideTrAc(); return; }
    try {
      const r = await fetch("/api/networks/lookup?q=" + encodeURIComponent(q.trim()));
      const d = await r.json();
      const rows = (d && d.ok ? d.rows : []) || [];
      if (!rows.length) { hideTrAc(); return; }
      trAcList.innerHTML = rows.slice(0, 40).map((row) =>
        `<div class="xa-ac-item" data-id="${row.id}" data-freq="${esc(row.frequency)}">` +
        `<b>${esc(row.frequency)}</b>` +
        (row.mask ? ` <span class="xa-ac-mask">${esc(row.mask)}</span>` : "") +
        (row.unit ? ` <span class="xa-ac-unit">${esc(row.unit)}</span>` : "") + `</div>`).join("");
      trAcList.classList.remove("hidden");
    } catch (_) { hideTrAc(); }
  }
  if (trFreqInp) {
    trFreqInp.addEventListener("input", () => {
      if (trNetIdInp) trNetIdInp.value = "";
      clearTimeout(trAcTimer);
      trAcTimer = setTimeout(() => runTrAc(trFreqInp.value), 200);
    });
    trFreqInp.addEventListener("focus", () => { if (trFreqInp.value.trim()) runTrAc(trFreqInp.value); });
  }
  if (trAcList) {
    trAcList.addEventListener("click", (e) => {
      const it = e.target.closest(".xa-ac-item");
      if (!it) return;
      trFreqInp.value = it.dataset.freq || "";
      trNetIdInp.value = it.dataset.id || "";
      hideTrAc();
    });
  }
  document.addEventListener("click", (e) => {
    if (trAcList && !trAcList.contains(e.target) && e.target !== trFreqInp) hideTrAc();
  });

  async function resolveTrNetId() {
    const id = parseInt(trNetIdInp.value, 10);
    if (Number.isFinite(id) && id > 0) return id;
    const freq = (trFreqInp.value || "").trim();
    if (!freq) return null;
    try {
      const r = await fetch("/api/networks/lookup?q=" + encodeURIComponent(freq));
      const d = await r.json();
      const rows = (d && d.ok ? d.rows : []) || [];
      const exact = rows.find((x) => (x.frequency || "").trim() === freq) || rows[0];
      if (exact) { trNetIdInp.value = String(exact.id); return exact.id; }
    } catch (_) {}
    return null;
  }

  function _trReset() { _trPairs = []; trWrap.innerHTML = ""; trActions.style.display = "none"; }

  async function loadTransfer() {
    hideTrAc();
    // Взаємне виключення: показуємо трансфер — ховаємо крос-таблицю й зведення.
    tableWrap.innerHTML = "";
    summary.classList.add("hidden");
    msg.textContent = "";
    const sourceId = await resolveNetId();
    if (!sourceId) { trMsg.textContent = "Спочатку оберіть вихідну радіомережу (верхнє поле)."; _trReset(); return; }
    const trId = await resolveTrNetId();
    if (!trId) { trMsg.textContent = "Задайте частоту радіомережі для трансферу."; _trReset(); return; }
    if (trId === sourceId) { trMsg.textContent = "Оберіть р/м для трансферу, відмінну від вихідної."; _trReset(); return; }
    trMsg.textContent = "Завантаження…"; _trReset();
    let d;
    try {
      const r = await fetch(`/api/callsigns/transfer-pairs?source_id=${sourceId}&target_id=${trId}`);
      d = await r.json();
    } catch (_) { d = null; }
    if (!d || !d.ok) { trMsg.textContent = (d && d.error) || "Помилка завантаження."; return; }
    _trPairs = (d.pairs || []).map((p) => ({ ...p, dir: 0 }));
    renderTransfer(d);
  }

  // dir: 0 = ✕ (без трансферу); -1 = «« (з трансферної → у вихідну, кол.5→кол.3);
  //      1 = »» (з вихідної → у трансферну, кол.3→кол.5).
  function dirBtnHtml(dir, idx) {
    let cls = "xa-dir--none", label = "✕", title = "Без трансферу (клік — змінити напрямок)";
    if (dir === -1) { cls = "xa-dir--on"; label = "«"; title = "Трансфер: з трансферної → у вихідну"; }
    else if (dir === 1) { cls = "xa-dir--on"; label = "»"; title = "Трансфер: з вихідної → у трансферну"; }
    return `<button type="button" class="xa-dir-btn ${cls}" data-idx="${idx}" title="${title}">${label}</button>`;
  }

  function renderTransfer(d) {
    const s = d.source || {}, t = d.target || {};
    if (!_trPairs.length) {
      trMsg.textContent = "Немає спільних (одноіменних) позивних між цими р/м.";
      _trReset(); return;
    }
    trMsg.textContent = "";
    const head =
      `<tr><th class="xa-th-np">№</th><th class="xa-th-name">Позивний</th>` +
      `<th class="xa-th-col" title="${esc(s.unit)}">Вихідна<div class="xa-th-cnt">${esc(s.frequency)}</div></th>` +
      `<th class="xa-th-dir">Трансфер</th>` +
      `<th class="xa-th-col" title="${esc(t.unit)}">Трансферна<div class="xa-th-cnt">${esc(t.frequency)}</div></th></tr>`;
    const body = _trPairs.map((p, i) =>
      `<tr>` +
      `<td class="xa-td-np">${i + 1}</td>` +
      `<td class="xa-td-name"><span class="xa-name-txt">${esc(p.name)}</span></td>` +
      `<td class="xa-td-cell">${csIcon(p.source, p.name)}</td>` +
      `<td class="xa-td-dir">${dirBtnHtml(p.dir, i)}</td>` +
      `<td class="xa-td-cell">${csIcon(p.target, p.name)}</td>` +
      `</tr>`).join("");
    trWrap.innerHTML = `<table class="xa-table xa-table--transfer"><thead>${head}</thead><tbody>${body}</tbody></table>`;
    trActions.style.display = "";
    _updateDoTransfer();
  }

  function _updateDoTransfer() {
    if (doTransferBtn) doTransferBtn.disabled = !_trPairs.some((p) => p.dir !== 0);
  }

  if (trWrap) {
    trWrap.addEventListener("click", (e) => {
      const b = e.target.closest(".xa-dir-btn");
      if (b) {
        const idx = parseInt(b.dataset.idx, 10);
        if (_trPairs[idx]) {
          const cur = _trPairs[idx].dir;
          _trPairs[idx].dir = cur === 0 ? 1 : (cur === 1 ? -1 : 0);
          b.outerHTML = dirBtnHtml(_trPairs[idx].dir, idx);
          _updateDoTransfer();
        }
        return;
      }
      const ic = e.target.closest(".xa-cs-icon");
      if (ic) {
        const csId = parseInt(ic.dataset.csId, 10);
        if (Number.isFinite(csId) && window.openCallsignEditModalById) {
          window.openCallsignEditModalById(csId, { source: "transfer" });
        }
      }
    });
  }

  async function doTransfer() {
    const transfers = [];
    for (const p of _trPairs) {
      if (p.dir === 1) transfers.push({ from_id: p.source.callsign_id, to_id: p.target.callsign_id });
      else if (p.dir === -1) transfers.push({ from_id: p.target.callsign_id, to_id: p.source.callsign_id });
    }
    if (!transfers.length) return;
    if (!confirm(`Провести трансфер даних для ${transfers.length} позивних? Дані отримувача буде перезаписано.`)) return;
    doTransferBtn.disabled = true;
    try {
      const r = await fetch("/api/callsigns/transfer", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transfers }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || "Помилка");
      if (window.appToast) window.appToast(`Трансфер виконано: ${d.count}`, "success", 2200);
      loadTransfer();  // перезавантажити іконки статусів
      if (window.decorateCallsignConclusions) window.decorateCallsignConclusions(document);
    } catch (e) {
      if (window.appToast) window.appToast("Помилка трансферу: " + (e.message || e), "error", 2600);
      doTransferBtn.disabled = false;
    }
  }

  if (transferBtn) transferBtn.addEventListener("click", loadTransfer);
  if (doTransferBtn) doTransferBtn.addEventListener("click", doTransfer);
})();
