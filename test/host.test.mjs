import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Coordinator, approvalSummary, publicError } from '../lib/coordinator.js';
import { CommandChannel, Config, readConfig, mergePublishedResponse } from '../lib/config.js';
import { registerTools, renderOutput } from '../index.js';

const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const exec = (agentId = 'agent-a', signal) => ({ name: 'whale_action', callId: 'call-1', agent: { id: agentId, session: { id: 'session-1' } }, signal });
const target = 'com.apple.TextEdit';
class FakeNative extends EventEmitter {
  calls = []; connected = true; count = 0; pauseCount = 0;
  snapshot(bundleId = target) { return { snapshotId: `snapshot-${++this.count}`, observedAt: Date.now(), bundleId, tree: [{ ref: 'node-1', role: 'AXButton', enabled: true }] }; }
  pauseNow() { this.pauseCount++; queueMicrotask(() => this.emit('paused', { reason: 'requested' })); }
  async request(method, params, options) { this.calls.push({ method, params, options }); if (method === 'observe') return this.snapshot(params.bundleId); if (method === 'action') return { dispatch: { sent: true, verified: false }, snapshot: this.snapshot(params.bundleId) }; return { paused: method !== 'resume', permissions: { accessibility: true, screenCapture: false } }; }
  async dispose() {}
}
function fixture({ approval, native = new FakeNative(), browser, now, getConfig, getDeniedOrigins } = {}) {
  const config = { enabled: true, mode: 'preserve', screenshots: false, browserEndpoint: 'http://127.0.0.1:9222' };
  const asks = [];
  const co = new Coordinator({ native, approval: { request: async request => { asks.push(request); return approval ? approval(request) : 'allowed-once'; } }, createBrowser: () => browser, getWorkspace: async () => '/workspace', getConfig: getConfig ?? (() => config), ...(now ? { now } : {}), ...(getDeniedOrigins ? { getDeniedOrigins } : {}), deniedOrigins: ['http://127.0.0.1:59721'] });
  return { co, native, config, asks };
}
test('real SDK Config defaults to standby, automatic route and no screenshots', () => {
  const defaults = readConfig(Config({})); assert.equal(defaults.enabled, true); assert.equal(defaults.mode, 'auto'); assert.equal(defaults.screenshots, false);
});
test('host entry actually imports and registers SDK tool definitions', () => {
  const tools = []; registerTools({ tools: { register: definition => { tools.push(definition); return () => {}; } } }, {});
  assert.ok(tools.some(tool=>tool.name==='whale_verify_video'));
  assert.ok(tools.some(tool=>tool.name==='whale_ax_press'));
  assert.ok(tools.some(tool=>tool.name==='whale_follow_video'));
  assert.ok(tools.some(tool=>tool.name==='whale_resume_video'));
  assert.equal(tools.length, 20); assert.equal(new Set(tools.map(t => t.name)).size, 20);
  assert.ok(tools.every(t => t.parameters && typeof t.execute === 'function'));
  const rendered = renderOutput({}, { snapshot: { tree: [] }, imageAttachment: { id: 'attachment-1' } });
  assert.equal(rendered[1].type, 'image'); assert.equal(rendered[0].text.includes('attachment-1'), false);
});
test('coordinator construction never starts native before loading the profile intent', async () => {
  const { co, native } = fixture(); assert.equal(co.status().paused, true); assert.equal(native.calls.length, 0);
  await assert.rejects(co.observe({ bundleId: target }, exec()), { code: 'paused' }); assert.equal(native.calls.length, 0);
});
const validCursor = () => ({ schema: 1, kind: 'software-overlay', visibility: 'target-window', independentNativePointer: false, runtimeValidated: false });
const reportedCursor = () => ({ ...validCursor(), source: 'helper-self-report' });
test('native ready cursor is a conservative whitelisted self-report, never raw capabilities', () => {
  const { co, native, config } = fixture();
  config.cursor = validCursor(); config.capabilities = { overlay: true };
  assert.equal(co.status().cursor, null);
  native.emit('ready', { capabilities: { overlay: true } }); assert.equal(co.status().cursor, null);
  const raw = { ...validCursor(), source: 'verified', secret: 'private-raw-field', independent: true };
  native.emit('ready', { cursor: raw, permissions: { forged: true } });
  assert.deepEqual(co.status().cursor, reportedCursor()); assert.equal(co.status().permissions, null);
  assert.equal(JSON.stringify(co.status()).includes('private-raw-field'), false);
  raw.kind = 'mutated'; assert.deepEqual(co.status().cursor, reportedCursor());
  assert.ok(Object.isFrozen(co.status().cursor)); assert.equal(native.calls.length, 0);
});
test('settings show permission booleans from the current native connection only', () => {
  const { co, native } = fixture();
  native.emit('ready', {permissions:{accessibility:true,screenCapture:false,inputMonitoring:'yes',extra:true}});
  assert.deepEqual(co.status().permissions,{accessibility:true,screenCapture:false});
  native.emit('disconnect'); assert.equal(co.status().permissions,null);
});
test('ready and trusted diagnose reject unknown, missing and malformed cursor descriptors', async () => {
  const invalid = [undefined, null, false, true, 1, 'software-overlay', [],
    { ...validCursor(), schema: '1' }, { ...validCursor(), schema: 2 },
    { ...validCursor(), kind: 'native-pointer' }, { ...validCursor(), visibility: 'global' }];
  for (const field of Object.keys(validCursor())) {
    const missing = validCursor(); delete missing[field]; invalid.push(missing);
  }
  for (const field of ['independentNativePointer', 'runtimeValidated']) {
    for (const value of [true, 0, 1, '', 'false', null, undefined]) invalid.push({ ...validCursor(), [field]: value });
  }
  const { co, native } = fixture();
  for (const cursor of invalid) {
    native.emit('ready', { cursor: validCursor() });
    native.emit('ready', { cursor }); assert.equal(co.status().cursor, null);
    native.emit('ready', { cursor: validCursor() });
    native.request = async () => ({ cursor, capabilities: { overlay: true } });
    assert.equal((await co.userCommand('diagnose')).cursor, null); assert.equal(co.status().cursor, null);
  }
});
test('diagnose uses only trusted status cursor and preserves permission and pause behavior', async () => {
  const { co, native } = fixture();
  native.emit('status', { cursor: validCursor() }); assert.equal(co.status().cursor, null);
  native.request = async (method, params) => {
    assert.equal(method, 'status'); assert.deepEqual(params, {});
    return { cursor: { ...validCursor(), secret: 'status-private-raw', source: 'runtime-verified' }, capabilities: { overlay: true }, permissions: { accessibility: true }, privateInput: { enabled: false }, paused: false };
  };
  const result = await co.userCommand('diagnose', { cursor: { ...validCursor(), runtimeValidated: true } });
  assert.deepEqual(result.cursor, reportedCursor()); assert.deepEqual(co.status().cursor, reportedCursor());
  assert.equal(JSON.stringify([result, co.status()]).includes('status-private-raw'), false);
  assert.deepEqual(result.permissions, { accessibility: true }); assert.deepEqual(result.capabilities, { overlay: true });
  assert.deepEqual(co.status().privateInput, { enabled: false }); assert.equal(result.nativePaused, false); assert.equal(co.status().paused, true);
  native.request = async () => ({ capabilities: { overlay: true } });
  assert.equal((await co.userCommand('diagnose', { cursor: validCursor() })).cursor, null);
  assert.equal(co.status().cursor, null);
});
test('cursor is exposed only for strict connected true and cleared across disconnect and missing ready', async () => {
  const { co, native } = fixture();
  for (const connected of [false, undefined, null, 0, 1, 'true']) {
    native.connected = connected; native.emit('ready', { cursor: validCursor() });
    assert.equal(co.status().nativeConnected, false); assert.equal(co.status().cursor, null);
    native.request = async () => ({ cursor: validCursor() });
    assert.equal((await co.userCommand('diagnose')).cursor, null);
  }
  native.connected = true; native.emit('ready', { cursor: validCursor() }); assert.deepEqual(co.status().cursor, reportedCursor());
  native.connected = false; native.emit('disconnect'); assert.equal(co.status().cursor, null); assert.equal(co.status().paused, true);
  native.connected = true; assert.equal(co.status().cursor, null);
  native.emit('ready', { capabilities: { overlay: true } }); assert.equal(co.status().cursor, null);
  native.emit('ready', { cursor: validCursor() }); assert.deepEqual(co.status().cursor, reportedCursor());
  native.emit('ready'); assert.equal(co.status().cursor, null);
  native.emit('ready', { cursor: validCursor() }); assert.deepEqual(co.status().cursor, reportedCursor());
});
test('late diagnose from a disconnected generation cannot restore or overwrite cursor on reconnect', async () => {
  const { co, native } = fixture(); const gate = defer();
  native.emit('ready', { cursor: validCursor() }); native.request = async () => gate.promise;
  const pending = co.userCommand('diagnose'); native.connected = false; native.emit('disconnect');
  native.connected = true; native.emit('ready', {}); gate.resolve({ cursor: validCursor() });
  assert.equal((await pending).cursor, null); assert.equal(co.status().cursor, null);
  const secondGate = defer(); native.request = async () => secondGate.promise;
  const second = co.userCommand('diagnose'); native.connected = false; native.emit('disconnect');
  native.connected = true; native.emit('ready', { cursor: validCursor() }); secondGate.resolve({});
  assert.deepEqual((await second).cursor, reportedCursor()); assert.deepEqual(co.status().cursor, reportedCursor());
});
test('asynchronous requested pause ack cannot cancel trusted resume or echo', async () => {
  const { co, native } = fixture(); await co.userCommand('resume'); await Promise.resolve();
  assert.equal(co.status().paused, false); assert.equal(native.pauseCount, 1);
  native.emit('paused', { reason: 'human_input' }); assert.equal(co.status().paused, true); assert.equal(native.pauseCount, 1);
});
test('read approval precedes observation, actions approve once and preserve mode is host-owned', async () => {
  const { co, native, asks } = fixture(); await co.userCommand('resume');
  const { snapshot } = await co.observe({ bundleId: target }, exec()); assert.equal(asks.length, 1);
  const result = await co.action({ bundleId: target, snapshotId: snapshot.snapshotId, action: 'click', elementRef: 'node-1', mode: 'foreground' }, exec());
  assert.equal(asks.length, 2); assert.ok(asks[1].reason.includes('node-1')); assert.ok(asks[1].reason.includes('Expand the original tool call'));
  const dispatched = native.calls.find(call => call.method === 'action'); assert.equal(dispatched.params.mode, 'auto'); assert.equal(dispatched.params.foregroundApproved, undefined);
  assert.deepEqual(dispatched.params.deniedOrigins, ['http://127.0.0.1:59721']); assert.equal(result.dispatch.verified, false);
  await assert.rejects(co.action({ bundleId: target, snapshotId: snapshot.snapshotId, action: 'click', elementRef: 'node-1' }, exec()), { code: 'stale_snapshot' });
});
test('read deny/unavailable/cancelled never touches UI', async () => {
  for (const outcome of ['rejected', 'unavailable', 'cancelled', undefined]) {
    const { co, native } = fixture({ approval: () => outcome }); await co.userCommand('resume');
    await assert.rejects(co.observe({ bundleId: target }, exec())); assert.equal(native.calls.some(call => call.method === 'observe'), false);
  }
});
test('snapshot cannot cross agent and approval is still required per action', async () => {
  const { co, native, asks } = fixture(); await co.userCommand('resume');
  const { snapshot } = await co.observe({ bundleId: target }, exec());
  await assert.rejects(co.action({ bundleId: target, snapshotId: snapshot.snapshotId, action: 'click', elementRef: 'node-1' }, exec('agent-b')), { code: 'stale_snapshot' });
  assert.equal(asks.length, 1); assert.equal(native.calls.some(call => call.method === 'action'), false);
});
test('pause during approval invalidates approval result and prevents dispatch', async () => {
  const gate = defer(); let calls = 0; const { co, native } = fixture({ approval: () => ++calls === 1 ? 'allowed-once' : gate.promise });
  await co.userCommand('resume'); const { snapshot } = await co.observe({ bundleId: target }, exec());
  const pending = co.action({ bundleId: target, snapshotId: snapshot.snapshotId, action: 'click', elementRef: 'node-1' }, exec());
  await new Promise(resolve => setImmediate(resolve)); co.pause('user'); gate.resolve('allowed-once');
  await assert.rejects(pending); assert.equal(native.calls.some(call => call.method === 'action'), false); assert.equal(co.status().paused, true);
});
test('late native resume cannot override a newer stop', async () => {
  const native = new FakeNative(); const gate = defer();
  native.request = async method => method === 'resume' ? gate.promise : {};
  const { co } = fixture({ native }); const resumed = co.userCommand('resume');
  await new Promise(resolve => setImmediate(resolve)); co.pause('newer-user-stop'); gate.resolve({ paused: false });
  await assert.rejects(resumed, { code: 'state_changed' }); assert.equal(co.status().paused, true); assert.ok(native.pauseCount >= 2);
});
test('screenshot requires setting and authority flags are rejected before action', async () => {
  const { co, native } = fixture(); await co.userCommand('resume');
  await assert.rejects(co.observe({ bundleId: target, screenshot: true }, exec()), { code: 'screenshots_disabled' });
  assert.equal(native.calls.some(call => call.method === 'observe'), false);
  await assert.rejects(co.action({ bundleId: target, action: 'press', key: 'Enter', userInitiated: true }, exec()), { code: 'invalid_action' });
});
test('OCR cannot bypass disabled pixel capture even with screenshot=false', async () => {
  const { co, native } = fixture(); await co.userCommand('resume');
  await assert.rejects(co.observe({ bundleId: target, screenshot: false, ocr: true }, exec()), { code: 'screenshots_disabled' });
  assert.equal(native.calls.some(call => call.method === 'observe'), false);
});
test('changed control origin pauses desktop-only sessions and invalidates previous snapshots', async () => {
  let origin = 'http://127.0.0.1:59721'; const { co, native } = fixture({ getDeniedOrigins: () => [origin] });
  await co.userCommand('resume'); const { snapshot } = await co.observe({ bundleId: target }, exec()); origin = 'http://127.0.0.1:60077';
  await assert.rejects(co.action({ bundleId: target, snapshotId: snapshot.snapshotId, action: 'click', elementRef: 'node-1' }, exec()), { code: 'control_origin_changed' });
  assert.equal(co.status().paused, true); assert.equal(native.calls.some(call => call.method === 'action'), false);
  await co.userCommand('resume'); await assert.rejects(co.action({ bundleId: target, snapshotId: snapshot.snapshotId, action: 'click', elementRef: 'node-1' }, exec()), { code: 'stale_snapshot' });
});
test('missing/invalid trusted origin pauses, clears browser connections and requires explicit resume', async () => {
  for (const invalid of [[], ['not-an-origin'], null, 'throw']) {
    let value = ['http://127.0.0.1:59721']; let disconnected = 0;
    const browser = { status: () => ({ connected: true }), listTabs: async () => [], disconnect: async () => { disconnected++; } };
    const { co } = fixture({ browser, getDeniedOrigins: () => { if (value === 'throw') throw new Error('missing service'); return value; } });
    await co.userCommand('resume'); await co.browser({ operation: 'tabs' }, exec()); assert.equal(co.status().browserConnections, 1);
    value = invalid; await assert.rejects(co.apps(exec()), { code: 'control_origin_unavailable' }); assert.equal(co.status().paused, true); assert.equal(co.status().browserConnections, 0); assert.equal(disconnected, 1);
    value = ['http://127.0.0.1:59721']; await assert.rejects(co.apps(exec()), { code: 'paused' });
  }
});
test('approval delay past snapshot TTL never dispatches and explicitly asks for fresh observation', async () => {
  let now = Date.now(); let calls = 0; const gate = defer();
  const { co, native } = fixture({ now: () => now, approval: () => ++calls === 1 ? 'allowed-once' : gate.promise });
  await co.userCommand('resume'); const { snapshot } = await co.observe({ bundleId: target }, exec());
  const pending = co.action({ bundleId: target, snapshotId: snapshot.snapshotId, action: 'click', elementRef: 'node-1' }, exec());
  await new Promise(resolve => setImmediate(resolve)); now += 16_000; gate.resolve('allowed-once');
  await assert.rejects(pending, error => error.code === 'stale_snapshot' && /Observe/.test(error.message)); assert.equal(native.calls.some(call => call.method === 'action'), false);
});
test('experimental private input defaults off and only trusted resume applies user preference', async () => {
  const { co, native, config } = fixture(); await co.userCommand('resume');
  assert.deepEqual(native.calls.find(call => call.method === 'input.configure').params, { userInitiated: true, privateSkyLight: false });
  config.privateSkyLight = true; await co.configureChanged(); await co.userCommand('resume');
  assert.deepEqual(native.calls.filter(call => call.method === 'input.configure').at(-1).params, { userInitiated: true, privateSkyLight: true });
});
test('post-dispatch failure survives tool rendering as mayHaveDispatched and never encourages replay', async () => {
  const { co, native } = fixture(); await co.userCommand('resume'); const { snapshot } = await co.observe({ bundleId: target }, exec());
  const original = native.request.bind(native); let sideEffects = 0;
  native.request = async (method, ...args) => { if (method === 'action') { sideEffects++; throw new Error('private-backend-content'); } return original(method, ...args); };
  const tools = []; registerTools({ tools: { register: tool => { tools.push(tool); } } }, co);
  const output = await tools.find(tool => tool.name === 'whale_action').execute({ bundleId: target, snapshotId: snapshot.snapshotId, action: 'click', elementRef: 'node-1' }, exec());
  assert.equal(sideEffects, 1); assert.equal(output.mayHaveDispatched, true); assert.equal(output.requiresObservation, true); assert.equal(output.error.verified, false);
  assert.ok(output.error.message.includes('Do not replay')); assert.equal(JSON.stringify(output).includes('private-backend-content'), false);
  assert.equal(publicError({ code: 'test', details: { mayHaveDispatched: true, privateBody: 'secret' } }).mayHaveDispatched, true);
});
test('text approval summary binds digest without duplicating private typed text', () => {
  const summary = approvalSummary({ action: 'type', text: 'private-body\n', elementRef: 'node-1' }); assert.equal(summary.includes('private-body'), false); assert.ok(summary.includes('textCharacters')); assert.ok(summary.includes('textContainsNewline'));
  assert.throws(() => approvalSummary({ action: 'type', text: 'x'.repeat(2001) }), { code: 'text_too_long' });
});
test('command channel ignores startup, replay and foreign boot even after response tampering', async () => {
  const calls = []; const responses = []; const initial = JSON.stringify({ boot: 'old', nonce: 'initial-nonce-0001', op: 'resume' });
  const channel = new CommandChannel({ initialCommand: initial, execute: async op => calls.push(op), publish: async r => responses.push(r), boot: 'private-host-boot' });
  await channel.initialize(); await channel.submit(initial);
  await channel.submit(JSON.stringify({ boot: 'forged-response-boot', nonce: 'nonce-string-00001', op: 'resume' }));
  const valid = JSON.stringify({ boot: channel.boot, nonce: 'nonce-string-00002', op: 'pause' }); await channel.submit(valid); await channel.submit(valid);
  assert.deepEqual(calls, ['pause']); assert.equal(responses.at(-1).ackNonce, 'nonce-string-00002'); await channel.dispose();
});
test('Stop bypasses a pending permission and invalidates queued resume', async () => {
  const gate = defer(); const calls = []; const channel = new CommandChannel({ boot: 'boot', publish: async () => {}, execute: async op => { calls.push(op); if (op === 'permissions') await gate.promise; } });
  const command = (op, n) => channel.submit(JSON.stringify({ boot: 'boot', nonce: `command-nonce-000${n}`, op, kind: 'accessibility' }));
  const permission = command('permissions', 1); const resume = command('resume', 2); await new Promise(resolve => setImmediate(resolve));
  const stop = command('pause', 3); await stop; assert.deepEqual(calls, ['permissions', 'pause']); gate.resolve(); await Promise.all([permission, resume]);
  assert.equal(calls.includes('resume'), false); await channel.dispose();
});

test('new-tab navigation and app launch require current exact approval', async () => {
 let opened=0; const browser={status:()=>({connected:true}),openTab:async({url})=>{opened++;return{tabId:'owned-tab',url,requiresObservation:true}},disconnect:async()=>{}};
 const f=fixture({browser});await f.co.userCommand('resume');
 const result=await f.co.browser({operation:'open',url:'https://example.test/path'},exec());
 assert.equal(result.tabId,'owned-tab');assert.equal(opened,1);assert.ok(f.asks.some(a=>a.reason.includes('open one new browser tab')));
 const denied=fixture({browser,approval:()=> 'denied'});await denied.co.userCommand('resume');
 await assert.rejects(denied.co.browser({operation:'open',url:'https://example.test/path'},exec()),{code:'approval_denied'});assert.equal(opened,1);
 const prior=f.native.request.bind(f.native);f.native.request=async(method,params,options)=>method==='app.open'?{bundleId:params.bundleId,pid:123,running:true,opened:true,activationRequested:false}:prior(method,params,options);
 const app=await f.co.openApp({bundleId:'org.fixture.app'},exec());assert.equal(app.activationRequested,false);
 await assert.rejects(denied.co.openApp({bundleId:'org.fixture.app'},exec()),{code:'approval_denied'});
 await f.co.dispose();await denied.co.dispose();
});

test('late pre-stop completion cannot replace the newer stop acknowledgement', async()=>{
 const gate=defer(),responses=[];
 const channel=new CommandChannel({boot:'boot',publish:async r=>responses.push(r),execute:async op=>{if(op==='diagnose')await gate.promise}});
 const before=channel.submit(JSON.stringify({boot:'boot',nonce:'older-command-0001',op:'diagnose'}));
 await new Promise(r=>setImmediate(r));
 await channel.submit(JSON.stringify({boot:'boot',nonce:'newer-command-0002',op:'pause'}));
 gate.resolve();assert.equal(await before,false);
 assert.equal(responses.at(-1).ackNonce,'newer-command-0002');assert.equal(responses.length,1);
 await channel.dispose();
});
test('status refresh preserves latest command acknowledgement only within the current boot',()=>{
 const prior={boot:'a',ackNonce:'stop-ack',operation:'pause',outcome:'completed',status:{paused:false}};
 const status={boot:'a',ackNonce:null,outcome:'configuration-changed',status:{paused:true}};
 const result=mergePublishedResponse(prior,status);
 assert.equal(result.ackNonce,'stop-ack');assert.equal(result.outcome,'completed');assert.equal(result.status.paused,true);
 assert.equal(mergePublishedResponse(prior,{...status,boot:'b'}).ackNonce,null);
 assert.equal(mergePublishedResponse(prior,{...status,ackNonce:'next-ack',outcome:'failed'}).outcome,'failed');
});

test('named click resolves only one complete, enabled AX press in the selected window', async () => {
  const {co,native}=fixture();
  await co.userCommand('resume');
  const node={role:'AXButton',title:'海洋',enabled:true,actions:['AXPress'],ref:'live-ref'};
  let tree=[node],complete=true,count=0;
  native.snapshot=()=>({bundleId:target,windowId:42,snapshotId:'fresh-'+(++count),
    observedAt:Date.now(),treeComplete:complete,tree});
  const click=()=>co.clickButton({bundleId:target,windowId:42,name:'海洋'},exec());
  await click();
  const inputs=()=>native.calls.filter(call=>call.method==='action');
  assert.equal(inputs().length,1);assert.equal(inputs()[0].params.elementRef,'live-ref');
  tree=[node,{...node,ref:'another'}];await assert.rejects(click,{code:'ambiguous_button'});
  tree=[];await assert.rejects(click,{code:'button_not_found'});
  tree=[{...node,enabled:false}];await assert.rejects(click,{code:'unsupported'});
  complete=false;await assert.rejects(click,{code:'incomplete_observation'});
  assert.equal(inputs().length,1);
});
test('an acknowledged pre-dispatch rejection does not get reported as an uncertain click', async () => {
  const {co,native}=fixture();await co.userCommand('resume');
  const {snapshot}=await co.observe({bundleId:target},exec());
  const original=native.request.bind(native);
  native.request=async(method,...args)=>{
    if(method==='action')throw Object.assign(new Error('fixture'),{code:'stale_snapshot',details:{notDispatched:true}});
    return original(method,...args);
  };
  await assert.rejects(co.action({bundleId:target,action:'click',snapshotId:snapshot.snapshotId,elementRef:'node-1'},exec()),
    error=>error.code==='stale_snapshot' && error.details.notDispatched===true && !error.details.mayHaveDispatched);
});

test('native radio observation uses the existing helper and only returns matching controls',async()=>{
  const {co,native}=fixture();
  native.snapshot=()=>({snapshotId:'tabs',observedAt:Date.now(),windowId:5,tree:[{role:'AXRadioButton',ref:'tab'},{role:'AXButton',ref:'button'}]});
  try {
    await co.userCommand('resume');
    const r=await co.observe({bundleId:target,windowId:5,role:'AXRadioButton'},exec());
    assert.deepEqual(r.snapshot.tree,[{role:'AXRadioButton',ref:'tab'}]);
    assert.equal(native.calls.find(r=>r.method==='observe').params.role,undefined);
  } finally {await co.dispose()}
});
test('an unready hidden play is observed on the exact lease without dispatching twice',async()=>{
  const {co}=fixture();const calls=[];let serial=0;const url='https://example.org/movie';
  co.extensionBridge={connected:true,serial:1,clearIndicators(){},async dispose(){},async request(op){
    calls.push(op);
    if(op==='meta')return {tabId:'8',url,active:false};
    if(op==='observe')return {url,snapshotId:'m'+(++serial),observedAt:Date.now(),visibility:'hidden',tree:[],videos:[{readyState:0,paused:false,ended:false}]};
    if(op==='play')throw Object.assign(Error('pending play'),{code:'extension_refused'});
  }};
  try {
    await co.userCommand('resume');
    const initial=await co.extension({operation:'observe'},exec());
    const result=await co.extension({operation:'play',muted:true,snapshotId:initial.snapshot.snapshotId,ref:'1'},exec());
    assert.equal(result.verified,false);assert.equal(result.doNotReplay,true);
    assert.equal(result.playbackState,'waiting_for_media');assert.equal(calls.filter(x=>x==='play').length,1);
  } finally {await co.dispose()}
});

test('silent background resume requires an unselected tab muted by DSH',async()=>{
  const {co}=fixture(),url='https://www.bilibili.com/video/BVFixture/';
  const route={operation:'resumePlayback',url,tabId:'5',useTaskTabMute:true};
  let meta;
  co.extensionBridge={connected:true,serial:1,clearIndicators(){},async dispose(){},async request(op){
    assert.equal(op,'meta','refused requests send no media input');return {url,tabId:'5',...meta};
  }};
  try{
    await co.userCommand('resume');
    for(meta of [{active:true,taskTabOwnsMute:true},{active:false,taskTabOwnsMute:false},{active:false}]){
      await assert.rejects(co.extension(route,exec()),e=>e.code==='task_mute_unavailable');
    }
  }finally{await co.dispose()}
});
test('resume rejects a different task and a replaced player before sending play',async()=>{
  const {co}=fixture(),calls=[];
  const url='https://example.org/clip',route={operation:'resumePlayback',url,tabId:'5'};
  let reads=0;
  co.extensionBridge={serial:1,connected:true,clearIndicators(){},async dispose(){},async request(op){
    calls.push(op);
    if(op==='meta')return {url,tabId:'5',active:false};
    if(op==='observe'){
      const id=String(++reads);
      return {url,snapshotId:id,observedAt:Date.now(),tree:[{role:'video',ref:'1'}],
        videos:[{playerId:id,paused:true,readyState:4}]};
    }
    throw Error('Unexpected media input: '+op);
  }};
  try{
    await co.userCommand('resume');
    await assert.rejects(co.extension({...route,tabId:'6'},exec()),e=>e.code==='stale_video');
    await assert.rejects(co.extension({...route,url:url+'-changed'},exec()),e=>e.code==='stale_video');
    assert.equal(reads,0);
    await assert.rejects(co.extension(route,exec()),e=>e.code==='stale_video');
    assert.equal(reads,2);
    assert.ok(!calls.includes('play'));
  }finally{await co.dispose()}
});

test('play returns a fresh tab observation after a pending or indeterminate extension reply',async()=>{
  for(const message of ['播放器未响应','Unexpected media reply']){
    const {co}=fixture(),url='https://example.org/movie';
    let observations=0,plays=0;
    co.extensionBridge={connected:true,serial:1,clearIndicators(){},async dispose(){},async request(op){
      if(op==='meta')return {url,tabId:'8',active:false};
      if(op==='observe')return {url,snapshotId:String(++observations),observedAt:Date.now(),visibility:'visible',
        tree:[{role:'video',ref:'1'}],videos:[{playerId:'fixture-film',readyState:1,paused:plays===0,ended:false}]};
      assert.equal(op,'play');plays++;
      throw Object.assign(Error(message),{code:'extension_refused',details:{notDispatched:false}});
    }};
    try{
      await co.userCommand('resume');
      const initial=await co.extension({operation:'observe'},exec());
      const result=await co.extension({operation:'play',ref:'1',snapshotId:initial.snapshot.snapshotId},exec());
      assert.equal(plays,1);assert.equal(observations,2);
      assert.equal(result.snapshot.snapshotId,'2');assert.equal(result.verified,false);
      assert.equal(result.doNotReplay,true);assert.deepEqual(result,JSON.parse(JSON.stringify(result)));
      if(message==='播放器未响应'){
        assert.equal(result.playRequest,'pending');assert.equal(result.playbackState,'waiting_for_media');
      }else{
        assert.equal(result.error.code,'extension_refused');assert.equal(result.mayHaveDispatched,true);
        assert.equal(result.playRequest,'outcome_unknown');
      }
    }finally{await co.dispose()}
  }
});

test('a follow-up reads only the authorized tab and stops on pause',async()=>{
  const {co}=fixture(),calls=[];const url='https://www.bilibili.com/video/BV1Example/';
  let finishRead;let id=0;
  co.extensionBridge={serial:9,connected:true,clearIndicators(){},async dispose(){},async request(op,args,signal){
    calls.push(op);
    if(op==='meta')return {url,tabId:'5',active:false};
    if(op==='observe')return {url,snapshotId:'v'+(++id),observedAt:Date.now(),videos:[{readyState:0}],tree:[]};
    assert.equal(op,'verifyPlayback');assert.deepEqual(args,{url,tabId:'5'});
    return new Promise(resolve=>{finishRead=()=>resolve({url,verified:false,from:0,to:0,tabActive:false})});
  }};
  try {
    await co.userCommand('resume');
    const first=await co.extension({operation:'followPlayback'},exec());
    for(let i=0;i<60 && !finishRead;i++)await new Promise(r=>setTimeout(r,2));
    assert.ok(finishRead);
    const again=await co.extension({operation:'followPlayback'},exec());
    assert.equal(first.followUp.id,again.followUp.id);
    await assert.rejects(co.extension({operation:'followPlayback'},exec('other-agent')),e=>e.code==='followup_busy');
    co.pause();finishRead();await new Promise(r=>setTimeout(r,4));
    assert.equal(calls.filter(op=>op==='verifyPlayback').length,1);
    assert.ok(!calls.includes('play'));
  } finally {await co.dispose()}
});
test('a legacy shared player can be verified while its follow-up is active without returning undefined JSON fields',async()=>{
  const {co}=fixture(),url='https://example.org/clip';let reads=0;
  co.extensionBridge={connected:true,serial:1,clearIndicators(){},async dispose(){},async request(op){
    if(op==='meta')return {url,tabId:'5',active:false};
    if(op==='observe')return {url,snapshotId:String(++reads),observedAt:Date.now(),tree:[],videos:[{readyState:0}]};
    assert.equal(op,'verifyPlayback');
    return {url,from:0,to:0,verified:false,paused:false,muted:true,visibility:'hidden',tabActive:false};
  }};
  try {
    await co.userCommand('resume');
    await co.extension({operation:'followPlayback'},exec());
    const result=await co.extension({operation:'verifyPlayback'},exec());
    assert.ok(result.followUp.latest);
    assert.deepEqual(result,JSON.parse(JSON.stringify(result)));
    assert.equal(Object.hasOwn(result.followUp.latest,'silenceVerified'),false);
    assert.equal(result.followUp.latest.verified,false);
  }finally{await co.dispose()}
});

test('a deferred Bilibili watch arms a live follow-up and can later confirm without replaying',async()=>{
  const {co}=fixture();const home='https://www.bilibili.com/',video=home+'video/BV123/';
  let url=home,playCalls=0,reads=0,snapshot=0;
  co.extensionBridge={connected:true,serial:8,clearIndicators(){},async dispose(){},async request(op,args){
    switch(op){
      case 'meta': return {url,tabId:'42',active:false};
      case 'navigate': url=args.destination;return {requiresObservation:true};
      case 'follow': url=video;return {requiresObservation:true};
      case 'observe':
        return {url,visibility:'hidden',snapshotId:String(++snapshot),observedAt:Date.now(),title:'海獭',
          tree:url===video?[{role:'video',ref:'v'}]:[{role:'link',ref:'link',href:video,title:'海獭'}],
          videos:url===video?[{paused:false,muted:true,readyState:playCalls?0:3}]:[]};
      case 'play': playCalls++;return {dispatched:true};
      case 'verifyPlayback': {
        const started=++reads>1;
        return {url,tabActive:false,visibility:'hidden',muted:true,paused:false,verified:started,from:0,to:started?2.2:0};
      }
      default: throw Error(op);
    }
  }};
  try {
    await co.userCommand('resume');
    const cold=await co.watchVideo({query:'海獭'},exec());
    assert.equal(cold.verified,false);assert.equal(cold.followUp.status,'checking');
    for(let i=0;i<65 && reads<2;i++)await new Promise(r=>setTimeout(r,3));
    const resumed=await co.extension({operation:'followPlayback'},exec());
    assert.equal(resumed.followUp.id,cold.followUp.id);assert.equal(resumed.followUp.background.to,2.2);
    assert.equal(playCalls,1);
  } finally {await co.dispose()}
});

test('zero placeholder discovers one window; ambiguous windows return choices without observation',async()=>{
  const {co,native}=fixture();await co.userCommand('resume');
  let windows=[{windowId:132001}];const observed=[];const request=native.request.bind(native);
  native.request=async(method,p,opts)=>{if(method==='windows.list')return {windows};if(method==='observe')observed.push(p.windowId);return request(method,p,opts)};
  try{await co.observe({bundleId:target,windowId:0,role:'AXTextField'},exec());windows=[...windows,{windowId:2}];
    assert.equal((await co.observe({bundleId:target,windowId:0},exec())).windows.length,2);assert.deepEqual(observed,[132001]);}
  finally{await co.dispose()}
});
