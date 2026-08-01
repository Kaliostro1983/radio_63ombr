/* ============================================================================
 * «Втрати 2» — сторінкова модалка (home): перелік перехоплень із привʼязаними
 * записами втрат за період + правки (через casualties_modal.js) + звіт-агрегація
 * у форматі «Втрати» (БЕЗПОВОРОТНІ 200 / САНІТАРНІ 300 по підрозділах).
 * ==========================================================================*/
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtDt(s) {
    var m = String(s == null ? "" : s).match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    return m ? (m[3] + "." + m[2] + "." + m[1] + " " + m[4] + ":" + m[5]) : "";
  }
  function toLocalInput(d) {
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function defaultRange() {
    // Доба 16→16: 16:00 учора → 16:00 сьогодні.
    var to = new Date(); to.setHours(16, 0, 0, 0);
    var from = new Date(); from.setDate(from.getDate() - 1); from.setHours(16, 0, 0, 0);
    return { from: toLocalInput(from), to: toLocalInput(to) };
  }

  var _modal, _open = false;

  function openModal() {
    _modal = $("homeModalCasualties2"); if (!_modal) return;
    var f = $("cas2From"), t = $("cas2To");
    if (f && !f.value) { var dr = defaultRange(); f.value = dr.from; if (t) t.value = dr.to; }
    _modal.classList.remove("hidden"); _modal.removeAttribute("aria-hidden");
    _open = true;
    showList();
    reload();
  }
  function closeModal() {
    if (!_modal) return;
    _modal.classList.add("hidden"); _modal.setAttribute("aria-hidden", "true");
    _open = false;
  }

  function showList() {
    $("cas2List").classList.remove("hidden");
    $("cas2Report").classList.add("hidden");
    $("cas2ReportBtn").style.display = "";
    $("cas2ListBtn").style.display = "none";
  }
  function showReport() {
    $("cas2List").classList.add("hidden");
    $("cas2Report").classList.remove("hidden");
    $("cas2ReportBtn").style.display = "none";
    $("cas2ListBtn").style.display = "";
  }

  function _range() {
    return { from: ($("cas2From").value || ""), to: ($("cas2To").value || "") };
  }

  // ── Перелік перехоплень + записів ──────────────────────────────────────────
  function reload() {
    var box = $("cas2List");
    box.innerHTML = '<div class="cas2-empty">Завантаження…</div>';
    var r = _range();
    var qs = new URLSearchParams();
    if (r.from) qs.set("date_from", r.from);
    if (r.to) qs.set("date_to", r.to);
    fetch("/api/casualties?" + qs.toString()).then(function (x) { return x.json(); }).then(function (d) {
      var recs = (d && d.records) || [];
      renderList(recs);
      if (!$("cas2Report").classList.contains("hidden")) loadReport();
      var sub = $("cas2Sub");
      if (sub) sub.textContent = recs.length ? ("· записів: " + recs.length) : "";
    }).catch(function () { box.innerHTML = '<div class="cas2-empty">Помилка завантаження</div>'; });
  }

  function renderList(recs) {
    var box = $("cas2List");
    if (!recs.length) { box.innerHTML = '<div class="cas2-empty">За цей період записів немає.</div>'; return; }
    // Групування за перехопленням.
    var groups = {}; var order = [];
    recs.forEach(function (rec) {
      var k = rec.message_id;
      if (!groups[k]) { groups[k] = { mid: k, recs: [], msg: rec }; order.push(k); }
      groups[k].recs.push(rec);
    });
    box.innerHTML = "";
    order.forEach(function (k) {
      var g = groups[k];
      var head = [fmtDt(g.msg.msg_dt), g.msg.msg_freq, g.msg.msg_net].filter(Boolean).join("  ·  ");
      var wrap = document.createElement("div");
      wrap.className = "cas2-item";
      var recRows = g.recs.map(function (rec) {
        var cs = (rec.callsigns || []).map(function (c) { return esc(c.name); }).join(", ");
        var bits = [
          '<span class="cas2-badge cas2-badge--' + (rec.status === "200" ? "200" : "300") + '">' + esc(rec.status) + " × " + rec.count + "</span>",
        ];
        if (rec.reason) bits.push(esc(rec.reason));
        if (rec.unit) bits.push(esc(rec.unit));
        var line = bits.join(" — ");
        if (cs) line += ' <span class="cas2-cs">(' + cs + ")</span>";
        if (rec.accounted) line += ' <span class="cas2-acc">враховано</span>';
        return '<div class="cas2-rec"><span class="cas2-rec-line">' + line + "</span></div>";
      }).join("");
      wrap.innerHTML =
        '<div class="cas2-item-head">' +
          '<div class="cas2-item-title">' + esc(head) + "</div>" +
          '<div class="cas2-item-actions">' +
            '<button type="button" class="cas2-edit" title="Редагувати записи цього перехоплення">✎ Правка</button>' +
            '<button type="button" class="cas2-del-head" title="Видалити записи втрат цього перехоплення">🗑 Видалити</button>' +
          "</div>" +
        "</div>" +
        (g.msg.msg_text ? '<div class="cas2-item-text">' + esc(g.msg.msg_text) + "</div>" : "") +
        '<div class="cas2-recs">' + recRows + "</div>";

      wrap.querySelector(".cas2-edit").addEventListener("click", function () {
        var cs = {};
        g.recs.forEach(function (rec) { (rec.callsigns || []).forEach(function (c) { cs[c.id] = { id: c.id, name: c.name }; }); });
        if (window.openCasualtyModal) {
          window.openCasualtyModal(g.mid, g.msg.msg_network_id || null, head, g.msg.msg_text || "", Object.keys(cs).map(function (i) { return cs[i]; }));
        }
      });
      wrap.querySelector(".cas2-del-head").addEventListener("click", function () {
        var ids = g.recs.map(function (rec) { return rec.id; });
        var msg = ids.length > 1
          ? ("Видалити всі записи втрат (" + ids.length + ") цього перехоплення?")
          : "Видалити запис втрат цього перехоплення?";
        if (!confirm(msg)) return;
        Promise.all(ids.map(function (id) {
          return fetch("/api/casualties/" + id, { method: "DELETE" });
        })).then(function () { reload(); });
      });
      box.appendChild(wrap);
    });
  }

  // ── Звіт-агрегація ─────────────────────────────────────────────────────────
  function loadReport() {
    var box = $("cas2Report");
    box.innerHTML = '<div class="cas2-empty">Завантаження…</div>';
    var r = _range();
    var qs = new URLSearchParams();
    if (r.from) qs.set("date_from", r.from);
    if (r.to) qs.set("date_to", r.to);
    fetch("/api/casualties/report?" + qs.toString()).then(function (x) { return x.json(); }).then(function (d) {
      renderReport((d && d.rows) || [], (d && d.totals) || { killed: 0, wounded: 0 });
    }).catch(function () { box.innerHTML = '<div class="cas2-empty">Помилка завантаження</div>'; });
  }

  function renderReport(rows, totals) {
    var box = $("cas2Report");
    if (!rows.length) { box.innerHTML = '<div class="cas2-empty">За цей період даних немає.</div>'; return; }
    var r = _range();
    var period = (fmtDt(r.from) || "") + " – " + (fmtDt(r.to) || "");
    var body = rows.map(function (row) {
      return "<tr><td>" + esc(row.unit) + "</td>" +
        '<td class="cas2-num cas2-num--200">' + (row.killed || 0) + "</td>" +
        '<td class="cas2-num cas2-num--300">' + (row.wounded || 0) + "</td></tr>";
    }).join("");
    box.innerHTML =
      '<div class="cas2-report-title">Втрати за період: ' + esc(period) + "</div>" +
      '<table class="cas2-report-table"><thead><tr>' +
        "<th>Підрозділ</th><th>200 (безповоротні)</th><th>300 (санітарні)</th>" +
      "</tr></thead><tbody>" + body + "</tbody>" +
      '<tfoot><tr><td>Усього</td>' +
        '<td class="cas2-num cas2-num--200">' + (totals.killed || 0) + "</td>" +
        '<td class="cas2-num cas2-num--300">' + (totals.wounded || 0) + "</td></tr></tfoot>" +
      "</table>";
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    var btn = $("homeOpenCasualties2");
    if (btn) btn.addEventListener("click", openModal);
    document.querySelectorAll("[data-cas2-close]").forEach(function (el) {
      el.addEventListener("click", function (e) { e.stopPropagation(); closeModal(); });
    });
    $("cas2Refresh") && $("cas2Refresh").addEventListener("click", reload);
    $("cas2ReportBtn") && $("cas2ReportBtn").addEventListener("click", function () { showReport(); loadReport(); });
    $("cas2ListBtn") && $("cas2ListBtn").addEventListener("click", showList);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && _open && _modal && !_modal.classList.contains("hidden") &&
          (!$("casualtyModal") || $("casualtyModal").classList.contains("hidden"))) {
        closeModal();
      }
    });
    // Живе оновлення після правок у редакторі втрат.
    document.addEventListener("casualtiesChanged", function () { if (_open) reload(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
