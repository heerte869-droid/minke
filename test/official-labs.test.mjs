import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {EventEmitter} from 'node:events';
import {chromium} from 'playwright-core';
import {Context} from '@deepseek-ai/cordis';
import ToolsService from '@deepseek-ai/dsh-tools';
import {NativeToolExecutor} from '@deepseek-ai/dsh-tool-executor-native';
import {BrowserAdapter} from '../lib/browser.js';
import {Coordinator} from '../lib/coordinator.js';
import {registerTools} from '../index.js';
import {connectComputer} from '../lib/api.js';

test('OpenAI public labs: booking, HTML drag-and-drop, canvas drawing and save through plugin tools',{timeout:60000},async()=>{
 const fixtureRoot=path.resolve('test/fixtures/openai-cua/labs');
 await mkdir('.test-artifacts',{recursive:true});
 const owned=await mkdtemp(path.resolve('.test-artifacts/official-labs-'));
 const files=new Map();
 const {readdir}=await import('node:fs/promises');
 async function load(dir,url){for(const e of await readdir(dir,{withFileTypes:true})){const child=path.join(dir,e.name),u=url+'/'+e.name;if(e.isDirectory())await load(child,u);else if(/\.(html|css|js)$/.test(e.name))files.set(u,{bytes:await readFile(child),type:e.name.endsWith('.html')?'text/html':e.name.endsWith('.css')?'text/css':'text/javascript'})}}
 for(const lab of['booking','kanban','paint'])await load(path.join(fixtureRoot,lab+'-lab-template'),'/'+lab);
 const server=createServer((req,res)=>{const p=new URL(req.url,'http://127.0.0.1').pathname;const item=files.get(p.endsWith('/')?p+'index.html':p);res.statusCode=item?200:404;res.setHeader('content-type',(item?.type??'text/plain')+';charset=utf-8');res.end(item?.bytes??'Not found')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 let browserContext,co,toolsFiber,release;const ctx=new Context(),report={sourceCommit:'6dd34b40acc1d002696ccd41aaf0a1f2f2be290c',mode:'Deterministic controller through real DSH tool pipeline; no model/API calls',scenarios:[],toolCalls:0,appConsentQuestions:0};
 try{
  browserContext=await chromium.launchPersistentContext(path.join(owned,'profile'),{executablePath:(process.env.WHALE_TEST_CHROMIUM || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),headless:true,viewport:{width:1440,height:1000},deviceScaleFactor:2,args:['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1']});
  await browserContext.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  const port=(await readFile(path.join(owned,'profile/DevToolsActivePort'),'utf8')).trim().split('\n')[0];
  class Native extends EventEmitter{connected=true;pauseNow(){}async request(method){return{paused:method!=='resume'}}async dispose(){}}
  const config={enabled:true,mode:'preserve',browserEndpoint:'http://127.0.0.1:'+port,screenshots:false};
  co=new Coordinator({native:new Native(),createBrowser:(workspace,opts)=>new BrowserAdapter({workspace,...opts}),getWorkspace:async()=>owned,getConfig:()=>config,deniedOrigins:['http://127.0.0.1:50077'],approval:{request:async()=>{throw Error('Unexpected second tool approval')}},questions:{ask:async()=>{report.appConsentQuestions++;return{answers:[{id:'computer-use-access',selected:['允许10分钟']}]}}}});
  ctx.provide('systemPrompt',{tools:()=>()=>{}});toolsFiber=ctx.plugin(ToolsService,{});for(let i=0;i<20&&!ctx.get('tools');i++)await new Promise(r=>setImmediate(r));
  release=ctx.tools.setExecutor(new NativeToolExecutor(ctx));registerTools(ctx,co);
  const agent={id:'official-lab-agent',session:{id:'official-lab-session'},ctx};
  const tools=new Proxy({}, {get:(_t,name)=>async args=>{
   report.toolCalls++;const batch=await ctx.tools.execute({calls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args??{})}],agent,signal:new AbortController().signal});
   const result=batch.results[0].result;
   if(result.isError)throw Error(result.content.map(c=>c.text??'').join('\n'));
   return JSON.parse(result.content.find(c=>c.type==='text').text);
  }});
  const computer=connectComputer(()=>tools);
  await co.userCommand('resume');
  const booking=await computer.createBrowserTab(origin+'/booking/');
  await booking.getState();
  await booking.getByLabel('Neighborhood').selectOption({label:'Marina District'});
  await booking.getByLabel('Breakfast included').click();
  await booking.getByLabel('Workspace desk').click();
  await booking.getByRole('button',{name:'Search'}).click();
  await booking.getByRole('button',{name:'Choose stay'}).click();
  await booking.getByLabel('Guest name').fill('Whale QA');
  await booking.getByLabel('Guest email').fill('qa@example.test');
  await booking.getByLabel('Check-in').fill('2026-12-01');
  await booking.getByLabel('Check-out').fill('2026-12-03');
  await booking.getByLabel('Special request').fill('安静房间 · automated local test');
  await booking.getByRole('button',{name:'Confirm stay'}).click();
  const bookingPage=browserContext.pages().find(p=>p.url().includes('/booking/'));
  const confirmed=await bookingPage.evaluate(()=>window.__bookingReadConfirmation());
  assert.equal(confirmed.hotelId,'luma_harbor');assert.equal(confirmed.guestName,'Whale QA');assert.equal(confirmed.checkIn,'2026-12-01');assert.match(confirmed.specialRequest,/安静房间/);
  await bookingPage.screenshot({path:path.join(owned,'booking.png')});report.scenarios.push({name:'booking',passed:true,hotelId:confirmed.hotelId});
  const kanban=await computer.createBrowserTab(origin+'/kanban/');
  let state=await kanban.getState();
  const card=state.snapshot.tree.find(n=>n.title.includes('Finalize analytics spec'));
  const destination=state.snapshot.tree.find(n=>n.title.includes('Polish stage tooltips'));
  assert.ok(card&&destination,'Draggable cards are visible in plugin observations');
  await kanban.drag([card.frame.x+card.frame.width/2,card.frame.y+card.frame.height/2],[destination.frame.x+destination.frame.width/2,destination.frame.y+destination.frame.height-12]);
  const kanbanPage=browserContext.pages().find(p=>p.url().includes('/kanban/'));
  const board=await kanbanPage.evaluate(()=>window.__kanbanReadBoardState());
  assert.ok(board.done.includes('analytics_spec'));assert.ok(!board.in_progress.includes('analytics_spec'));
  await kanbanPage.screenshot({path:path.join(owned,'kanban.png')});report.scenarios.push({name:'kanban-drag',passed:true,board});
  const paint=await computer.createBrowserTab(origin+'/paint/');
  const paintPage=browserContext.pages().find(p=>p.url().includes('/paint/'));
  await paintPage.waitForFunction(()=>window.__paintLabReady===true);
  await paint.getState();
  await paint.getByRole('button',{name:'Rectangle tool'}).click();
  state=await paint.getState();
  const canvas=state.snapshot.tree.find(n=>n.role==='canvas'&&n.frame.width>100);
  assert.ok(canvas,'Canvas bounds are observable');
  const from=[canvas.frame.x+canvas.frame.width*.2,canvas.frame.y+canvas.frame.height*.2],to=[canvas.frame.x+canvas.frame.width*.55,canvas.frame.y+canvas.frame.height*.5];
  const relative=p=>[Math.floor(p[0]/state.snapshot.viewport.width*1000),Math.floor(p[1]/state.snapshot.viewport.height*1000)];
  await paint.drag(relative(from),relative(to),{relative:true});
  await paint.getByRole('button',{name:'Save draft'}).click();
  assert.equal((await paint.waitFor({text:'Saved draft'})).matched,true);
  const saved=await paintPage.evaluate(()=>window.__paintReadSaveRecord());
  assert.ok(saved?.document?.paintedPixelCount>100,'A real canvas change was saved');
  await paintPage.screenshot({path:path.join(owned,'paint.png')});report.scenarios.push({name:'canvas-relative-drag-and-save',passed:true,paintedPixelCount:saved.document.paintedPixelCount});
  report.passed=true;
 }catch(error){report.failure=error.message;throw error}
 finally{
  await co?.dispose();await release?.();await toolsFiber?.dispose();await browserContext?.close();await new Promise(r=>server.close(r));
  await writeFile(path.join(owned,'result.json'),JSON.stringify(report,null,2));
 }
});
