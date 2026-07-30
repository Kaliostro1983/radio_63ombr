/* ============================================================================
 * Модалка оформлення втрат (200/300) — «Втрати 2», Фаза 2.
 * Кнопка «☠» у картці перехоплення → window.openCasualtyModal(msgId, netId, meta).
 * Кожен запис-контейнер автозберігається (lazy create → update) у /api/casualties.
 * Позивні — чіп-інпут з автокомплітом /api/callsigns/autocomplete; прив'язка
 * позивного на бекенді виставляє його life_status (200/300).
 * ==========================================================================*/
(function () {
  "use strict";

  var _msgId = 0, _netId = null, _interceptText = "";
  var _reasons = [];   // [{id,name}]
  var _units = [];     // [{id,name}]

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function toast(m, t) { if (window.appToast) window.appToast(m, t || "info", 1600); }

  // ── Довідники ────────────────────────────────────────────────────────────
  function loadReasons() {
    return fetch("/api/casualty-reasons").then(function (r) { return r.json(); })
      .then(function (d) { _reasons = (d && d.reasons) || []; });
  }
  function loadUnits() {
    return fetch("/api/cas/units").then(function (r) { return r.json(); })
      .then(function (d) { _units = (d && d.units) || []; });
  }
  function optionsHtml(list, selId) {
    return ['<option value="">—</option>'].concat(list.map(function (o) {
      return '<option value="' + o.id + '"' +
        (String(o.id) === String(selId) ? " selected" : "") + ">" + esc(o.name) + "</option>";
    })).join("");
  }
  function refreshSelects(sel, list) {
    document.querySelectorAll("#casRecords " + sel).forEach(function (s) {
      s.innerHTML = optionsHtml(list, s.value);
    });
  }

  // ── Відкрити / закрити ─────────────────────────────────────────────────────
  window.openCasualtyModal = function (messageId, networkId, meta, interceptText) {
    _msgId = messageId; _netId = networkId || null; _interceptText = interceptText || "";
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
      box.innerHTML = "";
      var recs = (d && d.records) || [];
      if (recs.length) recs.forEach(function (rec) { box.appendChild(buildContainer(rec)); });
      else box.appendChild(buildContainer(null));
    }).catch(function () {
      if (box) box.innerHTML = '<div class="cas-loading">Помилка завантаження</div>';
    });
  };

  function closeModal() {
    var modal = $("casualtyModal"); if (!modal) return;
    modal.classList.add("hidden"); modal.setAttribute("aria-hidden", "true");
  }

  // ── Запис-контейнер ────────────────────────────────────────────────────────
  function _applyStatusClass(st) {
    st.classList.toggle("is-200", st.dataset.status === "200");
    st.classList.toggle("is-300", st.dataset.status === "300");
  }

  function buildContainer(rec) {
    var el = document.createElement("div");
    el.className = "cas-rec";
    el.__casId = rec ? rec.id : null;
    el.__callsigns = rec && rec.callsigns ? rec.callsigns.slice() : [];
    var status = rec ? rec.status : "300";
    var count = rec ? rec.count : 1;

    el.innerHTML =
      '<div class="cas-rec__row1">' +
        '<button type="button" class="cas-status" data-status="' + status + '">' + status + "</button>" +
        '<input type="number" class="cas-count" min="1" step="1" value="' + (count || 1) + '">' +
        '<span class="cas-rec__saved"></span>' +
        '<button type="button" class="cas-del" title="Видалити запис">✕</button>' +
      "</div>" +
      '<label class="cas-fld"><span>Причина</span>' +
        '<span class="cas-select-wrap"><select class="cas-reason">' + optionsHtml(_reasons, rec ? rec.reason_id : "") + "</select>" +
        '<button type="button" class="cas-add-opt" data-kind="reason" title="Додати причину">＋</button></span></label>' +
      '<label class="cas-fld"><span>Підрозділ</span>' +
        '<span class="cas-select-wrap"><select class="cas-unit">' + optionsHtml(_units, rec ? rec.unit_id : "") + "</select>" +
        '<button type="button" class="cas-add-opt" data-kind="unit" title="Додати підрозділ">＋</button></span></label>' +
      '<label class="cas-chk"><input type="checkbox" class="cas-accounted"' + (rec && rec.accounted ? " checked" : "") + '><span>Враховано</span></label>' +
      '<div class="cas-fld"><span>Позивні</span><div class="cas-cs-wrap"><div class="cas-cs-chips"></div>' +
        '<input type="text" class="cas-cs-input" placeholder="позивний + Enter" autocomplete="off"></div></div>';

    var st = el.querySelector(".cas-status");
    _applyStatusClass(st);
    st.addEventListener("click", function () {
      var ns = st.dataset.status === "200" ? "300" : "200";
      st.dataset.status = ns; st.textContent = ns; _applyStatusClass(st); scheduleSave(el);
    });
    el.querySelector(".cas-count").addEventListener("input", function () { scheduleSave(el); });
    el.querySelector(".cas-reason").addEventListener("change", function () { scheduleSave(el); });
    el.querySelector(".cas-unit").addEventListener("change", function () { scheduleSave(el); });
    el.querySelector(".cas-accounted").addEventListener("change", function () { scheduleSave(el); });
    el.querySelectorAll(".cas-add-opt").forEach(function (b) {
      b.addEventListener("click", function () { addOption(el, b.dataset.kind); });
    });
    el.querySelector(".cas-del").addEventListener("click", function () { deleteContainer(el); });

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
  }
  function _addChip(el, item) {
    el.__callsigns = el.__callsigns || [];
    if (el.__callsigns.some(function (c) { return c.id === item.id; })) return;
    el.__callsigns.push({ id: item.id, name: item.name });
    renderChips(el); scheduleSave(el);
  }
  function _wireCsInput(el) {
    var input = el.querySelector(".cas-cs-input");
    var acBox = null, acSeq = 0;
    function closeAc() { if (acBox) { acBox.remove(); acBox = null; } }
    input.addEventListener("input", function () {
      var v = input.value.trim();
      if (v.length < 2) { closeAc(); return; }
      var seq = ++acSeq;
      var url = "/api/callsigns/autocomplete?q=" + encodeURIComponent(v) + (_netId ? ("&network_id=" + _netId) : "");
      fetch(url).then(function (r) { return r.json(); }).then(function (d) {
        if (seq !== acSeq) return;
        closeAc();
        var items = (d && d.items) || [];
        if (!items.length) return;
        acBox = document.createElement("div"); acBox.className = "cas-cs-ac";
        acBox.innerHTML = items.map(function (it, i) {
          return '<button type="button" data-i="' + i + '">' + esc(it.name) + "</button>";
        }).join("");
        acBox.querySelectorAll("button").forEach(function (b) {
          b.addEventListener("click", function () {
            _addChip(el, items[Number(b.dataset.i)]); input.value = ""; closeAc(); input.focus();
          });
        });
        el.querySelector(".cas-cs-wrap").appendChild(acBox);
      }).catch(closeAc);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeAc();
      if (e.key === "Enter") {
        e.preventDefault();
        if (acBox) { var first = acBox.querySelector("button"); if (first) first.click(); }
      }
    });
    input.addEventListener("blur", function () { setTimeout(closeAc, 150); });
  }

  // ── Автозбереження ─────────────────────────────────────────────────────────
  function _payload(el) {
    var reason = el.querySelector(".cas-reason").value;
    var unit = el.querySelector(".cas-unit").value;
    return {
      status: el.querySelector(".cas-status").dataset.status,
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
  function scheduleSave(el) {
    _setSaved(el, "dirty");
    clearTimeout(el.__saveTimer);
    el.__saveTimer = setTimeout(function () { saveContainer(el); }, 600);
  }
  function saveContainer(el) {
    var body = _payload(el);
    _setSaved(el, "saving");
    if (el.__casId) {
      fetch("/api/casualties/" + el.__casId, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }).then(function (r) { return r.json(); })
        .then(function (d) { _setSaved(el, d && d.ok ? "saved" : "error"); })
        .catch(function () { _setSaved(el, "error"); });
    } else {
      body.message_id = _msgId;
      fetch("/api/casualties", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }).then(function (r) { return r.json(); })
        .then(function (d) {
          if (d && d.ok && d.record) { el.__casId = d.record.id; _setSaved(el, "saved"); }
          else _setSaved(el, "error");
        }).catch(function () { _setSaved(el, "error"); });
    }
  }
  function deleteContainer(el) {
    if (el.__casId) {
      if (!confirm("Видалити цей запис втрат?")) return;
      fetch("/api/casualties/" + el.__casId, { method: "DELETE" })
        .then(function () { el.remove(); }).catch(function () { toast("Помилка видалення", "error"); });
    } else {
      el.remove();
    }
  }
  function addOption(el, kind) {
    var name = (prompt(kind === "reason" ? "Нова причина:" : "Новий підрозділ:") || "").trim();
    if (!name) return;
    var url = kind === "reason" ? "/api/casualty-reasons" : "/api/cas/units";
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d || !d.ok) { toast("Не вдалося додати", "error"); return; }
        if (kind === "reason") { _reasons.push({ id: d.id, name: name }); refreshSelects(".cas-reason", _reasons); el.querySelector(".cas-reason").value = d.id; }
        else { _units.push({ id: d.id, name: name }); refreshSelects(".cas-unit", _units); el.querySelector(".cas-unit").value = d.id; }
        scheduleSave(el);
      }).catch(function () { toast("Помилка", "error"); });
  }

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
    if (_casChatsCache[platform]) return Promise.resolve(_casChatsCache[platform]);
    return fetch("/api/push/chats?platform=" + platform + "&only_groups=0")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        _casChatsCache[platform] = (d && d.ok && Array.isArray(d.chats)) ? d.chats : [];
        return _casChatsCache[platform];
      }).catch(function () { _casChatsCache[platform] = []; return []; });
  }

  // Текст звіту: заголовок + мета/перехоплення + перелік записів (з DOM, тож
  // відображає поточний стан контейнерів).
  function _casBuildMessage() {
    var lines = ["☠ ВТРАТИ (за даними противника)"];
    var meta = ($("casModalMeta").textContent || "").trim();
    if (meta) lines.push("", meta);
    if (_interceptText) lines.push("", _interceptText.trim());
    var recLines = [];
    document.querySelectorAll("#casRecords .cas-rec").forEach(function (el) {
      var status = el.querySelector(".cas-status").dataset.status;
      var count = Math.max(1, parseInt(el.querySelector(".cas-count").value, 10) || 1);
      var rSel = el.querySelector(".cas-reason");
      var reason = rSel.value ? rSel.options[rSel.selectedIndex].text : "";
      var uSel = el.querySelector(".cas-unit");
      var unit = uSel.value ? uSel.options[uSel.selectedIndex].text : "";
      var cs = (el.__callsigns || []).map(function (c) { return c.name; });
      var parts = [status + " × " + count];
      if (reason) parts.push(reason);
      if (unit) parts.push(unit);
      var line = "• " + parts.join(" — ");
      if (cs.length) line += " · " + cs.join(", ");
      if (el.querySelector(".cas-accounted").checked) line += " (враховано)";
      recLines.push(line);
    });
    if (recLines.length) lines.push("", recLines.join("\n"));
    return lines.join("\n").trim();
  }

  function _casSend() {
    if (!_casChat || !_casChat.id) {
      _casOpenPicker();
      toast("Спершу вкажіть чат (Ctrl+клік по «Надіслати»)", "warn");
      return;
    }
    var text = _casBuildMessage();
    if (!text) { toast("Немає даних для надсилання", "warn"); return; }
    var btn = $("casSendBtn");
    if (btn) { btn.disabled = true; btn.classList.add("is-busy"); }
    fetch("/api/push/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: _casChat.platform, chat_id: _casChat.id, text: text }),
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) {
        if (d && d.ok) toast("Надіслано → " + _casChat.name, "success");
        else toast(d.error || d.detail || "Помилка надсилання", "error");
      }).catch(function (e) { toast("Помилка: " + (e && e.message || e), "error"); })
      .then(function () { if (btn) { btn.disabled = false; btn.classList.remove("is-busy"); } });
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
      var box = $("casRecords"); if (box) box.appendChild(buildContainer(null));
    });
    var send = $("casSendBtn");
    if (send) send.addEventListener("click", function (e) {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); _casOpenPicker(); }
      else _casSend();
    });
    // Закриття пікера при кліку поза ним.
    document.addEventListener("click", function (e) {
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
