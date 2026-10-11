/* Аудит абонентів р/м: чи змінився склад позивних.
 * Кнопка #netSubAuditBtn на картці р/м → модалка #netSubAuditModal.
 * Дані: GET /api/networks/{id}/subscriber-audit?fresh_days=14
 * Показує: інкарнації, канікули, виживання складу через провал, несучу,
 * turnover свіжого вікна та зведений вердикт.
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const modal = $("netSubAuditModal");
  const btn = $("netSubAuditBtn");
  if (!modal || !btn) return;

  const meta = $("saMeta");
  const body = $("saBody");

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function open() {
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    if (window.__modalToFront) window.__modalToFront(modal);
  }
  function close() {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }

  // dd.mm формат із 'YYYY-MM-DD' або 'YYYY-MM-DD HH:MM:SS'
  function d2(s) {
    if (!s) return "";
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : esc(s);
  }

  const VERDICT = {
    reactivated_new: { cls: "sa-v-bad", ic: "⚠" },
    suspect:         { cls: "sa-v-warn", ic: "❓" },
    rotation:        { cls: "sa-v-ok", ic: "🔁" },
    stable:          { cls: "sa-v-ok", ic: "✅" },
    no_data:         { cls: "sa-v-warn", ic: "∅" },
  };

  function chip(name, extra) {
    return `<span class="sa-chip${extra ? " " + extra : ""}">${esc(name)}</span>`;
  }

  function render(d) {
    if (!d || !d.ok) {
      body.innerHTML = `<div class="sa-err">${esc((d && d.error) || "Помилка запиту")}</div>`;
      meta.textContent = "";
      return;
    }
    const n = d.network || {};
    meta.innerHTML =
      `<b>${esc(n.frequency || "—")}</b>` +
      (n.unit ? ` · ${esc(n.unit)}` : "") +
      (n.zone ? ` · <span style="opacity:.8">${esc(n.zone)}</span>` : "") +
      ` · станом на ${d2(d.now)} (свіже вікно — останні ${d.params ? d.params.fresh_days : 14} діб)`;

    if (d.empty) {
      body.innerHTML = `<div class="sa-err">Немає перехоплень із розпізнаними позивними.</div>`;
      return;
    }

    const v = d.verdict || {};
    const vv = VERDICT[v.level] || VERDICT.stable;
    let html = "";

    // Вердикт
    html += `<div class="sa-verdict ${vv.cls}">
      <div class="sa-v-title">${vv.ic} ${esc(v.title || "")}</div>
      ${(v.reasons || []).map((r) => `<div class="sa-v-reason">• ${esc(r)}</div>`).join("")}
    </div>`;

    // Життя мережі / інкарнації
    const life = d.life || {};
    html += `<div class="sa-sec"><div class="sa-h">Життя мережі</div>
      <div class="sa-kv">Період: <b>${d2(life.first)} → ${d2(life.last)}</b>,
      активних діб: <b>${life.active_days}</b>, перехоплень: <b>${life.total_msgs}</b></div>`;
    if ((d.incarnations || []).length > 1) {
      html += `<div class="sa-kv" style="margin-top:6px">Інкарнації (розриви &gt; ${d.params.split_days} діб):</div>
        <ul class="sa-list">` +
        d.incarnations.map((s, i) => {
          const isCur = d.current && s.from === d.current.from && s.to === d.current.to;
          return `<li${isCur ? ' class="sa-cur"' : ""}>${d2(s.from)} → ${d2(s.to)} · ${s.active_days} діб · ${s.callsigns} позивних${isCur ? " · <b>поточна</b>" : ""}</li>`;
        }).join("") + `</ul>`;
    }
    html += `</div>`;

    // Виживання складу через останній провал
    if (d.recent_gap && d.roster_survival) {
      const rs = d.roster_survival, g = d.recent_gap;
      html += `<div class="sa-sec"><div class="sa-h">Зміна складу після провалу</div>
        <div class="sa-kv">Провал <b>${g.days} діб</b> (${d2(g.from)} → ${d2(g.to)}).
        Збіг складу до/після: <b>Jaccard ${rs.jaccard}</b> — спільних <b>${rs.common}</b>
        (було ${rs.prev} → стало ${rs.curr}).</div>
        <div class="sa-kv" style="margin-top:6px">Пережили провал:</div>
        <div class="sa-chips">${rs.survivors.length ? rs.survivors.map((x) => chip(x)).join("") : '<span class="sa-muted">— жоден —</span>'}</div>
      </div>`;
    }

    // Несуча
    const bb = d.backbone || [];
    html += `<div class="sa-sec"><div class="sa-h">Несуча (постійні позивні)</div>`;
    if (bb.length) {
      html += `<table class="sa-tbl"><thead><tr><th>Позивний</th><th>span</th><th>діб</th><th>всього</th><th>свіжих</th><th>статус</th></tr></thead><tbody>` +
        bb.map((b) => `<tr class="${b.alive ? "" : "sa-silent"}">
          <td>${esc(b.name)} ${b.alive ? '<span class="sa-dot sa-live" title="жива"></span>' : '<span class="sa-dot sa-mute" title="мовчить"></span>'}</td>
          <td>${b.span.toFixed(2)}</td><td>${b.days}</td><td>${b.total}</td><td>${b.fresh}</td>
          <td class="sa-muted">${esc(b.status || "")}</td></tr>`).join("") +
        `</tbody></table>`;
    } else {
      html += `<div class="sa-muted">Стабільної несучої не виявлено (мережа молода або повністю ротаційна).</div>`;
    }
    html += `</div>`;

    // Turnover (лише якщо не вироджено)
    const t = d.turnover || {};
    if (!t.degenerate) {
      const p = t.permanent || {}, tt = t.temporary || {};
      html += `<div class="sa-sec"><div class="sa-h">Оновлення у свіжому вікні</div>
        <div class="sa-kv">Постійні: retention <b>${p.retention == null ? "—" : p.retention}</b> (лишилось ${p.kept}/${p.base})</div>
        <div class="sa-kv">Тимчасові: retention <b>${tt.retention == null ? "—" : tt.retention}</b> (лишилось ${tt.kept}/${tt.base})</div>`;
      if ((t.dropped_permanent || []).length)
        html += `<div class="sa-kv" style="margin-top:6px">Зникли постійні:</div><div class="sa-chips">${t.dropped_permanent.map((x) => chip(x, "sa-chip-drop")).join("")}</div>`;
      if ((t.new_permanent || []).length)
        html += `<div class="sa-kv" style="margin-top:6px">Нові постійні:</div><div class="sa-chips">${t.new_permanent.map((x) => chip(x, "sa-chip-new")).join("")}</div>`;
      html += `</div>`;
    }

    // Топ свіжих
    const ft = d.fresh_top || [];
    if (ft.length) {
      html += `<div class="sa-sec"><div class="sa-h">Найактивніші у свіжому вікні</div>
        <div class="sa-chips">` +
        ft.map((x) => `<span class="sa-chip ${x.type === "P" ? "sa-chip-p" : "sa-chip-t"}" title="${x.type === "P" ? "постійний" : "тимчасовий"}">${esc(x.name)} · ${x.fresh}</span>`).join("") +
        `</div></div>`;
    }

    // Класифікація (підсумок)
    const cl = d.classification || {};
    html += `<div class="sa-foot sa-muted">Класифіковано: постійних ${cl.permanent}, тимчасових ${cl.temporary}${cl.unknown_status ? ` (з них ${cl.unknown_status} — роль визначено емпірично)` : ""}.</div>`;

    body.innerHTML = html;
  }

  async function load() {
    const nid = btn.getAttribute("data-net-id");
    if (!nid) return;
    open();
    meta.textContent = "";
    body.innerHTML = `<div class="sa-loading">Аналіз абонентів…</div>`;
    try {
      const r = await fetch(`/api/networks/${encodeURIComponent(nid)}/subscriber-audit?fresh_days=14`);
      const d = await r.json();
      render(d);
    } catch (e) {
      body.innerHTML = `<div class="sa-err">Помилка зʼєднання: ${esc(String(e && e.message || e))}</div>`;
    }
  }

  btn.addEventListener("click", load);
  modal.addEventListener("click", (e) => {
    if (e.target.closest && e.target.closest('[data-subaudit-close="1"]')) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) close();
  });
})();
