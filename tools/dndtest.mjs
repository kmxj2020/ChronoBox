import { spawn } from 'node:child_process';
import path from 'node:path';
const ROOT = process.argv[2];
const PORT = 9499;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', '--remote-debugging-port=' + PORT], { cwd: ROOT, stdio: 'ignore', env });

class CDP {
  constructor(u) { this.u = u; this.i = 0; this.p = new Map(); this.errs = []; }
  async c() {
    this.ws = new WebSocket(this.u);
    await new Promise((r, j) => { this.ws.onopen = r; this.ws.onerror = j; });
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.p.has(m.id)) {
        const { res, rej } = this.p.get(m.id);
        this.p.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        this.errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
      }
    };
  }
  async s(method, params) {
    const id = ++this.i;
    return new Promise((res, rej) => {
      this.p.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout ' + method)); } }, 25000);
    });
  }
  async e(expr) {
    const r = await this.s('Runtime.evaluate', { expression: '(async()=>{' + expr + '})()', awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'ERR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result && r.result.value;
  }
}

const STEPS_DROP = [
  "document.querySelector('[data-view=browser]').click();",
  "await new Promise(r=>setTimeout(r,1500));",
  "const ti=[...document.querySelectorAll('.br-tree-item')].find(b=>b.textContent==='新建文件夹');",
  "if(!ti) return 'no-tree-item';",
  "ti.click();",
  "await new Promise(r=>setTimeout(r,1600));",
  "const tile=[...document.querySelectorAll('.br-tile')].find(t=>t.textContent.includes('Markdown'));",
  "if(!tile) return 'no-tile';",
  "const dt=new DataTransfer();",
  "tile.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));",
  "const target=[...document.querySelectorAll('.br-tree-item')].find(b=>b.textContent==='__dnd_test__');",
  "if(!target) return 'no-target:'+[...document.querySelectorAll('.br-tree-item')].map(b=>b.textContent).join('|');",
  "target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));",
  "target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));",
  "await new Promise(r=>setTimeout(r,1800));",
  "const list=await window.chronoboxApi.browserList(window.__pid,'__dnd_test__');",
  "return JSON.stringify(list.entries.map(e=>e.name));"
].join('\n');

const STEPS_CLEAN = [
  "const list=await window.chronoboxApi.browserList(window.__pid,'__dnd_test__');",
  "const f=list.entries.find(e=>!e.isDirectory);",
  "if(f) await window.chronoboxApi.browserMoveInto(window.__pid,'__dnd_test__/'+f.name,'新建文件夹');",
  "const list2=await window.chronoboxApi.browserList(window.__pid,'__dnd_test__');",
  "let removed=false;",
  "if(list2.entries.length===0){ await window.chronoboxApi.browserTrash(window.__pid,'__dnd_test__'); removed=true; }",
  "const rootList=await window.chronoboxApi.browserList(window.__pid,'');",
  "return JSON.stringify({root:rootList.entries.map(e=>e.name), folderRemoved:removed});"
].join('\n');

async function main() {
  let pages = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      pages = l.filter((p) => p.type === 'page' && p.webSocketDebuggerUrl);
      if (pages.some((p) => p.url.includes('index.html'))) break;
    } catch {}
    await sleep(400);
  }
  const main = pages.find((p) => p.url.includes('index.html'));
  const c = new CDP(main.webSocketDebuggerUrl);
  await c.c();
  await c.s('Runtime.enable', {});
  await sleep(3200);

  console.log('0 pid:', await c.e("const cfg=await window.chronoboxApi.getConfig(); window.__pid=cfg.activeProjectId; return window.__pid;"));
  console.log('1 mkdir:', await c.e("await window.chronoboxApi.browserNewFolder(window.__pid,'','__dnd_test__'); return 'ok';"));
  console.log('2 drop:', await c.e(STEPS_DROP));
  console.log('3 cleanup:', await c.e(STEPS_CLEAN));
  console.log('page exceptions:', c.errs.length, c.errs.slice(0, 2));
  child.kill();
  await sleep(500);
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); try { child.kill(); } catch {} process.exit(1); });
