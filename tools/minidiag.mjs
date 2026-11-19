import { spawn } from 'node:child_process';
import path from 'node:path';
const ROOT = process.argv[2];
const PORT = 9420;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(ROOT,'node_modules','electron','dist','electron.exe'), ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio:'ignore', env });
class CDP { constructor(u){this.u=u;this.i=0;this.p=new Map();} async c(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j;});this.ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};} async s(method,params={}){const id=++this.i;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method,params}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('to'))}},10000);});} async e(x){const r=await this.s('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});return r.result?.value;} }
async function main(){
  let pages=[]; const t0=Date.now();
  while(Date.now()-t0<30000){ try{ const l=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); pages=l.filter(p=>p.type==='page'&&p.webSocketDebuggerUrl); if(pages.some(p=>p.url.includes('mini.html'))) break; }catch{} await sleep(400); }
  const mini = pages.find(p=>p.url.includes('mini.html'));
  if(!mini){ console.log('no mini target'); child.kill(); process.exit(1); }
  const c=new CDP(mini.webSocketDebuggerUrl); await c.c();
  await sleep(2000);
  const info = await c.e(`(()=>{const orb=document.getElementById('miniDotOrb');const r=orb?orb.getBoundingClientRect():null;const dot=document.getElementById('miniDot');return JSON.stringify({iw:innerWidth,ih:innerHeight,dpr:devicePixelRatio,orb:r?{w:r.width,h:r.height,x:r.x,y:r.y}:null,orbClass:orb?orb.className:null,count:document.getElementById('miniDotCount')?.textContent,dotClass:dot?dot.className:null,bodyCls:document.body.className});})()`);
  console.log('MINI:', info);
  child.kill(); await sleep(500); process.exit(0);
}
main().catch(e=>{console.error('ERR',e.message);try{child.kill()}catch{}process.exit(1);});
