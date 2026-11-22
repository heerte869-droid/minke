import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {lines,writeLine} from './extension-wire.js';
import {PolicyError} from './security.js';
const error=(code,message)=>new PolicyError(code,message);
export class ExtensionBridge {
  #server; #socket; #pending=new Map(); #publishPath; #directory; #key; #closed=false; #peers=new Set(); #launchers=new Set();
  #onboarding='not_connected'; #saveState=Promise.resolve();
  serial=0; browserParent=0;
  get connectionState(){
    if(this.connected)return 'shared';
    if(this.#launchers.size>1)return 'multiple';
    if(this.autoReady)return 'ready';
    return this.#onboarding;
  }
  #remember(state){
    if(this.#onboarding===state || !this.profileDir)return this.#saveState;
    this.#onboarding=state;
    const dest=path.join(this.profileDir,'.whale-extension-onboarding');
    const write=async()=>{
      const tmp=dest+'.'+randomUUID();
      try{await fs.writeFile(tmp,state,{flag:'wx',mode:0o600});await fs.rename(tmp,dest)}
      finally{await fs.rm(tmp,{force:true}).catch(()=>{})}
    };
    this.#saveState=this.#saveState.catch(()=>{}).then(write);
    return this.#saveState;
  }
  markPrepared(){return this.#remember(this.connected || this.#launchers.size ? 'offline':'waiting');}
  #rememberPeer(){void this.#remember('offline').catch(()=>{});}
  get profileDir(){return this.#publishPath ? path.dirname(this.#publishPath) : undefined}
  get connected(){return !!this.#socket && !this.#socket.destroyed}
  get autoReady(){return this.#launchers.size===1}
  async start(profileDir) {
    if(this.#server || this.#closed)return;
    const profile=await fs.realpath(profileDir);
    if((await fs.stat(profile)).uid!==process.getuid())throw Error('Profile owner mismatch');
    const saved=path.join(profile,'.whale-extension-onboarding');
    const st=await fs.lstat(saved).catch(e=>{if(e.code!=='ENOENT')throw e});
    if(st?.isFile() && st.size<=16){const value=await fs.readFile(saved,'utf8');if(['waiting','offline'].includes(value))this.#onboarding=value;}
    this.#directory=await fs.mkdtemp('/tmp/dsh-browser-');
    const socket=path.join(this.#directory,'bridge.sock');this.#key=randomBytes(32).toString('hex');
    this.#server=net.createServer(peer=>this.#accept(peer));
    await new Promise((resolve,reject)=>{this.#server.once('error',reject);this.#server.listen(socket,resolve)});
    await fs.chmod(socket,0o600);this.#server.unref();
    this.#publishPath=path.join(profile,'.whale-browser-link.json');
    const tmp=this.#publishPath+'.'+randomUUID();await fs.writeFile(tmp,JSON.stringify({socket,key:this.#key}),{flag:'wx',mode:0o600});await fs.rename(tmp,this.#publishPath);
  }
  #accept(peer){
    if(this.#closed||this.#peers.size>=4){peer.destroy();return}this.#peers.add(peer);
    let authenticated=false;const timer=setTimeout(()=>peer.destroy(),3000);timer.unref();
    peer.on('error',()=>{});peer.on('data',lines(msg=>{
      if(!authenticated){
        if(msg?.type!=='hello'||typeof msg.key!=='string'||!/^[a-f0-9]{64}$/.test(msg.key)||!timingSafeEqual(Buffer.from(msg.key),Buffer.from(this.#key)))return peer.destroy();
        clearTimeout(timer);authenticated=true;this.#rememberPeer();
        if(msg.channel==='tasks'){this.#launchers.add(peer);writeLine(peer,{type:'paired'});return}
        this.disconnect();this.#socket=peer;this.browserParent=Number.isSafeInteger(msg.browserParent)?msg.browserParent:0;this.serial++;writeLine(peer,{type:'paired'});return;
      }
      if(msg?.type!=='reply')return;const p=this.#pending.get(msg.id);if(p?.peer===peer)p.finish(msg.error?new PolicyError('extension_refused',String(msg.error).slice(0,250),{notDispatched:msg.notDispatched===true}):null,msg.result);
    },()=>peer.destroy()));
    peer.on('close',()=>{clearTimeout(timer);this.#peers.delete(peer);this.#launchers.delete(peer);for(const p of this.#pending.values())if(p.peer===peer)p.finish(error('extension_disconnected','Chrome 连接中断'));if(peer===this.#socket)this.disconnect()});
  }
  async request(op,args={},signal){
    if(!this.connected)throw error('extension_disconnected','请在目标网页上点 DSH 扩展并选择共享。');
    return this.#requestTo(this.#socket,op,args,signal);
  }
  async observeBilling(signal){
    if(!this.autoReady)throw error('launcher_unavailable','请打开一个已连接的普通 Chrome 配置。');
    return this.#requestTo([...this.#launchers][0],'observeBilling',{},signal,10000);
  }
  async openExtensionsManager(signal){
    if(!this.autoReady)throw error('launcher_unavailable','需要一个已连接的普通 Chrome 配置。');
    const [launcher]=this.#launchers;
    const result=await this.#requestTo(launcher,'openExtensionsManager',{},signal);
    if(!/^\d+$/.test(result?.tabId??'') || result?.created!==true)throw error('open_unconfirmed','扩展管理页打开状态待核对。');
    return {created:true,tabId:result.tabId,openedInBackground:result.openedInBackground===true,url:'chrome://extensions/'};
  }
  async openTask(site,signal,appearance,taskTitle){
    if(site!=='bilibili')throw error('site_unsupported','当前可自动打开哔哩哔哩。');
    if(!this.autoReady)throw error('launcher_unavailable',this.#launchers.size?'多个 Chrome 配置在线，请在要使用的配置中选择任务页。':'浏览器自动连接未就绪，请确认 Chrome 正在运行并已加载新版扩展。');
    const [launcher]=this.#launchers;
    const result=await this.#requestTo(launcher,'openTask',{site,presentation:'inactive-tab',taskTitle},signal,12000);
    if(!this.connected||!/^\d+$/.test(result?.tabId??''))throw error('task_unconfirmed','未确认新任务页，请先检查共享状态。');
    const meta=await this.request('meta',{appearance},signal);
    if(result.tabId!==meta.tabId||!['https://www.bilibili.com','https://search.bilibili.com'].includes(new URL(meta.url).origin))throw error('task_changed','任务标签已变化。');
    const placement=['player-window','inactive-tab'].includes(result.presentation)?result.presentation:undefined;
    return {tabId:meta.tabId,created:true,requiresObservation:true,...(meta.taskTabsSupported?{inTaskGroup:meta.inTaskGroup===true}:{}),...(placement?{presentation:placement,
      sourceWindowPreserved:result.sourceWindowPreserved===true,sourceTabPreserved:result.sourceTabPreserved===true,
      taskWindowFocused:result.taskWindowFocused===true}:{})};
  }
  async #requestTo(peer,op,args,signal,timeout=7000){
    if(signal?.aborted)throw error('cancelled','Operation cancelled');
    const id=randomUUID(),deadline=Date.now()+timeout;
    return new Promise((resolve,reject)=>{
      const finish=(err,value)=>{if(!this.#pending.delete(id))return;clearTimeout(timer);signal?.removeEventListener('abort',cancel);err?reject(err):resolve(value)};
      // A cancelled metadata/progress read has no input to retract. Forget its
      // reply locally; a wire cancel would also disarm the visible companion.
      const interrupt=()=>{if(!peer.destroyed && op!=='meta' && op!=='verifyPlayback')writeLine(peer,{type:'cancel',id});};
      const cancel=()=>{interrupt();finish(error('cancelled','Cancelled. Do not replay an input.'))};
      const timer=setTimeout(()=>{interrupt();finish(error('extension_timeout','未收到扩展回执，请先观察任务状态。'))},timeout);
      this.#pending.set(id,{finish,peer});signal?.addEventListener('abort',cancel,{once:true});
      try{writeLine(peer,{type:'request',id,deadline,op,args})}catch(e){finish(e)}
    })
  }
  clearIndicators(){for(const peer of this.#launchers)if(!peer.destroyed)writeLine(peer,{type:'clear'});if(this.connected)writeLine(this.#socket,{type:'clear'});}
  disconnect(restart=false){const peer=this.#socket;this.#socket=undefined;this.browserParent=0;if(peer&&!peer.destroyed){if(restart)peer.destroy();else peer.end(JSON.stringify({type:"released"})+"\n")};for(const p of this.#pending.values())if(p.peer===peer)p.finish(error('extension_disconnected','Extension disconnected'))}
  async dispose(){if(this.#closed)return;this.#closed=true;await this.#saveState.catch(()=>{});this.disconnect(true);for(const peer of this.#peers)peer.destroy();this.#server?.close();
    if(this.#publishPath){try{const current=JSON.parse(await fs.readFile(this.#publishPath,'utf8'));if(current.key===this.#key)await fs.unlink(this.#publishPath)}catch{}}
    if(this.#directory)await fs.rm(this.#directory,{recursive:true,force:true});
  }
}
