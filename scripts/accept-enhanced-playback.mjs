import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright-core';
import {Context} from '@deepseek-ai/cordis';
import ToolsService from '@deepseek-ai/dsh-tools';
import {NativeToolExecutor} from '@deepseek-ai/dsh-tool-executor-native';
import {Coordinator} from '../lib/coordinator.js';
import {ExtensionBridge} from '../lib/extension-bridge.js';
import {registerTools} from '../index.js';
import {registerBrowserHost} from '../scripts/setup-browser.mjs';
import {EXTENSION_ID} from '../lib/extension-id.js';

const archive=process.env.WHALE_FORM_ARTIFACTS;
assert.ok(archive,'Set WHALE_FORM_ARTIFACTS to save the test evidence');
await fs.mkdir(archive,{recursive:true});
const publicSite=process.argv.includes('--public-bilibili');
const bin=process.env.WHALE_TEST_CHROMIUM;
assert.ok(bin,'Set WHALE_TEST_CHROMIUM to a Chrome for Testing binary');
const tmp=await fs.mkdtemp('/tmp/dsh-local-film-proof-');
const profile=path.join(tmp,'profile');
const extension=path.join(tmp,'qa-extension');
await fs.mkdir(extension);
await promisify(execFile)('/usr/bin/unzip',['-q',path.resolve('assets/DSH-Chrome.zip'),'-d',extension]);
const manifest=JSON.parse(await fs.readFile(path.join(extension,'manifest.json'),'utf8'));
assert.equal(manifest.version,JSON.parse(await fs.readFile(path.resolve('browser-extension/manifest.json'))).version,'packaged Chrome version matches source');
assert.ok(manifest.permissions.includes('debugger'));
assert.equal(manifest.externally_connectable,undefined);

const site='https://www.bilibili.com';
const version=JSON.parse(await fs.readFile(path.join(extension,'manifest.json'))).version;
const report={extensionVersion:version,environment:publicSite?'signed-out Chrome for Testing, public Bilibili':'Chrome for Testing, offline, headless',inputs:'DSH playback in a never-selected task tab followed by natural viewing and release'};
const bridge=new ExtensionBridge();
let browser,host,release,fiber;
let remote;

try{
  await fs.mkdir(profile);
  await bridge.start(tmp);
  const nativeCalls=[];
  host=new Coordinator({native:{request:async method=>{nativeCalls.push(method);return method==='session.start'?{paused:false}:{}},pauseNow(){}},extensionBridge:bridge,deniedOrigins:['http://127.0.0.1:59721'],
    getConfig:()=>({enabled:true,sessionAccess:true,overlayMode:'companion',cursorVariant:'large',cursorSize:76})});
  host.bindProfile(tmp);
  assert.equal(host.status().controlState,'standby');
  const ctx=new Context();
  ctx.provide('systemPrompt',{tools:()=>()=>{}});
  fiber=ctx.plugin(ToolsService,{});
  for(let i=0;i<30&&!ctx.get('tools');i++)await new Promise(r=>setImmediate(r));
  release=ctx.tools.setExecutor(new NativeToolExecutor(ctx));
  registerTools(ctx,host);
  const agent={id:'form-qa',session:{id:'form-qa-session'},ctx};
  async function tool(args,name='whale_web'){
    const batch=await ctx.tools.execute({calls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}],agent,signal:new AbortController().signal});
    const result=batch.results[0].result;
    const raw=result.content.find(c=>c.type==='text').text;
    if(result.isError)throw Error(raw);
    const parsed=JSON.parse(raw);
    if(parsed.error)throw Error(JSON.stringify(parsed.error));
    return parsed;
  }

  const missingTimes=[];
  for(let i=0;i<25;i++){
    const start=performance.now();
    const receipt=await tool({query:'鲸鱼 科普'},'whale_watch_video');
    missingTimes.push(performance.now()-start);
    assert.equal(receipt.browserState,'not_connected');assert.ok(receipt.requiresUserAction && receipt.doNotReplay);
  }
  assert.deepEqual(nativeCalls,[]);
  missingTimes.sort((a,b)=>a-b);
  report.firstUse={missingSamples:25,toolCallsPerRequest:1,nativeRequestsBeforeInstall:nativeCalls.length,
    missingP50Ms:missingTimes[12],missingP95Ms:missingTimes[23]};
  await registerBrowserHost({userDataDir:profile,profileDir:tmp});
  await bridge.markPrepared();
  assert.equal(bridge.connectionState,'waiting');
  const flags=['--disable-extensions-except='+extension,'--load-extension='+extension];
  if(!publicSite)flags.push('--host-resolver-rules=MAP www.bilibili.com ~NOTFOUND, MAP search.bilibili.com ~NOTFOUND');
  {
    // Launch Services keeps the user's front application active. Connect only to
    // the debugging port Chrome assigned to this freshly created test profile.
    const app=path.resolve(bin,'../../..');
    await promisify(execFile)('/usr/bin/open',['-g','-n','-a',app,'--args','--user-data-dir='+profile,
      '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--headless=new',
      '--disable-background-networking','--mute-audio','--window-size=1350,920',...flags,'about:blank']);
    let port;
    for(let i=0;i<100&&!port;i++){
      port=await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8').then(s=>Number(s.split('\n')[0]),()=>0);
      if(!port)await delay(100);
    }
    assert.ok(port,'the isolated background test window opened');
    remote=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});
    browser=remote.contexts()[0];
  }
  if(!publicSite){
  const files=new Map();
  files.set('/index.html',{contentType:'text/html',body:'<!doctype html><title>Local film test</title>'});
  if(process.env.WHALE_TEST_VIDEO){
    files.set('/video/BV1Fixture/',{contentType:'text/html',body:'<!doctype html><title>Sintel playback test</title><video muted controls width="800" src="/sample.mp4"></video>'});
    files.set('/sample.mp4',{contentType:'video/mp4',body:await fs.readFile(process.env.WHALE_TEST_VIDEO)});
  }
  await browser.route('**/*',route=>{
    const u=new URL(route.request().url());
    const data=files.get(u.pathname==='/'?'/index.html':u.pathname);
    if(u.origin==='https://search.bilibili.com' && u.pathname==='/all')return route.fulfill({contentType:'text/html;charset=utf-8',body:'<!doctype html><meta charset=utf-8><title>结果</title><a href="https://www.bilibili.com/video/BV1Fixture/">鲸鱼 科普</a>'});
    if(u.origin!==site||!data)return route.abort();
    if(u.pathname==='/sample.mp4'){
      const range=route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
      if(range){
        const start=Number(range[1]),end=Math.min(range[2]?Number(range[2]):data.body.length-1,data.body.length-1);
        if(start>end)return route.fulfill({status:416,headers:{'content-range':'bytes */'+data.body.length}});
        return route.fulfill({status:206,contentType:data.contentType,body:data.body.subarray(start,end+1),
          headers:{'accept-ranges':'bytes','content-range':'bytes '+start+'-'+end+'/'+data.body.length}});
      }
    }
    return route.fulfill(data);
  });
  }
  for(let i=0;i<100&&!bridge.autoReady;i++)await delay(80);
  assert.ok(bridge.autoReady,'extension native messaging is ready');
  const worker=browser.serviceWorkers().find(w=>w.url()==='chrome-extension://'+EXTENSION_ID+'/worker.js');
  assert.ok(worker,'the QA DSH service worker is running');
  assert.equal(await worker.evaluate(()=>chrome.runtime.id),EXTENSION_ID);
  const selected=()=>worker.evaluate(async()=>{const [t]=await chrome.tabs.query({active:true,lastFocusedWindow:true});return [t.windowId,t.id]});
  const source=await selected();
  await worker.evaluate(()=>{globalThis.activationEvents=[];chrome.tabs.onActivated.addListener(e=>globalThis.activationEvents.push(e.tabId))});
  const newPage=browser.waitForEvent('page',{predicate:async p=>{
    try{await p.waitForURL(site+'/**',{timeout:3500,waitUntil:'commit'});return true}catch{return false}
  }});
  let task,page;
  if(publicSite){task=await bridge.openTask('bilibili');page=await newPage;}

const selectedAtStart=await selected();
const isAttached=()=>worker.evaluate(async id=>{try{await chrome.debugger.sendCommand({tabId:id},'Page.getLayoutMetrics');return true}catch{return false}},Number(task.tabId));
const sample=async()=>{
 const r=await tool({operation:'verifyPlayback'});
 return Object.fromEntries(['tabId','from','to','paused','muted','tabMuted','elementMuted','playerId','silenceVerified','tabActive','visibility','verified','extensionVersion','backgroundPresentation'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));
};
const take=async stage=>{const r=await sample();report[stage]=r;console.log(stage,JSON.stringify(r));return r};
const pulse=async predicate=>{for(let i=0;i<35;i++){if(await predicate())return;await delay(150)}throw Error('expected state was not reached')};
assert.deepEqual(selectedAtStart,source);
if(task)assert.equal(await isAttached(),false);
let desired;
if(publicSite){
  const base=(await tool({},'whale_web_state')).snapshot;
  assert.ok(!/安全验证|访问出错|访问受限|验证码|安全风控/.test(base.title+' '+base.text),'Bilibili access check on landing');
  const search=new URL('/all','https://search.bilibili.com');search.searchParams.set('keyword','大熊猫 打喷嚏');
  await tool({operation:'navigate',url:search.href,snapshotId:base.snapshotId});
  for(let i=0;i<30;i++){
    await delay(450);
    const s=(await tool({},'whale_web_state')).snapshot;
    if(/安全验证|访问出错|访问受限|安全风控|密码登录|扫描二维码登录/.test(s.title+' '+s.text))throw Error('Bilibili requires verification or login');
    if(new URL(s.url).hostname!=='search.bilibili.com')continue;
    desired=s.tree.find(x=>x.role==='link' && x.href?.includes('/video/BV1Bz4y1Y7DF') && x.title?.includes('熊猫'));
    if(!desired && i>=5)desired=s.tree.find(x=>x.role==='link' && /\/video\/BV[A-Za-z0-9]+/.test(x.href||'') && x.title?.includes('熊猫') && x.title.includes('喷嚏'));
    if(desired)break;
  }
  assert.ok(desired,'no verified panda video link in these search results');
  report.selectedTitle=desired.title;
  report.play=await tool({query:'大熊猫 打喷嚏',resultId:new URL(desired.href).pathname.match(/\/video\/(BV[A-Za-z0-9]+)/)[1],audioMode:'muted'},'whale_watch_video');
}else{
  const start=performance.now();
  report.play=await tool({query:'鲸鱼 科普',audioMode:'muted'},'whale_watch_video');
  report.firstUse.readyToPlaybackMs=performance.now()-start;
  report.firstUse.autoStartCount=nativeCalls.filter(m=>m==='session.start').length;
  assert.equal(report.firstUse.autoStartCount,1);
  page=await newPage;task=report.play;
}
console.log('watch',JSON.stringify(report.play));
const first=await take('cold');
assert.ok(first.verified && first.tabActive===false && first.visibility==='visible' && first.backgroundPresentation?.active && first.silenceVerified,'cold enhanced playback');
assert.ok(await isAttached());assert.deepEqual(await selected(),source);
const duration=(await tool({},'whale_web_state')).snapshot.videos[0].duration;
const interval=publicSite?Math.min(30000,(duration-first.to-10)*1000):30000;
assert.ok(interval>=5000,'video too short for both independent samples and viewer handoff');
await delay(interval);
const later=await take('sustained');
assert.ok(later.verified && later.from>first.from+interval/1000-2 && later.playerId===first.playerId && later.tabActive===false);
assert.deepEqual(await selected(),source);
assert.ok(!(await worker.evaluate(()=>globalThis.activationEvents.slice())).includes(Number(task.tabId)),'no user tab switch before cold playback proof');
await worker.evaluate(id=>chrome.tabs.update(id,{active:true}),Number(task.tabId));
const viewed=await take('viewed');
assert.ok(viewed.verified && viewed.tabActive && viewed.playerId===first.playerId && viewed.from>=later.to-0.2);
await page.waitForFunction(()=>{const c=document.querySelector('canvas[inert][aria-hidden=true]');return c && c.getBoundingClientRect().width>20 && c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3 && v>220)},{},{timeout:4500});
report.cursorRendered=true;
if(process.env.WHALE_FORM_ARTIFACTS){await fs.mkdir(process.env.WHALE_FORM_ARTIFACTS,{recursive:true});await page.screenshot({path:path.join(process.env.WHALE_FORM_ARTIFACTS,'切入观看.png')})}
await worker.evaluate(id=>chrome.tabs.update(id,{active:true}),source[1]);
assert.deepEqual(await selected(),source);
const ended=()=>page.locator('video').evaluate(v=>v.ended);
if(publicSite){
  host.pause('user');
  await pulse(async()=>!await isAttached());
}else await pulse(async()=>{if(await ended())return true;await delay(450);return false});
await pulse(async()=>!await isAttached());
report.endReleased=true;
if(!publicSite){const final=await tool({},'whale_web_state');
report.final={ended:final.snapshot.videos[0]?.ended,currentTime:final.snapshot.videos[0]?.currentTime};assert.ok(report.final.ended);}
report.releaseReason=publicSite?'explicit-stop':'media-ended';

if(!publicSite){
  const watchAgain=async()=>{
    const result=await tool({query:'鲸鱼 科普',audioMode:'muted'},'whale_watch_video');
    assert.ok(result.verified && await isAttached(),'fixture playback started');
  };
  await watchAgain();
  await page.evaluate(()=>{const panel=document.createElement('dialog');panel.textContent='扫描二维码登录';document.body.append(panel);panel.showModal()});
  await pulse(async()=>!await isAttached());
  report.loginReleased=true;
  const gateState=(await tool({},'whale_web_state')).snapshot;
  const node=gateState.tree.find(v=>v.role==='video');
  const gateResult=await tool({operation:'play',muted:true,snapshotId:gateState.snapshotId,ref:node.ref}).catch(e=>({error:String(e.message)}));
  assert.ok(gateResult.error || gateResult.verified===false);
  assert.equal(await isAttached(),false);report.gatedStartRefused=true;
  await page.evaluate(()=>document.querySelector('dialog').remove());
  await watchAgain();
  await page.goto(site+'/index.html',{waitUntil:'domcontentloaded'});
  await pulse(async()=>!await isAttached());report.navigationReleased=true;
  await watchAgain();
  host.pause('user');
  await pulse(async()=>!await isAttached());report.stopReleased=true;
  const rejected=await worker.evaluate(async tabId=>{
    const [r]=await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',func:async()=>{
      try{return (await chrome.runtime.sendMessage({op:'view'}))?.ok!==true}catch{return true}
    }});
    return r.result;
  },Number(task.tabId));
  assert.ok(rejected);
  report.contentScriptRejected=true;
}
await fs.writeFile(path.join(archive,'enhanced-playback.json'),JSON.stringify(report,null,2)+'\n');
}catch(e){
  report.error=String(e.message);await fs.writeFile(path.join(archive,'enhanced-playback.json'),JSON.stringify(report,null,2)+'\n');console.error(report.error);throw e;
}finally{
  await release?.();await fiber?.dispose();await host?.dispose();
  if(remote){
    if(remote.isConnected()) await remote.newBrowserCDPSession().then(s=>s.send('Browser.close')).catch(()=>{});
    await remote.close().catch(()=>{});
  }else await browser?.close();
  await bridge.dispose();
  // The CDP socket can disconnect before Chrome finishes writing its profile.
  const exitDeadline=Date.now()+20000;
  for(;;){
    const {stdout}=await promisify(execFile)('/bin/ps',['-axo','command='],{maxBuffer:16*1024*1024});
    const running=stdout.split('\n').some(line=>line.includes('Google Chrome for Testing.app/Contents/')&&line.includes('--user-data-dir='+profile));
    if(!running)break;
    if(Date.now()>exitDeadline)throw Error('The owned test browser has not exited: '+tmp);
    await delay(150);
  }
  await fs.rm(tmp,{recursive:true,force:true,maxRetries:4,retryDelay:150});
  assert.equal(await fs.stat(tmp).then(()=>true,()=>false),false);
  console.log('Temporary test profile removed:',tmp);
}
