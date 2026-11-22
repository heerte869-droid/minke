import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { NATIVE_PROTOCOL_OPT_IN, nativeProtocolTestSkip, assertNativeProtocolTestOptIn } from './helpers/native-test-opt-in.mjs';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const nativeTest = fileURLToPath(new URL('./native.test.mjs', import.meta.url));
// Preload before importing the real test file. Every child-process primitive is
// replaced, including its named ESM exports: neither probe can reach a helper.
const denyProcesses = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { writeSync } from 'node:fs';
let attempts = 0;
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  childProcess[name] = () => { attempts++; throw new Error('native_gate_probe_blocks_all_child_processes'); };
}
syncBuiltinESMExports();
process.on('exit', () => writeSync(1, '\\nNATIVE_GATE_BLOCKED_ATTEMPTS=' + attempts + '\\n'));
`;

async function probe(value) {
  const env = { ...process.env };
  // Never propagate an ambient opt-in/candidate or Node preload to the probe.
  for (const key of [NATIVE_PROTOCOL_OPT_IN, 'COMPUTER_USE_CANDIDATE_HELPER', 'NODE_OPTIONS', 'NODE_TEST_CONTEXT']) delete env[key];
  if (value !== undefined) env[NATIVE_PROTOCOL_OPT_IN] = value;
  try {
    const result = await execute(process.execPath, ['--test-reporter=tap', '--import', `data:text/javascript,${encodeURIComponent(denyProcesses)}`, nativeTest], { cwd: root, env, timeout: 10000, maxBuffer: 1024 * 1024 });
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (error.code !== 1 || error.signal) throw error;
    return { stdout: error.stdout, stderr: error.stderr, exitCode: 1 };
  }
}

function assertProbe(result, { failed, skipped, attempts }) {
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^# tests 3$/m);
  assert.match(result.stdout, new RegExp(`^# fail ${failed}$`, 'm'));
  assert.match(result.stdout, new RegExp(`^# skipped ${skipped}$`, 'm'));
  assert.match(result.stdout, new RegExp(`^NATIVE_GATE_BLOCKED_ATTEMPTS=${attempts}$`, 'm'));
}

test('real native test selector requires exact own opt-in and macOS', () => {
  for (const value of [undefined, '', '0', 'false', 'true', 'yes', ' 1', '1 ', 1, true]) {
    assert.equal(typeof nativeProtocolTestSkip({ env: { [NATIVE_PROTOCOL_OPT_IN]: value }, platform: 'darwin' }), 'string');
  }
  assert.equal(typeof nativeProtocolTestSkip({ env: Object.create({ [NATIVE_PROTOCOL_OPT_IN]: '1' }), platform: 'darwin' }), 'string');
  for (const platform of ['linux', 'win32', '']) assert.equal(typeof nativeProtocolTestSkip({ env: { [NATIVE_PROTOCOL_OPT_IN]: '1' }, platform }), 'string');
  assert.equal(nativeProtocolTestSkip({ env: { [NATIVE_PROTOCOL_OPT_IN]: '1' }, platform: 'darwin' }), false);
});

test('spawn-path guard independently refuses missing opt-in without any process execution', () => {
  assert.throws(() => assertNativeProtocolTestOptIn({ env: {}, platform: 'darwin' }), { code: 'native_test_opt_in_required' });
  assert.throws(() => assertNativeProtocolTestOptIn({ env: { [NATIVE_PROTOCOL_OPT_IN]: '1' }, platform: 'linux' }), { code: 'native_test_opt_in_required' });
  assert.doesNotThrow(() => assertNativeProtocolTestOptIn({ env: { [NATIVE_PROTOCOL_OPT_IN]: '1' }, platform: 'darwin' }));
});

for (const value of [undefined, '0', 'true']) test(`real native test registration skips without spawning when opt-in is ${String(value)}`, async () => {
  const result = await probe(value);
  assert.equal(result.exitCode, 0);
  assertProbe(result, { failed: 0, skipped: 3, attempts: 0 });
});

test('explicit selector reaches all three real-test spawn paths only inside a denying mock probe', async () => {
  const result = await probe('1');
  const selected = process.platform === 'darwin';
  // The inner three failures are EXPECTED mock interceptions, not helper runs.
  assert.equal(result.exitCode, selected ? 1 : 0);
  assertProbe(result, { failed: selected ? 3 : 0, skipped: selected ? 0 : 3, attempts: selected ? 3 : 0 });
});

test('package entrypoints never silently enable real native or candidate tests', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test test/*.test.mjs');
  assert.equal(pkg.scripts['test:native'], 'node --test test/native.test.mjs');
  assert.equal(pkg.scripts['test:native-gate'], 'node --test test/native-opt-in.test.mjs');
  for (const name of ['test', 'test:native', 'test:native-gate']) {
    assert.ok(!pkg.scripts[name].includes(NATIVE_PROTOCOL_OPT_IN));
    assert.ok(!pkg.scripts[name].includes('COMPUTER_USE_CANDIDATE_HELPER'));
  }
});
