document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("searchForm");
  const results = document.getElementById("results");
  const warning = document.getElementById("warning");
  const loadingEl = document.getElementById("loading");

  if (!form || !results || !warning) {
    console.warn("intercepts_search: required elements not found");
    return;
  }

  let offset = 0;
  const limit = 50;

  function debounce(fn, ms) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

  function highlight(text, phrase) {
    text = text ?? "";
    phrase = (phrase ?? "").trim();
    if (!phrase) return document.createTextNode(text);

    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "gi");

    const frag = document.createDocumentFragment();
    let last = 0;
    let m;

    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;

      if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));

      const span = document.createElement("span");
      span.className = "hl";
      span.textContent = text.slice(start, end);
      frag.appendChild(span);

      last = end;
      if (re.lastIndex === m.index) re.lastIndex++; // safety
    }

    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function formatDate(iso){
    if(!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso; // fallback
    return d.toLocaleString("uk-UA", {
        year:"numeric", month:"2-digit", day:"2-digit",
        hour:"2-digit", minute:"2-digit"
    });
    }

  function renderItem(item, phrase) {
    const card = document.createElement("div");
    card.className = "intercept-card";

    card.style.cursor = "pointer";
    card.addEventListener("click", (e) => {
    // якщо натиснули саме на лінк — нехай лінк працює
    const a = e.target.closest("a");
    if (a) return;

    // якщо користувач виділяє текст — не переходимо
    const sel = window.getSelection?.();
    if (sel && String(sel).length > 0) return;

    window.location.href = "/messages/" + item.id;
    });

    const header = document.createElement("div");
    header.className = "intercept-header";
    header.textContent = `${formatDate(item.created_at)}   ${item.frequency ?? ""}`;
    card.appendChild(header);

    const body = document.createElement("div");
    body.className = "intercept-body";
    body.appendChild(highlight(item.preview ?? "", phrase));
    card.appendChild(body);

    if (item.net_description) {
      const meta = document.createElement("div");
      meta.className = "intercept-meta";
      meta.textContent = item.net_description;
      card.appendChild(meta);
    }

    const open = document.createElement("a");
    open.href = "/messages/" + item.id;
    open.textContent = "Відкрити";
    open.style.display = "inline-block";
    open.style.marginTop = "6px";
    card.appendChild(open);

    return card;
  }

  async function loadData(reset) {
    const phrase = document.getElementById("phrase")?.value?.trim() || "";
    const frequency = document.getElementById("frequency")?.value?.trim() || "";
    const days = document.getElementById("days")?.value || "7";

    if (reset) {
      offset = 0;
      results.innerHTML = "";
    }

    const params = new URLSearchParams({
      phrase,
      frequency,
      days,
      limit: String(limit),
      offset: String(offset),
    });

    const res = await fetch("/api/intercepts/search?" + params.toString());
    if (!res.ok) {
      warning.innerText = `Помилка API: HTTP ${res.status}`;
      return;
    }

    const data = await res.json();

    warning.innerText = data.warning || "";

    const items = data.items || [];
    items.forEach((it) => results.appendChild(renderItem(it, phrase)));

    offset += items.length;
  }

  function debounce(fn, ms){
    let t;
    return (...args)=>{
        clearTimeout(t);
        t = setTimeout(()=>fn(...args), ms);
    };
}

const phraseEl = document.getElementById("phrase");
const freqEl = document.getElementById("frequency");
const daysEl = document.getElementById("days");

const autoSearch = debounce(()=>{
    const ev = new Event("submit",{cancelable:true});
    form.dispatchEvent(ev);
},400);

phraseEl?.addEventListener("input", autoSearch);
freqEl?.addEventListener("input", autoSearch);
daysEl?.addEventListener("change", autoSearch);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    loadData(true).catch((err) => {
      console.error(err);
      warning.innerText = "Помилка пошуку (див. консоль).";
    });
  });
});

// ===== lazy loading (нескінченний скрол) =====

let loading = false;

async function loadMore() {
  if (loading) return;
  loading = true;

  try {
    loadingEl.style.display = "block";
    await loadData(false);
  } catch (e) {
    console.error(e);
  } finally {
    loadingEl.style.display = "none";
    loading = false;
  }
}

window.addEventListener("scroll", () => {

    const scrollTop = window.scrollY;
    const windowHeight = window.innerHeight;
    const fullHeight = document.body.offsetHeight;

    // коли залишилось ~400px до кінця сторінки
    if(scrollTop + windowHeight > fullHeight - 400){

        loadMore();

    }

});