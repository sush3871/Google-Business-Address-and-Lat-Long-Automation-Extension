const assert=require('node:assert/strict');
const {harness}=require('./regression.cjs');
function form(h,controls,options=[]) {
  class Input {
    constructor(label,value='',attrs={}) {this.attrs={'aria-label':label,...attrs};this.tagName='INPUT';this._value=value;this.type='text';this.innerText='';this.readOnly=false;this.disabled=false;}
    get value(){return this._value;} set value(v){this._value=v;}
    getAttribute(k){return this.attrs[k]??null;} getClientRects(){return [{}];}
    querySelector(){return this.child||null;} closest(){return null;} scrollIntoView(){} focus(){} click(){}
    dispatchEvent(e){this.events=(this.events||[]).concat(e.type);return true;}
  }
  h.c.HTMLInputElement=Input;h.c.HTMLTextAreaElement=Input;h.c.Event=class{constructor(type){this.type=type;}};
  h.c.location={hostname:'business.google.com'};h.c.getComputedStyle=()=>({visibility:'visible',display:'block'});
  h.c.document={body:{innerText:''},querySelector(){return null;},querySelectorAll(selector){
    if(selector==='input,textarea,select,[role="combobox"]') return controls;
    if(selector.startsWith('[role="option"],[role="menuitem"]')) return options;
    return [];
  }};
  h.c.CSS={escape:s=>s};
  const exec=async r=>[{frameId:0,result:r.func(...(r.args||[]))}];h.c.readPage=exec;h.c.pageScript=exec;
  return Input;
}
let passed=0;
async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
(async()=>{
await test('nested city combobox wrapper is one editable field',async()=>{
 const h=harness(),controls=[];const Input=form(h,controls);
 const city=new Input('City (required)','Old City',{role:'combobox'}),wrapper=new Input('City');wrapper.tagName='DIV';wrapper.child=city;controls.push(wrapper,city);
 assert.equal(h.c.inspectUI('field:locality').count,1);
 assert.equal((await h.c.setField(1,'locality','Navi Mumbai')).ok,true);assert.equal(city.value,'Navi Mumbai');
});
await test('postal-code autocomplete is recognized without a visible label',async()=>{
 const h=harness(),controls=[];const Input=form(h,controls);const pin=new Input('', '400001',{autocomplete:'postal-code'});controls.push(pin);
 assert.equal((await h.c.setField(1,'postal','400709')).ok,true);assert.equal(pin.value,'400709');
});
await test('state abbreviation selects full state name in a native dropdown',async()=>{
 const h=harness(),controls=[];const Input=form(h,controls);const state=new Input('State','KA');state.tagName='SELECT';
 state.options=[{text:'Karnataka',value:'KA'},{text:'Maharashtra',value:'MH'}];
 Object.defineProperty(state,'selectedOptions',{get(){return state.options.filter(o=>o.value===state.value);}});controls.push(state);
 assert.equal((await h.c.setField(1,'admin','MH')).ok,true);assert.equal(state.value,'MH');
});
await test('custom readonly state dropdown uses normalized option labels',async()=>{
 const h=harness(),controls=[],options=[];const Input=form(h,controls,options);
 const state=new Input('State','Karnataka',{role:'combobox'});state.readOnly=true;controls.push(state);
 const option=new Input('','');option.innerText='Maharashtra';option.click=()=>state._value='Maharashtra';options.push(option);
 assert.equal((await h.c.setField(1,'admin','MH')).ok,true);assert.equal(state.value,'Maharashtra');
});
await test('PIN autofill resetting city is repaired before Save',async()=>{
 const h=harness();const values={address:'Road',address2:'',address3:'',admin:'Maharashtra',postal:'400709',locality:'Wrong city'};
 h.c.readField=async(_,k)=>values[k]??null;
 h.c.setField=async(_,k,v)=>{values[k]=v;return {ok:true};};
 const tg={detail:{locality:'pending'},was:{},notes:{}},pending=['locality'];
 await h.c.settleLocationFields(1,{admin:'MH',postal:'400709',locality:'Navi Mumbai'},tg,pending,{lines:['Road','',''],tooLong:false});
 assert.equal(values.locality,'Navi Mumbai');assert.equal(pending.filter(k=>k==='locality').length,1);
});
await test('address change invalidates completed pin and old history before Save',async()=>{
 const h=harness();h.data.history={A:{status:'submitted',latitude:19,longitude:73}};
 const target={coordDone:true,coordinates:{status:'match'}},rows=[{store:'A',targets:[target]}];
 await h.c.invalidatePin(rows,0,target);assert.equal(h.data.batchRows[0].targets[0].coordDone,false);assert.equal(h.data.history.A,undefined);
});
await test('Chrome geolocation must equal requested Excel position',async()=>{
 const h=harness();h.c.pageScript=async()=>[{result:{ok:true,latitude:19,longitude:73}}];
 await h.c.prepareCoordinates(1,{latitude:19,longitude:73});assert.ok(h.calls.includes('Emulation.setGeolocationOverride'));
 h.c.pageScript=async()=>[{result:{ok:true,latitude:20,longitude:73}}];await assert.rejects(h.c.prepareCoordinates(1,{latitude:19,longitude:73}),/different location/);
 h.c.pageScript=async()=>[{result:{ok:false,reason:'Permission denied'}}];await assert.rejects(h.c.prepareCoordinates(1,{latitude:19,longitude:73}),/Allow Location/);
});
await test('last map action recenters after nudge before Done',async()=>{
 const h=harness(),events=[];h.c.prepareCoordinates=async()=>{};h.c.guard=async()=>{};
 h.c.click=async(_,k)=>{events.push(k);return true;};h.c.candidates=async()=>true;
 h.c.nudge=async()=>{events.push('nudge');};h.c.draftCoordinates=async()=>({status:'match',distance:0});
 await h.c.positionPin(1,{latitude:19,longitude:73},{});
 assert.deepEqual(events,['adjust','locate','nudge','locate','done']);
});
await test('known wrong draft pin never reaches Done or Save',async()=>{
 const h=harness(),events=[];h.c.prepareCoordinates=async()=>{};h.c.guard=async()=>{};
 h.c.click=async(_,k)=>{events.push(k);return true;};h.c.candidates=async()=>true;h.c.nudge=async()=>{};
 h.c.draftCoordinates=async()=>({status:'mismatch',distance:27});
 await assert.rejects(h.c.positionPin(1,{latitude:19,longitude:73},{}),/27.0 m/);assert.ok(!events.includes('done'));assert.ok(!events.includes('save'));
});
await test('missing city does not suppress the coordinate stage',async()=>{
 const h=harness();h.eval(`guard=async()=>{};ensureForeground=async()=>{};openEditorFor=async()=>true;closeEditor=async()=>{};
 readEditorFields=async()=>'';recordChecks=async()=>{};click=async()=>true;candidates=async()=>true;
 nameStep=async(_,row,tg)=>{tg.detail.name='ok';};detailStep=async(_,row,tg,key)=>{tg.detail[key]=key==='locality'?'notfound':'ok';};
 settleLocationFields=async()=>{};addressNeedsPin=async()=>false;globalThis.pinCalled=false;
 positionPin=async()=>{pinCalled=true;throw Error('Reached coordinate stage');};`);
 const rows=[{store:'A',latitude:19,longitude:73,targets:[{detail:{},notes:{},was:{}}]}];
 await assert.rejects(h.c.processTarget(1,rows,0,0,{summaries:['ATM']},{coords:true,details:true},{fresh:true}),/Reached coordinate stage/);
 assert.equal(h.c.pinCalled,true);assert.equal(rows[0].targets[0].detail.locality,'notfound');
});
console.log(`${passed} field and coordinate tests passed.`);
})().catch(e=>{console.error(e);process.exitCode=1;});
