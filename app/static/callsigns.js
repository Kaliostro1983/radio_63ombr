(function () {
  function $(id) {
    return document.getElementById(id);
  }

  const elFreq = $("csFreq");
  const elDays = $("csDays");
  const elShow = $("csShow");
  const elInfo = $("csInfo");
  const elTbody = $("csTbody");

  const tabFreq = $("csTabFreq");
  const tabSearch = $("csTabSearch");
  const tabLinks = $("csTabLinks");
  const paneFreq = $("csPaneFreq");
  const paneSearch = $("csPaneSearch");
  const paneLinks = $("csPaneLinks");

  const elQuery = $("csQuery");
  const elSearch = $("csSearch");
  const elAdd = $("csAdd");
  const elSearchInfo = $("csSearchInfo");
  const elSearchTbody = $("csSearchTbody");

  // Links tab
  const elLinkFreq = $("csLinkFreq");
  const elLinkNetworkId = $("csLinkNetworkId");
  const elLinkCallsign = $("csLinkCallsign");
  const elLinkCallsignId = $("csLinkCallsignId");
  const elLinkDays = $("csLinkDays");
  const elLinkAdvanced = $("csLinkAdvanced");
  const elLinkShow = $("csLinkShow");
  const elLinkInfo = $("csLinkInfo");
  const elLinkGraphOut = $("csLinkGraphOut");

  let acBox = null;
  let acItems = [];
  let acIndex = -1;
  let acTarget = null; // "net" | "cs"

  function closeAc() {
    if (acBox) acBox.remove();
    acBox = null;
    acItems = [];
    acIndex = -1;
    acTarget = null;
  }

  function highlightAc() {
    if (!acBox) return;
    const items = acBox.querySelectorAll(".callsign-autocomplete__item");
    items.forEach((el, idx) => el.classList.toggle("is-selected", idx === acIndex));
  }

  function showAc(inputEl, items, target) {
    closeAc();
    if (!inputEl || !items || !items.length) return;
    const wrap = inputEl.closest(".home-freq-input-wrap");
    if (!wrap) return;
    acBox = document.createElement("div");
    acBox.className = "callsign-autocomplete";
    acItems = items;
    acIndex = -1;
    acTarget = target;
    acBox.innerHTML = items
      .map((it, idx) => {
        const label = target === "net"
          ? `${it.frequency || ""}${it.mask ? " / " + it.mask : ""} — ${it.unit || ""}`.trim()
          : `${it.name || ""}`;
        const icon = (target === "cs")
          ? `<img class="callsign-chip__icon" src="/static/icons/callsign_statuses/${it.status_id || "_default"}.svg" alt="">`
          : "";
        return `<button type="button" class="callsign-autocomplete__item" data-index="${idx}">${icon}${escapeHtml(label)}</button>`;
      })
      .join("");
    wrap.appendChild(acBox);
  }

  async function lookupNetworks(q) {
    const qs = String(q || "").trim();
    if (!qs || qs.length < 2) { closeAc(); return; }
    try {
      const resp = await fetch(`/api/networks/lookup?q=${encodeURIComponent(qs)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data.ok) return;
      const rows = Array.isArray(data.rows) ? data.rows : [];
      showAc(elLinkFreq, rows, "net");
    } catch (e) {
      closeAc();
    }
  }

  async function lookupCallsigns(q) {
    const qs = String(q || "").trim();
    if (!qs || qs.length < 2) { closeAc(); return; }
    try {
      let url = `/api/callsigns/autocomplete?q=${encodeURIComponent(qs)}`;
      const nid = elLinkNetworkId && elLinkNetworkId.value ? Number(elLinkNetworkId.value) : 0;
      if (nid) url += `&network_id=${encodeURIComponent(nid)}`;
      const resp = await fetch(url);
      if (!resp.ok) return;
      const data = await resp.json();
      const rows = Array.isArray(data.items) ? data.items : [];
      showAc(elLinkCallsign, rows, "cs");
    } catch (e) {
      closeAc();
    }
  }

  function buildSvg(width, height) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", String(height));
    svg.classList.add("net-graph-svg");
    return svg;
  }

  function attachPanZoom(svg, width, height) {
    const vb = { x: 0, y: 0, w: width, h: height };
    let drag = null;
    function setVb() { svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`); }
    function svgPoint(evt) {
      const rect = svg.getBoundingClientRect();
      const sx = (evt.clientX - rect.left) / rect.width;
      const sy = (evt.clientY - rect.top) / rect.height;
      return { x: vb.x + sx * vb.w, y: vb.y + sy * vb.h };
    }
    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const p = svgPoint(e);
      const zoom = e.deltaY > 0 ? 1.12 : 0.89;
      const nw = Math.max(240, Math.min(width * 6, vb.w * zoom));
      const nh = Math.max(240, Math.min(height * 6, vb.h * zoom));
      const kx = (p.x - vb.x) / vb.w;
      const ky = (p.y - vb.y) / vb.h;
      vb.x = p.x - kx * nw;
      vb.y = p.y - ky * nh;
      vb.w = nw; vb.h = nh;
      setVb();
    }, { passive: false });
    svg.addEventListener("mousedown", (e) => { if (e.button === 0) drag = { p: svgPoint(e), x: vb.x, y: vb.y }; });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const p2 = svgPoint(e);
      vb.x = drag.x + (drag.p.x - p2.x);
      vb.y = drag.y + (drag.p.y - p2.y);
      setVb();
    });
    window.addEventListener("mouseup", () => { drag = null; });
    setVb();
  }

  function forceLayout(nodes, edges, width, height, centerId) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    nodes.forEach((n) => {
      n.x = (Math.random() * 0.8 + 0.1) * width;
      n.y = (Math.random() * 0.8 + 0.1) * height;
      n.vx = 0; n.vy = 0;
    });
    const center = byId.get(centerId);
    if (center) { center.x = width / 2; center.y = height / 2; }

    const links = edges
      .map((e) => ({ a: byId.get(e.source), b: byId.get(e.target), w: Math.max(1, Number(e.cnt || 1)) }))
      .filter((l) => l.a && l.b);

    const kLink = 0.0022;
    const kRepel = 5200;
    const kCenter = 0.0006;
    const damping = 0.86;
    const minDist = 34;
    const margin = 170;

    function step() {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy + 0.01;
          const f = kRepel / d2;
          const inv = 1 / Math.sqrt(d2);
          a.vx += dx * inv * f; a.vy += dy * inv * f;
          b.vx -= dx * inv * f; b.vy -= dy * inv * f;
        }
      }
      links.forEach((l) => {
        const a = l.a, b = l.b;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
        const target = 140 + Math.min(160, l.w * 4);
        const f = (dist - target) * kLink;
        const fx = (dx / dist) * f, fy = (dy / dist) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      });
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
          if (dist >= minDist) continue;
          const push = (minDist - dist) * 0.08;
          const px = (dx / dist) * push, py = (dy / dist) * push;
          a.vx -= px; a.vy -= py;
          b.vx += px; b.vy += py;
        }
      }
      const cx = width / 2, cy = height / 2;
      nodes.forEach((n) => {
        n.vx += (cx - n.x) * kCenter;
        n.vy += (cy - n.y) * kCenter;
        n.vx *= damping; n.vy *= damping;
        n.x += n.vx; n.y += n.vy;
        n.x = Math.max(margin, Math.min(width - margin, n.x));
        n.y = Math.max(22, Math.min(height - 22, n.y));
      });
      if (center) { center.x = width / 2; center.y = height / 2; center.vx = 0; center.vy = 0; }
    }

    return { step, links };
  }

  function drawLinksGraph(data) {
    if (!elLinkGraphOut) return;
    const nodes = Array.isArray(data.nodes) ? data.nodes.slice(0) : [];
    const edges = Array.isArray(data.edges) ? data.edges.slice(0) : [];
    const centerId = Number(data.center_id || 0);
    if (!nodes.length || !centerId) {
      elLinkGraphOut.innerHTML = `<div class="small" style="opacity:.85">Немає даних.</div>`;
      return;
    }
    elLinkGraphOut.innerHTML = "";
    const width = elLinkGraphOut.clientWidth ? Math.max(520, elLinkGraphOut.clientWidth) : 900;
    const height = 520;
    const svg = buildSvg(width, height);
    elLinkGraphOut.appendChild(svg);
    attachPanZoom(svg, width, height);

    const gLinks = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const gNodes = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(gLinks); svg.appendChild(gNodes);

    const layout = forceLayout(nodes, edges, width, height, centerId);

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const linkEls = layout.links.map((l) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.classList.add("net-graph-link");
      const w = Math.min(6, 1 + Math.log10(1 + (l.w || 1)) * 2);
      line.style.strokeWidth = String(w);
      gLinks.appendChild(line);
      return { line, l };
    });

    const nodeEls = nodes.map((n) => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.classList.add("net-graph-node");
      const isCenter = n.id === centerId;

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", isCenter ? "18" : "14");
      circle.classList.add("net-graph-node__dot");
      if (isCenter) circle.classList.add("net-graph-node__dot--center");
      g.appendChild(circle);

      const img = document.createElementNS("http://www.w3.org/2000/svg", "image");
      img.setAttribute("href", n.icon || "/static/icons/callsign_statuses/_default.svg");
      img.setAttribute("x", isCenter ? "-12" : "-10");
      img.setAttribute("y", isCenter ? "-12" : "-10");
      img.setAttribute("width", isCenter ? "24" : "20");
      img.setAttribute("height", isCenter ? "24" : "20");
      g.appendChild(img);

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.textContent = n.name || "";
      text.setAttribute("y", "5");
      text.classList.add("net-graph-node__label");
      g.appendChild(text);

      g.addEventListener("click", () => {
        if (window.openCallsignEditModalById) window.openCallsignEditModalById(Number(n.id));
      });

      gNodes.appendChild(g);
      return { g, n };
    });

    let ticks = 0;
    function tick() {
      layout.step();
      linkEls.forEach(({ line, l }) => {
        line.setAttribute("x1", String(l.a.x));
        line.setAttribute("y1", String(l.a.y));
        line.setAttribute("x2", String(l.b.x));
        line.setAttribute("y2", String(l.b.y));
      });
      nodeEls.forEach(({ g, n }) => {
        const label = g.querySelector(".net-graph-node__label");
        if (label) {
          if (n.x > width - 210) {
            label.setAttribute("x", "-18");
            label.setAttribute("text-anchor", "end");
          } else {
            label.setAttribute("x", "18");
            label.setAttribute("text-anchor", "start");
          }
        }
        g.setAttribute("transform", `translate(${n.x},${n.y})`);
      });
      ticks += 1;
      if (ticks < 340) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function setInfo(text) {
    if (elInfo) elInfo.textContent = text || "";
  }

  function setSearchInfo(text) {
    if (elSearchInfo) elSearchInfo.textContent = text || "";
  }

  function escapeHtml(s) {
    return (s || "").replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  function renderCallsignNameCell(row) {
    return `
      <div class="callsign-name" style="font-weight:700">
        <img
          class="callsign-ico"
          src="/static/icons/callsign_statuses/${row.status_id || "_default"}.svg"
          alt=""
        >
        <span>${escapeHtml(row.name || "")}</span>
      </div>
    `;
  }

  function updateRowInFreqTable(updated) {
    if (!elTbody) return;
    const tr = elTbody.querySelector(
      `tr[data-callsign-id="${updated.callsign_id}"]`
    );
    if (!tr) return;

    tr.children[1].innerHTML = renderCallsignNameCell(updated);
    tr.children[2].textContent = updated.status_label || "";
    tr.children[3].textContent = updated.source_label || "";
    tr.children[4].textContent = updated.comment || "";
    tr.dataset.row = JSON.stringify(updated);
  }

  function updateRowInSearchTable(updated) {
    if (!elSearchTbody) return;
    const tr = elSearchTbody.querySelector(
      `tr[data-callsign-id="${updated.callsign_id}"]`
    );
    if (!tr) return;

    tr.children[1].innerHTML = renderCallsignNameCell(updated);
    tr.children[2].textContent = updated.status_label || "";
    tr.children[3].textContent = updated.frequency || "Невідомо";
    tr.children[4].textContent = updated.unit || "Невідомо";
    tr.dataset.row = JSON.stringify(updated);
  }

  function updateRowInTables(updated) {
    updateRowInFreqTable(updated);
    updateRowInSearchTable(updated);
  }

  function renderTable(rows) {
    if (!rows || rows.length === 0) {
      elTbody.innerHTML =
        '<tr><td colspan="5" class="small" style="opacity:.8">Нічого не знайдено.</td></tr>';
      return;
    }

    elTbody.innerHTML = "";
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      tr.dataset.callsignId = row.callsign_id;
      tr.dataset.row = JSON.stringify(row);

      const statusText = row.status_label || "";
      const sourceText = row.source_label || "";

      tr.innerHTML = `
        <td>${row.n}</td>
        <td>${renderCallsignNameCell(row)}</td>
        <td>${escapeHtml(statusText)}</td>
        <td>${escapeHtml(sourceText)}</td>
        <td>${escapeHtml(row.comment || "")}</td>
      `;

      tr.addEventListener("click", () => {
        if (window.openCallsignEditModalById) {
          window.openCallsignEditModalById(row.callsign_id);
        }
      });
      elTbody.appendChild(tr);
    });
  }

  function renderSearchTable(rows) {
    if (!rows || rows.length === 0) {
      elSearchTbody.innerHTML =
        '<tr><td colspan="5" class="small" style="opacity:.8">Нічого не знайдено.</td></tr>';
      return;
    }

    elSearchTbody.innerHTML = "";
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      tr.dataset.callsignId = row.callsign_id;
      tr.dataset.row = JSON.stringify(row);

      const statusText = row.status_label || "";
      tr.innerHTML = `
        <td>${row.n}</td>
        <td>${renderCallsignNameCell(row)}</td>
        <td>${escapeHtml(statusText)}</td>
        <td>${escapeHtml(row.frequency || "Невідомо")}</td>
        <td>${escapeHtml(row.unit || "Невідомо")}</td>
      `;

      tr.addEventListener("click", () => {
        if (window.openCallsignEditModalById) {
          window.openCallsignEditModalById(row.callsign_id);
        }
      });
      elSearchTbody.appendChild(tr);
    });
  }

  async function runQuery() {
    const frequency = (elFreq.value || "").trim();
    const days = (elDays.value || "7").trim();

    if (!frequency) {
      setInfo("Вкажіть частоту");
      return;
    }

    setInfo("Завантаження...");

    try {
      const url = `/api/callsigns/by-frequency?frequency=${encodeURIComponent(frequency)}&days=${encodeURIComponent(days)}`;
      const r = await fetch(url);

      if (!r.ok) throw new Error("HTTP " + r.status);

      const data = await r.json();

      if (!data.ok) {
        setInfo("Помилка");
        elTbody.innerHTML = `<tr><td colspan="5" class="small" style="color:var(--danger)">${escapeHtml(data.error || "Помилка")}</td></tr>`;
        return;
      }

      const rows = data.rows || [];
      if (rows.length === 0 && data.message) {
        setInfo(data.message);
        elTbody.innerHTML = `<tr><td colspan="5" class="small" style="opacity:.85">${escapeHtml(data.message)}</td></tr>`;
        return;
      }

      setInfo(`Знайдено: ${rows.length}`);
      renderTable(rows);
    } catch (e) {
      console.error(e);
      setInfo("Помилка запиту");
      elTbody.innerHTML = `<tr><td colspan="5" class="small" style="color:var(--danger)">Помилка запиту. Перевірте лог сервера.</td></tr>`;
    }
  }

  async function runSearch() {
    let q = (elQuery.value || "").trim();
    q = q.toUpperCase();
    elQuery.value = q;

    if (!q) {
      setSearchInfo("Вкажіть позивний");
      return;
    }

    setSearchInfo("Завантаження...");

    try {
      const url = `/api/callsigns/search?q=${encodeURIComponent(q)}`;
      const r = await fetch(url);

      if (!r.ok) throw new Error("HTTP " + r.status);

      const data = await r.json();

      if (!data.ok) {
        setSearchInfo("Помилка");
        elSearchTbody.innerHTML = `<tr><td colspan="5" class="small" style="color:var(--danger)">${escapeHtml(data.error || "Помилка")}</td></tr>`;
        return;
      }

      const rows = data.rows || [];
      setSearchInfo(`Знайдено: ${rows.length}`);
      renderSearchTable(rows);
    } catch (e) {
      console.error(e);
      setSearchInfo("Помилка запиту");
      elSearchTbody.innerHTML = `<tr><td colspan="5" class="small" style="color:var(--danger)">Помилка запиту. Перевірте лог сервера.</td></tr>`;
    }
  }

  function setTab(which) {
    const isFreq = which === "freq";
    const isSearch = which === "search";
    const isLinks = which === "links";

    if (tabFreq) {
      tabFreq.classList.toggle("active", isFreq);
      tabFreq.setAttribute("aria-selected", isFreq ? "true" : "false");
    }
    if (tabSearch) {
      tabSearch.classList.toggle("active", isSearch);
      tabSearch.setAttribute("aria-selected", isSearch ? "true" : "false");
    }
    if (tabLinks) {
      tabLinks.classList.toggle("active", isLinks);
      tabLinks.setAttribute("aria-selected", isLinks ? "true" : "false");
    }

    if (paneFreq) paneFreq.classList.toggle("hidden", !isFreq);
    if (paneSearch) paneSearch.classList.toggle("hidden", !isSearch);
    if (paneLinks) paneLinks.classList.toggle("hidden", !isLinks);

    if (!isFreq) setInfo("");
    if (!isSearch) setSearchInfo("");
    if (!isLinks && elLinkInfo) elLinkInfo.textContent = "";
  }

  async function runLinks() {
    if (!elLinkCallsignId || !elLinkCallsignId.value) {
      if (elLinkInfo) elLinkInfo.textContent = "Обери позивний зі списку.";
      return;
    }
    const cid = Number(elLinkCallsignId.value || 0);
    const days = Math.max(1, Math.min(365, Number((elLinkDays && elLinkDays.value) || 14)));
    const adv = elLinkAdvanced && elLinkAdvanced.checked ? 1 : 0;
    if (elLinkInfo) elLinkInfo.textContent = "Завантаження графа…";
    if (elLinkGraphOut) elLinkGraphOut.innerHTML = `<div class="small" style="opacity:.85">Завантаження…</div>`;
    try {
      const resp = await fetch(`/api/callsigns/${encodeURIComponent(cid)}/graph?days=${encodeURIComponent(days)}&advanced=${encodeURIComponent(adv)}`);
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error("bad response");
      if (elLinkInfo) elLinkInfo.textContent = `Вузлів: ${(data.nodes || []).length}, зв'язків: ${(data.edges || []).length}`;
      drawLinksGraph(data);
    } catch (e) {
      if (elLinkInfo) elLinkInfo.textContent = "Не вдалося завантажити граф.";
    }
  }

  async function applyLinksQueryParams() {
    if (!tabLinks || !paneLinks) return;
    const qs = new URLSearchParams(window.location.search);
    const tab = (qs.get("tab") || "").trim().toLowerCase();
    if (tab !== "links") return;

    setTab("links");

    const days = Number(qs.get("days") || "14") || 14;
    const adv = (qs.get("advanced") || "0") === "1";
    const callsignId = Number(qs.get("callsign_id") || "0") || 0;

    if (elLinkDays) elLinkDays.value = String(Math.max(1, Math.min(365, days)));
    if (elLinkAdvanced) elLinkAdvanced.checked = adv;

    if (callsignId && elLinkCallsignId && elLinkCallsign) {
      try {
        const r = await fetch(`/api/callsigns/by-id?id=${encodeURIComponent(callsignId)}`);
        const data = await r.json();
        if (data && data.ok && data.row) {
          elLinkCallsignId.value = String(data.row.callsign_id || callsignId);
          elLinkCallsign.value = String(data.row.name || "").trim();
          if (elLinkNetworkId) elLinkNetworkId.value = String(data.row.network_id || "");
          // Fill frequency field if we have it.
          if (elLinkFreq) {
            const freq = String(data.row.frequency || "").trim();
            const unit = String(data.row.unit || "").trim();
            elLinkFreq.value = freq || "";
            if (unit && elLinkInfo) elLinkInfo.textContent = `р/м: ${unit}`;
          }
          await runLinks();
        }
      } catch (e) {
        // ignore
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (!elShow) return;

    if (window.setCallsignModalOnSave) {
      window.setCallsignModalOnSave(updateRowInTables);
    }

    if (tabFreq) tabFreq.addEventListener("click", () => setTab("freq"));
    if (tabSearch) tabSearch.addEventListener("click", () => setTab("search"));
    if (tabLinks) tabLinks.addEventListener("click", () => setTab("links"));

    elShow.addEventListener("click", runQuery);
    if (elFreq) elFreq.addEventListener("keydown", (e) => { if (e.key === "Enter") runQuery(); });
    if (elDays) elDays.addEventListener("keydown", (e) => { if (e.key === "Enter") runQuery(); });

    if (elSearch) elSearch.addEventListener("click", runSearch);
    if (elAdd) {
      elAdd.addEventListener("click", () => {
        if (window.openCallsignCreateModal) window.openCallsignCreateModal();
      });
    }

    if (elQuery) elQuery.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
    if (elQuery) {
      elQuery.addEventListener("blur", () => {
        const v = (elQuery.value || "").trim().toUpperCase();
        elQuery.value = v;
      });
    }
    // Links tab events
    let netTimer = null;
    if (elLinkFreq) {
      elLinkFreq.addEventListener("input", () => {
        clearTimeout(netTimer);
        elLinkNetworkId.value = "";
        netTimer = setTimeout(() => lookupNetworks(elLinkFreq.value), 200);
      });
      elLinkFreq.addEventListener("keydown", (e) => {
        if (!acBox) return;
        if (e.key === "ArrowDown") { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; highlightAc(); }
        if (e.key === "ArrowUp") { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; highlightAc(); }
        if (e.key === "Escape") closeAc();
        if (e.key === "Enter") {
          if (acItems.length && acIndex >= 0 && acItems[acIndex] && acTarget === "net") {
            e.preventDefault();
            const it = acItems[acIndex];
            elLinkNetworkId.value = String(it.id || "");
            elLinkFreq.value = String(it.frequency || it.mask || "").trim();
            closeAc();
          }
        }
      });
    }

    let csTimer = null;
    if (elLinkCallsign) {
      elLinkCallsign.addEventListener("input", () => {
        clearTimeout(csTimer);
        elLinkCallsignId.value = "";
        csTimer = setTimeout(() => lookupCallsigns(elLinkCallsign.value), 180);
      });
      elLinkCallsign.addEventListener("keydown", (e) => {
        if (!acBox) return;
        if (e.key === "ArrowDown") { e.preventDefault(); acIndex = (acIndex + 1) % acItems.length; highlightAc(); }
        if (e.key === "ArrowUp") { e.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; highlightAc(); }
        if (e.key === "Escape") closeAc();
        if (e.key === "Enter") {
          if (acItems.length && acIndex >= 0 && acItems[acIndex] && acTarget === "cs") {
            e.preventDefault();
            const it = acItems[acIndex];
            elLinkCallsignId.value = String(it.id || "");
            elLinkCallsign.value = String(it.name || "").trim();
            closeAc();
          }
        }
      });
    }

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".home-freq-input-wrap")) closeAc();
      const btn = e.target.closest(".callsign-autocomplete__item");
      if (!btn || !acBox) return;
      const idx = Number(btn.dataset.index || -1);
      const it = (idx >= 0 && acItems[idx]) ? acItems[idx] : null;
      if (!it) return;
      if (acTarget === "net" && elLinkFreq && elLinkNetworkId) {
        elLinkNetworkId.value = String(it.id || "");
        elLinkFreq.value = String(it.frequency || it.mask || "").trim();
      }
      if (acTarget === "cs" && elLinkCallsign && elLinkCallsignId) {
        elLinkCallsignId.value = String(it.id || "");
        elLinkCallsign.value = String(it.name || "").trim();
      }
      closeAc();
    });

    if (elLinkShow) elLinkShow.addEventListener("click", runLinks);

    applyLinksQueryParams();
  });

  window.addEventListener("callsignModalDeleted", function () {
    // Easiest safe approach: reload to avoid stale UI state.
    window.location.reload();
  });
})();
