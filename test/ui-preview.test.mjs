import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

test('render real client with isolated config transport: layout, commands, keyboard and reduced motion', { timeout: 60000 }, async t => {
  await mkdir('.test-artifacts/ui', { recursive: true });
  const client = await readFile('client.js', 'utf8');
  const harness = `import React from 'react'; import {createRoot} from 'react-dom/client';
  let plugin;window.__ModuleLoader__={load(entry){plugin=entry.factory(name=>{if(name==='react')return React;throw Error(name)})}};
  ${client}
  let state={status:'ready',writable:true,revision:1,value:{enabled:false,mode:'preserve',screenshots:false,overlayMode:'clean',cursorSize:28,cursorHoldMs:1800,reducedMotion:false,browserEndpoint:'',response:JSON.stringify({boot:'fixture-boot',status:{paused:true,nativeConnected:false,permissions:null,browserConnections:0}})}};
  const listeners=new Set();const history=[];function emit(){for(const fn of listeners)fn()}
  const form={getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},async mutate(ops,revision){if(revision!==state.revision)return false;history.push(ops);const value={...state.value};for(const op of ops)value[op.path[0]]=op.value;state={...state,value,revision:state.revision+1};emit();const command=ops.find(op=>op.path[0]==='command');if(command){const c=JSON.parse(command.value);setTimeout(()=>{const previous=JSON.parse(state.value.response);const status={...previous.status,nativeConnected:true,permissions:{accessibility:true,screenCapture:false},paused:c.op==='resume'?false:c.op==='pause'||c.op==='revoke'?true:previous.status.paused};state={...state,revision:state.revision+1,value:{...state.value,response:JSON.stringify({boot:'fixture-boot',ackNonce:c.nonce,outcome:'completed',status})}};emit()},30)}return true}};
  function useSnapshot(selector){return selector(React.useSyncExternalStore(form.subscribe,form.getSnapshot,form.getSnapshot))}
  const root=createRoot(document.getElementById('app'));const cleanups=[];
  const ctx={effect:fn=>{const result=fn();if(typeof result==='function')cleanups.push(result);return result},configForms:{get:()=>form,whileServed:(_ids,fn)=>fn()},slots:{inject:(_name,fn)=>fn(),register:(_spec,Component)=>{root.render(React.createElement(Component,{form,useSnapshot}));return()=>root.unmount()}}};
  plugin.apply(ctx);window.__whaleHarness={history,getState:()=>state,setStatus(status,label){const previous=JSON.parse(state.value.response);state={...state,revision:state.revision+1,value:{...state.value,response:JSON.stringify({...previous,status})}};document.getElementById('fixture-label').textContent='ISOLATED UI MOCK · '+label+' · SIMULATED helper/settings only · No real desktop connection or native validation';emit()},setReadOnly(){state={...state,writable:false};emit()}};`;
  const result = await build({ stdin: { contents: harness, resolveDir: process.cwd(), sourcefile: 'ui-harness.jsx', loader: 'jsx' }, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'process.env.NODE_ENV': '"development"' } });
  const js = result.outputFiles[0].text;
  const server = createServer((req, res) => { if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(js); } else if (['/assets/cursor-whale.png','/assets/cursor-whale-large.png'].includes(req.url)) { res.setHeader('content-type','image/png');readFile('.'+req.url).then(data=>res.end(data)); } else { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Whale isolated UI verification</title><style>body{margin:0;padding:24px;background:#f5f7fa}#fixture-label{font:12px system-ui;color:#586a80;max-width:920px;margin:0 auto 14px}</style><div id="fixture-label">ISOLATED UI TEST · Real client component / simulated settings transport · Not connected to your desktop</div><div id="app"></div><script src="/bundle.js"></script>'); } });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await chromium.launch({ executablePath: (process.env.WHALE_TEST_CHROMIUM || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1080 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('heading', { name: '电脑控制', exact: true }).waitFor();
    await page.getByText('显示选项', {exact:true}).click();
    const reportedLabel = '支持在目标窗口显示';
    const unknownLabel = '尚未取得组件报告';
    const cursorReport = { schema: 1, kind: 'software-overlay', visibility: 'target-window', independentNativePointer: false, runtimeValidated: false, source: 'helper-self-report' };
    const fixtureStatus = { paused: true, nativeConnected: true, permissions: null, browserConnections: 0 };
    const cursorChecks = [];
    const narrowCursorChecks = [];
    async function checkNarrowCursorLayout(label) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.locator('.wc-status-label').evaluate(label => {
        const row = label.parentElement;
        const status = row.querySelector('.wc-status-text');
        const range = document.createRange(); range.selectNodeContents(label);
        const labelStyle = getComputedStyle(label);
        const statusStyle = getComputedStyle(status);
        const rowRect = row.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        const statusRect = status.getBoundingClientRect();
        return { labelLines: range.getClientRects().length, labelShrink: labelStyle.flexShrink, labelWhiteSpace: labelStyle.whiteSpace,
          statusWhiteSpace: statusStyle.whiteSpace, statusHeight: statusRect.height, statusLineHeight: parseFloat(statusStyle.lineHeight),
          rowFits: labelRect.left >= rowRect.left && labelRect.right <= statusRect.left && statusRect.right <= rowRect.right + 1,
          pageFits: document.documentElement.scrollWidth <= window.innerWidth + 2 };
      });
      assert.equal(layout.labelLines, 1, `${label}: label remains on one line at 390px`);
      assert.equal(layout.labelShrink, '0', `${label}: label does not shrink`);
      assert.equal(layout.labelWhiteSpace, 'nowrap', `${label}: label does not wrap`);
      assert.equal(layout.statusWhiteSpace, 'normal', `${label}: right-hand status may wrap`);
      assert.ok(layout.statusHeight >= layout.statusLineHeight - 1, `${label}: status remains readable`);
      assert.equal(layout.rowFits, true, `${label}: status stays beside the label within the row`);
      assert.equal(layout.pageFits, true, `${label}: no horizontal overflow at 390px`);
      assert.deepEqual(await page.evaluate(() => window.__whaleHarness.history), [], `${label}: narrow layout submits no mutation or command`);
      narrowCursorChecks.push({ label, width: 390, ...layout });
      await page.setViewportSize({ width: 1280, height: 1080 });
    }
    async function checkCursor(label, status, reported = false) {
      await page.evaluate(({ status, label }) => window.__whaleHarness.setStatus(status, label), { status, label });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.getByText(reported ? reportedLabel : unknownLabel, { exact: true }).waitFor();
      assert.equal(await page.getByText(reportedLabel, { exact: true }).count(), reported ? 1 : 0, label);
      assert.equal(await page.getByText(unknownLabel, { exact: true }).count(), reported ? 0 : 1, label);
      assert.equal(await page.locator('.wc-status-label').innerText(), '后台可见性');
      assert.deepEqual(await page.evaluate(() => window.__whaleHarness.history), [], `${label}: status rendering must not mutate settings or submit commands`);
      cursorChecks.push(label);
    }
    await checkCursor('connected + exact candidate self-report', { ...fixtureStatus, cursor: cursorReport }, true);
    assert.equal(await page.locator('#wc-overlay option[value="companion"]').textContent(), '跟随操作目标');
    assert.equal(await page.locator('.wc-hero .wc-cursor').count(), 0, 'No whale branding in the header');
    await page.screenshot({ path: '.test-artifacts/ui/cursor-reported-mock.png', fullPage: true, animations: 'disabled' });
    await checkNarrowCursorLayout('candidate self-report');
    await checkCursor('connected + unknown cursor (overlay:true is not proof)', { ...fixtureStatus, overlay: true });
    await page.screenshot({ path: '.test-artifacts/ui/cursor-unknown-mock.png', fullPage: true, animations: 'disabled' });
    await checkNarrowCursorLayout('unknown cursor');
    for (const [label, cursor] of [
      ['null', null], ['boolean', true], ['string', 'software-overlay'], ['array', []], ['empty object', {}],
      ['generic overlay only', { overlay: true }], ['unknown visibility', { ...cursorReport, visibility: 'unknown' }],
    ]) await checkCursor(`malformed cursor: ${label}`, { ...fixtureStatus, cursor });
    for (const key of Object.keys(cursorReport)) {
      const missing = { ...cursorReport }; delete missing[key];
      await checkCursor(`missing cursor.${key}`, { ...fixtureStatus, cursor: missing });
      await checkCursor(`invalid cursor.${key}`, { ...fixtureStatus, cursor: { ...cursorReport, [key]: typeof cursorReport[key] === 'boolean' ? true : typeof cursorReport[key] === 'number' ? '1' : 'unknown' } });
    }
    for (const nativeConnected of [false, null, 'true', 1]) {
      await checkCursor(`nativeConnected=${JSON.stringify(nativeConnected)} with stale report`, { ...fixtureStatus, nativeConnected, cursor: cursorReport });
    }
    const { nativeConnected: _ignored, ...unconnected } = fixtureStatus;
    await checkCursor('missing nativeConnected with stale report', { ...unconnected, cursor: cursorReport });
    await checkCursor('reported before disconnect', { ...fixtureStatus, cursor: cursorReport }, true);
    await checkCursor('disconnected with stale report', { ...fixtureStatus, nativeConnected: false, cursor: cursorReport });
    await checkCursor('reconnected but helper has not reported', fixtureStatus);
    await checkCursor('reconnected and candidate reported again', { ...fixtureStatus, cursor: cursorReport }, true);
    await checkCursor('reset to disconnected mock for existing user-command tests', { ...fixtureStatus, nativeConnected: false });
    assert.equal(cursorChecks.length, 31, 'All 31 cursor status scenarios remain covered before any user-command simulation');
    assert.equal(await page.getByRole('button', { name: '恢复操作', exact: true }).isEnabled(), true);
    await page.getByText('控制与安全', {exact:true}).click();
    await page.getByRole('button',{name:'恢复操作',exact:true}).click();
    await page.getByText('已恢复操作。',{exact:true}).waitFor();
    const setPaused = reason => page.evaluate(reason => {
      const h=window.__whaleHarness;
      const status=JSON.parse(h.getState().value.response).status;
      h.setStatus({...status,paused:true,nativeConnected:true,pauseReason:reason},'paused host');
    }, reason);
    const writesBeforePause=await page.evaluate(()=>window.__whaleHarness.history.length);
    await setPaused('session-or-sleep');
    const stateChip=page.locator('.wc-state');
    for(const width of [390,1280]){
      await page.setViewportSize({width,height:900});
      await page.getByText('等待解锁或唤醒',{exact:true}).waitFor({timeout:2000});
      assert.ok(await page.getByRole('button',{name:'停止操作',exact:true}).isEnabled());
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
      await page.locator('.wc-header').screenshot({path:'.test-artifacts/ui/pause-reason-'+width+'.png'});
    }
    await setPaused('user');
    assert.equal(await stateChip.textContent(),'已暂停');
    assert.equal(await page.evaluate(()=>window.__whaleHarness.history.length),writesBeforePause);
    await page.getByRole('button', { name: '恢复操作', exact: true }).click();
    await page.getByText('已恢复操作。', { exact: true }).waitFor();
    assert.equal(await page.getByText('运行可用', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', {name:'恢复操作'}).count(), 0);
    assert.equal(await page.getByRole('button',{name:'申请辅助功能'}).count(),0);
    assert.equal(await page.getByRole('button',{name:'申请屏幕录制'}).count(),1);
    await page.getByRole('button', { name: '停止操作', exact: true }).click();
    await page.getByText('已暂停并清除授权', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button',{name:'恢复操作',exact:true}).isEnabled(),true);
    await page.getByRole('button', { name: '检查权限', exact: true }).click();
    await page.getByText('权限状态已更新。', { exact: true }).waitFor();
    await page.getByText('浏览器调试连接',{exact:true}).click();
    await page.getByLabel('本机浏览器调试地址',{exact:true}).fill('https://example.org');
    await page.getByRole('button',{name:'保存',exact:true}).click();
    assert.equal(await page.getByLabel('本机浏览器调试地址',{exact:true}).getAttribute('aria-invalid'),'true');
    await page.getByLabel('本机浏览器调试地址', { exact: true }).fill('http://127.0.0.1:9222');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const history = await page.evaluate(() => window.__whaleHarness.history); assert.ok(history.some(ops => ops.some(op => op.path[0] === 'browserEndpoint' && op.value === 'http://127.0.0.1:9222')));
    await page.getByLabel('减少动态效果', { exact: false }).check();
    assert.equal(await page.locator('.wc-cursor').evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.getByRole('button', { name: '检查权限', exact: true }).focus(); await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY');
    await page.screenshot({ path: '.test-artifacts/ui/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('h1').count(), 1, 'The narrow UI renders one settings page');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2); assert.equal(overflow, false, 'No horizontal overflow on narrow UI');
    // Capture the complete narrow layout in one rendered viewport: this Chrome build
    // can repeat compositor tiles when fullPage captures immediately follow a resize.
    const narrowHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    assert.ok(narrowHeight < 10000, 'The fixture remains bounded');
    await page.setViewportSize({ width: 390, height: narrowHeight });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: '.test-artifacts/ui/mobile.png', fullPage: false, animations: 'disabled' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.__whaleHarness.setReadOnly());
    assert.equal(await page.getByRole('button', { name: '检查权限', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
    await writeFile('.test-artifacts/ui/result.json', JSON.stringify({ passed: true, scope: 'Real client source, isolated simulated configForms transport. Does NOT prove integration with running DSH GUI.', limitations: 'All helper connection/cursor states and acknowledgements are simulated. No native helper, native preview, permissions, real focus, positioning or background visibility was exercised.', cursorChecks, narrowCursorChecks, evidence: ['cursor-reported-mock.png', 'cursor-unknown-mock.png', 'desktop.png', 'mobile.png'], checks: ['render', 'strict cursor capability contract', 'cursor status rendering has no mutate/command side effects', 'enable', 'resume ack', 'stop/disable ack', 'diagnose ack', 'endpoint save', 'reduced motion', 'keyboard focus', 'narrow layout', 'read-only', 'no page errors'] }, null, 2));
    t.diagnostic(`Preview evidence: ${resolve('.test-artifacts/ui/desktop.png')}`);
  } finally {
    try { await browser?.close(); }
    finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
});
