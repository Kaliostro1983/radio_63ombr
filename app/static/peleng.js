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

document.addEventListener('DOMContentLoaded', ()=>{
  nowToInputs();
  document.getElementById('btn_now').addEventListener('click', nowToInputs);
  document.getElementById('btn_accept').addEventListener('click', acceptFreq);
  document.getElementById('btn_generate').addEventListener('click', generate);
  document.getElementById('btn_copy').addEventListener('click', copyOutput);
});