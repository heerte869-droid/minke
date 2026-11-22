import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export class PolicyError extends Error {
  constructor(code, message, details) { super(message); this.name = 'PolicyError'; this.code = code; if (details) this.details = details; }
}
const fail = (code, message) => { throw new PolicyError(code, message); };
const own = (v, key) => Object.prototype.hasOwnProperty.call(v, key);
const DENIED = /(?:^|[.\s_-])(?:terminal|iterm2?|warp|alacritty|kitty|wezterm|ghostty|1password|onepassword|onepassword7|1password7|bitwarden|lastpass|keychainaccess|securityagent|authorizationhost|loginwindow|systemuiserver|controlcenter|systempreferences|systemsettings|whale-helper|dsh-whale)(?:$|[.\s_-])/i;
const ACTIONS = new Set(['click', 'type', 'setValue', 'press', 'scroll', 'drag', 'selectText', 'axAction', 'wait', 'navigate', 'back', 'forward', 'reload', 'close', 'hover', 'select', 'upload']);
const MAX_TTL = 30 * 60_000;
function boundedTtl(value, max = MAX_TTL) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail('invalid_ttl', 'TTL must be a positive finite number.');
  return Math.min(max, Math.max(1, value));
}
function identityString(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) fail('invalid_identity', `Invalid ${label}`);
  return value;
}
export function assertSafeTarget(bundleId) {
  identityString(bundleId, 'application identity');
  if (DENIED.test(bundleId) || bundleId === 'com.deepseek.dsh' || bundleId === 'com.openai.chat' || bundleId.startsWith('com.apple.security')) fail('target_denied', 'Credential, terminal, security and controller applications cannot be automated.');
  return bundleId;
}
function canonical(value, depth = 0) {
  if (depth > 20) fail('invalid_parameters', 'Parameters exceed maximum nesting depth.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('invalid_parameters', 'Non-finite number.'); return Object.is(value, -0) ? 0 : value; }
  if (Array.isArray(value)) { if (value.length > 512) fail('invalid_parameters', 'Array too long.'); return value.map(v => canonical(v, depth + 1)); }
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const output = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('invalid_parameters', 'Unsafe parameter key.');
      if (value[key] !== undefined) output[key] = canonical(value[key], depth + 1);
    }
    return output;
  }
  fail('invalid_parameters', 'Only JSON parameters are supported.');
}
export function actionDigest(actionObject) {
  const json = JSON.stringify(canonical(actionObject));
  if (Buffer.byteLength(json) > 256 * 1024) fail('invalid_parameters', 'Action is too large.');
  return createHash('sha256').update(json).digest('hex');
}
function numberField(value, field, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail('invalid_action', `Invalid ${field}.`);
}
export function validateAction(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_action', 'Expected an action object.');
  const out = canonical(input);
  for (const forbidden of ['userInitiated', 'foregroundApproved', 'sessionId', 'agentId', 'endpoint', 'helperPath', 'approval', 'token']) if (own(out, forbidden)) fail('invalid_action', 'Action parameters cannot carry authority or transport configuration.');
  if (!ACTIONS.has(out.action)) fail('invalid_action', 'Unknown or forbidden action.');
  if (own(out, 'mode') && !['preserve', 'foreground'].includes(out.mode)) fail('invalid_action', 'Invalid input mode.');
  for (const key of ['x', 'y', 'toX', 'toY']) if (own(out, key)) numberField(out[key], key, 0, 100_000);
  for (const key of ['text', 'value', 'label', 'selection', 'prefix', 'suffix']) {
    if (!own(out, key)) continue;
    if (typeof out[key] !== 'string' || out[key].length > 32_768 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(out[key])) fail('invalid_action', `Invalid ${key}.`);
  }
  if (own(out, 'relative') && typeof out.relative !== 'boolean') fail('invalid_action', 'relative must be a boolean.');
  if (out.relative === true) {
    if (out.ref || out.elementRef || !own(out, 'x') || !own(out, 'y')) fail('invalid_action', 'Relative coordinates require a point without an element reference.');
    for (const key of ['x', 'y', 'toX', 'toY']) if (own(out, key)) numberField(out[key], key, 0, 999, true);
  }
  if (out.action === 'click') {
    if (!out.elementRef && !out.ref && !(own(out, 'x') && own(out, 'y'))) fail('invalid_action', 'Click requires an exact element reference or window-local coordinates.');
    if (own(out, 'button') && !['left', 'right', 'middle'].includes(out.button)) fail('invalid_action', 'Invalid mouse button.');
    if (own(out, 'count')) numberField(out.count, 'count', 1, 2, true);
  }
  if (out.action === 'drag') for (const field of ['x', 'y', 'toX', 'toY']) { if (!own(out, field)) fail('invalid_action', 'Drag requires all start/end coordinates.'); }
  if (['type', 'selectText'].includes(out.action) && typeof out.text !== 'string') fail('invalid_action', 'Text is required.');
  if (out.action === 'setValue' && typeof (out.value ?? out.text) !== 'string') fail('invalid_action', 'Value is required.');
  if (out.action === 'press') {
    if (typeof out.key !== 'string' || !out.key || out.key.length > 80 || !/^[A-Za-z0-9+_ .-]+$/.test(out.key)) fail('invalid_action', 'Invalid key chord.');
    if (out.key.split('+').length > 5) fail('invalid_action', 'Too many key modifiers.');
  }
  if (out.action === 'scroll') {
    if (!['up', 'down', 'left', 'right'].includes(out.direction)) fail('invalid_action', 'Invalid scroll direction.');
    if (own(out, 'amount')) numberField(out.amount, 'amount', 1, 3000);
  }
  if (out.action === 'wait' && own(out, 'amount')) numberField(out.amount, 'amount', 0, 2000, true);
  if (out.action === 'axAction' && (typeof out.axAction !== 'string' || !/^AX[A-Za-z]{1,64}$/.test(out.axAction))) fail('invalid_action', 'Only an advertised AX action name is accepted.');
  if (out.action === 'navigate') {
    let url; try { url = new URL(out.url); } catch { fail('invalid_action', 'Invalid navigation URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('url_denied', 'Only HTTP(S) navigation without embedded credentials is allowed.');
    out.url = url.href;
  }
  if (out.action === 'select' && ((typeof out.value === 'string') === (typeof out.label === 'string'))) fail('invalid_action', 'Select requires exactly one value or label.');
  if (out.action === 'upload' && (!Array.isArray(out.files) || out.files.length < 1 || out.files.length > 8 || out.files.some(p => typeof p !== 'string' || !p || p.includes('\0')))) fail('invalid_action', 'Upload requires 1–8 explicit workspace paths.');
  for (const field of ['elementRef', 'ref', 'snapshotId', 'tabId']) if (own(out, field)) identityString(out[field], field);
  actionDigest(out);
  return out;
}
export async function assertWorkspacePath(workspace, path) {
  if (typeof workspace !== 'string' || !workspace || typeof path !== 'string' || !path || path.includes('\0')) fail('path_denied', 'Invalid upload path.');
  const root = await realpath(workspace);
  const target = await realpath(resolve(root, path));
  const rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) fail('path_denied', 'Files must be within the session workspace.');
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) fail('path_denied', 'Only regular workspace files may be uploaded.');
  if (info.size > 20 * 1024 * 1024) fail('file_too_large', 'Upload files are limited to 20 MiB.');
  return target;
}
export function assertLocalEndpoint(endpoint, options = {}) {
  if (typeof endpoint !== 'string' || endpoint.length > 2048) fail('endpoint_denied', 'Invalid endpoint.');
  let url; try { url = new URL(endpoint); } catch { fail('endpoint_denied', 'Invalid endpoint URL.'); }
  const protocols = options.websocket ? ['ws:'] : ['http:'];
  if (!protocols.includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.hash || url.search) fail('endpoint_denied', 'Use an explicit loopback IP and port without credentials, query or fragment.');
  if (!options.websocket && !['/', '/json/version'].includes(url.pathname)) fail('endpoint_denied', 'Only the local CDP discovery endpoint is accepted.');
  if (options.websocket && !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(url.pathname)) fail('endpoint_denied', 'Unexpected CDP browser WebSocket path.');
  if (options.sameAuthority && url.host !== new URL(options.sameAuthority).host) fail('endpoint_denied', 'CDP redirected to a different host or port.');
  return url;
}

export function assertNotControlPlane(value, deniedOrigins = []) {
  let url; try { url = new URL(value); } catch { fail('url_denied', 'Invalid URL.'); }
  const local = host => host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host) || /^\[::ffff:(?:127\.|7f)/i.test(host);
  const port = u => u.port || (u.protocol === 'https:' ? '443' : '80');
  for (const origin of deniedOrigins) {
    const denied = new URL(origin);
    // Reserve the non-standard controller port even under DNS/host aliases.
    const reservedPort = denied.port && !['80', '443'].includes(denied.port) && port(url) === denied.port;
    if (url.origin === denied.origin || reservedPort || (local(url.hostname) && local(denied.hostname) && port(url) === port(denied))) fail('control_plane_denied', 'Computer tools cannot inspect or operate their own DSH control/approval interface.');
  }
  return url;
}

export class PolicyStore {
  #grants = new Map(); #tokens = new Map(); #now; #ttl; #paused = false; #epoch = 0;
  constructor({ now = Date.now, ttlMs = 10 * 60_000 } = {}) {
    if (typeof now !== 'function') fail('invalid_clock', 'Clock must be a function.');
    this.#now = () => { const value = now(); if (typeof value !== 'number' || !Number.isFinite(value)) fail('invalid_clock', 'Clock returned a non-finite timestamp.'); return value; };
    this.#ttl = boundedTtl(ttlMs);
  }
  get epoch() { return this.#epoch; }
  get paused() { return this.#paused; }
  #key({ sessionId, agentId, bundleId }) { return JSON.stringify([identityString(sessionId, 'session'), identityString(agentId, 'agent'), assertSafeTarget(bundleId)]); }
  #prune() {
    const now = this.#now();
    for (const [key, g] of this.#grants) {
      g.read = g.readExpiresAt > now;
      g.control = g.controlExpiresAt > now;
      if (!g.read && !g.control) this.#grants.delete(key);
    }
    for (const [key, t] of this.#tokens) if (t.expiresAt <= now) this.#tokens.delete(key);
  }
  grant(args) {
    this.assertRunning(); this.#prune();
    if (!['read', 'control'].includes(args.access)) fail('invalid_access', 'Unknown application access level.');
    const key = this.#key(args);
    if (!this.#grants.has(key) && this.#grants.size >= 256) fail('policy_limit', 'Too many active application grants.');
    const ttl = boundedTtl(args.ttlMs ?? this.#ttl);
    const previous = this.#grants.get(key);
    const expires = this.#now() + ttl;
    const record = { sessionId: args.sessionId, agentId: args.agentId, bundleId: args.bundleId,
      read: true, control: false,
      readExpiresAt: expires,
      controlExpiresAt: args.access === 'control' ? expires : (previous?.controlExpiresAt ?? 0),
      expiresAt: expires };
    record.control = record.controlExpiresAt > this.#now();
    record.expiresAt = Math.max(record.readExpiresAt, record.controlExpiresAt);
    this.#grants.set(key, record);
    return Object.freeze({ ...record });
  }
  require(args) {
    this.assertRunning(); this.#prune();
    if (!['read', 'control'].includes(args.access)) fail('invalid_access', 'Unknown access level.');
    const grant = this.#grants.get(this.#key(args));
    if (!grant || !grant[args.access]) fail('access_required', 'Explicit approval for this session, agent and application is required.');
    return Object.freeze({ ...grant });
  }
  revoke(filter = {}) {
    this.#epoch++; this.#tokens.clear();
    for (const [key, value] of this.#grants) if (Object.entries(filter).every(([k, v]) => v === undefined || value[k] === v)) this.#grants.delete(key);
  }
  list(filter = {}) {
    this.#prune();
    return [...this.#grants.values()].filter(g => Object.entries(filter).every(([k, v]) => v === undefined || g[k] === v)).map(g => Object.freeze({ ...g }));
  }
  pause() { this.#paused = true; this.#epoch++; this.#tokens.clear(); }
  startEnabled() { this.#paused = false; this.#epoch++; this.#tokens.clear(); }
  resume({ userInitiated } = {}) { if (userInitiated !== true) fail('user_required', 'Only the user can resume computer control.'); this.startEnabled(); }
  assertRunning() { if (this.#paused) fail('paused', 'Computer control is paused. Ask the user to resume in settings.'); }
  issueConfirmation(identity) {
    this.assertRunning(); this.require({ ...identity, access: 'control' }); this.#prune();
    identityString(identity.snapshotId, 'snapshot');
    if (this.#tokens.size >= 128) fail('policy_limit', 'Too many pending confirmations.');
    const token = randomBytes(32).toString('base64url');
    const { ttlMs, ...bound } = identity;
    this.#tokens.set(token, { digest: actionDigest(bound), epoch: this.#epoch, expiresAt: this.#now() + boundedTtl(ttlMs ?? 10_000, 15_000) });
    return token;
  }
  consumeConfirmation(token, identity) {
    this.assertRunning(); this.#prune();
    if (typeof token !== 'string' || token.length > 128) fail('confirmation_required', 'Invalid confirmation.');
    const record = this.#tokens.get(token);
    this.#tokens.delete(token); // Any attempted use consumes it, including mismatched/replayed requests.
    this.require({ ...identity, access: 'control' });
    const { ttlMs, ...bound } = identity;
    const digest = actionDigest(bound);
    if (!record || record.epoch !== this.#epoch || record.expiresAt <= this.#now() || !timingSafeEqual(Buffer.from(record.digest), Buffer.from(digest))) fail('confirmation_required', 'Confirmation expired, changed or already used.');
    return true;
  }
  clear() { this.#grants.clear(); this.#tokens.clear(); this.#epoch++; }
}

/** Convert bounded normalized image coordinates to the observed logical surface. */
export function normalizeCoordinates(args, geometry) {
  if (args.relative !== true) return args;
  if (!geometry || !Number.isFinite(geometry.width) || !Number.isFinite(geometry.height) ||
      geometry.width <= 0 || geometry.height <= 0 || geometry.width > 100000 || geometry.height > 100000) {
    fail('geometry_required', 'Observe this exact surface before using relative coordinates.');
  }
  const result = { ...args, relative: false };
  for (const key of ['x', 'toX']) if (own(args, key)) result[key] = args[key] * geometry.width / 1000;
  for (const key of ['y', 'toY']) if (own(args, key)) result[key] = args[key] * geometry.height / 1000;
  return result;
}
