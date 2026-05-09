/* import_export.js – v1
 * Handles the Import/Export page: XLSX upload + chatbot error queue.
 */

(function () {
  "use strict";

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

      // Auto-load chatbot errors when switching to that tab
      if (btn.id === "ieTabBot") loadErrors();
    });
  });

  // ─── XLSX Upload ─────────────────────────────────────────────────────────

  const xlsxFile      = qs("#ieXlsxFile");
  const xlsxFileName  = qs("#ieXlsxFileName");
  const xlsxUploadBtn = qs("#ieXlsxUploadBtn");
  const xlsxProgress  = qs("#ieXlsxProgress");
  const xlsxResult    = qs("#ieXlsxResult");
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
    if (r.total   !== undefined) lines.push(`Всього рядків : ${r.total}`);
    if (r.inserted !== undefined) lines.push(`Вставлено     : ${r.inserted}`);
    if (r.skipped  !== undefined) lines.push(`Пропущено     : ${r.skipped}`);
    if (r.errors   !== undefined) lines.push(`Помилок       : ${r.errors}`);
    if (r.duplicates !== undefined) lines.push(`Дублікатів    : ${r.duplicates}`);
    if (Array.isArray(r.error_details) && r.error_details.length) {
      lines.push("", "── Деталі помилок ──");
      r.error_details.slice(0, 50).forEach(e => lines.push(`  ${e}`));
    }
    return lines.join("\n") || JSON.stringify(r, null, 2);
  }

  // ─── Chatbot error queue ──────────────────────────────────────────────────

  const botRefreshBtn  = qs("#ieBotRefreshBtn");
  const botOnlyNew     = qs("#ieBotOnlyNew");
  const botLoader      = qs("#ieBotLoader");
  const botEmpty       = qs("#ieBotEmpty");
  const botTableWrap   = qs("#ieBotTableWrap");
  const botTbody       = qs("#ieBotTbody");
  const botStats       = qs("#ieBotStats");
  const botTotalEl     = qs("#ieBotTotal");
  const botUnrevEl     = qs("#ieBotUnreviewed");

  if (botRefreshBtn) botRefreshBtn.addEventListener("click", loadErrors);
  if (botOnlyNew)    botOnlyNew.addEventListener("change", loadErrors);

  async function loadErrors() {
    const filter = botOnlyNew && botOnlyNew.checked ? "unreviewed" : "all";
    botLoader.style.display = "block";
    botEmpty.style.display  = "none";
    botTableWrap.style.display = "none";
    botStats.style.display     = "none";

    const data = await apiFetch(`/api/ingest/errors?filter=${filter}&limit=200`);
    botLoader.style.display = "none";

    if (!data.ok) {
      toast("Помилка завантаження: " + (data.error || "?"), "error");
      return;
    }

    botStats.style.display   = "block";
    botTotalEl.textContent   = data.total;
    botUnrevEl.textContent   = data.unreviewed;

    if (!data.items || data.items.length === 0) {
      botEmpty.style.display = "block";
      return;
    }

    renderErrors(data.items);
    botTableWrap.style.display = "block";
  }

  function renderErrors(items) {
    botTbody.innerHTML = "";
    items.forEach(item => {
      const reviewed = !!item.reviewed_at;
      const tr = document.createElement("tr");
      tr.id = `ie-row-${item.id}`;
      if (reviewed) tr.classList.add("ie-row-reviewed");

      tr.innerHTML = `
        <td>${item.id}</td>
        <td style="white-space:nowrap">${fmtDt(item.received_at)}</td>
        <td>${esc(item.source_chat_name || item.platform || "—")}</td>
        <td style="font-family:monospace;font-size:12px">${esc(item.message_format || "—")}</td>
        <td><span class="ie-error-badge">${esc(item.parse_error || item.parse_status || "—")}</span></td>
        <td>
          ${reviewed
            ? `<span class="ie-status-done"></span><span style="font-size:12px">переглянуто</span>`
            : `<span class="ie-status-new"></span><span style="font-size:12px">нове</span>`
          }
        </td>
        <td>
          <div class="ie-row-actions">
            <button class="ie-btn-sm" data-expand="${item.id}" title="Показати текст">▼</button>
            ${!reviewed
              ? `<button class="ie-btn-sm retry" data-retry="${item.id}" title="Повторно обробити">▶</button>
                 <button class="ie-btn-sm dismiss" data-dismiss="${item.id}" title="Позначити як переглянуто">✓</button>`
              : ""
            }
          </div>
        </td>
      `;
      botTbody.appendChild(tr);

      // Raw text row (hidden)
      const trRaw = document.createElement("tr");
      trRaw.id = `ie-raw-${item.id}`;
      trRaw.className = "ie-raw-row";
      trRaw.style.display = "none";
      trRaw.innerHTML = `<td colspan="7"><div class="ie-raw-text">${esc(item.raw_text || "")}</div></td>`;
      botTbody.appendChild(trRaw);
    });

    // Bind action handlers
    botTbody.querySelectorAll("[data-expand]").forEach(btn => {
      btn.addEventListener("click", () => toggleRawRow(btn.dataset.expand, btn));
    });
    botTbody.querySelectorAll("[data-dismiss]").forEach(btn => {
      btn.addEventListener("click", () => dismissRow(Number(btn.dataset.dismiss)));
    });
    botTbody.querySelectorAll("[data-retry]").forEach(btn => {
      btn.addEventListener("click", () => retryRow(Number(btn.dataset.retry)));
    });
  }

  function toggleRawRow(id, btn) {
    const raw = document.getElementById(`ie-raw-${id}`);
    if (!raw) return;
    const visible = raw.style.display !== "none";
    raw.style.display = visible ? "none" : "";
    btn.textContent = visible ? "▼" : "▲";
  }

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
        toast(`#${id}: ще не вдалося — ${data.reason}`, "info", 4000);
      } else if (data.duplicate) {
        toast(`#${id}: дублікат`, "info", 3000);
      } else if (data.message_row_id) {
        toast(`#${id}: успішно → message #${data.message_row_id}`, "success", 3500);
      } else {
        toast(`#${id}: оброблено`, "success", 3000);
      }
      loadErrors();
    } else {
      toast("Помилка retry: " + (data.error || "?"), "error");
      if (btn) { btn.disabled = false; btn.textContent = "▶"; }
    }
  }

  function esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

})();
