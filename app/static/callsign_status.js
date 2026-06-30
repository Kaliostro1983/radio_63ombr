/* callsign_status.js — ЄДИНИЙ модуль логіки «життєвого» статусу позивного.
 *
 * Значення:
 *   "alive" — живий (типове)
 *   "200"   — Груз 200 (ліквідований)
 *   "300"   — Груз 300 (поранений)
 *
 * Модуль НЕ малює готовий HTML/SVG напряму, а тримає одну мапу статус→вигляд
 * (колір/підпис/підказка) і дає тонкі адаптери під різні носії:
 *   • applyChipBadge(wrap, life) — HTML-бейдж у чіпі перехоплення;
 *   • svgBadge(life)             — кутовий бейдж для вузла графа (SVG).
 * Логіка одна → змінив правило в одному місці, оновилось скрізь.
 */
(function () {
  "use strict";

  // Лише «мертві» стани мають бейдж; живий — без позначки (щоб не рясніло).
  var DEAD = {
    "200": { key: "200", label: "200", bg: "#1f2937", color: "#fff", title: "Груз 200 (ліквідований)" },
    "300": { key: "300", label: "300", bg: "#dc2626", color: "#fff", title: "Груз 300 (поранений)" },
  };
  var ALIVE = { key: "alive", label: "Живий", bg: "transparent", color: "var(--text)", title: "Живий" };
  var ORDER = ["alive", "200", "300"];

  function norm(life) {
    var s = String(life == null ? "alive" : life).trim();
    return (s === "200" || s === "300") ? s : "alive";
  }
  // Повна інфо для будь-якого значення (вкл. alive) — для перемикача в модалці.
  function meta(life) {
    var k = norm(life);
    return k === "alive" ? ALIVE : DEAD[k];
  }
  // Інфо лише для бейджа: null для живого.
  function badge(life) {
    return DEAD[norm(life)] || null;
  }
  // Наступне значення по колу: живий → 200 → 300 → живий.
  function next(life) {
    var i = ORDER.indexOf(norm(life));
    return ORDER[(i + 1) % ORDER.length];
  }

  // HTML: вставити/прибрати <span.cs-life-badge> поряд з іконкою в чіпі.
  // `wrap` = елемент .cs-ico-wrap (має data-concl-cs-id). Бейдж кладемо
  // одразу після іконки, у той самий контейнер-чіп.
  function applyChipBadge(wrap, life) {
    if (!wrap) return;
    var info = badge(life);
    // Обводка іконки за станом (200 — чорна, 300 — червона; живий — без обводки).
    wrap.classList.remove("cs-life-ring-200", "cs-life-ring-300");
    if (info) wrap.classList.add("cs-life-ring-" + info.key);
    // Числовий бейдж поряд з іконкою.
    var host = wrap.parentNode;
    if (!host) return;
    var existing = null, c = host.firstChild;
    for (; c; c = c.nextSibling) {
      if (c.nodeType === 1 && c.classList && c.classList.contains("cs-life-badge")) { existing = c; break; }
    }
    if (!info) { if (existing) existing.remove(); return; }
    var el = existing || document.createElement("span");
    el.className = "cs-life-badge cs-life-badge--" + info.key;
    el.textContent = info.label;
    el.title = info.title;
    if (!existing) host.insertBefore(el, wrap.nextSibling);
  }

  // SVG: кутовий кружечок з числом для вузла графа. Повертає <g> або null.
  function svgBadge(life) {
    var info = badge(life);
    if (!info) return null;
    var NS = "http://www.w3.org/2000/svg";
    var g = document.createElementNS(NS, "g");
    g.setAttribute("class", "net-graph-node__life");
    var circle = document.createElementNS(NS, "circle");
    circle.setAttribute("cx", "8.5");
    circle.setAttribute("cy", "8.5");
    circle.setAttribute("r", "7");
    circle.setAttribute("fill", info.bg);
    circle.setAttribute("stroke", "#11151a");
    circle.setAttribute("stroke-width", "1.5");
    g.appendChild(circle);
    var text = document.createElementNS(NS, "text");
    text.setAttribute("x", "8.5");
    text.setAttribute("y", "8.5");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.setAttribute("fill", info.color);
    text.setAttribute("font-size", "6.5");
    text.setAttribute("font-weight", "700");
    text.style.pointerEvents = "none";
    text.textContent = info.label;
    g.appendChild(text);
    var titleEl = document.createElementNS(NS, "title");
    titleEl.textContent = info.title;
    g.appendChild(titleEl);
    return g;
  }

  window.CallsignStatus = {
    norm: norm, meta: meta, badge: badge, next: next,
    applyChipBadge: applyChipBadge, svgBadge: svgBadge, ORDER: ORDER,
  };
})();
