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

    // On selection from datalist (or leaving the field) — silently fill
    // unit + location via the accept endpoint so the user doesn't have to
    // press "Прийняти" manually after choosing from autocomplete.
    async function autoFillFromFreq() {
      const raw = (freqInput.value || "").trim();
      if (!raw) return;
      try {
        const data = await apiPost("/peleng/accept", { value: raw });
        if (data.display_value) setVal("frequency", data.display_value);
        if (data.unit)     setVal("unit",     data.unit);
        if (data.location) setVal("location", data.location);
      } catch { /* silent — user can still press Прийняти manually */ }
    }

    freqInput.addEventListener("change", autoFillFromFreq);
    freqInput.addEventListener("blur",   autoFillFromFreq);
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

  // Legacy: вкладки замінені модалками. Лишаємо порожній no-op, щоб не
  // зламати потенційні зовнішні виклики (раніше функція ховала pelPaneReport,
  // що тепер — основний контент сторінки). При відкритті «report» лише
  // тригернемо scheduleReportPreview для сумісності.
  function setPelengTab(which) {
    if (which === "report") scheduleReportPreview();
  }

  /* ── Актуальне tab ── */
  function esc(s) {
    return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  let _actualData = null;

  // ── Threshold helpers ──────────────────────────────────────────────────────
  function getThresholds() {
    const gd = Math.max(1, parseInt($("pelThreshGreenDays")?.value)  || 3);
    const yd = Math.max(1, parseInt($("pelThreshYellowDays")?.value) || 8);
    return { greenH: gd * 24, yellowH: Math.max(gd * 24 + 1, yd * 24) };
  }

  function initThresholds() {
    const gd = parseInt(localStorage.getItem("pel_thresh_green_days"))  || 3;
    const yd = parseInt(localStorage.getItem("pel_thresh_yellow_days")) || 8;
    const gEl = $("pelThreshGreenDays");
    const yEl = $("pelThreshYellowDays");
    if (gEl) gEl.value = gd;
    if (yEl) yEl.value = yd;
    updateThreshDisplays(false);   // false = don't re-render (no data yet)
  }

  function updateThreshDisplays(rerender) {
    const gd = Math.max(1, parseInt($("pelThreshGreenDays")?.value)  || 3);
    const yd = Math.max(gd + 1, parseInt($("pelThreshYellowDays")?.value) || 8);
    localStorage.setItem("pel_thresh_green_days",  gd);
    localStorage.setItem("pel_thresh_yellow_days", yd);

    const gh = gd * 24;
    const yh = yd * 24;

    const ghEl = $("pelThreshGreenHours");
    const yhEl = $("pelThreshYellowHours");
    const rdEl = $("pelThreshRedDays");
    const rhEl = $("pelThreshRedHours");

    if (ghEl) ghEl.textContent = `≤ ${gh} год`;
    if (yhEl) yhEl.textContent = `≤ ${yh} год`;
    if (rdEl) rdEl.textContent = `> ${yd} діб`;
    if (rhEl) rhEl.textContent = `> ${yh} год`;

    if (rerender !== false && _actualData) renderActual();
  }

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

    const { greenH, yellowH } = getThresholds();

    // Re-classify using current thresholds (server may use different defaults)
    const filtered = _actualData
      .map(r => {
        let status = r.status;
        if (r.age_h != null) {
          status = r.age_h <= greenH ? "green" : (r.age_h <= yellowH ? "yellow" : "red");
        }
        return { ...r, status };
      })
      .filter(r =>
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
      return `<tr class="pel-actual-row" data-net-id="${r.id}" title="Відкрити еталонку р/м">
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

    // row click → open etalon in new tab
    tbody.onclick = (e) => {
      const tr = e.target.closest("tr.pel-actual-row");
      if (!tr) return;
      const id = tr.dataset.netId;
      if (id) window.open(`/etalons?pick=${id}`, "_blank");
    };
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
    scheduleReportPreview();

    // ── Модалки (Оформлення / Формування звіту / Актуальне) ──
    // Карта пеленгів тепер постійно видима як основний контент сторінки.
    // Решта функціоналу винесена в модалки, що відкриваються кнопками
    // в шапці сторінки.
    const pelModals = {
      compose: document.getElementById("pelModalCompose"),
      report:  document.getElementById("pelModalReport"),
      actual:  document.getElementById("pelModalActual"),
    };

    function openPelModal(which) {
      const m = pelModals[which];
      if (!m) return;
      m.classList.remove("hidden");
      m.removeAttribute("aria-hidden");
      // Триггер legacy-кнопок (приховані в DOM) — це активує існуючі
      // hooks типу scheduleReportPreview або init Actual.
      try { document.getElementById("pelTab" + which.charAt(0).toUpperCase() + which.slice(1))?.click(); } catch (_) {}
      if (which === "report") scheduleReportPreview();
    }

    function closePelModal(which) {
      const m = pelModals[which];
      if (!m) return;
      m.classList.add("hidden");
      m.setAttribute("aria-hidden", "true");
    }

    document.getElementById("pelOpenCompose")?.addEventListener("click", () => openPelModal("compose"));
    document.getElementById("pelOpenReport")?.addEventListener("click",  () => openPelModal("report"));
    document.getElementById("pelOpenActual")?.addEventListener("click",  () => openPelModal("actual"));

    document.querySelectorAll("[data-pel-modal-close]").forEach((el) => {
      el.addEventListener("click", (e) => {
        const which = el.getAttribute("data-pel-modal-close");
        if (which) { e.stopPropagation(); closePelModal(which); }
      });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      for (const k of ["compose","report","actual"]) {
        if (!pelModals[k].classList.contains("hidden")) { closePelModal(k); break; }
      }
    });

    const pelActualShowBtn = $("pelActualShowBtn");
    if (pelActualShowBtn) pelActualShowBtn.onclick = loadActual;

    // Threshold table — init from localStorage, update displays on change
    initThresholds();
    $("pelThreshGreenDays")?.addEventListener("input",  () => updateThreshDisplays());
    $("pelThreshYellowDays")?.addEventListener("input", () => updateThreshDisplays());
    // Checkboxes re-render immediately when data is already loaded
    $("cbActualGreen")?.addEventListener("change",  () => { if (_actualData) renderActual(); });
    $("cbActualYellow")?.addEventListener("change", () => { if (_actualData) renderActual(); });
    $("cbActualRed")?.addEventListener("change",    () => { if (_actualData) renderActual(); });

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

    // Map block (новий контейнер у Звіт-табі)
    initPelMapBlock();
  });

  /* ════════════════════════════════════════════════════════════
   *  Map block: фільтр (швидкі періоди + datetime) + Leaflet-карта
   *  з SIDC-маркерами антени + send-bar (платформа/чат/надіслати)
   * ════════════════════════════════════════════════════════════ */

  // SIDC: "Антена радіопередавача" (Hostile affiliation, position 4 = '6')
  const PEL_ANTENNA_SIDC = "10061000001101000000";
  const PEL_PLATFORM_KEY = "pelSendPlatform_v1";
  const PEL_CHAT_KEY     = "pelSendChat_v1";

  let _pelMap = null;
  let _pelMarkerLayer = null;
  let _pelSidcUrl = null;       // cache blob URL для SIDC-іконки
  let _pelSendPlatform = "whatsapp";
  let _pelSendChatId = "";
  let _pelChatsCache = { whatsapp: null, signal: null };
  let _pelLastRows = [];        // останні завантажені рядки (для перерендеру)
  let _pelShowFreq = false;     // стан чекбоксу «Частоти»
  let _pelShowUnit = false;     // стан чекбоксу «Підрозділ» (кола з номером)
  let _pelSending  = false;     // in-flight flag — захист від подвійного fetch

  /** Витягнути НОМЕР бригади/полка з опису р/м.
   *  Бере перше число (1–3 цифри), за яким йде кодова абревіатура частини —
   *  омсбр / мсп / мбр / тп / тбр / мсд / обмп / обмбр / орб / обр / полк/бригад…
   *  Якщо явного маркера немає — fallback на перше число в рядку (як правило
   *  це і є потрібний номер у форматі "164 омсбр 25 ЗА"). */
  function _pelExtractUnitNumber(unitText) {
    const s = String(unitText || "");
    if (!s) return null;
    const MARKERS = "(?:омсбр|мсбр|обр|омбр|обмбр|обмп|мсп|мп|тп|тбр|мбр|мсд|тд|обз|орб|оемб|оп|полк|бригад)";
    const re = new RegExp("(\\d{1,3})\\s*" + MARKERS, "i");
    const m = s.match(re);
    if (m) return m[1];
    const fallback = s.match(/\b(\d{1,3})\b/);
    return fallback ? fallback[1] : null;
  }

  /** Сталий колір для номера підрозділу. Один номер → один колір.
   *  Використовуємо HSL з "золотим кутом" 137.5°, щоб номери, які поряд за
   *  значенням, отримували контрастні відтінки. */
  function _pelColorForUnit(num) {
    const n = Number(num);
    if (!isFinite(n) || n <= 0) return "#6b7280";
    const hue = (n * 137.508) % 360;
    return `hsl(${hue.toFixed(1)}, 70%, 45%)`;
  }

  /** Leaflet-divIcon кольорового кола з номером підрозділу. */
  function _pelBuildUnitIcon(unitNum) {
    const color = _pelColorForUnit(unitNum);
    const txt = String(unitNum || "?");
    return L.divIcon({
      className: "pel-unit-icon",
      html: `<div class="pel-unit-circle" style="background:${color}">${txt}</div>`,
      iconSize:    [34, 34],
      iconAnchor:  [17, 17],
      popupAnchor: [0, -17],
    });
  }

  function _pelFmtDtLocal(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}` +
           `T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function _pelEnsureMap() {
    if (_pelMap) return _pelMap;
    const el = document.getElementById("pelMapDiv");
    if (!el || typeof L === "undefined") return null;
    // Якщо на DOM-елементі лишився Leaflet-маркер від попередньої (можливо
    // неуспішної) спроби ініціалізації — прибрати його, інакше L.map() кине
    // "Map container is already initialized".
    if (el._leaflet_id) {
      try { delete el._leaflet_id; }
      catch (_) { el._leaflet_id = undefined; }
    }
    try {
      // Windows Chrome експонує ontouchstart shim навіть без сенсорного
      // екрана, через що L.Browser.touch=true → Leaflet ставить туман
      // .leaflet-touch-drag/-zoom і використовує touch-only code path,
      // який не приймає mousedown → drag НЕ працює мишкою.
      // Форсуємо desktop-режим на ЦІЙ сторінці: вимикаємо touch-детекцію
      // в L.Browser, плюс tap:false на map-опції.
      try {
        if (window.L && L.Browser) {
          L.Browser.touch  = false;
          L.Browser.mobile = false;
        }
      } catch (_) {}
      _pelMap = L.map(el, {
        center: [48.5, 37.5], zoom: 9, zoomControl: true, tap: false,
      });
      // Google hybrid (lyrs=y) — супутник + підписи населених пунктів,
      // hl=uk фіксує українську локалізацію (той самий тайл-сервіс
      // використовується на вкладці «Висновок» сторінки «Перехоплення»).
      L.tileLayer(
        "https://mt1.google.com/vt/lyrs=y&hl=uk&x={x}&y={y}&z={z}",
        { attribution: "Google", maxZoom: 20 }
      ).addTo(_pelMap);
      _pelMarkerLayer = L.layerGroup().addTo(_pelMap);
      return _pelMap;
    } catch (e) {
      // Якщо init все одно впав — не лишати state у напівінітному стані.
      _pelMap = null;
      _pelMarkerLayer = null;
      console.warn("[peleng] L.map init failed:", e);
      return null;
    }
  }

  /** Генерує (один раз) blob-URL SIDC-іконки антени через milsymbol. */
  function _pelSidcIconUrl() {
    if (_pelSidcUrl) return _pelSidcUrl;
    if (!window.ms) return null;
    try {
      const sym = new ms.Symbol(PEL_ANTENNA_SIDC, { size: 32 });
      const svg = sym.asSVG();
      const blob = new Blob([svg], { type: "image/svg+xml" });
      _pelSidcUrl = URL.createObjectURL(blob);
      return _pelSidcUrl;
    } catch (_) { return null; }
  }

  function _pelBuildIcon() {
    const url = _pelSidcIconUrl();
    if (!url) return null;
    return L.divIcon({
      className: "pel-mapblock-icon",
      html: `<img src="${url}" alt="" width="29" height="29">`,
      iconSize:   [29, 29],
      iconAnchor: [15, 15],
      popupAnchor:[0, -15],
    });
  }

  async function _pelLoadPoints(fromDt, toDt) {
    const qs = new URLSearchParams({ from_dt: fromDt, to_dt: toDt });
    const r = await fetch("/api/peleng/points?" + qs.toString());
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      throw new Error(d.detail || ("HTTP " + r.status));
    }
    return Array.isArray(d.rows) ? d.rows : [];
  }

  function _pelRenderPoints(rows, opts) {
    const skipFit = opts && opts.skipFit;
    _pelLastRows = rows;
    const map = _pelEnsureMap();
    if (!map) return;
    if (!_pelMarkerLayer) _pelMarkerLayer = L.layerGroup().addTo(map);
    _pelMarkerLayer.clearLayers();

    const defaultIcon = _pelBuildIcon();
    const bounds = [];
    let placed = 0;
    for (const r of rows) {
      const raw = String(r.mgrs || "").trim().replace(/\s+/g, "").toUpperCase();
      if (!raw || typeof window.mgrs === "undefined" || !window.mgrs.toPoint) continue;
      try {
        const pt  = window.mgrs.toPoint(raw);
        const lat = Number(pt[1]), lon = Number(pt[0]);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const popup =
          `<div style="min-width:180px">` +
          `<div><b>${escapeHtml(r.frequency || "—")}</b></div>` +
          (r.unit ? `<div>${escapeHtml(r.unit)}</div>` : "") +
          `<div class="small" style="opacity:.7">${escapeHtml(r.event_dt || "")}</div>` +
          `<div class="small" style="opacity:.7">${escapeHtml(r.mgrs || "")}</div>` +
          `</div>`;
        // У режимі «Підрозділ» — кольорове коло з номером бригади/полка
        // з опису р/м. Якщо номер не вдалося розпізнати, falback на дефолтну
        // SIDC-іконку (антена), щоб точку все одно було видно.
        let icon = defaultIcon;
        if (_pelShowUnit) {
          const unitNum = _pelExtractUnitNumber(r.unit);
          if (unitNum) icon = _pelBuildUnitIcon(unitNum);
        }
        const m = icon ? L.marker([lat, lon], { icon }) : L.circleMarker([lat, lon], { radius:6, color:"#ef4444" });
        m.bindPopup(popup);
        // Підпис частоти праворуч (тільки якщо чекбокс «Частоти» увімкнено).
        if (_pelShowFreq && r.frequency) {
          m.bindTooltip(String(r.frequency), {
            permanent: true,
            direction: "right",
            offset: [12, 0],
            className: "pel-freq-label",
          });
        }
        m.addTo(_pelMarkerLayer);
        bounds.push([lat, lon]);
        placed++;
      } catch (_) {}
    }
    const countEl = document.getElementById("pelMapCount");
    if (countEl) countEl.textContent = `Знайдено: ${placed}` + (placed !== rows.length ? ` / ${rows.length}` : "");
    if (skipFit) return placed;
    if (bounds.length === 1) {
      map.setView(bounds[0], Math.max(map.getZoom(), 11));
    } else if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 });
    }
    return placed;
  }

  /* Знімок мапи у Canvas (без overlay-кнопок) + опційно зменшення до 1200px. */
  async function _pelCaptureMapCanvas() {
    const mapDiv = document.getElementById("pelMapDiv");
    if (!mapDiv) return null;
    if (!window.html2canvas) {
      try {
        await new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://html2canvas.hertzen.com/dist/html2canvas.min.js";
          s.onload = resolve; s.onerror = reject;
          document.head.appendChild(s);
        });
      } catch (e) {
        window.reportClientError?.({
          action: "load_html2canvas", category: "network",
          detail: String(e && e.message || e),
        });
        return null;
      }
    }
    if (_pelMap) _pelMap.invalidateSize();
    // Кнопка #pelMapCopyBtn — сусідній елемент до mapDiv (у .pel-mapblock-mapwrap),
    // тому html2canvas її не захоплює, ховати не треба.
    let canvas = null;
    try {
      canvas = await window.html2canvas(mapDiv, { useCORS: true, allowTaint: false, logging: false, imageTimeout: 0 });
    } catch (e) {
      window.reportClientError?.({
        action: "screenshot", category: "screenshot_failed",
        detail: String(e && e.message || e),
      });
    }
    return canvas;
  }

  /** Копіювати знімок мапи у буфер обміну. */
  async function _pelCopyMap() {
    const canvas = await _pelCaptureMapCanvas();
    if (!canvas) { window.appToast?.("Помилка створення скріншоту", "error", 2600); return; }
    try {
      canvas.toBlob(async (blob) => {
        if (!blob) { window.appToast?.("Не вдалося створити зображення", "error"); return; }
        try {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          window.appToast?.("Карту скопійовано!", "success", 1800);
        } catch (e) {
          window.appToast?.("Браузер заблокував копіювання зображення", "error", 2600);
        }
      }, "image/png");
    } catch (_) {
      window.appToast?.("Помилка створення скріншоту", "error", 2600);
    }
  }

  async function _pelApplyPeriod(fromDt, toDt) {
    const btn = document.getElementById("pelMapShowBtn");
    if (btn) { btn.disabled = true; }
    try {
      const rows = await _pelLoadPoints(fromDt, toDt);
      _pelRenderPoints(rows);
      if (!rows.length) showToast("За цей період пеленгів не знайдено");
    } catch (e) {
      if (window.appToast) window.appToast(e.message || "Помилка завантаження", "error", 2400);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ── Send-bar (W/S платформа, chat autocomplete, надіслати) ── */
  function _pelLoadSendChat() {
    try {
      const p = localStorage.getItem(PEL_PLATFORM_KEY); if (p === "whatsapp" || p === "signal") _pelSendPlatform = p;
      const j = JSON.parse(localStorage.getItem(PEL_CHAT_KEY) || "null");
      if (j && j.id) {
        _pelSendChatId = j.id;
        const inp = document.getElementById("pelSendChatInput");
        if (inp) inp.value = j.name || "";
        const hid = document.getElementById("pelSendChatId");
        if (hid) hid.value = j.id;
        const sendBtn = document.getElementById("pelSendBtn");
        if (sendBtn) sendBtn.disabled = false;
      }
    } catch (_) {}
    _pelSyncPlatformUi();
  }

  function _pelSyncPlatformUi() {
    const btn = document.getElementById("pelSendPlatformBtn");
    if (!btn) return;
    if (_pelSendPlatform === "signal") {
      btn.textContent = "S";
      btn.classList.remove("qc-platform-btn--wa");
      btn.classList.add("qc-platform-btn--sg");
      btn.title = "Signal (натисни для WhatsApp)";
    } else {
      btn.textContent = "W";
      btn.classList.add("qc-platform-btn--wa");
      btn.classList.remove("qc-platform-btn--sg");
      btn.title = "WhatsApp (натисни для Signal)";
    }
  }

  async function _pelLoadChats(platform) {
    if (_pelChatsCache[platform]) return _pelChatsCache[platform];
    try {
      const r = await fetch("/api/push/chats?platform=" + platform + "&only_groups=1");
      const d = await r.json();
      if (d && d.ok && Array.isArray(d.chats)) { _pelChatsCache[platform] = d.chats; return d.chats; }
    } catch (_) {}
    return [];
  }

  function _pelRenderChatDrop(chats, query) {
    const drop = document.getElementById("pelSendChatDrop");
    if (!drop) return;
    const q = (query || "").toLowerCase();
    const filtered = q ? chats.filter(c => (c.name || "").toLowerCase().includes(q)) : chats;
    if (!filtered.length) { drop.classList.add("hidden"); drop.innerHTML = ""; return; }
    drop.innerHTML = "";
    filtered.slice(0, 40).forEach(chat => {
      const item = document.createElement("div");
      item.className = "qc-chat-drop-item";
      item.innerHTML =
        `<span>${escapeHtml(chat.name)}</span>` +
        `<span class="qc-chat-drop-item__type">${chat.type === "group" ? "група" : "контакт"}</span>`;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        _pelSendChatId = chat.id;
        const inp = document.getElementById("pelSendChatInput");
        if (inp) inp.value = chat.name || "";
        const hid = document.getElementById("pelSendChatId");
        if (hid) hid.value = chat.id;
        const sendBtn = document.getElementById("pelSendBtn");
        if (sendBtn) sendBtn.disabled = false;
        localStorage.setItem(PEL_CHAT_KEY, JSON.stringify({ id: chat.id, name: chat.name }));
        drop.classList.add("hidden");
      });
      drop.appendChild(item);
    });
    drop.classList.remove("hidden");
  }

  async function _pelCaptureMapBase64() {
    const canvas = await _pelCaptureMapCanvas();
    if (!canvas) return "";
    // Стискаємо до 1200px по ширині для месенджерів (як на Висновку).
    const MAX_W = 1200;
    let out = canvas;
    if (canvas.width > MAX_W) {
      const s = MAX_W / canvas.width;
      out = document.createElement("canvas");
      out.width = MAX_W; out.height = Math.round(canvas.height * s);
      out.getContext("2d").drawImage(canvas, 0, 0, out.width, out.height);
    }
    return out.toDataURL("image/jpeg", 0.82).split(",")[1] || "";
  }

  /** "2026-06-04T07:22" → "07:22 04.06.2026". */
  function _pelFmtDateTime(s) {
    if (!s) return "—";
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return s;
    return `${m[4]}:${m[5]} ${m[3]}.${m[2]}.${m[1]}`;
  }

  /** Українські відмінки для слова «пеленг»:
   *    1, 21, 31 …                → «пеленг»
   *    2-4, 22-24, 32-34 …        → «пеленги»
   *    5-20, 25-30, 35-40 …       → «пеленгів»
   */
  function _pelPluralPeleng(n) {
    const m100 = n % 100;
    if (m100 >= 11 && m100 <= 14) return "пеленгів";
    const m10 = n % 10;
    if (m10 === 1) return "пеленг";
    if (m10 >= 2 && m10 <= 4) return "пеленги";
    return "пеленгів";
  }

  function _pelBuildSendText() {
    const from = document.getElementById("pelMapFromDt")?.value || "";
    const to   = document.getElementById("pelMapToDt")?.value   || "";
    const cntText = document.getElementById("pelMapCount")?.textContent || "";
    const n = parseInt((cntText.match(/\d+/) || ["0"])[0], 10);
    return `Пеленги за період: ${_pelFmtDateTime(from)} — ${_pelFmtDateTime(to)}\nЗроблено ${n} ${_pelPluralPeleng(n)}`;
  }

  function initPelMapBlock() {
    // Default range: now-8h … now (узгоджено з найменшою швидкою кнопкою «8 год»)
    const now = new Date();
    const from = new Date(now.getTime() - 8 * 3600 * 1000);
    const fromEl = document.getElementById("pelMapFromDt");
    const toEl   = document.getElementById("pelMapToDt");
    if (fromEl) fromEl.value = _pelFmtDtLocal(from);
    if (toEl)   toEl.value   = _pelFmtDtLocal(now);

    // Quick buttons: end = найближча РІВНА година попереду (наприклад,
    // 07:22 → 08:00; навіть якщо вже 07:00 точно, беремо 08:00).
    // Start = end - N годин з кнопки.
    document.querySelectorAll(".pel-mapblock-quick-btn").forEach(b => {
      b.addEventListener("click", () => {
        const h = parseInt(b.dataset.hours, 10);
        if (!isFinite(h) || h <= 0) return;
        const end = new Date();
        end.setMinutes(0, 0, 0);
        end.setHours(end.getHours() + 1);
        const start = new Date(end.getTime() - h * 3600 * 1000);
        if (fromEl) fromEl.value = _pelFmtDtLocal(start);
        if (toEl)   toEl.value   = _pelFmtDtLocal(end);
        _pelApplyPeriod(fromEl.value, toEl.value);
      });
    });

    document.getElementById("pelMapShowBtn")?.addEventListener("click", () => {
      _pelApplyPeriod(fromEl?.value || "", toEl?.value || "");
    });

    // Чекбокс «Частоти» — перемальовує наявні маркери без рефетчу.
    const freqChk = document.getElementById("pelShowFreqChk");
    if (freqChk) {
      freqChk.checked = false;
      _pelShowFreq = false;
      freqChk.addEventListener("change", () => {
        _pelShowFreq = freqChk.checked;
        if (_pelLastRows.length) _pelRenderPoints(_pelLastRows, { skipFit: true });
      });
    }

    // Чекбокс «Підрозділ» — замінює дефолтні SIDC-іконки на кольорові
    // кружечки з номером бригади/полка з опису р/м.
    const unitChk = document.getElementById("pelShowUnitChk");
    if (unitChk) {
      unitChk.checked = false;
      _pelShowUnit = false;
      unitChk.addEventListener("change", () => {
        _pelShowUnit = unitChk.checked;
        if (_pelLastRows.length) _pelRenderPoints(_pelLastRows, { skipFit: true });
      });
    }

    // Кнопка «Скопіювати карту» (overlay правий верхній кут).
    document.getElementById("pelMapCopyBtn")?.addEventListener("click", _pelCopyMap);

    // Карта пеленгів — постійно видимий основний контент. Ініціалізуємо
    // тільки коли контейнер отримав свою висоту (захист від випадку,
    // коли L.map(el) зробить broken-map на 0×0 контейнері і dragging
    // не зачепиться за подвійні обчислення розмірів).
    function _pelInitMapWhenReady(retries) {
      retries = retries || 0;
      const el = document.getElementById("pelMapDiv");
      if (!el) return;
      if (el.clientHeight < 100 && retries < 20) {
        setTimeout(() => _pelInitMapWhenReady(retries + 1), 80);
        return;
      }
      const m = _pelEnsureMap();
      if (!m) return;
      m.invalidateSize();
      try {
        if (m.dragging && !m.dragging.enabled()) m.dragging.enable();
        if (m.scrollWheelZoom && !m.scrollWheelZoom.enabled()) m.scrollWheelZoom.enable();
      } catch (_) {}
    }
    setTimeout(_pelInitMapWhenReady, 60);

    // Send-bar
    _pelLoadSendChat();
    document.getElementById("pelSendPlatformBtn")?.addEventListener("click", () => {
      _pelSendPlatform = (_pelSendPlatform === "whatsapp") ? "signal" : "whatsapp";
      try { localStorage.setItem(PEL_PLATFORM_KEY, _pelSendPlatform); } catch(_){}
      // При зміні платформи скинути обраний чат (бо чати різні).
      _pelSendChatId = "";
      const inp = document.getElementById("pelSendChatInput"); if (inp) inp.value = "";
      const hid = document.getElementById("pelSendChatId");    if (hid) hid.value = "";
      const sendBtn = document.getElementById("pelSendBtn");   if (sendBtn) sendBtn.disabled = true;
      _pelSyncPlatformUi();
    });

    const chatInput = document.getElementById("pelSendChatInput");
    const chatDrop  = document.getElementById("pelSendChatDrop");
    if (chatInput && chatDrop) {
      chatInput.addEventListener("focus", async () => {
        const chats = await _pelLoadChats(_pelSendPlatform);
        _pelRenderChatDrop(chats, chatInput.value);
      });
      chatInput.addEventListener("input", async () => {
        _pelSendChatId = "";
        const hid = document.getElementById("pelSendChatId"); if (hid) hid.value = "";
        const sendBtn = document.getElementById("pelSendBtn"); if (sendBtn) sendBtn.disabled = true;
        const chats = await _pelLoadChats(_pelSendPlatform);
        _pelRenderChatDrop(chats, chatInput.value);
      });
      chatInput.addEventListener("blur", () => {
        setTimeout(() => chatDrop.classList.add("hidden"), 180);
      });
    }

    // onclick= (а не addEventListener) — гарантовано один обробник,
    // навіть якщо initPelMapBlock колись викличуть повторно.
    // _pelSending — захист від подвійного fetch у тих рідкісних випадках,
    // коли disabled-атрибут не встигає спрацювати між клікам.
    const sendBtnEl = document.getElementById("pelSendBtn");
    if (sendBtnEl) sendBtnEl.onclick = async (e) => {
      e?.preventDefault?.();
      if (_pelSending) return;
      if (!_pelSendChatId) return;
      _pelSending = true;
      const sendBtn = document.getElementById("pelSendBtn");
      if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = "…"; }
      const t0 = performance.now();
      let image_base64 = "";
      try {
        image_base64 = await _pelCaptureMapBase64();
        const text = _pelBuildSendText();
        const res = await fetch("/api/push/send", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: _pelSendPlatform, chat_id: _pelSendChatId, text, image_base64 }),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok && d.ok) {
          if (window.appToast) window.appToast("Надіслано", "success", 1600);
        } else {
          const errMsg = d.error || d.detail || `HTTP ${res.status}`;
          window.reportClientError?.({
            action: "send", category: res.status >= 500 ? "server_5xx" : (res.status >= 400 ? "server_4xx" : "bad_response"),
            detail: String(errMsg).slice(0, 300),
            extra: { platform: _pelSendPlatform, chat_id: _pelSendChatId, image_size: image_base64.length, http_status: res.status, duration_ms: Math.round(performance.now() - t0) },
          });
          if (window.appToast) window.appToast(errMsg, "error", 2400);
        }
      } catch (err) {
        const msg = String(err && err.message || err);
        window.reportClientError?.({
          action: "send", category: /timeout/i.test(msg) ? "timeout" : "network",
          detail: msg.slice(0, 300),
          extra: { platform: _pelSendPlatform, chat_id: _pelSendChatId, image_size: image_base64.length, duration_ms: Math.round(performance.now() - t0) },
        });
        if (window.appToast) window.appToast(msg, "error", 2400);
      } finally {
        _pelSending = false;
        if (sendBtn) { sendBtn.disabled = !_pelSendChatId; sendBtn.innerHTML = "&#10148;"; }
      }
    };
  }
})();