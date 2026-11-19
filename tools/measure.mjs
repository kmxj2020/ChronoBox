import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
const ROOT = process.argv[2];
const PORT = 9505;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(ROOT,'node_modules','electron','dist','electron.exe'), ['.', '--remote-debugging-port=' + PORT], { cwd: ROOT, stdio:'ignore', env });
class CDP { constructor(u){this.u=u;this.i=0;this.p=new Map();} async c(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j;});this.ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};} async s(method,params){const id=++this.i;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method,params:params||{}}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('to'));}},20000);});} async e(expr){const r=await this.s('Runtime.evaluate',{expression:'(async()=>{'+expr+'})()',awaitPromise:true,returnByValue:true});if(r.exceptionDetails)return 'ERR: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;} }
async function main(){
  let pages=[];const t0=Date.now();
  while(Date.now()-t0<40000){try{const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();pages=l.filter(p=>p.type==='page'&&p.webSocketDebuggerUrl);if(pages.some(p=>p.url.includes('index.html')))break;}catch{}await sleep(400);}
  const c=new CDP(pages.find(p=>p.url.includes('index.html')).webSocketDebuggerUrl);await c.c();await c.s('Runtime.enable',{});await sleep(3200);
  await c.e("localStorage.setItem('chronobox_matrix_col_mode','7'); document.querySelector('[data-view=matrix]').click(); return 'ok';");
  await sleep(2000);
  console.log(await c.e([
    "const shell=document.querySelector('.matrix-shell');",
    "const wrap=document.querySelector('.matrix-scroll-wrap');",
    "const ths=[...document.querySelectorAll('.matrix-th-ver')];",
    "const wr=wrap.getBoundingClientRect();",
    "const vis=ths.filter(th=>{const r=th.getBoundingClientRect(); return r.left>=wr.left-2 && r.right<=wr.right+2;}).length;",
    "return JSON.stringify({",
    "  sidebar: document.getElementById('leftSidebar').getBoundingClientRect().width,",
    "  inspector: document.getElementById('inspectorPane').getBoundingClientRect().width,",
    "  shellW: shell.clientWidth, wrapW: wrap.clientWidth, scrollW: wrap.scrollWidth,",
    "  thWidths: ths.map(t=>Math.round(t.getBoundingClientRect().width)),",
    "  fullyVisibleCols: vis, totalCols: ths.length,",
    "  colMode: localStorage.getItem('chronobox_matrix_col_mode'),",
    "  fileColW: Math.round(document.querySelector('.matrix-th-file').getBoundingClientRect().width)",
    "});"
  ].join('\n')));
  const shot = await c.s('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(ROOT, '_shots', 'v51', 'Wcols-measured.png'), Buffer.from(shot.data, 'base64'));
  console.log('shot saved');
  child.kill();await sleep(400);process.exit(0);
}
main().catch((e)=>{console.error('ERR',e.message);try{child.kill()}catch{}process.exit(1);});
