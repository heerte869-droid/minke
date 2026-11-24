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
import {registerBrowserHost} from './setup-browser.mjs';

const archive=process.env.WHALE_FORM_ARTIFACTS;
const extension=path.resolve(process.env.WHALE_FORM_EXTENSION||'browser-extension');
const bin=process.env.WHALE_TEST_CHROMIUM;
assert.ok(bin,'Set WHALE_TEST_CHROMIUM to a Chrome for Testing binary');
const tmp=await fs.mkdtemp('/tmp/whale-forms-');
const profile=path.join(tmp,'profile');
const fixture=path.resolve('test/fixtures/openai-cua/labs/booking-lab-template');
const site='https://www.bilibili.com';
const version=JSON.parse(await fs.readFile(path.join(extension,'manifest.json'))).version;
const report={extensionVersion:version,rounds:[]};
const bridge=new ExtensionBridge();
let browser,host,release,fiber;
let remote;
const windowed=process.argv.includes('--windowed');
try{
  await fs.mkdir(profile);
  await bridge.start(tmp);
  await registerBrowserHost({userDataDir:profile,profileDir:tmp});
  const flags=['--disable-extensions-except='+extension,'--load-extension='+extension,
    '--host-resolver-rules=MAP www.bilibili.com ~NOTFOUND, MAP search.bilibili.com ~NOTFOUND'];
  if(windowed){
    // Launch Services keeps the user's front application active. Connect only to
    // the debugging port Chrome assigned to this freshly created test profile.
    const app=path.resolve(bin,'../../..');
    await promisify(execFile)('/usr/bin/open',['-g','-n','-a',app,'--args','--user-data-dir='+profile,
      '--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--no-first-run','--no-default-browser-check',
      '--disable-background-networking','--mute-audio','--window-size=1350,920',...flags,'about:blank']);
    let port;
    for(let i=0;i<100&&!port;i++){
      port=await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8').then(s=>Number(s.split('\n')[0]),()=>0);
      if(!port)await delay(100);
    }
    assert.ok(port,'the isolated background test window opened');
    remote=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true});
    browser=remote.contexts()[0];
  }else{
    browser=await chromium.launchPersistentContext(profile,{headless:true,chromiumSandbox:true,executablePath:bin,
      viewport:{width:1350,height:920},args:flags});
  }
  const files=new Map();
  for(const [name,type] of [['index.html','text/html'],['app.js','text/javascript'],['app.css','text/css']]){
    files.set('/'+name,{contentType:type+';charset=utf-8',body:await fs.readFile(path.join(fixture,name))});
  }
  if(process.env.WHALE_TEST_VIDEO){
    files.set('/media-test.html',{contentType:'text/html',body:'<!doctype html><title>Sintel playback test</title><video controls width="800" src="/sample.mp4"></video>'});
    files.set('/sample.mp4',{contentType:'video/mp4',body:await fs.readFile(process.env.WHALE_TEST_VIDEO)});
  }
  await browser.route('**/*',route=>{
    const u=new URL(route.request().url());
    const data=files.get(u.pathname==='/'?'/index.html':u.pathname);
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
  for(let i=0;i<100&&!bridge.autoReady;i++)await delay(80);
  assert.ok(bridge.autoReady,'extension native messaging is ready');
  const worker=browser.serviceWorkers()[0];
  const selected=()=>worker.evaluate(async()=>{const [t]=await chrome.tabs.query({active:true,lastFocusedWindow:true});return [t.windowId,t.id]});
  const source=await selected();
  await worker.evaluate(()=>{globalThis.activationEvents=[];chrome.tabs.onActivated.addListener(e=>globalThis.activationEvents.push(e.tabId))});
  const [page,task]=await Promise.all([browser.waitForEvent('page'),bridge.openTask('bilibili')]);
  await page.goto(site+'/index.html');
  await page.getByText('3 stays').waitFor();
  host=new Coordinator({native:{request:async()=>({}),pauseNow(){}},extensionBridge:bridge,deniedOrigins:['http://127.0.0.1:59721'],
    getConfig:()=>({enabled:true,sessionAccess:true,overlayMode:'companion',cursorVariant:'large',cursorSize:76})});
  await host.userCommand('resume');
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
  let snapshot;
  const observe=async()=>{snapshot=(await tool({operation:'observe'})).snapshot};
  async function action(operation,title,params={}){
    const nodes=snapshot.tree.filter(n=>n.title===title);
    assert.equal(nodes.length,1,'unique target '+title);
    const result=await tool({operation,snapshotId:snapshot.snapshotId,ref:nodes[0].ref,...params});
    if(operation!=='click')assert.equal(result.dispatch?.verified,true,'field readback '+title);
    snapshot=result.snapshot;
    assert.equal(snapshot.tabActive,false,'operation must stay in the background');
  }
  if(process.argv.includes('--baseline')){
    await observe();
    report.missingRegion=!snapshot.tree.some(n=>n.title==='Neighborhood');
    report.unnamedTextFields=snapshot.tree.filter(n=>n.role==='textbox'&&n.title==='INPUT').length;
    assert.ok(report.missingRegion&&report.unnamedTextFields>=2);
  }else{
    for(let round=1;round<=3;round++){
      await page.reload();
      await page.getByText('3 stays').waitFor();
      const start=performance.now();
      await observe();
      await action('selectOption','Neighborhood',{labels:['Marina District']});
      await action('setChecked','Breakfast included',{checked:true});
      await action('setChecked','Workspace desk',{checked:true});
      await action('click','Search');
      await action('click','Choose stay');
      const fields=[['Guest name','Whale QA '+round],['Guest email','qa'+round+'@example.test'],
        ['Check-in','2026-12-01'],['Check-out','2026-12-03'],['Special request','Quiet room '+round]];
      for(const [name,text] of fields)await action('fill',name,{text});
      await action('click','Confirm stay');
      assert.ok(snapshot.text.includes('Luma Harbor Hotel confirmed')&&snapshot.text.includes('2026-12-01 to 2026-12-03 · Whale QA '+round));
      const ms=Math.round(performance.now()-start);
      const receipt=await page.evaluate(()=>window.__bookingReadConfirmation());
      assert.deepEqual(receipt,{hotelId:'luma_harbor',hotelName:'Luma Harbor Hotel',checkIn:'2026-12-01',checkOut:'2026-12-03',
        guestName:fields[0][1],guestEmail:fields[1][1],specialRequest:fields[4][1]});
      assert.deepEqual(await selected(),source);
      if(windowed)assert.equal(snapshot.visibility,'hidden','windowed task must actually be hidden');
      report.rounds.push({round,ms,confirmed:true,selectedTabPreserved:true,visibility:snapshot.visibility});
    }
    const events=await worker.evaluate(()=>globalThis.activationEvents);
    assert.ok(!events.includes(Number(task.tabId)));
    report.taskTabActivations=events.filter(id=>id===Number(task.tabId)).length;
    // Exercise the shared port directly: normal model tools are serialized by the coordinator.
    await page.evaluate(()=>document.body.append(document.createElement('video')));
    const meta=await bridge.request('meta');
    const reads=Promise.all(Array.from({length:3},()=>bridge.request('verifyPlayback',{tabId:meta.tabId,url:meta.url})));
    await assert.rejects(bridge.request('meta'),{code:'extension_busy',details:{notDispatched:true}});
    await reads;
    assert.equal((await bridge.request('meta')).tabId,meta.tabId);
    await page.evaluate(()=>document.querySelector('video:last-child')?.remove());
    await page.evaluate(()=>{window.checkboxClicks=0;document.querySelector('input[type=checkbox]').addEventListener('click',()=>window.checkboxClicks++)});
    await action('setChecked','Breakfast included',{checked:true});
    assert.equal(await page.evaluate(()=>window.checkboxClicks),0);
    await action('setChecked','Breakfast included',{checked:false});
    assert.equal(await page.evaluate(()=>window.checkboxClicks),1);
    await assert.rejects(action('fill','Check-in',{text:'not-a-date'}),/格式/);
    assert.equal(await page.getByLabel('Check-in',{exact:true}).inputValue(),'2026-12-01');
    report.idempotentCheck=true;report.invalidDatePreserved=true;
    await observe();
    await action('setChecked','Breakfast included',{checked:true});
    await action('click','Confirm stay');
    // Simulate a viewer entering the existing tab only after background measurements.
    await worker.evaluate(async id=>chrome.tabs.update(Number(id),{active:true}),task.tabId);
    await page.waitForFunction(()=>{
      const c=document.querySelector('canvas[inert][aria-hidden=true]');
      return c?.getBoundingClientRect().width>10&&c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>220);
    });
    assert.equal((await bridge.request('meta')).tabId,task.tabId);
    report.visibleCursorOnEntry=true;
    if(archive){await fs.mkdir(archive,{recursive:true});await page.screenshot({path:path.join(archive,windowed?'DSH-后台切入.png':'DSH-表单确认与鲸鱼娘.png')})}
    if(windowed&&process.env.WHALE_TEST_VIDEO){
      await worker.evaluate(id=>chrome.tabs.update(id,{active:true}),source[1]);
      await page.close();
      for(let i=0;i<30&&bridge.connected;i++)await delay(80);
      const [videoPage,videoTask]=await Promise.all([browser.waitForEvent('page'),bridge.openTask('bilibili')]);
      await videoPage.goto(site+'/media-test.html',{waitUntil:'domcontentloaded'});
      const select=id=>worker.evaluate(async id=>{await chrome.tabs.update(Number(id),{active:true})},id);
      const measure=()=>tool({operation:'verifyPlayback'});
      const testTransfer=process.argv.includes('--check-mute-transfer');
      const resume=(useTaskTabMute=false)=>tool({url:site+'/media-test.html',tabId:videoTask.tabId,useTaskTabMute},'whale_resume_video');
      await observe();
      assert.equal(snapshot.visibility,'hidden');
      assert.equal(snapshot.tabActive,false);
      if(process.argv.includes('--check-long')){
        await assert.rejects(tool({operation:'play',muted:true,ref:'999',snapshotId:snapshot.snapshotId}));
        assert.equal((await bridge.request('meta')).tabMuted,false,'a rejected ref cannot change tab sound');
        await observe();
      }
      const video=snapshot.tree.find(n=>n.role==='video');
      const play=await tool({operation:'play',muted:true,ref:video.ref,snapshotId:snapshot.snapshotId});
      const summarize=s=>({from:s.from,to:s.to,verified:s.verified,visibility:s.visibility,selected:s.tabActive,paused:s.paused,muted:s.muted});
      const cold=await measure();
      report.media={request:play.playbackState??play.playRequest??'dispatched',cold:summarize(cold)};
      if(!cold.verified&&snapshot.videos[0].readyState===0)assert.equal((await resume()).playbackState,'waiting_for_media');
      assert.deepEqual(await selected(),source);
      await select(videoTask.tabId);
      await videoPage.waitForFunction(()=>!document.hidden,undefined,{polling:50});
      const firstView=await measure();
      report.media.firstView=summarize(firstView);
      assert.ok(firstView.verified,'the original request begins or continues after selection');
      if(testTransfer){
        await assert.rejects(resume(true),/后台任务标签/);
        // This local player reproduces a site switching to muted autoplay.
        await videoPage.locator('video').evaluate(v=>{v.muted=true});
      }
      await select(source[1]);
      await videoPage.waitForFunction(()=>document.hidden,undefined,{polling:50});
      if(testTransfer)await videoPage.locator('video').evaluate(v=>v.pause()); // The fixture site pauses on hiding.
      let background=await measure();
      if(testTransfer)assert.ok(background.paused && background.elementMuted && background.tabMuted && !background.tabActive);
      report.media.afterLeaving=summarize(background);
      if(!background.verified&&background.paused&&background.visibility==='hidden'){
        // Independent scenario: issue one new play command to a confirmed
        // paused, already loaded player. Never replay an uncertain command.
        background=await resume(testTransfer);
        if(testTransfer)assert.ok(background.usedTaskTabMute && background.silenceVerified && !background.elementMuted);
        assert.equal(background.playSent,true);
        assert.equal(background.verificationScope,'player');
        report.media.explicitResume=background.playSent;
      }
      report.media.background=summarize(background);
      assert.ok(background.verified&&background.visibility==='hidden'&&!background.tabActive,JSON.stringify(report.media));
      assert.deepEqual(await selected(),source);
      if(process.argv.includes('--check-long')){
        const start=Date.now(),activations=await worker.evaluate(()=>globalThis.activationEvents.length);
        const readings=[];
        for(const when of [0,5000,10000,15000,20000,30000]){
          await delay(Math.max(0,start+when-Date.now()));
          const r=await measure();
          assert.ok(r.verified&&r.visibility==='hidden'&&!r.tabActive&&!r.paused);
          assert.ok(r.tabMuted&&!r.elementMuted&&r.silenceVerified);
          assert.deepEqual(await selected(),source);
          readings.push({...summarize(r),elapsedMs:Date.now()-start,elementMuted:r.elementMuted,tabMuted:r.tabMuted,silenceVerified:r.silenceVerified});
        }
        assert.ok(readings.at(-1).to-readings[0].from>=29);
        assert.equal(await worker.evaluate(()=>globalThis.activationEvents.length),activations);
        report.media.longBackground=readings;
      }
      const crossing=measure();
      await delay(650);
      await select(videoTask.tabId);
      report.media.switching=summarize(await crossing);
      assert.equal(report.media.switching.visibility,'mixed');
      const viewed=await resume();
      assert.equal(viewed.playSent,false);
      report.media.returned=summarize(viewed);
      assert.ok(viewed.verified&&viewed.visibility==='visible'&&viewed.from>=background.to);
      await videoPage.waitForFunction(()=>document.querySelector('canvas[inert]')?.getBoundingClientRect().width>10);
      if(archive)await videoPage.screenshot({path:path.join(archive,'DSH-视频续播.png')});
      const seeking=measure();
      await delay(650);
      await videoPage.locator('video').evaluate(v=>{v.currentTime+=5});
      report.media.seek=summarize(await seeking);
      assert.equal(report.media.seek.verified,false);

      if(process.argv.includes('--check-followup')){
        async function waitForReceipt(matches){
          const until=Date.now()+25000;
          let last;
          while(Date.now()<until){
            const {followUp}=await tool({},'whale_follow_video');
            last=followUp;
            if(matches(followUp))return followUp;
            if(followUp.status==='finished')throw Error('Unexpected final receipt: '+JSON.stringify(followUp));
            await delay(2500);
          }
          throw Error('Timed out waiting for playback receipt: '+JSON.stringify(last));
        }
        async function backgroundSample(){
          await select(source[1]);
          await videoPage.waitForFunction(()=>document.hidden,undefined,{polling:50});
          // Chrome can pause several seconds after a tab becomes hidden.
          // Use the observed pause before issuing an explicit resume in this test.
          const initial=await waitForReceipt(value=>value.background||value.latest?.paused);
          if(!initial.background){
            const r=await tool({url:videoPage.url(),tabId:videoTask.tabId},'whale_resume_video');
            assert.ok(r.verified&&r.playSent);
          }
          const receipt=await waitForReceipt(value=>value.background);
          assert.ok(receipt.background.playerId);
          assert.deepEqual(await selected(),source);
          return receipt.background;
        }
        const same=await backgroundSample();
        await select(videoTask.tabId);
        const continued=await waitForReceipt(value=>value.status==='finished');
        assert.equal(continued.reason,'viewed_after_background');
        assert.equal(continued.viewedAfterBackground.playerId,same.playerId);
        // Start a second watch on a fresh fixture page, then change its media
        // source in place as a single-page playlist would.
        await videoPage.goto(site+'/media-test.html?playlist=1',{waitUntil:'domcontentloaded'});
        await observe();
        const player=snapshot.tree.find(n=>n.role==='video');
        await tool({operation:'play',ref:player.ref,snapshotId:snapshot.snapshotId,muted:true});
        const previous=await backgroundSample();
        const unchangedUrl=videoPage.url();
        await videoPage.locator('video').evaluate((v,time)=>{
          v.addEventListener('loadedmetadata',()=>{v.currentTime=time;void v.play().catch(()=>{})},{once:true});
          v.src='/sample.mp4?clip=next';
        },previous.to+4);
        await select(videoTask.tabId);
        const switched=await waitForReceipt(value=>value.status==='finished');
        assert.equal(videoPage.url(),unchangedUrl);
        assert.equal(switched.reason,'player_changed');
        assert.equal(switched.viewedAfterBackground,null);
        assert.equal(switched.lastVerified.playerId,previous.playerId);
        const replacement=await measure();
        assert.notEqual(replacement.playerId,previous.playerId);
        assert.ok(replacement.verified&&replacement.from>=previous.to);
        report.media.followUp={samePlayer:continued.reason,background:same,viewed:continued.viewedAfterBackground,
          newSourceAtSameUrl:switched.reason,original:switched.lastVerified,replacement:summarize(replacement)};
      }
    }
  }
  console.log(JSON.stringify(report,null,2));
  if(archive){await fs.mkdir(archive,{recursive:true});await fs.writeFile(path.join(archive,'chrome-'+version+(windowed?'-windowed':'')+'.json'),JSON.stringify(report,null,2)+'\n')}
}catch(e){
  console.error(JSON.stringify(report));throw e;
}finally{
  await release?.();await fiber?.dispose();await host?.dispose();
  if(remote){
    const cdp=await remote.newBrowserCDPSession();
    await cdp.send('Browser.close').catch(()=>{});
    await remote.close();
  }else await browser?.close();
  await bridge.dispose();
  if(!process.env.WHALE_KEEP_TEST_PROFILE)await fs.rm(tmp,{recursive:true,force:true});
}
