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
    modal.hidden = false;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
  }

  function hideModal() {
    modal.hidden = true;
    modal.classList.remove("is-open");
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
    if (event.target === modal) {
      hideModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !modal.hidden) {
      hideModal();
    }
  });
})();