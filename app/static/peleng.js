(function () {
  console.log("peleng.js loaded");

  function $(id) {
    return document.getElementById(id);
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function getVal(id) {
    const el = $(id);
    return el ? (el.value || "").trim() : "";
  }

  function setVal(id, value) {
    const el = $(id);
    if (el) el.value = value ?? "";
  }

  function escapeHtml(v) {
    return String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function showToast(text, ms = 1400) {
    if (window.appToast) {
      window.appToast(text, "success", ms);
      return;
    }
    const t = $("toast");
    if (!t) return;
    t.textContent = text;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), ms);
  }

  async function apiNetworksLookup(q) {
    const resp = await fetch(`/api/networks/lookup?q=${encodeURIComponent(q)}`, {
      headers: { Accept: "application/json" },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      return { rows: [] };
    }
    return { rows: Array.isArray(data.rows) ? data.rows : [] };
  }

  function setupFreqAutocomplete() {
    const freqInput = $("frequency");
    const unitInput = $("unit");
    const datalist = $("pelengFreqMasksList");
    if (!freqInput || !unitInput || !datalist) return;

    let lastNetworkLookupResults = [];
    let timer = null;
    const minLen = 2;

    function setUnitFromValue(val) {
      const v = String(val || "").trim();
      if (!v) return;
      const hit = lastNetworkLookupResults.find((r) => (r.frequency && r.frequency === v) || (r.mask && r.mask === v));
      if (!hit) return;
      if (hit.unit) setVal("unit", hit.unit);
    }

    function clearDatalist() {
      while (datalist.firstChild) datalist.removeChild(datalist.firstChild);
    }

    async function updateDatalist(query) {
      const { rows } = await apiNetworksLookup(query);
      lastNetworkLookupResults = rows;

      clearDatalist();
      if (!rows.length) return;

      // Add only unique option values to avoid duplicated suggestions.
      const seen = new Set();
      const pushOpt = (val) => {
        const v = String(val || "").trim();
        if (!v || seen.has(v)) return;
        seen.add(v);
        const opt = document.createElement("option");
        opt.value = v;
        datalist.appendChild(opt);
      };

      for (const r of rows) {
        pushOpt(r.frequency);
        pushOpt(r.mask);
      }
    }

    freqInput.addEventListener("input", () => {
      const q = String(freqInput.value || "").trim();
      if (timer) clearTimeout(timer);

      // If user erased the input - keep UI clean.
      if (!q) {
        lastNetworkLookupResults = [];
        clearDatalist();
        return;
      }

      if (q.length < minLen) return;

      timer = setTimeout(() => {
        updateDatalist(q).catch(() => {});
      }, 250);
    });

    freqInput.addEventListener("change", () => setUnitFromValue(freqInput.value));
    freqInput.addEventListener("blur", () => setUnitFromValue(freqInput.value));
  }

  function nowToInputs() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mi = pad2(d.getMinutes());

    setVal("event_date", `${yyyy}-${mm}-${dd}`);
    setVal("event_time", `${hh}:${mi}`);
  }

  async function apiPost(url, body) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      throw new Error(data.detail || data.error || "Помилка запиту");
    }

    return data;
  }

  async function acceptFreq() {
    const raw = getVal("frequency");
    if (!raw) {
      if (window.appToast) window.appToast("Введи частоту або маску.", "error");
      return;
    }

    try {
      const data = await apiPost("/peleng/accept", { value: raw });
      setVal("frequency", data.display_value || raw);
      if (data.unit) setVal("unit", data.unit);
      if (data.location) setVal("location", data.location);
      showToast("Прийнято");
    } catch (e) {
      if (window.appToast) window.appToast(e.message || "Помилка", "error");
    }
  }

  async function generateMessage() {
    const payload = {
      date: getVal("event_date"),
      time: getVal("event_time"),
      freq_or_mask: getVal("frequency"),
      unit: getVal("unit"),
      location: getVal("location"),
      mgrs_text: $("mgrs_text")?.value || "",
      comment: $("comment")?.value || "",
    };

    try {
      const data = await apiPost("/peleng/generate", payload);
      setVal("output", data.text || "");

      const txt = (data.text || "").trim();
      if (txt) {
        const copied = await window.clipboardWrite(txt);
        showToast(copied ? "Скопійовано у буфер" : "Згенеровано");
      }
    } catch (e) {
      if (window.appToast) window.appToast(e.message || "Помилка", "error");
    }
  }

  async function copyOutput() {
    const txt = getVal("output");
    if (!txt) {
      if (window.appToast) window.appToast("Спершу згенеруй повідомлення.", "info");
      return;
    }

    const ok = await window.clipboardWrite(txt);
    if (ok) {
      showToast("Скопійовано", 1500);
    } else {
      if (window.appToast) window.appToast("Не вдалося скопіювати в буфер.", "error");
    }
  }

  function toLocalInputValue(d) {
    const yyyy = d.getFullYear();
    const mm = pad2(d.getMonth() + 1);
    const dd = pad2(d.getDate());
    const hh = pad2(d.getHours());
    const mi = pad2(d.getMinutes());
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
  }

  function localInputToSql(dtLocal) {
    if (!dtLocal) return "";
    return `${dtLocal.replace("T", " ")}:00`;
  }

  function refreshReportModeNote() {
    const text = ($("report_source_text")?.value || "").trim();
    const note = $("report_mode_note");
    if (!note) return;

    if (text) {
      note.textContent = "Режим: звіт із вставленого тексту (БД ігнорується)";
      note.classList.add("text-mode");
    } else {
      note.textContent = "Режим: вибірка з БД";
      note.classList.remove("text-mode");
    }
  }

  function initReportInputs() {
    const now = new Date();
    const hours = Number($("report_hours")?.value || 9);

    const toEl = $("report_to_dt");
    const fromEl = $("report_from_dt");
    if (!toEl || !fromEl) return;

    toEl.value = toLocalInputValue(now);
    fromEl.value = toLocalInputValue(new Date(now.getTime() - hours * 60 * 60 * 1000));

    refreshReportModeNote();
  }

  /** Period field changed → update end date (start + hours = end) */
  function updateReportEndByHours() {
    const fromEl = $("report_from_dt");
    const toEl   = $("report_to_dt");
    const hoursEl = $("report_hours");
    if (!fromEl || !toEl || !hoursEl) return;
    const fromVal = fromEl.value;
    const hours = Number(hoursEl.value || 0);
    if (!fromVal || !hours || hours < 1) return;
    const fromDt = new Date(fromVal);
    toEl.value = toLocalInputValue(new Date(fromDt.getTime() + hours * 60 * 60 * 1000));
  }

  /** Start or end date changed → recalculate period in hours */
  function updateReportHoursByDates() {
    const fromEl  = $("report_from_dt");
    const toEl    = $("report_to_dt");
    const hoursEl = $("report_hours");
    if (!fromEl || !toEl || !hoursEl) return;
    if (!fromEl.value || !toEl.value) return;
    const diffMs = new Date(toEl.value).getTime() - new Date(fromEl.value).getTime();
    const diffH  = Math.round(diffMs / (60 * 60 * 1000));
    if (diffH > 0) hoursEl.value = String(diffH);
  }

  async function downloadBlob(url, options = {}, fallbackName = "report.docx") {
    const res = await fetch(url, options);

    if (!res.ok) {
      let msg = "Помилка формування звіту";
      try {
        const data = await res.json();
        msg = data.detail || data.error || msg;
      } catch {}
      throw new Error(msg);
    }

    const blob = await res.blob();
    let filename = fallbackName;

    const cd = res.headers.get("Content-Disposition") || "";
    // RFC 5987: filename*=UTF-8''<percent-encoded>
    const m5987 = cd.match(/filename\*=UTF-8''([^;\s]+)/i);
    if (m5987) {
      try { filename = decodeURIComponent(m5987[1]); } catch { filename = m5987[1]; }
    } else {
      // Legacy: filename="..." or filename=...
      const m = cd.match(/filename="?([^";\n]+)"?/);
      if (m && m[1]) filename = m[1].trim();
    }

    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  }

  async function updateReportPreview() {
    const text = ($("report_source_text")?.value || "").trim();
    const previewEl = $("report_preview");
    if (!previewEl) return;

    if (text) {
      previewEl.textContent = "Знайдено: режим тексту";
      return;
    }

    const fromDt = localInputToSql($("report_from_dt")?.value || "");
    const toDt = localInputToSql($("report_to_dt")?.value || "");

    if (!fromDt || !toDt) {
      previewEl.textContent = "Знайдено: —";
      return;
    }

    try {
      const qs = new URLSearchParams({ from_dt: fromDt, to_dt: toDt });
      const res = await fetch(`/peleng/report/preview?${qs.toString()}`);
      const data = await res.json();

      if (!res.ok) {
        previewEl.textContent = "Знайдено: —";
        return;
      }

      previewEl.textContent = `Батчів: ${data.batch_count}, точок: ${data.point_count}`;
    } catch {
      previewEl.textContent = "Знайдено: —";
    }
  }

  let previewTimer = null;

  function scheduleReportPreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(updateReportPreview, 250);
  }

  function makeReportFilename() {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const yyyy = now.getFullYear();
    return `Форма_1.2.13_${dd}.${mm}.${yyyy}.docx`;
  }

  async function downloadReportBlob(url, fetchOpts) {
    const res = await fetch(url, fetchOpts);
    const cd = res.headers.get("Content-Disposition") || "";
    console.log("[peleng] report response status:", res.status);
    console.log("[peleng] Content-Disposition:", cd);
    if (!res.ok) {
      let msg = "Помилка формування звіту";
      try { const d = await res.json(); msg = d.detail || d.error || msg; } catch {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const fname = makeReportFilename();
    console.log("[peleng] saving as:", fname);
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  }

  let _reportBusy = false;
  async function generateReport() {
    if (_reportBusy) return;
    _reportBusy = true;
    const text = ($("report_source_text")?.value || "").trim();

    try {
      if (text) {
        await downloadReportBlob("/peleng/report/from-text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        showToast("Звіт сформовано з тексту", 1700);
        return;
      }

      const fromDt = localInputToSql($("report_from_dt")?.value || "");
      const toDt = localInputToSql($("report_to_dt")?.value || "");

      if (!fromDt || !toDt) {
        if (window.appToast) window.appToast("Заповни початковий і кінцевий дата/час.", "error");
        return;
      }

      const qs = new URLSearchParams({ from_dt: fromDt, to_dt: toDt });
      await downloadReportBlob(`/peleng/report/by-period?${qs.toString()}`, {});
      showToast("Звіт сформовано з БД", 1700);
    } catch (e) {
      console.error("[peleng] generateReport error:", e);
      if (window.appToast) window.appToast(e.message || "Помилка", "error");
    } finally {
      _reportBusy = false;
    }
  }

  let postsState = [];

  function postRowTemplate(post, idx) {
    const tr = document.createElement("tr");
    tr.dataset.idx = String(idx);

    tr.innerHTML = `
      <td class="col-active"><input type="checkbox" class="post-active" ${post.active ? "checked" : ""}></td>
      <td class="col-id"><input type="text" class="post-id" value="${escapeHtml(post.id || "")}"></td>
      <td><input type="text" class="post-name" value="${escapeHtml(post.name || "")}"></td>
      <td class="col-bp"><input type="text" class="post-bp" value="${escapeHtml(post.bp_number || "")}"></td>
      <td><textarea class="post-unit">${escapeHtml(post.unit || "")}</textarea></td>
      <td><input type="text" class="post-equipment" value="${escapeHtml(post.equipment || "")}"></td>
      <td class="col-actions"><button type="button" class="btn btn-danger btn-post-delete">✕</button></td>
    `;
    return tr;
  }

  function renderPostsTable() {
    const tbody = $("posts_tbody");
    if (!tbody) return;

    tbody.innerHTML = "";
    postsState.forEach((post, idx) => {
      tbody.appendChild(postRowTemplate(post, idx));
    });
  }

  function collectPostsFromUi() {
    const rows = Array.from(document.querySelectorAll("#posts_tbody tr"));
    return rows.map((row, idx) => {
      const idVal = row.querySelector(".post-id")?.value?.trim() || `post_${idx + 1}`;
      return {
        active: !!row.querySelector(".post-active")?.checked,
        id: idVal,
        name: row.querySelector(".post-name")?.value?.trim() || "",
        bp_number: row.querySelector(".post-bp")?.value?.trim() || "",
        unit: row.querySelector(".post-unit")?.value || "",
        equipment: row.querySelector(".post-equipment")?.value?.trim() || "",
      };
    });
  }

  async function loadPosts() {
    try {
      const res = await fetch("/peleng/posts");
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || data.error || "Не вдалося завантажити пости");
      postsState = Array.isArray(data.posts) ? data.posts : [];
      renderPostsTable();
    } catch (e) {
      if (window.appToast) window.appToast(e.message || "Помилка", "error");
    }
  }

  function addPost() {
    postsState = collectPostsFromUi();
    postsState.push({
      active: true,
      id: `post_${postsState.length + 1}`,
      name: "",
      bp_number: "",
      unit: "",
      equipment: "",
    });
    renderPostsTable();
  }

  function deletePostRow(ev) {
    const btn = ev.target.closest(".btn-post-delete");
    if (!btn) return;

    const tr = btn.closest("tr");
    if (!tr) return;

    const idx = Number(tr.dataset.idx);
    postsState = collectPostsFromUi();
    postsState.splice(idx, 1);
    renderPostsTable();
  }

  async function savePosts() {
    try {
      postsState = collectPostsFromUi();
      const data = await apiPost("/peleng/posts/save", { posts: postsState });
      showToast(data.detail || "Пости збережено", 1700);
      await loadPosts();
    } catch (e) {
      if (window.appToast) window.appToast(e.message || "Помилка", "error");
    }
  }

  function setPelengTab(which) {
    console.log("setPelengTab", which);
    [
      ["compose", "pelTabCompose", "pelPaneCompose"],
      ["report",  "pelTabReport",  "pelPaneReport"],
      ["actual",  "pelTabActual",  "pelPaneActual"],
    ].forEach(([key, tabId, paneId]) => {
      const isActive = key === which;
      const tab = $(tabId), pane = $(paneId);
      if (tab)  { tab.classList.toggle("active", isActive); tab.setAttribute("aria-selected", isActive ? "true" : "false"); }
      if (pane)   pane.classList.toggle("hidden", !isActive);
    });
    if (which === "report") scheduleReportPreview();
  }

  /* ── Актуальне tab ── */
  function esc(s) {
    return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  let _actualData = null;

  async function loadActual() {
    const loader   = $("pelActualLoader");
    const emptyEl  = $("pelActualEmpty");
    const tableWrap= $("pelActualTableWrap");
    const tbody    = $("pelActualTbody");
    if (!loader) return;

    loader.style.display = "";
    emptyEl.style.display = "none";
    tableWrap.style.display = "none";

    try {
      const res = await fetch("/api/peleng/status-summary");
      if (!res.ok) throw new Error("Помилка сервера: " + res.status);
      _actualData = await res.json();
      renderActual();
    } catch (e) {
      loader.style.display = "none";
      if (window.appToast) window.appToast(e.message || "Помилка", "error");
    }
  }

  function renderActual() {
    const loader   = $("pelActualLoader");
    const emptyEl  = $("pelActualEmpty");
    const tableWrap= $("pelActualTableWrap");
    const tbody    = $("pelActualTbody");
    if (!_actualData || !tbody) return;

    const showGreen  = $("cbActualGreen")?.checked !== false;
    const showYellow = $("cbActualYellow")?.checked !== false;
    const showRed    = $("cbActualRed")?.checked !== false;

    const filtered = _actualData.filter(r =>
      !((r.status === "green"  && !showGreen) ||
        (r.status === "yellow" && !showYellow) ||
        (r.status === "red"    && !showRed))
    );

    if (loader) loader.style.display = "none";

    if (filtered.length === 0) {
      if (emptyEl)   emptyEl.style.display = "";
      if (tableWrap) tableWrap.style.display = "none";
      return;
    }

    tbody.innerHTML = filtered.map(r => {
      const tagHtml = r.tags
        ? r.tags.split(",").map(t => `<span class="pel-tag-badge">${esc(t.trim())}</span>`).join("")
        : "";
      const numCls = (n) => n > 0 ? " num-pos" : "";
      return `<tr>
        <td class="col-dot"><span class="pel-status-dot dot-${r.status}"></span></td>
        <td class="col-freq">${esc(r.frequency)}</td>
        <td>${esc(r.mask)}</td>
        <td class="col-unit">${esc(r.unit)}</td>
        <td>${tagHtml}</td>
        <td class="col-num${numCls(r.intercept_count_3d)}">${r.intercept_count_3d}</td>
        <td class="col-num">${r.peleng_count_10d}</td>
        <td class="col-dt">${esc(r.last_peleng_dt)}</td>
      </tr>`;
    }).join("");

    if (emptyEl)   emptyEl.style.display = "none";
    if (tableWrap) tableWrap.style.display = "";
  }

  document.addEventListener("DOMContentLoaded", () => {
    console.log("peleng DOM ready");

    const tabCompose = $("pelTabCompose");
    const tabReport  = $("pelTabReport");
    const tabActual  = $("pelTabActual");
    const btnNow = $("btn_now");
    const btnAccept = $("btn_accept");
    const btnGenerate = $("btn_generate");
    const btnCopy = $("btn_copy");
    const reportHours = $("report_hours");
    const reportTo = $("report_to_dt");
    const reportFrom = $("report_from_dt");
    const reportText = $("report_source_text");
    const reportBtn = $("btn_report_generate");
    const postsAddBtn = $("btn_posts_add");
    const postsSaveBtn = $("btn_posts_save");
    const postsTbody = $("posts_tbody");

    nowToInputs();
    initReportInputs();
    loadPosts();
    setupFreqAutocomplete();
    setPelengTab("compose");
    scheduleReportPreview();

    tabCompose?.addEventListener("click", () => {
      console.log("compose click");
      setPelengTab("compose");
    });

    tabReport?.addEventListener("click", () => {
      console.log("report click");
      setPelengTab("report");
    });

    tabActual?.addEventListener("click", () => {
      setPelengTab("actual");
    });

    const pelActualShowBtn = $("pelActualShowBtn");
    if (pelActualShowBtn) pelActualShowBtn.onclick = loadActual;

    btnNow?.addEventListener("click", nowToInputs);
    btnAccept?.addEventListener("click", acceptFreq);
    btnGenerate?.addEventListener("click", generateMessage);
    btnCopy?.addEventListener("click", copyOutput);

    if (reportHours) {
      reportHours.addEventListener("input", () => {
        updateReportEndByHours();
        scheduleReportPreview();
      });

      reportHours.addEventListener("change", () => {
        updateReportEndByHours();
        scheduleReportPreview();
      });
    }

    reportFrom?.addEventListener("change", () => {
      updateReportHoursByDates();
      scheduleReportPreview();
    });

    reportTo?.addEventListener("change", () => {
      updateReportHoursByDates();
      scheduleReportPreview();
    });

    reportText?.addEventListener("input", () => {
      refreshReportModeNote();
      scheduleReportPreview();
    });

    if (reportBtn)  reportBtn.onclick  = generateReport;
    if (postsAddBtn) postsAddBtn.onclick = addPost;
    if (postsSaveBtn) postsSaveBtn.onclick = savePosts;
    postsTbody?.addEventListener("click", deletePostRow);
  });
})();