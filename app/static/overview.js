/* overview.js – v1
 * Statistics overview tab for the home page "Огляд".
 */

(function () {
  "use strict";

  const pane = document.getElementById("homePaneOverview");
  if (!pane) return;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const fromInput = document.getElementById("ovwFrom");
  const toInput   = document.getElementById("ovwTo");
  const loadBtn   = document.getElementById("ovwLoad");
  const copyBtn   = document.getElementById("ovwCopy");
  const elTotal   = document.getElementById("ovwTotal");
  const elOcheret = document.getElementById("ovwOcheret");
  const elPeleng  = document.getElementById("ovwPeleng");
  const elAnal    = document.getElementById("ovwAnalytical");
  const canvas    = document.getElementById("ovwPieCanvas");
  const legend    = document.getElementById("ovwPieLegend");

  // ── State ──────────────────────────────────────────────────────────────────
  let _stats = null;

  // ── Date helpers ───────────────────────────────────────────────────────────
  function toLocalDTInput(d) {
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function dtInputToSQL(val) {
    // "2026-05-09T14:30" → "2026-05-09 14:30:00"
    return (val || "").replace("T", " ") + ":00";
  }

  function initDefaults() {
    const now  = new Date();
    const week = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (toInput)   toInput.value   = toLocalDTInput(now);
    if (fromInput) fromInput.value = toLocalDTInput(week);
  }

  // ── Load ───────────────────────────────────────────────────────────────────
  async function load() {
    if (!fromInput?.value || !toInput?.value) return;
    const from_dt = dtInputToSQL(fromInput.value);
    const to_dt   = dtInputToSQL(toInput.value);

    if (loadBtn) { loadBtn.disabled = true; loadBtn.textContent = "…"; }
    try {
      const res = await fetch(
        `/api/overview/stats?from_dt=${encodeURIComponent(from_dt)}&to_dt=${encodeURIComponent(to_dt)}`
      );
      const d = await res.json().catch(() => ({}));
      if (d.ok) { _stats = d; render(d); }
    } catch (e) {
      console.error("overview fetch", e);
    } finally {
      if (loadBtn) { loadBtn.disabled = false; loadBtn.textContent = "Оновити"; }
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  function render(d) {
    if (elTotal)   elTotal.textContent   = d.total_intercepts;
    if (elOcheret) elOcheret.textContent = d.ocheret_intercepts;
    if (elPeleng)  elPeleng.textContent  = d.peleng_count;
    if (elAnal)    elAnal.textContent    = d.analytical_count;
    drawPie(d.by_chat || []);
  }

  // ── Pie chart ──────────────────────────────────────────────────────────────
  const PALETTE = [
    "#3b82f6","#22c55e","#f59e0b","#ef4444","#a855f7",
    "#06b6d4","#f97316","#84cc16","#ec4899","#6366f1",
    "#14b8a6","#f43f5e","#8b5cf6","#0ea5e9","#d97706",
  ];

  function drawPie(byChat) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const total = byChat.reduce((s, r) => s + r.count, 0);
    if (total === 0) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "13px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Немає даних", W / 2, H / 2);
      if (legend) legend.innerHTML = "";
      return;
    }

    const cx = W / 2, cy = H / 2;
    const r  = Math.min(W, H) / 2 - 4;
    let angle = -Math.PI / 2;

    byChat.forEach((row, i) => {
      const slice = (row.count / total) * 2 * Math.PI;
      const color = PALETTE[i % PALETTE.length];
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, angle, angle + slice);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      angle += slice;
    });

    // Legend
    if (legend) {
      legend.innerHTML = byChat.map((row, i) => {
        const pct   = Math.round(row.count / total * 100);
        const color = PALETTE[i % PALETTE.length];
        return `<li class="ovw-legend-item">
          <span class="ovw-legend-dot" style="background:${color}"></span>
          <span>${escHtml(row.chat_name)} — <b>${row.count}</b> (${pct}%)</span>
        </li>`;
      }).join("");
    }
  }

  // ── Copy ───────────────────────────────────────────────────────────────────
  function buildCopyText(d) {
    return (
      "Статистика взводу РЕР за крайні 7 днів:\n\n" +
      `* отекстовано ${d.ocheret_intercepts} перехоплень;\n` +
      `* оброблено ${d.total_intercepts} перехоплень зі смуги відповідальності бригади\n` +
      `* зроблено ${d.peleng_count} пеленгаційних засічок\n` +
      `* зроблено ${d.analytical_count} аналітичних висновків`
    );
  }

  copyBtn?.addEventListener("click", () => {
    if (!_stats) { toast("Спочатку завантажте дані", "error", 3000); return; }
    const text = buildCopyText(_stats);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => toast("Скопійовано!", "success", 2500))
        .catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  });

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity  = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand("copy"); toast("Скопійовано!", "success", 2500); }
    catch { toast("Не вдалося скопіювати", "error", 3000); }
    document.body.removeChild(ta);
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  let _inited = false;
  async function init() {
    if (_inited) return;
    _inited = true;
    initDefaults();
    await load();
  }

  loadBtn?.addEventListener("click", load);
  document.getElementById("homeTabOverview")?.addEventListener("click", init);
  if (!pane.classList.contains("hidden")) init();

  // ── Util ───────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function toast(msg, type, ms) {
    const stack = document.getElementById("appToastStack");
    if (!stack) return;
    const el = document.createElement("div");
    el.className = "app-toast app-toast--" + (type || "info");
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), ms || 3000);
  }

})();
