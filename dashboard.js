const $ = id => document.getElementById(id);
let loaded = null;          // file chosen in step 1 (only used for step 1)
let busy = false;

async function send(action, extra = {}) {
  const r = await chrome.runtime.sendMessage({ action, ...extra });
  if (r?.error) throw new Error(r.error);
  return r;
}
const say = (msg) => { $('status').textContent = msg; };
const fail = e => say('⚠ ' + (e?.message || e));

const STATUS = {
  queued: ['Not done yet', 'none'], processing: ['Interrupted - review', 'warn'], saving: ['Review: save may have gone through', 'warn'],
  submitted_review: ['Review: save may have gone through', 'warn'], submitted: ['Done - saved', 'ok'], done_manual: ['Done (marked by you)', 'ok'],
  reviewed_skip: ['Reviewed - check manually', 'warn'], skipped: ['Skipped', 'warn'], error: ['Not done - error', 'bad'], invalid: ['Invalid sheet data', 'bad']
};
const CHECK = { match: ['OK', 'ok'], partial: ['Partial', 'warn'], mismatch: ['Mismatch', 'bad'], not_found: ['Not read', 'warn'], blank: ['blank', 'none'] };

function chip(text, cls) { const s = document.createElement('span'); s.className = 'chip ' + cls; s.textContent = text; return s; }
function td(...nodes) { const c = document.createElement('td'); c.append(...nodes); return c; }
function actionButton(label, action, store, confirmText) {
  const b = document.createElement('button'); b.className = 'secondary'; b.textContent = label;
  b.onclick = async () => {
    if (confirmText && !confirm(confirmText)) return;
    try { await send(action, { store }); } catch (e) { fail(e); }
  };
  return b;
}

async function refresh() {
  const { batchRows = [] } = await chrome.storage.local.get('batchRows');
  const s = await chrome.storage.session.get(['status', 'batchRunning', 'mode', 'runSuspended']);
  busy = !!s.batchRunning;
  $('status').textContent = s.status || (batchRows.length ? `${batchRows.length} stores in the queue.` : 'Ready. Load your sheet first.');
  for (const id of ['startRun', 'startCheck']) $(id).disabled = busy || !batchRows.length;
  for (const id of ['import', 'clear', 'clearChecks']) if (id !== 'import') $(id).disabled = busy;
  $('import').disabled = busy || !loaded;
  $('pause').disabled = $('stop').disabled = !busy;
  $('stop').textContent=s.runSuspended?'Start / resume current ATM':'Stop at current ATM';
  $('stop').dataset.action=s.runSuspended?'resume':'stop';
  $('runMode').disabled = busy;
  $('empty').hidden = batchRows.length > 0;
  const tbody = $('rows'); tbody.replaceChildren();
  const n = { done: 0, todo: 0, review: 0, bad: 0, mism: 0, checked: 0, skipped: 0, shared: 0, upd: 0 };
  for (const r of batchRows) {
    const [label, cls] = STATUS[r.status] || [r.status, 'none'];
    if (['submitted', 'done_manual'].includes(r.status)) n.done++; else if (['queued'].includes(r.status)) n.todo++; else if (r.status === 'skipped') n.skipped++;
    else if (['processing', 'saving', 'submitted_review', 'reviewed_skip'].includes(r.status)) n.review++; else n.bad++;
    if (Math.max(r.sharedCount || 0, (r.targets || []).length) > 1) n.shared++;
    if ((r.targets || []).some(t => Object.values(t.detail || {}).includes('updated'))) n.upd++;
    if (r.checkedAt) { n.checked++; if (Object.values(r.checks || {}).includes('mismatch')) n.mism++; }
    const tr = document.createElement('tr');
    const coords = Number.isFinite(r.latitude) && Number.isFinite(r.longitude) ? `${r.latitude}, ${r.longitude}` : '—';
    const checkCell = k => { const c = r.checks?.[k]; return td(c ? chip(...CHECK[c]) : chip('—', 'none')); };
    const notes = [r.detailsReview ? 'Review address save before resuming' : '', XlsxOut.skipText(r), r.error, r.coordinateError, r.checkError, r.checkSummary, r.detailError, r.note].filter(Boolean).join(' · ');
    const nc = td(notes); nc.className = 'notes';
    if (r.observed) nc.title = 'Business Manager shows: ' + r.observed;
    const actions = td();
    if (['queued', 'error'].includes(r.status)) actions.append(actionButton('Mark done', 'markDone', r.store, `Mark ${r.store} as already done? It will be skipped.`));
    if (r.detailsReview || ['processing', 'saving', 'submitted_review'].includes(r.status)) actions.append(actionButton('I reviewed it', 'recover', r.store, `Open ${r.store} in Business Manager, check it, close its editor, then press OK.`));
    if (['done_manual', 'reviewed_skip', 'submitted'].includes(r.status) || (r.status === 'skipped' && !r.sheetSkip)) actions.append(actionButton('Queue again', 'requeue', r.store, `Queue ${r.store} again? It will be saved a second time.`));
    const storeCell = td(r.store); const sh = XlsxOut.sharedText(r); if (sh) { const g = document.createElement('span'); g.className = 'tag'; g.textContent = 'shared ID'; g.title = sh; storeCell.append(g); }
    const dc = td(XlsxOut.summaryText(r)); dc.className = 'notes';
    tr.append(td(String(r.sheetRow ?? '')), storeCell, td(coords), td(chip(label, cls)),
      checkCell('name'), checkCell('address'), checkCell('locality'), checkCell('admin'), checkCell('postal'), dc, nc, actions);
    tbody.append(tr);
  }
  $('counts').textContent = batchRows.length
    ? `${n.done} done · ${n.todo} not done yet · ${n.skipped} skipped · ${n.review} to review · ${n.bad} error/invalid · ${n.upd} with details updated · ${n.shared} shared store IDs · ${n.checked} checked (${n.mism} with a mismatch)` : '';
}

/* ---- Step 1 ---- */
$('file').onchange = async () => {
  const f = $('file').files[0]; loaded = null; $('problems').replaceChildren(); $('sheetRow').hidden = true;
  if (!f) return refresh();
  try {
    loaded = await SheetIO.load(f);
    const sel = $('sheet'); sel.replaceChildren();
    loaded.sheets.forEach((s, i) => { const o = document.createElement('option'); o.value = i; o.textContent = s.name + (s.detect ? '' : ' (no Store code header)'); sel.append(o); });
    const first = loaded.sheets.findIndex(s => s.detect); sel.value = first >= 0 ? first : 0;
    $('sheetRow').hidden = false; describeSheet();
  } catch (e) { fail(e); loaded = null; }
  refresh();
};
function describeSheet() {
  const s = loaded.sheets[+$('sheet').value], p = $('problems'); p.replaceChildren();
  if (!s.detect) { $('detected').textContent = ''; const li = document.createElement('li'); li.textContent = 'This sheet has no header row with Store code. Pick another sheet.'; p.append(li); return; }
  const { map, headerRow } = s.detect, names = { store: 'Store code', name: 'Business name', address: 'Street address', address2: 'Street address line 2', address3: 'Street address line 3', locality: 'Locality', admin: 'Administrative area', postal: 'Postal code', latitude: 'Latitude', longitude: 'Longitude' };
  const missing = Object.keys(names).filter(k => map[k] === undefined).map(k => names[k]);
  const q = SheetIO.queueFromSheet(s);
  $('detected').textContent = `Header on row ${headerRow + 1} · ${q.rows.length} stores found` + (missing.length ? ` · columns not found (checks skipped): ${missing.join(', ')}` : '');
  q.problems.forEach(t => { const li = document.createElement('li'); li.textContent = t; p.append(li); });
}
$('sheet').onchange = describeSheet;
$('import').onclick = async () => {
  try {
    const s = loaded.sheets[+$('sheet').value], q = SheetIO.queueFromSheet(s);
    if (!q.rows.length) throw new Error('No store rows found on this sheet.');
    await send('import', { rows: q.rows });
    const { headerRow, map } = s.detect;
    await chrome.storage.local.set({ sheetName: s.name, sourceSheet: { name: s.name, fileName: loaded.name, headerRow, map, matrix: Array.from(s.matrix, r => Array.from(r || [], v => v ?? '')) } });
    $('writeMsg').textContent = '';
  } catch (e) { fail(e); }
};

/* ---- Step 2 ---- */
$('runMode').onchange = () => chrome.storage.local.set({selectedRunMode:$('runMode').value}).catch(fail);
chrome.storage.local.get('selectedRunMode').then(s => {
  if (['coords_address','coords_check','address_only'].includes(s.selectedRunMode)) $('runMode').value=s.selectedRunMode;
}).catch(fail);
$('startRun').onclick = async () => {
  try {
    const mode=$('runMode').value, opts=RunPolicy.options(mode);
    const {batchRows=[]}=await chrome.storage.local.get('batchRows');
    const pending=batchRows.filter(r => {const n=RunPolicy.needs(r,opts); return n.coords || n.details;});
    if(!pending.length) return say('No eligible work remains for this option. Review coordinate errors, Use Re-check all ATMs for a read-only verification; Queue again explicitly authorizes another update.');
    const action=mode==='coords_address'?'set coordinates and correct mismatched address details':
      mode==='coords_check'?'set coordinates and check address details without editing them':'correct mismatched address details without changing coordinates';
    if(!confirm(`Process ${pending.length} store(s): ${action}? Business names will not be changed.`)) return;
    await send('start',{mode}); say('Started in a separate background Chrome window. You can keep working in other windows - this dashboard shows the progress.');
  } catch(e) {fail(e);}
};
$('startCheck').onclick = async () => { try { await send('start', { mode: 'check' }); say('Checking started in a separate background Chrome window. You can keep working in other windows.'); } catch (e) { fail(e); } };
$('pause').onclick = () => send('pause').catch(fail);
$('stop').onclick = () => send($('stop').dataset.action||'stop').catch(fail);

/* ---- Step 4 ---- */
const download = (blob, name) => { const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000); };
$('downloadXlsx').onclick = async () => {
  try {
    const { batchRows = [], sourceSheet } = await chrome.storage.local.get(['batchRows', 'sourceSheet']);
    if (!batchRows.length || !sourceSheet) throw new Error('Nothing to download yet. Load your sheet (step 1) and run it first.');
    const res = await XlsxOut.build(sourceSheet, batchRows);
    download(res.blob, res.filename);
    $('writeMsg').textContent = `Downloaded ${res.filename}: ${res.counts.rows} rows · ${res.counts.updated} with details updated (${res.counts.confirmed} confirmed after refresh, ${res.counts.unconfirmed} not confirmed) · ${res.counts.skipped} skipped · ${res.counts.shared} shared store IDs. Your original file is unchanged.`;
  } catch (e) { $('writeMsg').textContent = '⚠ ' + e.message; }
};
$('export').onclick = async () => {
  const { batchRows = [] } = await chrome.storage.local.get('batchRows');
  const cols = ['store', 'sheetRow', 'latitude', 'longitude', 'status', 'updated', 'error', 'checkError', 'observed', 'checkedAt'];
  const csvLine = r => r.map(v => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(',');
  const lines = [csvLine([...cols, 'name', 'address', 'locality', 'admin', 'postal']),
    ...batchRows.map(r => csvLine([...cols.map(k => r[k]), ...['name', 'address', 'locality', 'admin', 'postal'].map(k => r.checks?.[k])]))];
  download(new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv' }), 'store-coordinate-log.csv');
};
$('clearChecks').onclick = () => { if (confirm('Clear check results only? Saved update history will be retained.')) send('clearChecks').catch(fail); };
$('clear').onclick = () => { if (confirm('Clear the queue AND the history of finished stores? After this the extension no longer knows which stores were saved.')) send('clear').catch(fail); };

chrome.storage.onChanged.addListener(() => refresh().catch(fail));
refresh().catch(fail);
