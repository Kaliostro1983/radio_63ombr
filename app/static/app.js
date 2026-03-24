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
});