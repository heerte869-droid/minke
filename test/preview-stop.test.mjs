import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Coordinator } from '../lib/coordinator.js';

// In-memory only: no NativeClient, process launch, native preview or permissions.
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function fixture(handler, deniedOrigins=[]) {
  const native = new EventEmitter();
  native.connected = false;
  native.calls = [];
  native.pauseCount = 0;
  native.pauseNow = () => { native.pauseCount++; };
  native.dispose = async () => {};
  native.request = async (method, params, options) => {
    const call = { method, params, options };
    native.calls.push(call);
    return handler ? handler(call) : { preview: true };
  };
  const config = { enabled: false, overlayMode: 'clean', cursorSize: 64, cursorHoldMs: 1800, reducedMotion: true };
  const co = new Coordinator({ native, deniedOrigins, getConfig: () => config });
  return { co, native, config };
}
const stops = {
  pause: ({ co }) => co.pause('test-user-stop'),
  configuration: async ({ co, config }) => { config.enabled = false; await co.configureChanged(); },
  'native-input': ({ native }) => native.emit('paused', { reason: 'human_input' }),
  reconnect: ({ native }) => {
    native.connected = false;
    native.emit('disconnect');
    native.connected = true;
    native.emit('ready', {});
  },
  dispose: ({ co }) => co.dispose(),
};

test('explicit preview remains available while disabled, paused and not connected without resuming', async () => {
  const response = { preview: true };
  const f = fixture(() => response);
  try {
    assert.equal(await f.co.userCommand('preview'), response);
    assert.deepEqual(f.native.calls.map(call => call.method), ['overlay.configure', 'overlay.preview']);
    assert.deepEqual(f.native.calls[0].params, { mode: 'clean', variant:'large', size: 64, holdMs: 1800, reducedMotion: true });
    assert.deepEqual(f.native.calls[1].params, { userInitiated: true });
    const signal = f.native.calls[0].options.signal;
    assert.ok(signal instanceof AbortSignal);
    assert.equal(f.native.calls[1].options.signal, signal);
    assert.equal(signal.aborted, false);
    assert.equal(f.co.status().enabled, false);
    assert.equal(f.co.status().paused, true);
    assert.equal(f.co.status().nativeConnected, false);
    assert.equal(f.native.pauseCount, 0);
    f.co.pause('after-success');
    assert.equal(signal.aborted, false, 'successful preview is no longer registered as active');
  } finally { await f.co.dispose(); }
});

for (const stage of ['overlay.configure', 'overlay.preview']) {
  for (const [name, stop] of Object.entries(stops)) {
    test(`preview stop during ${stage}: ${name}`, async () => {
      const gate = deferred();
      const entered = deferred();
      // Deliberately ignore AbortSignal: epoch checks must independently reject late success.
      const f = fixture(call => {
        if (call.method === stage) { entered.resolve(); return gate.promise; }
        return {};
      });
      if (name === 'configuration') f.config.enabled = true;
      try {
        const pending = f.co.userCommand('preview');
        const rejected = assert.rejects(pending, { code: name === 'dispose' ? 'disposed' : 'state_changed' });
        await entered.promise;
        await stop(f);
        gate.resolve({ preview: true });
        await rejected;
        assert.equal(f.native.calls.length, stage === 'overlay.configure' ? 1 : 2);
        assert.equal(f.native.calls[0].options.signal.aborted, true);
        if (stage === 'overlay.preview') assert.equal(f.native.calls[1].options.signal, f.native.calls[0].options.signal);
        assert.equal(f.co.status().paused, true);
      } finally { gate.resolve({}); await f.co.dispose(); }
    });
  }
}

for (const name of ['pause', 'reconnect']) {
  test(`fulfilled configure cannot continue after synchronous ${name} before its await continuation`, async () => {
    const f = fixture();
    try {
      const pending = f.co.userCommand('preview'); // configure already returned a fulfilled Promise.
      const rejected = assert.rejects(pending, { code: 'state_changed' });
      stops[name](f); // No await: run before the configure continuation's microtask.
      await rejected;
      assert.deepEqual(f.native.calls.map(call => call.method), ['overlay.configure']);
      assert.equal(f.native.calls[0].options.signal.aborted, true);
    } finally { await f.co.dispose(); }
  });
}

for (const stage of ['overlay.configure', 'overlay.preview']) {
  test(`preview ${stage} rejection propagates without retry and releases its controller`, async () => {
    const error = new Error('simulated-backend-failure');
    const f = fixture(call => { if (call.method === stage) throw error; return {}; });
    try {
      await assert.rejects(f.co.userCommand('preview'), actual => actual === error);
      assert.equal(f.native.calls.length, stage === 'overlay.configure' ? 1 : 2);
      const signals = f.native.calls.map(call => call.options.signal);
      assert.ok(signals.every(signal => signal instanceof AbortSignal && !signal.aborted));
      f.co.pause('after-error');
      assert.ok(signals.every(signal => !signal.aborted), 'failed preview is no longer active');
    } finally { await f.co.dispose(); }
  });
}

test('disposed coordinator rejects new preview without reading configuration or making requests', async () => {
  const f = fixture();
  await f.co.dispose();
  f.co.getConfig = () => { throw new Error('configuration must not be read'); };
  await assert.rejects(f.co.userCommand('preview'), { code: 'disposed' });
  assert.equal(f.native.calls.length, 0);
});

test('preview passes a usable abort signal to a cancellation-aware pending transport', async () => {
  const entered = deferred();
  const f = fixture(call => new Promise((resolve, reject) => {
    entered.resolve();
    call.options.signal.addEventListener('abort', () => reject(Object.assign(new Error('mock aborted'), { code: 'aborted' })), { once: true });
  }));
  try {
    const pending = f.co.userCommand('preview');
    const rejected = assert.rejects(pending, { code: 'aborted' });
    await entered.promise;
    f.co.pause('user');
    await rejected;
    assert.deepEqual(f.native.calls.map(call => call.method), ['overlay.configure']);
  } finally { await f.co.dispose(); }
});

for (const stage of ['overlay.configure', 'overlay.preview']) {
  test(`old ${stage} completion cannot dispatch or stop a newer explicit preview`, async () => {
    const gate = deferred();
    const entered = deferred();
    const response = { preview: true, simulated: true };
    const newGate = deferred();
    const newEntered = deferred();
    let held = false;
    const f = fixture(call => {
      if (call.method === stage && !held) { held = true; entered.resolve(); return gate.promise; }
      if (call.method === 'overlay.preview') { newEntered.resolve(); return newGate.promise; }
      return response;
    });
    try {
      const old = f.co.userCommand('preview');
      const rejected = assert.rejects(old, { code: 'state_changed' });
      await entered.promise;
      f.co.pause('separate-user-stop');
      const newer = f.co.userCommand('preview').then(value => ({ value }), error => ({ error }));
      await newEntered.promise;
      const newSignal = f.native.calls.at(-1).options.signal;
      const pauses = f.native.pauseCount;
      gate.resolve({ preview: true, stale: true });
      await rejected;
      assert.equal(f.native.calls.filter(call => call.method === 'overlay.preview').length, stage === 'overlay.configure' ? 1 : 2);
      assert.equal(f.native.pauseCount, pauses, 'old completion must not emit a cleanup stop into the newer epoch');
      assert.equal(newSignal.aborted, false, 'newer preview is still pending and must remain uncancelled');
      newGate.resolve(response);
      const outcome = await newer;
      assert.equal(outcome.error, undefined);
      assert.equal(outcome.value, response);
      assert.equal(f.co.status().paused, true);
    } finally { gate.resolve({}); newGate.resolve(response); await f.co.dispose(); }
  });
}

test('resume rebinds the companion to the same share without reading the page or activating a tab',async()=>{
  const {co,config}=fixture(undefined,['http://127.0.0.1:59721']);
  config.enabled=true;config.overlayMode='companion';
  const calls=[];
  co.extensionBridge={connected:true,clearIndicators(){calls.push('clear')},async request(op,args){
    calls.push(op);assert.equal(args.appearance.mode,'companion');
  },async dispose(){}};
  try {
    await co.userCommand('resume');
    assert.deepEqual(calls,['clear','meta']);
    assert.equal(co.status().pauseReason,null);
    co.pause('user');assert.equal(co.status().pauseReason,'user');
    assert.deepEqual(calls,['clear','meta','clear']);
  } finally {await co.dispose()}
});
