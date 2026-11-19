// tools/shot.mjs — CDP screenshot harness for ChronoBox
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || process.cwd();
const OUT = process.argv[3] || path.join(ROOT, 'shots');
const PORT = Number(process.argv[4] || 9222);
fs.mkdirSync(OUT, { recursive: true });

const electronBin = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // DSH sets this; it would make electron behave as plain node
const child = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  stdio: 'ignore',
  detached: false,
  env,
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function waitForTargets(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const list = await getTargets();
      const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pages.length) return pages;
    } catch {}
    await sleep(400);
  }
  throw new Error('no CDP targets');
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  const pages = await waitForTargets();
  console.log('targets:', pages.map(p => `${p.title} | ${p.url.split('/').pop()}`).join(' ; '));
  const results = [];
  for (const page of pages) {
    const name = page.url.includes('mini') ? 'mini' : (results.length === 0 ? 'main' : 'page' + results.length);
    const cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await sleep(2500);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('saved', file);
    results.push(file);
    cdp.close();
  }
  child.kill();
  await sleep(800);
  process.exit(0);
}

main().catch(e => { console.error('ERR', e.message); try { child.kill(); } catch {} process.exit(1); });
