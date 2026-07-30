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

  // HTML закладки для вставки в шаблон картки.
  window.interceptStatusRibbon = function (item) {
    var flag = (item && item.value_flag) ? 1 : 0;
    var concl = (item && item.has_conclusion) ? 1 : 0;
    var st = statusOf(flag, concl);
    return '<button type="button" class="intercept-card__status intercept-card__status--' + st + '"' +
      ' data-mid="' + (item && item.id) + '" data-flag="' + flag + '" data-concl="' + concl + '"' +
      ' title="' + TITLES[st] + '" aria-label="Статус перехоплення: ' + st + '"></button>';
  };

  function apply(el) {
    var st = statusOf(el.dataset.flag === "1", el.dataset.concl === "1");
    el.className = "intercept-card__status intercept-card__status--" + st;
    el.title = TITLES[st];
  }

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
