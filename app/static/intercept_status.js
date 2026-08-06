/* ============================================================================
 * Статус цінності перехоплення — кутова закладка на картці.
 *   звичайне (сірий) · потенційно цінне (помаранчевий) · цінне (зелений).
 * Зелений — похідний (є аналітичний висновок), не перемикається кліком.
 * Клік по закладці (не зеленій) → toggle сірий⇄помаранчевий.
 * Спільний для всіх рендерерів картки (explorer / search / message_detail).
 * ==========================================================================*/
(function () {
  "use strict";

  var TITLES = {
    valuable: "Цінне — є аналітичний висновок",
    potential: "Потенційно цінне (клік — зняти позначку)",
    normal: "Звичайне (клік — позначити потенційно цінним)",
  };

  function statusOf(flag, concl) {
    return concl ? "valuable" : (flag ? "potential" : "normal");
  }

  // HTML закладки + кругла кнопка «?» (к-сть висновків на частоті за 48 год).
  window.interceptStatusRibbon = function (item) {
    var flag = (item && item.value_flag) ? 1 : 0;
    var concl = (item && item.has_conclusion) ? 1 : 0;
    var st = statusOf(flag, concl);
    var nid = (item && item.network_id != null) ? item.network_id : "";
    return '<button type="button" class="intercept-card__status intercept-card__status--' + st + '"' +
      ' data-mid="' + (item && item.id) + '" data-flag="' + flag + '" data-concl="' + concl + '"' +
      ' title="' + TITLES[st] + '" aria-label="Статус перехоплення: ' + st + '"></button>' +
      '<button type="button" class="intercept-card__concl48" data-concl48="1"' +
      ' data-network-id="' + nid + '"' +
      ' title="Аналітичних висновків на цій частоті за крайні 48 год (клік — показати)"' +
      ' aria-label="Кількість аналітичних висновків за 48 годин">?</button>';
  };

  function apply(el) {
    var st = statusOf(el.dataset.flag === "1", el.dataset.concl === "1");
    el.className = "intercept-card__status intercept-card__status--" + st;
    el.title = TITLES[st];
  }

  function _updateByMid(mid, changes) {
    if (mid == null) return;
    document.querySelectorAll('.intercept-card__status[data-mid="' + mid + '"]').forEach(function (el) {
      Object.keys(changes).forEach(function (k) { el.dataset[k] = changes[k]; });
      apply(el);
    });
  }

  // Жива синхронізація: оформлено висновок → зелений; видалено → назад
  // (помаранчевий, бо value_flag лишається 1).
  document.addEventListener("conclusionSaved", function (e) {
    _updateByMid(e.detail && e.detail.message_id, { concl: "1", flag: "1" });
  });
  document.addEventListener("conclusionDeleted", function (e) {
    _updateByMid(e.detail && e.detail.message_id, { concl: "0" });
  });

  // Кнопка «?»: показати к-сть аналітичних висновків на цій частоті за 48 год.
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".intercept-card__concl48");
    if (!b) return;
    e.stopPropagation();
    e.preventDefault();
    if (b.dataset.loading === "1") return;
    var nid = b.dataset.networkId;
    if (!nid) { b.textContent = "0"; b.classList.add("intercept-card__concl48--loaded"); return; }
    b.dataset.loading = "1";
    b.textContent = "…";
    fetch("/api/conclusions/count-48h?network_id=" + encodeURIComponent(nid))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        b.textContent = (d && d.ok) ? String(d.count) : "?";
        b.classList.add("intercept-card__concl48--loaded");
      })
      .catch(function () { b.textContent = "?"; })
      .finally(function () { b.dataset.loading = "0"; });
  });

  // Делегований клік — працює для будь-якого рендерера картки.
  document.addEventListener("click", function (e) {
    var el = e.target.closest && e.target.closest(".intercept-card__status");
    if (!el) return;
    e.stopPropagation();
    e.preventDefault();
    if (el.dataset.concl === "1") {
      if (window.appToast) window.appToast("Статус визначає аналітичний висновок", "info", 1800);
      return;
    }
    var mid = el.dataset.mid;
    if (!mid) return;
    fetch("/api/intercepts-explorer/" + mid + "/value-flag", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok) { el.dataset.flag = d.value_flag ? "1" : "0"; apply(el); } })
      .catch(function () { if (window.appToast) window.appToast("Помилка зміни статусу", "error", 1800); });
  });
})();
