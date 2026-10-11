/* ============================================================================
 * Модалка оформлення втрат (200/300) — «Втрати 2», Фаза 2.
 * Кнопка «☠» у картці перехоплення → window.openCasualtyModal(msgId, netId, meta).
 * Кожен запис-контейнер автозберігається (lazy create → update) у /api/casualties.
 * Позивні — чіп-інпут з автокомплітом /api/callsigns/autocomplete; прив'язка
 * позивного на бекенді виставляє його life_status (200/300).
 * ==========================================================================*/
(function () {
  "use strict";

  var _msgId = 0, _netId = null, _interceptText = "", _meta = "";
  var _standardText = "";           // перехоплення за стандартним шаблоном (із сервера)
  var _interceptCallsigns = [];   // [{id,name}] — позивні перехоплення (для префілу чіпів)
  var _suggestedUnitId = "";       // автопідбір підрозділу для нових записів
  var _reasons = [];   // [{id,name}]
  var _units = [];     // [{id,name}]

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function toast(m, t) { if (window.appToast) window.appToast(m, t || "info", 1600); }
  function _casPhotoSrc(status) { return "/static/photos/casualties/" + (status === "200" ? "200" : "300") + ".webp?v=2"; }

  // ── Довідники ────────────────────────────────────────────────────────────
  function loadReasons() {
    return fetch("/api/casualty-reasons").then(function (r) { return r.json(); })
      .then(function (d) { _reasons = (d && d.reasons) || []; });
  }
  function loadUnits() {
    return fetch("/api/cas/units").then(function (r) { return r.json(); })
      .then(function (d) { _units = (d && d.units) || []; });
  }
  function _defaultReasonId() {
    var r = (_reasons || []).find(function (x) { return String(x.name).trim().toLowerCase() === "невідомо"; });
    return r ? r.id : "";
  }
  function optionsHtml(list, selId, withEmpty) {
    var head = (withEmpty === false) ? [] : ['<option value="">—</option>'];
    return head.concat(list.map(function (o) {
      return '<option value="' + o.id + '"' +
        (String(o.id) === String(selId) ? " selected" : "") + ">" + esc(o.name) + "</option>";
    })).join("");
  }
  function refreshSelects(sel, list, withEmpty) {
    document.querySelectorAll("#casRecords " + sel).forEach(function (s) {
      s.innerHTML = optionsHtml(list, s.value, withEmpty);
    });
  }

  // ── Відкрити / закрити ─────────────────────────────────────────────────────
  window.openCasualtyModal = function (messageId, networkId, meta, interceptText, callsigns) {
    _msgId = messageId; _netId = networkId || null; _interceptText = interceptText || ""; _meta = meta || ""; _standardText = "";
    // «НВ» — це не позивний (вказівка, що позивний невідомий) → не префілимо.
    _interceptCallsigns = (Array.isArray(callsigns) ? callsigns : []).filter(function (c) {
      return String((c && c.name) || "").trim().toUpperCase() !== "НВ";
    });
    var modal = $("casualtyModal"); if (!modal) return;
    var metaEl = $("casModalMeta"); if (metaEl) metaEl.textContent = meta || "";
    modal.classList.remove("hidden"); modal.removeAttribute("aria-hidden");
    var box = $("casRecords");
    if (box) box.innerHTML = '<div class="cas-loading">Завантаження…</div>';
    Promise.all([
      _reasons.length ? Promise.resolve() : loadReasons(),
      _units.length ? Promise.resolve() : loadUnits(),
    ]).then(function () {
      return fetch("/api/casualties?message_id=" + messageId).then(function (r) { return r.json(); });
    }).then(function (d) {
      _suggestedUnitId = (d && d.suggested_unit_id) || "";
      _standardText = (d && d.standard_text) || "";
      box.innerHTML = "";
      var recs = (d && d.records) || [];
      if (recs.length) recs.forEach(function (rec) { box.appendChild(buildContainer(rec)); });
      else box.appendChild(buildContainer(null));
      _updateSaveAvailability();
      _renderRecentPanel();
    }).catch(function () {
      if (box) box.innerHTML = '<div class="cas-loading">Помилка завантаження</div>';
    });
  };

  function closeModal() {
    var modal = $("casualtyModal"); if (!modal) return;
    modal.classList.add("hidden"); modal.setAttribute("aria-hidden", "true");
    _closeRecentPanel();
  }

  // ── Бокова панель: оформлені втрати в цій р/м за 24 год ─────────────────────
  //   Праворуч від картки модалки (візуально — як панель однойменних у картці
  //   позивного). Інформаційна: контекст/антидубль, без навігації.
  var _recentPanel = null;
  function _ensureRecentPanel() {
    if (_recentPanel) return _recentPanel;
    var p = document.createElement("div");
    p.id = "casRecentPanel";
    p.className = "cs-samename-panel cas-recent-panel hidden";
    p.innerHTML =
      '<div class="cs-samename-head">' +
        '<span class="cs-samename-title">Втрати р/м · 24 год</span>' +
        '<button type="button" class="cs-samename-close" title="Закрити" aria-label="Закрити">✕</button>' +
      "</div>" +
      '<div class="cs-samename-list"></div>';
    document.body.appendChild(p);
    p.querySelector(".cs-samename-close").addEventListener("click", _closeRecentPanel);
    _recentPanel = p;
    return p;
  }
  function _closeRecentPanel() { if (_recentPanel) _recentPanel.classList.add("hidden"); }
  function _positionRecentPanel(p) {
    var modalEl = $("casualtyModal");
    var card = document.querySelector("#casualtyModal .cas-modal__card");
    if (!card) return;
    // z-index — НАД модалкою, інакше повноекранний бекдроп перехоплює кліки/наведення.
    var mz = modalEl ? (parseInt(getComputedStyle(modalEl).zIndex, 10) || 50) : 50;
    p.style.zIndex = String(mz + 5);
    var r = card.getBoundingClientRect();
    var gap = 16, pw = 300;
    var left = r.right + gap;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
    p.style.left = left + "px";
    p.style.right = "auto";
    p.style.top = Math.max(8, r.top) + "px";
    p.style.transform = "none";
    p.style.maxHeight = Math.min(window.innerHeight - 16, Math.max(240, r.height)) + "px";
  }
  function _fmtRecentDt(s) {
    var v = String(s == null ? "" : s).replace("T", " ").trim();
    var m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}:\d{2})/);
    return m ? (m[3] + "." + m[2] + " " + m[4]) : v;
  }
  function _renderRecentPanel() {
    if (!_msgId) return;
    var p = _ensureRecentPanel();
    var list = p.querySelector(".cs-samename-list");
    list.innerHTML = '<div class="cs-samename-empty">Завантаження…</div>';
    p.classList.remove("hidden");
    _positionRecentPanel(p);
    fetch("/api/casualties/by-network?message_id=" + _msgId + "&hours=24")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var recs = (d && d.records) || [];
        if (!recs.length) {
          list.innerHTML = '<div class="cs-samename-empty">Немає оформлених втрат у цій р/м за 24 год.</div>';
          return;
        }
        list.innerHTML = recs.map(function (rec) {
          var st = rec.status === "200" ? "200" : "300";
          var cs = (rec.callsigns || []).map(function (c) { return esc(c.name); }).join(", ");
          var sub = "<b>" + (rec.count || 1) + "×" + st + "</b>" + (rec.reason ? " · " + esc(rec.reason) : "");
          var head = cs || '<span class="cas-recent-nocs">— без позивних —</span>';
          return '<div class="cs-samename-item cas-recent-item">' +
            '<div class="cas-recent-photo-wrap">' +
              '<img class="cs-samename-photo" src="' + _casPhotoSrc(st) + '" alt="">' +
              '<span class="cas-recent-badge cas-recent-badge--' + st + '">' + st + "</span>" +
            "</div>" +
            '<div class="cs-samename-meta">' +
              '<div class="cs-samename-freq">' + head + "</div>" +
              '<div class="cas-recent-sub">' + sub + "</div>" +
              '<div class="cs-samename-unit">' + esc(_fmtRecentDt(rec.msg_dt)) + "</div>" +
            "</div></div>";
        }).join("");
      })
      .catch(function () { list.innerHTML = '<div class="cs-samename-empty">Помилка завантаження.</div>'; });
  }
  window.addEventListener("resize", function () {
    if (_recentPanel && !_recentPanel.classList.contains("hidden")) _positionRecentPanel(_recentPanel);
  });

  // ── Запис-контейнер ────────────────────────────────────────────────────────

  function buildContainer(rec) {
    var el = document.createElement("div");
    el.className = "cas-rec";
    el.__casId = rec ? rec.id : null;
    // Існуючий запис — його позивні; новий — ПОРОЖНЬО (оператор додає вручну).
    el.__callsigns = rec && rec.callsigns ? rec.callsigns.slice() : [];
    var status = rec ? rec.status : "300";
    var count = rec ? rec.count : 1;
    el.dataset.status = status;   // статус зберігаємо на самому записі (кнопки немає)

    // Панель перехоплення (кнопка «око»): шапка (дата/частота/мережа), клікабельні
    // позивні (клік → у поле «Позивні»), порожній рядок, текст діалогу.
    var _metaHtml = (_meta ? _meta.split(/\s*·\s*/).filter(Boolean) : [])
      .map(function (s) { return '<div>' + esc(s) + '</div>'; }).join("");
    var _csHtml = (_interceptCallsigns || []).map(function (c) {
      return '<button type="button" class="cas-it-cs" data-id="' + c.id + '" data-name="' +
        esc(c.name) + '" title="Додати в «Позивні»">' + esc(c.name) + '</button>';
    }).join("");

    el.innerHTML =
      '<div class="cas-rec__top">' +
        '<div class="cas-rec__photo-col">' +
          '<img class="cas-rec__photo" src="' + _casPhotoSrc(status) + '" alt="" ' +
          'title="Клікніть, щоб змінити статус 200 ⇄ 300">' +
          '<span class="cas-rec__photo-badge cas-rec__photo-badge--' + status + '">' + status + '</span>' +
        '</div>' +
        '<div class="cas-rec__fields">' +
          '<div class="cas-rec__row1">' +
            '<input type="number" class="cas-count" min="1" step="1" value="' + (count || 1) + '">' +
            '<label class="cas-chk cas-chk--inline"><input type="checkbox" class="cas-accounted"' + (rec && rec.accounted ? " checked" : "") + '><span>Враховано</span></label>' +
            '<span class="cas-rec__saved"></span>' +
            '<button type="button" class="cas-eye" title="Показати/сховати перехоплення">👁</button>' +
            '<button type="button" class="cas-del" title="Видалити запис">🗑</button>' +
          "</div>" +
          '<label class="cas-fld"><span>Причина</span>' +
            '<span class="cas-select-wrap"><select class="cas-reason">' + optionsHtml(_reasons, rec ? rec.reason_id : _defaultReasonId(), false) + "</select>" +
            '<button type="button" class="cas-add-opt" data-kind="reason" title="Додати причину">＋</button></span></label>' +
          '<label class="cas-fld"><span>Підрозділ</span>' +
            '<span class="cas-select-wrap"><select class="cas-unit">' + optionsHtml(_units, rec ? rec.unit_id : _suggestedUnitId) + "</select>" +
            '<button type="button" class="cas-add-opt" data-kind="unit" title="Додати підрозділ">＋</button>' +
            '<button type="button" class="cas-manage-opt" data-kind="unit" title="Керувати підрозділами (додати/видалити)">⚙</button></span></label>' +
        "</div>" +
      "</div>" +
      '<div class="cas-fld"><span>Позивні</span><div class="cas-cs-wrap"><div class="cas-cs-chips"></div>' +
        '<input type="text" class="cas-cs-input" placeholder="позивний + Enter" autocomplete="off">' +
        '<button type="button" class="cas-cs-clear" title="Очистити всі позивні" style="display:none">✕</button></div></div>' +
      // Перехоплення (за шаблоном контейнера) — показується кнопкою «око».
      '<div class="cas-intercept hidden">' +
        (_metaHtml ? '<div class="cas-intercept__meta">' + _metaHtml + '</div>' : '') +
        (_csHtml ? '<div class="cas-intercept__cs">' + _csHtml + '</div>' : '') +
        '<div class="cas-intercept__text">' + esc(_interceptText) + '</div>' +
      '</div>';

    // Клік по фото = зміна статусу 200 ⇄ 300.
    el.querySelector(".cas-rec__photo").addEventListener("click", function () {
      var ns = el.dataset.status === "200" ? "300" : "200";
      el.dataset.status = ns;
      this.src = _casPhotoSrc(ns);
      var badge = el.querySelector(".cas-rec__photo-badge");
      if (badge) { badge.textContent = ns; badge.className = "cas-rec__photo-badge cas-rec__photo-badge--" + ns; }
      scheduleSave(el);
    });
    el.querySelector(".cas-count").addEventListener("input", function () { scheduleSave(el); });
    el.querySelector(".cas-reason").addEventListener("change", function () { scheduleSave(el); });
    el.querySelector(".cas-unit").addEventListener("change", function () { scheduleSave(el); });
    el.querySelector(".cas-accounted").addEventListener("change", function () { scheduleSave(el); });
    el.querySelectorAll(".cas-add-opt").forEach(function (b) {
      b.addEventListener("click", function () { addOption(el, b.dataset.kind); });
    });
    el.querySelectorAll(".cas-manage-opt").forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); openUnitManager(b); });
    });
    el.querySelector(".cas-del").addEventListener("click", function () { deleteContainer(el); });
    // Око — показати/сховати текст перехоплення (щоб звірити поля).
    var _eye = el.querySelector(".cas-eye"), _itp = el.querySelector(".cas-intercept");
    if (_eye && _itp) _eye.addEventListener("click", function () {
      var nowHidden = _itp.classList.toggle("hidden");
      _eye.classList.toggle("cas-eye--on", !nowHidden);
    });
    // Клік по позивному в шапці перехоплення → додати його в поле «Позивні».
    el.querySelectorAll(".cas-it-cs").forEach(function (b) {
      b.addEventListener("click", function () {
        _addChip(el, { id: Number(b.dataset.id), name: b.dataset.name });
        b.classList.add("cas-it-cs--added");
      });
    });
    // Хрестик у полі позивних — видаляє ВСІ позивні одним кліком.
    el.querySelector(".cas-cs-clear").addEventListener("click", function () {
      el.__callsigns = []; renderChips(el); scheduleSave(el);
      var inp = el.querySelector(".cas-cs-input"); if (inp) inp.focus();
    });

    renderChips(el);
    _wireCsInput(el);
    if (rec) _setSaved(el, "saved");
    return el;
  }

  // ── Позивні: чіпи + автокомпліт ────────────────────────────────────────────
  function renderChips(el) {
    var box = el.querySelector(".cas-cs-chips");
    box.innerHTML = (el.__callsigns || []).map(function (c, i) {
      return '<span class="cas-chip">' + esc(c.name) +
        '<button type="button" class="cas-chip-x" data-idx="' + i + '">×</button></span>';
    }).join("");
    box.querySelectorAll(".cas-chip-x").forEach(function (x) {
      x.addEventListener("click", function () {
        el.__callsigns.splice(Number(x.dataset.idx), 1); renderChips(el); scheduleSave(el);
      });
    });
    var clr = el.querySelector(".cas-cs-clear");
    if (clr) clr.style.display = (el.__callsigns && el.__callsigns.length) ? "" : "none";
  }
  function _addChip(el, item) {
    el.__callsigns = el.__callsigns || [];
    if (el.__callsigns.some(function (c) { return c.id === item.id; })) return;
    el.__callsigns.push({ id: item.id, name: item.name });
    renderChips(el); scheduleSave(el);
  }
  function _wireCsInput(el) {
    var input = el.querySelector(".cas-cs-input");
    var wrap = el.querySelector(".cas-cs-wrap");
    var acBox = null, acSeq = 0, acItems = [];
    // Список-підказку кріпимо до <body> з position:fixed, інакше overflow модалки
    // (тіло має overflow-y:auto, картка — overflow:hidden) обрізає його, бо поле
    // «Позивні» — останнє в контейнері.
    function closeAc() {
      if (acBox) { acBox.remove(); acBox = null; }
      acItems = [];
      window.removeEventListener("scroll", _onScroll, true);
      window.removeEventListener("resize", closeAc);
    }
    function _choose(i) {
      var it = acItems[i]; if (!it) return;
      _addChip(el, it); input.value = ""; closeAc(); input.focus();
    }
    function _position() {
      if (!acBox) return;
      var r = wrap.getBoundingClientRect();
      var below = window.innerHeight - r.bottom;
      acBox.style.left = r.left + "px";
      acBox.style.width = r.width + "px";
      // Розкриваємо вниз, якщо вистачає місця; інакше — вгору над полем.
      if (below >= 180 || below >= r.top) {
        acBox.style.top = (r.bottom + 2) + "px";
        acBox.style.bottom = "auto";
        acBox.style.maxHeight = Math.max(80, Math.min(220, below - 8)) + "px";
      } else {
        acBox.style.top = "auto";
        acBox.style.bottom = (window.innerHeight - r.top + 2) + "px";
        acBox.style.maxHeight = Math.max(80, Math.min(220, r.top - 8)) + "px";
      }
    }
    function _onScroll() { closeAc(); }
    input.addEventListener("input", function () {
      var v = input.value.trim();
      if (v.length < 2) { closeAc(); return; }
      var seq = ++acSeq;
      var url = "/api/callsigns/autocomplete?q=" + encodeURIComponent(v) + (_netId ? ("&network_id=" + _netId) : "");
      fetch(url).then(function (r) { return r.json(); }).then(function (d) {
        if (seq !== acSeq) return;
        closeAc();
        acItems = (d && d.items) || [];
        if (!acItems.length) return;
        acBox = document.createElement("div"); acBox.className = "cas-cs-ac";
        acBox.innerHTML = acItems.map(function (it, i) {
          return '<button type="button" data-i="' + i + '">' + esc(it.name) + "</button>";
        }).join("");
        acBox.querySelectorAll("button").forEach(function (b) {
          // mousedown + preventDefault — щоб інпут не втрачав фокус (blur → closeAc)
          // раніше, ніж спрацює вибір.
          b.addEventListener("mousedown", function (ev) { ev.preventDefault(); _choose(Number(b.dataset.i)); });
        });
        document.body.appendChild(acBox);
        _position();
        window.addEventListener("scroll", _onScroll, true);
        window.addEventListener("resize", closeAc);
      }).catch(closeAc);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeAc(); return; }
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (acItems.length) { _choose(0); return; }
      // Немає збігу в автокомпліті → створюємо новий позивний (get-or-create),
      // як у полях позивних перехоплення: «назва + Enter».
      var v = input.value.trim();
      if (v.length < 2) return;
      fetch("/api/callsigns/get-or-create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: v, network_id: _netId || null }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d && d.ok && d.id) {
          _addChip(el, { id: d.id, name: d.name });
          input.value = ""; closeAc(); input.focus();
        } else if (window.appToast) {
          window.appToast((d && d.error) || "Не вдалося створити позивний", "error", 2200);
        }
      }).catch(function () {
        if (window.appToast) window.appToast("Помилка створення позивного", "error", 2200);
      });
    });
    input.addEventListener("blur", function () { setTimeout(closeAc, 150); });
  }

  // ── Автозбереження ─────────────────────────────────────────────────────────
  function _payload(el) {
    var reason = el.querySelector(".cas-reason").value;
    var unit = el.querySelector(".cas-unit").value;
    return {
      status: el.dataset.status,
      count: Math.max(1, parseInt(el.querySelector(".cas-count").value, 10) || 1),
      reason_id: reason ? parseInt(reason, 10) : null,
      unit_id: unit ? parseInt(unit, 10) : null,
      accounted: el.querySelector(".cas-accounted").checked,
      callsign_ids: (el.__callsigns || []).map(function (c) { return c.id; }),
    };
  }
  function _setSaved(el, state) {
    var s = el.querySelector(".cas-rec__saved");
    if (!s) return;
    s.className = "cas-rec__saved cas-rec__saved--" + state;
    s.textContent = state === "saving" ? "…" : (state === "saved" ? "✓" : (state === "error" ? "!" : "•"));
    s.title = { saving: "Збереження…", saved: "Збережено", error: "Помилка збереження", dirty: "Незбережено" }[state] || "";
  }
  function _notifyChanged() {
    try { document.dispatchEvent(new CustomEvent("casualtiesChanged", { detail: { message_id: _msgId } })); } catch (_) {}
  }
  function scheduleSave(el) {
    // БЕЗ автозбереження: редагування полів лише позначає запис як «незбережений».
    // У БД запис про втрати потрапляє ВИКЛЮЧНО по нижніх кнопках «Зберегти» (💾)
    // та «Гори у пеклі» (🔥) — див. _casSaveOnly / _casSendAndBurn.
    clearTimeout(el.__saveTimer);
    _setSaved(el, "dirty");
  }
  // applyStatus=true → бекенд виставить life_status привʼязаним позивним
  // (робимо це лише на «Надіслати»). Повертає Promise<bool ok>.
  function saveContainer(el, applyStatus) {
    var body = _payload(el);
    body.apply_status = !!applyStatus;
    _setSaved(el, "saving");
    if (el.__casId) {
      return fetch("/api/casualties/" + el.__casId, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }).then(function (r) { return r.json(); })
        .then(function (d) { var ok = !!(d && d.ok); _setSaved(el, ok ? "saved" : "error"); if (ok) _notifyChanged(); return ok; })
        .catch(function () { _setSaved(el, "error"); return false; });
    }
    body.message_id = _msgId;
    return fetch("/api/casualties", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.record) { el.__casId = d.record.id; _setSaved(el, "saved"); _notifyChanged(); return true; }
        _setSaved(el, "error"); return false;
      }).catch(function () { _setSaved(el, "error"); return false; });
  }
  function deleteContainer(el) {
    if (el.__casId) {
      if (!confirm("Видалити цей запис втрат?")) return;
      fetch("/api/casualties/" + el.__casId, { method: "DELETE" })
        .then(function () { el.remove(); _updateSaveAvailability(); _notifyChanged(); })
        .catch(function () { toast("Помилка видалення", "error"); });
    } else {
      el.remove(); _updateSaveAvailability();
    }
  }
  // Немає жодного контейнера → збереження/надсилання недоступні.
  function _updateSaveAvailability() {
    var n = document.querySelectorAll("#casRecords .cas-rec").length;
    var send = $("casSendBtn"), save = $("casSaveBtn");
    if (send) send.disabled = (n === 0);
    if (save) save.disabled = (n === 0);
  }
  function addOption(el, kind) {
    var name = (prompt(kind === "reason" ? "Нова причина:" : "Новий підрозділ:") || "").trim();
    if (!name) return;
    var url = kind === "reason" ? "/api/casualty-reasons" : "/api/cas/units";
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d || !d.ok) { toast("Не вдалося додати", "error"); return; }
        if (kind === "reason") { _reasons.push({ id: d.id, name: name }); refreshSelects(".cas-reason", _reasons, false); el.querySelector(".cas-reason").value = d.id; }
        else { _units.push({ id: d.id, name: name }); refreshSelects(".cas-unit", _units); el.querySelector(".cas-unit").value = d.id; }
        scheduleSave(el);
      }).catch(function () { toast("Помилка", "error"); });
  }

  // ── Менеджер підрозділів (додати/видалити) — спільна плавуча панель.
  //    Дзеркало керування групами в картці р/м (класи lm-type-manage-*).
  var _unitMgr = null;
  function _buildUnitManager() {
    if (_unitMgr) return _unitMgr;
    var panel = document.createElement("div");
    panel.className = "lm-type-manage-panel cas-unit-mgr hidden";
    panel.style.cssText = "position:fixed; z-index:100001; width:320px; max-width:92vw;";
    panel.innerHTML =
      '<div class="lm-type-manage-add">' +
        '<input type="text" class="cas-umgr-name" placeholder="Назва нового підрозділу…" autocomplete="off" maxlength="120">' +
        '<button type="button" class="lm-type-manage-add-btn cas-umgr-add" title="Додати">+</button>' +
      '</div>' +
      '<div class="lm-type-manage-list cas-umgr-list"></div>' +
      '<div class="small lm-type-manage-err cas-umgr-err" style="display:none"></div>';
    document.body.appendChild(panel);
    var nameInp = panel.querySelector(".cas-umgr-name");
    var listEl  = panel.querySelector(".cas-umgr-list");
    var errEl   = panel.querySelector(".cas-umgr-err");
    function showErr(m) { errEl.textContent = m || ""; errEl.style.display = m ? "block" : "none"; }
    function render() {
      listEl.innerHTML = "";
      _units.forEach(function (u) {
        var row = document.createElement("div");
        row.className = "lm-type-manage-row";
        row.innerHTML =
          '<span>' + esc(u.name) + '</span>' +
          '<span style="display:flex;align-items:center">' +
            '<button type="button" class="lm-type-manage-del-btn" data-id="' + u.id + '" title="Видалити підрозділ">✕</button>' +
          '</span>';
        listEl.appendChild(row);
      });
      listEl.querySelectorAll(".lm-type-manage-del-btn").forEach(function (b) {
        b.addEventListener("click", function () { onDelete(Number(b.dataset.id)); });
      });
      if (!_units.length) listEl.innerHTML = '<div class="small" style="opacity:.6;padding:6px">Список порожній</div>';
    }
    function onAdd() {
      var name = (nameInp.value || "").trim();
      if (!name) return;
      showErr("");
      fetch("/api/cas/units", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name }) })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d || !d.ok) { showErr((d && d.error) || "Не вдалося додати"); return; }
          _units.push({ id: d.id, name: name });
          nameInp.value = "";
          refreshSelects(".cas-unit", _units);
          render();
          toast("Підрозділ додано: " + name, "success");
        }).catch(function () { showErr("Помилка додавання"); });
    }
    function onDelete(id) {
      var u = null, i;
      for (i = 0; i < _units.length; i++) { if (_units[i].id === id) { u = _units[i]; break; } }
      var nm = u ? u.name : "";
      if (!confirm("Видалити підрозділ «" + nm + "»?\nПовʼязані записи втрат цього підрозділу також буде видалено.")) return;
      showErr("");
      fetch("/api/cas/units/" + id, { method: "DELETE" })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d || !d.ok) { showErr((d && d.error) || "Не вдалося видалити"); return; }
          _units = _units.filter(function (x) { return x.id !== id; });
          refreshSelects(".cas-unit", _units);
          render();
          toast("Підрозділ видалено", "success");
        }).catch(function () { showErr("Помилка видалення"); });
    }
    panel.querySelector(".cas-umgr-add").addEventListener("click", onAdd);
    nameInp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); onAdd(); } });
    _unitMgr = { panel: panel, render: render, showErr: showErr };
    return _unitMgr;
  }
  function openUnitManager(btn) {
    var m = _buildUnitManager();
    m.showErr(""); m.render();
    var p = m.panel;
    p.classList.remove("hidden");
    var r = btn.getBoundingClientRect();
    var left = Math.min(r.left, window.innerWidth - p.offsetWidth - 8);
    var top  = Math.min(r.bottom + 6, window.innerHeight - p.offsetHeight - 8);
    p.style.left = Math.max(8, left) + "px";
    p.style.top  = Math.max(8, top) + "px";
    var inp = p.querySelector(".cas-umgr-name"); if (inp) setTimeout(function () { inp.focus(); }, 0);
  }
  // Клік поза панеллю — закрити.
  document.addEventListener("click", function (e) {
    if (!_unitMgr || _unitMgr.panel.classList.contains("hidden")) return;
    if (_unitMgr.panel.contains(e.target)) return;
    if (e.target.closest && e.target.closest(".cas-manage-opt")) return;
    _unitMgr.panel.classList.add("hidden");
  });

  // ── Надсилання у чат (окрема ціль від «Цікаво») ────────────────────────────
  var LS_CAS_CHAT = "casSendChat_v1";
  var CAS_PLATFORMS = [
    { id: "signal", label: "S", color: "#3a76f0" },
    { id: "whatsapp", label: "W", color: "#16a34a" },
  ];
  var _casChat = (function () {
    try { var s = localStorage.getItem(LS_CAS_CHAT); return s ? JSON.parse(s) : null; } catch (_) { return null; }
  })();
  var _casChatsCache = {};
  var _casPickPlatform = (_casChat && _casChat.platform) || "signal";
  var _casPickPending = null;

  function _casLoadChats(platform) {
    // Кешуємо ЛИШЕ непорожній список. Інакше тимчасовий збій транспорту WhatsApp
    // (getChats повертає []) залипав би в кеші до перезавантаження сторінки.
    if (_casChatsCache[platform] && _casChatsCache[platform].length) return Promise.resolve(_casChatsCache[platform]);
    return fetch("/api/push/chats?platform=" + platform + "&only_groups=0")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var list = (d && d.ok && Array.isArray(d.chats)) ? d.chats : [];
        if (list.length) _casChatsCache[platform] = list;   // не кешувати порожнє
        return list;
      }).catch(function () { return []; });
  }

  // Відправка 1 — перехоплення за стандартним шаблоном (дата/маска|частота/мережа/
  // позивні/порожній рядок/діалог), як його формує сервер (кнопка «Копіювати»).
  function _casBuildInterceptMsg() {
    if (_standardText && _standardText.trim()) return _standardText.replace(/\s+$/, "");
    // Фолбек, якщо стандартний текст не прийшов із сервера.
    var lines = [];
    var meta = ($("casModalMeta").textContent || "").trim();
    if (meta) lines.push(meta);
    if (_interceptText) lines.push("", _interceptText.trim());
    return lines.join("\n").trim();
  }
  // Відправка 2 — записи: «[кількість] - [статус] - ([позивні]), причина: [причина]».
  // Дужки з позивними — лише коли позивні є.
  function _casBuildRecordsMsg() {
    var recLines = [];
    document.querySelectorAll("#casRecords .cas-rec").forEach(function (el) {
      var status = el.dataset.status;
      var count = Math.max(1, parseInt(el.querySelector(".cas-count").value, 10) || 1);
      var rSel = el.querySelector(".cas-reason");
      var reason = rSel.value ? rSel.options[rSel.selectedIndex].text : "";
      var cs = (el.__callsigns || []).map(function (c) { return c.name; });
      var tail = "";
      if (cs.length) {
        tail = "(" + cs.join(", ") + ")";
        if (reason) tail += ", причина: " + reason;
      } else if (reason) {
        tail = "причина: " + reason;
      }
      var line = count + " - " + status + (tail ? " - " + tail : "");
      // Позначка «(врахований)» — якщо оператор виставив чекбокс «Враховано».
      if (el.querySelector(".cas-accounted") && el.querySelector(".cas-accounted").checked) {
        line += " (врахований)";
      }
      recLines.push(line);
    });
    return recLines.join("\n").trim();
  }

  function _casPost(text) {
    return fetch("/api/push/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: _casChat.platform, chat_id: _casChat.id, text: text }),
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) { return !!(d && d.ok); });
  }

  // «Зберегти» — те саме, що «Гори у пеклі», але БЕЗ надсилання в чат:
  // фіксуємо всі записи із застосуванням статусів позивних (200/300).
  function _casSaveOnly() {
    var recs = Array.prototype.slice.call(document.querySelectorAll("#casRecords .cas-rec"));
    if (!recs.length) { toast("Немає даних для збереження", "warn"); return; }
    var btn = $("casSaveBtn");
    if (btn) { btn.disabled = true; btn.classList.add("is-busy"); }
    Promise.all(recs.map(function (el) { return saveContainer(el, true); })).then(function (oks) {
      if (btn) { btn.disabled = false; btn.classList.remove("is-busy"); }
      var ok = oks.every(Boolean);
      toast(ok ? "Збережено" : "Помилка збереження", ok ? "success" : "error");
    });
  }

  function _casSend() {
    if (!_casChat || !_casChat.id) {
      _casOpenPicker();
      toast("Спершу вкажіть чат (Ctrl+клік по кнопці)", "warn");
      return;
    }
    var payloads = [];
    var msg1 = _casBuildInterceptMsg(); if (msg1) payloads.push(msg1);
    var msg2 = _casBuildRecordsMsg();  if (msg2) payloads.push(msg2);
    if (!payloads.length) { toast("Немає даних для надсилання", "warn"); return; }
    var btn = $("casSendBtn");
    if (btn) { btn.disabled = true; btn.classList.add("is-busy"); }
    // Спершу зафіксувати всі записи із застосуванням статусів позивних (200/300),
    // потім послідовно надіслати два повідомлення (спершу перехоплення, тоді записи).
    var recs = Array.prototype.slice.call(document.querySelectorAll("#casRecords .cas-rec"));
    Promise.all(recs.map(function (el) { return saveContainer(el, true); })).then(function () {
      (function next(i, okAll) {
        if (i >= payloads.length) {
          if (btn) { btn.disabled = false; btn.classList.remove("is-busy"); }
          toast(okAll ? ("Надіслано → " + _casChat.name) : "Помилка надсилання", okAll ? "success" : "error");
          return;
        }
        _casPost(payloads[i]).then(function (ok) { next(i + 1, okAll && ok); })
          .catch(function () { next(i + 1, false); });
      })(0, true);
    });
  }

  // ── Пікер цільового чату (динамічна панель у футері) ────────────────────────
  function _casClosePicker() { var p = $("casSendPicker"); if (p) p.remove(); }
  function _casRenderDrop(pk, query) {
    var drop = pk.querySelector(".cas-pick-drop");
    drop.classList.remove("hidden");
    drop.innerHTML = '<div class="cas-pick-empty">Завантаження…</div>';
    _casLoadChats(_casPickPlatform).then(function (chats) {
      var q = (query || "").trim().toLowerCase();
      var filtered = chats.filter(function (c) { return c && c.name; })
        .filter(function (c) { return !q || String(c.name).toLowerCase().indexOf(q) >= 0; }).slice(0, 40);
      if (!filtered.length) { drop.innerHTML = '<div class="cas-pick-empty">Чатів не знайдено</div>'; return; }
      drop.innerHTML = "";
      filtered.forEach(function (chat) {
        var it = document.createElement("div");
        it.className = "cas-pick-item"; it.textContent = chat.name;
        it.addEventListener("mousedown", function (e) {
          e.preventDefault();
          _casPickPending = { id: chat.id, name: chat.name };
          pk.querySelector(".cas-pick-input").value = chat.name;
          pk.querySelector(".cas-pick-ok").disabled = false;
          drop.classList.add("hidden");
        });
        drop.appendChild(it);
      });
    });
  }
  function _casOpenPicker() {
    _casClosePicker();
    _casPickPlatform = (_casChat && _casChat.platform) || "signal";
    _casPickPending = _casChat ? { id: _casChat.id, name: _casChat.name } : null;
    var pinfo = CAS_PLATFORMS.find(function (p) { return p.id === _casPickPlatform; }) || CAS_PLATFORMS[0];
    var pk = document.createElement("div");
    pk.id = "casSendPicker"; pk.className = "cas-send-picker";
    pk.innerHTML =
      '<button type="button" class="cas-pick-platform" style="background:' + pinfo.color + '">' + pinfo.label + "</button>" +
      '<div class="cas-pick-inwrap"><input type="text" class="cas-pick-input" placeholder="чат…" autocomplete="off" value="' + esc(_casChat ? _casChat.name : "") + '">' +
      '<div class="cas-pick-drop hidden"></div></div>' +
      '<button type="button" class="cas-pick-ok"' + (_casPickPending ? "" : " disabled") + ">ОК</button>";
    var foot = document.querySelector("#casualtyModal .cas-modal__foot");
    if (foot) foot.appendChild(pk);

    pk.querySelector(".cas-pick-platform").addEventListener("click", function () {
      var idx = CAS_PLATFORMS.findIndex(function (p) { return p.id === _casPickPlatform; });
      var next = CAS_PLATFORMS[(idx + 1) % CAS_PLATFORMS.length];
      _casPickPlatform = next.id; _casPickPending = null;
      var b = pk.querySelector(".cas-pick-platform"); b.textContent = next.label; b.style.background = next.color;
      pk.querySelector(".cas-pick-input").value = "";
      pk.querySelector(".cas-pick-ok").disabled = true;
    });
    var inp = pk.querySelector(".cas-pick-input");
    inp.addEventListener("focus", function () { _casRenderDrop(pk, inp.value); });
    inp.addEventListener("input", function () { _casRenderDrop(pk, inp.value); });
    pk.querySelector(".cas-pick-ok").addEventListener("click", function () {
      if (!_casPickPending) return;
      _casChat = { platform: _casPickPlatform, id: _casPickPending.id, name: _casPickPending.name };
      try { localStorage.setItem(LS_CAS_CHAT, JSON.stringify(_casChat)); } catch (_) {}
      _casClosePicker();
      toast("Чат втрат: " + _casChat.name, "success");
    });
    setTimeout(function () { inp.focus(); }, 0);
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    var modal = $("casualtyModal"); if (!modal) return;
    modal.querySelectorAll("[data-cas-close]").forEach(function (b) {
      b.addEventListener("click", closeModal);
    });
    var add = $("casAddBtn");
    if (add) add.addEventListener("click", function () {
      var box = $("casRecords"); if (box) { box.appendChild(buildContainer(null)); _updateSaveAvailability(); }
    });
    var send = $("casSendBtn");
    if (send) send.addEventListener("click", function (e) {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); _casOpenPicker(); }
      else _casSend();
    });
    var save = $("casSaveBtn");
    if (save) save.addEventListener("click", _casSaveOnly);
    // Закриття пікера при кліку поза ним — на mousedown (інакше вибір пункту
    // списку ховає його, і подальший click потрапляє поза пікером → закриття
    // до натискання «ОК»).
    document.addEventListener("mousedown", function (e) {
      var pk = $("casSendPicker"); if (!pk) return;
      if (pk.contains(e.target) || (send && send.contains(e.target))) return;
      _casClosePicker();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if ($("casSendPicker")) { _casClosePicker(); return; }
      if (!modal.classList.contains("hidden")) closeModal();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
