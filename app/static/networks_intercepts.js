/**
 * networks_intercepts.js — "Перехоплення за тиждень" bar chart on the network card.
 *
 * Renders intercept counts per day for the last 7 days (including today) for the
 * currently-opened radio network. Data: GET /api/networks/{id}/intercept-stats.
 * The 7-day axis is built here in the browser's local timezone (created_at is
 * stored in local time), so "today" is always the user's current day.
 */
(function () {
  "use strict";

  var DOW = ["Нд", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
  var BAR_AREA = 120;   // px height of the bar area
  var BAR_COLOR = "#3b82f6";

  function pad2(n) { return String(n).padStart(2, "0"); }
  function localDate(d) {
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }

  /** Build the last `days` local dates, oldest first, ending today. */
  function lastDays(days) {
    var out = [];
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(today.getTime() - i * 86400000);
      out.push(d);
    }
    return out;
  }

  function render(host, counts) {
    // counts: array of {date: Date, n: number, isToday: bool}
    var max = counts.reduce(function (m, c) { return Math.max(m, c.n); }, 0);
    var total = counts.reduce(function (s, c) { return s + c.n; }, 0);

    var cols = counts.map(function (c) {
      var h = max > 0 ? Math.round((c.n / max) * BAR_AREA) : 0;
      if (c.n > 0 && h < 3) h = 3;                 // keep tiny non-zero bars visible
      var fill = c.n > 0 ? BAR_COLOR : "var(--border)";
      var barH = c.n > 0 ? h : 2;
      var dd = pad2(c.date.getDate()) + "." + pad2(c.date.getMonth() + 1);
      var dow = DOW[c.date.getDay()];
      var todayRing = c.isToday
        ? "outline:2px solid color-mix(in srgb," + BAR_COLOR + " 55%,transparent);outline-offset:1px;"
        : "";
      return (
        '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:5px" ' +
        'title="' + dow + " " + dd + " — " + c.n + ' перехоплень">' +
          '<div style="height:' + BAR_AREA + 'px;width:100%;display:flex;flex-direction:column;' +
               'justify-content:flex-end;align-items:center">' +
            '<div style="font-size:.78rem;font-weight:700;color:var(--fg);margin-bottom:4px">' + c.n + '</div>' +
            '<div style="width:62%;max-width:40px;height:' + barH + 'px;background:' + fill + ';' +
                 'border-radius:4px 4px 0 0;' + todayRing + '"></div>' +
          '</div>' +
          '<div style="font-size:.72rem;color:var(--muted);text-align:center;line-height:1.25">' +
            dow + '<br>' + dd +
          '</div>' +
        '</div>'
      );
    }).join("");

    host.innerHTML =
      '<div style="display:flex;align-items:flex-end;gap:8px;padding:6px 2px 0">' + cols + '</div>' +
      '<div class="small" style="margin-top:10px;color:var(--muted)">Всього за тиждень: <b>' + total + '</b></div>';
  }

  function load(card) {
    var host = card.querySelector("#netInterceptChart");
    var nid = card.getAttribute("data-network-id");
    if (!host || !nid) return;

    fetch("/api/networks/" + encodeURIComponent(nid) + "/intercept-stats?days=7", {
      headers: { Accept: "application/json" },
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) throw new Error((data && data.error) || "bad response");
        var byDate = {};
        (data.rows || []).forEach(function (row) { byDate[row.date] = row.count; });
        var counts = lastDays(7).map(function (d) {
          var key = localDate(d);
          return { date: d, n: byDate[key] || 0, isToday: key === localDate(new Date()) };
        });
        render(host, counts);
      })
      .catch(function (err) {
        host.innerHTML = '<div class="small" style="color:var(--danger,#dc2626)">Не вдалося завантажити: ' +
          String(err) + "</div>";
      });
  }

  function init() {
    var card = document.getElementById("netInterceptStats");
    if (card) load(card);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
