import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { NativeClient } from '../lib/native-client.js';

class FakeChild extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); exitCode = null; frames = []; kills = [];
  constructor({ reply = true, version = '0.4.10' } = {}) {
    super(); this.reply = reply;
    this.stdin = new Writable({ write: (chunk, _encoding, done) => {
      const request = JSON.parse(chunk.toString()); this.frames.push(request); done();
      if (this.reply) queueMicrotask(() => this.respond(request.id, { method: request.method }));
    } });
    queueMicrotask(() => this.stdout.write(JSON.stringify({ event: 'ready', data: { protocol: 1, version } }) + '\n'));
  }
  respond(id, result) { this.stdout.write(JSON.stringify({ id, result }) + '\n'); }
  kill(signal) { this.kills.push(signal); this.exitCode = 0; queueMicrotask(() => this.emit('exit', 0)); return true; }
}
function setup(options = {}) {
  const children = []; const client = new NativeClient({ helperPath: '/fixture/whale-helper', checkExecutable: async () => {}, spawnProcess: () => { const child = new FakeChild(options); children.push(child); return child; }, startupMs: 100, timeoutMs: 100 });
  return { client, children };
}
test('native transport is lazy and verifies protocol before bounded JSON RPC', async () => {
  const { client, children } = setup(); assert.equal(children.length, 0); assert.equal(client.connected, false);
  assert.deepEqual(await client.request('status'), { method: 'status' }); assert.equal(children.length, 1); assert.equal(client.connected, true);
  assert.equal(children[0].frames[0].method, 'status'); await client.dispose(); assert.equal(client.connected, false);
});
test('native transport rejects mismatched version and terminates helper', async () => {
  const { client, children } = setup({ version: '99.0.0' }); await assert.rejects(client.start(), { code: 'protocol_mismatch' }); assert.ok(children[0].kills.length > 0); await client.dispose();
});
test('malformed protocol rejects pending work without leaking backend text', async () => {
  const { client, children } = setup({ reply: false }); const pending = client.request('observe'); await new Promise(resolve => setImmediate(resolve));
  children[0].stdout.write('private-ui-content-not-json\n'); await assert.rejects(pending, error => error.code === 'protocol_error' && !error.message.includes('private-ui-content')); assert.equal(client.connected, false); await client.dispose();
});
test('oversized unterminated frames fail closed', async () => {
  const { client, children } = setup({ reply: false }); const pending = client.request('status'); await new Promise(resolve => setImmediate(resolve));
  children[0].stdout.write('x'.repeat(2 * 1024 * 1024 + 1)); await assert.rejects(pending, { code: 'protocol_error' }); await client.dispose();
});
test('abort sends priority pause and rejects request; pre-abort never spawns', async () => {
  const { client, children } = setup({ reply: false }); const controller = new AbortController();
  const pending = client.request('action', {}, { signal: controller.signal }); await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, { code: 'aborted' }); assert.equal(children[0].frames.at(-1).method, 'pause'); await client.dispose();
  const second = setup(); const already = new AbortController(); already.abort(); await assert.rejects(second.client.request('action', {}, { signal: already.signal }), { code: 'aborted' }); assert.equal(second.children.length, 0); await second.client.dispose();
});
test('timeout pauses without automatic replay', async () => {
  const { client, children } = setup({ reply: false }); await assert.rejects(client.request('action', {}, { timeoutMs: 5 }), { code: 'helper_timeout' });
  assert.deepEqual(children[0].frames.map(frame => frame.method), ['action', 'pause']); await client.dispose();
});
test('late old child events cannot disconnect new helper or clear new pending work', async () => {
  const { client, children } = setup(); await client.request('status'); const old = children[0]; old.emit('error', new Error('fixture disconnect'));
  await client.request('status'); const fresh = children[1]; assert.equal(client.connected, true);
  old.emit('exit', 1); old.emit('error', new Error('late old process error')); old.stdout.write('not-json\n');
  assert.equal(client.connected, true); assert.deepEqual(await client.request('status'), { method: 'status' }); assert.equal(fresh.kills.length, 0); await client.dispose();
});
test('native request size and timeout validation are bounded before dispatch', async () => {
  const { client, children } = setup(); await client.start();
  await assert.rejects(client.request('action', { text: 'x'.repeat(2 * 1024 * 1024) }), { code: 'request_too_large' });
  await assert.rejects(client.request('status', {}, { timeoutMs: Infinity }), { code: 'invalid_timeout' }); assert.equal(children[0].frames.length, 0); await client.dispose();
});
