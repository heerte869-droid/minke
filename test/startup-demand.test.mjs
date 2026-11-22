import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { NativeClient } from '../lib/native-client.js';
import { Coordinator } from '../lib/coordinator.js';

// In-memory transport doubles only. No real process, executable access or TCC calls.
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
class FakeChild extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); exitCode = null; frames = []; kills = [];
  constructor(autoReady) {
    super();
    this.stdin = new Writable({ write: (chunk, _encoding, done) => {
      const frame = JSON.parse(chunk.toString()); this.frames.push(frame); done();
      queueMicrotask(() => this.stdout.write(JSON.stringify({ id: frame.id, result: { method: frame.method } }) + '\n'));
    } });
    if (autoReady) queueMicrotask(() => this.ready());
  }
  ready() { this.stdout.write(JSON.stringify({ event: 'ready', data: { protocol: 1, version: '0.4.1' } }) + '\n'); }
  kill(signal) { this.kills.push(signal); this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0)); return true; }
}
function fixture({ checkExecutable, autoReady = true } = {}) {
  const gate = deferred(); const checked = deferred(); const spawned = deferred();
  const children = []; let checkCalls = 0;
  const client = new NativeClient({ helperPath: '/in-memory/whale-helper', startupMs: 500, timeoutMs: 500,
    checkExecutable: () => { checkCalls++; checked.resolve(); return checkExecutable ? checkExecutable(checkCalls, gate) : gate.promise; },
    spawnProcess: () => { const child = new FakeChild(autoReady); children.push(child); spawned.resolve(child); return child; },
  });
  return { client, gate, checked, spawned, children, get checkCalls() { return checkCalls; } };
}
async function withFixture(run, options) {
  const f = fixture(options);
  try { await run(f); } finally { f.gate.resolve(); await f.client.dispose(); }
}
const aborted = promise => assert.rejects(promise, { code: 'aborted' });

test('cancelled sole demand never spawns after executable preflight', async () => withFixture(async f => {
  const controller = new AbortController();
  const rejected = aborted(f.client.request('overlay.configure', {}, { signal: controller.signal }));
  await f.checked.promise;
  controller.abort(); f.gate.resolve();
  await rejected;
  assert.equal(f.children.length, 0);
  assert.equal(f.client.connected, false);
  assert.equal(f.checkCalls, 1);
}));

for (const kind of ['request', 'start']) {
  test(`pre-aborted ${kind} never checks an executable or spawns`, async () => withFixture(async f => {
    const controller = new AbortController(); controller.abort();
    const pending = kind === 'request' ? f.client.request('status', {}, { signal: controller.signal }) : f.client.start({ signal: controller.signal });
    await aborted(pending);
    assert.equal(f.checkCalls, 0); assert.equal(f.children.length, 0);
  }));
}

test('all shared demands cancelled during preflight produce no spawn', async () => withFixture(async f => {
  const a = new AbortController(); const b = new AbortController();
  const first = aborted(f.client.request('first', {}, { signal: a.signal }));
  const second = aborted(f.client.request('second', {}, { signal: b.signal }));
  await f.checked.promise; a.abort(); b.abort(); f.gate.resolve();
  await Promise.all([first, second]);
  assert.equal(f.checkCalls, 1); assert.equal(f.children.length, 0);
}));

for (const cancelledIndex of [0, 1]) {
  test(`shared startup preserves live demand when caller ${cancelledIndex + 1} cancels`, async () => withFixture(async f => {
    const controllers = [new AbortController(), new AbortController()];
    const methods = ['first', 'second'];
    const outcomes = controllers.map((controller, index) => f.client.request(methods[index], {}, { signal: controller.signal }).then(value => ({ value }), error => ({ error })));
    await f.checked.promise; controllers[cancelledIndex].abort(); f.gate.resolve();
    const results = await Promise.all(outcomes);
    assert.equal(results[cancelledIndex].error?.code, 'aborted');
    assert.deepEqual(results[1 - cancelledIndex].value, { method: methods[1 - cancelledIndex] });
    assert.equal(f.checkCalls, 1); assert.equal(f.children.length, 1);
    assert.deepEqual(f.children[0].frames.map(frame => frame.method), [methods[1 - cancelledIndex]]);
    assert.deepEqual(f.children[0].kills, []);
  }));
}

test('uncancelled public start keeps shared startup alive', async () => withFixture(async f => {
  const controller = new AbortController();
  const rejected = aborted(f.client.request('old', {}, { signal: controller.signal }));
  const started = f.client.start();
  await f.checked.promise; controller.abort(); f.gate.resolve();
  await Promise.all([rejected, started]);
  assert.equal(f.checkCalls, 1); assert.equal(f.children.length, 1);
  assert.equal(f.client.connected, true);
  assert.deepEqual(f.children[0].frames, []); assert.deepEqual(f.children[0].kills, []);
}));

for (const cancelledStartFirst of [true, false]) {
  test(`cancelled public start as ${cancelledStartFirst ? 'creator' : 'joiner'} rejects without harming live request`, async () => withFixture(async f => {
    const controller = new AbortController();
    let started; let fresh;
    if (cancelledStartFirst) {
      started = aborted(f.client.start({ signal: controller.signal }));
      fresh = f.client.request('fresh');
    } else {
      fresh = f.client.request('fresh');
      started = aborted(f.client.start({ signal: controller.signal }));
    }
    await f.checked.promise; controller.abort(); f.gate.resolve();
    await started; assert.deepEqual(await fresh, { method: 'fresh' });
    assert.equal(f.checkCalls, 1); assert.equal(f.children.length, 1);
    assert.deepEqual(f.children[0].frames.map(frame => frame.method), ['fresh']);
    assert.deepEqual(f.children[0].kills, []);
  }));
}

test('fresh demand may join before preflight admission after an older cancellation', async () => withFixture(async f => {
  const controller = new AbortController();
  const rejected = aborted(f.client.request('old', {}, { signal: controller.signal }));
  await f.checked.promise; controller.abort();
  const fresh = f.client.request('fresh'); f.gate.resolve();
  await rejected; assert.deepEqual(await fresh, { method: 'fresh' });
  assert.equal(f.checkCalls, 1); assert.equal(f.children.length, 1);
  assert.deepEqual(f.children[0].frames.map(frame => frame.method), ['fresh']);
}));

test('fully cancelled startup clears its slot for a later explicit retry', async () => withFixture(async f => {
  const controller = new AbortController();
  const rejected = aborted(f.client.request('old', {}, { signal: controller.signal }));
  await f.checked.promise; controller.abort(); f.gate.resolve(); await rejected;
  assert.equal(f.children.length, 0); assert.equal(f.checkCalls, 1);
  assert.deepEqual(await f.client.request('fresh'), { method: 'fresh' });
  assert.equal(f.checkCalls, 2); assert.equal(f.children.length, 1);
  assert.deepEqual(f.children[0].frames.map(frame => frame.method), ['fresh']);
}));

test('failed public start leaves no live demand that can admit a later cancelled request', async () => {
  const secondChecked = deferred();
  await withFixture(async f => {
    await assert.rejects(f.client.start(), { code: 'helper_missing' });
    const controller = new AbortController();
    const rejected = aborted(f.client.request('old', {}, { signal: controller.signal }));
    await secondChecked.promise; controller.abort(); f.gate.resolve(); await rejected;
    assert.equal(f.checkCalls, 2); assert.equal(f.children.length, 0);
  }, { checkExecutable: (call, gate) => {
    if (call === 1) throw new Error('simulated access failure');
    secondChecked.resolve(); return gate.promise;
  } });
});

test('cancelling after spawn does not kill a shared startup or dispatch the old request', async () => withFixture(async f => {
  const controller = new AbortController();
  const rejected = aborted(f.client.request('old', {}, { signal: controller.signal }));
  f.gate.resolve(); const child = await f.spawned.promise;
  controller.abort(); const fresh = f.client.request('fresh');
  assert.deepEqual(child.kills, []); child.ready();
  await rejected; assert.deepEqual(await fresh, { method: 'fresh' });
  assert.equal(f.children.length, 1); assert.deepEqual(child.kills, []);
  assert.deepEqual(child.frames.map(frame => frame.method), ['fresh']);
}, { autoReady: false }));

test('synchronous injected preflight reentry joins a fully published startup promise', async () => {
  let current; let joined;
  await withFixture(async f => {
    current = f;
    const started = f.client.start();
    await f.checked.promise; f.gate.resolve();
    await Promise.all([started, joined]);
    assert.equal(f.checkCalls, 1); assert.equal(f.children.length, 1);
    assert.equal(f.client.connected, true);
  }, { checkExecutable: (_call, gate) => {
    joined = current.client.start().then(() => {
      assert.equal(current.client.connected, true, 'reentrant start must not resolve before ready');
    });
    return gate.promise;
  } });
});

test('dispose before deferred boot prevents executable preflight and spawn', async () => withFixture(async f => {
  const rejected = assert.rejects(f.client.request('status'), { code: 'closed' });
  await f.client.dispose();
  await rejected;
  assert.equal(f.checkCalls, 0); assert.equal(f.children.length, 0);
}));

test('access failure retains helper_missing priority when its caller also cancels', async () => {
  let failAccess;
  await withFixture(async f => {
    const controller = new AbortController();
    const rejected = assert.rejects(f.client.request('status', {}, { signal: controller.signal }), { code: 'helper_missing' });
    await f.checked.promise; controller.abort(); failAccess(new Error('simulated failure'));
    await rejected; assert.equal(f.children.length, 0);
  }, { checkExecutable: () => new Promise((_resolve, reject) => { failAccess = reject; }) });
});

for (const stop of ['pause', 'disable']) {
  test(`coordinator preview ${stop} during executable preflight does not start a helper`, async () => withFixture(async f => {
    const config = { enabled: true, overlayMode: 'clean', cursorSize: 64, cursorHoldMs: 1800, reducedMotion: true };
    const co = new Coordinator({ native: f.client, getConfig: () => config });
    try {
      const rejected = aborted(co.userCommand('preview'));
      await f.checked.promise;
      if (stop === 'pause') co.pause('test-user-stop');
      else { config.enabled = false; await co.configureChanged(); }
      f.gate.resolve(); await rejected;
      assert.equal(f.children.length, 0); assert.equal(f.client.connected, false);
      assert.equal(co.status().paused, true);
    } finally { await co.dispose(); }
  }));
}
