import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import {chromium} from 'playwright-core';import {ExtensionBridge} from '../lib/extension-bridge.js';import {registerBrowserHost} from '../scripts/setup-browser.mjs';import {EXTENSION_ID} from '../lib/extension-id.js';
const root=path.resolve('browser-extension'),d=await fs.mkdtemp('/tmp/whale-extension-qa-');let bridge=new ExtensionBridge();
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {PNG}=require(path.join(path.dirname(require.resolve('playwright-core/package.json')),'lib/utilsBundle.js'));
const checks=[];
async function visiblePixels(page,name){
  await page.waitForFunction(()=>{const c=document.querySelector('canvas[inert][aria-hidden=true]');return c?.getBoundingClientRect().width>10});
  const bounds=await page.evaluate(()=>{
    const c=document.querySelector('canvas[inert][aria-hidden=true]'),r=c.getBoundingClientRect(),px=c.getContext('2d').getImageData(0,0,c.width,c.height).data,points=[];
    for(let y=2;y<c.height-1;y+=3)for(let x=2;x<c.width-1;x+=3){
      const k=(y*c.width+x)*4;
      if(px[k+3]>245&&px[k+2]>px[k]+20)points.push([Math.floor(r.left+(x+.5)*r.width/c.width),Math.floor(r.top+(y+.5)*r.height/c.height),...px.slice(k,k+3)]);
    }
    return {points,rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
  });
  const file=path.join(d,name+'.png');
  const png=PNG.sync.read(await page.screenshot({path:file,scale:'css'}));
  let hits=0,total=0;
  for(const [x,y,r,g,b] of bounds.points){
    if(x<0||y<0||x>=png.width||y>=png.height)continue;
    const k=4*(y*png.width+x);total++;
    if(Math.max(Math.abs(r-png.data[k]),Math.abs(g-png.data[k+1]),Math.abs(b-png.data[k+2]))<44)hits++;
  }
  checks.push({name,hits,total,ratio:total?hits/total:0,rect:bounds.rect});
  assert.ok(total>=10&&hits/total>.55,'Rendered whale pixels missing: '+JSON.stringify(checks.at(-1)));
}

const bin=process.env.WHALE_TEST_CHROMIUM;if(!bin)throw Error('Set WHALE_TEST_CHROMIUM to an extension-capable test browser');let browser;
try{
 await fs.mkdir(path.join(d,'profile'),{recursive:true});await bridge.start(d);await registerBrowserHost({userDataDir:path.join(d,'profile'),profileDir:d});browser=await chromium.launchPersistentContext(path.join(d,'profile'),{executablePath:bin,headless:process.env.WHALE_TEST_HEADLESS==='1',chromiumSandbox:true,viewport:null,args:['--host-resolver-rules=MAP www.bilibili.com ~NOTFOUND, MAP search.bilibili.com ~NOTFOUND','--disable-extensions-except='+root,'--load-extension='+root]});
 await browser.route('https://www.bilibili.com/**',r=>r.fulfill({contentType:'text/html;charset=utf-8',body:'<title>扩展本地验收</title><label>查询<input placeholder="输入关键词"></label><button onclick="document.querySelector(\'output\').textContent=document.querySelector(\'input\').value">搜索</button><output></output><a href="https://www.bilibili.com/next">详情</a><video muted></video>'}));
 await browser.route('https://www.bilibili.com/next',r=>r.fulfill({contentType:'text/html;charset=utf-8',body:'<title>鲸类资料详情</title><h1>鲸类资料详情</h1>'}));
 const audio=Buffer.alloc(44+8000*18,128);audio.write('RIFF',0);audio.writeUInt32LE(audio.length-8,4);
 audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);
 audio.writeUInt32LE(8000,24);audio.writeUInt32LE(8000,28);audio.writeUInt16LE(1,32);audio.writeUInt16LE(8,34);audio.write('data',36);audio.writeUInt32LE(audio.length-44,40);
 await browser.route('https://search.bilibili.com/**',r=>r.fulfill({contentType:'text/html;charset=utf-8',body:'<title>搜索结果</title><a href="https://www.bilibili.com/video/BV1Ad/">游泳耳机测评</a><a href="https://www.bilibili.com/video/BV1Fixture/">鲸鱼科普：鲸类百科</a>'}));
 await browser.route('https://www.bilibili.com/video/BV1Fixture/**',r=>r.fulfill({contentType:'text/html;charset=utf-8',body:'<title>鲸类百科</title><video controls width="320" height="150" src="data:audio/wav;base64,'+audio.toString('base64')+'"></video>'}));
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 for(let i=0;i<80&&!bridge.autoReady;i++)await delay(100);
 assert.ok(bridge.autoReady,'installed extension must become available without opening its popup');
 const testWorker=browser.serviceWorkers()[0];
 await testWorker.evaluate(async()=>{const w=await chrome.windows.getLastFocused({windowTypes:['normal']});await chrome.windows.update(w.id,{left:10,top:80,width:850,height:600});});

 const selectedId=()=>testWorker.evaluate(async()=>(await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0].id);
 const originalTab=await selectedId();
 const createdManager=browser.waitForEvent('page');
 const manager=await bridge.openExtensionsManager();assert.ok(manager.openedInBackground);assert.equal(await selectedId(),originalTab);
 const managerPage=await createdManager;await managerPage.waitForURL('chrome://extensions/');
 await testWorker.evaluate(id=>chrome.tabs.remove(id),Number(manager.tabId));
 assert.equal(bridge.connected,false,'idle connection shares no page');
 await assert.rejects(bridge.openTask('other'),e=>e.code==='site_unsupported');
 const automatic=browser.waitForEvent('page',{timeout:12000});
 void automatic.catch(()=>{});
 const first=await bridge.openTask('bilibili',undefined,undefined,'鲸类对照');console.log('initial',first.presentation,first.tabId);
 const autoPage=await automatic;await autoPage.waitForURL('https://www.bilibili.com/**');
 const firstGroup=await testWorker.evaluate(async id=>{
   const tab=await chrome.tabs.get(Number(id));return chrome.tabGroups.get(tab.groupId);
 },first.tabId);
 assert.equal(firstGroup.title,'DSH · 鲸类对照');
 const autoMeta=await bridge.request('meta');
 assert.equal(first.tabId,autoMeta.tabId);assert.equal(autoMeta.active,false);
 await autoPage.bringToFront();
 assert.equal((await bridge.request('meta')).tabId,first.tabId);
 await autoPage.close();
 for(let i=0;i<20&&bridge.connected;i++)await delay(100);
 assert.ok(!bridge.connected&&bridge.autoReady,'closing a task releases only that page');
  const {searchAndPlay}=await import('../lib/bilibili-video.js');
 const windowState=()=>testWorker.evaluate(async()=>{
   const w=await chrome.windows.getLastFocused({windowTypes:['normal']});
   const [tab]=await chrome.tabs.query({windowId:w.id,active:true});
   return {id:w.id,selected:tab.id,count:(await chrome.windows.getAll({windowTypes:['normal']})).length};
 });
 const source=await windowState();
 const userGroup=await testWorker.evaluate(async id=>{
   const group=await chrome.tabs.group({tabIds:[id]});
   await chrome.tabGroups.update(group,{title:'DSH · B 站',color:'purple'});
   return group;
 },source.selected);
 const groupOf=id=>testWorker.evaluate(async id=>(await chrome.tabs.get(Number(id))).groupId,id);

 const newTask=await bridge.openTask('bilibili');
 assert.equal(newTask.presentation,'inactive-tab');
 assert.equal(newTask.sourceTabPreserved,true);assert.equal(newTask.sourceWindowPreserved,true);
 assert.deepEqual(await windowState(),source);
 const targetWindow=await testWorker.evaluate(async id=>(await chrome.tabs.get(Number(id))).windowId,newTask.tabId);
 assert.equal(targetWindow,source.id);
 assert.equal((await bridge.request('meta')).active,false);
 let tester;for(let i=0;i<40&&!tester;i++){tester=browser.pages().find(p=>p.url().startsWith('https://www.bilibili.com'));if(!tester)await delay(100)}assert.ok(tester,'dedicated isolated page');
 await tester.goto('https://www.bilibili.com/dsh-local-fixture');assert.equal(await tester.title(),'扩展本地验收');
 const {Coordinator}=await import('../lib/coordinator.js');
 const host=new Coordinator({native:{request:async()=>({}),pauseNow(){}},extensionBridge:bridge,
   deniedOrigins:['http://127.0.0.1:59721'],getConfig:()=>({enabled:true,sessionAccess:true,overlayMode:'companion',cursorSize:76,cursorVariant:'large'})});
 await host.userCommand('resume');
 const tool=async args=>{
   const exec={agent:{id:'compare',session:{id:'group-fixture'}},token:Symbol(),callId:crypto.randomUUID(),name:'whale_web'};
   return host.runHostAuthorized(exec,args,()=>host.extension(args,exec));
 };
 assert.equal(newTask.inTaskGroup,true);
 const rootGroup=await groupOf(newTask.tabId);
 assert.ok(rootGroup>=0 && rootGroup!==userGroup);
 const rootInfo=await testWorker.evaluate(async id=>chrome.tabGroups.get(id),rootGroup);
 assert.equal(rootInfo.title,'DSH · B 站');assert.equal(rootInfo.color,'purple');
 const firstPage=(await tool({operation:'observe'})).snapshot;
 const detail=firstPage.tree.find(node=>node.title==='详情');
 const childEvent=browser.waitForEvent('page');
 const child=await tool({operation:'openLinkTab',ref:detail.ref,snapshotId:firstPage.snapshotId});
 const childId=child.openedTabId;
 assert.equal(child.sourceTabId,newTask.tabId);assert.equal(await groupOf(childId),rootGroup);
 // Chrome may start a tabs.create navigation before Playwright attaches its
 // fixture route. Check the requested destination, then load the deterministic
 // test body on that same tab, without selecting it or contacting the site.
 const childPage=await childEvent;
 const requested=await testWorker.evaluate(async id=>{const t=await chrome.tabs.get(Number(id));return t.pendingUrl||t.url},childId);
 assert.equal(requested,'https://www.bilibili.com/next');
 await childPage.goto(requested);
 assert.equal(await childPage.title(),'鲸类资料详情');

 let taskPages=await tool({operation:'listTaskTabs'});
 assert.deepEqual(taskPages.tabs.map(t=>t.tabId),[newTask.tabId,childId]);
 assert.deepEqual(await windowState(),source);
 await tool({operation:'selectTaskTab',tabId:childId});
 const selectedChild=(await tool({operation:'observe'})).snapshot;
 assert.ok(selectedChild.url.endsWith('/next'));assert.equal(selectedChild.title,'鲸类资料详情');
 await tool({operation:'selectTaskTab',tabId:newTask.tabId});
 assert.equal((await tool({operation:'observe'})).snapshot.title,'扩展本地验收');
 await assert.rejects(tool({operation:'selectTaskTab',tabId:String(source.selected)}));
 assert.equal((await bridge.request('meta')).tabId,newTask.tabId);assert.deepEqual(await windowState(),source);
 // A user can move one result into their own group. Closing the DSH source must respect that layout.
 await testWorker.evaluate(async({id,g})=>chrome.tabs.group({tabIds:[Number(id)],groupId:g}),{id:childId,g:userGroup});
 // Observe the first navigation through the ordinary extension before allowing playback or selecting the task.
 let followChecked=false;
 const followed=Promise.withResolvers();
 const observedBridge={
   get serial(){return bridge.serial}, get connected(){return bridge.connected},
   async request(op,args,signal){
     const reply=await bridge.request(op,args,signal);
     if(op==='follow') {
       assert.equal(args.muteTaskTab,true);
       const tab=await testWorker.evaluate(id=>chrome.tabs.get(Number(id)),newTask.tabId);
       assert.equal(tab.active,false);
       assert.equal(tab.mutedInfo?.muted,true);
       assert.equal(tab.mutedInfo?.extensionId,EXTENSION_ID);
       assert.deepEqual(await windowState(),source);
       followChecked=true;
       followed.resolve();
     }
     return reply;
   }
 };
 const watching=tester.waitForURL('**/video/BV1Fixture/**').then(async()=>{
   await tester.locator('video').waitFor();
   await followed.promise;
   await tester.bringToFront();
 });
 void watching.catch(()=>{}); // A prior workflow failure may close the isolated browser before this observer finishes.
 const playback=await searchAndPlay(observedBridge,newTask.tabId,'鲸鱼 科普',new AbortController().signal,{overlayMode:'companion',cursorSize:76,cursorVariant:'large'});
 assert.ok(followChecked,'Chrome confirmed normal DSH owned the mute before the player opened');
 await watching;assert.equal(playback.verified,true);assert.equal(playback.title,'鲸类百科');assert.equal(playback.tabId,newTask.tabId);assert.equal(playback.muted,true);
 assert.ok(playback.to-playback.from>=1);assert.ok((await bridge.request('meta')).active);
 const startedFollow=await tool({operation:'followPlayback'});
 assert.equal(startedFollow.followUp.status,'checking');
 await delay(7300);await visiblePixels(tester,'video-after-old-timeout');
 const sampled=await tool({operation:'followPlayback'});
 assert.equal(sampled.followUp.id,startedFollow.followUp.id);
 assert.ok(sampled.followUp.samples>0 && sampled.followUp.latest.verified,'read-only host follow-up sampled the real player');
 assert.equal(sampled.followUp.latest.selectedAfter,true);
 assert.equal(sampled.followUp.background,null,'a visible sample cannot prove hidden playback');
 await fs.writeFile(path.join(d,'followup-results.json'),JSON.stringify(sampled,null,2));
 await tester.evaluate(()=>{const v=document.querySelector('video'),copy=v.cloneNode(true);v.replaceWith(copy)});
 await delay(600);await visiblePixels(tester,'replaced-player');
 await tester.reload();await visiblePixels(tester,'reloaded-video');
 await tester.evaluate(()=>{const b=document.createElement('button');b.textContent='全屏验收';b.onclick=()=>document.querySelector('video').requestFullscreen();document.body.append(b)});
 await tester.getByRole('button',{name:'全屏验收'}).click();await tester.waitForFunction(()=>document.fullscreenElement?.tagName==='VIDEO');
 await delay(250);await visiblePixels(tester,'native-video-fullscreen');await tester.evaluate(()=>document.exitFullscreen());
 const other=await browser.newPage();await other.setContent('<h1>用户的独立标签</h1>');await other.bringToFront();assert.equal(await other.locator('canvas[inert]').count(),0);
 await tester.bringToFront();await visiblePixels(tester,'returned-tab');
 bridge.clearIndicators();await tester.waitForFunction(()=>!document.querySelector('[data-dsh-cursor]'));
 await other.bringToFront();await tester.bringToFront();await delay(450);assert.equal(await tester.locator('[data-dsh-cursor]').count(),0);
 // Browser integration is real; only the native helper is stubbed.
 await host.userCommand('resume');
 await visiblePixels(tester,'restored-without-model-read');
 host.pause('user');await tester.waitForFunction(()=>!document.querySelector('[data-dsh-cursor]'));
 await other.close();
 // A user watching the current DSH page must not have it navigated away by the next search.
 await host.userCommand('resume');
 const initialPage=tester.url(),initialSelection=await windowState();
 assert.equal(initialSelection.selected,Number(newTask.tabId));
 const watchExec={agent:{id:'compare',session:{id:'group-fixture'}},token:Symbol(),callId:crypto.randomUUID(),name:'whale_watch_video'};
 const freshPage=browser.waitForEvent('page',{timeout:13000});
 const watch=host.runHostAuthorized(watchExec,{},()=>host.watchVideo({query:'海狮',audioMode:'muted'},watchExec));
 void watch.catch(()=>{});
 const nextSearch=await freshPage;
 await nextSearch.waitForURL('https://search.bilibili.com/**',{waitUntil:'commit'});
 assert.equal(new URL(nextSearch.url()).searchParams.get('keyword'),'海狮');
 // Chrome can commit the first navigation before the test router has attached to a new tab.
 if(!await nextSearch.getByText('鲸鱼科普：鲸类百科').count())await nextSearch.goto(nextSearch.url());
 const searchResult=await watch;
 assert.equal(searchResult.playbackState,'needs_selection');
 assert.equal(searchResult.created,true);
 assert.notEqual(searchResult.tabId,newTask.tabId);
 assert.equal(tester.url(),initialPage);
 assert.deepEqual(await windowState(),initialSelection);
 const newMeta=await bridge.request('meta');
 assert.equal(newMeta.tabId,searchResult.tabId);
 assert.equal(newMeta.active,false);
 const oldAndNew=await tool({operation:'listTaskTabs'});
 assert.ok(oldAndNew.tabs.some(row=>row.tabId===newTask.tabId && row.selectedInWindow));
 await nextSearch.bringToFront();
 const seen=await bridge.request('observe',{tabId:newMeta.tabId,url:newMeta.url});
 const candidate=seen.tree.find(row=>row.role==='link' && row.href?.includes('BV1Fixture'));
 assert.ok(candidate);
 await assert.rejects(bridge.request('follow',{tabId:newMeta.tabId,url:newMeta.url,snapshotId:seen.snapshotId,ref:candidate.ref,backgroundSearch:true}),e=>e.details?.notDispatched===true);
 assert.equal(nextSearch.url(),newMeta.url);
 await fs.writeFile(path.join(d,'selected-search-results.json'),JSON.stringify({created:searchResult.created,preserved:true,childInitiallySelected:newMeta.active,retainedInGroup:true,guardedFollow:true},null,2));
 await tool({operation:'selectTaskTab',tabId:newTask.tabId});
 await nextSearch.close();
 await tester.close();for(let i=0;i<20&&bridge.connected;i++)await delay(100);
 assert.equal(await groupOf(childId),userGroup);
 await testWorker.evaluate(async id=>chrome.tabs.remove(Number(id)),childId);
 const popup=await browser.newPage();
 await popup.goto('chrome-extension://'+EXTENSION_ID+'/popup.html');
 await popup.getByText('未共享',{exact:true}).waitFor();
 assert.equal(await popup.locator('button:visible').allTextContents().then(x=>x.join(',')),'共享当前页');
 await popup.screenshot({path:path.join(d,'popup-idle.png'),clip:{x:0,y:0,width:320,height:await popup.locator('body').evaluate(b=>b.getBoundingClientRect().height)}});
 const opened=browser.waitForEvent('page',{predicate:p=>p!==popup,timeout:15000});
 await bridge.openTask('bilibili');
 await popup.getByText('正在共享',{exact:true}).waitFor({timeout:8000});assert.ok(bridge.connected);
 const fixturePage=await opened;await fixturePage.goto('https://www.bilibili.com/dsh-local-fixture');assert.equal(await fixturePage.title(),'扩展本地验收');
 let meta,lastError;for(let i=0;i<25;i++){try{meta=await bridge.request('meta');break}catch(e){lastError=e.message;await new Promise(r=>setTimeout(r,150))}}if(!meta){const sw=browser.serviceWorkers()[0];console.log(JSON.stringify({lastError,pages:browser.pages().map(p=>p.url()),tabs:await sw.evaluate(async()=> (await chrome.tabs.query({})).map(t=>({id:t.id,url:t.url,pending:t.pendingUrl,status:t.status}))),permissions:await sw.evaluate(()=>chrome.permissions.getAll())}));}assert.ok(meta);
 const state=()=>bridge.request('observe',{tabId:meta.tabId,url:meta.url});let snap=await state();const field=snap.tree.find(x=>x.role==='textbox'),needle='鲸鱼插件 42';
 await bridge.request('fill',{...meta,snapshotId:snap.snapshotId,ref:field.ref,text:needle,showCursor:true,variant:'large',size:30});snap=await state();assert.equal(snap.tree.find(x=>x.role==='textbox').value,needle);
 const btn=snap.tree.find(x=>x.title==='搜索');await bridge.request('click',{...meta,snapshotId:snap.snapshotId,ref:btn.ref,showCursor:true,variant:'large',size:30});const page=browser.pages().find(p=>p.url().startsWith('https://www.bilibili.com/'));assert.equal(await page.locator('output').innerText(),needle);
 await popup.locator('#title').getByText('扩展本地验收',{exact:true}).waitFor();
 assert.equal(await popup.locator('#site').textContent(),'www.bilibili.com');
 for(const theme of ['light','dark']){
   await popup.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
   await popup.screenshot({path:path.join(d,'popup-'+theme+'.png'),clip:{x:0,y:0,width:320,height:await popup.locator('body').evaluate(b=>b.getBoundingClientRect().height)}});
 }
 await popup.locator('#view').click();
 await page.waitForFunction(()=>!document.hidden && !!document.querySelector('canvas[inert][aria-hidden=true]'));
 assert.equal((await bridge.request('meta')).tabId,meta.tabId);
 await popup.bringToFront();
 await assert.rejects(bridge.request('click',{...meta,snapshotId:snap.snapshotId,ref:btn.ref}));snap=await state();await assert.rejects(bridge.request('navigate',{...meta,snapshotId:snap.snapshotId,destination:'https://example.org/'}));
 await page.bringToFront();
 const cfg={mode:'companion',variant:'large',size:76,hold:350};
 await bridge.request('meta',{appearance:cfg});let aim=await state();
 await bridge.request('fill',{...meta,snapshotId:aim.snapshotId,ref:aim.tree.find(x=>x.role==='textbox').ref,text:'实屏输入',showCursor:true,cursorMode:'companion',variant:'large',size:76});
 await visiblePixels(page,'text-entry');
 aim=await state();await bridge.request('click',{...meta,snapshotId:aim.snapshotId,ref:aim.tree.find(x=>x.title==='搜索').ref,showCursor:true,cursorMode:'companion',variant:'large',size:76});
 await visiblePixels(page,'button-click');
 await bridge.request('meta',{appearance:{...cfg,mode:'hidden'}});await page.waitForFunction(()=>!document.querySelector('[data-dsh-cursor]'));
 await bridge.request('meta',{appearance:{...cfg,mode:'clean'}});aim=await state();
 await bridge.request('click',{...meta,snapshotId:aim.snapshotId,ref:aim.tree.find(x=>x.title==='搜索').ref,showCursor:true,cursorMode:'clean',cursorHold:500,variant:'large',size:76});
 await visiblePixels(page,'clean-immediate');await page.waitForFunction(()=>!document.querySelector('[data-dsh-cursor]')?.getBoundingClientRect().width);
 await popup.bringToFront();
 await popup.locator('#stop').click();await popup.getByText('未共享',{exact:true}).waitFor();await assert.rejects(bridge.request('meta'));
 for(let i=0;i<50 && await groupOf(meta.tabId)>=0;i++)await delay(40);
 assert.equal(await groupOf(meta.tabId),-1);
 await testWorker.evaluate(async({id,g})=>chrome.tabs.group({tabIds:[Number(id)],groupId:g}),{id:meta.tabId,g:userGroup});
 await page.bringToFront();
 const manual=await popup.evaluate(async()=>{const status=await chrome.runtime.sendMessage({op:'status'});return chrome.runtime.sendMessage({op:'connect',generation:status.generation,tabId:status.id})});
 assert.equal(manual.ok,true);
 await host.userCommand('resume');
 assert.equal((await bridge.request('meta')).tabId,meta.tabId);
 assert.equal(await groupOf(meta.tabId),userGroup);
 assert.equal((await tool({operation:'listTaskTabs'})).tabs.length,1);
 const manualMedia=page.locator('video');
 await manualMedia.evaluate(v=>{v.muted=false});
 assert.equal((await bridge.request('meta')).tabMuted,false);
 const manualState=(await tool({operation:'observe'})).snapshot;
 const manualRef=manualState.tree.find(n=>n.role==='video').ref;
 // This fixture has no media source. Its sound setting still records which
 // route the explicitly requested silent playback used.
 await tool({operation:'play',muted:true,ref:manualRef,snapshotId:manualState.snapshotId}).catch(()=>{});
 assert.equal(await manualMedia.evaluate(v=>v.muted),true);
 assert.equal((await bridge.request('meta')).tabMuted,false);
 // A host-only update can take longer than the worker's first reconnect attempt.
 // Keep the actual shared tab and do not replay any previous command.
 await bridge.dispose();await delay(800);bridge=new ExtensionBridge();await bridge.start(d);
 for(let i=0;i<70 && !bridge.connected;i++)await delay(100);
 if(!bridge.connected){
   const state=await testWorker.evaluate(async()=>({stored:await chrome.storage.session.get('sharedTab'),manifest:chrome.runtime.getManifest().version}));
   console.log('reconnect diagnostic',bridge.autoReady,JSON.stringify(state));
 }
 assert.ok(bridge.connected,'existing shared tab reconnects after host reload');
 assert.equal((await bridge.request('meta')).tabId,meta.tabId);
 await popup.evaluate(()=>chrome.runtime.sendMessage({op:'stop'}));
 assert.equal(await groupOf(meta.tabId),userGroup);
 assert.equal(await groupOf(source.selected),userGroup);
 await fs.writeFile(path.join(d,'group-results.json'),JSON.stringify({automaticGroup:rootInfo.title,namedTaskGroup:firstGroup.title,color:rootInfo.color,
   sameWindow:true,sourceSelectedPreserved:true,linkedPageGrouped:true,modelSwitchedTwice:true,unrelatedTabExcluded:true,
   userMovedPagePreserved:true,stopKeptPage:true,manualShareKeptUserGroup:true},null,2));
await fs.writeFile(path.join(d,'cursor-results.json'),JSON.stringify(checks,null,2));console.log(d,JSON.stringify(checks.map(x=>[x.name,x.ratio])));console.log('PASS automatic background task, tab switch, page close with standby retained, real extension, pairing, selected tab, fill + click oracle, stale ref refusal, cross-site refusal and disconnect');
}finally{await browser?.close();bridge.dispose()}
