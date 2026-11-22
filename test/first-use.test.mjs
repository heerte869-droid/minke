import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../lib/coordinator.js';
import {prepareChromeInstall} from '../lib/extension-setup.js';

const exec=()=>({agent:{id:'a',session:{id:'s'}},name:'whale_apps',callId:crypto.randomUUID()});
const temp=async t=>{const p=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-first-use-'));t.after(()=>fs.rm(p,{recursive:true,force:true}));return p};
function instance(root, enabled=true, onStart=async()=>({paused:false,escapeStopAvailable:true})){
  const calls=[],config={enabled,sessionAccess:true};
  const native=Object.assign(new EventEmitter(),{connected:true,pauseNow(){},async dispose(){},async request(method,params){
    calls.push(method);if(method==='session.start')return onStart(params);
    if(method==='resume')return {paused:false};if(method==='apps.list')return {apps:[]};return {};
  }});
  const co=new Coordinator({native,getConfig:()=>config,deniedOrigins:['http://127.0.0.1:59721']});
  co.bindProfile(root);return {co,native,calls,config};
}

test('new profile is ready without helper startup, and warm tasks reuse activation',async t=>{
  const {co,calls}=instance(await temp(t));
  try{assert.equal(co.status().controlState,'standby');assert.equal(co.status().paused,false);assert.deepEqual(calls,[]);
    await Promise.all([co.apps(exec()),co.apps(exec())]);
    assert.equal(co.status().controlState,'running');assert.equal(calls.filter(x=>x==='session.start').length,1);
    assert.ok(!calls.includes('permissions.request')&&!calls.includes('resume'));
  }finally{await co.dispose()}
});
test('a deliberate stop survives sleep, settings changes and host replacement',async t=>{
  const dir=await temp(t);const one=instance(dir);await one.co.apps(exec());
  await one.co.userCommand('pause');one.native.emit('paused',{reason:'session_or_sleep'});one.native.emit('sessionAvailable');
  await one.co.configureChanged();assert.equal(one.co.status().controlState,'stopped');await one.co.dispose();
  const two=instance(dir);try{
    await assert.rejects(two.co.apps(exec()),{code:'paused'});assert.equal(two.calls.length,0);
    await two.co.userCommand('resume');await two.co.apps(exec());assert.equal(two.co.status().controlState,'running');
  }finally{await two.co.dispose()}
  const three=instance(dir);try{assert.equal(three.co.status().controlState,'standby')}finally{await three.co.dispose()}
});
test('legacy explicit disable and a native emergency stop both survive startup',async t=>{
  const dir=await temp(t);const disabled=instance(dir,false);
  await assert.rejects(disabled.co.apps(exec()),{code:'disabled'});assert.equal(disabled.co.status().controlState,'stopped');await disabled.co.dispose();
  const a=instance(dir);await a.co.apps(exec());a.native.emit('paused',{reason:'human_input_or_native_safety_stop'});await a.co.dispose();
  const b=instance(dir);try{assert.equal(b.co.status().controlState,'stopped');assert.equal(b.calls.length,0)}finally{await b.co.dispose()}
});
test('sleep cancels prior work, a locked session stays blocked, unlock admits only a fresh task',async t=>{
  let locked=false;const a=instance(await temp(t),true,async()=>{if(locked)throw Object.assign(Error('locked'),{code:'session_inactive'});return {paused:false}});
  try{await a.co.apps(exec());locked=true;a.native.emit('paused',{reason:'session_or_sleep'});
    assert.equal(a.co.status().controlState,'waiting_session');await assert.rejects(a.co.apps(exec()),{code:'session_inactive'});
    assert.equal(a.calls.filter(x=>x==='apps.list').length,1);locked=false;a.native.emit('sessionAvailable');
    assert.equal(a.co.status().controlState,'standby');assert.equal(a.calls.filter(x=>x==='apps.list').length,1);
    await a.co.apps(exec());assert.equal(a.calls.filter(x=>x==='apps.list').length,2);
  }finally{await a.co.dispose()}
});
test('stopping during automatic activation supersedes an arriving ready reply',async t=>{
  let release,entered;const gate=new Promise(r=>{release=r}),start=new Promise(r=>{entered=r});
  const a=instance(await temp(t),true,async()=>{entered();await gate;return {paused:false}});
  try{const work=a.co.apps(exec());await start;await a.co.userCommand('pause');release();
    await assert.rejects(work,{code:'state_changed'});assert.equal(a.co.status().controlState,'stopped');assert.ok(!a.calls.includes('apps.list'));
  }finally{release();await a.co.dispose()}
});
test('missing extension returns one actionable result before native startup or task approval',async t=>{
  const a=instance(await temp(t));a.co.extensionBridge={connectionState:'not_connected',clearIndicators(){},async dispose(){}};
  try{
    const r=await a.co.watchVideo({query:'鲸鱼'},exec());assert.equal(r.requiresUserAction,true);assert.match(r.reason,/安装 Chrome 扩展/);
    a.co.extensionBridge.connectionState='waiting';assert.equal((await a.co.extension({operation:'observe'},exec())).browserState,'waiting');
    a.co.extensionBridge.connectionState='offline';assert.match((await a.co.watchVideo({query:'鲸鱼'},exec())).reason,/之前启用/);
    a.co.extensionBridge.connectionState='multiple';assert.match((await a.co.watchVideo({query:'鲸鱼'},exec())).reason,/多个/);
    assert.deepEqual(a.calls,[]);
  }finally{await a.co.dispose()}
});
test('setup prepares the bundled unpacked files, including first Chrome launch and an offline manager',async t=>{
  const profileDir=await temp(t),chromeDir=path.join(profileDir,'Chrome');let opens=0;
  await assert.rejects(prepareChromeInstall({profileDir,chromeDir,openManager:async()=>{throw Error('missing Chrome')}}),{code:'chrome_not_initialized'});
  const r=await prepareChromeInstall({profileDir,chromeDir,openManager:async()=>{opens++}});
  assert.equal(r.managerOpened,true);assert.equal(opens,1);assert.equal(JSON.parse(await fs.readFile(path.join(r.directory,'manifest.json'))).version,'0.4.12');
  const again=await prepareChromeInstall({profileDir,chromeDir,openManager:async()=>{throw Error('unavailable')}});
  assert.equal(again.managerOpened,false);assert.equal(again.directory,r.directory);
});

test('a connected extension distinguishes a missing window from an idle share',async t=>{
  const a=instance(await temp(t));let launches=0;
  a.co.approval={request:async()=>'allowed-once'};
  a.co.extensionBridge={connectionState:'ready',autoReady:true,connected:false,clearIndicators(){},async dispose(){},
    async openTask(){launches++;throw Object.assign(Error('No last-focused window'),{code:'extension_refused',details:{notDispatched:true}})}};
  try{
    const idle=await a.co.extension({operation:'observe'},exec());assert.equal(idle.browserState,'ready');
    const result=await a.co.watchVideo({query:'海獭'},exec());assert.equal(result.browserState,'no_window');
    assert.equal(result.doNotReplay,true);assert.equal(result.created,false);assert.equal(launches,1);
  }finally{await a.co.dispose()}
});
