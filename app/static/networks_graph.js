(function () {
  function $(id) { return document.getElementById(id); }

  const root = $("netCallsignGraph");
  if (!root) return;

  const daysInput = $("netGraphDays");
  const btn = $("netGraphShow");
  const btnCallsignList = $("netGraphCallsignList");
  const out = $("netGraphOut");

  const networkId = Number(root.getAttribute("data-network-id") || 0);
  const networkFrequency = String(root.getAttribute("data-frequency") || "").trim();
  if (!networkId || !btn || !daysInput || !out) return;

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderEmpty(msg) {
    out.innerHTML = `<div class="small" style="opacity:.85">${escapeHtml(msg)}</div>`;
  }

  function buildSvg(width, height) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", String(height));
    svg.classList.add("net-graph-svg");
    return svg;
  }

  function forceLayout(nodes, edges, width, height) {
    // Very small force layout without external deps.
    const byId = new Map(nodes.map((n) => [n.id, n]));
    nodes.forEach((n) => {
      n.x = (Math.random() * 0.8 + 0.1) * width;
      n.y = (Math.random() * 0.8 + 0.1) * height;
      n.vx = 0;
      n.vy = 0;
    });

    const links = edges
      .map((e) => ({ a: byId.get(e.source), b: byId.get(e.target), w: Math.max(1, Number(e.cnt || 1)) }))
      .filter((l) => l.a && l.b);

    // Weaker repulsion + mild center pull reduces edge-piling when many nodes.
    const kLink = 0.0022;
    const kRepel = 2400;
    const kCenter = 0.00045;
    const damping = 0.86;
    const minDist = 34; // collision distance between nodes
    const margin = 170; // keep room for labels inside viewBox

    function step() {
      // repulsion
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy + 0.01;
          const f = kRepel / d2;
          a.vx += (dx / Math.sqrt(d2)) * f;
          a.vy += (dy / Math.sqrt(d2)) * f;
          b.vx -= (dx / Math.sqrt(d2)) * f;
          b.vy -= (dy / Math.sqrt(d2)) * f;
        }
      }

      // link attraction
      links.forEach((l) => {
        const a = l.a, b = l.b;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
        const target = 140 + Math.min(160, l.w * 4);
        const f = (dist - target) * kLink;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      });

      // simple collision separation
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
          if (dist >= minDist) continue;
          const push = (minDist - dist) * 0.08;
          const px = (dx / dist) * push;
          const py = (dy / dist) * push;
          a.vx -= px;
          a.vy -= py;
          b.vx += px;
          b.vy += py;
        }
      }

      // center gravity + integrate
      const cx = width / 2, cy = height / 2;
      nodes.forEach((n) => {
        n.vx += (cx - n.x) * kCenter;
        n.vy += (cy - n.y) * kCenter;
        n.vx *= damping;
        n.vy *= damping;
        n.x += n.vx;
        n.y += n.vy;
        n.x = Math.max(margin, Math.min(width - margin, n.x));
        n.y = Math.max(22, Math.min(height - 22, n.y));
      });
    }

    return { step, links };
  }

  function applyLabelSide(g, n, width) {
    const label = g.querySelector(".net-graph-node__label");
    if (!label) return;
    if (n.x > width - 210) {
      label.setAttribute("x", "-18");
      label.setAttribute("text-anchor", "end");
    } else {
      label.setAttribute("x", "18");
      label.setAttribute("text-anchor", "start");
    }
  }

  function refreshVisuals(linkEls, nodeEls, width) {
    linkEls.forEach(({ line, l }) => {
      line.setAttribute("x1", String(l.a.x));
      line.setAttribute("y1", String(l.a.y));
      line.setAttribute("x2", String(l.b.x));
      line.setAttribute("y2", String(l.b.y));
    });
    nodeEls.forEach(({ g, n }) => {
      applyLabelSide(g, n, width);
      g.setAttribute("transform", `translate(${n.x},${n.y})`);
    });
  }

  function drawGraph(data) {
    const nodes = Array.isArray(data.nodes) ? data.nodes.slice(0) : [];
    const edges = Array.isArray(data.edges) ? data.edges.slice(0) : [];

    if (!nodes.length) {
      if (typeof out._netGraphCleanup === "function") {
        out._netGraphCleanup();
        out._netGraphCleanup = null;
      }
      renderEmpty("Немає позивних за обраний період.");
      return;
    }

    // Limit to keep UI responsive.
    const maxNodes = 140;
    const maxEdges = 220;
    if (nodes.length > maxNodes) nodes.length = maxNodes;
    if (edges.length > maxEdges) edges.length = maxEdges;

    if (typeof out._netGraphCleanup === "function") {
      out._netGraphCleanup();
      out._netGraphCleanup = null;
    }

    out.innerHTML = "";
    const width = out.clientWidth ? Math.max(520, out.clientWidth) : 900;
    const height = 520;
    const svg = buildSvg(width, height);
    out.appendChild(svg);

    const marginX = 170;
    const marginY = 22;
    const vb = { x: 0, y: 0, w: width, h: height };
    let panDrag = null;
    let nodeDrag = null;

    function setVb() {
      svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    }

    function svgPoint(evt) {
      const rect = svg.getBoundingClientRect();
      const sx = (evt.clientX - rect.left) / rect.width;
      const sy = (evt.clientY - rect.top) / rect.height;
      return { x: vb.x + sx * vb.w, y: vb.y + sy * vb.h };
    }

    const gLinks = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const gNodes = document.createElementNS("http://www.w3.org/2000/svg", "g");
    svg.appendChild(gLinks);
    svg.appendChild(gNodes);

    const layout = forceLayout(nodes, edges, width, height);

    const linkEls = layout.links.map((l) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.classList.add("net-graph-link");
      gLinks.appendChild(line);
      return { line, l };
    });

    const nodeEls = nodes.map((n) => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.classList.add("net-graph-node");
      g.setAttribute("data-id", String(n.id));
      g.style.cursor = "grab";

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("r", "14");
      circle.classList.add("net-graph-node__dot");
      g.appendChild(circle);

      const img = document.createElementNS("http://www.w3.org/2000/svg", "image");
      img.setAttribute("href", n.icon || "/static/icons/callsign_statuses/_default.svg");
      img.setAttribute("x", "-10");
      img.setAttribute("y", "-10");
      img.setAttribute("width", "20");
      img.setAttribute("height", "20");
      img.classList.add("net-graph-node__icon");
      g.appendChild(img);

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.textContent = n.name || "";
      text.setAttribute("x", "18");
      text.setAttribute("y", "5");
      text.classList.add("net-graph-node__label");
      g.appendChild(text);

      gNodes.appendChild(g);

      g.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const p = svgPoint(e);
        nodeDrag = {
          n,
          ox: n.x - p.x,
          oy: n.y - p.y,
          g,
          sx: e.clientX,
          sy: e.clientY,
          moved: false,
        };
        g.style.cursor = "grabbing";
      });

      g.addEventListener("click", (e) => {
        if (g.dataset.suppressClick === "1") {
          delete g.dataset.suppressClick;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (window.openCallsignEditModalById) {
          window.openCallsignEditModalById(Number(n.id), { networkId });
        }
      });

      return { g, n };
    });

    function onWindowMove(e) {
      if (nodeDrag) {
        const p = svgPoint(e);
        nodeDrag.n.x = Math.max(marginX, Math.min(width - marginX, p.x + nodeDrag.ox));
        nodeDrag.n.y = Math.max(marginY, Math.min(height - marginY, p.y + nodeDrag.oy));
        if (!nodeDrag.moved && (Math.abs(e.clientX - nodeDrag.sx) > 5 || Math.abs(e.clientY - nodeDrag.sy) > 5)) {
          nodeDrag.moved = true;
        }
        refreshVisuals(linkEls, nodeEls, width);
        return;
      }
      if (!panDrag) return;
      const p2 = svgPoint(e);
      vb.x = panDrag.x + (panDrag.p.x - p2.x);
      vb.y = panDrag.y + (panDrag.p.y - p2.y);
      setVb();
    }

    function onWindowUp() {
      if (nodeDrag) {
        if (nodeDrag.moved) nodeDrag.g.dataset.suppressClick = "1";
        nodeDrag.g.style.cursor = "grab";
        nodeDrag = null;
      }
      panDrag = null;
    }

    svg.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".net-graph-node")) return;
      panDrag = { p: svgPoint(e), x: vb.x, y: vb.y };
    });

    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("mouseup", onWindowUp);
    out._netGraphCleanup = () => {
      window.removeEventListener("mousemove", onWindowMove);
      window.removeEventListener("mouseup", onWindowUp);
    };

    setVb();

    let ticks = 0;
    function tick() {
      layout.step();
      refreshVisuals(linkEls, nodeEls, width);
      ticks += 1;
      if (ticks < 320) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  async function loadGraph() {
    const days = Math.max(1, Math.min(365, Number(daysInput.value || 14)));
    daysInput.value = String(days);
    if (typeof out._netGraphCleanup === "function") {
      out._netGraphCleanup();
      out._netGraphCleanup = null;
    }
    out.innerHTML = `<div class="small" style="opacity:.85">Завантаження графа…</div>`;
    try {
      const resp = await fetch(`/api/networks/${encodeURIComponent(networkId)}/callsign-graph?days=${encodeURIComponent(days)}`, {
        headers: { Accept: "application/json" },
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        renderEmpty("Не вдалося завантажити дані графа.");
        return;
      }
      drawGraph(data);
    } catch (e) {
      renderEmpty("Помилка завантаження графа.");
    }
  }

  btn.addEventListener("click", loadGraph);

  if (btnCallsignList) {
    btnCallsignList.addEventListener("click", () => {
      const days = Math.max(1, Math.min(365, Number(daysInput.value || 14)));
      const qs = new URLSearchParams();
      qs.set("tab", "freq");
      if (networkFrequency) qs.set("frequency", networkFrequency);
      qs.set("days", String(days));
      window.open(`/callsigns?${qs.toString()}`, "_blank");
    });
  }
})();
