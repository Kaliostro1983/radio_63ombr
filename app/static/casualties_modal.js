/* ============================================================================
 * Модалка оформлення втрат (200/300) — «Втрати 2», Фаза 2.
 * Кнопка «☠» у картці перехоплення → window.openCasualtyModal(msgId, netId, meta).
 * Кожен запис-контейнер автозберігається (lazy create → update) у /api/casualties.
 * Позивні — чіп-інпут з автокомплітом /api/callsigns/autocomplete; прив'язка
 * позивного на бекенді виставляє його life_status (200/300).
 * ==========================================================================*/
(function () {
  "use strict";

  var _msgId = 0, _netId = null;
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
  window.openCasualtyModal = function (messageId, networkId, meta) {
    _msgId = messageId; _netId = networkId || null;
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
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
