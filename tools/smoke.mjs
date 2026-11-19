// tools/smoke.mjs — drive the real UI and collect runtime errors
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = process.argv[2];
const PORT = 9430;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(ROOT,'node_modules','electron','dist','electron.exe'), ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio:'ignore', env });

class CDP {
  constructor(u){this.u=u;this.i=0;this.p=new Map();this.events=[];}
  async c(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j;});
    this.ws.onmessage=e=>{const m=JSON.parse(e.data);
      if(m.id&&this.p.has(m.id)){const{res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}
      else if(m.method){this.events.push(m);}};}
  async s(method,params={}){const id=++this.i;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('timeout '+method))}},15000);});}
  async e(x){const r=await this.s('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});return r;}
}

async function main(){
  let pages=[]; const t0=Date.now();
  while(Date.now()-t0<40000){ try{ const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); pages=l.filter(p=>p.type==='page'&&p.webSocketDebuggerUrl); if(pages.some(p=>p.url.includes('index.html'))) break; }catch{} await sleep(400); }
  const main = pages.find(p=>p.url.includes('index.html'));
  if(!main){ console.log('FATAL: no main target'); child.kill(); process.exit(1); }
  const c=new CDP(main.webSocketDebuggerUrl); await c.c();
  await c.s('Runtime.enable'); await c.s('Log.enable');
  await sleep(3500);

  const run = async (label, expr, wait=700) => {
    const r = await c.e(expr);
    if (r && r.exceptionDetails) console.log(`  [THROW] ${label}: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description || ''}`.slice(0,300));
    await sleep(wait);
    return r?.result?.value;
  };

  console.log('--- step: views ---');
  for (const v of ['matrix','browser','graph','timeline','diff','archivebox','settings']) {
    await run('view '+v, `document.querySelector('[data-view="${v}"]').click(); 'ok'`);
  }
  console.log('--- step: settings sections ---');
  for (const s of ['general','themes','shortcuts','bc','automation','storage','bundle','about']) {
    await run('sec '+s, `(document.querySelector('[data-sec="${s}"]')||{click(){}}).click(); 'ok'`, 500);
  }
  console.log('--- step: palette ---');
  await run('palette open', `document.querySelector('#btnGlobalSearch').click(); 'ok'`);
  await run('palette type', `(()=>{const i=document.querySelector('#inpGlobalSearch'); i.value='主题'; i.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';})()`, 900);
  await run('palette arrowdown', `document.querySelector('#inpGlobalSearch').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})); 'ok'`, 300);
  await run('palette esc', `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 'ok'`, 400);

  console.log('--- step: keyboard shortcuts ---');
  await run('ctrl+1', `window.dispatchEvent(new KeyboardEvent('keydown',{key:'1',ctrlKey:true})); 'ok'`);
  await run('ctrl+6', `window.dispatchEvent(new KeyboardEvent('keydown',{key:'6',ctrlKey:true})); 'ok'`);
  await run('? sheet', `window.dispatchEvent(new KeyboardEvent('keydown',{key:'?'})); 'ok'`);
  await run('esc close', `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})); 'ok'`);
  await run('ctrl+backslash', `window.dispatchEvent(new KeyboardEvent('keydown',{key:'\\\\',ctrlKey:true})); 'ok'`, 500);
  await run('ctrl+shift+f', `window.dispatchEvent(new KeyboardEvent('keydown',{key:'F',ctrlKey:true,shiftKey:true})); 'ok'`, 500);
  await run('restore panes', `window.dispatchEvent(new KeyboardEvent('keydown',{key:'F',ctrlKey:true,shiftKey:true})); 'ok'`, 500);

  console.log('--- step: pane resize ---');
  await run('sidebar resize', `(()=>{
     const h=document.getElementById('sidebarResizer');
     const r=h.getBoundingClientRect();
     h.dispatchEvent(new PointerEvent('pointerdown',{clientX:r.left+2,clientY:200,bubbles:true,pointerId:1}));
     window.dispatchEvent(new PointerEvent('pointermove',{clientX:r.left+42,clientY:200,bubbles:true,pointerId:1}));
     window.dispatchEvent(new PointerEvent('pointerup',{clientX:r.left+42,clientY:200,bubbles:true,pointerId:1}));
     return getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim();
   })()`, 600);
  await run('sidebar dblclick reset', `(()=>{const h=document.getElementById('sidebarResizer'); h.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w').trim();})()`, 600);

  console.log('--- step: theme cycle ---');
  for (let i=0;i<7;i++) await run('theme '+i, `document.querySelector('#btnToggleTheme').click(); document.documentElement.getAttribute('data-theme')`, 250);

  console.log('--- step: new matrix interactions ---');
  await run('view matrix', `document.querySelector('[data-view="matrix"]').click(); 'ok'`, 900);
  await run('eye toggle x2', `(()=>{const b=document.querySelector('#btnMatrixToggleHidden'); if(!b) return 'no-btn'; b.click(); return 'ok';})()`, 600);
  await run('eye toggle back', `(()=>{const b=document.querySelector('#btnMatrixToggleHidden'); if(b) b.click(); return 'ok';})()`, 600);
  await run('dblclick cell', `(()=>{const td=document.querySelector('.matrix-row td.matrix-td-cell[data-col-idx]'); if(!td) return 'no-cell'; td.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 'ok';})()`, 900);
  await run('browser enter dir', `(()=>{const v=document.querySelector('[data-view="browser"]'); v.click(); return 'ok';})()`, 900);
  await run('browser tile dblclick', `(()=>{const t=document.querySelector('.br-tile.is-dir'); if(!t) return 'no-tile'; t.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return 'ok';})()`, 1200);
  await run('browser list mode', `(()=>{const b=[...document.querySelectorAll('.br-mode-btn')][1]; if(!b) return 'no-btn'; b.click(); return 'ok';})()`, 1000);
  await run('browser grid back', `(()=>{const b=[...document.querySelectorAll('.br-mode-btn')][0]; if(!b) return 'no-btn'; b.click(); return 'ok';})()`, 900);
  await run('browser ctx menu', `(()=>{const t=document.querySelector('.br-tile'); if(!t) return 'no-tile'; t.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:400,clientY:400})); return 'ok';})()`, 600);
  await run('close menu', `document.body.click(); 'ok'`, 400);
  await run('diff dropdown', `(()=>{document.querySelector('[data-view=\"diff\"]').click(); return 'ok';})()`, 1200);
  await run('open dropdown', `(()=>{const t=document.querySelector('#diffToSelect .cselect'); if(!t) return 'no'; t.click(); return getComputedStyle(document.querySelector('#diffToSelect .cselect-menu')).display;})()`, 700);
  await run('pick option', `(()=>{const o=document.querySelector('#diffToSelect .cselect-opt'); if(!o) return 'no'; o.click(); return 'ok';})()`, 1200);
  console.log('--- step: archive modal guard ---');
  await run('quick archive', `document.querySelector('[data-view="matrix"]').click(); document.querySelector('#btnQuickArchive').click(); 'ok'`, 700);

  // collect errors
  const errors = c.events.filter(e =>
    (e.method === 'Runtime.exceptionThrown') ||
    (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') ||
    (e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
  );
  console.log('\n=== RUNTIME ERRORS: ' + errors.length + ' ===');
  for (const e of errors.slice(0, 20)) {
    if (e.method === 'Runtime.exceptionThrown') console.log('EXC:', (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text || '').slice(0, 300));
    else if (e.method === 'Runtime.consoleAPICalled') console.log('CONSOLE:', e.params.args.map(a=>a.value ?? a.description ?? '').join(' ').slice(0,300));
    else console.log('LOG:', (e.params.entry.text||'').slice(0,300));
  }
  child.kill(); await sleep(600); process.exit(0);
}
main().catch(e=>{console.error('ERR',e.message);try{child.kill()}catch{}process.exit(1);});
