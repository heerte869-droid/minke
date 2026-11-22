import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

export class NativeProtocolError extends Error {
  constructor(code, message) { super(message); this.name = 'NativeProtocolError'; this.code = code; }
}
const MAX_LINE = 2 * 1024 * 1024;
const fault = (code, message) => new NativeProtocolError(code, message);
/** Lazy, bounded stdio transport. Never downloads, compiles, or asks for OS permissions. */
export class NativeClient extends EventEmitter {
  #child; #pending = new Map(); #buffer = ''; #starting; #ready = false; #closed = false;
  constructor({ helperPath, spawnProcess = spawn, checkExecutable = p => access(p, constants.X_OK), startupMs = 12_000, timeoutMs = 20_000 } = {}) {
    super(); this.helperPath = helperPath; this.spawnProcess = spawnProcess; this.checkExecutable = checkExecutable; this.startupMs = startupMs; this.timeoutMs = timeoutMs;
  }
  get connected() { return this.#ready && !!this.#child; }
  async start({ signal } = {}) {
    if (this.#closed) throw fault('closed', 'Native transport has been disposed.');
    if (signal?.aborted) throw fault('aborted', 'Native startup cancelled before process launch.');
    if (this.connected) return;
    let startup = this.#starting;
    if (!startup) {
      startup = { demands: new Set() }; this.#starting = startup;
      // Register demand and publish the promise before even a synchronous injected preflight can reenter.
      startup.promise = Promise.resolve().then(() => this.#boot(startup.demands)).finally(() => {
        if (this.#starting === startup) this.#starting = undefined;
      });
    }
    const demand = { signal }; startup.demands.add(demand);
    try {
      await startup.promise;
      if (signal?.aborted) throw fault('aborted', 'Native startup caller cancelled.');
    } finally { startup.demands.delete(demand); }
  }
  async #boot(demands) {
    if (this.#closed) throw fault('closed', 'Native transport has been disposed.');
    if (typeof this.helperPath !== 'string' || !this.helperPath.startsWith('/')) throw fault('helper_missing', 'Set up the stable Whale helper before enabling computer use.');
    try { await this.checkExecutable(this.helperPath); } catch { throw fault('helper_missing', 'Whale helper is missing or not executable. Run the explicit setup command.'); }
    if (this.#closed) throw fault('closed', 'Native transport has been disposed.');
    // Never let cancelled callers (or leases from an older attempt) admit a new process.
    if (![...demands].some(({ signal }) => !signal?.aborted)) throw fault('aborted', 'Native startup cancelled before process launch.');
    const child = this.spawnProcess(this.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME ?? '' } });
    this.#child = child; this.#buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', text => { if (this.#child === child) this.#accept(text); });
    // Intentionally discard diagnostics rather than risk logging UI/private content.
    child.stderr.on('data', () => {});
    const failed = () => { if (this.#child === child) this.#fail(fault('helper_disconnected', 'Native helper disconnected; observations and pending operations are invalid.')); };
    child.on('error', failed); child.once('exit', failed);
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off('ready', ready); this.off('disconnect', disconnected); };
      const ready = () => { cleanup(); resolve(); };
      const disconnected = error => { cleanup(); reject(error); };
      const timer = setTimeout(() => { cleanup(); this.#fail(fault('helper_timeout', 'Native helper startup timed out.')); child.kill('SIGTERM'); reject(fault('helper_timeout', 'Native helper startup timed out.')); }, this.startupMs);
      this.once('ready', ready); this.once('disconnect', disconnected);
    });
  }
  #accept(text) {
    this.#buffer += text;
    if (Buffer.byteLength(this.#buffer) > MAX_LINE && !this.#buffer.includes('\n')) return this.#badFrame();
    let boundary;
    while ((boundary = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, boundary); this.#buffer = this.#buffer.slice(boundary + 1);
      if (!line || Buffer.byteLength(line) > MAX_LINE) return this.#badFrame();
      let message; try { message = JSON.parse(line); } catch { return this.#badFrame(); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return this.#badFrame();
      if (message.event === 'ready') {
        if (message.data?.protocol !== 1 || message.data?.version !== '0.4.10') { this.#badFrame('protocol_mismatch'); return; }
        this.#ready = true; this.emit('ready', message.data); continue;
      }
      if (['paused', 'status', 'sessionAvailable'].includes(message.event)) { this.emit(message.event, message.data ?? {}); continue; }
      if (typeof message.id !== 'string') return this.#badFrame();
      const entry = this.#pending.get(message.id); if (!entry) continue;
      this.#pending.delete(message.id); entry.cleanup();
      if (message.error) {
        const code=/^[a-z_]{1,64}$/.test(message.error.code??'')?message.error.code:'native_error';
        const hint={app_not_running:'Find the installed application with whale_apps and open it in the background if authorized.',permission_denied:'Check the app permission status in DSH settings.',window_discovery_unavailable:'The app window is not ready; use a fresh read.',unsupported:'This control does not advertise a supported background action.'}[code]??'Inspect the target with a fresh observation before another action.';
        const error=fault(code,'Native operation: '+code+'. '+hint);
        if(message.error.details?.notDispatched===true)error.details={notDispatched:true};
        entry.reject(error);
      }
      else if (Object.hasOwn(message, 'result')) entry.resolve(message.result);
      else { entry.reject(fault('protocol_error', 'Native response has no result.')); this.#badFrame(); }
    }
    if (Buffer.byteLength(this.#buffer) > MAX_LINE) this.#badFrame();
  }
  #badFrame(code = 'protocol_error') { this.#fail(fault(code, 'Invalid or oversized native protocol frame.')); this.#child?.kill('SIGTERM'); }
  #fail(error) {
    const child = this.#child; this.#child = undefined; this.#ready = false; this.#buffer = '';
    for (const entry of this.#pending.values()) { entry.cleanup(); entry.reject(error); }
    this.#pending.clear();
    if (child && child.exitCode === null) child.kill('SIGTERM');
    this.emit('disconnect', error);
  }
  async request(method, params = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (signal?.aborted) throw fault('aborted', 'Operation cancelled before dispatch.');
    await this.start({ signal });
    if (signal?.aborted) throw fault('aborted', 'Operation cancelled before dispatch.');
    return this.#send(method, params, { signal, timeoutMs });
  }
  #send(method, params, { signal, timeoutMs }) {
    if (this.#pending.size >= 32) return Promise.reject(fault('request_limit', 'Too many pending native operations.'));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return Promise.reject(fault('invalid_timeout', 'Native timeout must be within 1–60000 milliseconds.'));
    const id = randomUUID(); const line = JSON.stringify({ id, method, params }) + '\n';
    if (Buffer.byteLength(line) > MAX_LINE) return Promise.reject(fault('request_too_large', 'Native request exceeds the protocol bound.'));
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.#pending.delete(id); cleanup();
        // Cancellation invalidates the native generation before rejecting locally.
        if (method !== 'pause') this.pauseNow();
        reject(fault('aborted', 'Operation cancelled; computer control was paused.'));
      };
      const timer = setTimeout(() => { this.#pending.delete(id); cleanup(); this.pauseNow(); reject(fault('helper_timeout', 'Native operation timed out; computer control was paused.')); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      this.#pending.set(id, { resolve, reject, cleanup }); signal?.addEventListener('abort', cancel, { once: true });
      try { this.#child.stdin.write(line, error => { if (error) this.#fail(fault('helper_disconnected', 'Native input channel failed.')); }); } catch { this.#fail(fault('helper_disconnected', 'Native input channel failed.')); }
      if (signal?.aborted) cancel();
    });
  }
  pauseNow(manualStop=false) {
    if (this.#child && this.#ready) {
      try { this.#child.stdin.write(JSON.stringify({ id: randomUUID(), method: 'pause', params: manualStop?{manualStop:true}:{} }) + '\n'); } catch { /* fail closed on next request */ }
    }
  }
  async dispose() {
    if (this.#closed) return; this.#closed = true; this.pauseNow();
    const child = this.#child; this.#fail(fault('closed', 'Native transport disposed.')); this.#child = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
    });
  }
}
