/**
 * Persistent, transport-agnostic object API over the registered DSH tools.
 * This layer never grants authority, resumes control, or retries an input.
 */
export function connectComputer(tools, { now = Date.now } = {}) {
  const states = new Map(), surfaces = new Map();
  const call = async (name, args = {}) => {
    const currentTools = typeof tools === 'function' ? tools() : tools;
    if (typeof currentTools?.[name] !== 'function') throw Object.assign(new Error('Computer Use tool is unavailable: ' + name), { code: 'tool_unavailable' });
    const result = await currentTools[name](args);
    if (result?.error) throw Object.assign(new Error(result.error.message), result.error);
    return result;
  };
  const keyFor = (kind, target, windowId) => JSON.stringify([kind, target, windowId ?? null]);
  function surface(kind, target, windowId) {
    const key = keyFor(kind, target, windowId);
    if (surfaces.has(key)) return surfaces.get(key);
    const selection = kind === 'native' ? { bundleId: target, ...(windowId === undefined ? {} : { windowId }) } : { tabId: target };
    const state = { snapshot: null, tail: Promise.resolve() }; states.set(key, state);
    const serialized = work => {
      const result = state.tail.then(work, work); state.tail = result.catch(() => {}); return result;
    };
    const store = result => {
      if (!result?.snapshot || result.requiresObservation || result.originChanged) { state.snapshot = null; return result; }
      if (kind === 'native') for (const [k, value] of states) { const [otherKind, otherTarget] = JSON.parse(k); if (otherKind === kind && otherTarget === target) value.snapshot = null; }
      state.snapshot = result.snapshot;
      return result;
    };
    async function readReady(name, args, waitMs = 1200) {
      if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 5000) throw new Error('waitMs must be between 0 and 5000.');
      const started = Date.now(); const attempts = Math.ceil(waitMs / 150) + 1;
      for (let i = 0; i < attempts; i++) {
        try { return await call(name, args); }
        catch (error) {
          if (!['window_unavailable', 'window_discovery_unavailable'].includes(error.code) || Date.now() - started >= waitMs || i === attempts - 1) throw error;
          await new Promise(resolve => setTimeout(resolve, Math.min(150, waitMs - (Date.now() - started))));
        }
      }
    }
    async function observe(options = {}) {
      // All app/window aliases share native snapshots, as the native cache keeps
      // only one current observation per target. Never resurrect a sibling ref.
      if (kind === 'native') for (const [k, value] of states) {
        const [otherKind, otherTarget] = JSON.parse(k);
        if (otherKind === kind && otherTarget === target) value.snapshot = null;
      }
      state.snapshot = null;
      const result = kind === 'native'
        ? await readReady('whale_observe', { ...selection, screenshot: options.screenshot === true, ocr: options.ocr === true }, options.waitMs ?? 1200)
        : await call('whale_browser', { operation: 'observe', ...selection, screenshot: options.screenshot === true });
      return store(result);
    }
    function fresh() {
      const snap = state.snapshot;
      if (!snap || !Number.isFinite(snap.observedAt) || now() - snap.observedAt >= 15_000 || now() < snap.observedAt - 1000) {
        state.snapshot = null;
        throw Object.assign(new Error('Read fresh state on this surface before acting.'), { code: 'observation_required' });
      }
      return snap;
    }
    function targetArgs(target) {
      if (typeof target === 'string' && target) return kind === 'native' ? { elementRef: target } : { ref: target };
      if (Array.isArray(target) && target.length === 2 && target.every(Number.isFinite)) return { x: target[0], y: target[1] };
      if (target === undefined || target === null) return {};
      throw Object.assign(new Error('Use an exact element ref or [x, y] point.'), { code: 'invalid_target' });
    }
    async function action(action, parameters = {}) {
      const snap = fresh();
      // Consume before dispatch, including exceptions. An uncertain action must
      // never reuse or automatically re-observe/replay its old target.
      state.snapshot = null;
      const args = { ...selection, snapshotId: snap.snapshotId, action, ...parameters };
      const result = kind === 'native' ? await call('whale_action', args) : await call('whale_browser', { operation: 'action', ...args });
      return store(result);
    }
    const roleName = role => ({ AXButton: 'button', AXTextField: 'textbox', AXTextArea: 'textbox', AXCheckBox: 'checkbox', AXRadioButton: 'radio', AXPopUpButton: 'combobox', AXComboBox: 'combobox', AXLink: 'link', AXStaticText: 'text' })[role] ?? role;
    function locator(role, name, exact = true, context) {
      const rows = () => fresh().tree.filter(row => (!role || roleName(row.role) === roleName(role)) && (context === undefined || String(row.context ?? '').includes(context)) &&
        (name === undefined || [row.title, row.description, row.placeholder, row.label].filter(v => typeof v === 'string').some(v => exact ? v === name : v.includes(name))));
      const ref = () => {
        const matches = rows();
        if (matches.length !== 1) throw Object.assign(new Error(matches.length ? 'Multiple controls match; inspect state and choose an exact ref.' : 'Control is absent from the current observation.'), { code: matches.length ? 'ambiguous_element' : 'element_missing' });
        return matches[0].ref;
      };
      return Object.freeze({
        count: () => rows().length,
        click: options => object.click(ref(), options),
        fill: value => object.setValue(ref(), value),
        typeText: text => object.typeText(ref(), text),
        press: key => object.pressKey(ref(), key),
        ...(kind === 'browser' ? { hover: () => object.hover(ref()), selectOption: value => object.selectOption(ref(), value) } : {}),
      });
    }
    const object = {
      getByRole: (role, { name, exact = true, context } = {}) => locator(role, name, exact, context),
      getByLabel: (name, { exact = true, context } = {}) => locator(null, name, exact, context),
      ...(kind === 'native' ? { bundleId: target, windowId } : { tabId: target }),
      getState: options => serialized(() => observe(options)),
      getAXState: options => serialized(() => observe(options)),
      getScreenshot: () => serialized(() => observe({ screenshot: true })),
      getAXStateAndScreenshot: options => serialized(() => observe({ ...options, screenshot: true })),
      click: (target, options = {}) => serialized(() => action('click', { ...targetArgs(target), ...(options.button ? { button: options.button } : {}), ...(options.count ? { count: options.count } : {}), ...(options.relative === true ? { relative: true } : {}) })),
      typeText: (target, text) => serialized(() => action('type', { ...targetArgs(target), text })),
      setValue: (target, value) => serialized(() => action('setValue', { ...targetArgs(target), value })),
      pressKey: (target, key) => serialized(() => action('press', { ...targetArgs(target), key })),
      scroll: (target, direction, amount = 500) => serialized(() => action('scroll', { ...targetArgs(target), direction, amount })),
      clickRelative: (point, options = {}) => object.click(point, { ...options, relative: true }),
      drag: (from, to, { relative = false } = {}) => serialized(() => action('drag', { ...targetArgs(from), toX: to?.[0], toY: to?.[1], relative })),
      waitFor: (condition, { timeoutMs = 5000, intervalMs = 250, signal } = {}) => serialized(async () => {
        if (!condition || typeof condition !== 'object' || Array.isArray(condition) || !Object.keys(condition).length || (!condition.text && !condition.role && condition.enabled === undefined) ||
          Object.keys(condition).some(k => !['text', 'role', 'enabled', 'absent'].includes(k)) ||
          ('text' in condition && typeof condition.text !== 'string') || ('role' in condition && typeof condition.role !== 'string') ||
          ('enabled' in condition && typeof condition.enabled !== 'boolean') || ('absent' in condition && typeof condition.absent !== 'boolean') ||
          !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 10_000 || !Number.isFinite(intervalMs) || intervalMs < 100 || intervalMs > 1000) {
          throw Object.assign(new Error('Use a bounded text/role/enabled condition and a timeout of at most 10 seconds.'), { code: 'invalid_wait' });
        }
        const deadline = now() + timeoutMs;
        const maxAttempts = Math.ceil(timeoutMs / intervalMs) + 1;
        let result;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (signal?.aborted) throw Object.assign(new Error('Wait cancelled.'), { code: 'aborted' });
          result = await observe();
          const matches = (result.snapshot?.tree ?? []).filter(row =>
            (!condition.text || String(row.title ?? row.description ?? row.label ?? '').includes(condition.text)) &&
            (!condition.role || roleName(row.role) === roleName(condition.role)) &&
            (condition.enabled === undefined || row.enabled === condition.enabled));
          const pageMatch = !!condition.text && !condition.role && condition.enabled === undefined &&
            String(result.snapshot?.text ?? '').includes(condition.text);
          const found = matches.length > 0 || pageMatch;
          const complete = result.snapshot?.truncated !== true && result.snapshot?.textTruncated !== true && result.snapshot?.secure !== true && result.snapshot?.protectedContent !== true && !(result.snapshot?.warnings ?? []).some(w => /omitted|incomplete|truncated/i.test(w));
          if (condition.absent ? !found && complete : found) return { ...result, matched: true, matches, attempts: attempt + 1 };
          if (now() >= deadline) break;
          await new Promise((resolve, reject) => {
            const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(Object.assign(new Error('Wait cancelled.'), { code: 'aborted' })); };
            const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.min(intervalMs, Math.max(0, deadline - now())));
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
          });
        }
        return { ...result, matched: false, timedOut: true };
      }),
    };
    if (kind === 'native') Object.assign(object, {
      getWindows: ({ waitMs = 1200 } = {}) => serialized(async () => {
        if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 5000) throw new Error('waitMs must be between 0 and 5000.');
        const deadline = Date.now() + waitMs; let result;
        do { result = await readReady('whale_windows', { bundleId: target }, Math.max(0, deadline - Date.now()));
          if (result.windows?.length || result.discovery?.rejected?.some(code => !['window_identity_unmatched', 'window_geometry_unavailable'].includes(code))) return result;
          if (Date.now() >= deadline) break; await new Promise(resolve => setTimeout(resolve, Math.min(150, deadline - Date.now())));
        } while (Date.now() <= deadline);
        return result;
      }),
      getWindow: id => {
        if (!Number.isInteger(id) || id <= 0) throw new Error('A positive window ID is required.');
        return surface('native', target, id);
      },
      selectText: (target, text, options = {}) => serialized(() => action('selectText', { ...targetArgs(target), text, ...(options.prefix ? { prefix: options.prefix } : {}), ...(options.suffix ? { suffix: options.suffix } : {}) })),
      performSecondaryAction: (target, axAction) => serialized(() => action('axAction', { ...targetArgs(target), axAction })),
    });
    else Object.assign(object, {
      hover: target => serialized(() => action('hover', targetArgs(target))),
      goto: url => serialized(() => action('navigate', { url })),
      close: () => serialized(() => action('close')),
      back: () => serialized(() => action('back')),
      forward: () => serialized(() => action('forward')),
      reload: () => serialized(() => action('reload')),
      selectOption: (target, option) => serialized(() => {
        const choice = typeof option === 'string' ? { value: option } : option;
        if (!choice || typeof choice !== 'object' || Array.isArray(choice) || Object.keys(choice).length !== 1 || !['value', 'label'].includes(Object.keys(choice)[0]) || typeof Object.values(choice)[0] !== 'string') throw Object.assign(new Error('Use an option value or { label: exactLabel }.'), { code: 'invalid_selection' });
        return action('select', { ...targetArgs(target), ...choice });
      }),
      upload: (target, files) => serialized(() => action('upload', { ...targetArgs(target), files })),
    });
    surfaces.set(key, Object.freeze(object));
    return surfaces.get(key);
  }
  return Object.freeze({
    getCapabilities: async () => ({ ...(await call('whale_status')), objectAPI: true, automaticInputRetry: false,
      native: ['apps', 'findApps', 'openApp', 'windows', 'observe', 'screenshot', 'click', 'typeText', 'setValue', 'pressKey', 'scroll', 'drag', 'selectText', 'secondaryAction', 'waitFor'],
      browser: ['tabs', 'open', 'close', 'back', 'forward', 'reload', 'hover', 'observe', 'screenshot', 'navigate', 'click', 'typeText', 'setValue', 'pressKey', 'selectOption', 'scroll', 'drag', 'upload', 'waitFor'] }),
    getState: async () => {
      const status = await call('whale_status');
      return { status, ...(status.enabled && !status.paused ? await call('whale_apps') : {}) };
    },
    listApps: () => call('whale_apps'),
    findApps: query => call('whale_apps', { query }),
    getApp: async selector => {
      if (typeof selector !== 'string' || !selector.trim()) throw new Error('Supply an app name or bundle ID.');
      const data = await call('whale_apps', { query: selector }), apps = Array.isArray(data) ? data : data.apps ?? [];
      const exact = apps.filter(a => a.bundleId === selector);
      const matches = exact.length ? exact : apps.filter(a => [a.name, a.localizedName, a.path?.split('/').at(-1)?.replace(/\.app$/, '')].filter(Boolean).some(name => name.toLocaleLowerCase() === selector.toLocaleLowerCase()));
      if (matches.length !== 1) throw Object.assign(new Error(matches.length ? 'App name is ambiguous; use an exact bundle ID.' : 'App was not found. Use findApps() and choose an exact bundle ID.'), { code: matches.length ? 'ambiguous_app' : 'app_not_running' });
      if ((matches[0].instanceCount ?? 1) > 1) throw Object.assign(new Error('Multiple running instances share this bundle ID. Select a unique application instance first.'), { code: 'ambiguous_app' });
      if (matches[0].running === false) await call('whale_open_app', { bundleId: matches[0].bundleId });
      return surface('native', matches[0].bundleId);
    },
    listTabs: () => call('whale_browser', { operation: 'tabs' }),
    createBrowserTab: async (url, { contextTabId } = {}) => { const result = await call('whale_browser', { operation: 'open', url, ...(contextTabId ? { contextTabId } : {}) }); if (!result.tabId) throw new Error('New tab was not verified.'); return surface('browser', result.tabId); },
    getTab: async selector => {
      const data = await call('whale_browser', { operation: 'tabs' });
      const matches = (data.tabs ?? []).filter(t => !t.blocked && (t.tabId === selector || t.url === selector));
      if (matches.length !== 1) throw Object.assign(new Error('Select one exact tab ID from listTabs().'), { code: matches.length ? 'ambiguous_tab' : 'tab_missing' });
      return surface('browser', matches[0].tabId);
    },
    pause: async () => { for (const value of states.values()) value.snapshot = null; return call('whale_pause'); },
  });
}
