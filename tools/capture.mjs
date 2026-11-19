// tools/capture.mjs — drive the real app over CDP and screenshot every view
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
const OUT = process.argv[3];
const PORT = Number(process.argv[4] || 9400);
const PREFIX = process.argv[5] || '';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env });

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 40000);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description || ''));
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function waitTargets(timeout = 40000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pages.some(p => p.url.includes('index.html'))) return pages;
    } catch {}
    await sleep(400);
  }
  throw new Error('no CDP targets');
}

const steps = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'steps.json'), 'utf8'));

async function main() {
  const pages = await waitTargets();
  const mainPage = pages.find(p => p.url.includes('index.html'));
  const miniPage = pages.find(p => p.url.includes('mini.html'));
  const cdp = new CDP(mainPage.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await sleep(3000);
  const dpr = await cdp.eval('devicePixelRatio');
  console.log('devicePixelRatio =', dpr);

  for (const step of steps) {
    if (step.eval) {
      try { const v = await cdp.eval(step.eval); if (v !== undefined && v !== null) console.log('  eval ->', JSON.stringify(v).slice(0, 300)); }
      catch (e) { console.log('  eval ERR', step.name, e.message.slice(0, 200)); }
    }
    if (step.wait) await sleep(step.wait);
    if (step.shot) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, `${PREFIX}${step.shot}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log('shot', file);
    }
  }
  cdp.close();

  // 重新查询一次目标：悬浮窗通常比主窗口晚创建
  let miniTarget = miniPage;
  if (!miniTarget) {
    try {
      const list2 = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      miniTarget = list2.find(t => t.type === 'page' && t.url.includes('mini.html'));
    } catch {}
  }
  if (miniTarget && steps.some(s => s.shot === 'mini')) {
    const mc = new CDP(miniTarget.webSocketDebuggerUrl);
    await mc.connect(); await mc.send('Page.enable'); await sleep(1500);
    const shot = await mc.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${PREFIX}mini.png`), Buffer.from(shot.data, 'base64'));
    console.log('shot mini.png');
    mc.close();
  }

  child.kill();
  await sleep(600);
  process.exit(0);
}

main().catch(e => { console.error('ERR', e.message); try { child.kill(); } catch {} process.exit(1); });
