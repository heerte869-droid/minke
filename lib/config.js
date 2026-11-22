import z from '@deepseek-ai/schemastery';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const SETTINGS_ID = 'whale-computer';
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  mode: z.union(['auto','preserve','foreground']).default('auto').volatile(),
  sessionAccess: z.boolean().default(true).volatile(),
  screenshots: z.boolean().default(false).volatile(),
  privateSkyLight: z.boolean().default(false).volatile(),
  browserEndpoint: z.string().default('').volatile(),
  overlayMode: z.union(['clean', 'companion', 'hidden']).default('companion').volatile(),
  cursorVariant: z.union(['large','mini']).default('large').volatile(),
  cursorSize: z.number().min(20).max(128).default(28).volatile(),
  cursorHoldMs: z.number().min(300).max(5000).default(1800).volatile(),
  reducedMotion: z.boolean().default(false).volatile(),
  command: z.string().default('').volatile(),
  response: z.string().default('').volatile(),
  helperPath: z.string().default(fileURLToPath(new URL('../native/build/Whale Computer.app/Contents/MacOS/whale-helper', import.meta.url))),
});
export const PREF_KEYS = ['enabled', 'sessionAccess', 'screenshots', 'privateSkyLight', 'browserEndpoint', 'overlayMode', 'cursorVariant', 'cursorSize', 'cursorHoldMs', 'reducedMotion'];
export function readConfig(config) { return {mode:'auto',...Object.fromEntries(PREF_KEYS.map(key => [key, typeof config[key]?.get === 'function' ? config[key].get() : config[key]]))}; }
export const UI_COMMANDS = new Set(['diagnose', 'pause', 'resume', 'revoke', 'permissions', 'preview','extensionDisconnect','downloadExtension','prepareChromeInstall']);
/** Authenticated settings carries commands, but its persisted values never carry authority. */
export class CommandChannel {
  #seen = new Set(); #tail = Promise.resolve(); #disposed = false; #generation = 0; #priority = new Set();
  constructor({ initialCommand = '', execute, publish, status = () => ({}), boot = randomUUID() }) {
    this.boot = boot; this.execute = execute; this.publish = publish; this.status = status;
    try { const initial = JSON.parse(initialCommand); if (typeof initial.nonce === 'string') this.#seen.add(initial.nonce); } catch { /* old malformed input is ignored */ }
  }
  async initialize() { await this.publish({ boot: this.boot, status: this.status(), outcome: 'ready', ackNonce: null, notice: 'Fresh host startup. Existing commands ignored.' }); }
  submit(raw) {
    if (this.#disposed || typeof raw !== 'string' || !raw || raw.length > 4096) return Promise.resolve(false);
    let command; try { command = JSON.parse(raw); } catch { return Promise.resolve(false); }
    if (!command || command.boot !== this.boot || typeof command.nonce !== 'string' || !/^[A-Za-z0-9-]{16,128}$/.test(command.nonce) || this.#seen.has(command.nonce) || !UI_COMMANDS.has(command.op)) return Promise.resolve(false);
    // Consume before execution, including failures. Bound memory rejects additional commands rather than replaying old ones.
    if (this.#seen.size >= 4096) return Promise.resolve(false);
    this.#seen.add(command.nonce);
    const priority = command.op === 'pause' || command.op === 'revoke';
    if (priority) this.#generation++;
    const generation = this.#generation;
    const operation = async () => {
      if (this.#disposed || (!priority && generation !== this.#generation)) return false;
      let outcome = 'completed'; let result;
      try { result = await this.execute(command.op, command.op === 'permissions' ? { kind: command.kind } : {}); }
      catch (error) { outcome = 'failed'; result = { code: typeof error?.code === 'string' ? error.code : 'operation_failed', message: 'Command failed. Check helper setup and permissions; no automatic retry was made.' }; }
      if (this.#disposed || generation !== this.#generation) return false;
      if (!this.#disposed) await this.publish({ boot: this.boot, ackNonce: command.nonce, outcome, operation: command.op, result, status: this.status() });
      return outcome === 'completed';
    };
    if (priority) {
      const result = operation(); this.#priority.add(result); void result.finally(() => this.#priority.delete(result)).catch(() => {}); return result;
    }
    const result = this.#tail.then(operation, operation); this.#tail = result.catch(() => {}); return result;
  }
  async dispose() { this.#disposed = true; this.#generation++; await Promise.allSettled([this.#tail, ...this.#priority]); }
}

/** Status refreshes must not erase an acknowledged command before clients see it. */
export function mergePublishedResponse(previous, next) {
  if (previous?.boot === next.boot && previous?.ackNonce && !next.ackNonce) {
    const acknowledgement = Object.fromEntries(['ackNonce', 'outcome', 'operation', 'result'].filter(key => previous[key] !== undefined).map(key => [key, previous[key]]));
    return { ...next, ...acknowledgement };
  }
  return next;
}
