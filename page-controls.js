(() => {
  const id='store-batch-controls-v49';
  if(document.getElementById(id)) return;
  const host=document.createElement('div');host.id=id;
  host.style.cssText='position:fixed!important;right:18px!important;bottom:20px!important;z-index:2147483647!important;';
  const shadow=host.attachShadow({mode:'closed'});
  shadow.innerHTML=`<style>:host{all:initial}section{width:260px;padding:14px;background:#102337;color:#fff;border:1px solid #456078;border-radius:12px;box-shadow:0 4px 20px #0005;font:13px/1.45 system-ui}strong{display:block;margin-bottom:6px}p{margin:4px 0 10px;overflow-wrap:anywhere}button{width:100%;padding:10px;border:0;border-radius:7px;color:white;background:#c63030;font:bold 15px system-ui;cursor:pointer}button.start{background:#157342}button:disabled{opacity:.6;cursor:default}</style><section><strong>ATM batch control</strong><p id="state">Checking run…</p><button disabled>Start</button></section>`;
  document.documentElement.append(host);
  const label=shadow.querySelector('#state'),button=shadow.querySelector('button');
  let state={},pending=false;
  async function refresh() {
    try {
      state=await chrome.runtime.sendMessage({action:'pageState'});
      if(!state || state.error) throw Error(state?.error||'Open the extension dashboard.');
      const stopped=!state.running || state.suspended;host.dataset.paused=String(!!state.suspended);
      button.textContent=stopped?'Start':'Stop';button.className=stopped?'start':'';
      button.disabled=pending || !state.ownTab || (!state.running && !state.canResume);
      label.textContent=(state.suspended?'Stopped at ':state.running?'Running: ':state.canResume?'Resume from ':'No active run. Choose a mode in the dashboard. ')+(state.store||'');
    } catch(e) {button.disabled=true;label.textContent=e.message;}
  }
  button.onclick=async()=>{
    pending=true;button.disabled=true;
    try {const r=await chrome.runtime.sendMessage({action:state.running&&!state.suspended?'stop':'resume'});if(r?.error) throw Error(r.error);}
    catch(e){label.textContent=e.message;pending=false;button.disabled=false;return;}
    pending=false;await refresh();
  };
  chrome.storage.onChanged.addListener(refresh);
  refresh();
})();
