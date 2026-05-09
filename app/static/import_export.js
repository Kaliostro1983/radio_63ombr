/* import_export.js – v2
 * Handles the Import/Export page: XLSX upload + chatbot error queue.
 */

(function () {
  "use strict";

  // ─── Lookups: human-readable labels ──────────────────────────────────────

  const REASON_LABELS = {
    "alias_not_found":         "Відсутній аліас",
    "network_not_found":       "Відсутня мережа",
    "unknown format":          "Невідомий формат",
    "dt_invalid":              "Невалідна дата",
    "structured_parse_failed": "Помилка розбору",
    "peleng_parse_failed":     "Помилка пеленгу",
    "header_missing":          "Відсутній заголовок",
    "published_at_missing":    "Відсутня дата",
    "body_missing":            "Відсутнє тіло",
    "sender_missing":          "Відсутній відправник",
  };

  const FORMAT_LABELS = {
    "unknown":            "Невідомий",
    "structured_alias":   "Структурний",
    "peleng_type":        "Пеленг",
    "nonstandard_type_1": "Нестандартний",
    "analytical_type":    "Аналітичний",
    "template":           "Шаблон",
  };

  function reasonLabel(r)  { return REASON_LABELS[r]  || r || "—"; }
  function formatLabel(f)  { return FORMAT_LABELS[f]  || f || "—"; }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function qs(sel, ctx) { return (ctx || document).querySelector(sel); }

  function fmtDt(iso) {
    if (!iso) return "—";
    try {
      const d = new Date(iso.replace(" ", "T"));
      const pad = n => String(n).padStart(2, "0");
      return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return iso; }
  }

  function toast(msg, type, ms) {
    const stack = document.getElementById("appToastStack");
    if (!stack) { console.log(msg); return; }
    const el = document.createElement("div");
    el.className = "app-toast app-toast--" + (type || "info");
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), ms || 3000);
  }

  async function apiFetch(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    return data;
  }

  function esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ─── Tab switching ────────────────────────────────────────────────────────

  const tabBtns  = document.querySelectorAll(".tabs-nav .tab-btn");
  const tabPanes = document.querySelectorAll(".tab-panel");

  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      tabBtns.forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      tabPanes.forEach(p => p.classList.add("hidden"));
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      const pane = document.getElementById(btn.getAttribute("aria-controls"));
      if (pane) pane.classList.remove("hidden");
      if (btn.id === "ieTabBot") loadErrors();
    });
  });

  // ─── XLSX Upload ─────────────────────────────────────────────────────────

  const xlsxFile       = qs("#ieXlsxFile");
  const xlsxFileName   = qs("#ieXlsxFileName");
  const xlsxUploadBtn  = qs("#ieXlsxUploadBtn");
  const xlsxProgress   = qs("#ieXlsxProgress");
  const xlsxResult     = qs("#ieXlsxResult");
  const xlsxResultHead = qs("#ieXlsxResultHead");
  const xlsxResultDet  = qs("#ieXlsxResultDetails");

  if (xlsxFile) {
    xlsxFile.addEventListener("change", () => {
      const f = xlsxFile.files[0];
      xlsxFileName.textContent = f ? f.name : "Оберіть файл…";
      xlsxUploadBtn.disabled = !f;
      xlsxResult.style.display = "none";
    });
  }

  if (xlsxUploadBtn) {
    xlsxUploadBtn.addEventListener("click", async () => {
      const f = xlsxFile.files[0];
      if (!f) return;
      xlsxUploadBtn.disabled = true;
      xlsxProgress.style.display = "flex";
      xlsxResult.style.display = "none";
      const fd = new FormData();
      fd.append("file", f);
      try {
        const data = await apiFetch("/api/import/xlsx", { method: "POST", body: fd });
        xlsxProgress.style.display = "none";
        xlsxResult.style.display = "block";
        if (data.ok) {
          xlsxResultHead.textContent = "✅ Імпорт завершено";
          xlsxResultHead.className = "ie-result-head ok";
          xlsxResultDet.textContent = renderXlsxResult(data.result);
        } else {
          xlsxResultHead.textContent = "❌ Помилка імпорту";
          xlsxResultHead.className = "ie-result-head err";
          xlsxResultDet.textContent = data.detail || JSON.stringify(data, null, 2);
        }
      } catch (e) {
        xlsxProgress.style.display = "none";
        xlsxResult.style.display = "block";
        xlsxResultHead.textContent = "❌ Помилка мережі";
        xlsxResultHead.className = "ie-result-head err";
        xlsxResultDet.textContent = String(e);
      } finally {
        xlsxUploadBtn.disabled = false;
      }
    });
  }

  function renderXlsxResult(r) {
    if (!r) return "—";
    if (typeof r === "string") return r;
    const lines = [];
    if (r.total      !== undefined) lines.push(`Всього рядків : ${r.total}`);
    if (r.inserted   !== undefined) lines.push(`Вставлено     : ${r.inserted}`);
    if (r.skipped    !== undefined) lines.push(`Пропущено     : ${r.skipped}`);
    if (r.errors     !== undefined) lines.push(`Помилок       : ${r.errors}`);
    if (r.duplicates !== undefined) lines.push(`Дублікатів    : ${r.duplicates}`);
    if (Array.isArray(r.error_details) && r.error_details.length) {
      lines.push("", "── Деталі помилок ──");
      r.error_details.slice(0, 50).forEach(e => lines.push(`  ${e}`));
    }
    return lines.join("\n") || JSON.stringify(r, null, 2);
  }

  // ─── Chatbot error queue ──────────────────────────────────────────────────

  const botRefreshBtn    = qs("#ieBotRefreshBtn");
  const botOnlyNew       = qs("#ieBotOnlyNew");
  const botLoader        = qs("#ieBotLoader");
  const botEmpty         = qs("#ieBotEmpty");
  const botTableWrap     = qs("#ieBotTableWrap");
  const botTbody         = qs("#ieBotTbody");
  const botStats         = qs("#ieBotStats");
  const botTotalEl       = qs("#ieBotTotal");
  const botUnrevEl       = qs("#ieBotUnreviewed");
  const botVisibleEl     = qs("#ieBotVisible");
  const botFilterArea    = qs("#ieBotFilterArea");
  const botFilterReasons = qs("#ieBotFilterReasons");
  const botFilterFormats = qs("#ieBotFilterFormats");

  // Active filter sets (all active by default, filled on load)
  let activeReasons = new Set();
  let activeFormats = new Set();

  if (botRefreshBtn) botRefreshBtn.addEventListener("click", loadErrors);
  if (botOnlyNew)    botOnlyNew.addEventListener("change", loadErrors);

  async function loadErrors() {
    const filter = botOnlyNew && botOnlyNew.checked ? "unreviewed" : "all";
    botLoader.style.display = "block";
    botEmpty.style.display  = "none";
    botTableWrap.style.display = "none";
    botStats.style.display     = "none";
    if (botFilterArea) botFilterArea.style.display = "none";

    const data = await apiFetch(`/api/ingest/errors?filter=${filter}&limit=200`);
    botLoader.style.display = "none";

    if (!data.ok) {
      toast("Помилка завантаження: " + (data.error || "?"), "error");
      return;
    }

    botStats.style.display  = "block";
    botTotalEl.textContent  = data.total;
    botUnrevEl.textContent  = data.unreviewed;

    if (!data.items || data.items.length === 0) {
      botEmpty.style.display = "block";
      return;
    }

    buildFilters(data.items);
    renderErrors(data.items);
    botTableWrap.style.display = "block";
  }

  // ─── Filters ─────────────────────────────────────────────────────────────

  function buildFilters(items) {
    // Collect unique values from the data
    const reasons = [...new Set(items.map(i => i.parse_error || "—"))];
    const formats = [...new Set(items.map(i => i.message_format || "unknown"))];

    // Reset active sets to "all active"
    activeReasons = new Set(reasons);
    activeFormats = new Set(formats);

    if (botFilterReasons) {
      botFilterReasons.innerHTML =
        `<span class="ie-filter-group-label">Причина:</span>`;
      reasons.forEach(r => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ie-filter-btn active";
        btn.dataset.filterReason = r;
        btn.textContent = reasonLabel(r);
        btn.addEventListener("click", () => toggleFilter(btn, "reason", r));
        botFilterReasons.appendChild(btn);
      });
    }

    if (botFilterFormats) {
      botFilterFormats.innerHTML =
        `<span class="ie-filter-group-label">Формат:</span>`;
      formats.forEach(f => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ie-filter-btn active";
        btn.dataset.filterFormat = f;
        btn.textContent = formatLabel(f);
        btn.addEventListener("click", () => toggleFilter(btn, "format", f));
        botFilterFormats.appendChild(btn);
      });
    }

    if (botFilterArea) botFilterArea.style.display = "block";
  }

  function toggleFilter(btn, type, value) {
    if (type === "reason") {
      if (activeReasons.has(value)) activeReasons.delete(value);
      else activeReasons.add(value);
    } else {
      if (activeFormats.has(value)) activeFormats.delete(value);
      else activeFormats.add(value);
    }
    btn.classList.toggle("active");
    applyFilters();
  }

  function applyFilters() {
    let visible = 0;
    botTbody.querySelectorAll("tr[data-reason]").forEach(row => {
      const show = activeReasons.has(row.dataset.reason) && activeFormats.has(row.dataset.format);
      row.classList.toggle("ie-hidden", !show);
      if (!row.classList.contains("ie-text-row") && show) visible++;
    });
    if (botVisibleEl) botVisibleEl.textContent = visible;
  }

  // ─── Render error rows ────────────────────────────────────────────────────

  function renderErrors(items) {
    botTbody.innerHTML = "";

    items.forEach((item, idx) => {
      const reviewed = !!item.reviewed_at;
      const reason   = item.parse_error || "—";
      const format   = item.message_format || "unknown";

      // ── Metadata row ──
      const tr = document.createElement("tr");
      tr.className = "ie-item-row" + (reviewed ? " ie-row-reviewed" : "");
      tr.dataset.reason = reason;
      tr.dataset.format = format;
      tr.id = `ie-row-${item.id}`;

      tr.innerHTML = `
        <td class="ie-col-num">${idx + 1}</td>
        <td class="ie-col-dt">${fmtDt(item.received_at)}</td>
        <td class="ie-col-chat">${esc(item.source_chat_name || item.platform || "—")}</td>
        <td class="ie-col-fmt"><code>${esc(format)}</code></td>
        <td class="ie-col-reason"><span class="ie-error-badge">${esc(reasonLabel(reason))}</span></td>
        <td class="ie-col-status">
          ${reviewed
            ? `<span class="ie-status-done"></span><span class="ie-status-txt">переглянуто</span>`
            : `<span class="ie-status-new"></span><span class="ie-status-txt">нове</span>`}
        </td>
        <td class="ie-col-actions">
          <div class="ie-row-actions">
            ${!reviewed
              ? `<button class="ie-btn-sm retry"   data-retry="${item.id}"   title="Повторно обробити">▶</button>
                 <button class="ie-btn-sm dismiss" data-dismiss="${item.id}" title="Позначити як переглянуто">✓</button>`
              : ""}
          </div>
        </td>`;
      botTbody.appendChild(tr);

      // ── Raw text row (always visible) ──
      const trText = document.createElement("tr");
      trText.className = "ie-text-row" + (reviewed ? " ie-row-reviewed" : "");
      trText.dataset.reason = reason;
      trText.dataset.format = format;
      trText.innerHTML = `
        <td class="ie-text-cell" colspan="7">
          <div class="ie-raw-text">${esc(item.raw_text || "")}</div>
        </td>`;
      botTbody.appendChild(trText);
    });

    // Bind action handlers via delegation
    botTbody.addEventListener("click", handleTableClick, { once: false });
    if (botVisibleEl) botVisibleEl.textContent = items.length;
  }

  let _tableClickBound = false;
  function handleTableClick(e) {
    const dismiss = e.target.closest("[data-dismiss]");
    const retry   = e.target.closest("[data-retry]");
    if (dismiss) dismissRow(Number(dismiss.dataset.dismiss));
    if (retry)   retryRow(Number(retry.dataset.retry));
  }
  // Bind once (to avoid duplicates on reload)
  qs("#ieBotTbody") && qs("#ieBotTbody").addEventListener("click", handleTableClick);

  async function dismissRow(id) {
    const data = await apiFetch(`/api/ingest/${id}/dismiss`, { method: "POST" });
    if (data.ok) {
      toast("Позначено як переглянуте", "success", 2000);
      loadErrors();
    } else {
      toast("Помилка: " + (data.error || "?"), "error");
    }
  }

  async function retryRow(id) {
    const btn = botTbody.querySelector(`[data-retry="${id}"]`);
    if (btn) { btn.disabled = true; btn.textContent = "…"; }

    const data = await apiFetch(`/api/ingest/${id}/retry`, { method: "POST" });

    if (data.ok) {
      if (data.skipped) {
        toast(`Ще не вдалося: ${reasonLabel(data.reason)}`, "info", 4000);
      } else if (data.duplicate) {
        toast("Дублікат — повідомлення вже є в БД", "info", 3000);
      } else if (data.message_row_id) {
        toast(`Успішно прийнято → повідомлення #${data.message_row_id}`, "success", 3500);
      } else {
        toast("Оброблено", "success", 3000);
      }
      loadErrors();
    } else {
      toast("Помилка повторної обробки: " + (data.error || "?"), "error");
      if (btn) { btn.disabled = false; btn.textContent = "▶"; }
    }
  }

})();
