import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeProtocolTestSkip, assertNativeProtocolTestOptIn } from './helpers/native-test-opt-in.mjs';
const binary=fileURLToPath(new URL('../native/build/Whale Computer.app/Contents/MacOS/whale-helper',import.meta.url));
const nativeSkip=nativeProtocolTestSkip();
function launch(){
  assertNativeProtocolTestOptIn();
  const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});
  let buffer='';const messages=[];const pending=[];
  child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{
    buffer+=data;let index;
    while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;const value=JSON.parse(line);messages.push(value);for(const item of [...pending])if(item.predicate(value)){clearTimeout(item.timer);pending.splice(pending.indexOf(item),1);item.resolve(value)}}
  });
  let diagnostics='';child.stderr.setEncoding('utf8');child.stderr.on('data',data=>{diagnostics+=data});
  const wait=predicate=>{const found=messages.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const item={predicate,resolve,timer:setTimeout(()=>reject(new Error(`native timeout; seen=${JSON.stringify(messages.map(x=>({event:x.event,id:x.id,code:x.error?.code})))}; stderr=${diagnostics.slice(-1000)}`)),10000)};pending.push(item)})};
  let counter=0;
  return {child,messages,wait,async call(method,params={}){const id=`test-${++counter}`;child.stdin.write(JSON.stringify({id,method,params})+'\n');return wait(x=>x.id===id)},async close(){if(child.exitCode==null){try{await this.call('shutdown')}finally{child.stdin.end();child.kill()}}}};
}
test('native pure self tests do not query or operate desktop',{skip:nativeSkip},()=>{
  assertNativeProtocolTestOptIn();
  const result=spawnSync(binary,['--self-test'],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);const value=JSON.parse(result.stdout.trim());assert.ok(value.result.passed>=12);assert.equal(value.result.guiActions,0);assert.equal(value.result.permissionPrompts,0);
});
test('native protocol startup/status/pause/invalid requests without TCC prompts',{skip:nativeSkip},async t=>{
  const client=launch();t.after(()=>client.close());
  const ready=await client.wait(x=>x.event==='ready');assert.equal(ready.data.protocol,1);assert.equal(ready.data.version,'0.4.1');
  const status=await client.call('status');assert.equal(status.result.protocol,1);assert.equal(typeof status.result.permissions.accessibility,'boolean');assert.equal(typeof status.result.capabilities.privateSkyLight,'boolean');assert.equal(status.result.privateInput.enabled,false);assert.equal(status.result.paused,true);
  const userOnly=await client.call('permissions.request',{kind:'accessibility'});assert.equal(userOnly.error.code,'user_required');
  const inputDenied=await client.call('input.configure',{privateSkyLight:true});assert.equal(inputDenied.error.code,'user_required');
  const privateEnabled=await client.call('input.configure',{privateSkyLight:true,userInitiated:true});assert.equal(privateEnabled.result.enabled,true);assert.equal(privateEnabled.result.empiricallyValidated,false);
  const privateDisabled=await client.call('input.configure',{privateSkyLight:false,userInitiated:true});assert.equal(privateDisabled.result.enabled,false);
  const preview=await client.call('overlay.preview');assert.equal(preview.error.code,'user_required');
  const resumed=await client.call('resume');assert.equal(resumed.error.code,'user_required');
  const unknown=await client.call('not-a-method');assert.equal(unknown.error.code,'method_not_found');
  const enabled=await client.call('resume',{userInitiated:true});assert.equal(enabled.result.paused,false);
  const unsafe=await client.call('observe',{bundleId:'com.apple.Terminal'});assert.equal(unsafe.error.code,'forbidden_target');
  const stale=await client.call('action',{bundleId:'com.apple.TextEdit',snapshotId:'not-real',action:'click',mode:'preserve'});assert.equal(stale.error.code,'stale_snapshot');
  const paused=await client.call('pause');assert.equal(paused.result.paused,true);
  const blocked=await client.call('observe',{bundleId:'com.apple.TextEdit'});assert.equal(blocked.error.code,'paused');
  client.child.stdin.write('{bad json}\n');const invalid=await client.wait(x=>x.error?.code==='parse_error');assert.equal(invalid.id,'');
  const check=await client.call('status');assert.equal(check.result.paused,true);
  for(let i=0;i<8;i++){
    client.child.stdin.write(JSON.stringify({id:`race-resume-${i}`,method:'resume',params:{userInitiated:true}})+'\n'+JSON.stringify({id:`race-pause-${i}`,method:'pause',params:{}})+'\n');
    await client.wait(x=>x.id===`race-resume-${i}`);await client.wait(x=>x.id===`race-pause-${i}`);
    const stopped=await client.call('status');assert.equal(stopped.result.paused,true);
  }
  assert.equal(client.messages.filter(x=>x.event==='paused').length,0,'command pauses must not echo spontaneous pause events');

});
test('native rejects oversized framing then resynchronizes',{skip:nativeSkip},async t=>{
  const client=launch();t.after(()=>client.close());await client.wait(x=>x.event==='ready');
  client.child.stdin.write('x'.repeat(2*1024*1024+1)+'\n');await client.wait(x=>x.error?.code==='line_limit');
  const status=await client.call('status');assert.equal(status.result.protocol,1);
});
