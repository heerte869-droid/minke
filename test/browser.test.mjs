import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright-core';
import { BrowserAdapter, discoverCDP, normalizeKey } from '../lib/browser.js';
import { gotoOwnedFixture } from './helpers/owned-navigation.mjs';

async function server(handler) { const s = createServer(handler); await new Promise(r => s.listen(0, '127.0.0.1', r)); return { server: s, origin: `http://127.0.0.1:${s.address().port}`, close: () => new Promise(r => s.close(r)) }; }
const html = `<!doctype html><meta charset="utf-8"><title>Whale Test Fixture</title><style>body{font:18px system-ui;padding:25px}input,button,select{font:inherit;margin:8px}#scroll{height:80px;overflow:auto}#inner{height:1000px}</style><h1>鲸鱼测试</h1><label for="named-input">Nickname</label><input id="named-input"><div contenteditable="true" role="textbox" aria-label="Rich editor">Initial note</div><input aria-label="Message" id="message"><button id="counter" onclick="this.textContent='Count '+(++window.count)">Count 0</button><select aria-label="Choice"><option value="a">A</option><option value="b">B</option></select><input type="file" aria-label="Upload"><div role="button" id="scroll"><div id="inner">Scroll fixture</div></div><div role="button" id="drag" style="width:180px;height:60px;background:#cef;touch-action:none" onpointerdown="window.dragStart=event.clientX;this.setPointerCapture(event.pointerId)" onpointerup="window.dragDelta=event.clientX-window.dragStart">Drag fixture</div><script>window.count=0</script>`;

test('key normalization is explicit and bounded', () => {
  assert.equal(normalizeKey('CMD+ENTER'), 'Meta+Enter'); assert.equal(normalizeKey('Ctrl+shift+a'), 'Control+Shift+a');
  for (const key of ['arbitrary', 'Ctrl+Ctrl+a', 'Unknown+x', 'F50', '']) assert.throws(() => normalizeKey(key));
});
test('adapter fails closed without trusted controller origin and rejects invalid clocks/TTL', async () => {
  const adapter = new BrowserAdapter({ workspace: process.cwd() });
  await assert.rejects(adapter.connect({ endpoint: 'http://127.0.0.1:1' }), { code: 'control_origin_required' });
  for (const ttlMs of [NaN, Infinity, 0, -1, '100']) assert.throws(() => new BrowserAdapter({ workspace: process.cwd(), ttlMs }), { code: 'invalid_ttl' });
  assert.throws(() => new BrowserAdapter({ workspace: process.cwd(), deniedOrigins: ['file:///tmp'] }), { code: 'url_denied' });
});

test('discovery refuses redirect, remote websocket, oversized responses', async () => {
  const remote = await server((_q, r) => r.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://example.com:9222/devtools/browser/abc' })));
  try { await assert.rejects(discoverCDP(remote.origin), { code: 'endpoint_denied' }); } finally { await remote.close(); }
  const redirect = await server((_q, r) => { r.writeHead(302, { Location: 'http://127.0.0.1:1' }); r.end(); });
  try { await assert.rejects(discoverCDP(redirect.origin)); } finally { await redirect.close(); }
  const huge = await server((_q, r) => r.end('x'.repeat(70000)));
  try { await assert.rejects(discoverCDP(huge.origin), { code: 'cdp_response_too_large' }); } finally { await huge.close(); }
});

for (const first of ['owner', 'adapter']) test(`owned fixture navigation waits for both connections (${first} first)`, async () => {
  const expected = 'http://127.0.0.1:12345/fixture';
  let cached = expected; let predicate; let ownerCalls = 0; let settled = false;
  let resolveOwner; let resolveAdapter;
  const ownerDone = new Promise(resolve => { resolveOwner = resolve; });
  const adapterDone = new Promise(resolve => { resolveAdapter = resolve; });
  const main = { url: () => cached };
  const adapterPage = {
    url: () => cached, mainFrame: () => main,
    waitForEvent(name, options) {
      assert.equal(name, 'framenavigated'); assert.equal(options.timeout, 5000);
      predicate = options.predicate; return adapterDone;
    },
  };
  const ownerPage = { url: () => expected, goto(url) {
    assert.equal(url, expected); assert.equal(typeof predicate, 'function', 'Subscribe before owner navigation');
    ownerCalls++; return ownerDone;
  } };
  const pending = gotoOwnedFixture(ownerPage, adapterPage, expected).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(ownerCalls, 1); assert.equal(settled, false, 'Old equal cached URL is not a navigation event');
  assert.equal(predicate({ url: () => { throw new Error('Do not inspect a child frame URL'); } }), false);
  cached = 'http://127.0.0.1:12345/wrong'; assert.equal(predicate(main), false);
  cached = expected; assert.equal(predicate(main), true);
  if (first === 'owner') resolveOwner(); else resolveAdapter(main);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false, 'One completed connection is insufficient');
  if (first === 'owner') resolveAdapter(main); else resolveOwner();
  await pending; assert.equal(settled, true); assert.equal(ownerCalls, 1);
});

for (const side of ['owner', 'owner-sync', 'adapter']) test(`owned fixture navigation propagates ${side} failure without replay`, async () => {
  const expected = 'http://127.0.0.1:12345/fixture'; const failure = new Error(`${side} closed or timed out`);
  let subscribed = false; let calls = 0;
  const owner = { url: () => expected, goto() { assert.ok(subscribed); calls++; if (side === 'owner-sync') throw failure; return side === 'owner' ? Promise.reject(failure) : Promise.resolve(); } };
  const adapter = { url: () => expected, mainFrame: () => ({}), waitForEvent() { subscribed = true; return side === 'adapter' ? Promise.reject(failure) : Promise.resolve(); } };
  await assert.rejects(gotoOwnedFixture(owner, adapter, expected), error => error === failure);
  assert.equal(calls, 1, 'Do not replay navigation or ignore a rejected barrier');
});

test('real isolated headless Chrome: observe act verify and reject stale/protected targets', { timeout: 60000 }, async t => {
  await mkdir('.test-artifacts', { recursive: true });
  const workspace = await mkdtemp(resolve('.test-artifacts/browser-'));
  const site = await server((req, res) => { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(req.url === '/protected' ? '<title>Protected</title><input type="password" value="never-disclose"><button>Continue</button>' : html); });
  const foreign = await server((_q, res) => { res.setHeader('content-type', 'text/html'); res.end('<input aria-label="Foreign Secret" value="cross-origin-secret">'); });
  let context; let adapter;
  try {
    context = await chromium.launchPersistentContext(join(workspace, 'profile'), { executablePath: (process.env.WHALE_TEST_CHROMIUM || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), headless: true, args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], viewport: { width: 900, height: 700 }, deviceScaleFactor: 2, acceptDownloads: false });
    // The test owns this temporary browser. Adapter attaches to an explicitly discovered local socket.
    const { readFile } = await import('node:fs/promises');
    const active = (await readFile(join(workspace, 'profile', 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    let adapterBrowser;
    adapter = new BrowserAdapter({ workspace, deniedOrigins: [foreign.origin], connect: async (...args) => {
      adapterBrowser = await chromium.connectOverCDP(...args); return adapterBrowser;
    } });
    await adapter.connect({ endpoint: `http://127.0.0.1:${active[0]}` });
    const page = context.pages()[0];
    const adapterPages = adapterBrowser.contexts().flatMap(c => c.pages());
    assert.equal(context.pages().length, 1); assert.equal(adapterPages.length, 1, 'Only the owned fixture tab may be synchronized');
    const adapterPage = adapterPages[0];
    const gotoFixture = url => gotoOwnedFixture(page, adapterPage, url);
    await gotoFixture(site.origin);
    const { tabs } = await adapter.listTabs(); const tabId = tabs.find(tab => tab.url === `${site.origin}/`).tabId;
    let snapshot = await adapter.observe({ tabId, screenshot: true }); assert.ok(snapshot.image.base64); assert.equal(snapshot.image.mediaType, 'image/png'); assert.equal(snapshot.viewport.scale,2); assert.equal(snapshot.image.width,Buffer.from(snapshot.image.base64,'base64').readUInt32BE(16)); assert.ok(snapshot.image.width>=snapshot.viewport.width,'Use actual PNG geometry; attached CDP can return CSS-size captures despite DPR 2'); assert.deepEqual(JSON.parse(JSON.stringify(snapshot)),snapshot,'All tool state is lossless JSON');
    assert.match(snapshot.text, /鲸鱼测试/); assert.ok(snapshot.tree.some(n => n.title === 'Nickname')); assert.ok(snapshot.tree.some(n => n.title === 'Rich editor' && n.editable));
    assert.equal(await page.evaluate(() => devicePixelRatio),2,'Capture preserves device emulation on the attached browser');
    const rich = snapshot.tree.find(n => n.title === 'Rich editor'); const edited = await adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'setValue', ref: rich.ref, value: 'Editable 中文' }); assert.equal(edited.dispatch.verified, true); snapshot = edited.snapshot;
    const message = snapshot.tree.find(n => n.title === 'Message'); assert.ok(message);
    const typed = await adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'setValue', ref: message.ref, value: '你好，小鲸鱼 🐳' });
    assert.equal(typed.dispatch.verified, true); assert.equal(await page.locator('#message').inputValue(), '你好，小鲸鱼 🐳');
    await assert.rejects(adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'setValue', ref: message.ref, value: 'replay' }), { code: 'stale_snapshot' });
    const opened = await adapter.openTab({ url: site.origin + '/new-tab', contextTabId: tabId });
    assert.ok(opened.tabId && opened.requiresObservation); let newState = await adapter.observe({ tabId: opened.tabId });
    newState = (await adapter.action({ tabId: opened.tabId, snapshotId: newState.snapshotId, action: 'navigate', url: site.origin + '/next' })).snapshot;
    newState = (await adapter.action({ tabId: opened.tabId, snapshotId: newState.snapshotId, action: 'back' })).snapshot; assert.equal(newState.url, site.origin + '/new-tab');
    newState = (await adapter.action({ tabId: opened.tabId, snapshotId: newState.snapshotId, action: 'forward' })).snapshot; assert.equal(newState.url, site.origin + '/next');
    newState = (await adapter.action({ tabId: opened.tabId, snapshotId: newState.snapshotId, action: 'reload' })).snapshot; assert.equal(newState.url, site.origin + '/next');
    await assert.rejects(adapter.openTab({ url: foreign.origin }), { code: 'control_plane_denied' });
    const closed = await adapter.action({ tabId: opened.tabId, snapshotId: newState.snapshotId, action: 'close' }); assert.equal(closed.closed, true); assert.equal(closed.dispatch.verified, true);
    snapshot = await adapter.observe({ tabId });
    const button = snapshot.tree.find(n => n.title === 'Count 0');
    await page.locator('#counter').evaluate(node => { for (const type of ['pointerdown','click']) node.addEventListener(type, e => {
      node.dataset[type]=JSON.stringify([e.clientX,e.clientY]);
    }, {once:true}); });
    const clicked = await adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'click', ref: button.ref,
      cursor: {mode:'companion',size:30,hold:1800} });
    const offset=await page.evaluate(() => {
      const marker=document.querySelector('[data-whale-ai-pointer]');
      const r=marker.getBoundingClientRect(), events=document.querySelector('#counter').dataset;
      const [x,y]=JSON.parse(events.pointerdown), [cx,cy]=JSON.parse(events.click);
      return {dx:r.x+r.width*88/1254-x,dy:r.y+r.height*88/1254-y,clickDelta:Math.hypot(cx-x,cy-y),inert:marker.inert};
    });
    assert.ok(Math.hypot(offset.dx,offset.dy)<0.1 && offset.clickDelta<=Math.SQRT2 && offset.inert, JSON.stringify(offset));
    await adapter.clearCursor();
    assert.equal(await page.locator('[data-whale-ai-pointer]').count(),0);
    assert.equal(await page.locator('#counter').innerText(), 'Count 1'); assert.ok(clicked.snapshot.tree.some(n => n.title === 'Count 1'));
    snapshot = clicked.snapshot;
    const choice = snapshot.tree.find(n => n.title === 'Choice');
    const selected = await adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'select', ref: choice.ref, label: 'B' }); assert.equal(selected.dispatch.verified, true);
    snapshot = selected.snapshot;
    const file = join(workspace, 'upload.txt'); await writeFile(file, 'fixture upload only');
    const upload = snapshot.tree.find(n => n.title === 'Upload');
    const uploaded = await adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'upload', ref: upload.ref, files: ['upload.txt'] });
    assert.equal(await page.locator('input[type=file]').evaluate(el => el.files[0].name), 'upload.txt');
    snapshot = uploaded.snapshot;
    const scroll = snapshot.tree.find(n => n.title === 'Scroll fixture');
    const scrolled = await adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'scroll', ref: scroll.ref, direction: 'down', amount: 200 });
    assert.equal(await page.locator('#scroll').evaluate(el => el.scrollTop), 200);
    snapshot = scrolled.snapshot;
    const draggable = snapshot.tree.find(n => n.title === 'Drag fixture'); const dragX = draggable.frame.x + 15; const dragY = draggable.frame.y + 15;
    const dragged = await adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'drag', x: dragX, y: dragY, toX: dragX + 80, toY: dragY });
    assert.equal(await page.evaluate(() => window.dragDelta), 80);
    snapshot = dragged.snapshot;
    const waited = await adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'wait', amount: 10 });
    snapshot = waited.snapshot;
    await page.setViewportSize({width:960,height:720});
    await assert.rejects(adapter.action({tabId,snapshotId:snapshot.snapshotId,action:'click',x:20,y:20}),{code:'stale_snapshot'});
    snapshot=await adapter.observe({tabId});
    const changed = snapshot.tree.find(n => n.title === 'Count 1'); await page.locator('#counter').evaluate(el => { el.textContent = 'Changed outside agent'; });
    await assert.rejects(adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'click', ref: changed.ref }), { code: 'stale_element' });
    await gotoFixture(site.origin); snapshot = await adapter.observe({ tabId });
    const postFailureButton = snapshot.tree.find(n => n.title === 'Count 0'); const observe = adapter.observe.bind(adapter);
    adapter.observe = async () => { throw new Error('Fixture post-action observation failure'); };
    try {
      await assert.rejects(adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'click', ref: postFailureButton.ref }), error => error.code === 'action_unverified' && error.details.mayHaveDispatched === true && error.details.requiresObservation === true);
      assert.equal(await page.locator('#counter').innerText(), 'Count 1', 'Post-observe failure must not hide the side effect');
    } finally { adapter.observe = observe; }
    await gotoFixture(site.origin); snapshot = await adapter.observe({ tabId });
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'password'; input.id = 'late-protected'; document.body.append(input); });
    await assert.rejects(adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'click', x: 30, y: 20 }), { code: 'protected_page' });
    for (const autocomplete of ['section-test one-time-code', 'shipping cc-number', 'billing cc-csc', 'current-password', 'new-password']) {
      await gotoFixture(site.origin); snapshot = await adapter.observe({ tabId });
      await page.evaluate(token => { const input = document.createElement('input'); input.autocomplete = token; input.value = 'token-list-secret'; document.body.append(input); }, autocomplete);
      await assert.rejects(adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'click', x: 30, y: 20 }), { code: 'protected_page' });
      const protectedSnapshot = await adapter.observe({ tabId }); assert.ok(!JSON.stringify(protectedSnapshot).includes('token-list-secret'));
      await assert.rejects(adapter.observe({ tabId, screenshot: true }), { code: 'protected_capture' });
    }
    await gotoFixture(site.origin); snapshot = await adapter.observe({ tabId });
    await page.evaluate(src => new Promise(resolve => { const frame = document.createElement('iframe'); frame.onload = resolve; frame.src = src; document.body.append(frame); }), foreign.origin);
    await assert.rejects(adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'drag', x: 30, y: 20, toX: 50, toY: 50 }), { code: 'protected_page' });
    await gotoFixture(`${site.origin}/protected`); snapshot = await adapter.observe({ tabId });
    assert.ok(snapshot.protectedContent); assert.ok(!JSON.stringify(snapshot).includes('never-disclose'));
    await assert.rejects(adapter.observe({ tabId, screenshot: true }), { code: 'protected_capture' });
    snapshot = await adapter.observe({ tabId }); await assert.rejects(adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'click', x: 30, y: 20 }), { code: 'protected_page' });
    await gotoFixture(site.origin);
    await page.evaluate(src => new Promise(resolve => { const f = document.createElement('iframe'); f.onload = resolve; f.src = src; document.body.append(f); }), foreign.origin);
    snapshot = await adapter.observe({ tabId }); assert.ok(!JSON.stringify(snapshot).includes('cross-origin-secret')); assert.ok(snapshot.protectedContent);
    await assert.rejects(adapter.observe({ tabId, screenshot: true }), { code: 'protected_capture' });
    await gotoFixture(site.origin); snapshot = await adapter.observe({ tabId });
    await assert.rejects(adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'navigate', url: foreign.origin }), { code: 'control_plane_denied' });
    assert.equal(page.url(), `${site.origin}/`);
    await gotoFixture(foreign.origin);
    assert.ok((await adapter.listTabs()).tabs.find(t => t.tabId === tabId).blocked);
    await assert.rejects(adapter.observe({ tabId }), { code: 'control_plane_denied' });
    await gotoFixture(site.origin); snapshot = await adapter.observe({ tabId }); const abort = new AbortController(); abort.abort();
    await assert.rejects(adapter.action({ tabId, snapshotId: snapshot.snapshotId, action: 'wait', signal: abort.signal }), { code: 'aborted' });
    await gotoFixture(site.origin); snapshot=await adapter.observe({tabId});
    const cancelDrag=new AbortController(),dragNode=snapshot.tree.find(n=>n.title==='Drag fixture');
    const originalMove=adapterPage.mouse.move.bind(adapterPage.mouse); let moves=0;
    adapterPage.mouse.move=async(...args)=>{const result=await originalMove(...args);if(++moves===2)cancelDrag.abort();return result;};
    await assert.rejects(adapter.action({tabId,snapshotId:snapshot.snapshotId,action:'drag',x:dragNode.frame.x+10,y:dragNode.frame.y+10,toX:dragNode.frame.x+100,toY:dragNode.frame.y+10,signal:cancelDrag.signal}),e=>e.code==='aborted'||e.details?.mayHaveDispatched===true);
    await page.waitForFunction(()=>Number.isFinite(window.dragDelta),{},{timeout:3000});
    assert.ok(await page.evaluate(()=>window.dragDelta)<90,'Cancellation released the held button before remaining moves');
    await writeFile(join(workspace, 'result.json'), JSON.stringify({ passed: true, scope: 'Isolated headless Chrome and localhost fixture only; not existing user Chrome.', checks: ['CDP attachment', 'snapshot', 'PNG', 'Chinese/emoji readback', 'click oracle', 'select oracle', 'upload buffer', 'scroll position oracle', 'drag delta oracle', 'bounded wait', 'stale snapshot', 'stale DOM', 'protected capture rejection', 'late password rejection', 'autocomplete token lists', 'late cross-origin frame rejection', 'controller live URL denial', 'abort'] }, null, 2));
    t.diagnostic(`Evidence: ${workspace}/result.json`);
  } finally { await adapter?.disconnect(); await context?.close(); await site.close(); await foreign.close(); }
});
