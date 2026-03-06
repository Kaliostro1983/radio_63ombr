function pad2(n){ return String(n).padStart(2,'0'); }

function nowToInputs() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth()+1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  document.getElementById('event_date').value = `${yyyy}-${mm}-${dd}`;
  document.getElementById('event_time').value = `${hh}:${mi}`;
}

function showToast(text, ms=1200){
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), ms);
}

async function apiPost(url, body){
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(()=>({}));
  if(!r.ok){
    const msg = data.detail || 'Помилка запиту';
    throw new Error(msg);
  }
  return data;
}

function getVal(id){ return (document.getElementById(id).value || '').trim(); }
function setVal(id, v){ document.getElementById(id).value = v ?? ''; }

async function acceptFreq(){
  const raw = getVal('frequency');
  if(!raw){ alert('Введи частоту або маску.'); return; }

  try{
    const data = await apiPost('/peleng/accept', {value: raw});
    setVal('frequency', data.display_value || raw);
    if(data.unit) setVal('unit', data.unit);
    if(data.location) setVal('location', data.location);
    showToast('Прийнято');
  }catch(e){
    alert(e.message);
  }
}

async function generate(){
  const payload = {
    date: getVal('event_date'),
    time: getVal('event_time'),
    freq_or_mask: getVal('frequency'),
    unit: getVal('unit'),
    location: getVal('location'),
    mgrs_text: document.getElementById('mgrs_text').value || '',
    comment: document.getElementById('comment').value || '',
  };

  try{
    const data = await apiPost('/peleng/generate', payload);
    setVal('output', data.text || '');

    // як у десктопі: після генерації одразу копіюємо
    const txt = (data.text || '').trim();
    if(txt){
      try{
        await navigator.clipboard.writeText(txt);
        showToast('Скопійовано у буфер обміну');
      }catch{
        showToast('Згенеровано (буфер недоступний)');
      }
    }
  }catch(e){
    alert(e.message);
  }
}

async function copyOutput(){
  const txt = getVal('output');
  if(!txt){ alert('Спершу згенеруй повідомлення.'); return; }

  // 1) копіюємо
  await navigator.clipboard.writeText(txt);

  // 2) зберігаємо в БД
  const payload = {
    date: getVal('event_date'),
    time: getVal('event_time'),
    freq_or_mask: getVal('frequency'),
    mgrs_text: document.getElementById('mgrs_text').value || '',
  };

  try{
    const res = await apiPost('/peleng/save', payload);
    showToast(`Скопійовано + Збережено (batch ${res.batch_id})`);
  }catch(e){
    // копіювання вже сталося, тому тут лише повідомляємо про збереження
    showToast(`Скопійовано (не збережено: ${e.message})`, 1800);
  }
}

function toLocalInputValue(d) {
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function initReportInputs() {
  const now = new Date();
  const hours = Number(document.getElementById('report_hours')?.value || 9);

  const toEl = document.getElementById('report_to_dt');
  const fromEl = document.getElementById('report_from_dt');

  if (!toEl || !fromEl) return;

  toEl.value = toLocalInputValue(now);

  const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
  fromEl.value = toLocalInputValue(from);
}

function updateReportFromDtByHours() {
  const toEl = document.getElementById('report_to_dt');
  const fromEl = document.getElementById('report_from_dt');
  const hoursEl = document.getElementById('report_hours');

  if (!toEl || !fromEl || !hoursEl) return;

  const toVal = toEl.value;
  const hours = Number(hoursEl.value || 0);

  if (!toVal || !hours || hours < 1) return;

  const toDt = new Date(toVal);
  const fromDt = new Date(toDt.getTime() - hours * 60 * 60 * 1000);
  fromEl.value = toLocalInputValue(fromDt);
}

function localInputToSql(dtLocal) {
  // "2026-02-19T11:58" -> "2026-02-19 11:58:00"
  if (!dtLocal) return '';
  return `${dtLocal.replace('T', ' ')}:00`;
}

async function downloadBlob(url, options = {}, fallbackName = 'report.docx') {
  const res = await fetch(url, options);
  if (!res.ok) {
    let msg = 'Помилка формування звіту';
    try {
      const data = await res.json();
      msg = data.detail || msg;
    } catch {}
    throw new Error(msg);
  }

  const blob = await res.blob();

  let filename = fallbackName;
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename="([^"]+)"/);
  if (m && m[1]) filename = m[1];

  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

async function generateReport() {
  const text = (document.getElementById('report_source_text')?.value || '').trim();

  try {
    if (text) {
      await downloadBlob('/peleng/report/from-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }, 'report_from_text.docx');

      showToast('Звіт сформовано з тексту', 1600);
      return;
    }

    const fromDt = localInputToSql(document.getElementById('report_from_dt')?.value || '');
    const toDt = localInputToSql(document.getElementById('report_to_dt')?.value || '');

    if (!fromDt || !toDt) {
      alert('Заповни початковий і кінцевий дата/час для вибірки з БД.');
      return;
    }

    const qs = new URLSearchParams({
      from_dt: fromDt,
      to_dt: toDt,
    });

    await downloadBlob(`/peleng/report/by-period?${qs.toString()}`, {
      method: 'GET',
    }, 'report_from_db.docx');

    showToast('Звіт сформовано з БД', 1600);
  } catch (e) {
    alert(e.message);
  }
}

function toLocalInputValue(d) {
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  const hh = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function localInputToSql(dtLocal) {
  if (!dtLocal) return '';
  return `${dtLocal.replace('T', ' ')}:00`;
}

function initReportInputs() {
  const now = new Date();
  const hours = Number(document.getElementById('report_hours')?.value || 9);

  const toEl = document.getElementById('report_to_dt');
  const fromEl = document.getElementById('report_from_dt');
  if (!toEl || !fromEl) return;

  toEl.value = toLocalInputValue(now);
  const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
  fromEl.value = toLocalInputValue(from);

  refreshReportModeNote();
}

function updateReportFromDtByHours() {
  const toEl = document.getElementById('report_to_dt');
  const fromEl = document.getElementById('report_from_dt');
  const hoursEl = document.getElementById('report_hours');

  if (!toEl || !fromEl || !hoursEl) return;

  const toVal = toEl.value;
  const hours = Number(hoursEl.value || 0);
  if (!toVal || !hours || hours < 1) return;

  const toDt = new Date(toVal);
  const fromDt = new Date(toDt.getTime() - hours * 60 * 60 * 1000);
  fromEl.value = toLocalInputValue(fromDt);
}

function refreshReportModeNote() {
  const text = (document.getElementById('report_source_text')?.value || '').trim();
  const note = document.getElementById('report_mode_note');
  if (!note) return;

  if (text) {
    note.textContent = 'Режим: звіт із вставленого тексту (БД ігнорується)';
    note.classList.add('text-mode');
  } else {
    note.textContent = 'Режим: вибірка з БД';
    note.classList.remove('text-mode');
  }
}

async function downloadBlob(url, options = {}, fallbackName = 'report.docx') {
  const res = await fetch(url, options);
  if (!res.ok) {
    let msg = 'Помилка формування звіту';
    try {
      const data = await res.json();
      msg = data.detail || msg;
    } catch {}
    throw new Error(msg);
  }

  const blob = await res.blob();
  let filename = fallbackName;
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename="([^"]+)"/);
  if (m && m[1]) filename = m[1];

  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(blobUrl);
}

async function updateReportPreview() {
  const text = (document.getElementById('report_source_text')?.value || '').trim();
  const previewEl = document.getElementById('report_preview');
  if (!previewEl) return;

  if (text) {
    previewEl.textContent = 'Знайдено: режим тексту';
    return;
  }

  const fromDt = localInputToSql(document.getElementById('report_from_dt')?.value || '');
  const toDt = localInputToSql(document.getElementById('report_to_dt')?.value || '');
  if (!fromDt || !toDt) {
    previewEl.textContent = 'Знайдено: —';
    return;
  }

  try {
    const qs = new URLSearchParams({ from_dt: fromDt, to_dt: toDt });
    const res = await fetch(`/peleng/report/preview?${qs.toString()}`);
    const data = await res.json();

    if (!res.ok) {
      previewEl.textContent = 'Знайдено: —';
      return;
    }

    previewEl.textContent = `Батчів: ${data.batch_count}, точок: ${data.point_count}`;
  } catch {
    previewEl.textContent = 'Знайдено: —';
  }
}

let previewTimer = null;
function scheduleReportPreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(updateReportPreview, 250);
}

async function generateReport() {
  const text = (document.getElementById('report_source_text')?.value || '').trim();

  try {
    if (text) {
      await downloadBlob('/peleng/report/from-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }, 'report_from_text.docx');
      showToast('Звіт сформовано з тексту', 1600);
      return;
    }

    const fromDt = localInputToSql(document.getElementById('report_from_dt')?.value || '');
    const toDt = localInputToSql(document.getElementById('report_to_dt')?.value || '');

    if (!fromDt || !toDt) {
      alert('Заповни початковий і кінцевий дата/час.');
      return;
    }

    const qs = new URLSearchParams({ from_dt: fromDt, to_dt: toDt });
    await downloadBlob(`/peleng/report/by-period?${qs.toString()}`, {}, 'report_from_db.docx');
    showToast('Звіт сформовано з БД', 1600);
  } catch (e) {
    alert(e.message);
  }
}

// ---------------- posts ----------------
let postsState = [];

function postRowTemplate(post, idx) {
  const tr = document.createElement('tr');
  tr.dataset.idx = String(idx);

  tr.innerHTML = `
    <td class="col-active"><input type="checkbox" class="post-active" ${post.active ? 'checked' : ''}></td>
    <td class="col-id"><input type="text" class="post-id" value="${escapeHtml(post.id || '')}"></td>
    <td><input type="text" class="post-name" value="${escapeHtml(post.name || '')}"></td>
    <td class="col-bp"><input type="text" class="post-bp" value="${escapeHtml(post.bp_number || '')}"></td>
    <td><textarea class="post-unit">${escapeHtml(post.unit || '')}</textarea></td>
    <td><input type="text" class="post-equipment" value="${escapeHtml(post.equipment || '')}"></td>
    <td class="col-actions"><button type="button" class="btn btn-danger btn-post-delete">✕</button></td>
  `;
  return tr;
}

function escapeHtml(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderPostsTable() {
  const tbody = document.getElementById('posts_tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  postsState.forEach((post, idx) => {
    tbody.appendChild(postRowTemplate(post, idx));
  });
}

function collectPostsFromUi() {
  const rows = Array.from(document.querySelectorAll('#posts_tbody tr'));
  return rows.map((row, idx) => {
    const idVal = row.querySelector('.post-id')?.value?.trim() || `post_${idx + 1}`;
    return {
      active: !!row.querySelector('.post-active')?.checked,
      id: idVal,
      name: row.querySelector('.post-name')?.value?.trim() || '',
      bp_number: row.querySelector('.post-bp')?.value?.trim() || '',
      unit: row.querySelector('.post-unit')?.value || '',
      equipment: row.querySelector('.post-equipment')?.value?.trim() || '',
    };
  });
}

async function loadPosts() {
  try {
    const res = await fetch('/peleng/posts');
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Не вдалося завантажити пости');
    postsState = Array.isArray(data.posts) ? data.posts : [];
    renderPostsTable();
  } catch (e) {
    alert(e.message);
  }
}

function addPost() {
  postsState = collectPostsFromUi();
  postsState.push({
    active: true,
    id: `post_${postsState.length + 1}`,
    name: '',
    bp_number: '',
    unit: '',
    equipment: '',
  });
  renderPostsTable();
}

function deletePostRow(ev) {
  const btn = ev.target.closest('.btn-post-delete');
  if (!btn) return;
  const tr = btn.closest('tr');
  if (!tr) return;
  const idx = Number(tr.dataset.idx);
  postsState = collectPostsFromUi();
  postsState.splice(idx, 1);
  renderPostsTable();
}

async function savePosts() {
  try {
    postsState = collectPostsFromUi();
    const data = await apiPost('/peleng/posts/save', { posts: postsState });
    showToast(data.detail || 'Пости збережено', 1600);
    await loadPosts();
  } catch (e) {
    alert(e.message);
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  nowToInputs();

  document.getElementById('btn_now').addEventListener('click', nowToInputs);
  document.getElementById('btn_accept').addEventListener('click', acceptFreq);
  document.getElementById('btn_generate').addEventListener('click', generate);
  document.getElementById('btn_copy').addEventListener('click', copyOutput);

  initReportInputs();
  loadPosts();
  scheduleReportPreview();

  const reportHours = document.getElementById('report_hours');
  const reportTo = document.getElementById('report_to_dt');
  const reportFrom = document.getElementById('report_from_dt');
  const reportText = document.getElementById('report_source_text');
  const reportBtn = document.getElementById('btn_report_generate');
  const postsAddBtn = document.getElementById('btn_posts_add');
  const postsSaveBtn = document.getElementById('btn_posts_save');
  const postsTbody = document.getElementById('posts_tbody');

  if (reportHours) {
    reportHours.addEventListener('input', () => {
      updateReportFromDtByHours();
      scheduleReportPreview();
    });
    reportHours.addEventListener('change', () => {
      updateReportFromDtByHours();
      scheduleReportPreview();
    });
  }

  if (reportTo) {
    reportTo.addEventListener('change', () => {
      updateReportFromDtByHours();
      scheduleReportPreview();
    });
  }

  if (reportFrom) {
    reportFrom.addEventListener('change', scheduleReportPreview);
  }

  if (reportText) {
    reportText.addEventListener('input', () => {
      refreshReportModeNote();
      scheduleReportPreview();
    });
  }

  if (reportBtn) {
    reportBtn.addEventListener('click', generateReport);
  }

  if (postsAddBtn) {
    postsAddBtn.addEventListener('click', addPost);
  }

  if (postsSaveBtn) {
    postsSaveBtn.addEventListener('click', savePosts);
  }

  if (postsTbody) {
    postsTbody.addEventListener('click', deletePostRow);
  }
});