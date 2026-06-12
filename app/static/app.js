(function(){
  console.log("JS loaded");

  const root = document.documentElement;
  const saved = localStorage.getItem("theme");
  if(saved){ root.setAttribute("data-theme", saved); }
  window.toggleTheme = function(){
    const cur = root.getAttribute("data-theme") || "light";
    const next = cur === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  }

  window.appToast = function(message, type = "info", ms = 2400){
    const text = String(message || "").trim();
    if(!text) return;
    const stack = document.getElementById("appToastStack");
    if(!stack) return;
    const el = document.createElement("div");
    el.className = `app-toast app-toast--${type}`;
    el.textContent = text;
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 180);
    }, Math.max(1000, Number(ms) || 2400));
  };

  /**
   * Copy text to clipboard.
   * Works in both secure (HTTPS) and non-secure (HTTP) contexts.
   * Returns a Promise<boolean> — true on success.
   */
  window.clipboardWrite = async function(text) {
    const t = String(text ?? "");
    // Modern async API — only available in secure contexts (HTTPS / localhost).
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await navigator.clipboard.writeText(t);
        return true;
      } catch { /* fall through */ }
    }
    // Legacy execCommand fallback — works on HTTP remote access.
    try {
      const ta = document.createElement("textarea");
      ta.value = t;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) return true;
    } catch { /* fall through */ }
    return false;
  };

  window.appTouchStatus = function(label){
    const el = document.getElementById("appLastUpdate");
    if(!el) return;
    if(label){
      el.textContent = String(label);
      return;
    }
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    el.textContent = `Оновлено ${hh}:${mm}:${ss}`;
  };

  /**
   * Шар 3: повідомити сервер про передранній фейл, поки помилка ще
   * відома (toast зникає, console чистимо — без цього сліду не буде).
   * Викликати в catch перед toast'ом.  Best-effort (fire-and-forget).
   *
   *   reportClientError({
   *     action:   "send"|"screenshot"|"fetch_chats"|...,
   *     category: "network"|"timeout"|"screenshot_failed"|"permission"|"unknown",
   *     detail:   <error.message>,
   *     extra:    { platform, chat_id, image_size, ... }
   *   })
   */
  window.reportClientError = function(opts){
    try {
      const p = opts || {};
      fetch("/api/client-errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page:       location.pathname,
          action:     String(p.action || ""),
          category:   String(p.category || "unknown"),
          detail:     String(p.detail || ""),
          extra:      p.extra || {},
          user_agent: navigator.userAgent,
        }),
      }).catch(() => {});
    } catch(_){}
  };
})();

function makeAllExclusive(selectEl) {
  if (!selectEl) return;

  const opts = () => Array.from(selectEl.options);
  const getAllOpt = () => opts().find(o => o.value === "0");

  const normalize = () => {
    const o = opts();
    const all = getAllOpt();
    if (!all) return;

    const selected = o.filter(x => x.selected);

    if (selected.length === 0) {
      all.selected = true;
      return;
    }

    const hasAll = selected.some(x => x.value === "0");
    const hasNonAll = selected.some(x => x.value !== "0");

    // якщо "Усі" + ще щось — прибираємо "Усі"
    if (hasAll && hasNonAll) all.selected = false;
  };

  normalize();

  selectEl.addEventListener("change", () => {
    const o = opts();
    const all = getAllOpt();
    if (!all) return;

    const selectedValues = o.filter(x => x.selected).map(x => x.value);
    const hasAll = selectedValues.includes("0");

    // якщо вибрали "Усі" — залишаємо тільки "Усі"
    if (hasAll) {
      o.forEach(x => { if (x.value !== "0") x.selected = false; });
      all.selected = true;
      return;
    }

    // якщо вибрали будь-що інше — прибираємо "Усі"
    all.selected = false;

    // якщо нічого не вибрано — повертаємо "Усі"
    if (!o.some(x => x.selected)) all.selected = true;
  });
}



document.addEventListener("DOMContentLoaded", () => {
  makeAllExclusive(document.querySelector('select[name="status_ids"]'));
  makeAllExclusive(document.querySelector('select[name="chat_ids"]'));
  makeAllExclusive(document.querySelector('select[name="group_ids"]'));
  if (window.appTouchStatus) window.appTouchStatus();
  initSidebar();
});

// ── Sidebar state management ──────────────────────────────────
(function() {
  var CYCLE  = ["full", "compact", "hidden"];

  // SVG path content for each state's toggle button
  var TOGGLE_ICON = {
    full:    '<polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>',  // »» compress
    compact: '<polyline points="9 18 15 12 9 6"/><line x1="19" y1="6" x2="19" y2="18"/>', // › hide
    hidden:  '<polyline points="15 18 9 12 15 6"/><polyline points="8 18 2 12 8 6"/>',     // «« show (fallback)
  };
  var TOGGLE_LABEL = { full: "Компакт", compact: "Сховати", hidden: "Відкрити" };
  var TOGGLE_TITLE = {
    full:    "Згорнути до іконок",
    compact: "Сховати меню",
    hidden:  "Відкрити меню",
  };

  window.initSidebar = function() {
    var toggleBtn  = document.getElementById("sidebarToggleBtn");
    var pullTab    = document.getElementById("sidebarPullTab");
    var toggleIcon = document.getElementById("sidebarToggleIcon");

    if (!toggleBtn) return;

    function getState() {
      return document.documentElement.getAttribute("data-sidebar") || "full";
    }

    function applyState(s) {
      if (CYCLE.indexOf(s) === -1) s = "full";
      document.documentElement.setAttribute("data-sidebar", s);
      localStorage.setItem("sidebarState", s);
      if (toggleIcon) toggleIcon.innerHTML = TOGGLE_ICON[s] || TOGGLE_ICON.full;
      var lbl = toggleBtn.querySelector(".sidebar-toggle-label");
      if (lbl) lbl.textContent = TOGGLE_LABEL[s] || "";
      toggleBtn.title = TOGGLE_TITLE[s] || "";
    }

    toggleBtn.addEventListener("click", function() {
      var idx  = CYCLE.indexOf(getState());
      var next = CYCLE[(idx + 1) % CYCLE.length];
      applyState(next);
    });

    if (pullTab) {
      pullTab.addEventListener("click", function() { applyState("full"); });
    }

    // Sync button appearance to the already-applied state (set by anti-FOUC script)
    applyState(getState());
  };
})();