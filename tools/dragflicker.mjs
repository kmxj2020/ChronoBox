import { spawn } from 'node:child_process';
import path from 'node:path';
const ROOT = process.argv[2];
const PORT = 9512;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(ROOT,'node_modules','electron','dist','electron.exe'), ['.', '--remote-debugging-port=' + PORT], { cwd: ROOT, stdio:'ignore', env });
class CDP { constructor(u){this.u=u;this.i=0;this.p=new Map();} async c(){this.ws=new WebSocket(this.u);await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j;});this.ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{res,rej}=this.p.get(m.id);this.p.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};} async s(method,params){const id=++this.i;return new Promise((res,rej)=>{this.p.set(id,{res,rej});this.ws.send(JSON.stringify({id,method,params:params||{}}));setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error('to'));}},20000);});} async e(expr){const r=await this.s('Runtime.evaluate',{expression:'(async()=>{'+expr+'})()',awaitPromise:true,returnByValue:true});if(r.exceptionDetails)return 'ERR: '+(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;} }
async function main(){
  let pages=[];const t0=Date.now();
  while(Date.now()-t0<40000){try{const l=await (await fetch('http://127.0.0.1:'+PORT+'/json/list')).json();pages=l.filter(p=>p.type==='page'&&p.webSocketDebuggerUrl);if(pages.some(p=>p.url.includes('index.html')))break;}catch{}await sleep(400);}
  const c=new CDP(pages.find(p=>p.url.includes('index.html')).webSocketDebuggerUrl);await c.c();await c.s('Runtime.enable',{});await sleep(3200);

  const res = await c.e([
    "document.querySelector('[data-view=browser]').click();",
    "await new Promise(r=>setTimeout(r,1600));",
    "const tile=document.querySelector('.br-tile.is-dir') || document.querySelector('.br-tile');",
    "if(!tile) return 'no-tile';",
    "const dt=new DataTransfer();",
    "dt.setData('application/x-chronobox-rel','test');",
    "const child=tile.querySelector('.br-tile-name');",
    "const out=[];",
    "tile.dispatchEvent(new DragEvent('dragenter',{bubbles:true,dataTransfer:dt}));",
    "out.push('after dragenter: '+tile.classList.contains('is-drop-target'));",
    "for(let i=0;i<12;i++){",
    "  tile.dispatchEvent(new DragEvent('dragleave',{bubbles:true,dataTransfer:dt,relatedTarget:child}));",
    "  tile.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));",
    "}",
    "out.push('after 12 child-boundary landmines: '+tile.classList.contains('is-drop-target'));",
    "tile.dispatchEvent(new DragEvent('dragleave',{bubbles:true,dataTransfer:dt,relatedTarget:null}));",
    "out.push('after real dragleave: '+tile.classList.contains('is-drop-target'));",
    "const style=getComputedStyle(tile);",
    "out.push('borderWidth='+style.borderTopWidth+' borderStyle='+style.borderTopStyle);",
    "return out.join(' | ');"
  ].join('\n'));
  console.log(res);
  child.kill();await sleep(400);process.exit(0);
}
main().catch((e)=>{console.error('ERR',e.message);try{child.kill()}catch{}process.exit(1);});
