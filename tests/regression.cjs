const fs=require('node:fs'), path=require('node:path'), vm=require('node:vm'), assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
function harness() {
  const data={},session={},calls=[];
  const storage=obj=>({async get(keys){if(typeof keys==='string') return {[keys]:obj[keys]};return {...obj};},async set(v){Object.assign(obj,structuredClone(v));},async remove(keys){for(const k of [keys].flat()) delete obj[k];}});
  const noop=()=>{};
  const chrome={tabs:{async get(id){return {id,active:true,windowId:1,url:'https://business.google.com/'};},onActivated:{addListener:noop}},windows:{async get(){return {focused:true};},onFocusChanged:{addListener:noop}},scripting:{async executeScript(){return [];}},storage:{local:storage(data),session:storage(session)},runtime:{getURL:()=> 'chrome-extension://test/dashboard.html',onMessage:{addListener:noop}},action:{onClicked:{addListener:noop}},debugger:{onDetach:{addListener:noop},async sendCommand(_,cmd){calls.push(cmd);}}};
  const c=vm.createContext({console,chrome,CompressionStream,DecompressionStream,Response,TextEncoder,TextDecoder,Blob,Uint8Array,DataView,URL,setTimeout:fn=>{fn();return 0;},clearTimeout,setInterval,clearInterval,structuredClone});
  c.importScripts=(...files)=>files.forEach(f=>vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),c));
  c.importScripts('worker.js','sheetio.js','xlsxout.js');
  return {c,data,session,calls,eval:s=>vm.runInContext(s,c)};
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
module.exports={harness};
if(require.main===module) (async()=>{
await test('both mode permissions are explicit; unknown modes rejected',()=>{
 const {c}=harness();
 assert.deepEqual(JSON.parse(JSON.stringify(c.RunPolicy.options('coords_check'))),{coords:true,details:false,mode:'coords_check'});
 assert.equal(c.RunPolicy.options('coords_address').details,true);
 assert.throws(()=>c.RunPolicy.options('address_only'));
 assert.throws(()=>c.RunPolicy.options('garbage'));
});
await test('sheets without coordinates remain check-only; duplicates stay skipped',async()=>{
 const h=harness();
 const file=new Blob(['Store code,Street address\n001,First Road\n001,Second Road']);file.name='test.csv';
 const loaded=await h.c.SheetIO.load(file);
 const q=h.c.SheetIO.queueFromSheet(loaded.sheets[0]);
 assert.equal(q.rows.length,2);assert.equal(q.rows[0].status,'queued');assert.equal(q.rows[1].sheetSkip,true);
 assert.equal(h.c.RunPolicy.needs(q.rows[0],h.c.RunPolicy.options('coords_address')).details,false);
 assert.equal(h.c.RunPolicy.needs(q.rows[0],h.c.RunPolicy.options('coords_check')).coords,false);
});
await test('mode 1 still corrects addresses after coordinates were completed',()=>{
 const {c}=harness(), row={store:'001',status:'submitted',latitude:19,longitude:73};
 assert.equal(c.RunPolicy.needs(row,c.RunPolicy.options('coords_address')).details,true);
 assert.equal(c.RunPolicy.needs(row,c.RunPolicy.options('coords_address')).coords,false);
 row.detailsReview=true;assert.equal(c.RunPolicy.needs(row,c.RunPolicy.options('coords_address')).details,false);
});
await test('coordinate changes invalidate target completion on reimport',async()=>{
 const h=harness(),r={store:'001',status:'submitted',latitude:19,longitude:73,address:'Road',policyVersion:'4.6',targets:[{link:'a',coordDone:true}],detailsDone:true};
 h.data.batchRows=[r];h.data.history={'001':{latitude:19,longitude:73,status:'submitted'}};
 await h.c.importRows([{...r,targets:undefined,status:'queued',latitude:20}]);
 assert.equal(h.data.batchRows[0].targets[0].coordDone,false);assert.equal(h.data.batchRows[0].status,'queued');
});
await test('Unicode addresses do not compare as empty tokens',()=>{
 const {c}=harness(); assert.equal(c.ProfileMatch.same('पुणे','मुंबई'),false);assert.equal(c.ProfileMatch.same('पुणे','पुणे'),true);
 const p=c.ProfileMatch.splitAddress('Long Road '.repeat(12),'Near Bank','Floor 2');
 assert.ok(p.lines[0].length<=80);assert.ok(p.lines[1].length<=80);assert.ok(p.lines.join(' ').includes('Near Bank'));
});
for(const mode of ['coords_address','coords_check']) await test(mode+' executes only permitted mutations',async()=>{
 const h=harness();
 h.eval(`
 guard=async()=>{};ensureForeground=async()=>{};openEditorFor=async()=>true;
 readEditorFields=async()=>'';recordChecks=async()=>{};closeEditor=async()=>{};nudge=async()=>null;
 prepareCoordinates=async()=>{await debugCommand({tabId:1},'Emulation.setGeolocationOverride',{});};readField=async()=>null;
 globalThis.effects=[];globalThis.adjustOpen=false;
 click=async(_,kind)=>{effects.push(kind);if(kind==='adjust') adjustOpen=true;if(kind==='done') adjustOpen=false;return true;};
 candidates=async(_,kind)=>kind==='done'?adjustOpen:kind==='save';
 detailStep=async(_,row,tg,key,pending)=>{effects.push('write:'+key);tg.detail[key]='pending';pending.push(key);};
 nameStep=async(_,row,tg)=>{effects.push('write:name');tg.detail.name='updated';};
 waitSaved=async()=>({cleared:true,messages:[]});
 globalThis.rows=[{store:'001',status:'queued',latitude:19,longitude:73,address:'Road',targets:[{coordDone:false,detailsDone:false,detail:{},was:{},notes:{}}]}];
 globalThis.exp={summaries:['Business'],cols:[],biz:[]};
 `);
 await h.c.processTarget(1,h.c.rows,0,0,h.c.exp,h.c.RunPolicy.options(mode),{fresh:true});
 const effects=Array.from(h.c.effects);
 assert.equal(effects.some(x=>x.startsWith('write:')),mode!=='coords_check');
 assert.equal(h.calls.includes('Emulation.setGeolocationOverride'),mode!=='address_only');
 assert.equal(effects.includes('adjust'),mode!=='address_only');
 assert.equal(effects.includes('locate'),mode!=='address_only');
 assert.equal(effects.filter(x=>x==='save').length,mode==='coords_address'?2:1);
 if(mode==='coords_address') assert.ok(effects.indexOf('save')<effects.indexOf('adjust'));
 assert.equal(effects.includes('write:name'),mode!=='coords_check');
});
await test('overlong address verification does not crash',async()=>{
 const h=harness();h.eval(`guard=async()=>{};openEditorFor=async()=>true;closeEditor=async()=>{};clickTabNamed=async()=>true;click=async()=>true;readNameDisplayed=async()=>null;readField=async()=>null;findFieldValue=async()=> 'Pune';`);
 const row={address:'a'.repeat(300),locality:'Pune',targets:[{detail:{},detailsDone:false}]};
 await h.c.verifyTarget(1,row,0,{},true);assert.equal(row.targets[0].detailsDone,false);
 assert.equal(h.c.refreshedChecks(row).address,'mismatch');
});
await test('line 3 mismatch and one mismatched shared business prevent OK',()=>{
 const h=harness();const row={address:'Road',address3:'Floor 2',targets:[{verify:{status:'ok',address:{ok:true,got:'Road'},address3:{ok:true,got:'Floor 2'}}},{verify:{status:'mismatch',address:{ok:true,got:'Road'},address3:{ok:false,got:'Floor 3'}}}]};
 assert.equal(h.c.refreshedChecks(row).address,'mismatch');
 row.targets[1].verify={status:'error'};assert.equal(h.c.refreshedChecks(row).address,'not_found');
});
await test('interrupted address Save leaves durable review marker',async()=>{
 const h=harness();h.eval(`guard=async()=>{};ensureForeground=async()=>{};clickSave=async()=>true;waitSaved=async()=>{throw Error('Disconnected after Save');};`);
 const rows=[{store:'001',targets:[]}],tg={detail:{address:'pending'},notes:{}};
 await assert.rejects(h.c.saveDetails(1,tg,['address'],rows,0));assert.equal(h.data.batchRows[0].detailsReview,true);
});
await test('stale displayed values do not requeue a saved address',async()=>{
 const h=harness();h.eval(`guard=async()=>{};openEditorFor=async()=>true;closeEditor=async()=>{};clickTabNamed=async()=>true;click=async()=>true;readNameDisplayed=async()=> 'Old name';readField=async()=> '';findFieldValue=async()=> 'Old address';`);
 const detail=Object.fromEntries(['name','address','address2','address3','locality','admin','postal'].map(k=>[k,'updated']));
 const row={store:'001',status:'queued',latitude:19,longitude:73,address:'New address',name:'New name',targets:[{detailsDone:true,detail}],detailsDone:true};
 await h.c.verifyTarget(1,row,0,{},true);
 assert.equal(row.targets[0].verify.status,'mismatch');assert.equal(row.targets[0].detailsDone,true);
 assert.equal(h.c.RunPolicy.needs(row,h.c.RunPolicy.options('coords_address')).details,false);
 // Upgrade: v4.6 may have left both done flags false despite a successful Save.
 row.detailsDone=false;row.targets[0].detailsDone=false;
 assert.equal(h.c.RunPolicy.needs(row,h.c.RunPolicy.options('coords_address')).details,false);
});
await test('already submitted fields are not retyped during a partial retry',async()=>{
 const h=harness();h.eval(`findFieldValue=async()=>{throw Error('Must not reread and rewrite a submitted field');};setField=async()=>{throw Error('Must not type');};`);
 const tg={detail:{address:'updated'},notes:{}};const pending=[];
 await h.c.detailStep(1,{address:'New Road'},tg,'address',pending);assert.equal(pending.length,0);
});
await test('all updates precede the separate read-only pass',async()=>{
 const h=harness();h.data.batchRows=['A','B','C'].map(store=>({store,status:'queued',address:'Road',latitude:19,longitude:73}));
 h.eval(`ensureForeground=async()=>{};attach=async()=>{};detach=async()=>{};globalThis.events=[];
 searchStore=async()=>({count:1,links:[STORE],summaries:['ATM'],cols:[],biz:[]});
 processTarget=async(_,rows,i)=>{events.push('save:'+rows[i].store);rows[i].targets[0].detailsDone=true;return 'done';};
 checkRows=async(_,rows)=>{for(const row of rows) events.push('check:'+row.store);};`);
 await h.c.runBatch(1,h.c.RunPolicy.options('coords_address'));
 assert.deepEqual(Array.from(h.c.events),['save:A','save:B','save:C','check:A','check:B','check:C']);
});
await test('coordinate-only mode visits each ATM once and stops without rechecking',async()=>{
 const h=harness();h.data.batchRows=['A','B','C'].map(store=>({store,status:'queued',latitude:19,longitude:73}));
 h.eval(`ensureForeground=async()=>{};attach=async()=>{};detach=async()=>{};globalThis.events=[];
 searchStore=async()=>{events.push('visit:'+STORE);return {count:1,links:[STORE],summaries:['ATM'],cols:[],biz:[]};};
 processTarget=async(_,rows,i)=>{events.push('save:'+rows[i].store);rows[i].targets[0].coordDone=true;return 'done';};
 checkRows=async()=>{events.push('FORBIDDEN second pass');};`);
 await h.c.runBatch(1,h.c.RunPolicy.options('coords_check'));
 assert.deepEqual(Array.from(h.c.events),['visit:A','save:A','visit:B','save:B','visit:C','save:C']);
 assert.ok(h.data.batchRows.every(row=>row.status==='submitted'));
 assert.match(h.session.status,/no second pass/);
});
await test('read-only pass revisits checked rows and cannot save or move the map',async()=>{
 const h=harness();h.eval(`ensureForeground=async()=>{};reloadBusinessPage=async()=>{};guard=async()=>{};closeEditor=async()=>{};
 searchStore=async()=>({count:1,links:[STORE],summaries:['ATM'],cols:[],biz:[]});
 openEditorFor=async()=>true;clickTabNamed=async()=>true;
 click=async(_,kind)=>{if(['save','adjust','locate','done'].includes(kind)) throw Error('Forbidden mutation: '+kind);return true;};
 setField=async()=>{throw Error('Forbidden field write');};typeField=async()=>{throw Error('Forbidden field write');};
 readNameDisplayed=async()=> 'Old Name';readField=async()=> '';findFieldValue=async()=> 'Old Address';`);
 const rows=['A','B'].map(store=>({store,status:'submitted',address:'New Address',name:'New Name',checkedAt:'old',detailsDone:true,
 targets:[{link:store,detailsDone:true,coordDone:true,detail:{address:'updated'},was:{},notes:{}}]}));
 await h.c.checkRows(1,rows);
 for(const row of rows){assert.equal(row.checks.address,'mismatch');assert.equal(row.detailsDone,true);assert.equal(row.targets[0].coordDone,true);assert.equal(row.targets[0].detailsDone,true);assert.notEqual(row.checkedAt,'old');}
 assert.equal(h.calls.length,0);
});
await test('Stop blocks browser commands until Start resumes the same run',async()=>{
 const h=harness();h.eval("running=true;STORE='ATM-B';");await h.c.beginControl(1,'coords_check');
 await h.c.suspendRun('Stopped by you');
 let complete=false;const command=h.c.debugCommand({tabId:1},'Input.insertText',{text:'test'}).then(()=>complete=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(complete,false);assert.equal(h.calls.length,0);
 assert.equal(h.session.runSuspended,true);
 await h.c.resumeRun();await command;assert.equal(complete,true);assert.equal(h.calls.length,1);
});
await test('tab switch suspends without throwing a row error or running a command',async()=>{
 const h=harness();h.eval("running=true;STORE='ATM-B';");await h.c.beginControl(1,'coords_check');
 h.c.chrome.tabs.get=async id=>({id,windowId:1,active:false,url:'https://business.google.com/'});
 let complete=false;const command=h.c.debugCommand({tabId:1},'Input.insertText',{text:'test'}).then(()=>complete=true);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(h.session.runSuspended,true);assert.equal(complete,false);
 await assert.rejects(h.c.resumeRun(),/Return to/);
 h.c.chrome.tabs.get=async id=>({id,windowId:1,active:true,url:'https://business.google.com/'});
 await h.c.resumeRun();await command;assert.equal(complete,true);
});
await test('stop in the second ATM resumes that step without revisiting the first ATM',async()=>{
 const h=harness();h.data.batchRows=['A','B','C'].map(store=>({store,status:'queued',latitude:19,longitude:73}));
 let stopped;const reached=new Promise(resolve=>stopped=resolve);h.c.reachedStop=stopped;
 h.eval(`ensureForeground=async()=>{};attach=async()=>{};detach=async()=>{};globalThis.events=[];
 searchStore=async()=>({count:1,links:[STORE],summaries:['ATM'],cols:[],biz:[]});
 processTarget=async(_,rows,i)=>{events.push('begin:'+rows[i].store);if(i===1){await suspendRun();reachedStop();await runGate();}events.push('save:'+rows[i].store);rows[i].targets[0].coordDone=true;return 'done';};`);
 const run=h.c.runBatch(1,h.c.RunPolicy.options('coords_check'));await reached;
 assert.equal(h.data.runCheckpoint.store,'B');assert.equal(h.data.runCheckpoint.index,1);
 assert.deepEqual(Array.from(h.c.events),['begin:A','save:A','begin:B']);
 await h.c.resumeRun();await run;
 assert.deepEqual(Array.from(h.c.events),['begin:A','save:A','begin:B','save:B','begin:C','save:C']);
});
await test('saved row cursor starts at that row even when earlier rows have errors',async()=>{
 const h=harness();h.data.batchRows=['A','B','C'].map(store=>({store,status:'error',latitude:19,longitude:73}));
 h.eval(`ensureForeground=async()=>{};attach=async()=>{};detach=async()=>{};globalThis.events=[];
 searchStore=async()=>({count:1,links:[STORE],summaries:['ATM'],cols:[],biz:[]});
 processTarget=async(_,rows,i)=>{events.push(rows[i].store);rows[i].targets[0].coordDone=true;return 'done';};`);
 await h.c.runBatch(1,{...h.c.RunPolicy.options('coords_check'),startIndex:1});
 assert.deepEqual(Array.from(h.c.events),['B','C']);
});
await test('Excel export includes run mode and third-line mismatch',async()=>{
 const h=harness();
 const result=await h.c.XlsxOut.build({name:'Test',fileName:'input.csv',headerRow:0,map:{store:0,address:1},matrix:[['Store code','Street address'],['001','Road']]},[{store:'001',sheetRow:2,address:'Road',status:'queued',lastRunMode:'coords_address',checks:{address:'mismatch'},targets:[]}]);
 assert.ok(result.blob.size>1000);fs.writeFileSync(path.join(root,'tests','result-test.xlsx'),Buffer.from(await result.blob.arrayBuffer()));
});
await test('background run opens an unfocused window and returns focus to the dashboard',async()=>{
 const h=harness(),log=[];
 h.c.chrome.windows.create=async o=>{log.push(['create',o]);return {id:77,tabs:[{id:9}]};};
 h.c.chrome.windows.update=async(id,o)=>{log.push(['update',id,o]);};
 h.c.chrome.tabs.query=async()=>[{id:1,url:'https://business.google.com/locations',lastAccessed:1}];
 const t=await h.c.findBusinessTab(5);
 assert.equal(t,9);
 const created=log.find(x=>x[0]==='create')[1];
 assert.equal(created.focused,false);assert.equal(created.url,'https://business.google.com/locations');
 assert.deepEqual(JSON.parse(JSON.stringify(log.find(x=>x[0]==='update'))),['update',5,{focused:true}]);
 assert.equal(h.session.runWindow.windowId,77);
 // a second start reuses the same window instead of opening another
 log.length=0;assert.equal(await h.c.findBusinessTab(5),9);assert.equal(log.length,0);
});
await test('focus emulation is enabled on attach so a hidden window keeps working',async()=>{
 const h=harness();let tabId;
 h.c.chrome.debugger.attach=async t=>{tabId=t.tabId;};
 await h.c.attach(4);
 assert.ok(h.calls.includes('Emulation.setFocusEmulationEnabled'));
});
await test('another window gaining focus does not suspend the run',async()=>{
 const h=harness();h.eval("running=true;STORE='ATM-A';");await h.c.beginControl(1,'coords_check');
 let done=false;const p=h.c.debugCommand({tabId:1},'Input.insertText',{text:'x'}).then(()=>done=true);
 await p;assert.equal(done,true);assert.notEqual(h.session.runSuspended,true);
});
await test('background window closes only after a complete run',async()=>{
 const h=harness(),removed=[];
 h.c.chrome.windows.remove=async id=>{removed.push(id);};
 h.session.runWindow={tabId:9,windowId:77};h.data.runCheckpoint={complete:false};
 await h.c.closeRunWindowIfDone();assert.equal(removed.length,0);assert.ok(h.session.runWindow);
 h.data.runCheckpoint={complete:true};
 await h.c.closeRunWindowIfDone();assert.deepEqual(removed,[77]);assert.equal(h.session.runWindow,undefined);
});
await test('old address completion without a name result is eligible for name repair',()=>{
 const h=harness(), detail=Object.fromEntries(['address','address2','address3','locality','admin','postal'].map(k=>[k,'updated']));
 const row={store:'001',latitude:19,longitude:73,status:'submitted',detailsDone:true,targets:[{detailsDone:true,detail}]};
 assert.equal(h.c.RunPolicy.needs(row,h.c.RunPolicy.options('coords_address')).details,true);
 row.targets[0].detail.name='updated';
 assert.equal(h.c.RunPolicy.needs(row,h.c.RunPolicy.options('coords_address')).details,false);
});
await test('name save is durably marked before clicking and clears only after completion',async()=>{
 const h=harness();h.eval(`clickTabNamed=async()=>true;readNameDisplayed=async()=> 'Old Name';readField=async()=> 'Old Name';setField=async()=>({ok:true});guard=async()=>{};ensureForeground=async()=>{};waitSaved=async()=>({cleared:true});`);
 const rows=[{store:'A',targets:[{detail:{},notes:{},was:{}}]}];let saves=0;
 h.c.clickSave=async()=>{saves++;assert.equal(h.data.batchRows[0].detailsReview,true);assert.equal(h.data.batchRows[0].targets[0].detail.name,'review');return true;};
 await h.c.nameStep(1,{name:'New Name'},rows[0].targets[0],rows,0);
 assert.equal(saves,1);assert.equal(h.data.batchRows[0].detailsReview,false);assert.equal(rows[0].targets[0].detail.name,'updated');
 await h.c.nameStep(1,{name:'New Name'},rows[0].targets[0],rows,0);assert.equal(saves,1);
});
await test('interrupted business name save cannot be automatically retried',async()=>{
 const h=harness();h.eval(`clickTabNamed=async()=>true;readNameDisplayed=async()=> 'Old';readField=async()=> 'Old';setField=async()=>({ok:true});guard=async()=>{};ensureForeground=async()=>{};clickSave=async()=>true;waitSaved=async()=>{throw Error('Disconnected');};`);
 const rows=[{store:'A',targets:[{detail:{},notes:{},was:{}}]}];
 await assert.rejects(h.c.nameStep(1,{name:'New'},rows[0].targets[0],rows,0),/Disconnected/);
 assert.equal(h.data.batchRows[0].detailsReview,true);
 assert.equal(h.c.RunPolicy.needs(h.data.batchRows[0],h.c.RunPolicy.options('coords_address')).details,false);
});
await test('coordinate readback waits for stability and computes actual distance',async()=>{
 const h=harness();let calls=0;
 h.c.readPage=async()=>{calls++;return [{result:{count:1,latitude:19,longitude:73}}];};
 const c=await h.c.readSavedCoordinates(1,{latitude:19,longitude:73});
 assert.equal(calls,3);assert.equal(c.status,'match');assert.equal(c.distance,0);
 const other=await h.c.readSavedCoordinates(1,{latitude:20,longitude:73});
 assert.equal(other.status,'mismatch');assert.ok(other.distance>100000);
});
await test('missing or ambiguous coordinate readback never copies requested coordinates',async()=>{
 const h=harness();h.c.readPage=async()=>[];
 const c=await h.c.readSavedCoordinates(1,{latitude:19,longitude:73});
 assert.equal(c.status,'unconfirmed');assert.equal(c.latitude,undefined);
 h.c.readPage=async()=>[1,2].map(()=>({result:{count:1,latitude:19,longitude:73}}));
 assert.equal((await h.c.readSavedCoordinates(1,{latitude:19,longitude:73})).status,'unconfirmed');
 const cols=h.c.XlsxOut.coordinateCells({targets:[{coordinates:c}]});
 assert.equal(cols[0],'');assert.equal(cols[1],'');assert.equal(cols[2],'Unconfirmed');
});
await test('Excel coordinate columns align with the observed values',async()=>{
 const h=harness();const values=h.c.XlsxOut.coordinateCells({targets:[{coordinates:{latitude:19.2,longitude:73.4,distance:8.456,status:'mismatch',note:'Read after refresh'}}]});
 assert.deepEqual(Array.from(values),[19.2,73.4,'MISMATCH',8.46,'Read after refresh']);
 assert.equal(h.c.XlsxOut.HEADERS.slice(-5)[0],'Saved latitude');
});
for(const stage of ['before-save','after-save']) await test('address not found '+stage+' positions Excel pin before submitting address',async()=>{
 const h=harness();h.eval(`
 guard=async()=>{};ensureForeground=async()=>{};openEditorFor=async()=>true;
 readEditorFields=async()=>'';recordChecks=async()=>{};closeEditor=async()=>{};
 prepareLocationSave=async()=>{};nudge=async()=>null;prepareCoordinates=async()=>{};readField=async()=>null;
 globalThis.effects=[];globalThis.adjustOpen=false;
 click=async(_,kind)=>{effects.push(kind);if(kind==='adjust') adjustOpen=true;if(kind==='done') adjustOpen=false;return true;};
 candidates=async(_,kind)=>kind==='done'?adjustOpen:['save','adjust'].includes(kind);
 nameStep=async(_,row,tg)=>{tg.detail.name='ok';};
 detailStep=async(_,row,tg,key,pending)=>{tg.detail[key]='pending';pending.push(key);};
 waitSaved=async()=>({cleared:true,messages:[]});
 globalThis.rows=[{store:'A0103',status:'queued',latitude:29.601803,longitude:79.662211,address:'Plot No. 209, Bakshi Khola, Mall Road',targets:[{detail:{},was:{},notes:{}}]}];
 globalThis.exp={summaries:['ATM'],cols:[],biz:[]};
 `);
 h.c.addressNeedsPin=async()=>stage==='before-save';
 h.c.saveDetails=async()=>{h.c.effects.push('address-attempt');return false;};
 await h.c.processTarget(1,h.c.rows,0,0,h.c.exp,h.c.RunPolicy.options('coords_address'),{fresh:true});
 const effects=Array.from(h.c.effects);
 assert.equal(effects.includes('address-attempt'),stage==='after-save');
 assert.ok(effects.indexOf('locate')<effects.indexOf('save'));
 assert.equal(effects.filter(e=>e==='save').length,1);
 assert.equal(h.c.rows[0].targets[0].detail.address,'updated');
 assert.equal(h.c.rows[0].targets[0].coordDone,true);
 assert.equal(h.c.rows[0].detailsReview,false);
});
await test('address validation after Save retains pending fields for pin correction',async()=>{
 const h=harness();h.eval(`guard=async()=>{};ensureForeground=async()=>{};prepareLocationSave=async()=>{};clickSave=async()=>true;waitSaved=async()=>({cleared:false,needsPin:true});`);
 const tg={detail:{address:'pending'},notes:{}},rows=[{store:'A',targets:[tg]}],pending=['address'];
 assert.equal(await h.c.saveDetails(1,tg,pending,rows,0,true),false);
 assert.equal(pending.length,1);assert.equal(tg.detail.address,'pending');assert.equal(rows[0].detailsReview,false);
});
await test('waitSaved returns pin correction only when explicitly enabled',async()=>{
 const h=harness();h.c.readPage=async()=>[{result:{needsPin:true,saveVisible:true}}];
 const allowed=await h.c.waitSaved(1,true);assert.equal(allowed.needsPin,true);assert.equal(allowed.cleared,false);
 const notAllowed=await h.c.waitSaved(1);assert.equal(notAllowed.cleared,false);assert.equal(notAllowed.needsPin,undefined);
});
console.log(`${passed} regression tests passed.`);
})().catch(e=>{console.error(e);process.exitCode=1});
