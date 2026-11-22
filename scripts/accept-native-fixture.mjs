#!/usr/bin/env node
/** Explicit, semantic-only acceptance. Default invocation does not spawn anything. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyBuildInputs } from './native-build-inputs.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const bundleId='local.dsh.computer-use.fixture';
const fixturePath=path.join(root,'native/build/Computer Use Fixture.app/Contents/MacOS/computer-use-fixture');
const helperPath=path.join(homedir(),'.dsh/whale-computer/Whale Computer.app/Contents/MacOS/whale-helper');
const execute=promisify(execFile);
const usage=`Semantic-only disposable fixture acceptance\n\nnode scripts/accept-native-fixture.mjs --run --origin http://127.0.0.1:PORT [--output-dir EXISTING_PACKAGE_DIRECTORY] [--audit-stillness]\n\nWithout --run this prints the plan and does nothing. Lead supplies the current trusted DSH origin.\nUses the already-installed helper by default, or an explicit verified --candidate-dir. Never rebuilds, signs or installs it. Compiles only the read-only\nmetadata probe into a new evidence directory. Launches one new disposable fixture, verifies its exact\nchild PID/window, and performs only AX setValue, advertised AXPress, and optional AX selectText.\nNo raw typing, key/mouse events, private backend, activation or permission requests. Optional --capture tests screenshots/OCR of only this disposable window.\nNormal mode permits user cursor/foreground changes: samples are descriptive, not causal proof of\nnon-interference. Do not interact with the disposable target itself. Optional --audit-stillness\nrequires unchanged sampled cursor/foreground for a separate quiet comparison, not normal usage.\nNative safety stops, target mismatch and action uncertainty always abort without retry.\nJSON evidence is saved in a new directory under --output-dir (default native/build).\n`;
export function options(argv){
  const result={run:false,origin:null,outputDir:path.join(root,'native/build'),help:false,auditStillness:false,candidateDir:null,capture:false};
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--run')result.run=true;
    else if(argv[i]==='--help')result.help=true;
    else if(argv[i]==='--capture')result.capture=true;
    else if(argv[i]==='--audit-stillness')result.auditStillness=true;
    else if(['--origin','--output-dir','--candidate-dir'].includes(argv[i])){
      const key=argv[i];assert.ok(argv[i+1]&&!argv[i+1].startsWith('--'),`Missing ${key} value`);
      result[key==='--origin'?'origin':key==='--candidate-dir'?'candidateDir':'outputDir']=argv[++i];
    }else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return result;
}
export function compareDesktop(baseline,current,{auditStillness=false}={}){
  for(const sample of [baseline,current])assert.ok(sample?.readOnly===true&&Number.isInteger(sample.frontmostPID)&&sample.frontmostPID>0&&Number.isFinite(sample.cursor?.x)&&Number.isFinite(sample.cursor?.y),'Usable read-only desktop metadata required');
  const foregroundSampleUnchanged=current.frontmostPID===baseline.frontmostPID;
  const cursorSampleUnchanged=Math.abs(current.cursor.x-baseline.cursor.x)<=0.5&&Math.abs(current.cursor.y-baseline.cursor.y)<=0.5;
  const comparison={foregroundSampleUnchanged,cursorSampleUnchanged,causalAttribution:'not-established',mode:auditStillness?'quiet-sampled-comparison':'concurrent-semantic-only'};
  if(auditStillness)assert.ok(foregroundSampleUnchanged&&cursorSampleUnchanged,'Quiet comparison interrupted: sampled desktop changed; not an attribution to helper input');
  return comparison;
}
export function controllerOrigin(raw){
  assert.ok(raw,'--origin is required with --run');const url=new URL(raw);
  assert.ok(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/','Pass a plain HTTP(S) controller origin, without credentials/path/query');
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Controller must be a local loopback origin');
  assert.ok(url.port&&Number(url.port)>0,'Controller must include its current explicit nonstandard port');
  return url.origin;
}
const alive=child=>child&&child.pid&&child.exitCode===null&&child.signalCode===null;
function exitWithin(child,ms){
  if(!alive(child))return Promise.resolve(true);
  return new Promise(resolve=>{const done=()=>{clearTimeout(timer);resolve(true)};const timer=setTimeout(()=>{child.off('exit',done);resolve(false)},ms);child.once('exit',done)});
}
async function terminateOwned(child){
  if(!alive(child))return;
  child.kill('SIGTERM');if(!await exitWithin(child,1000)&&alive(child)){child.kill('SIGKILL');await exitWithin(child,1000)}
}
class JSONChild {
  constructor(executable){
    this.child=spawn(executable,[],{stdio:['pipe','pipe','pipe']});this.messages=[];this.pending=[];this.counter=0;this.buffer='';this.fatal=null;
    this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',chunk=>{
      this.buffer+=chunk;if(Buffer.byteLength(this.buffer)>2*1024*1024){this.fail(new Error('Child JSON framing limit'));return}
      let index;while((index=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,index);this.buffer=this.buffer.slice(index+1);if(!line)continue;
        try{const value=JSON.parse(line);this.messages.push(value);for(const waiter of [...this.pending])if(this.messages.length-1>=waiter.from&&waiter.predicate(value)){clearTimeout(waiter.timer);this.pending.splice(this.pending.indexOf(waiter),1);waiter.resolve(value)}}catch{this.fail(new Error('Child emitted invalid JSON'));return}
      }
    });
    // Drain diagnostics without persisting arbitrary process logs.
    this.child.stderr.resume();this.child.stdin.on('error',error=>this.fail(error));
    this.child.on('error',error=>this.fail(error));this.child.on('exit',()=>this.fail(new Error('Owned child exited')));
  }
  fail(error){this.fatal??=error;for(const item of this.pending.splice(0)){clearTimeout(item.timer);item.reject(error)}}
  wait(predicate,from=0,timeout=6000){
    const found=this.messages.slice(from).find(predicate);if(found)return Promise.resolve(found);if(this.fatal)return Promise.reject(this.fatal);
    return new Promise((resolve,reject)=>{const item={predicate,from,resolve,reject,timer:setTimeout(()=>{this.pending.splice(this.pending.indexOf(item),1);this.pauseNow();this.fail(new Error('Child response timeout; no retry'));reject(this.fatal)},timeout)};this.pending.push(item)});
  }
  send(method,params={}){assert.ok(alive(this.child),'Owned helper is not alive');const id=`accept-${++this.counter}`;this.child.stdin.write(JSON.stringify({id,method,params})+'\n');return id}
  async call(method,params={},timeout=6000){if(this.fatal)throw this.fatal;const id=this.send(method,params);return this.wait(value=>value.id===id,0,timeout)}
  pauseNow(){if(alive(this.child)&&this.child.stdin.writable)this.child.stdin.write(JSON.stringify({id:`cleanup-pause-${++this.counter}`,method:'pause',params:{}})+'\n')}
  async dispose(){
    if(alive(this.child)){
      this.pauseNow();if(this.child.stdin.writable)this.child.stdin.write(JSON.stringify({id:'cleanup-shutdown',method:'shutdown',params:{}})+'\n');
      if(!await exitWithin(this.child,1500))await terminateOwned(this.child);
    }
  }
}
function summary(result){
  if(!result||typeof result!=='object')return result;
  if(result.snapshot)return {dispatch:result.dispatch,snapshot:summary(result.snapshot)};
  if(result.snapshotId)return {snapshotId:result.snapshotId,pid:result.pid,windowId:result.windowId,truncated:result.truncated,fixtureText:result.tree?.filter(row=>row.role==='AXTextField').map(row=>({ref:row.ref,value:row.value,description:row.description}))};
  return result;
}
async function run(opts){
  let selectedHelper=helperPath,selectedFixture=fixturePath;
  if(opts.candidateDir){
    const directory=await realpath(path.resolve(opts.candidateDir));
    assert.equal(path.dirname(directory),await realpath(path.join(root,'native/candidates')),'Candidate must be inside the isolated candidate root');
    const report=JSON.parse(await readFile(path.join(directory,'build-report.json'),'utf8'));
    selectedHelper=path.join(directory,'Whale Computer.app/Contents/MacOS/whale-helper');
    selectedFixture=path.join(directory,'Computer Use Fixture.app/Contents/MacOS/computer-use-fixture');
    assert.equal(report.helper,selectedHelper);assert.equal(report.installed,false);
    assert.equal(createHash('sha256').update(await readFile(selectedHelper)).digest('hex'),report.helperSha256);
    await verifyBuildInputs({directory:path.join(directory,report.inputSnapshot.directory),hashes:report.inputSnapshot.files});
  }
  const origin=controllerOrigin(opts.origin);const canonicalRoot=await realpath(root);const outputRoot=await realpath(path.resolve(opts.outputDir));
  assert.ok(outputRoot===canonicalRoot||outputRoot.startsWith(canonicalRoot+path.sep),'Evidence output must stay inside this package, including symlink resolution');
  const directory=await mkdtemp(path.join(outputRoot,'fixture-acceptance-'));const evidencePath=path.join(directory,'evidence.json');
  const evidence={startedAt:new Date().toISOString(),scope:{bundleId,origin,helperPath:selectedHelper,fixturePath:selectedFixture},mode:opts.auditStillness?'quiet-sampled-comparison':'concurrent-semantic-only',claims:{rawInputTested:false,independentRawCursorVerified:false,nonInterferenceCausallyProved:false},checks:[],calls:[],desktop:[],desktopComparisons:[],outcome:'failed',cleanup:{}};
  let helper,fixture,probeBinary,baseline,windowId,interrupted=false;
  const check=(condition,label)=>{assert.ok(condition,label);evidence.checks.push(label)};
  const interrupt=()=>{interrupted=true;helper?.pauseNow()};process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
  const deadline=setTimeout(interrupt,90000);deadline.unref();
  const metadata=async label=>{
    const args=fixture?.child.pid?['--fixture-pid',String(fixture.child.pid)]:[];
    if(helper?.child.pid)args.push('--overlay-pid',String(helper.child.pid));
    const {stdout}=await execute(probeBinary,args,{timeout:5000,maxBuffer:1024*1024});const data=JSON.parse(stdout);evidence.desktop.push({label,...data});
    check(data.readOnly===true&&Number.isInteger(data.frontmostPID)&&data.frontmostPID>0&&Number.isFinite(data.cursor?.x)&&Number.isFinite(data.cursor?.y),`${label}: usable read-only foreground/cursor metadata`);
    return data;
  };
  const preserve=(data,label)=>{
    evidence.desktopComparisons.push({label,...compareDesktop(baseline,data,opts)});
    if(opts.auditStillness)evidence.checks.push(`${label}: unchanged quiet desktop samples (not causal proof)`);
  };
  const scope=async label=>{
    check(!interrupted,'No interruption/deadline requested');check(alive(fixture?.child),'Owned fixture child is still alive');
    const data=await metadata(label);preserve(data,label);
    check(data.fixtures.length===1&&data.fixtures[0].pid===fixture.child.pid&&data.fixtures[0].executablePath===evidence.scope.fixtureExecutable,`${label}: fixture bundle uniquely identifies exact owned child PID/path`);
    check(data.frontmostPID!==fixture.child.pid,`${label}: disposable target remains background; no concurrent interaction with target`);
    // Window identity is selected once through the already-authorized helper,
    // then rebound by every returned snapshot and native pre-dispatch validation.
    // The independently compiled metadata probe never requires AX authorization.
  };
  const request=async(method,params={},allowError=false)=>{
    check(!interrupted,'No interruption before protocol request');
    if(method!=='pause')check(!helper.messages.some(message=>message.event==='paused'),'No spontaneous native safety stop');
    const response=await helper.call(method,params,params.screenshot||params.ocr?20000:6000);evidence.calls.push({method,params,response:response.error?{error:response.error}:{result:summary(response.result)}});
    if(response.error&&!allowError)throw new Error(`Native ${method} refused (${response.error.code}); never retried`);
    return response;
  };
  const target=()=>({bundleId,windowId,deniedOrigins:[origin]});
  const snapshot=data=>{
    check(data&&data.bundleId===bundleId&&data.pid===fixture.child.pid&&data.windowId===windowId,'Snapshot binds exact owned fixture PID/window');
    check(Array.isArray(data.tree)&&data.tree.every(row=>!row.secure)&&data.truncated===false&&!data.warnings?.some(warning=>/incomplete|truncated|secure/i.test(warning)),'Complete non-secure disposable AX tree');
    return data;
  };
  const node=(state,role,label)=>{
    const rows=state.tree.filter(row=>row.role===role&&(row.title===label||row.description===label));check(rows.length===1&&rows[0].enabled!==false,`Unique enabled fixture ${label}`);return rows[0];
  };
  const act=async(state,element,action,extra={})=>{
    await scope(`before-${action}`);snapshot(state);
    if(action==='click')check(element.actions?.includes('AXPress'),'Click preflight advertises AXPress; no fallback allowed');
    check(['setValue','selectText','click'].includes(action),'Only hard-limited semantic action names');
    const response=await request('action',{...target(),snapshotId:state.snapshotId,elementRef:element.ref,action,mode:'preserve',...extra},action==='selectText');
    if(response.error){
      // An unsupported selection with no dispatch is an optional skip, not a retry.
      if(action==='selectText'&&response.error.code==='unsupported'&&!response.error.details?.dispatched){evidence.selection={skipped:true,reason:'AXSelectedTextRange not settable'};await scope('after-unsupported-selectText');return null}
      throw new Error(`Semantic action failed (${response.error.code}); no retry`);
    }
    check(response.result.dispatch?.route==='accessibility','Native confirms accessibility route, never raw/private');
    if(action!=='click')check(response.result.dispatch.verified===true,`${action}: native AX read-back verified`);
    const fresh=snapshot(response.result.snapshot);await scope(`after-${action}`);const display=(await request('status')).result.overlayDiagnostics;evidence.overlayDiagnostics??=[];evidence.overlayDiagnostics.push({action,display});return fresh;
  };
  try{
    evidence.scope.fixtureExecutable=await realpath(selectedFixture);evidence.scope.helperExecutable=await realpath(selectedHelper);
    check(evidence.scope.fixtureExecutable.startsWith(canonicalRoot+path.sep),'Fixture executable is inside this package');
    const cache=path.join(directory,'module-cache');await mkdir(cache);probeBinary=path.join(directory,'fixture-desktop-probe');
    await execute('/usr/bin/xcrun',['swiftc','-swift-version','5','-module-cache-path',cache,'-framework','AppKit','-framework','ApplicationServices',path.join(root,'scripts/fixture-desktop-probe.swift'),'-o',probeBinary],{timeout:45000,maxBuffer:1024*1024});
    baseline=await metadata('before-helper-and-fixture-launch');check(baseline.fixtures.length===0,'No pre-existing fixture instance: never touches someone else’s fixture');
    check(!interrupted,'No interruption before helper launch');helper=new JSONChild(evidence.scope.helperExecutable);const ready=await helper.wait(message=>message.event==='ready');
    check(ready.data.protocol===1&&ready.data.paused===true&&ready.data.permissions?.accessibility===true,'Installed helper starts paused with existing AX authorization');
    check(ready.data.privateInput?.enabled===false,'Experimental private input remains disabled');preserve(await metadata('after-helper-launch'),'after-helper-launch');
    check(!interrupted,'No interruption before fixture launch');fixture=new JSONChild(evidence.scope.fixtureExecutable);evidence.scope.fixturePID=fixture.child.pid;
    const fixtureReady=await fixture.wait(message=>message.event==='ready');check(fixtureReady.data.disposable===true&&fixtureReady.data.bundleId===bundleId&&fixtureReady.data.pid===fixture.child.pid,'Fixture stdout proves disposable exact child identity');
    const initial=(await fixture.wait(message=>message.event==='fixture')).data;check(initial.clicks===0&&initial.text===''&&initial.drags===0,'Independent fixture starts empty with no clicks/drags');evidence.initialFixture=initial;
    await scope('after-fixture-launch');await request('resume',{userInitiated:true});
    let discovery;
    for(let attempt=0;attempt<6;attempt++){
      discovery=await request('windows.list',{bundleId,deniedOrigins:[origin]},true);
      if(discovery.result?.windows?.length)break;
      if(discovery.result?.discovery?.rejected?.some(code=>!['window_identity_unmatched','window_geometry_unavailable'].includes(code)))break;
      if(discovery.error && discovery.error.code!=='window_discovery_unavailable')throw new Error('Window discovery refused: '+discovery.error.code);
      if(attempt<5)await new Promise(resolve=>setTimeout(resolve,150));
    }
    const found=(await request('apps.find',{query:bundleId})).result.apps;
    check(Array.isArray(found)&&found.some(app=>app.bundleId===bundleId&&app.pid===fixture.child.pid),'Installed/running app discovery resolves the exact owned fixture');
    const windows=discovery.result?.windows;
    check(Array.isArray(windows)&&windows.length===1&&windows[0].pid===fixture.child.pid&&Number.isInteger(windows[0].windowId)&&windows[0].windowId>0,'Authorized helper identifies one exact owned fixture window');
    windowId=windows[0].windowId;
    let state=snapshot((await request('observe',{...target(),maxNodes:2000,maxDepth:64})).result);
    const consumed=state;const sample='验收：中文🙂 — 仅临时数据';
    state=await act(state,node(state,'AXTextField','Fixture Text'),'setValue',{value:sample});
    check(node(state,'AXTextField','Fixture Text').value===sample,'Fresh AX snapshot independently contains exact Chinese and emoji value');
    const stale=await request('revalidate',{...target(),snapshotId:consumed.snapshotId,elementRef:node(consumed,'AXTextField','Fixture Text').ref},true);
    check(stale.error?.code==='stale_snapshot','Consumed observation is one-shot (read-only stale revalidation rejects)');
    const mark=fixture.messages.length;state=await act(state,node(state,'AXButton','Fixture Count'),'click',{count:1,button:'left'});
    const oracle=(await fixture.wait(message=>message.event==='fixture'&&message.data?.clicks===1,mark)).data;
    check(oracle.text===sample&&oracle.clicks===1&&oracle.drags===0&&oracle.scrollY===initial.scrollY,'Independent fixture stdout confirms exact text, one AXPress, no drag/scroll');evidence.oracle=oracle;
    const selected=await act(state,node(state,'AXTextField','Fixture Text'),'selectText',{text:'中文🙂',prefix:'验收：',suffix:' — 仅临时数据'});
    if(selected){state=selected;evidence.selection={verified:true,verification:'Native AXSelectedTextRange read-back; fixture has no independent selection oracle'};check(node(state,'AXTextField','Fixture Text').value===sample,'Selection leaves document value unchanged')}
    if(opts.capture){
    const captureResult=(await request('observe',{...target(),maxNodes:2000,maxDepth:64,screenshot:true,ocr:true})).result;
    snapshot(captureResult);
    check(captureResult.image?.mediaType==='image/png'&&Number.isInteger(captureResult.image.width)&&Number.isInteger(captureResult.image.height),'Window screenshot has bounded PNG metadata');
    const png=Buffer.from(captureResult.image.base64,'base64');
    check(png.subarray(0,8).toString('hex')==='89504e470d0a1a0a','Screenshot decodes to a real PNG');
    await writeFile(path.join(directory,'owned-fixture.png'),png);
    check(Array.isArray(captureResult.ocr)&&captureResult.ocr.length>0,'Native OCR returned text from the disposable window');
    evidence.capture={verified:true,width:captureResult.image.width,height:captureResult.image.height,ocrRows:captureResult.ocr.length,file:'owned-fixture.png'};
    }
    evidence.overlay={observedSamples:evidence.desktop.filter(x=>x.ownedOverlayWindows?.length).map(x=>({label:x.label,windows:x.ownedOverlayWindows})),visualAcceptance:false,clickThroughVerified:false};
    await request('pause');const refused=await request('observe',{...target(),maxNodes:2000,maxDepth:64},true);check(refused.error?.code==='paused','Paused helper refuses fixture observation without side effects');
    await scope('after-pause');evidence.outcome='passed';
  }catch(error){evidence.failure={message:error.message,interrupted};helper?.pauseNow();process.exitCode=1}
  finally{
    clearTimeout(deadline);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
    try{await helper?.dispose();evidence.cleanup.helperDisposed=!alive(helper?.child)}catch{evidence.cleanup.helperDisposed=false;await terminateOwned(helper?.child)}
    try{await terminateOwned(fixture?.child);evidence.cleanup.ownedFixtureTerminated=!alive(fixture?.child)}catch{evidence.cleanup.ownedFixtureTerminated=false}
    if(probeBinary&&baseline)try{const final=await metadata('after-owned-child-cleanup');preserve(final,'after-owned-child-cleanup')}catch(error){evidence.cleanup.desktopCheckFailure=error.message;evidence.outcome='failed';process.exitCode=1}
    if(evidence.cleanup.helperDisposed===false||evidence.cleanup.ownedFixtureTerminated===false){evidence.outcome='failed';process.exitCode=1}
    evidence.finishedAt=new Date().toISOString();await writeFile(evidencePath,JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({outcome:evidence.outcome,evidence:evidencePath,checks:evidence.checks.length,noRawInput:true,noPermissionRequests:true}));
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const opts=options(process.argv.slice(2));if(opts.help||!opts.run)console.log(usage);else await run(opts)}catch(error){console.error(`Fixture acceptance refused: ${error.message}`);process.exitCode=1}
}
