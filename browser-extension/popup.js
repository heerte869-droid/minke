const byId = id => document.getElementById(id);
const feedback = document.querySelector('output');
const here = byId('here'), view = byId('view'), stop = byId('stop');
let snapshot, busy = false, revision = 0, timer;

function setText(node, value) {
  if (node.textContent !== value) node.textContent = value;
}

function render(state) {
  byId('billing').hidden=!state.billingAccessRequested;
  const shared = state.connected || state.connecting;
  const focused = document.activeElement;
  document.body.dataset.on = String(state.connected);
  setText(byId('state'), state.activity || (state.connected ? '正在共享' : state.connecting ? '正在连接' : '未共享'));
  setText(byId('context'), shared ? '任务标签页' : '当前标签页');
  const label = state.title || state.site || (shared ? '共享的标签页' : '请选择 HTTPS 网页');
  setText(byId('title'), label);
  byId('title').title = label;
  setText(byId('site'), state.site || '');
  here.hidden = shared;
  view.hidden = !state.connected || state.here;
  stop.hidden = !shared;
  here.disabled = busy || !state.shareable || shared;
  view.disabled = busy || !state.connected;
  stop.disabled = busy;
  if (focused instanceof HTMLButtonElement && focused.hidden) {
    [here,view,stop].find(button => !button.hidden && !button.disabled)?.focus();
  }
}

async function refresh() {
  const request = ++revision;
  try {
    const state = await chrome.runtime.sendMessage({op:'status'});
    if (request !== revision || document.hidden) return;
    if (!state || state.error) throw Error(state?.error || '扩展未响应，请重新打开弹窗。');
    snapshot = state;
    render(state);
    if (feedback.dataset.kind === 'connection') feedback.textContent = '';
  } catch (error) {
    if (request !== revision || document.hidden) return;
    snapshot = undefined;
    for (const button of [here,view,stop]) button.disabled = true;
    byId('state').textContent = '连接中断';
    document.body.dataset.on = 'false';
    feedback.dataset.kind = 'connection';
    feedback.textContent = error.message;
  }
}

function schedule() {
  clearTimeout(timer);
  if (!document.hidden && !busy) timer = setTimeout(poll,600);
}
async function poll() {
  if (document.hidden || busy) return;
  const request = revision + 1;
  await refresh();
  if (request === revision) schedule();
}

async function act(op) {
  if (busy || !snapshot) return;
  const {id, generation} = snapshot;
  const initiatingButton = document.activeElement;
  busy = true;
  ++revision;
  clearTimeout(timer);
  feedback.textContent = '';
  render(snapshot);
  try {
    const reply = await chrome.runtime.sendMessage({op,tabId:id,generation});
    if (!reply?.ok) throw Error(reply?.error || '操作未完成，请重试。');
  } catch (error) {
    feedback.dataset.kind = 'action';
    feedback.textContent = error.message;
  } finally {
    busy = false;
    await refresh();
    if (!document.hidden && initiatingButton instanceof HTMLButtonElement && initiatingButton.hidden &&
        document.activeElement===document.body) {
      [here,view,stop].find(button=>!button.hidden && !button.disabled)?.focus();
    }
    schedule();
  }
}

byId('billing').onclick=async()=>{
  try{
    const granted=await chrome.permissions.request({origins:['https://platform.openai.com/*']});
    feedback.dataset.kind='action';feedback.textContent=granted?'已授权，可在 DSH 中读取。':'未获得账单站点权限。';
  }catch{feedback.dataset.kind='action';feedback.textContent='授权未完成，请重试。';}
  await refresh();
};
here.onclick = () => act('connect');
view.onclick = () => act('view');
stop.onclick = () => act('stop');
document.addEventListener('visibilitychange',() => {
  ++revision;
  clearTimeout(timer);
  if (!document.hidden) void poll();
});
void poll();
