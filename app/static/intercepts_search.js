// static/intercepts_search.js
// заміни файл повністю

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("searchForm");
  const phraseInput = document.getElementById("phrase");
  const frequencyInput = document.getElementById("frequency");
  const daysInput = document.getElementById("days");
  const results = document.getElementById("results");
  const warning = document.getElementById("warning");
  const loadingEl = document.getElementById("loading");

  if (!form || !results || !warning || !loadingEl) {
    return;
  }

  let offset = 0;
  const limit = 50;
  let loading = false;
  let reachedEnd = false;

  function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function highlightText(text, phrase) {
    const value = String(text ?? "");
    const query = String(phrase ?? "").trim();

    if (!query) {
      return document.createTextNode(value);
    }

    const re = new RegExp(escapeRegExp(query), "gi");
    const fragment = document.createDocumentFragment();

    let lastIndex = 0;
    let match = null;

    while ((match = re.exec(value)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      if (start > lastIndex) {
        fragment.appendChild(document.createTextNode(value.slice(lastIndex, start)));
      }

      const span = document.createElement("span");
      span.className = "hl";
      span.textContent = value.slice(start, end);
      fragment.appendChild(span);

      lastIndex = end;

      if (re.lastIndex === match.index) {
        re.lastIndex += 1;
      }
    }

    if (lastIndex < value.length) {
      fragment.appendChild(document.createTextNode(value.slice(lastIndex)));
    }

    return fragment;
  }

  function formatDate(value) {
    if (!value) return "";

    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) {
      return String(value);
    }

    return dt.toLocaleString("uk-UA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function normalizeLines(text) {
    const raw = String(text ?? "");

    return raw
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function buildFormattedText(item) {
    const parts = [];

    if (item.callsign_sender) parts.push(item.callsign_sender);
    if (item.callsign_receiver) parts.push(item.callsign_receiver);

    if (item.text) parts.push(normalizeLines(item.text));
    else if (item.preview) parts.push(normalizeLines(item.preview));

    return parts.filter(Boolean).join("\n");
  }

  function renderTextBlock(text, phrase) {
    const wrapper = document.createElement("div");
    wrapper.className = "intercept-text";

    const lines = normalizeLines(text).split("\n");

    for (const line of lines) {
      const lineEl = document.createElement("div");
      lineEl.className = "intercept-line";

      if (line.trim() === "") {
        lineEl.innerHTML = "&nbsp;";
      } else {
        lineEl.appendChild(highlightText(line, phrase));
      }

      wrapper.appendChild(lineEl);
    }

    return wrapper;
  }

  function renderHeader(item) {
    const header = document.createElement("div");
    header.className = "intercept-header";

    const dateEl = document.createElement("div");
    dateEl.className = "intercept-datetime";
    dateEl.textContent = formatDate(item.created_at);

    const freqEl = document.createElement("div");
    freqEl.className = "intercept-frequency";
    freqEl.textContent = item.frequency ? String(item.frequency) : "";

    header.appendChild(dateEl);
    header.appendChild(freqEl);

    return header;
  }

  function renderMeta(item) {
    const meta = document.createElement("div");
    meta.className = "intercept-meta";

    const parts = [];
    if (item.net_description) parts.push(item.net_description);
    if (item.location_name) parts.push(item.location_name);

    meta.textContent = parts.join(" ");
    return meta;
  }

  function renderItem(item, phrase) {
    const card = document.createElement("article");
    card.className = "intercept-card";

    card.appendChild(renderHeader(item));

    const meta = renderMeta(item);
    if (meta.textContent.trim()) {
      card.appendChild(meta);
    }

    const textBlock = renderTextBlock(buildFormattedText(item), phrase);
    card.appendChild(textBlock);

    const open = document.createElement("a");
    open.className = "intercept-open-link";
    open.href = `/messages/${item.id}`;
    open.textContent = "Відкрити";
    card.appendChild(open);

    card.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;

      const selection = window.getSelection?.();
      if (selection && String(selection).trim()) return;

      window.location.href = `/messages/${item.id}`;
    });

    return card;
  }

  function setWarning(message) {
    const value = String(message || "").trim();
    warning.textContent = value;
    warning.style.display = value ? "block" : "none";
  }

  async function loadData(reset = false) {
    /* Один активний запит: інакше scroll «догрузка» може стартувати паралельно з submit і двічі взяти offset=0. */
    if (loading) {
      return;
    }

    const phrase = phraseInput?.value?.trim() || "";
    const frequency = frequencyInput?.value?.trim() || "";
    const days = daysInput?.value || "70";

    if (reset) {
      offset = 0;
      reachedEnd = false;
      results.innerHTML = "";
    }

    if (!phrase && !frequency) {
      setWarning("Вкажи слово або частоту/маску для пошуку.");
      return;
    }

    loading = true;
    loadingEl.style.display = "block";

    try {
      setWarning("");

      const params = new URLSearchParams({
        phrase,
        frequency,
        days: String(days),
        limit: String(limit),
        offset: String(offset),
      });

      const response = await fetch(`/api/intercepts/search?${params.toString()}`);
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.detail || `HTTP ${response.status}`);
      }

      if (data?.warning) {
        setWarning(data.warning);
      }

      const items = Array.isArray(data?.items) ? data.items : [];
      items.forEach((item) => results.appendChild(renderItem(item, phrase)));

      offset += items.length;
      reachedEnd = items.length < limit;
    } catch (error) {
      console.error(error);
      throw error;
    } finally {
      loading = false;
      loadingEl.style.display = "none";
    }
  }

  async function loadMore() {
    if (loading || reachedEnd) {
      return;
    }

    try {
      await loadData(false);
    } catch (error) {
      console.error(error);
      setWarning(error.message || "Помилка дозавантаження.");
    }
  }

  const autoSearch = debounce(() => {
    form.requestSubmit();
  }, 350);

  phraseInput?.addEventListener("input", autoSearch);
  frequencyInput?.addEventListener("input", autoSearch);
  daysInput?.addEventListener("change", autoSearch);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    try {
      await loadData(true);
    } catch (error) {
      console.error(error);
      setWarning(error.message || "Помилка пошуку.");
    }
  });

  window.addEventListener("scroll", () => {
    const scrollBottom = window.scrollY + window.innerHeight;
    const threshold = document.body.offsetHeight - 400;

    if (scrollBottom >= threshold) {
      loadMore();
    }
  });
});