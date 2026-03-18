(function () {
  function $(id) { return document.getElementById(id); }

  const root = $("netCallsignGraph");
  if (!root) return;

  const daysInput = $("netGraphDays");
  const btn = $("netGraphShow");
  const out = $("netGraphOut");

  const networkId = Number(root.getAttribute("data-network-id") || 0);
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

  function attachPanZoom(svg, width, height) {
    const vb = { x: 0, y: 0, w: width, h: height };
    let drag = null;

    function setVb() {
      svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    }

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
      vb.w = nw;
      vb.h = nh;
      setVb();
    }, { passive: false });

    svg.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      drag = { p: svgPoint(e), x: vb.x, y: vb.y };
    });
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

    // Tuned to avoid "gravity clumping" (keep nodes more spread out).
    const kLink = 0.0022;
    const kRepel = 5200;
    const kCenter = 0.0006;
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

  function drawGraph(data) {
    const nodes = Array.isArray(data.nodes) ? data.nodes.slice(0) : [];
    const edges = Array.isArray(data.edges) ? data.edges.slice(0) : [];

    if (!nodes.length) {
      renderEmpty("Немає позивних за обраний період.");
      return;
    }

    // Limit to keep UI responsive.
    const maxNodes = 140;
    const maxEdges = 220;
    if (nodes.length > maxNodes) nodes.length = maxNodes;
    if (edges.length > maxEdges) edges.length = maxEdges;

    out.innerHTML = "";
    const width = out.clientWidth ? Math.max(520, out.clientWidth) : 900;
    const height = 520;
    const svg = buildSvg(width, height);
    out.appendChild(svg);
    attachPanZoom(svg, width, height);

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

      g.addEventListener("click", () => {
        if (window.openCallsignEditModalById) {
          window.openCallsignEditModalById(Number(n.id), { networkId });
        }
      });

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
        // Flip labels to the left when near the right edge.
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
      if (ticks < 320) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  async function loadGraph() {
    const days = Math.max(1, Math.min(365, Number(daysInput.value || 14)));
    daysInput.value = String(days);
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
})();

