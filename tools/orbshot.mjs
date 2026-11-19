import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.argv[2];
const OUT = process.argv[3];
const PORT = 9470;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(ROOT,'node_modules','electron','dist','electron.exe'), ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio:'ignore', env });
class CDP { constructor(u){this.u=u;this.i=0;this.p=new Map();} async c(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j;});this.ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};} async s(method,params={}){const id=++this.i;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('to '+method));}},15000);});} async e(x){const r=await this.s('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});return r.result?.value;} }
async function main(){
  let pages=[]; const t0=Date.now();
  while(Date.now()-t0<40000){ try{ const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); pages=l.filter(p=>p.type==='page'&&p.webSocketDebuggerUrl); if(pages.some(p=>p.url.includes('mini.html'))) break; }catch{} await sleep(400); }
  const mini = pages.find(p=>p.url.includes('mini.html'));
  if(!mini){ console.log('no mini'); child.kill(); process.exit(1); }
  const c=new CDP(mini.webSocketDebuggerUrl); await c.c();
  await c.s('Page.enable');
  await sleep(2200);
  let shot = await c.s('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(OUT,'orb-normal.png'), Buffer.from(shot.data,'base64'));
  console.log('orb-normal ok');
  // 贴边
  await c.e("window.chronoboxApi.snapMiniToEdge()");
  await sleep(1200);
  shot = await c.s('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(OUT,'orb-docked.png'), Buffer.from(shot.data,'base64'));
  console.log('orb-docked ok');
  child.kill(); await sleep(500); process.exit(0);
}
main().catch(e=>{console.error('ERR',e.message);try{child.kill()}catch{}process.exit(1);});
