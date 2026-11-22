// A presentation belongs to one DSH-created, muted tab and one observed document.
let current = null;
let cancelledDocument;
let operations = Promise.resolve();
const focusCommand = 'Emulation.setFocusEmulationEnabled';

function serial(work) {
  const next = operations.then(work);
  operations = next.catch(() => {});
  return next;
}

function matches(tab, lease) {
  return !tab.incognito && tab.id === lease.tabId && tab.windowId === lease.windowId &&
    tab.url === lease.url && (!tab.pendingUrl || tab.pendingUrl === lease.url) &&
    tab.mutedInfo?.muted === true && tab.mutedInfo.reason === 'extension' &&
    tab.mutedInfo.extensionId === chrome.runtime.id;
}

function videoURL(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://www.bilibili.com' && !url.username && !url.password &&
      /^\/(?:zh-(?:Hans|Hant)\/)?video\/BV[A-Za-z0-9]+\/?$/.test(url.pathname);
  } catch { return false; }
}

// Runs only in the specific top-level document that supplied the validated video ref.
function inspectDocument(url, token) {
  if (location.href !== url || location.origin !== 'https://www.bilibili.com') return {stop:'navigation'};
  const visible = node => {
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== 'hidden';
  };
  const nav = performance.getEntriesByType('navigation')[0];
  const text = (document.title+'\n'+(document.body?.innerText ?? '')).slice(0,40000);
  if ((nav?.responseStatus && nav.responseStatus >= 400) ||
      /访问受限|访问出错|安全验证|完成验证码|安全风控|HTTP\s*412|扫码登录|扫描二维码登录|密码登录|短信登录|登录后(?:才能|方可|继续)?(?:观看|播放)|试看(?:已)?结束|付费观看|sign in to (?:watch|continue)/i.test(text) ||
      [...document.querySelectorAll('input[type=password],input[autocomplete="one-time-code"],iframe[src*="captcha"],iframe[src*="geetest"]')].some(visible)) return {stop:'gate'};
  const players = [...document.querySelectorAll('video')].filter(visible);
  if (players.length !== 1 || players[0].error) return {stop:'player'};
  const player = players[0];
  let state = globalThis.__dshPresentationPlayer;
  if (!state || state.token !== token) {
    state?.events.abort();
    state = {token,player,source:player.currentSrc,ended:false,events:new AbortController()};
    globalThis.__dshPresentationPlayer = state;
    player.addEventListener('ended',() => { state.ended=true; },{once:true,signal:state.events.signal});
  }
  if (state.player !== player || (state.source && player.currentSrc !== state.source)) return {stop:'player'};
  if (!state.source && player.currentSrc) state.source=player.currentSrc;
  if (state.ended || player.ended) return {stop:'ended'};
  return {time:player.currentTime,paused:player.paused,hidden:document.hidden};
}

async function inspect(lease) {
  const [row] = await chrome.scripting.executeScript({
    target:{tabId:lease.tabId,documentIds:[lease.documentId]},world:'ISOLATED',
    func:inspectDocument,args:[lease.url,lease.token]
  });
  if (!row?.result) throw Error('无法确认视频文档');
  return row.result;
}


function stop(lease) {
  if (!lease || lease.closed) return;
  lease.closed = true;
  clearInterval(lease.monitor);
  if (current === lease) current = null;
  serial(async () => {
    if (!lease.attached) return;
    const target = {tabId: lease.tabId};
    try {
      const tab = await chrome.tabs.get(lease.tabId);
      if (tab.url === lease.url && !tab.pendingUrl) {
        await chrome.debugger.sendCommand(target, focusCommand, {enabled:false});
      }
    } catch { /* The tab or its debugging session may already be gone. */ }
    finally {
      await chrome.debugger.detach(target).catch(() => {});
      lease.attached = false;
    }
  });
}

export function endPresentation() { stop(current); }

export function presentationState(tabId) {
  if (current?.ready && current.tabId === tabId) {
    return {active:true,version:chrome.runtime.getManifest().version};
  }
}

async function monitor(lease) {
  if (lease.closed) return;
  if (Date.now() - lease.lastInspection > 8500) { stop(lease); return; }
  if (lease.checking) return;
  lease.checking = true;
  try {
    const state = await inspect(lease);
    if (lease.closed) return;
    lease.lastInspection = Date.now();
    if (state.stop || state.hidden || (lease.playing && state.paused)) { stop(lease); return; }
    if (!state.paused && state.time > lease.time) {
      lease.playing = true;
      lease.lastProgress = lease.lastInspection;
    }
    lease.time = state.time;
    if (lease.lastInspection - lease.lastProgress > 30000) stop(lease);
  } catch { stop(lease); }
  finally { lease.checking = false; }
}

export async function preparePresentation(tab, documentId, validate) {
  if (!documentId || tab.active || !videoURL(tab.url) || documentId === cancelledDocument) return false;
  const existing = current;
  if (existing?.ready && existing.documentId === documentId && matches(tab, existing)) {
    const state = await inspect(existing);
    validate();
    if (existing.closed || state.stop) {
      stop(existing);
      throw Object.assign(Error('当前视频无法继续后台播放'), {notDispatched:true});
    }
    return true;
  }
  endPresentation();
  const lease = {tabId:tab.id,windowId:tab.windowId,url:tab.url,documentId,token:crypto.randomUUID(),
    attached:false,ready:false,closed:false,playing:false,checking:false,time:0,
    lastInspection:Date.now(),lastProgress:Date.now()};
  if (!matches(tab, lease)) return false;
  current = lease;
  try {
    const before = await inspect(lease);
    validate();
    if (before.stop) throw Object.assign(Error(before.stop === 'gate' ? '页面有登录、验证或观看限制' : '视频已结束或播放器已变化'), {notDispatched:true});
    const ready = await serial(async () => {
      const target = {tabId:lease.tabId};
      const fresh = await chrome.tabs.get(lease.tabId);
      validate();
      if (lease.closed || fresh.active || !matches(fresh,lease)) return false;
      try { await chrome.debugger.attach(target,'1.3'); } catch { return false; }
      lease.attached = true;
      const attached = await chrome.tabs.get(lease.tabId);
      validate();
      if (lease.closed || attached.active || !matches(attached,lease)) return false;
      await chrome.debugger.sendCommand(target,focusCommand,{enabled:true});
      return !lease.closed;
    });
    if (!ready) { stop(lease); return false; }
    const after = await inspect(lease);
    validate();
    if (lease.closed || after.stop || after.hidden) throw Error('视频任务未就绪或出现观看限制');
    lease.ready = true;
    lease.lastInspection = lease.lastProgress = Date.now();
    lease.monitor = setInterval(() => void monitor(lease),900);
    return true;
  } catch (error) { stop(lease); throw error; }
}

chrome.tabs.onUpdated.addListener((id, change, tab) => {
  const lease = current;
  if (lease?.tabId === id && (change.status === 'loading' || !matches(tab,lease))) stop(lease);
});
chrome.tabs.onRemoved.addListener(id => { if (current?.tabId === id) endPresentation(); });
chrome.tabs.onReplaced.addListener((_newId,oldId) => { if (current?.tabId === oldId) endPresentation(); });
chrome.debugger.onDetach.addListener((target, reason) => {
  const lease = current;
  if (lease?.tabId !== target.tabId || !lease.attached || lease.closed) return;
  if (reason === 'canceled_by_user') cancelledDocument = lease.documentId;
  lease.attached = false;
  stop(lease);
});
