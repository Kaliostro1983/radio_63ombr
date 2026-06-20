/**
 * Ефективність палітр — модалка на сторінці «Висновки».
 * Для кожної палітри показує, скільки аналітичних висновків за останні N днів
 * (за замовч. 90) зроблено САМЕ ПО ЦІЙ ПАЛІТРІ: оператор шукав код, обрав одну
 * з точок палітри і зберіг висновок → ця точка зарахована палітрі як ефективна.
 * Облік ведеться при збереженні висновку; рахунок — прямий SQL на сервері.
 */
(function () {
  "use strict";

  const DAYS = 90;

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function seqPrefix(seq) {
    const n = Number(seq);
    return (Number.isFinite(n) && n > 0) ? `<span class="pe-seq">#${n}</span> ` : "";
  }

  function heatClass(n) {
    if (n <= 0) return "pe-cnt--zero";
    if (n <= 10) return "pe-cnt--low";
    return "pe-cnt--high";
  }

  const modal = document.getElementById("cnPaletteEffModal");
  const body = document.getElementById("cnPaletteEffBody");
  const openBtn = document.getElementById("cnOpenPaletteEff");
  if (!modal || !body || !openBtn) return;

  function show() {
    modal.classList.remove("hidden");
    modal.removeAttribute("aria-hidden");
    if (window.__modalToFront) window.__modalToFront(modal);
  }
  function hide() {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }

  async function load() {
    body.innerHTML = `<div class="pe-empty">Завантаження…</div>`;
    let data;
    try {
      const r = await fetch(`/api/palettes/efficiency?days=${DAYS}`);
      data = await r.json();
    } catch (_) { data = null; }
    if (!data || !data.ok) {
      body.innerHTML = `<div class="pe-empty">Помилка завантаження.</div>`;
      return;
    }

    const rows = (data.palettes || []).map((p) => ({
      seq_no: p.seq_no,
      name: p.name || "",
      units: (p.units || []).join(", "),
      conclusions: Number(p.conclusions || 0),
      points: Number(p.points || 0),
    }));
    rows.sort((a, b) => b.conclusions - a.conclusions || b.points - a.points || a.name.localeCompare(b.name));

    if (!rows.length) {
      body.innerHTML = `<div class="pe-empty">Палітр немає.</div>`;
      return;
    }
    const trs = rows.map((r, i) => `
      <tr>
        <td class="pe-idx">${i + 1}</td>
        <td class="pe-name">${seqPrefix(r.seq_no)}${esc(r.name)}</td>
        <td class="pe-units">${esc(r.units) || "—"}</td>
        <td class="pe-cnt-cell"><span class="pe-cnt ${heatClass(r.conclusions)}">${r.conclusions}</span></td>
        <td class="pe-cnt-cell"><span class="pe-pts">${r.points}</span></td>
      </tr>`).join("");
    body.innerHTML = `
      <div class="pe-sub small">За ${data.days || DAYS} днів · «Висновків» — скільки висновків зроблено по точках
        цієї палітри; «Точок» — скільки ефективних точок обрано всього.</div>
      <table class="table pe-table">
        <thead>
          <tr>
            <th style="width:44px">#</th>
            <th>Палітра</th>
            <th style="width:160px">Підрозділи</th>
            <th style="width:90px; text-align:center">Висновків</th>
            <th style="width:70px; text-align:center">Точок</th>
          </tr>
        </thead>
        <tbody>${trs}</tbody>
      </table>`;
  }

  openBtn.addEventListener("click", () => { show(); load(); });
  modal.querySelectorAll("[data-cn-pe-close]").forEach((el) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); hide(); });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) hide();
  });
})();
