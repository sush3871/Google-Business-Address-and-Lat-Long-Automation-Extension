let STORE = '';
let IDX = 0; // which of several businesses sharing this store code is being handled
importScripts('match.js', 'runpolicy.js');
let GEO = {};
// A service worker restart means no batch is running in memory any more.
chrome.storage.session.set({batchRunning:false});
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const wait = async ms => {await runGate();await delay(ms);await runGate();};
let pausedAt=0, pausedDuration=0;
const runNow=()=>Date.now()-pausedDuration-(suspended?Date.now()-pausedAt:0);
let suspended=false, resumeWaiters=[], activeRunTab=null, activeRunWindow=null;
async function suspendRun(reason='Stopped by you') {
  if(!running || suspended) return;
  suspended=true;pausedAt=Date.now();
  await chrome.storage.session.set({runSuspended:true,status:reason+' — '+(STORE||'current business')+'. Press Start on the business page to continue.'});
}
async function runGate() {
  if(!running || activeRunTab===null) return;
  const tab=await chrome.tabs.get(activeRunTab);
  if(!tab.active) await suspendRun('Paused because you changed tabs');
  // All pending work waits here, preserving the current row, target and operation.
  while(suspended && !cancelRequested) await new Promise(resolve=>resumeWaiters.push(resolve));
  if(cancelRequested) throw new Error('Run interrupted. Resume from the saved business.');
}
async function resumeRun() {
  if(!running) throw new Error('This run is no longer active. Use the dashboard to resume the saved business.');
  const tab=await chrome.tabs.get(activeRunTab);
  const win=await chrome.windows.get(tab.windowId);
  if(!tab.active || !win.focused) throw new Error('Return to the Business Manager tab, then press Start.');
  pausedDuration+=Date.now()-pausedAt;suspended=false;
  await chrome.storage.session.set({runSuspended:false,status:'Resuming '+(STORE||'current business')+' from the stopped step…'});
  resumeWaiters.splice(0).forEach(resolve=>resolve());
}
async function beginControl(tabId,mode) {
  activeRunTab=tabId;activeRunWindow=(await chrome.tabs.get(tabId)).windowId;suspended=false;pausedDuration=0;
  await chrome.storage.session.set({runSuspended:false,runTabId:tabId});
  try {await chrome.scripting.executeScript({target:{tabId},files:['page-controls.js']});} catch {}
  await chrome.storage.local.set({lastRunMode:mode});
}
async function checkpoint(phase,index,store,target=0) {
  await runGate();
  await chrome.storage.local.set({runCheckpoint:{phase,index,store,target,mode:activeMode,complete:false}});
  await chrome.storage.session.set({currentStore:store});
}
let activeMode='coords_check';
async function finishControl() {
  suspended=false;activeRunTab=null;activeRunWindow=null;
  resumeWaiters.splice(0).forEach(resolve=>resolve());
  await chrome.storage.session.set({runSuspended:false});
}
async function pageScript(request) {await runGate();return chrome.scripting.executeScript(request);}
async function debugCommand(target,command,params) {
  // Release mouse/key input even when Stop arrives during a press.
  const release=command==='Emulation.clearGeolocationOverride' || params?.type==='mouseReleased' || params?.type==='keyUp';
  if(!release) await runGate();
  return chrome.debugger.sendCommand(target,command,params);
}
let running = false;
let cancelRequested = false;
const tell = status => chrome.storage.session.set({status});

// This function runs in the page's isolated extension world. No network calls.
function inspectUI(kind, commit=false, store, idx=0, value='') {
  if(!['business.google.com','www.google.com','maps.google.com'].includes(location.hostname))
    return {count:0};
  const visible = e => !!(e.getClientRects().length) && getComputedStyle(e).visibility !== 'hidden'
    && getComputedStyle(e).display !== 'none';
  const labels = e => [e.getAttribute('aria-label'), e.getAttribute('title'), e.innerText].filter(Boolean).map(v=>v.trim());
  const name = e => (e.getAttribute('aria-label') || e.getAttribute('title') || e.innerText || '').trim();
  const controls = scope => [...scope.querySelectorAll('button,[role="button"],[role="tab"]')]
    .filter(e => visible(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true');
  const seenLinks = new Set();
  const rows = [...document.querySelectorAll('tr,[role="row"]')].filter(r => visible(r) &&
    [...r.querySelectorAll('td,[role="cell"]')].some(c => c.textContent.trim() === store)).filter(r => {
      const l = r.querySelector('a[href]')?.href || ''; if(l && seenLinks.has(l)) return false; seenLinks.add(l); return true; });
  const links = rows.map(r => r.querySelector('a[href]')?.href || null);
  // Values under the list's own column headings (Store code, Business name, Street address, City, State, Pin code).
  const colsOf = r => {
    const table = r.closest('table,[role="grid"],[role="table"],[role="treegrid"]'); if(!table) return null;
    const heads = [...table.querySelectorAll('th,[role="columnheader"]')].filter(visible).map(h => (h.innerText || '').trim());
    const cells = [...r.querySelectorAll('td,[role="cell"]')].map(c => (c.innerText || '').trim());
    if(!heads.length || !cells.length || cells.length > heads.length) return null;
    const h = heads.slice(heads.length - cells.length), out = {};
    const pick = (key, rx) => { const i = h.findIndex(x => rx.test(x)); if(i >= 0) out[key] = cells[i]; };
    pick('store', /^store code$/i); pick('name', /^business name$/i); pick('address', /^(street address|address line 1)$/i);
    pick('locality', /^(city|town)$/i); pick('admin', /^state$/i); pick('postal', /^(pin ?code|postal code)$/i);
    if(out.store !== store) return null; // misaligned columns: do not trust
    return Object.keys(out).length > 1 ? out : null;
  };
  const bizOf = r => {
    const cells = [...r.querySelectorAll('td,[role="cell"]')].map(c => (c.innerText || '').trim());
    const c = cells.find(t => t && t !== store && !/^(verified|not verified|verify)/i.test(t));
    if(!c) return null;
    const lines = c.split('\n').map(x => x.trim()).filter(Boolean);
    return lines.length ? {name:lines[0], block:lines.slice(1).join(', ')} : null;
  };
  if(kind === 'identity') return {count:rows.length, biz:rows.map(bizOf), links, link:links[idx] || null, summaries:rows.map(r => r.innerText.slice(0,2000)), cols:rows.map(colsOf), summary:rows[idx]?.innerText.slice(0,2000)};
  if(kind === 'response') {
    const text = document.body?.innerText || '';
    const patterns = [/[^\n]*(?:pending|under review|being reviewed|may take|up to \d+|couldn't save|could not save|something went wrong|changes saved|edit.{0,15}saved)[^\n]*/gi];
    // Hard errors are only trusted inside alerts / live regions, not anywhere on the page.
    const alertText = [...document.querySelectorAll('[role="alert"],[role="alertdialog"],[aria-live="assertive"],[role="dialog"],[role="status"]')]
      .filter(visible).map(e => e.innerText || '').join('\n');
    const errors = (alertText.match(/[^\n]*(?:couldn['\u2019]t save|could not save|something went wrong|error saving|isn['\u2019]t valid|not valid)[^\n]*/gi) || []).slice(0,5);
    const verify = /verif(y|ication)/i.test(alertText);
    return {messages:patterns.flatMap(p => text.match(p) || []).slice(0,8), errors, verify,
      saveVisible:controls(document).some(e => /^Save$/i.test(name(e)))};
  }
  if(kind === 'editorText') { // read-only: values of visible form fields (address, name...) in this frame
    const vals = [...document.querySelectorAll('input,textarea,select')].filter(e => visible(e) &&
      !['hidden','password','checkbox','radio','button','submit','file'].includes((e.type||'').toLowerCase()))
      .map(e => e.tagName === 'SELECT' ? (e.selectedOptions[0]?.text || '') : (e.value || '')).map(v => v.trim()).filter(Boolean);
    return {count:0, text:vals.join(' | ').slice(0,3000)};
  }
  const labelsOf = e => {
    const out = [e.getAttribute('aria-label'), e.placeholder, e.getAttribute('name')];
    if(e.id) { const l = document.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if(l) out.push(l.innerText); }
    const by = e.getAttribute('aria-labelledby'); if(by) out.push(by.split(/\s+/).map(i => document.getElementById(i)?.innerText || '').join(' '));
    const wrap = e.closest('label'); if(wrap) out.push(wrap.innerText);
    const box = e.closest('[role="group"],mat-form-field,[class*="field" i],[class*="input" i]'); if(box) out.push((box.innerText || '').split('\n')[0].slice(0,60));
    if(e.previousElementSibling) out.push((e.previousElementSibling.innerText || '').split('\n')[0].slice(0,60));
    return out.filter(Boolean).map(v => v.trim().replace(/\s*\*$/, '')).filter(Boolean);
  };
  const fieldEls = () => [...document.querySelectorAll('input,textarea,select,[role="combobox"]')].filter(e => visible(e) && !e.disabled &&
    !['hidden','password','checkbox','radio','button','submit','file','search'].includes((e.type||'').toLowerCase()));
  const press = e => { e.scrollIntoView({block:'center'});
    for(const t of ['pointerdown','mousedown','pointerup','mouseup']) e.dispatchEvent(new MouseEvent(t, {bubbles:true, cancelable:true, view:window}));
    e.click(); };
  const nameSection = () => { // the "Business name" heading with its pencil, as in the About tab; the name is plain text until the pencil is pressed
    const norm = e => (e.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
    let heads = [];
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); // find the words "Business name" whatever element holds them
    for(let n; (n = tw.nextNode());) {
      if(!/^\s*business name\s*(edit)?\s*$/i.test(n.nodeValue)) continue;
      const el = n.parentElement;
      if(el && visible(el) && !el.closest('input,textarea,select,option,script,style') && !heads.includes(el)) heads.push(el);
    }
    if(heads.length > 1) heads = heads.filter(e => !e.closest('label,mat-label,[class*="label" i],legend')); // an open edit box also prints the words
    if(heads.length !== 1) return null;
    const head = heads[0], clean = l => l && !/^(edit|edit business name)$/i.test(l);
    let a = head.parentElement, value = null, section = head.parentElement;
    for(let i = 0; i < 4 && a; i++, a = a.parentElement) {
      const lines = (a.innerText || '').split('\n').map(x => x.trim()).filter(Boolean);
      if(lines.some(l => /^business category$/i.test(l))) break;
      const k = lines.findIndex(l => /^business name/i.test(l));
      const v = lines.slice(k + 1).find(clean);
      if(k >= 0 && v) { value = v; section = a; break; }
    }
    if(value === null) { // heading and value are separate siblings
      for(const sib of [head.nextElementSibling, head.parentElement?.nextElementSibling]) {
        const v = (sib?.innerText || '').split('\n').map(x => x.trim()).find(clean);
        if(v && !/^business category$/i.test(v)) { value = v; break; }
      }
    }
    return value === null ? null : {head, section, value};
  };
  if(kind === 'nameRead') { const n = nameSection(); return n ? {count:1, value:n.value} : {count:0}; }
  if(kind === 'namePencil') {
    const n = nameSection(); if(!n) return {count:0};
    const hr = n.head.getBoundingClientRect();
    const ctl = [...n.section.querySelectorAll('button,[role="button"],a,[tabindex],svg,mat-icon,i')].filter(e => visible(e) && !e.disabled);
    const byLabel = ctl.filter(e => /edit/i.test(labels(e).join(' ')) );
    const sameRow = ctl.filter(e => { const r = e.getBoundingClientRect(); return Math.abs((r.top + r.height / 2) - (hr.top + hr.height / 2)) < 24 && r.left >= hr.left; });
    const pick = byLabel.length === 1 ? byLabel[0] : (sameRow.length >= 1 ? sameRow[sameRow.length - 1] : (ctl.length === 1 ? ctl[0] : n.head));
    if(commit === true) press(pick);
    if(commit === 'point') {
      pick.scrollIntoView({block:'center'});
      const r = pick.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, hit = document.elementFromPoint(x, y);
      return {count:1, point:(hit && (hit === pick || pick.contains(hit) || hit.contains(pick))) ? {x, y} : null};
    }
    return {count:1};
  }
  if(kind === 'dialogText') return {count:0, text:(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500)};
  if(kind === 'fieldList') return {count:0, fields:fieldEls().map(e => labelsOf(e)[0] || '(no label)').slice(0,40)};
  if(kind === 'tabs') return {count:0, tabs:[...document.querySelectorAll('[role="tab"]')].filter(visible).map(e => name(e)).filter(Boolean).slice(0,15)};
  if(kind === 'tab' || kind === 'option') {
    const want = String(value).trim().toLowerCase();
    const els = kind === 'tab' ? [...document.querySelectorAll('[role="tab"]')] : [...document.querySelectorAll('[role="option"],[role="menuitem"],li')];
    const hit = els.filter(e => visible(e) && (kind === 'tab' ? name(e) : (e.innerText||'').trim()).toLowerCase() === want);
    if(commit === true && hit.length === 1) hit[0].click();
    return {count:hit.length};
  }
  if(kind.startsWith('field:')) { // one form field found by its label; 'set' writes the value, 'open' opens a custom drop-down
    const key = kind.slice(6);
    const RX = {name:/^business name\b/i, address:/^(street address|address line 1|address)(?!.*\b(line [23]|[23])\b)/i,
      address2:/^(street )?address( line)? 2\b/i, address3:/^(street )?address( line)? 3\b/i, locality:/^(city|town|locality|suburb)/i,
      admin:/^(state|province|administrative area|region)/i, postal:/^(pin ?code|postal ?code|zip|postcode)/i}[key];
    const EXACT = {name:/^business name$/i, address:/^street address$/i, address2:/^street address line 2$/i, address3:/^street address line 3$/i,
      locality:/^(city|town)$/i, admin:/^state$/i, postal:/^pin ?code$/i}[key];
    if(!RX) return {count:0};
    let els = fieldEls().filter(e => labelsOf(e).some(l => RX.test(l)));
    if(els.length > 1) { // tie-break: exact label, then the open dialog
      const exact = els.filter(e => labelsOf(e).some(l => EXACT.test(l))); if(exact.length >= 1) els = exact;
      if(els.length > 1) { const dlg = els.filter(e => e.closest('[role="dialog"],[aria-modal="true"]')); if(dlg.length >= 1) els = dlg; }
    }
    if(els.length !== 1) return {count:els.length};
    const e = els[0], custom = e.tagName !== 'SELECT' && (e.readOnly || e.getAttribute('role') === 'combobox' || !['INPUT','TEXTAREA'].includes(e.tagName));
    const read = () => (e.tagName === 'SELECT' ? (e.selectedOptions[0]?.text || '') : (e.value !== undefined && e.value !== '' ? e.value : (e.innerText || e.getAttribute('aria-label') || ''))).trim();
    if(commit === 'point') { e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {count:1, point:{x:r.x + r.width / 2, y:r.y + r.height / 2}}; }
    if(commit !== 'set' && commit !== 'open') return {count:1, value:read()};
    if(commit === 'open') { e.scrollIntoView({block:'center'}); e.click(); return {count:1, opened:true}; }
    if(e.tagName === 'SELECT') {
      const want = String(value).trim().toLowerCase();
      const opt = [...e.options].find(o => o.text.trim().toLowerCase() === want);
      if(!opt) return {count:1, set:false, reason:'"' + value + '" is not in the drop-down list'};
      e.value = opt.value;
    } else if(custom) return {count:1, set:false, custom:true, reason:'this is a custom drop-down'};
    else {
      e.focus();
      Object.getOwnPropertyDescriptor(e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(e, value);
    }
    e.dispatchEvent(new Event('input', {bubbles:true})); e.dispatchEvent(new Event('change', {bubbles:true})); e.dispatchEvent(new Event('blur', {bubbles:true}));
    return {count:1, set:read().toLowerCase() === String(value).trim().toLowerCase(), value:read(), reason:'the page did not accept the new value'};
  }
  let candidates = [];
  if(kind === 'search') {
    candidates = [...document.querySelectorAll('input')].filter(e => visible(e) &&
      (e.getAttribute('aria-label') === 'Search businesses' || e.placeholder === 'Search businesses'));
  } else if(kind === 'editor') {
    if(!rows[idx]) return {count:0};
    candidates = controls(rows[idx]).filter(e => /^(Edit business information|\d+ Google updates?)$/i.test(name(e)));
  } else {
    const patterns = {
      location:/^Location$/i,
      nameTab:/^(Business name|Name|Business information|Basic information|Info|About)$/i,
      edit:/^Edit (business )?location$/i,
      adjust:/^(Adjust|Edit)( pin location| map| location)?$/i,
      locate:/^(Show your location|Your location|My location|Current location|Go to your location|Use (my|your|current) location|Locate me)$/i,
      done:/^Done$/i,
      save:/^Save$/i,
      close:/^Close$/i,
      cancel:/^Cancel$/i,
      discard:/^(Discard|Discard changes|Discard edits|Leave|Leave page|Don['\u2019]t save)$/i
    };
    if(!patterns[kind]) return {count:0};
    candidates = controls(document).filter(e => labels(e).some(label=>patterns[kind].test(label)));
  }
  if(commit === 'point' && candidates.length === 1) {
    const e=candidates[0];e.scrollIntoView({block:'center'});
    const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
    const hit=document.elementFromPoint(x,y);
    return {count:1,point:hit && (hit===e || e.contains(hit)) ? {x,y} : null};
  }
  if(commit && candidates.length === 1) {
    const e = candidates[0];
    if(kind === 'search') {
      e.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,store);
      e.dispatchEvent(new Event('input',{bubbles:true}));
      e.dispatchEvent(new Event('change',{bubbles:true}));
    } else { e.scrollIntoView({block:'center'}); e.click(); }
  }
  return {count:candidates.length};
}

// Retry only observations. A navigation can destroy the old document while
// executeScript is reading it. Never wrap clicks or Save in this retry helper.
function transientDocumentError(error) {
  return /frame (?:with )?id.*(?:removed|not found)|no frame with id|execution context (?:was )?destroyed|cannot find context with specified id|document (?:was )?(?:unloaded|removed)/i.test(error?.message || '');
}
async function readPage(request) {
  for(let attempt=0;attempt<20;attempt++) {
    if(cancelRequested) throw new Error('Stopped while waiting for the page.');
    try {return await pageScript(request);}
    catch(error) {
      if(!transientDocumentError(error) || attempt===19) throw error;
      await wait(600);
    }
  }
}
async function top(tabId,kind,commit=false) {
  const request={target:{tabId},func:inspectUI,args:[kind,commit,STORE,IDX]};
  const results = commit===true ? await pageScript(request) : await readPage(request);
  return results[0].result;
}
async function candidates(tabId,kind) {
  const results = await readPage({target:{tabId,allFrames:true},func:inspectUI,args:[kind,false,STORE,IDX]});
  const total = results.reduce((sum,x) => sum + (x.result?.count || 0),0);
  return total === 1 ? results.find(x => x.result?.count === 1) : null;
}
async function click(tabId,kind,timeout=2500) {
  const deadline = runNow()+timeout;
  do {
    if(cancelRequested) throw new Error('Stopped by you. Cancel any unsaved edit in Google.');
    const found = await candidates(tabId,kind);
    if(found) {
      const result = await pageScript({target:{tabId,frameIds:[found.frameId]},
        func:inspectUI,args:[kind,true,STORE,IDX]});
      if(result[0].result.count !== 1) throw new Error('The page changed. No further clicks.');
      await wait(650);
      return true;
    }
    await wait(300);
  } while(runNow()<deadline);
  return false;
}
async function attach(tabId) {
  const old = await chrome.storage.session.get('attached');
  if(old.attached && old.attached !== tabId) {
    let alive = true;
    try { await chrome.tabs.get(old.attached); } catch { alive = false; }
    if(alive) throw new Error('A previous run is still attached to another tab. Press Stop in the dashboard first.');
    await chrome.storage.session.remove('attached');
  }
  let connected = false;
  if(old.attached === tabId) {
    try { await debugCommand({tabId},'Page.getFrameTree'); connected=true; }
    catch { await chrome.storage.session.remove('attached'); }
  }
  if(!connected) {
    await chrome.debugger.attach({tabId},'1.3');
    await chrome.storage.session.set({attached:tabId});
  }
}
async function detach() {
  const {attached} = await chrome.storage.session.get('attached');
  await chrome.storage.session.remove(['attached','positioned']);
  if(attached) {
    try { await debugCommand({tabId:attached},'Emulation.clearGeolocationOverride'); } catch {}
    try { await chrome.debugger.detach({tabId:attached}); } catch {}
  }
}
async function guard(tabId) {
  if(cancelRequested) throw new Error('Stopped. Cancel any unsaved edit in Google.');
  const s = await chrome.storage.session.get(['matched','attached']);
  if(s.matched?.tabId !== tabId || s.attached !== tabId) throw new Error('Find the store in this tab first.');
  const current = await top(tabId,'identity');
  if(!current.count || current.count !== s.matched.count || !current.link || current.link !== s.matched.link)
    throw new Error('The exact store profile cannot be confirmed. No Save. Return to its search result.');
}

// Locate one map surface in the rendered page. Unsupported frames fail closed.
function mapProbe() {
  const maps=[...document.querySelectorAll('.gm-style')].filter(e=>{
    const r=e.getBoundingClientRect();
    return r.width>120 && r.height>120 && getComputedStyle(e).visibility!=='hidden';
  });
  if(maps.length!==1) return null;
  const map=maps[0],r=map.getBoundingClientRect();
  // Away from the central marker and right-hand zoom controls.
  const x=r.x+r.width*.28,y=r.y+r.height*.56;
  for(const px of [x,x+10]) {
    const hit=document.elementFromPoint(px,y);
    if(!hit || !map.contains(hit) || hit.closest('button,a,input,[role="button"]')) return null;
  }
  if(x<0 || x+10>innerWidth || y<0 || y>innerHeight) return null;
  return {x,y,href:location.href,width:r.width,height:r.height};
}
// Each parent measures its own iframe element, so redirects and nested frames
// do not require URL matching or reuse of a previous store's screen position.
function frameBridge(mode,token,point) {
  const slot='__storeMapBridge';
  if(mode==='install') {
    globalThis[slot]?.cleanup?.();
    const state={token,result:null};
    const forward=p=>{
      if(window===window.top) state.result=p;
      else window.parent.postMessage({type:'store-map-measure',token,point:p},'*');
    };
    const receive=e=>{
      if(e.data?.type!=='store-map-measure' || e.data.token!==token) return;
      const p=e.data.point;
      if(!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      const frames=[...document.querySelectorAll('iframe')].filter(f=>f.contentWindow===e.source);
      if(frames.length!==1) return;
      const f=frames[0],r=f.getBoundingClientRect();
      if(Math.abs(r.width-f.offsetWidth)>1 || Math.abs(r.height-f.offsetHeight)>1) return;
      if(p.x<0 || p.y<0 || p.x+10>=f.clientWidth || p.y>=f.clientHeight) return;
      const q={x:r.left+f.clientLeft+p.x,y:r.top+f.clientTop+p.y};
      if(q.x<0 || q.y<0 || q.x+10>=innerWidth || q.y>=innerHeight) return;
      if([q.x,q.x+10].some(x=>document.elementFromPoint(x,q.y)!==f)) return;
      forward(q);
    };
    window.addEventListener('message',receive);
    state.cleanup=()=>window.removeEventListener('message',receive);
    state.forward=forward;globalThis[slot]=state;
    return true;
  }
  const state=globalThis[slot];
  if(state?.token!==token) return null;
  if(mode==='send') {state.forward(point);return true;}
  if(mode==='read') return state.result;
  if(mode==='remove') {state.cleanup();delete globalThis[slot];}
}
async function mapPoint(tabId) {
  const results=await readPage({target:{tabId,allFrames:true},func:mapProbe});
  const matches=results.filter(r=>r.result);
  if(matches.length!==1) throw new Error('Cannot identify one unobstructed map.');
  const match=matches[0],point={x:match.result.x,y:match.result.y};
  if(match.frameId===0) return point;
  const token=crypto.randomUUID();
  try {
    await pageScript({target:{tabId,allFrames:true},func:frameBridge,args:['install',token]});
    await pageScript({target:{tabId,frameIds:[match.frameId]},func:frameBridge,args:['send',token,point]});
    for(let i=0;i<15;i++) {
      if(cancelRequested) throw new Error('Stopped.');
      const r=await pageScript({target:{tabId},func:frameBridge,args:['read',token]});
      if(r[0].result) return r[0].result;
      await wait(100);
    }
    throw new Error('Could not measure the map through its containing frames.');
  } finally {
    try {await pageScript({target:{tabId,allFrames:true},func:frameBridge,args:['remove',token]});}catch{}
  }
}

async function dragMap(tabId,start,end) {
  let current=start;
  try {
    if(cancelRequested) throw new Error('Stopped before map drag.');
    await debugCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',...start,button:'none',buttons:0});
    await debugCommand({tabId},'Input.dispatchMouseEvent',{type:'mousePressed',...start,button:'left',buttons:1,clickCount:1});
    for(let i=1;i<=10;i++) {
      if(cancelRequested) throw new Error('Drag interrupted. Check and reposition the pin manually before Done.');
      current={x:start.x+(end.x-start.x)*i/10,y:start.y+(end.y-start.y)*i/10};
      await debugCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',...current,button:'left',buttons:1});
      await wait(40);
    }
    await wait(250); // release at rest to limit inertial panning
  } finally {
    try {await debugCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseReleased',...current,button:'left',buttons:0,clickCount:1});} catch {}
  }
}

// Pick in the TOP viewport so nested-frame offsets do not have to be guessed.
// This click is consumed by the overlay; it is never sent to the Google form.
function pickMapPoint() {
  return new Promise(resolve=>{
    if(globalThis.b5001CancelPick) globalThis.b5001CancelPick();
    const overlay=document.createElement('div');
    overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.03);';
    const banner=document.createElement('div');
    banner.textContent='One-time setup: click a blank part of the MAP, away from the red pin and buttons. Two small drags will follow. Esc cancels.';
    banner.style.cssText='position:absolute;top:8px;left:10%;right:10%;padding:12px;background:#1558c0;color:white;font:15px system-ui;pointer-events:none;';
    overlay.append(banner);document.documentElement.append(overlay);
    const controls=document.getElementById('store-batch-controls-v49');if(controls) document.documentElement.append(controls);
    let timer;
    const finish=value=>{
      clearInterval(timer);overlay.remove();document.removeEventListener('keydown',key,true);
      delete globalThis.b5001CancelPick;resolve(value);
    };
    const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();finish(null);}};
    globalThis.b5001CancelPick=()=>finish(null);
    document.addEventListener('keydown',key,true);
    let remaining=60000,previous=Date.now();
    timer=setInterval(()=>{const now=Date.now();if(!document.getElementById('store-batch-controls-v49')?.dataset.paused || document.getElementById('store-batch-controls-v49').dataset.paused!=='true') remaining-=now-previous;previous=now;if(remaining<=0) finish(null);},500);
    overlay.addEventListener('click',e=>{
      e.preventDefault();e.stopImmediatePropagation();
      const x=e.clientX,y=e.clientY;
      overlay.style.pointerEvents='none';
      const a=document.elementFromPoint(x,y),b=document.elementFromPoint(x+10,y);
      overlay.style.pointerEvents='auto';
      const surface=el=>el?.closest('iframe,.gm-style');
      const root=surface(a);
      if(!root || root!==surface(b) || x+10>=innerWidth || y>=innerHeight || y<60){
        banner.textContent='Please click inside the visible map, away from its controls. Esc cancels.';return;
      }
      const r=root.getBoundingClientRect();
      finish({x,y,anchor:{tag:root.tagName,src:root.getAttribute('src')||'',left:r.left,top:r.top,width:r.width,height:r.height}});
    },true);
  });
}
function checkPickedPoint(point) {
  const a=document.elementFromPoint(point.x,point.y)?.closest('iframe,.gm-style');
  const b=document.elementFromPoint(point.x+10,point.y)?.closest('iframe,.gm-style');
  if(!a || a!==b || a.tagName!==point.anchor.tag || (a.getAttribute('src')||'')!==point.anchor.src) return false;
  const r=a.getBoundingClientRect();
  return ['left','top','width','height'].every(k=>Math.abs(r[k]-point.anchor[k])<1);
}

// Calibration lives only for this run. Each later editor must have the same
// frame geometry and source origin/path before reusing the selected point.
function reusePoint(old) {
  const key=src=>{try{const u=new URL(src,location.href);return u.origin+u.pathname;}catch{return src;}};
  const roots=[...document.querySelectorAll(old.anchor.tag==='IFRAME'?'iframe':'.gm-style')].filter(e=>{
    const r=e.getBoundingClientRect();
    return e.tagName===old.anchor.tag && key(e.getAttribute('src')||'')===key(old.anchor.src) &&
      ['left','top','width','height'].every(k=>Math.abs(r[k]-old.anchor[k])<1);
  });
  if(roots.length!==1) return null;
  const root=roots[0];
  if([old.x,old.x+10].some(x=>document.elementFromPoint(x,old.y)?.closest('iframe,.gm-style')!==root)) return null;
  return {...old,anchor:{...old.anchor,src:root.getAttribute('src')||''}};
}
let pauseRequested=false;
const DONE_STATES=['submitted','done_manual','reviewed_skip'];
async function ledger() {
  const {batchRows}=await chrome.storage.local.get('batchRows');
  return batchRows || [];
}
// history remembers finished stores even if the queue is re-imported, so nothing is saved twice.
async function setRow(rows,index,status,extra={}) {
  Object.assign(rows[index],extra,{status,updated:new Date().toISOString()});
  const update={batchRows:rows};
  if(DONE_STATES.includes(status)) {
    const {history={}}=await chrome.storage.local.get('history');
    history[rows[index].store]={status,latitude:rows[index].latitude,longitude:rows[index].longitude,updated:rows[index].updated};
    update.history=history;
  }
  await chrome.storage.local.set(update);
}
async function patchRow(rows,index,extra) { // update fields without touching the coordinate status
  Object.assign(rows[index],extra);
  await chrome.storage.local.set({batchRows:rows});
}
const profileKey=r=>['v4.4',r.name,r.address,r.address2,r.address3,r.locality,r.admin,r.postal].join('|'); // version in the key: a new extension version re-checks details
async function importRows(incoming) {
  if(running) throw new Error('A run is in progress. Stop or pause it before importing.');
  const {history={},batchRows=[]}=await chrome.storage.local.get(['history','batchRows']);
  const old=new Map(batchRows.map(r=>[r.store,r]));
  const same=(a,b)=>Math.abs(a-b)<1e-9;
  const rows=incoming.map(n=>{
    const row={...n,policyVersion:'4.7'};
    const h=history[n.store], o=old.get(n.store);
    if(o?.detailsReview) row.detailsReview=true;
    if(row.status==='invalid' || row.sheetSkip) return row;
    if(h && same(h.latitude,n.latitude) && same(h.longitude,n.longitude)) {
      row.status=h.status; row.error=''; row.note='Already done earlier (coordinates unchanged).';
    } else if(o && ['processing','saving','submitted_review'].includes(o.status)) {
      Object.assign(row,{status:o.status,error:o.error,updated:o.updated});
    } else if(h) {
      row.note='Coordinates changed since the earlier save (was '+h.latitude+', '+h.longitude+'): queued again.';
    }
    if(o && ['4.6','4.7'].includes(o.policyVersion) && profileKey(o)===profileKey(row)) Object.assign(row,{checks:o.checks,observed:o.observed,checkedAt:o.checkedAt,checkError:o.checkError,targets:o.targets,sharedCount:o.sharedCount,detailsDone:o.detailsDone,detailsAt:o.detailsAt});
    if (row.targets && (!same(o.latitude,n.latitude) || !same(o.longitude,n.longitude))) {
      row.targets=row.targets.map(t=>({...t,coordDone:false}));
    }
    return row;
  });
  await chrome.storage.local.set({batchRows:rows});
  await chrome.storage.local.remove('runCheckpoint');
  return rows;
}
async function ensureForeground(tabId) {
  const tab=await chrome.tabs.get(tabId);
  if(new URL(tab.url).hostname!=='business.google.com') throw new Error('Return to the Business Manager page.');
  if(!tab.active) await suspendRun('Paused because you changed tabs');
  await runGate();
}

async function openMatchedEditor(tabId) {
  await guard(tabId);await ensureForeground(tabId);
  // The pencil is in the top-level results table: use a real browser mouse
  // click at the freshly measured exact row control, not a synthetic DOM click.
  const result=await top(tabId,'editor','point');
  if(result?.count!==1 || !result.point) throw new Error('The matched store pencil is missing or covered. No click.');
  const point=result.point;
  if(cancelRequested) throw new Error('Stopped before opening editor.');
  await debugCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',...point,button:'none',buttons:0});
  await debugCommand({tabId},'Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
  await debugCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});
  await wait(1000);
}


// Search for STORE and return what the results table shows (all businesses carrying this code). Opens nothing.
async function searchStore(tabId) {
  if(await candidates(tabId,'location') || await candidates(tabId,'done') || await candidates(tabId,'save'))
    throw new Error('Close the open editor first, then resume. No refresh needed.');
  await chrome.storage.session.remove(['matched','positioned']);
  IDX=0;
  if((await top(tabId,'search')).count!==1) throw new Error('Open the business list with its Search businesses box.');
  await top(tabId,'search',true);
  for(const type of ['keyDown','keyUp']) await debugCommand({tabId},'Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  let identity,prev=-1;
  for(let i=0;i<30;i++) {
    if(cancelRequested) throw new Error('Stopped.');
    await wait(500);
    identity=await top(tabId,'identity');
    // the same non-zero result count twice in a row = the table has finished drawing
    if(identity.count>0 && identity.count===prev) break;
    prev=identity.count;
  }
  if(identity.count>0 && identity.links.some(l=>!l)) throw new Error('A result for '+STORE+' has no profile link, so it cannot be identified safely.');
  return identity;
}
// Why a listing must be skipped, judged from its row in the results table ('' = fine).
const DUP_RX=/\bduplicate\b/i;
const VERIFY_RX=/verify now|get verified|needs? (to be )?verif|verification (is )?(required|needed|pending|in progress)|not verified|unverified|suspended|verify (your|this) business/i;
function classifyListing(text) {
  if(DUP_RX.test(text||'')) return 'Duplicate listing in Business Manager';
  if(VERIFY_RX.test(text||'')) return 'Verification required in Business Manager (store will not open)';
  return '';
}
async function waitEditor(tabId,timeout=30000) {
  const end=runNow()+timeout;
  while(runNow()<end) {
    if(cancelRequested) throw new Error('Stopped.');
    if(await candidates(tabId,'location')) return true;
    await wait(500);
  }
  return false;
}
// Search again (unless the caller just did), confirm the same businesses are listed, open business number t.
async function openEditorFor(tabId,exp,t,fresh) {
  if(!fresh) {
    const id=await searchStore(tabId);
    if(id.count!==exp.count || id.links.join('|')!==exp.links.join('|')) throw new Error('The search results for '+STORE+' changed. Nothing edited.');
  }
  IDX=t;
  await chrome.storage.session.set({matched:{tabId,link:exp.links[t],count:exp.count}});
  await tell(STORE+(exp.count>1?` (business ${t+1} of ${exp.count})`:'')+': opening the store editor…');
  await openMatchedEditor(tabId);
  return waitEditor(tabId);
}
// Read-only: text of the visible address/name fields in the open editor.
async function readEditorFields(tabId) {
  try {
    const res=await readPage({target:{tabId,allFrames:true},func:inspectUI,args:['editorText',false,STORE]});
    return res.map(r=>r.result?.text||'').filter(Boolean).join(' | ');
  } catch { return ''; }
}
const oneLine=t=>String(t||'').replace(/\s*\n+\s*/g,' | ').slice(0,400);
async function recordChecks(rows,index,sources,cols,biz) {
  const row=rows[index];
  const checks=ProfileMatch.checkProfile(row,sources);
  // When the list shows the real columns, compare each field with its own column (exact, not word-in-text).
  const have=(cols||[]).filter(Boolean);
  if(have.length) for(const [key] of FIELD_LIST) {
    if(!String(row[key]??'').trim()) {checks[key==='postal'?'postal':key]='blank';continue;}
    const vals=have.map(c=>c[key]).filter(v=>v!==undefined);
    if(!vals.length) continue;
    const results=vals.map(v=>ProfileMatch.same(row[key],v,SAME_OPTS[key])?'match':ProfileMatch.compare(row[key],v,{...SAME_OPTS[key],partial:0.6}));
    checks[key]=results.includes('match')?'match':results.includes('partial')?'partial':'mismatch';
  }
  // No separate columns: the list shows "name line, then address lines" in one cell. Name is compared with the first line ONLY
  // (the address words must not make a short name look right); the rest is compared with the address block.
  const bz=(biz||[]).filter(Boolean);
  if(!have.length && bz.length) {
    const nm=String(row.name??'').trim();
    if(nm) {
      const r=bz.map(b=>ProfileMatch.same(nm,b.name)?'match':(c=>c==='match'?'partial':c)(ProfileMatch.compare(nm,b.name,{partial:0.6})));
      checks.name=r.includes('match')?'match':r.includes('partial')?'partial':'mismatch';
    }
    if(bz.some(b=>b.block)) for(const key of ['address','locality','admin','postal']) {
      if(!String(row[key]??'').trim()) continue;
      const r=bz.filter(b=>b.block).map(b=>ProfileMatch.compare(row[key],b.block,{...SAME_OPTS[key],partial:key==='address'?0.6:0.99}));
      checks[key]=r.includes('match')?'match':r.includes('partial')?'partial':'mismatch';
    }
  }
  await patchRow(rows,index,{checks,observed:oneLine(sources.filter(Boolean).join(' || ')),checkedAt:new Date().toISOString(),checkError:''});
}
async function nudge(tabId,calibration) {
  let p,picked;
  try {p=await mapPoint(tabId);} catch(error) {
    if(calibration) {
      const result=await pageScript({target:{tabId},func:reusePoint,args:[calibration]});
      picked=result[0].result;
      // Changed geometry triggers a fresh selection instead of ending the batch.
    }
    if(!picked) {
      if(cancelRequested) throw new Error('Stopped.');
      await tell(STORE+': click a blank part of this map. This selection will be reused for the remaining stores.');
      const result=await pageScript({target:{tabId},func:pickMapPoint});
      picked=result[0].result;
      if(!picked) throw new Error('Map selection cancelled or timed out.');
    }
    p={x:picked.x,y:picked.y};
  }
  await guard(tabId);await ensureForeground(tabId);
  if(!await candidates(tabId,'done')) throw new Error('Map editor closed unexpectedly.');
  if(picked) {
    const check=await pageScript({target:{tabId},func:checkPickedPoint,args:[picked]});
    if(!check[0].result) throw new Error('Map moved before drag.');
  }
  const q={x:p.x+10,y:p.y};
  await dragMap(tabId,p,q);await wait(450);await guard(tabId);
  if(picked) {
    const check=await pageScript({target:{tabId},func:checkPickedPoint,args:[picked]});
    if(!check[0].result) throw new Error('Map moved during drag. Nothing saved.');
  } else {
    const check=await mapPoint(tabId);
    if(Math.abs(check.x-p.x)>1 || Math.abs(check.y-p.y)>1) throw new Error('Map layout changed during drag.');
  }
  await dragMap(tabId,q,p);await wait(1200);
  return picked || calibration;
}
// Cancel any half-finished edit (Cancel / Escape / "discard changes?" confirmation). True when no Save/Done control is left.
async function discardEdits(tabId) {
  for(let i=0;i<3;i++) {
    if(!await candidates(tabId,'save') && !await candidates(tabId,'done')) return true;
    if(!await click(tabId,'cancel',1500)) {
      for(const type of ['keyDown','keyUp']) await debugCommand({tabId},'Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await wait(700);
    }
    await click(tabId,'discard',1500);
  }
  return !await candidates(tabId,'save') && !await candidates(tabId,'done');
}
async function closeEditor(tabId) {
  if(await candidates(tabId,'save') || await candidates(tabId,'done')) {
    if(!await discardEdits(tabId)) throw new Error('Editor still has unsaved controls that could not be cancelled.');
  }
  if(await candidates(tabId,'location')) {
    if(!await click(tabId,'close',3000)) {
      for(const type of ['keyDown','keyUp']) await debugCommand({tabId},'Input.dispatchKeyEvent',{type,key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    }
  }
  for(let i=0;i<15;i++) {
    await wait(400);
    if(!await candidates(tabId,'location') && !await candidates(tabId,'save') && !await candidates(tabId,'done') && (await top(tabId,'search')).count===1) return;
  }
  throw new Error('Could not confirm editor closed. Close it manually, then resume.');
}

const keepAlive=()=>setInterval(()=>{chrome.runtime.getPlatformInfo().catch(()=>{});},20000);

// One entry per business that carries this store code. Results of earlier runs are kept for businesses already finished.
function buildTargets(row,exp) {
  const prev=new Map((row.targets||[]).map(x=>[x.link,x]));
  row.sharedCount=exp.count;
  row.targets=exp.links.map((link,i)=>{
    const o=prev.get(link)||{},keep=!!o.detailsDone || RunPolicy.detailsSubmitted(o);
    return {link,n:i+1,shows:oneLine(exp.summaries[i]),skip:'',coordDone:!!o.coordDone,detailsDone:keep,
      detail:o.detail||{},was:o.was||{},notes:o.notes||{},verify:undefined};
  });
}
const FIELD_LIST=[['name','business name'],['address','address'],['locality','locality'],['admin','administrative area'],['postal','postal code']];
const SAME_OPTS={name:{},address:{},address2:{},address3:{},locality:{},admin:{state:true},postal:{digits:true}};
const ADDR_LIMIT=80; // characters allowed in one street-address line
// The three street address lines to enter for this sheet row (line 1 alone unless it is longer than ADDR_LIMIT).
const addressPlan=row=>ProfileMatch.splitAddress(row.address,row.address2,row.address3,ADDR_LIMIT);
async function readField(tabId,key) { // current value of a form field, or null when it is not on screen
  const found=await candidates(tabId,'field:'+key);
  if(!found) return null;
  const r=await readPage({target:{tabId,frameIds:[found.frameId]},func:inspectUI,args:['field:'+key,'read',STORE,IDX]});
  return r[0].result?.count===1 ? (r[0].result.value||'') : null;
}
async function readNameDisplayed(tabId) {
  const res=await readPage({target:{tabId,allFrames:true},func:inspectUI,args:['nameRead',false,STORE,IDX]});
  const hit=res.filter(r=>r.result?.count===1);
  return hit.length===1 ? hit[0].result.value : null;
}
async function pressNamePencil(tabId) {
  const res=await readPage({target:{tabId,allFrames:true},func:inspectUI,args:['namePencil',false,STORE,IDX]});
  const hit=res.filter(r=>r.result?.count===1);
  if(hit.length!==1) return false;
  await pageScript({target:{tabId,frameIds:[hit[0].frameId]},func:inspectUI,args:['namePencil',true,STORE,IDX]});
  await wait(900);return true;
}
async function dialogSnapshot(tabId) {
  try {
    const res=await readPage({target:{tabId,allFrames:true},func:inspectUI,args:['dialogText',false,STORE,IDX]});
    return res.map(r=>r.result?.text||'').filter(Boolean).sort((a,b)=>b.length-a.length)[0]||'';
  } catch {return '';}
}
// ---- real mouse / keyboard fallbacks (used when a synthetic click or a plain value change is ignored by the page) ----
async function pointOf(tabId,kind) { // {frameId, point} of the single matching control, or null
  const res=await readPage({target:{tabId,allFrames:true},func:inspectUI,args:[kind,false,STORE,IDX]});
  const hit=res.filter(r=>r.result?.count===1);
  if(hit.length!==1) return null;
  const r=await pageScript({target:{tabId,frameIds:[hit[0].frameId]},func:inspectUI,args:[kind,'point',STORE,IDX]});
  const point=r[0].result?.point;
  return point?{frameId:hit[0].frameId,point}:null;
}
async function realClick(tabId,frameId,point) {
  let p=point;
  if(frameId!==0) { // translate frame coordinates to the top page
    const token=crypto.randomUUID();
    try {
      await pageScript({target:{tabId,allFrames:true},func:frameBridge,args:['install',token]});
      await pageScript({target:{tabId,frameIds:[frameId]},func:frameBridge,args:['send',token,point]});
      p=null;
      for(let i=0;i<15 && !p;i++) {
        const r=await pageScript({target:{tabId},func:frameBridge,args:['read',token]});
        p=r[0].result; if(!p) await wait(100);
      }
    } finally {try {await pageScript({target:{tabId,allFrames:true},func:frameBridge,args:['remove',token]});} catch {}}
    if(!p) return false;
  }
  if(cancelRequested) throw new Error('Stopped.');
  await debugCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x,y:p.y,button:'none',buttons:0});
  await debugCommand({tabId},'Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',buttons:1,clickCount:1});
  await debugCommand({tabId},'Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',buttons:0,clickCount:1});
  return true;
}
async function pressNamePencilReal(tabId) {
  const p=await pointOf(tabId,'namePencil');
  if(!p || !await realClick(tabId,p.frameId,p.point)) return false;
  await wait(900);return true;
}
// Click into a field, select everything and type the value like a person would (value '' = just clear it).
async function typeField(tabId,key,value) {
  const p=await pointOf(tabId,'field:'+key);
  if(!p) return {ok:false,reason:'field not found'};
  if(!await realClick(tabId,p.frameId,p.point)) return {ok:false,reason:'could not click into the field'};
  await wait(250);
  const send=(type,extra)=>debugCommand({tabId},'Input.dispatchKeyEvent',{type,...extra});
  await send('rawKeyDown',{key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2,commands:['selectAll']});
  await send('keyUp',{key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
  await send('rawKeyDown',{key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  await send('keyUp',{key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
  if(value) await debugCommand({tabId},'Input.insertText',{text:value});
  await wait(500);
  const now=await readField(tabId,key);
  return now!==null && ProfileMatch.same(value,now) ? {ok:true} : {ok:false,reason:'typing did not change the field (it shows "'+(now??'')+'")'};
}
async function waitField(tabId,key,ms) {
  const end=runNow()+ms;
  do {if(await readField(tabId,key)!==null) return true; await wait(350);} while(runNow()<end);
  return false;
}
// Business name lives in the About tab as plain text; press its pencil to get an edit box, change it, Save.
// Every stage is written to the notes so the Excel file shows exactly where it stopped. The saved value is confirmed after a page refresh.
async function nameStep(tabId,row,tg) {
  const want=String(row.name??'').trim();
  if(!want) {tg.detail.name='blank';return;}
  await clickTabNamed(tabId,'About');
  let cur=await readNameDisplayed(tabId);
  if(cur===null) cur=await readField(tabId,'name'); // already in edit mode
  if(cur===null) {
    tg.detail.name='notfound';
    if(!tg.diag) tg.diag='Business name not found in the About tab. Screen text: '+(await dialogSnapshot(tabId));
    return;
  }
  if(ProfileMatch.same(want,cur)) {tg.detail.name='ok';return;}
  // 1. get an edit box: already open, else the pencil by script, else a real mouse click on the pencil
  let editing=await readField(tabId,'name')!==null;
  if(!editing && await pressNamePencil(tabId)) editing=await waitField(tabId,'name',2500);
  if(!editing && await pressNamePencilReal(tabId)) editing=await waitField(tabId,'name',4000);
  if(!editing) {
    tg.detail.name='failed';tg.notes.name='the pencil next to Business name did not open an edit box';
    tg.diag=tg.diag||'Business name edit box did not open. Screen text: '+(await dialogSnapshot(tabId));
    return;
  }
  // 2. enter the name (script first, then real typing) and 3. press Save
  let reason='';
  for(const mode of ['set','type']) {
    const r=mode==='set'?await setField(tabId,'name',want):await typeField(tabId,'name',want);
    if(!r.ok) {reason=r.reason;continue;}
    await guard(tabId);await ensureForeground(tabId);
    await tell(STORE+': saving business name…');
    if(!await clickSave(tabId)) {reason='Save was not available after entering the name ('+mode+' entry)';continue;}
    tg.was.name=cur;
    const w=await waitSaved(tabId);
    if(!w.cleared) {
      tg.detail.name='review';tg.notes.name='Save is still showing after clicking it. Screen: '+(await dialogSnapshot(tabId));
      throw new Error(STORE+': business name Save did not finish. Review this store; no automatic second Save.');
    }
    tg.detail.name='updated';tg.notes.name='';
    await wait(800);
    return; // the page keeps showing the old name until it is refreshed: the refresh check confirms it
  }
  tg.detail.name='failed';tg.notes.name=reason||'could not enter the new name';
  tg.diag=tg.diag||'Business name could not be changed. Screen text: '+(await dialogSnapshot(tabId));
}
async function listFields(tabId) {
  try {
    const res=await readPage({target:{tabId,allFrames:true},func:inspectUI,args:['fieldList',false,STORE,IDX]});
    return [...new Set(res.flatMap(r=>r.result?.fields||[]))].join(' | ');
  } catch {return '';}
}
async function clickTabNamed(tabId,tabName) {
  const res=await readPage({target:{tabId,allFrames:true},func:inspectUI,args:['tab',false,STORE,IDX,tabName]});
  const hit=res.filter(r=>r.result?.count===1);
  if(hit.length!==1) return false;
  await pageScript({target:{tabId,frameIds:[hit[0].frameId]},func:inspectUI,args:['tab',true,STORE,IDX,tabName]});
  await wait(900);return true;
}
// Look for a field; if it is not on this screen, open the editor's other tabs one by one (never Save) until it appears.
async function findFieldValue(tabId,key) {
  let cur=await readField(tabId,key);
  if(cur!==null) return cur;
  if(key==='name') {await click(tabId,'nameTab',2000);cur=await readField(tabId,key);if(cur!==null) return cur;}
  const res=await readPage({target:{tabId,allFrames:true},func:inspectUI,args:['tabs',false,STORE,IDX]});
  const names=[...new Set(res.flatMap(r=>r.result?.tabs||[]))].filter(n=>!/^location$/i.test(n)).slice(0,8);
  for(const n of names) {
    if(cancelRequested) throw new Error('Stopped.');
    if(await clickTabNamed(tabId,n)) {cur=await readField(tabId,key);if(cur!==null) return cur;}
  }
  return null;
}
async function setField(tabId,key,value) {
  const found=await candidates(tabId,'field:'+key);
  if(!found) return {ok:false,reason:'field not found'};
  const r=await pageScript({target:{tabId,frameIds:[found.frameId]},func:inspectUI,args:['field:'+key,'set',STORE,IDX,value]});
  const x=r[0].result||{};
  if(x.custom) { // custom drop-down (e.g. State): open it, pick the matching option, then read it back
    await pageScript({target:{tabId,frameIds:[found.frameId]},func:inspectUI,args:['field:'+key,'open',STORE,IDX,value]});
    await wait(700);
    const o=await readPage({target:{tabId,allFrames:true},func:inspectUI,args:['option',false,STORE,IDX,value]});
    const hit=o.filter(q=>q.result?.count===1);
    if(hit.length===1) {
      await pageScript({target:{tabId,frameIds:[hit[0].frameId]},func:inspectUI,args:['option',true,STORE,IDX,value]});
      await wait(700);
      const now=await readField(tabId,key);
      if(now!==null && ProfileMatch.same(value,now,SAME_OPTS[key])) return {ok:true};
    }
    return {ok:false,reason:'could not pick "'+value+'" in the drop-down'};
  }
  return {ok:!!x.set,reason:x.reason||'could not set the field'};
}
// Compare one field with the sheet and change it on screen when it differs. Nothing is saved here.
async function detailStep(tabId,row,tg,key,pending,wanted) {
  if(tg.detail?.[key]==='updated') return; // Already submitted: stale display must not cause another write.
  const want=String(wanted!==undefined?wanted:(row[key]??'')).trim();
  if(!want) {
    if(key==='address2' || key==='address3') { // nothing in the sheet for this line: remove any text the page has there
      const cur=await readField(tabId,key);
      if(cur===null || !cur.trim()) {tg.detail[key]='blank';return;}
      let r=await setField(tabId,key,'');
      if(!r.ok) r=await typeField(tabId,key,'');
      if(!r.ok) {tg.detail[key]='failed';tg.notes[key]='could not clear it: '+r.reason;return;}
      tg.was[key]=cur;tg.notes[key]='cleared';tg.detail[key]='pending';pending.push(key);
      return;
    }
    tg.detail[key]='blank';return; // blank city/state/PIN in the sheet: leave the page alone
  }
  const cur=await findFieldValue(tabId,key);
  if(cur===null) {
    tg.detail[key]='notfound';
    if(!tg.diag) tg.diag='Field not found: '+key+'. Fields visible on screen: '+(await listFields(tabId)||'none');
    return;
  }
  if(ProfileMatch.same(want,cur,SAME_OPTS[key]) || (key==='admin' && ProfileMatch.compare(want,cur,{state:true})==='match')) {tg.detail[key]='ok';return;}
  const r=await setField(tabId,key,want);
  if(!r.ok) {tg.detail[key]='failed';tg.notes[key]=r.reason;return;}
  tg.was[key]=cur;tg.detail[key]='pending';pending.push(key);
}
async function clickSave(tabId) {return click(tabId,'save',3000);}
async function waitSaved(tabId) {
  let messages=[];
  for(let i=0;i<25;i++) {
    if(cancelRequested) throw new Error('Stopped after Save; review this row.');
    await wait(1000);
    const response=await readPage({target:{tabId,allFrames:true},func:inspectUI,args:['response',false,STORE,IDX]});
    messages=[...new Set(response.flatMap(r=>r.result?.messages||[]))];
    const errors=[...new Set(response.flatMap(r=>r.result?.errors||[]))];
    if(errors.length) throw new Error('Google reported a problem: '+errors.join(' | '));
    if(response.some(r=>r.result?.verify)) throw new Error('Google is asking for verification after this change. Handle it by hand, then resume.');
    if(!response.some(r=>r.result?.saveVisible)) return {cleared:true,messages};
  }
  return {cleared:false,messages};
}
async function saveDetails(tabId,tg,pending,rows,index) {
  await guard(tabId);await ensureForeground(tabId);
  await patchRow(rows,index,{detailsReview:true});
  if(!await clickSave(tabId)) {pending.forEach(k=>{tg.detail[k]='failed';tg.notes[k]='Save button not found';});throw new Error('Save button not found; nothing was saved. Close the editor, then resume.');}
  const r=await waitSaved(tabId);
  if(!r.cleared) {pending.forEach(k=>tg.detail[k]='review');throw new Error('Save is still visible after changing '+pending.join(', ')+'. Review this store; no automatic second Save.');}
  pending.forEach(k=>tg.detail[k]='updated');pending.length=0;
  await patchRow(rows,index,{detailsReview:false});
}

// One business: update details and/or coordinates. Returns 'done' or 'unopened'.
async function processTarget(tabId,rows,index,t,exp,opts,ctx) {
  const row=rows[index],tg=row.targets[t],pending=[];
  const doDetails=opts.details && !tg.detailsDone, doCoords=opts.coords && !tg.coordDone;
  if(!doDetails && !doCoords) return 'done';
  let opened=false;
  try {opened=await openEditorFor(tabId,exp,t,ctx.fresh && t===0);}
  catch(error) {if(!/pencil is missing|Location tab did not load/i.test(error.message)) throw error;}
  if(!opened) {
    await closeEditor(tabId); // throws (and stops the run) if the screen is in an unknown state
    tg.skip='Store would not open - verification may be required';
    return 'unopened';
  }
  ctx.fresh=false;
  await guard(tabId);
  const early=await readEditorFields(tabId);
  await guard(tabId);
  if(!await click(tabId,'location',10000)) throw new Error(STORE+': Location tab not found. Nothing further done.');
  if(t===0) await recordChecks(rows,index,[exp.summaries.join('\n'),early,await readEditorFields(tabId)],exp.cols,exp.biz);
  const editClicked=await click(tabId,'edit',5000);
  if(doDetails) {
    await tell(STORE+': checking address, locality, state and PIN…');
    const plan=addressPlan(row);
    if(plan.tooLong) { // cannot fit in three lines: change none of the address lines
      for(const k of ['address','address2','address3']) tg.detail[k]='failed';
      tg.notes.address='address is too long for 3 lines of '+ADDR_LIMIT+' characters ('+plan.lines.join(' / ').length+' characters) - shorten it in the sheet';
    } else {
      for(const [i,key] of ['address','address2','address3'].entries()) await detailStep(tabId,row,tg,key,pending,plan.lines[i]);
    }
    for(const key of ['locality','admin','postal']) await detailStep(tabId,row,tg,key,pending);
    if(!doCoords && pending.length) {await tell(STORE+': saving address changes…');await saveDetails(tabId,tg,pending,rows,index);}
  }
  if(doCoords) {
    await debugCommand({tabId},'Emulation.setGeolocationOverride',GEO);
    await tell(`${STORE}: setting ${row.latitude}, ${row.longitude}…`);
    if(!editClicked) await click(tabId,'edit',5000);
    await click(tabId,'adjust',5000);
    if(!await candidates(tabId,'done')) throw new Error('Adjust map is not open.');
    if(!await click(tabId,'locate',5000)) throw new Error('Current-location control not found. No Save.');
    await wait(3500);
    ctx.calibration=await nudge(tabId,ctx.calibration);
    await guard(tabId);
    if(!await click(tabId,'done',5000)) throw new Error('Done button not found.');
    await wait(1000);await guard(tabId);await ensureForeground(tabId);
    if(await candidates(tabId,'done') || !await candidates(tabId,'save')) throw new Error('Save stage could not be confirmed.');
    // Persist before clicking: interrupted/ambiguous submissions never retry automatically.
    await setRow(rows,index,'saving');
    if(!await clickSave(tabId)) {
      pending.forEach(k=>{tg.detail[k]='failed';tg.notes[k]='Save button not found';});
      await setRow(rows,index,'error',{error:'Save button not found; nothing was clicked. Safe to retry.'});
      throw new Error('Save button not found; nothing was clicked. Close the editor, then resume.');
    }
    await setRow(rows,index,'submitted_review');
    await tell(STORE+': Save clicked; waiting for the editor to finish…');
    const r=await waitSaved(tabId);
    if(!r.cleared) throw new Error('Save is still visible. Review this row; no automatic second Save.');
    pending.forEach(k=>tg.detail[k]='updated');pending.length=0;
    tg.coordDone=true;
    await setRow(rows,index,'processing',{messages:r.messages,error:''}); // the row becomes 'submitted' once every business is done
  }
  // Finish submission now. The later check pass must never requeue a saved target.
  if(doDetails) tg.detailsDone=RunPolicy.detailsSubmitted(tg);
  await patchRow(rows,index,{});
  await closeEditor(tabId);
  await chrome.storage.session.remove('matched');
  await wait(1000);
  return 'done';
}

// ---- Refresh and confirm -------------------------------------------------------------------------------------------
// Business Manager keeps showing the old values after Save until the page is reloaded. So after a business was changed
// the page is refreshed, the store is searched and opened again (read only, never Save) and every sheet value is
// compared with what the page now shows. The result is stored in tg.verify and written to the Excel file.
async function reloadBusinessPage(tabId) {
  await chrome.storage.session.remove('matched');
  try {await debugCommand({tabId},'Page.enable');} catch {}
  await chrome.tabs.reload(tabId);
  await wait(1500);
  for(let i=0;i<60;i++) {
    if(cancelRequested) throw new Error('Stopped while the page was refreshing.');
    if(i<6) try {await debugCommand({tabId},'Page.handleJavaScriptDialog',{accept:true});} catch {} // "Leave site?" prompt
    try {
      const tab=await chrome.tabs.get(tabId);
      if(tab.status==='complete' && (await top(tabId,'search')).count===1) return;
    } catch {}
    await wait(500);
  }
  throw new Error('The business list did not come back after refreshing the page.');
}
// The values this sheet row should now have on the page, in the order they are checked.
function expectedValues(row) {
  const plan=addressPlan(row);
  const list=[['name',row.name,{}]];
  if(!plan.tooLong) list.push(['address',plan.lines[0],{}],['address2',plan.lines[1],{}],['address3',plan.lines[2],{}]);
  list.push(['locality',row.locality,SAME_OPTS.locality],['admin',row.admin,SAME_OPTS.admin],['postal',row.postal,SAME_OPTS.postal]);
  // lines 2 and 3 that are empty in the sheet must now be empty on the page
  return list.map(([key,v,opts])=>({key,want:String(v??'').trim(),opts,empty:(key==='address2'||key==='address3') && !String(v??'').trim()}));
}
async function verifyTarget(tabId,row,t,exp,fresh,uiIndex=t) {
  const tg=row.targets[t];
  tg.verify={};
  let opened=false;
  try {opened=await openEditorFor(tabId,exp,uiIndex,fresh);}
  catch(error) {if(!/pencil is missing|Location tab did not load/i.test(error.message)) throw error;}
  if(!opened) {
    await closeEditor(tabId);
    tg.verify={status:'error',note:'could not reopen the store after refreshing'};
    return;
  }
  await guard(tabId);
  const got={};
  await clickTabNamed(tabId,'About');
  got.name=await readNameDisplayed(tabId);
  if(got.name===null) got.name=await readField(tabId,'name');
  if(!await click(tabId,'location',10000)) throw new Error(STORE+': Location tab not found while confirming the changes.');
  await click(tabId,'edit',5000); // opens the address fields for reading only - Save is never pressed
  for(const key of ['address','address2','address3','locality','admin','postal']) {
    const e=expectedValues(row).find(x=>x.key===key);
    if(!e) continue;
    if(e.want) got[key]=await findFieldValue(tabId,key);
    else if(e.empty) got[key]=await readField(tabId,key);
  }
  let bad=0,checked=0;
  for(const e of expectedValues(row)) {
    if(!e.want && !e.empty) continue; // blank in the sheet: nothing was changed, nothing to confirm
    const cur=got[e.key];
    if(e.empty) {
      if(cur===null || cur===undefined) continue; // line not on screen: nothing to confirm
      checked++;const ok=!String(cur).trim();tg.verify[e.key]={ok,got:cur};if(!ok) bad++;continue;
    }
    checked++;
    if(cur===null || cur===undefined) {tg.verify[e.key]={ok:false,got:null};bad++;continue;}
    const ok=ProfileMatch.same(e.want,cur,e.opts) || (e.key==='admin' && ProfileMatch.compare(e.want,cur,{state:true})==='match');
    tg.verify[e.key]={ok,got:cur};if(!ok) bad++;
  }
  tg.verify.status=!checked?'none':bad?'mismatch':'ok';
  tg.verify.at=new Date().toISOString();
  await closeEditor(tabId);
  await chrome.storage.session.remove('matched');
  await wait(1000);
}
function refreshedChecks(row) {
  const targets=(row.targets||[]).filter(t=>!t.skip);
  const checks={};
  for(const key of ['name','address','locality','admin','postal']) {
    const keys=key==='address'?['address','address2','address3']:[key];
    const expected=expectedValues(row).filter(e=>keys.includes(e.key) && (e.want || e.empty));
    if(!expected.length) {checks[key]=key==='address' && addressPlan(row).tooLong?'mismatch':'blank';continue;}
    const results=targets.map(t=>{
      if(!t.verify || t.verify.status==='error') return 'not_found';
      const vals=expected.map(e=>t.verify[e.key]);
      if(vals.some(v=>v && v.got!=null && !v.ok)) return 'mismatch';
      if(vals.some((v,i)=>!v && !expected[i].empty || v && v.got==null)) return 'not_found';
      return 'match';
    });
    checks[key]=results.includes('mismatch')?'mismatch':!results.length || results.includes('not_found')?'not_found':'match';
  }
  return checks;
}

// ---- A store that fails must not stop the batch: note the error on its row, get back to the list, carry on ----
const FATAL_RX=/attached to another tab|debugger|target closed|no tab with id|cannot attach|Four stores in a row|queue is empty/i;
async function recordRowError(rows,index,error,ctx) {
  const r=rows[index];
  (r.targets||[]).forEach(x=>Object.keys(x.detail||{}).forEach(k=>{if(x.detail[k]==='pending'){x.detail[k]=r.detailsReview?'review':'failed';(x.notes=x.notes||{})[k]=(r.detailsReview?'Save not confirmed: ':'Not completed: ')+error.message;}}));
  if(ctx.coordRow) {
    const status=r.status;
    await setRow(rows,index,['saving','submitted_review','submitted'].includes(status)?status:'error',{error:error.message});
  } else await patchRow(rows,index,{detailError:error.message});
}
async function recoverToList(tabId) { // back to the business list with no editor open
  await chrome.storage.session.remove(['matched','positioned']);
  try {await closeEditor(tabId);return;} catch {}
  await reloadBusinessPage(tabId); // last resort: reload (a "leave site?" prompt is accepted)
}

async function runBatch(tabId,opts={coords:true,details:false}) {
  if(running) throw new Error('Batch already running.');
  running=true;cancelRequested=false;pauseRequested=false;activeMode=opts.mode||'coords_check';
  await beginControl(tabId,activeMode);
  await chrome.storage.session.set({batchRunning:true,mode:opts.coords?(opts.details?'coords+details':'coords'):'details',phase:'update'});
  const ka=keepAlive();
  let rows,index=-1;const ctx={calibration:null,fresh:false,openFails:0,coordRow:false,errors:0,streak:0};
  try {
    rows=await ledger();
    if(!rows.length) throw new Error('The queue is empty. Import your sheet first.');
    if(rows.some(r=>r.detailsReview || ['saving','submitted_review','processing'].includes(r.status)))
      throw new Error('A previous row needs review. Use the recovery control in the dashboard before resuming.');
    await ensureForeground(tabId);await attach(tabId);await wait(800);
    for(index=opts.startIndex||0;index<rows.length;index++) {
      const row=rows[index];
      const needs=RunPolicy.needs(row,opts);
      const needCoords=needs.coords, needDetails=needs.details;
      if(!needCoords && !needDetails) continue;
      if(cancelRequested || pauseRequested) break;
      try {
        STORE=row.store;IDX=0;await checkpoint('update',index,row.store);GEO={latitude:row.latitude,longitude:row.longitude,accuracy:1};ctx.coordRow=needCoords;
        await ensureForeground(tabId);
        if(needCoords) await setRow(rows,index,'processing',{error:''});
        await patchRow(rows,index,{detailError:'',lastRunMode:opts.mode,coordinateError:opts.coords?RunPolicy.coordinateError(row):(row.coordinateError||'')});
        await tell(`${index+1}/${rows.length} — ${STORE}: searching…`);
        const exp=await searchStore(tabId);
        buildTargets(row,exp);
        await patchRow(rows,index,{});
        if(exp.count===0) {
          row.targets=[];row.sharedCount=0;
          await setRow(rows,index,'skipped',{error:'',skipReason:'Store code not found in Business Manager'});
          continue;
        }
        ctx.fresh=true;
        for(let t=index===(opts.startIndex||0)?(opts.startTarget||0):0;t<exp.count;t++) {
          if(cancelRequested) break;
          await checkpoint('update',index,row.store,t);
          const tg=row.targets[t];
          const why=classifyListing(exp.summaries[t]);
          if(why) {tg.skip=why;continue;}
          const outcome=await processTarget(tabId,rows,index,t,exp,{coords:needCoords,details:needDetails},ctx);
          if(outcome==='unopened') {
            if(++ctx.openFails>=4) throw new Error('Four stores in a row would not open. The page layout may have changed - check Business Manager, then resume.');
          } else ctx.openFails=0;
          await patchRow(rows,index,{});
        }
        if(cancelRequested) {
          if(needCoords && rows[index].status==='processing') await setRow(rows,index,'queued',{error:''});
          break;
        }
        IDX=0;
        const active=row.targets.filter(x=>!x.skip);
        const skips=[...new Set(row.targets.filter(x=>x.skip).map(x=>x.skip))];
        const unopened=row.targets.filter(x=>x.skip).length===row.targets.length;
        if(unopened) {
          await setRow(rows,index,'skipped',{error:'',skipReason:skips.join('; ')});
        } else {
          if(needDetails) await patchRow(rows,index,{detailsDone:row.targets.filter(x=>!x.skip).every(x=>x.detailsDone),detailsAt:new Date().toISOString()});
          const note=skips.length?`${row.targets.filter(x=>x.skip).length} of ${exp.count} businesses skipped: ${skips.join('; ')}`:(exp.count>1?`Store ID shared by ${exp.count} businesses - all processed.`:'');
          if(needCoords) await setRow(rows,index,'submitted',{error:'',note});
          else await patchRow(rows,index,{note});
        }
        ctx.streak=0;
      } catch(error) {
        if(cancelRequested || FATAL_RX.test(error.message||'')) throw error;
        ctx.errors++;ctx.streak++;
        await recordRowError(rows,index,error,ctx);
        if(ctx.streak>=5) throw new Error('5 stores in a row failed - stopping so you can look. Last error: '+error.message);
        await tell(`${STORE}: skipped after an error (${error.message}). Going on with the next store…`);
        try {await recoverToList(tabId);} catch(e) {throw new Error('Could not get back to the business list after an error on '+STORE+' ('+e.message+'). Open the list, then press Start again.');}
      }
    }
    if(opts.details && !pauseRequested && !cancelRequested) {
      index=rows.length; // Read failures must not alter any row's submission state.
      await checkRows(tabId,rows);
    }
    if(!pauseRequested && !cancelRequested) await chrome.storage.local.set({runCheckpoint:{complete:true}});
    await tell(pauseRequested||cancelRequested?'Batch paused. Close any unsaved editor before resuming.':(ctx.errors?ctx.errors+' store(s) hit an error and were skipped (see Notes) - press Start again to retry only those. ':(opts.details?'Update pass and read-only check pass finished. ':'Coordinate update finished. Address checks were recorded during the first visit; no second pass. '))+'Open the dashboard for the per-store log, then press "Download Excel (.xlsx)". Google may still review edits.');
  } catch(error) {
    if(rows && index>=0 && index<rows.length) await recordRowError(rows,index,error,ctx);
    await tell('Paused: '+error.message);
  } finally {clearInterval(ka);await detach();running=false;await finishControl();await chrome.storage.session.set({batchRunning:false,finishedAt:Date.now()});}
}

// Pass 2: read profile fields only. Never call processTarget/detailStep/Save/map controls.
async function checkRows(tabId,rows,startIndex=0,startTarget=0) {
  await chrome.storage.session.set({mode:'check',phase:'check'});
  await tell('All update attempts finished. Refreshing once, then checking every ATM (read-only)…');
  await reloadBusinessPage(tabId);
  let failures=0;
  for(let index=startIndex;index<rows.length;index++) {
    const row=rows[index];
    if(!row.store || row.status==='invalid' || row.sheetSkip) continue;
    if(cancelRequested || pauseRequested) break;
    STORE=row.store;IDX=0;await checkpoint('check',index,row.store);
    await tell(`Read-only check ${index+1}/${rows.length} — ${STORE}: name, address, city, state and PIN…`);
    try {
      await ensureForeground(tabId);
      const identity=await searchStore(tabId);
      if(!identity.count) {
        await patchRow(rows,index,{checks:{name:'not_found',address:'not_found',locality:'not_found',admin:'not_found',postal:'not_found'},
          checkedAt:new Date().toISOString(),checkError:'Store code not found during final check.'});
        continue;
      }
      // Preserve every saved target even if Google temporarily omits or reorders a listing.
      const previous=new Map((row.targets||[]).map(t=>[t.link,t]));
      const indices=[];
      if(!row.targets) row.targets=[];
      for(let t=0;t<identity.count;t++) {
        const link=identity.links[t];
        let target=previous.get(link);
        if(!target) {target={link,n:row.targets.length+1,detail:{},was:{},notes:{}};row.targets.push(target);}
        target.shows=oneLine(identity.summaries[t]);
        target.skip=classifyListing(identity.summaries[t]);
        target.verify=undefined;
        indices.push(row.targets.indexOf(target));
      }
      for(const target of row.targets) if(!identity.links.includes(target.link)) {
        target.verify={status:'error',note:'Saved business is not present in the current search results'};
      }
      row.sharedCount=Math.max(row.sharedCount||0,identity.count);
      for(let t=index===startIndex?startTarget:0;t<identity.count;t++) {
        await checkpoint('check',index,row.store,t);
        if(cancelRequested) break;
        const ri=indices[t], target=row.targets[ri];
        if(target.skip) continue;
        // verifyTarget's target index and UI result index can differ after reordering.
        await verifyTarget(tabId,row,ri,identity,t===0,t);
        await patchRow(rows,index,{});
      }
      const checks=refreshedChecks(row);
      await patchRow(rows,index,{checks,checkedAt:new Date().toISOString(),checkError:'',
        checkSummary:Object.values(checks).includes('mismatch')?'Not reflected / mismatch — saved changes will NOT be submitted again':
          Object.values(checks).includes('not_found')?'Could not read all fields — no changes made':'Check complete — no changes made'});
      failures=0;
    } catch(error) {
      if(cancelRequested || FATAL_RX.test(error.message||'')) throw error;
      await patchRow(rows,index,{checks:{name:'not_found',address:'not_found',locality:'not_found',admin:'not_found',postal:'not_found'},
        checkError:error.message,checkedAt:new Date().toISOString(),checkSummary:'Check failed — saved changes will NOT be submitted again'});
      if(++failures>=3) throw new Error('Three read-only checks failed. Saved updates are retained. Use Re-check all ATMs after fixing the page.');
      await recoverToList(tabId);
    }
  }
}

async function runChecks(tabId,startIndex=0,startTarget=0) {
  if(running) throw new Error('Batch already running.');
  running=true;cancelRequested=false;pauseRequested=false;activeMode='check';
  await beginControl(tabId,'check');
  await chrome.storage.session.set({batchRunning:true,mode:'check'});
  const ka=keepAlive();
  try {
    const rows=await ledger();
    if(!rows.length) throw new Error('The queue is empty. Import your sheet first.');
    await ensureForeground(tabId);await attach(tabId);await wait(800);
    await checkRows(tabId,rows,startIndex,startTarget);
    if(!pauseRequested && !cancelRequested) await chrome.storage.local.set({runCheckpoint:{complete:true}});
    await tell(pauseRequested||cancelRequested?'Read-only checks paused. Use Re-check all ATMs to repeat checks without saving.':'Read-only checks finished. No changes saved. Download the Excel result.');
  } catch(error) {await tell('Read-only checks paused: '+error.message);}
  finally {clearInterval(ka);await detach();running=false;await finishControl();await chrome.storage.session.set({batchRunning:false,finishedAt:Date.now()});}
}

async function findBusinessTab() {
  const tabs=await chrome.tabs.query({url:'https://business.google.com/*'});
  if(!tabs.length) throw new Error('Open business.google.com (your signed-in business list) in this Chrome window first.');
  tabs.sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0));
  const tab=tabs[0];
  await chrome.tabs.update(tab.id,{active:true});
  await chrome.windows.update(tab.windowId,{focused:true});
  await wait(800);
  return tab.id;
}
const DASH=chrome.runtime.getURL('dashboard.html');
chrome.action.onClicked.addListener(async()=>{
  const [existing]=await chrome.tabs.query({url:DASH});
  if(existing) {await chrome.tabs.update(existing.id,{active:true});await chrome.windows.update(existing.windowId,{focused:true});}
  else await chrome.tabs.create({url:DASH});
});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  const dashboard=String(sender.url||'').startsWith(DASH);
  const page=!!sender.tab && /^https:\/\/business\.google\.com\//.test(sender.url||'');
  if(sender.id!==chrome.runtime.id || (!dashboard && !page)) return false;
  if(page && !['pageState','stop','resume'].includes(message.action)) return false;
  (async()=>{
    if(message.action==='pageState') {
      const cp=(await chrome.storage.local.get('runCheckpoint')).runCheckpoint;
      return {running,suspended,store:STORE||cp?.store||'',canResume:!!cp && !cp.complete,ownTab:activeRunTab===null || sender.tab?.id===activeRunTab};
    }
    if(page && activeRunTab!==null && sender.tab.id!==activeRunTab) throw new Error('Controls belong to the tab running this batch.');
    if(message.action==='resume' && running) {
      if(dashboard && activeRunTab!==null) {await chrome.tabs.update(activeRunTab,{active:true});await chrome.windows.update(activeRunWindow,{focused:true});}
      await resumeRun();return {resumed:true};
    }
    const idle=()=>{if(running) throw new Error('Pause/stop and wait for the run to finish first.');};
    if(message.action==='start' || message.action==='resume') {
      if(running) throw new Error('Batch already running.');
      const tabId=await findBusinessTab();
      const cp=(await chrome.storage.local.get('runCheckpoint')).runCheckpoint;
      const mode=message.action==='resume'?cp?.mode:message.mode;
      if(!mode) throw new Error('Load a sheet and choose a mode in the dashboard first.');
      const continuing=cp && !cp.complete && cp.mode===mode;
      const startIndex=continuing?cp.index:0;
      if(continuing) {
        const rows=await ledger(),row=rows[startIndex];
        if(!row || row.store!==cp.store) throw new Error('Queue changed. Start a new run from the dashboard.');
        if(row.detailsReview || ['saving','submitted_review'].includes(row.status)) throw new Error('Save was interrupted. Review this business using I reviewed it in the dashboard before resuming.');
        if(row.status==='processing') await setRow(rows,startIndex,'queued',{error:''});
        await chrome.tabs.reload(tabId);await delay(1500); // discard unsaved editor state after a worker restart
      }
      void (mode==='check' || (continuing && cp.phase==='check')?runChecks(tabId,startIndex,continuing?cp.target||0:0):runBatch(tabId,{...RunPolicy.options(mode),startIndex,startTarget:continuing?cp.target||0:0})).catch(e=>tell(e.message));
      return {started:true};
    }
    if(message.action==='import') {await importRows(message.rows);await tell('Imported '+message.rows.length+' rows from your sheet.');}
    else if(message.action==='pause') {pauseRequested=true;await tell('Pause requested. Finishing the current row first.');}
    else if(message.action==='stop') {
      await suspendRun('Stopped by you');
    } else if(message.action==='recover') {
      idle();
      const rows=await ledger(),i=rows.findIndex(r=>r.store===message.store);
      if(i<0 || (!rows[i].detailsReview && !['saving','submitted_review','processing','error'].includes(rows[i].status))) throw new Error('This row does not need recovery.');
      // Post-save ambiguity can only be marked reviewed/skipped, never automatically resubmitted.
      if(rows[i].detailsReview) {
        await patchRow(rows,i,{detailsReview:false,detailsDone:false,detailError:'Manually reviewed; address will be compared again before editing.'});
        return {rows};
      }
      const ambiguous=['saving','submitted_review'].includes(rows[i].status);
      await setRow(rows,i,ambiguous?'reviewed_skip':'queued',{error:'Manually reviewed and editor closed by user.'});
      await tell('Row reviewed. Resume continues the remaining queue.');
    } else if(message.action==='markDone') {
      idle();
      const rows=await ledger(),i=rows.findIndex(r=>r.store===message.store);
      if(i<0 || rows[i].status==='invalid' || rows[i].sheetSkip) throw new Error('This row cannot be marked done.');
      await setRow(rows,i,'done_manual',{error:'',note:'Marked done by you.'});
    } else if(message.action==='requeue') {
      idle();
      const rows=await ledger(),i=rows.findIndex(r=>r.store===message.store);
      if(i<0 || rows[i].status==='invalid' || rows[i].sheetSkip) throw new Error('This row cannot be queued (invalid data or a duplicate row in the sheet).');
      const {history={}}=await chrome.storage.local.get('history');delete history[rows[i].store];
      await chrome.storage.local.set({history});
      delete rows[i].targets;delete rows[i].detailsDone;await setRow(rows,i,'queued',{error:'',skipReason:'',note:'Queued again by you.'});
    } else if(message.action==='clearChecks') {
      idle();
      const rows=await ledger();rows.forEach(r=>{delete r.checks;delete r.observed;delete r.checkedAt;delete r.checkError;delete r.checkSummary;(r.targets||[]).forEach(t=>{delete t.verify;});});
      await chrome.storage.local.set({batchRows:rows});
    } else if(message.action==='clear') {
      idle();
      await chrome.storage.local.remove(['batchRows','history','runCheckpoint']);
      await tell('Queue and history cleared.');
    }
    return {rows:await ledger(),running,status:(await chrome.storage.session.get('status')).status};
  })().then(respond).catch(e=>respond({error:e.message}));
  return true;
});
chrome.debugger.onDetach.addListener(async source=>{
  const {attached}=await chrome.storage.session.get('attached');
  if(attached===source.tabId) {cancelRequested=true;suspended=false;resumeWaiters.splice(0).forEach(resolve=>resolve());await chrome.storage.session.remove(['attached','positioned']);}
});

chrome.tabs.onActivated?.addListener(info=>{
  if(running && activeRunTab!==null && info.windowId===activeRunWindow && info.tabId!==activeRunTab)
    void suspendRun('Paused because you changed tabs');
});
chrome.windows.onFocusChanged?.addListener(windowId=>{
  if(running && activeRunWindow!==null && windowId!==activeRunWindow)
    void suspendRun('Paused because the business window lost focus');
});
