// static/intercepts_import.js
(function () {
  const importBtn = document.getElementById("importXlsxBtn");
  const fileInput = document.getElementById("xlsxFileInput");

  const modal = document.getElementById("xlsxImportModal");
  const modalBody = document.getElementById("xlsxImportModalBody");
  const modalTitle = document.getElementById("xlsxImportModalTitle");
  const closeBtn = document.getElementById("closeXlsxModalBtn");
  const closeBtnFooter = document.getElementById("closeXlsxModalBtnFooter");

  if (!importBtn || !fileInput || !modal || !modalBody) {
    return;
  }

  function showModal() {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
  }

  function hideModal() {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    modalBody.innerHTML = "";
    if (modalTitle) modalTitle.textContent = "Результат імпорту XLSX";
    document.body.classList.remove("modal-open");
  }

  function openModal(html, titleText) {
    modalBody.innerHTML = html;
    if (modalTitle) {
      modalTitle.textContent = String(titleText || "Результат імпорту XLSX");
    }
    showModal();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderSuccess(filename, result) {
    const reasonLabels = {
      dt_invalid: "Некоректна або неочікувана дата/час у шапці повідомлення",
      unknown_format: "Формат повідомлення не вдалося класифікувати",
      alias_not_found: "Не знайдено аліас радіомережі у вкладці «Академік»",
      network_not_found: "Не знайдено відповідну радіомережу у таблиці «Радіомережі»",
      published_at_missing: "У структурованому повідомленні відсутня дата/час",
      sender_missing: "У структурованому повідомленні відсутній «Відправник»",
      body_missing: "Порожнє тіло повідомлення",
      xlsx_empty_cell: "Порожня комірка в колонці «р/обмін»",
      xlsx_row_missing_target_column: "У рядку відсутня цільова колонка «р/обмін»",
    };

    const reasons = (result && typeof result === "object" && result.reasons && typeof result.reasons === "object")
      ? result.reasons
      : {};
    const reasonEntries = Object.entries(reasons || {})
      .map(([k, v]) => ({ k: String(k || ""), v: Number(v || 0) }))
      .filter((it) => it.k && Number.isFinite(it.v) && it.v > 0)
      .filter((it) => it.k !== "duplicate_message" && it.k !== "duplicate" && it.k !== "duplicates");
    const reasonSamples = (result && typeof result === "object" && result.reason_samples && typeof result.reason_samples === "object")
      ? result.reason_samples
      : {};

    const reasonsHtml = reasonEntries.length
      ? `
        <div class="import-skip-block" style="margin-top:14px">
          <div style="font-weight:800; margin-bottom:8px">Пропущені повідомлення: причини</div>
          <div class="small" style="opacity:.85; margin-bottom:8px">
            Дублікати не показуємо (це нормально). Нижче — підсумок по пропусках.
          </div>
          <ul class="import-skip-list">
            ${reasonEntries
              .sort((a, b) => (b.v - a.v) || a.k.localeCompare(b.k))
              .map((it) => {
                const label = reasonLabels[it.k] || "Технічна причина (див. код)";
                return `<li><code>${escapeHtml(it.k)}</code> — <strong>${it.v}</strong><br><span class="small" style="opacity:.82">${escapeHtml(label)}</span></li>`;
              })
              .join("")}
          </ul>
          <div class="small" style="opacity:.9; margin-top:8px">
            Разом пропущено: <strong>${reasonEntries.reduce((acc, it) => acc + it.v, 0)}</strong>
          </div>
          <div style="font-weight:700; margin-top:12px; margin-bottom:6px">Приклади пропущених</div>
          <div class="import-skip-samples">
            ${reasonEntries
              .sort((a, b) => (b.v - a.v) || a.k.localeCompare(b.k))
              .map((it) => {
                const samples = Array.isArray(reasonSamples[it.k]) ? reasonSamples[it.k] : [];
                if (!samples.length) {
                  return `<div class="import-skip-sample-group"><div><code>${escapeHtml(it.k)}</code></div><div class="small" style="opacity:.8">Немає прикладів.</div></div>`;
                }
                return `
                  <div class="import-skip-sample-group">
                    <div><code>${escapeHtml(it.k)}</code></div>
                    <ul class="import-skip-sample-list">
                      ${samples.map((s) => `<li><pre class="import-skip-pre">${escapeHtml(String(s || ""))}</pre></li>`).join("")}
                    </ul>
                  </div>
                `;
              })
              .join("")}
          </div>
          <div class="small" style="opacity:.75; margin-top:10px">
            Порада: якщо бачиш <code>alias_not_found</code> — перевір аліаси у вкладці «Академік». Якщо <code>network_not_found</code> — перевір наявність р/м у таблиці «Радіомережі».
          </div>
        </div>
      `
      : "";

    return `
      <div class="import-result-layout">
        <div class="import-result-left">
          <img
            src="/static/photos/techninal/import_completed.webp"
            alt="Import completed"
            class="import-result-completed-img"
          />
        </div>
        <div class="import-result-right">
          <div class="import-result">
            <div class="import-result-row"><strong>Усього рядків:</strong> ${result.total_rows ?? 0}</div>
            <div class="import-result-row"><strong>Оброблено:</strong> ${result.processed ?? 0}</div>
            <div class="import-result-row"><strong>Додано:</strong> ${result.inserted ?? 0}</div>
            <div class="import-result-row"><strong>Дублікатів:</strong> ${result.duplicates ?? 0}</div>
            <div class="import-result-row"><strong>Пропущено:</strong> ${result.skipped ?? 0}</div>
            <div class="import-result-row"><strong>Помилок:</strong> ${result.failed ?? 0}</div>
          </div>
          ${reasonsHtml}
        </div>
      </div>
    `;
  }

  function renderError(message) {
    return `
      <div class="import-result import-result-error">
        <div><strong>Помилка завантаження</strong></div>
        <div style="margin-top:8px;">${escapeHtml(message)}</div>
      </div>
    `;
  }

  async function uploadFile(file) {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch("/api/import/xlsx", {
      method: "POST",
      body: formData,
    });

    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }

    if (!response.ok) {
      const message = data?.detail || data?.message || "Не вдалося обробити файл.";
      throw new Error(message);
    }

    if (!data || data.ok !== true || !data.result) {
      throw new Error("Сервер повернув некоректну відповідь.");
    }

    return data.result;
  }

  hideModal();

  importBtn.addEventListener("click", () => {
    hideModal();
    fileInput.value = "";
    fileInput.click();
  });

  fileInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const lowerName = file.name.toLowerCase();
    if (!lowerName.endsWith(".xlsx")) {
      openModal(renderError("Підтримуються лише файли .xlsx"), "Результат імпорту XLSX");
      return;
    }

    const originalBtnText = importBtn.textContent;
    importBtn.disabled = true;
    importBtn.textContent = "Завантаження...";

    try {
      const result = await uploadFile(file);
      openModal(renderSuccess(file.name, result), file.name);
    } catch (error) {
      openModal(renderError(error.message || "Невідома помилка."), "Результат імпорту XLSX");
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = originalBtnText;
      fileInput.value = "";
    }
  });

  closeBtn?.addEventListener("click", hideModal);
  closeBtnFooter?.addEventListener("click", hideModal);

  modal.addEventListener("click", (event) => {
    const t = event.target;
    if (t && t.getAttribute && t.getAttribute("data-close") === "1") {
      hideModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) {
      hideModal();
    }
  });
})();