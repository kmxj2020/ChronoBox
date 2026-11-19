import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.argv[2];
const OUT = process.argv[3];
const PORT = 9475;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(ROOT,'node_modules','electron','dist','electron.exe'), ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio:'ignore', env });
class CDP { constructor(u){this.u=u;this.i=0;this.p=new Map();} async c(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j;});this.ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};} async s(method,params={}){const id=++this.i;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('to '+method));}},20000);});} async e(x){const r=await this.s('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});return r;} }
async function main(){
  let pages=[]; const t0=Date.now();
  while(Date.now()-t0<40000){ try{ const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); pages=l.filter(p=>p.type==='page'&&p.webSocketDebuggerUrl); if(pages.some(p=>p.url.includes('index.html'))) break; }catch{} await sleep(400); }
  const main = pages.find(p=>p.url.includes('index.html'));
  if(!main){ console.log('no main'); child.kill(); process.exit(1); }
  const c=new CDP(main.webSocketDebuggerUrl); await c.c(); await c.s('Page.enable');
  await sleep(2500);
  const target = main.url.replace(/index\.html.*$/, '_preview-orbit.html');
  await c.e("location.href='" + target + "'");
  await sleep(2200);
  const shot = await c.s('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(OUT,'orb-preview.png'), Buffer.from(shot.data,'base64'));
  console.log('saved orb-preview.png');
  child.kill(); await sleep(500); process.exit(0);
}
main().catch(e=>{console.error('ERR',e.message);try{child.kill()}catch{}process.exit(1);});
