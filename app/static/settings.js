(function () {
  const key = "graphLineThicknessFactor";
  const input = document.getElementById("graphLineThicknessRange");
  const valueEl = document.getElementById("graphLineThicknessValue");
  if (!input || !valueEl) return;

  function clamp(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1.0;
    return Math.max(1.0, Math.min(1.6, n));
  }

  function format(v) {
    return clamp(v).toFixed(1);
  }

  function readSaved() {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null || raw === undefined || raw === "") return 1.0;
      return clamp(raw);
    } catch (e) {
      return 1.0;
    }
  }

  function apply(v) {
    const value = clamp(v);
    input.value = String(value);
    valueEl.textContent = format(value);
    document.documentElement.style.setProperty("--graph-line-thickness-factor", String(value));
  }

  apply(readSaved());

  input.addEventListener("input", () => {
    apply(input.value);
  });

  input.addEventListener("change", () => {
    const value = clamp(input.value);
    try {
      localStorage.setItem(key, String(value));
    } catch (e) {}
    if (typeof window.appToast === "function") {
      window.appToast("Товщину ліній графу збережено.", "info", 1700);
    }
  });
})();

