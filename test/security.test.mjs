import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PolicyStore, assertSafeTarget, actionDigest, validateAction, assertLocalEndpoint, assertWorkspacePath } from '../lib/security.js';
const identity = { sessionId: 'session-a', agentId: 'agent-a', bundleId: 'com.apple.TextEdit' };
const bound = { ...identity, snapshotId: 'snapshot-a', action: 'type', args: { action: 'type', text: '鲸鱼🐳' } };

test('default deny and exact session/agent/application grants', () => {
  const p = new PolicyStore(); assert.throws(() => p.require({ ...identity, access: 'read' }), { code: 'access_required' });
  p.grant({ ...identity, access: 'read' }); assert.ok(p.require({ ...identity, access: 'read' }));
  for (const change of [{ agentId: 'other' }, { sessionId: 'other' }, { bundleId: 'com.apple.finder' }]) assert.throws(() => p.require({ ...identity, ...change, access: 'read' }), { code: 'access_required' });
  assert.throws(() => p.require({ ...identity, access: 'control' }), { code: 'access_required' });
});
test('read renewal never extends control expiry', () => {
  let now = 1; const p = new PolicyStore({ now: () => now }); p.grant({ ...identity, access: 'control', ttlMs: 100 });
  now = 50; p.grant({ ...identity, access: 'read', ttlMs: 1000 }); now = 150;
  assert.ok(p.require({ ...identity, access: 'read' })); assert.throws(() => p.require({ ...identity, access: 'control' }), { code: 'access_required' });
});
test('reject invalid TTL and clocks including NaN', () => {
  for (const ttlMs of [NaN, Infinity, -1, 0, '100']) { assert.throws(() => new PolicyStore({ ttlMs }), { code: 'invalid_ttl' }); const p = new PolicyStore(); assert.throws(() => p.grant({ ...identity, access: 'read', ttlMs }), { code: 'invalid_ttl' }); p.grant({ ...identity, access: 'control' }); assert.throws(() => p.issueConfirmation({ ...bound, ttlMs }), { code: 'invalid_ttl' }); }
  const p = new PolicyStore({ now: () => NaN }); assert.throws(() => p.grant({ ...identity, access: 'read' }), { code: 'invalid_clock' });
});
test('confirmation bound to exact action, single use and short TTL', () => {
  let now = 1; const p = new PolicyStore({ now: () => now }); p.grant({ ...identity, access: 'control' });
  const token = p.issueConfirmation(bound); assert.equal(p.consumeConfirmation(token, bound), true); assert.throws(() => p.consumeConfirmation(token, bound), { code: 'confirmation_required' });
  const mismatch = p.issueConfirmation(bound); assert.throws(() => p.consumeConfirmation(mismatch, { ...bound, args: { action: 'type', text: 'changed' } }), { code: 'confirmation_required' }); assert.throws(() => p.consumeConfirmation(mismatch, bound));
  const expires = p.issueConfirmation({ ...bound, ttlMs: 10 }); now += 11; assert.throws(() => p.consumeConfirmation(expires, bound), { code: 'confirmation_required' });
});
test('pause/revoke invalidates all pending approvals and model cannot resume', () => {
  const p = new PolicyStore(); p.grant({ ...identity, access: 'control' }); const token = p.issueConfirmation(bound); p.pause(); assert.throws(() => p.require({ ...identity, access: 'read' }), { code: 'paused' }); assert.throws(() => p.resume(), { code: 'user_required' }); p.resume({ userInitiated: true }); assert.throws(() => p.consumeConfirmation(token, bound), { code: 'confirmation_required' });
  const token2 = p.issueConfirmation(bound); p.revoke(identity); assert.throws(() => p.consumeConfirmation(token2, bound), { code: 'access_required' });
});
test('immutable copies and stable full parameter hashes', () => {
  const p = new PolicyStore(); const g = p.grant({ ...identity, access: 'read' }); assert.throws(() => { g.control = true; }); assert.equal(actionDigest({ b: 2, a: 1 }), actionDigest({ a: 1, b: 2 })); assert.notEqual(actionDigest({ a: 1 }), actionDigest({ a: 2 })); assert.throws(() => actionDigest(JSON.parse('{"__proto__": {"x":1}}')));
});
test('deny sensitive app targets and authority smuggling', () => {
  for (const target of ['com.apple.Terminal', 'com.googlecode.iterm2', 'com.agilebits.onepassword', 'com.apple.security.agent', 'com.deepseek.dsh']) {
    assert.throws(() => assertSafeTarget(target), { code: 'target_denied' });
  }
  for (const field of ['userInitiated', 'foregroundApproved', 'sessionId', 'agentId', 'endpoint', 'token']) assert.throws(() => validateAction({ action: 'wait', [field]: true }), { code: 'invalid_action' });
});
test('validate bounded actions and Unicode, reject injection transport', () => {
  assert.equal(validateAction({ action: 'type', text: '你好 🐳\n' }).text, '你好 🐳\n');
  for (const action of [{ action: 'shell', text: 'whoami' }, { action: 'click' }, { action: 'click', x: NaN, y: 0 }, { action: 'wait', amount: 9000 }, { action: 'navigate', url: 'file:///etc/passwd' }, { action: 'navigate', url: 'https://user:pass@example.com' }, { action: 'upload', files: [] }, { action: 'type', text: '\u001b' }]) assert.throws(() => validateAction(action));
});
test('CDP endpoints require explicit loopback and same authority websocket', () => {
  assert.equal(assertLocalEndpoint('http://127.0.0.1:9222').host, '127.0.0.1:9222');
  for (const endpoint of ['http://example.com:9222', 'http://localhost:9222', 'https://127.0.0.1:9222', 'http://127.0.0.1', 'http://a:b@127.0.0.1:9222', 'http://127.0.0.1:9222/path', 'http://127.0.0.1:9222/?x=1']) assert.throws(() => assertLocalEndpoint(endpoint), { code: 'endpoint_denied' });
  assert.throws(() => assertLocalEndpoint('ws://127.0.0.1:9223/devtools/browser/abc', { websocket: true, sameAuthority: 'http://127.0.0.1:9222' }), { code: 'endpoint_denied' });
});
test('uploads resolve workspace boundaries, symlinks and regular files', async () => {
  const root = await mkdtemp(resolve('.test-security-')); const inside = join(root, 'inside'); await writeFile(inside, 'fixture');
  assert.equal(await assertWorkspacePath(root, 'inside'), inside);
  const other = await mkdtemp(resolve('.test-outside-')); const file = join(other, 'outside'); await writeFile(file, 'secret fixture'); await symlink(file, join(root, 'escape'));
  await assert.rejects(assertWorkspacePath(root, 'escape'), { code: 'path_denied' }); await assert.rejects(assertWorkspacePath(root, root), { code: 'path_denied' });
  // Leave test-owned artifacts for inspection; no computed deletion of user paths.
});
