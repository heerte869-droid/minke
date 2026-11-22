import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Context} from '@deepseek-ai/cordis';
import ToolsService from '@deepseek-ai/dsh-tools';
import {NativeToolExecutor} from '@deepseek-ai/dsh-tool-executor-native';
import {Coordinator} from '../lib/coordinator.js';
import {registerTools} from '../index.js';

test('real DSH pipeline admission is reused without bypassing app consent or a denied call',async()=>{
 const ctx=new Context();ctx.provide('systemPrompt',{tools:()=>()=>{}});
 const fiber=ctx.plugin(ToolsService,{});for(let i=0;i<20&&!ctx.get('tools');i++)await new Promise(r=>setImmediate(r));assert.equal(fiber.state,2);const tools=ctx.get('tools');const release=tools.setExecutor(new NativeToolExecutor(ctx));
 let deny=false,manualAsks=0,consentAsks=0,count=0,actions=0;const admitted=[];
 const policy=ctx.on('tools/pre-execute',async(exec,next)=>{admitted.push(exec);return deny?{kind:'deny',reason:'fixture denied'}:next()});
 class Native extends EventEmitter{
  connected=true;pauseNow(){}
  async request(method,params){if(method==='action')actions++;if(method==='observe'||method==='action'){
   const snapshot={snapshotId:'s-'+(++count),observedAt:Date.now(),bundleId:params.bundleId,frame:{x:10,y:20,width:400,height:300},tree:[{ref:'node-1',role:'AXButton',title:'Fixture Count',enabled:true}]};
   return method==='action'?{snapshot,dispatch:{verified:true}}:snapshot;
  }return{paused:method!=='resume',escapeStopAvailable:true}}
  async dispose(){}
 }
 const config={enabled:true,mode:'preserve'};
 const co=new Coordinator({native:new Native(),getConfig:()=>config,deniedOrigins:['http://127.0.0.1:59721'],approval:{request:async()=>{manualAsks++;return'rejected'}},questions:{ask:async()=>{consentAsks++;return{answers:[{id:'computer-use-access',selected:['允许10分钟']}]}}}});
 registerTools(ctx,co);const agent={id:'test-agent',session:{id:'test-session'},ctx};
 const call=async(name,args)=>{const batch=await tools.execute({calls:[{id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}],agent,signal:new AbortController().signal});return batch.results[0].result};
 const parsed=r=>JSON.parse(r.content.find(c=>c.type==='text').text);
 try{
  await co.userCommand('resume');
  const observation=await call('whale_observe',{bundleId:'org.test.fixture'});
  assert.equal(observation.isError,false);const snap=parsed(observation).snapshot;
  assert.equal(consentAsks,1);assert.equal(manualAsks,0,'App consent works even when the tool-approval channel rejects asks');
  deny=true;const refused=await call('whale_action',{bundleId:'org.test.fixture',snapshotId:snap.snapshotId,action:'click',elementRef:'node-1'});
  assert.equal(refused.isError,true);assert.equal(actions,0);
  deny=false;const acted=await call('whale_action',{bundleId:'org.test.fixture',snapshotId:snap.snapshotId,action:'click',elementRef:'node-1'});
  assert.equal(acted.isError,false);assert.equal(actions,1);assert.equal(manualAsks,0,'No second manual approval after host admission');
  const next=parsed(acted).snapshot,oldExec=admitted.at(-1);
  await assert.rejects(co.action({bundleId:'org.test.fixture',snapshotId:next.snapshotId,action:'click',elementRef:'node-1'},oldExec),{code:'approval_denied'});
  assert.equal(actions,1,'The same execution context cannot reuse a finished receipt');
  config.screenshots=true;
  const changed=await call('whale_action',{bundleId:'org.test.fixture',snapshotId:next.snapshotId,action:'click',elementRef:'node-1'});
  assert.equal(changed.isError,true);assert.equal(co.status().paused,true);assert.equal(actions,1,'Preference change blocks dispatch before a polling tick');
 }finally{await co.dispose();policy();await release();await fiber.dispose()}
});
