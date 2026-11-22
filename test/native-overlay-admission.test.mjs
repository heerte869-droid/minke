import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Source contracts + an explicitly abstract queue model, NOT executed Swift or AppKit.
// No NativeClient import, executable access, native process, permissions, or desktop.
const core = await readFile(new URL('../native/Core.swift', import.meta.url), 'utf8');
const main = await readFile(new URL('../native/main.swift', import.meta.url), 'utf8');
const overlay = await readFile(new URL('../native/Overlay.swift', import.meta.url), 'utf8');
const candidateTest = await readFile(new URL('./cursor-policy.test.mjs', import.meta.url), 'utf8');
const gate = 'try engine.state.checkGeneration(admittedGeneration)';
function branch(method) {
  const start = main.indexOf(`case "${method}":`);
  assert.notEqual(start, -1);
  const rest = main.slice(start);
  return rest.slice(0, rest.search(/\n\s*(?:case |default:)/));
}

test('source contract: generation-only admission locks locally and permits paused state', () => {
  const start = core.indexOf('func checkGeneration(');
  assert.notEqual(start, -1);
  const end = core.indexOf('@discardableResult func pause(', start);
  assert.ok(end > start);
  const body = core.slice(start, end);
  assert.match(body, /lock\.lock\(\);\s*defer\s*\{\s*lock\.unlock\(\)\s*\}/);
  assert.match(body, /guard expected == _generation else/);
  assert.match(body, /throw NativeError\("cancelled",/);
  assert.doesNotMatch(body, /_paused|DispatchQueue|\.sync|\.async|body\(/);
});

test('source contract: admission precedes work queue and priority pause remains outside it', () => {
  const admitted = main.indexOf('let admittedGeneration=engine.state.generation');
  const queued = main.indexOf('work.async', admitted);
  assert(admitted >= 0 && queued > admitted);
  const priority = main.slice(main.indexOf('if method=="pause"'), admitted);
  assert.match(priority, /engine\.state\.pause\(\)/);
  assert.match(priority, /DispatchQueue\.main\.async/);
  assert.doesNotMatch(priority, /work\.async/);
});

for (const method of ['overlay.configure', 'overlay.preview']) {
  test(`source contract: both queues guard ${method}`, () => {
    const raw = branch(method);
    if (method === 'overlay.preview') assert(raw.includes(`preview(check:{${gate}})`));
    // The validity callback is invoked inside preview, not a fourth immediate gate.
    const body = raw.replace(`check:{${gate}}`, 'check:validityCheck');
    const checks = [...body.matchAll(/try engine\.state\.checkGeneration\(admittedGeneration\)/g)].map(m => m.index);
    assert.equal(checks.length, 3, 'work entry, main entry and post-effect generation checks');
    const queued = body.indexOf('DispatchQueue.main.sync');
    const effect = body.indexOf(method === 'overlay.configure' ? 'engine.overlay?.configure(params)' : 'engine.overlay?.preview(');
    assert(checks[0] < queued && queued < checks[1] && checks[1] < effect && effect < checks[2]);
    assert.match(body, /try DispatchQueue\.main\.sync/);
    assert.doesNotMatch(body, /state\.dispatch|state\.check\(|lock\.lock|try\?/);
    if (method === 'overlay.configure') assert(body.indexOf('return configured') > checks[2]);
    else assert(body.indexOf('result=["preview":true]') > checks[2]);
  });
}

test('source contract: preview still requires explicit userInitiated before main dispatch', () => {
  const body = branch('overlay.preview');
  assert.match(body, /guard params\["userInitiated"\] as\? Bool == true else/);
  assert(body.indexOf('NativeError("user_required"') < body.indexOf('DispatchQueue.main.sync'));
  assert(body.includes(gate));
});

test('source contract: compiled native self-tests cover paused admission and invalidation', () => {
  for (const label of ['overlay generation check allows paused', 'stop invalidates queued overlay', 'resume invalidates queued overlay']) {
    assert(core.includes(`"${label}"`), label);
  }
  assert.match(core, /let admissionAssertions=try overlayAdmissionSelfTest\(\);passed\+=admissionAssertions/);
  assert.match(core, /"cursorAdmissionAssertions":admissionAssertions/);
  assert.match(candidateTest, /Number\.isSafeInteger\(result\.cursorAdmissionAssertions\)&&result\.cursorAdmissionAssertions>=3/);
  assert.match(candidateTest, /assert.equal\(result.passed,/);
});

test('source contract: preview protects setup ownership across screen lookup and hide', () => {
  const start = overlay.indexOf('func preview(check:');
  assert(start >= 0);
  const body = overlay.slice(start, overlay.indexOf('private func scheduleHide', start));
  const previous = body.indexOf('let previous=lifecycle.current');
  const screen = body.indexOf('let screen=NSScreen.main');
  const same = body.indexOf('guard lifecycle.current==previous');
  const hidden = body.indexOf('hide()');
  const empty = body.indexOf('guard lifecycle.current==nil');
  const begun = body.indexOf('let token=lifecycle.begin(.preview)');
  assert(previous < screen && screen < same && same < hidden && hidden < empty && empty < begun);
  assert(body.slice(screen, same).includes('try check()'));
  assert(body.slice(hidden, empty).includes('try check()'));
});

test('source contract: preview validates around positioning/order and cleans only own or empty owner', () => {
  const start = overlay.indexOf('func preview(check:');
  const body = overlay.slice(start, overlay.indexOf('private func scheduleHide', start));
  const validate = body.indexOf('func validate() throws');
  assert(body.slice(validate).includes('try check()'));
  assert(body.slice(validate).includes('guard lifecycle.acceptsHide(token) else {throw NativeError("cancelled"'));
  const checks = [...body.matchAll(/try validate\(\)/g)].map(m => m.index);
  const position = body.indexOf('panel.setFrameOrigin('), order = body.indexOf('panel.orderFrontRegardless()');
  assert.equal(checks.length, 3);
  assert(checks[0] < position && position < checks[1] && checks[1] < order && order < checks[2]);
  assert(checks[2] < body.indexOf('scheduleHide(after:2)'));
  assert.match(body, /catch\s*\{[\s\S]*if lifecycle\.acceptsHide\(token\) \|\| lifecycle\.current==nil \{hide\(\)\}\s*throw error/);
});

// Mirrors only the admitted-generation decisions statically bound above. It cannot
// prove AppKit ordering, nested run-loop behavior, lock scheduling or WindowServer visibility.
function model({ paused = true, changeAt, changes = ['pause'] } = {}) {
  const state = { paused, generation: 0, effects: [], replied: false, cancelled: false };
  const admitted = state.generation;
  const change = stage => {
    if (stage !== changeAt) return;
    for (const kind of changes) { state.paused = kind === 'pause'; state.generation++; }
  };
  const check = () => { if (admitted !== state.generation) throw new Error('cancelled'); };
  try {
    change('beforeWork'); check();
    change('beforeMain'); check();
    state.effects.push('effect'); change('duringEffect'); check();
    state.replied = true; change('afterReply');
  } catch (error) {
    assert.equal(error.message, 'cancelled'); state.cancelled = true;
  }
  return state;
}

test('queue model, not Swift: current explicit overlay remains allowed while paused or active', () => {
  for (const paused of [true, false]) {
    const result = model({ paused });
    assert.equal(result.replied, true); assert.deepEqual(result.effects, ['effect']);
  }
});
for (const changeAt of ['beforeWork', 'beforeMain']) {
  test(`queue model, not Swift: ${changeAt} pause or resume rejects without an overlay effect`, () => {
    for (const paused of [true, false]) for (const kind of ['pause', 'resume']) {
      const result = model({ paused, changeAt, changes: [kind] });
      assert.equal(result.cancelled, true); assert.equal(result.replied, false); assert.deepEqual(result.effects, []);
    }
  });
}
test('queue model, not Swift: in-effect invalidation rejects old success but cannot undo effect', () => {
  for (const kind of ['pause', 'resume']) {
    const result = model({ changeAt: 'duringEffect', changes: [kind] });
    assert.equal(result.cancelled, true); assert.equal(result.replied, false); assert.deepEqual(result.effects, ['effect']);
  }
});
test('queue model, not Swift: pause then resume never resurrects old queued admission', () => {
  const result = model({ changeAt: 'beforeMain', changes: ['pause', 'resume'] });
  assert.equal(result.paused, false); assert.equal(result.cancelled, true); assert.deepEqual(result.effects, []);
});
test('queue model, not Swift: a stop after completed reply cannot retract historical success', () => {
  const result = model({ changeAt: 'afterReply' });
  assert.equal(result.replied, true); assert.equal(result.cancelled, false); assert.equal(result.paused, true);
});
test('queue model, not Swift: late-order cleanup suppresses empty owner but preserves newer owner', () => {
  const old = Symbol('old'), newer = Symbol('newer');
  for (const [current, shouldHide] of [[old, true], [null, true], [newer, false]]) {
    const hide = current === old || current === null;
    assert.equal(hide, shouldHide);
  }
});
