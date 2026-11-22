import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { options, controllerOrigin, compareDesktop } from '../scripts/accept-native-fixture.mjs';

const execute=promisify(execFile);
const runner=fileURLToPath(new URL('../scripts/accept-native-fixture.mjs',import.meta.url));
const baseline={readOnly:true,frontmostPID:123,cursor:{x:100,y:200}};
const changed={readOnly:true,frontmostPID:456,cursor:{x:800,y:900}};

test('fixture acceptance and quiet comparison both require explicit opt-in',()=>{
  assert.equal(options([]).run,false);
  assert.equal(options(['--run']).auditStillness,false);
  assert.equal(options(['--audit-stillness']).run,false);
  assert.equal(options(['--run','--audit-stillness']).auditStillness,true);
  assert.throws(()=>options(['--disable-safety']),/Unknown option/);
  assert.throws(()=>options(['--origin']),/Missing/);
});

test('fixture runner accepts only explicit local controller origins',()=>{
  assert.equal(controllerOrigin('http://127.0.0.1:50077'),'http://127.0.0.1:50077');
  assert.equal(controllerOrigin('http://[::1]:50077'),'http://[::1]:50077');
  for(const origin of [null,'https://example.com:50077','file:///tmp/test','http://localhost','http://user:pass@localhost:50077','http://localhost:50077/path','http://localhost:50077/?secret=1','http://localhost:50077/#hash'])assert.throws(()=>controllerOrigin(origin));
});

test('ordinary semantic acceptance permits human desktop changes without causal claims',()=>{
  const result=compareDesktop(baseline,changed);
  assert.deepEqual(result,{foregroundSampleUnchanged:false,cursorSampleUnchanged:false,causalAttribution:'not-established',mode:'concurrent-semantic-only'});
  const unchanged=compareDesktop(baseline,baseline);
  assert.equal(unchanged.cursorSampleUnchanged,true);
  assert.equal(unchanged.causalAttribution,'not-established','unchanged samples cannot prove no transient movement');
  assert.deepEqual(baseline,{readOnly:true,frontmostPID:123,cursor:{x:100,y:200}},'comparison is read-only');
});

test('quiet audit stays opt-in and malformed desktop evidence fails closed',()=>{
  assert.throws(()=>compareDesktop(baseline,changed,{auditStillness:true}),/Quiet comparison interrupted/);
  assert.equal(compareDesktop(baseline,baseline,{auditStillness:true}).mode,'quiet-sampled-comparison');
  for(const bad of [null,{...changed,readOnly:false},{...changed,frontmostPID:0},{...changed,cursor:{x:NaN,y:1}},{...changed,cursor:{x:1,y:Infinity}}])assert.throws(()=>compareDesktop(baseline,bad),/metadata required/);
});

test('default/help CLI never runs acceptance and remote origins refuse before launch',async()=>{
  for(const args of [[],['--help'],['--audit-stillness'],['--output-dir','/nonexistent-no-io-required']]){
    const {stdout,stderr}=await execute(process.execPath,[runner,...args],{timeout:5000});
    assert.match(stdout,/Without --run this prints the plan and does nothing/);
    assert.match(stdout,/Normal mode permits user cursor\/foreground changes/);
    assert.equal(stderr,'');
  }
  await assert.rejects(execute(process.execPath,[runner,'--run','--origin','https://example.com:50077'],{timeout:5000}),error=>{
    assert.equal(error.code,1);
    assert.match(error.stderr,/Controller must be a local loopback origin/);
    assert.equal(error.stdout,'');
    return true;
  });
});
