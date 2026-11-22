import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {constants} from 'node:fs';
import {EXTENSION_ID} from '../lib/extension-id.js';
import {MAX_FRAME,lines,writeLine} from '../lib/extension-wire.js';

const [record,mode,...rest]=process.argv.slice(2);
const launcher=mode==='--tasks';
const origin=launcher?rest[0]:mode;
if(origin!=='chrome-extension://'+EXTENSION_ID+'/' || !path.isAbsolute(record||''))process.exit(2);

function frame(value){
  const data=Buffer.from(JSON.stringify(value));
  if(data.length>MAX_FRAME)throw Error('frame too large');
  const prefix=Buffer.alloc(4);prefix.writeUInt32LE(data.length);
  process.stdout.write(Buffer.concat([prefix,data]));
}
async function endpoint(){
  const handle=await fs.open(record,constants.O_RDONLY|constants.O_NOFOLLOW);
  let config;
  try {
    const st=await handle.stat();
    if(!st.isFile()||st.uid!==process.getuid()||(st.mode&0o077)||st.size>2048)throw Error('invalid record');
    config=JSON.parse(await handle.readFile('utf8'));
  } finally {await handle.close()}
  const dir=path.dirname(config.socket);
  if(!/^\/tmp\/dsh-browser-[A-Za-z0-9]{6}$/.test(dir)||path.basename(config.socket)!=='bridge.sock'||!/^[a-f0-9]{64}$/.test(config.key))throw Error('invalid endpoint');
  const st=await fs.lstat(dir);
  if(!st.isDirectory()||st.uid!==process.getuid()||(st.mode&0o077))throw Error('invalid owner');
  return config;
}
let peer,closed=false,paired=false,timer,backoff=300,buffer=Buffer.alloc(0);
let reconnectDeadline=Date.now()+4800;
function finish(){
  if(closed)return;
  closed=true;clearTimeout(timer);peer?.destroy();process.stdin.destroy();process.stdout.end();
}
function lost(){
  if(closed)return;
  if(!launcher && paired){
    // Same Chrome port, same tab. Clear outstanding work before reconnecting.
    frame({type:'clear'});paired=false;reconnectDeadline=Date.now()+4800;
  }
  if(!launcher && Date.now()>=reconnectDeadline){
    frame({type:'unavailable',error:'请打开 DSH 并启用电脑控制插件。'});
    finish();return;
  }
  if(launcher)frame({type:'waiting'});
  timer=setTimeout(dial,launcher?backoff:Math.min(backoff,Math.max(0,reconnectDeadline-Date.now())));backoff=Math.min(backoff*2,5000);
}
async function dial(){
  try {
    const config=await endpoint();
    if(closed)return;
    const next=net.createConnection(config.socket);peer=next;
    next.on('connect',()=>{
      backoff=300;
      writeLine(next,{type:'hello',key:config.key,browserParent:process.ppid,channel:launcher?'tasks':'page'});
    });
    next.on('data',lines(message=>{
      if(message.type==='paired')paired=true;
      frame(message);
      if(!launcher && message.type==='released')finish();
    },()=>next.destroy()));
    next.on('error',()=>{});
    next.on('close',()=>{if(peer===next){peer=null;lost()}});
  } catch {
    if(closed)return;
    lost();
  }
}
process.stdin.on('data',chunk=>{
  try {
    buffer=Buffer.concat([buffer,chunk]);
    while(buffer.length>=4){
      const n=buffer.readUInt32LE(0);if(n>MAX_FRAME)throw Error('invalid frame');
      if(buffer.length<4+n)break;
      const msg=JSON.parse(buffer.subarray(4,4+n));buffer=buffer.subarray(4+n);
      if(msg?.type==='reply'&&peer&&!peer.destroyed)writeLine(peer,msg);
    }
  } catch {finish()}
});
process.stdin.on('end',finish);process.stdin.on('error',finish);process.stdout.on('error',finish);
void dial();
