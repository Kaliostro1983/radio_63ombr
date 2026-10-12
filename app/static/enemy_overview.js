/* ============================================================================
 * Мета-огляд противника — інтелект-карта структури (cytoscape + milsymbol).
 *  • Згортуване дерево (за замовч. відкритий лише верхній рівень).
 *  • Фільтр «Радіовидимість»: лише вузли з р/м у БД (за агрегованою статистикою).
 *  • Для кожного вузла поповер із 4 діями: рівень · усе · редагувати · інфо.
 *  • Редагування (додати/видалити/правити) — персистентний CRUD /api/enemy/node.
 *  • Інфо-панель: статистика + р/м + дрил у перехоплення (/messages/{id}).
 * Символи APP-6: ворожий ромб, ешелон (риски) + рід військ (іконка); БпЛА —
 * коректний air-symbol дрона.
 * ==========================================================================*/
(function () {
  "use strict";

  // ── Символіка ──────────────────────────────────────────────────────────────
  var ECH_UA = {army:"армія",division:"дивізія",brigade:"бригада",regiment:"полк",battalion:"батальйон",company:"рота"};
  var BR_UA  = {hq:"управління",infantry:"мотопіхота",armor:"танкові",artillery:"артилерія",antitank:"протитанкові",
                airdefense:"ППО",recon:"розвідка",engineer:"інженерні",cbrn:"РХБЗ",signal:"звʼязок",ew:"РЕБ",
                maint:"ремонт/евакуація",medical:"медичне",support:"забезпечення",uav:"БпЛА"};
  var ECH_SIDC = {army:"K",division:"I",brigade:"H",regiment:"G",battalion:"F",company:"E"};
  var BR_FUNC  = {hq:"UH----",infantry:"UCI---",armor:"UCA---",artillery:"UCF---",antitank:"UCAT--",airdefense:"UCD---",
                  recon:"UCR---",engineer:"UCE---",cbrn:"UUAC--",signal:"UUS---",ew:"UUSW--",maint:"UULM--",medical:"UUMS--",support:"UUL---"};
  var ECH_OPTS = [["army","армія"],["division","дивізія"],["brigade","бригада"],["regiment","полк"],["battalion","батальйон"],["company","рота"]];
  var BR_OPTS  = [["hq","управління"],["infantry","мотопіхота"],["armor","танкові"],["artillery","артилерія"],["antitank","протитанкові"],
                  ["airdefense","ППО"],["recon","розвідка"],["engineer","інженерні"],["cbrn","РХБЗ"],["signal","звʼязок"],["ew","РЕБ"],
                  ["maint","ремонт/евакуація"],["medical","медичне"],["support","забезпечення"],["uav","БпЛА"]];

  function sidc(ech, br){
    if (br === "uav") return "SHAPMFQ----" + (ECH_SIDC[ech] || "-");   // коректний дрон (air)
    return "SHGP" + (BR_FUNC[br] || "U-----") + "-" + (ECH_SIDC[ech] || "-");
  }
  function symSVG(ech, br, size){
    try { return (window.ms ? new ms.Symbol(sidc(ech,br),{size:size||30,outlineWidth:1}).asSVG() : ""); }
    catch(e){ return ""; }
  }
  function symURI(ech, br){ return "data:image/svg+xml;utf8," + encodeURIComponent(symSVG(ech,br,30)); }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c];}); }
  function fmtK(n){ return n>999 ? (Math.round(n/100)/10 + "k") : String(n); }
  function fmtDt(s){ var v=String(s==null?"":s).replace("T"," ").trim(); var m=v.match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}:\d{2})/); return m?(m[3]+"."+m[2]+" "+m[4]):v; }

  // ── Стан ────────────────────────────────────────────────────────────────────
  var ALL = {}, KIDS = {}, rootId = null;
  var expanded = new Set();     // id вузлів, чиї діти показані
  var radioOnly = false;
  var cy = null, stageEl = null, editEl = null;

  var LAYOUT = {name:"dagre", rankDir:"TB", nodeSep:24, rankSep:82, edgeSep:12, animate:false};
  function layoutOpts(fit){ return Object.assign({}, LAYOUT, {fit: !!fit, padding: 46}); }

  // «Радіовидимість»: показуємо лише вузли, що мають хоч одну радіомережу —
  // власну або в будь-якого нащадка (сервер агрегує nets угору по дереву).
  // Вузли без жодної мережі (зокрема засіяні як «БД», але без перехоплень) —
  // ховаємо.
  function hasRadio(n){ return !!(n && n.stats && n.stats.nets > 0); }
  function kidsVisible(id){ return (KIDS[id]||[]).filter(function(c){ return !radioOnly || hasRadio(ALL[c]); }); }
  function canExpand(id){ return kidsVisible(id).length > 0; }

  // ── Завантаження/перезавантаження структури ─────────────────────────────────
  function loadStructure(cb){
    fetch("/api/enemy/structure").then(function(r){ return r.json(); }).then(function(d){
      if (!d || !d.ok){ if(stageEl) stageEl.insertAdjacentHTML("beforeend",'<div class="en-hint">Не вдалося завантажити структуру.</div>'); return; }
      ALL = {}; KIDS = {}; rootId = null;
      (d.nodes || []).forEach(function(n){
        ALL[n.id] = n;
        if (n.parent) (KIDS[n.parent] = KIDS[n.parent] || []).push(n.id);
        if (n.root) rootId = n.id;
      });
      Array.from(expanded).forEach(function(id){ if (!ALL[id]) expanded.delete(id); });
      if (cb) cb();
    }).catch(function(){ if(stageEl) stageEl.insertAdjacentHTML("beforeend",'<div class="en-hint">Помилка завантаження.</div>'); });
  }

  // ── Побудова / перемальовування ─────────────────────────────────────────────
  function computeVisible(){
    var vis = {};
    (function walk(id){
      vis[id] = true;
      if (expanded.has(id)) kidsVisible(id).forEach(walk);
    })(rootId);
    return vis;
  }

  function rebuild(opts){
    opts = opts || {};
    if (!cy) return;
    var vis = computeVisible();
    var els = [];
    Object.keys(vis).forEach(function(id){
      var n = ALL[id];
      var isOpen = expanded.has(id) && kidsVisible(id).length > 0;   // розкрита структура нижче → товсте обведення
      var data = {id:id, label:n.label, prov:n.prov||"osint"};
      if (!n.root) data.img = symURI(n.ech, n.branch);
      els.push({data:data, classes:(n.root?"root ":"") + ("prov-"+(n.prov||"osint")) + (isOpen?" ndopen":"")});
    });
    Object.keys(vis).forEach(function(id){
      var n = ALL[id];
      if (n.parent && vis[n.parent]) els.push({data:{id:"e_"+n.parent+"_"+id, source:n.parent, target:id}});
    });
    hideHover();
    cy.elements().remove();
    cy.add(els);
    cy.layout(layoutOpts(false)).run();
    if (opts.fit !== false) cy.fit(undefined, 48);
    updateGlobalBtn();
  }

  // ── Операції розгортання ────────────────────────────────────────────────────
  function subtreeAllExpanded(id){
    var ok = true;
    (function walk(x){
      if (kidsVisible(x).length){
        if (!expanded.has(x)){ ok = false; return; }
        kidsVisible(x).forEach(walk);
      }
    })(id);
    return ok;
  }
  function expandAll(id){ (function walk(x){ if (kidsVisible(x).length){ expanded.add(x); kidsVisible(x).forEach(walk); } })(id); }
  function collapseAll(id){ var st=[id]; while(st.length){ var x=st.pop(); expanded.delete(x); (KIDS[x]||[]).forEach(function(c){ st.push(c); }); } }

  // ── Наведення на вузол: кнопки-іконки (ред./інфо — вгорі-праворуч;
  //    розгорнути/згорнути — внизу по центру) ──────────────────────────────────
  var enhTR = null, enhB = null, hoverNode = null, hideTimer = null;
  function ensureHover(){
    if (enhTR) return;
    enhTR = document.createElement("div"); enhTR.className = "enh-tr"; enhTR.hidden = true;
    enhTR.innerHTML =
      '<button class="enh-btn" data-act="edit" title="Редагувати (додати/видалити/правити)" aria-label="Редагувати">✎</button>' +
      '<button class="enh-btn" data-act="info" title="Інформація та радіомережі" aria-label="Інформація">ⓘ</button>';
    enhB = document.createElement("div"); enhB.className = "enh-b"; enhB.hidden = true;
    enhB.innerHTML = '<button class="enh-btn enh-btn--exp" data-act="toggle" title="Розгорнути / згорнути" aria-label="Розгорнути/згорнути">▾</button>';
    stageEl.appendChild(enhTR); stageEl.appendChild(enhB);
    [enhTR, enhB].forEach(function(g){
      g.addEventListener("mouseenter", cancelHide);
      g.addEventListener("mouseleave", scheduleHide);
      g.querySelectorAll("button").forEach(function(b){
        b.addEventListener("click", function(e){ e.stopPropagation(); hoverAction(b.getAttribute("data-act")); });
      });
    });
  }
  function cancelHide(){ clearTimeout(hideTimer); }
  function scheduleHide(){ clearTimeout(hideTimer); hideTimer = setTimeout(hideHover, 170); }
  function hideHover(){ if (enhTR) enhTR.hidden = true; if (enhB) enhB.hidden = true; hoverNode = null; }
  function showHover(id){
    var n = ALL[id]; if (!n) return;
    ensureHover();
    cancelHide();
    hoverNode = id;
    var tbtn = enhB.querySelector(".enh-btn--exp");
    if (canExpand(id)){
      var exp = expanded.has(id);
      tbtn.textContent = exp ? "▴" : "▾";
      tbtn.title = exp ? "Згорнути нижній рівень" : "Розгорнути нижній рівень";
      enhB.hidden = false;
    } else { enhB.hidden = true; }
    enhTR.hidden = false;
    positionHover(id);
  }
  function positionHover(id){
    if (!cy || !enhTR) return;
    var el = cy.getElementById(id);
    if (!el || el.empty()){ hideHover(); return; }
    var p = el.renderedPosition(), half = 23 * cy.zoom();
    enhTR.style.left = (p.x + half - 30) + "px";
    enhTR.style.top  = (p.y - half - 16) + "px";
    enhB.style.left  = (p.x - 14) + "px";
    enhB.style.top   = (p.y + half - 9) + "px";
  }
  function hoverAction(act){
    var id = hoverNode; if (!id) return;
    if (act === "edit") openEdit(id);
    else if (act === "info") openInfo(id);
    else if (act === "toggle"){
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      rebuild({fit:true});   // центруємо структуру при розгортанні/згортанні
    }
  }

  // ── Редагування структури (модалка) ─────────────────────────────────────────
  function optionsHtml(opts, sel){
    return '<option value="">—</option>' + opts.map(function(o){
      return '<option value="'+o[0]+'"'+(o[0]===sel?' selected':'')+'>'+esc(o[1])+'</option>';
    }).join("");
  }
  function ensureEdit(){
    if (editEl) return editEl;
    editEl = document.createElement("div");
    editEl.className = "en-edit"; editEl.hidden = true;
    editEl.innerHTML =
      '<div class="en-edit__backdrop" data-close="1"></div>' +
      '<div class="en-edit__card">' +
        '<div class="en-edit__head"><h3 id="enEditTitle"></h3>' +
          '<button type="button" class="en-edit__x" data-close="1" aria-label="Закрити">✕</button></div>' +
        '<div class="en-edit__body" id="enEditBody"></div>' +
      '</div>';
    document.body.appendChild(editEl);
    editEl.querySelectorAll("[data-close]").forEach(function(b){ b.addEventListener("click", closeEdit); });
    return editEl;
  }
  function closeEdit(){ if (editEl) editEl.hidden = true; }
  function field(label, html){ return '<label class="en-fld"><span>'+esc(label)+'</span>'+html+'</label>'; }

  function openEdit(id){
    var n = ALL[id]; if (!n) return;
    hideHover();
    ensureEdit();
    document.getElementById("enEditTitle").textContent = "Структура: " + n.label;
    var body = document.getElementById("enEditBody");
    var h = "";

    // (A) Правка полів вузла (крім кореня)
    if (!n.root){
      h += '<div class="en-edit__sec"><div class="en-edit__sec-t">Поля вузла</div>'
        + field("Назва", '<input id="edLabel" type="text" value="'+esc(n.label)+'" maxlength="80">')
        + field("Повна назва", '<input id="edFull" type="text" value="'+esc(n.full||"")+'" maxlength="200">')
        + '<div class="en-fld2">'
        +   field("Ешелон", '<select id="edEch">'+optionsHtml(ECH_OPTS, n.ech)+'</select>')
        +   field("Рід військ", '<select id="edBranch">'+optionsHtml(BR_OPTS, n.branch)+'</select>')
        + '</div>'
        + '<button type="button" class="en-btn en-btn--accent" id="edSave">Зберегти зміни</button>'
        + '</div>';
    }

    // (B) Додати підрозділ
    h += '<div class="en-edit__sec"><div class="en-edit__sec-t">Додати підрозділ усередину «'+esc(n.label)+'»</div>'
      + field("Назва", '<input id="adLabel" type="text" placeholder="напр. 254 мсп" maxlength="80">')
      + field("Повна назва", '<input id="adFull" type="text" placeholder="повна назва / дислокація" maxlength="200">')
      + '<div class="en-fld2">'
      +   field("Ешелон", '<select id="adEch">'+optionsHtml(ECH_OPTS, n.root?"army":"")+'</select>')
      +   field("Рід військ", '<select id="adBranch">'+optionsHtml(BR_OPTS, "")+'</select>')
      + '</div>'
      + '<button type="button" class="en-btn en-btn--accent" id="adAdd">Додати</button>'
      + '</div>';

    // (C) Видалити (крім кореня)
    if (!n.root){
      h += '<div class="en-edit__sec en-edit__sec--danger"><div class="en-edit__sec-t">Видалення</div>'
        + '<div class="en-edit__hint">Видалить цей вузол разом з усіма підлеглими.</div>'
        + '<button type="button" class="en-btn en-btn--danger" id="edDel">Видалити «'+esc(n.label)+'»</button>'
        + '</div>';
    }

    body.innerHTML = h;
    editEl.hidden = false;

    var save = document.getElementById("edSave");
    if (save) save.addEventListener("click", function(){
      var payload = {
        label: document.getElementById("edLabel").value.trim(),
        full:  document.getElementById("edFull").value.trim(),
        ech:   document.getElementById("edEch").value,
        branch:document.getElementById("edBranch").value,
      };
      api("PUT", "/api/enemy/node/"+encodeURIComponent(id), payload, function(){
        toast("Збережено");
        loadStructure(function(){ rebuild({fit:true}); openEdit(id); });
      });
    });
    document.getElementById("adAdd").addEventListener("click", function(){
      var label = document.getElementById("adLabel").value.trim();
      if (!label){ toast("Вкажіть назву"); return; }
      var payload = {
        parent: id, label: label,
        full: document.getElementById("adFull").value.trim(),
        ech: document.getElementById("adEch").value,
        branch: document.getElementById("adBranch").value,
      };
      api("POST", "/api/enemy/node", payload, function(){
        toast("Додано: " + label);
        expanded.add(id);
        loadStructure(function(){ rebuild({fit:true}); openEdit(id); });
      });
    });
    var del = document.getElementById("edDel");
    if (del) del.addEventListener("click", function(){
      if (!confirm("Видалити «"+n.label+"» разом з усіма підлеглими вузлами?")) return;
      api("DELETE", "/api/enemy/node/"+encodeURIComponent(id), null, function(){
        toast("Видалено");
        expanded.delete(id);
        closeEdit();
        loadStructure(function(){ rebuild({fit:true}); });
      });
    });
  }

  function api(method, url, body, ok){
    var opt = {method:method, headers:{"Content-Type":"application/json"}};
    if (body != null) opt.body = JSON.stringify(body);
    fetch(url, opt).then(function(r){ return r.json().catch(function(){ return {}; }); }).then(function(d){
      if (d && d.ok) ok(d); else toast((d && d.error) || "Помилка");
    }).catch(function(){ toast("Помилка мережі"); });
  }
  function toast(m){ if (window.appToast) window.appToast(m, "info", 1600); }

  // ── Інфо-панель (функція «Інформація») ──────────────────────────────────────
  var panel;
  function closePanel(){ if (panel) panel.hidden = true; if (cy) cy.$(":selected").unselect(); }
  function openInfo(id){
    var n = ALL[id]; if (!n || !panel) return;
    hideHover();
    document.getElementById("enpName").textContent = n.label;
    document.getElementById("enpFull").textContent = n.full || "";
    document.getElementById("enpSym").innerHTML = n.root ? '<span style="color:#cfe0f5;font-size:26px">▣</span>' : symSVG(n.ech, n.branch, 50);
    var body = document.getElementById("enpBody");
    if (n.root){ body.innerHTML = '<div class="enp-empty">Коренева точка. Нижче — армії противника на нашому напрямку.</div>'; panel.hidden = false; return; }
    var provTxt = n.prov==="db" ? "з перехоплень (БД)" : n.prov==="trophy" ? "трофей (кодплаг)" : "OSINT / ручне";
    var provCls = n.prov==="db" ? "db" : "osint";
    var h = "";
    h += '<div class="enp-row"><span class="k">Ешелон</span><span class="v">'+esc(ECH_UA[n.ech]||"—")+'</span></div>';
    h += '<div class="enp-row"><span class="k">Рід військ</span><span class="v">'+esc(BR_UA[n.branch]||"—")+'</span></div>';
    h += '<div class="enp-row"><span class="k">Джерело</span><span class="v"><span class="enp-prov '+provCls+'">'+esc(provTxt)+'</span></span></div>';
    if (n.stats){
      h += '<div class="enp-stats">'
        + '<div class="enp-stat"><div class="n">'+n.stats.nets+'</div><div class="l">р/м</div></div>'
        + '<div class="enp-stat"><div class="n">'+fmtK(n.stats.cs)+'</div><div class="l">позивних</div></div>'
        + '<div class="enp-stat"><div class="n" style="font-size:12.5px">'+(n.stats.last?esc(n.stats.last.slice(5)):"—")+'</div><div class="l">остання</div></div>'
        + '</div>';
      h += '<button type="button" class="enp-nets-btn" id="enpNetsBtn">Показати радіомережі ('+n.stats.nets+') ▾</button>';
      h += '<div class="enp-nets" id="enpNets" hidden></div>';
    } else {
      h += '<div class="enp-note">Поки без перехоплень у БД — вузол зі структури (OSINT/ручне).</div>';
    }
    body.innerHTML = h;
    panel.hidden = false;
    var nb = document.getElementById("enpNetsBtn");
    if (nb) nb.addEventListener("click", function(){ toggleNets(id, nb); });
  }
  function toggleNets(id, btn){
    var box = document.getElementById("enpNets"); if (!box) return;
    if (!box.hidden){ box.hidden = true; btn.textContent = btn.textContent.replace("▴","▾"); return; }
    box.hidden = false; btn.textContent = btn.textContent.replace("▾","▴");
    if (box.dataset.loaded === "1") return;
    box.innerHTML = '<div class="enp-empty">Завантаження…</div>';
    fetch("/api/enemy/networks?node="+encodeURIComponent(id)).then(function(r){ return r.json(); }).then(function(d){
      var nets = (d && d.networks) || [];
      if (!nets.length){ box.innerHTML = '<div class="enp-empty">Немає р/м у БД.</div>'; return; }
      box.dataset.loaded = "1";
      box.innerHTML = nets.map(function(w){
        return '<div class="enp-net" data-nid="'+w.id+'" title="Показати перехоплення цієї р/м">'
          + '<span class="f">'+esc(w.freq)+'</span><span class="u" title="'+esc(w.unit)+'">'+esc(w.unit||"—")+'</span>'
          + '<span class="c">'+fmtK(w.cs)+' п.</span><span class="caret">▾</span></div>'
          + '<div class="enp-ints" id="enpInts_'+w.id+'" hidden></div>';
      }).join("");
      box.querySelectorAll(".enp-net").forEach(function(row){ row.addEventListener("click", function(){ toggleInts(row); }); });
    }).catch(function(){ box.innerHTML = '<div class="enp-empty">Помилка завантаження р/м.</div>'; });
  }
  function toggleInts(row){
    var nid = row.dataset.nid, box = document.getElementById("enpInts_"+nid), caret = row.querySelector(".caret");
    if (!box) return;
    if (!box.hidden){ box.hidden = true; if (caret) caret.textContent = "▾"; return; }
    box.hidden = false; if (caret) caret.textContent = "▴";
    if (box.dataset.loaded === "1") return;
    box.innerHTML = '<div class="enp-empty">Завантаження…</div>';
    fetch("/api/enemy/intercepts?network_id="+encodeURIComponent(nid)+"&limit=15").then(function(r){ return r.json(); }).then(function(d){
      var its = (d && d.intercepts) || [];
      if (!its.length){ box.innerHTML = '<div class="enp-empty">Немає перехоплень.</div>'; return; }
      box.dataset.loaded = "1";
      box.innerHTML = its.map(function(it){
        var sn = (it.body||"").replace(/\s+/g," ").trim().slice(0,92), more = (it.body && it.body.length>92)?"…":"";
        return '<a class="enp-int" href="/messages/'+it.id+'" target="_blank" rel="noopener" title="Відкрити повну картку">'
          + '<span class="it">'+esc(fmtDt(it.dt))+'</span><span class="ib">'+esc(sn)+more+'</span></a>';
      }).join("");
    }).catch(function(){ box.innerHTML = '<div class="enp-empty">Помилка завантаження перехоплень.</div>'; });
  }

  // ── Глобальні кнопки ─────────────────────────────────────────────────────────
  function updateGlobalBtn(){
    var b = document.getElementById("enExpandAll");
    if (!b) return;
    b.textContent = subtreeAllExpanded(rootId) ? "Згорнути" : "Розгорнути";
  }

  // ── Ініціалізація ────────────────────────────────────────────────────────────
  function init(){
    stageEl = document.getElementById("enStage");
    var cyEl = document.getElementById("enCy");
    if (!stageEl || !cyEl) return;
    panel = document.getElementById("enPanel");
    var px = document.getElementById("enpX"); if (px) px.addEventListener("click", closePanel);
    var fit = document.getElementById("enFit"); if (fit) fit.addEventListener("click", function(){ if (cy) cy.fit(undefined, 48); });
    var exAll = document.getElementById("enExpandAll");
    if (exAll) exAll.addEventListener("click", function(){
      if (subtreeAllExpanded(rootId)){ expanded = new Set([rootId]); } else { expandAll(rootId); }
      rebuild({fit:true});
    });
    var ro = document.getElementById("enRadioOnly");
    if (ro) ro.addEventListener("change", function(){ radioOnly = ro.checked; rebuild({fit:true}); });

    if (window.cytoscapeDagre){ try { cytoscape.use(window.cytoscapeDagre); } catch(e){} }
    cy = cytoscape({
      container: cyEl, elements: [],
      minZoom:0.25, maxZoom:2.6, wheelSensitivity:0.25,
      style:[
        {selector:"node[img]", style:{
          "background-opacity":0, "background-image":"data(img)", "background-fit":"contain", "background-clip":"none",
          "shape":"round-rectangle", "border-width":1.5, "border-color":"#44566d", "border-opacity":0.85,
          "width":46, "height":46, "label":"data(label)", "color":"#e7edf5", "font-size":13, "font-weight":600,
          "text-valign":"bottom", "text-halign":"center", "text-margin-y":5, "text-wrap":"wrap", "text-max-width":104, "min-zoomed-font-size":7
        }},
        {selector:"node.prov-osint[img]", style:{"color":"#f0b454"}},
        {selector:"node.prov-trophy[img]", style:{"color":"#f0b454"}},
        {selector:"node.ndopen[img]", style:{"border-width":2.6, "border-color":"#8098c0", "border-opacity":1}},
        {selector:"node.root", style:{
          "background-opacity":1, "background-color":"#182536", "shape":"round-rectangle", "width":"label", "height":34, "padding":"10px",
          "border-width":1, "border-color":"#334a66", "label":"data(label)", "text-valign":"center", "text-halign":"center",
          "color":"#cfe0f5", "font-size":14, "font-weight":700, "text-max-width":220
        }},
        {selector:"node:selected", style:{"text-background-color":"#6ea8ff","text-background-opacity":0.18,"text-background-shape":"round-rectangle","text-background-padding":3}},
        {selector:"edge", style:{"width":1.4,"line-color":"#33465f","curve-style":"taxi","taxi-direction":"downward","taxi-turn":44,"taxi-turn-min-distance":6,"target-arrow-shape":"none"}}
      ]
    });

    cy.on("mouseover", "node", function(ev){ showHover(ev.target.id()); });
    cy.on("mouseout", "node", function(){ scheduleHide(); });
    cy.on("tap", "node", function(ev){ showHover(ev.target.id()); });   // дотик: показати кнопки
    cy.on("tap", function(ev){ if (ev.target === cy){ hideHover(); closePanel(); } });
    cy.on("pan zoom", function(){ if (hoverNode) positionHover(hoverNode); });

    loadStructure(function(){
      expanded = new Set([rootId]);   // за замовч.: відкритий лише верхній рівень (армії)
      rebuild({fit:true});
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
