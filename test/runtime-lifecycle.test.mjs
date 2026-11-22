import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import * as plugin from '../index.js';

test('real Cordis lifecycle mounts tools/settings and holds the sole provider until cleanup',async t=>{
 let Registry;
 try {Registry=(await import('@deepseek-ai/dsh-computer-use')).default}
 catch(error){if(error.code==='ERR_MODULE_NOT_FOUND'){t.skip('Current rc.3 registry required; run the verified runtime test command');return}throw error}
 const ctx=new Context(),tools=[],responses=[],skills=[];let inputRequests=0;
 const registryFiber=ctx.plugin(Registry);
 ctx.provide('tools',{register:tool=>{tools.push(tool);return()=>{const i=tools.indexOf(tool);if(i>=0)tools.splice(i,1)}}});
 ctx.provide('skills',{register:skill=>{skills.push(skill);return()=>{}}});
 ctx.provide('userQuestions',{ask:async()=>{throw Error('No consent during startup')}});
 ctx.provide('approval',{request:async()=>{inputRequests++;return'denied'}});
 ctx.provide('attachments',{saveImages:async()=>{throw Error('No image calls during startup')}});
 ctx.provide('workingDirectory',{ensure:async()=>process.cwd()});
 ctx.provide('webServer',{getOrigin:()=> 'http://127.0.0.1:59721'});
 ctx.provide('settings',{configure:()=>()=>{},update:async(_id,value)=>responses.push(JSON.parse(value.response))});
 let fiber;
 try{
  fiber=ctx.plugin(plugin,{helperPath:'/does-not-exist/no-startup-execution'});
  for(let i=0;i<30 && (tools.length<9 || !ctx.get('whaleDisplay') || !skills.length);i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(fiber.state,2,'Plugin reached the active Cordis lifecycle');
  assert.ok(tools.some(tool=>tool.name==='whale_verify_video'));
  assert.ok(tools.some(tool=>tool.name==='whale_ax_press'));
  assert.ok(tools.some(tool=>tool.name==='whale_follow_video'));
  assert.ok(tools.some(tool=>tool.name==='whale_resume_video'));
  assert.equal(tools.length, 19);
  assert.equal(skills.length,1);
  const match=skills[0].content.match(/await import\(("file:[^"]+")\)/);
  assert.ok(match,'Skill supplies the exact installed API URL');
  assert.equal(typeof (await import(JSON.parse(match[1]))).connectComputer,'function');
  assert.equal(ctx.get('computerUse').providerName,'whale-computer');
  const display=JSON.parse(ctx.get('whaleDisplay').read());
  assert.equal(display.status.paused,true);
  assert.equal(display.status.nativeConnected,false);
  assert.equal(responses.length,0,'Publishing host state never mutates profile settings');
  assert.equal(inputRequests,0);
  assert.throws(()=>ctx.get('computerUse').register('second-controller'),/already registered/);
  await fiber.dispose();fiber=null;
  assert.equal(ctx.get('computerUse').providerName,undefined,'Provider reservation released after shutdown');
 }finally{await fiber?.dispose();await registryFiber.dispose()}
});
