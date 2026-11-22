import {groupNewTab,releaseGroups} from './task-tabs.js';
import {operate} from './page.js';
import {endPresentation,preparePresentation,presentationState} from './playback-presentation.js';
const BILI=['https://www.bilibili.com','https://search.bilibili.com'];
let generation=0, recovering=false, activity=null;
const pending=new Set();let link=null, target=null, connected=false;
function allowed(value){
  try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(target?.bili?BILI.includes(u.origin):u.origin===target?.origin)}catch{return false}
}
async function setIcon(id,active){
  await Promise.allSettled([chrome.action.setBadgeText({tabId:id,text:active?'•':''}),chrome.action.setBadgeBackgroundColor({tabId:id,color:'#7047BA'}),chrome.action.setTitle({tabId:id,title:active?'DSH 正在共享此页 · 查看状态':'用 DSH 共享此页'})]);
}
function clearPage(owner,callId){
  if(!owner)return;
  owner.visual=null;owner.visualEpoch=(owner.visualEpoch||0)+1;
  void chrome.scripting.executeScript({injectImmediately:true,target:{tabId:owner.id},world:'ISOLATED',func:(key,id,epoch)=>{
    globalThis.__dshWhaleCursor?.disarm(key,epoch);
    if(globalThis.__dshWhaleShareKey!==key)return;
    if(id && globalThis.__dshWhaleFlight!==id)return;
    globalThis.__dshWhaleFlight=null;
    globalThis.__dshWhaleClear?.();
    globalThis.__dshWhaleMarker?.remove();
  },args:[owner.key,callId??null,owner.visualEpoch]}).catch(()=>{});
}
function disconnect(forget=true){
  endPresentation();
  if(forget){generation++;void chrome.storage.session.remove("sharedTab").catch(()=>{})}
  clearPage(target);activity=null;
  const old=link,prev=target;link=null;target=null;connected=false;pending.clear();old?.disconnect();
  if(prev)void setIcon(prev.id,false);
  if(forget && prev)void releaseGroups(prev.members);
}
function ownsMute(tab){
  const mute=tab.mutedInfo;
  return mute?.muted===true && mute.reason==='extension' && mute.extensionId===chrome.runtime.id;
}
async function metadata(){
  if(!target)throw Error('没有共享标签页');const t=await chrome.tabs.get(target.id);
  if(!t.url||!allowed(t.url))throw Error('标签页已离开共享站点，请在新站点点击扩展图标');
  const w=await chrome.windows.get(t.windowId);
  const member=target?.members.find(entry=>entry.id===t.id);
  return{extensionVersion:chrome.runtime.getManifest().version,tabId:String(t.id),url:t.url,active:t.active,independentSearchSupported:target.bili&&member?.createdByDSH===true,
    taskTabOwnsMute:target.bili&&member?.createdByDSH===true&&ownsMute(t),tabMuted:t.mutedInfo?.muted===true,taskTabsSupported:true,formControlsSupported:true,
    inTaskGroup:member?.groupId!=null && member.groupId===t.groupId && member.windowId===t.windowId,windowFocused:w.focused,windowBounds:{x:w.left,y:w.top,w:w.width,h:w.height},title:t.title?.slice(0,240)||''}
}
const imgs=new Map();
async function png(variant){const k=variant==='mini'?'mini':'large';if(!imgs.has(k)){const bytes=new Uint8Array(await(await fetch(chrome.runtime.getURL('cursor-'+k+'.png'))).arrayBuffer());let raw='';for(let i=0;i<bytes.length;i+=8192)raw+=String.fromCharCode(...bytes.subarray(i,i+8192));imgs.set(k,'data:image/png;base64,'+btoa(raw))}return imgs.get(k)}

function visualSettings(raw){
  if(!raw||!['companion','clean','hidden'].includes(raw.mode))return null;
  return {mode:raw.mode,variant:raw.variant==='mini'?'mini':'large',
    size:Math.max(20,Math.min(128,Number(raw.size)||28)),hold:Math.max(300,Math.min(15000,Number(raw.hold)||1800))};
}
function updateVisual(owner,raw){
  const settings=visualSettings(raw);
  if(!settings)return false;
  if(settings.mode==='hidden'){if(owner.visual)clearPage(owner);return false}
  if(JSON.stringify(settings)===JSON.stringify(owner.visual))return false;
  owner.visual=settings;owner.visualEpoch=(owner.visualEpoch||0)+1;
  return true;
}
async function prepareLayer(owner,tab){
  if(target!==owner||!owner?.visual||!allowed(tab.url))return;
  const epoch=owner.visualEpoch,style=owner.visual;
  const valid=()=>target===owner&&owner.visualEpoch===epoch&&owner.visual===style;
  const [doc]=await chrome.scripting.executeScript({injectImmediately:true,target:{tabId:owner.id},world:'ISOLATED',files:['cursor-layer.js']});
  if(!valid()||!doc?.documentId)return;
  const data=doc.result?.cached?.includes(style.variant)?null:await png(style.variant);
  if(!valid())return;
  await chrome.scripting.executeScript({injectImmediately:true,target:{tabId:owner.id,documentIds:[doc.documentId]},world:'ISOLATED',
    func:settings=>globalThis.__dshWhaleCursor?.bind(settings),
    args:[{...style,data,hotspot:style.variant==='mini'?48/512:88/1254,key:owner.key,epoch,url:tab.url,active:tab.active}]});
}
chrome.tabs.onUpdated.addListener((id,change,tab)=>{
  const owner=target;
  if(owner?.id===id&&owner.visual?.mode==='companion'&&(change.status==='complete'||change.url)&&allowed(tab.url)){
    void prepareLayer(owner,tab).catch(()=>{});
  }
});

async function saveShare(owner){
  if(target===owner)await chrome.storage.session.set({sharedTab:{id:owner.id,origin:owner.origin,members:owner.members,groupTitle:owner.groupTitle}});
}
async function groupCreated(owner,tab,valid){
  await groupNewTab(owner,tab,()=>target===owner && valid()).catch(()=>{});
  await saveShare(owner);
}
async function listTaskTabs(owner,sourceUrl){
  const origin=new URL(sourceUrl).origin;
  const rows=await Promise.all(owner.members.map(async member=>{
    const tab=await chrome.tabs.get(member.id).catch(()=>null);
    if(!tab || (tab.pendingUrl && !allowed(tab.pendingUrl)))return null;
    if(allowed(tab.url))return {tabId:String(tab.id),current:tab.id===owner.id,selectedInWindow:tab.active,
      ...(new URL(tab.url).origin===origin?{title:tab.title?.slice(0,200)||''}:{})};
    // Chrome may not expose the new URL immediately. Keep the ID we just
    // created discoverable, without reading or reporting any uncommitted title.
    if(member.openingOrigin && tab.status==='loading' && (!tab.url||tab.url==='about:blank'))
      return {tabId:String(tab.id),loading:true,current:tab.id===owner.id};
    return null;
  }));
  return rows.filter(Boolean);
}
async function selectTaskTab(owner,id,valid){
  const member=owner.members.find(entry=>String(entry.id)===id);
  if(!member)throw Error('请选择当前任务已打开的标签');
  let tab;
  const deadline=Date.now()+4800;
  for(;;){
    valid();
    tab=await chrome.tabs.get(member.id);
    valid();
    if(target!==owner || (tab.pendingUrl && !allowed(tab.pendingUrl)))throw Error('任务标签已变化');
    if(allowed(tab.url) && (!tab.pendingUrl || tab.url===tab.pendingUrl))break;
    if(!member.openingOrigin || Date.now()>=deadline || (tab.url && tab.url!=='about:blank' && !allowed(tab.url)))throw Error('任务页尚未就绪或已离开共享站点');
    await new Promise(resolve=>setTimeout(resolve,80));
  }
  if(tab.id!==owner.id){
    endPresentation();
    const next={...owner,id:tab.id,key:crypto.randomUUID()};
    clearPage(owner);target=next;generation++;
    await Promise.all([setIcon(owner.id,false),setIcon(next.id,true),saveShare(next)]);
    if(next.visual?.mode==='companion')void prepareLayer(next,tab).catch(()=>{});
  }
  return {tabId:String(tab.id),requiresObservation:true};
}

async function runInPage(input,tabId,documentId){
  const target=documentId?{tabId,documentIds:[documentId]}:{tabId};
  const [row]=await chrome.scripting.executeScript({injectImmediately:true,target,world:'ISOLATED',func:operate,args:[input]});
  if(!row?.result||row.error)throw Error(row?.error?.message||'页面未返回结果，请观察当前状态');
  if(row.result.failure){const e=Error(row.result.failure);e.notDispatched=row.result.notDispatched===true;throw e}
  return row;
}
async function execute(m,port){
  const valid=()=>{if(port!==link||!pending.has(m.id)||!Number.isFinite(m.deadline)||Date.now()>=m.deadline)throw Error('任务已停止或过期')};
  valid();const owner=target,meta=await metadata();valid();
  const changed=updateVisual(owner,m.args.appearance);
  if(m.op==='meta'){
    // Metadata must not wait for document_idle, page rendering or cursor decoding.
    if(changed&&owner.visual?.mode==='companion')void prepareLayer(owner,meta).catch(()=>{});
    return meta;
  }
  if(changed&&owner.visual?.mode==='companion')await prepareLayer(owner,meta).catch(()=>{});
  valid();
  if(meta.tabId!==m.args.tabId||meta.url!==m.args.url)throw Error('页面已变化，请重新观察');
  if(['startBackgroundSearch','navigate','pauseVideo'].includes(m.op))endPresentation();
  if(m.op==='startBackgroundSearch'){
    if(!meta.independentSearchSupported || typeof m.args.query!=='string' || !m.args.query.trim() || m.args.query.length>160)
      throw Error('后台搜索需要当前任务和有效的关键词');
    const source=await chrome.tabs.get(owner.id);
    valid();
    if(target!==owner || source.incognito || source.url!==meta.url || (source.pendingUrl && source.pendingUrl!==meta.url))
      throw Error('来源标签已变化，请重新观察');
    const destination=new URL('/all',BILI[1]);
    destination.searchParams.set('keyword',m.args.query.trim());
    const child=await chrome.tabs.create({windowId:source.windowId,active:false,url:destination.href});
    if(target!==owner)throw Error('共享任务已切换');
    owner.members.push({id:child.id,openingOrigin:destination.origin,createdByDSH:true});
    await groupCreated(owner,child,()=>link===port && pending.has(m.id) && Date.now()<m.deadline);
    valid();
    return selectTaskTab(owner,String(child.id),valid);
  }
  if(m.op==='listTaskTabs'){const tabs=await listTaskTabs(owner,meta.url);valid();return {tabs}}
  if(m.op==='selectTaskTab')return selectTaskTab(owner,m.args.targetTabId,valid);
  if(!['openLinkTab','observe','verifyPlayback','click','fill','selectOption','setChecked','submit','follow','navigate','play','pauseVideo'].includes(m.op))throw Error('不支持的操作');
  const protectSelected=m.args.backgroundSearch===true && meta.independentSearchSupported && ['navigate','follow'].includes(m.op);
  if(protectSelected && meta.active)throw Object.assign(Error('正在查看任务页，已保留当前页面'),{notDispatched:true});
  activity={at:Date.now(),id:m.id,label:['observe','verifyPlayback'].includes(m.op)?'正在浏览':'正在操作'};
  const input={...m.args,callId:m.id,shareKey:target.key,tabActive:meta.active,op:m.op==='openLinkTab'?'follow':m.op,deadline:m.deadline,origin:new URL(meta.url).origin};
  if(!['observe','verifyPlayback','navigate'].includes(m.op)&&m.args.showCursor){
    updateVisual(owner,{mode:m.args.cursorMode||owner.visual?.mode||'clean',variant:m.args.variant,size:m.args.size,hold:m.args.cursorHold});
    await prepareLayer(owner,meta).catch(()=>{});
  }
  const tabId=Number(meta.tabId);
  const member=owner.members.find(entry=>entry.id===tabId);
  let documentId,tabMuteDispatched=false,row;
  let tabStayedMuted=meta.tabMuted;
  const checkTabSound=(id,change)=>{if(id===tabId&&change.mutedInfo?.muted===false)tabStayedMuted=false};
  if(m.op==='verifyPlayback')chrome.tabs.onUpdated.addListener(checkTabSound);
  try{
    valid();
    if(m.op==='play' && input.useTaskTabMute===true){
      const refuse=()=>Object.assign(Error('此续播方式需要由 DSH 静音的后台任务标签'),{notDispatched:true});
      if(!meta.taskTabOwnsMute || meta.active || !input.expectedPlayerId || input.muted===true)throw refuse();
      const check=await runInPage({...input,op:'checkVideoMute'},tabId);
      const tab=await chrome.tabs.get(tabId);
      valid();
      if(target!==owner || !check.documentId || !check.result.elementMuted || tab.active || !ownsMute(tab) ||
          tab.url!==meta.url || (tab.pendingUrl && tab.pendingUrl!==meta.url))throw refuse();
      documentId=check.documentId;
    }
    if(m.op==='play' && input.muted===true && (!owner.bili || member?.createdByDSH===true)){
      const check=await runInPage({...input,op:'checkVideoMute'},tabId);
      valid();
      documentId=check.documentId;
      let tab=await chrome.tabs.get(tabId);
      valid();
      if(!documentId||target!==owner||tab.url!==meta.url||(tab.pendingUrl&&tab.pendingUrl!==meta.url))throw Error('任务页已变化，请重新观察');
      if((!owner.bili || !check.result.elementMuted) && !tab.mutedInfo?.muted){
        tabMuteDispatched=true;
        tab=await chrome.tabs.update(tabId,{muted:true});
        if(!tab?.mutedInfo?.muted)throw Error('未确认任务标签静音');
      }
      input.muted=check.result.elementMuted;
      // Keep the audio track active on an ordinary shared video. Silence is supplied by Chrome.
      if(!owner.bili && ownsMute(tab)){
        input.silentViaTab=true;
        input.muted=false;
      }
      if(owner.bili && !tab.active && ownsMute(tab)){
        const present=await preparePresentation(tab,documentId,()=>{
          valid();
          if(target!==owner)throw Error('任务已停止或切换');
        });
        if(present)input.muted=true;
      }
    }
    valid();
    if(target!==owner)throw Error('任务已变化，请重新观察');
    row=await runInPage(input,tabId,documentId);
  }catch(e){if(tabMuteDispatched)e.notDispatched=false;throw e}
  finally{if(m.op==='verifyPlayback')chrome.tabs.onUpdated.removeListener(checkTabSound)}
  if(input.showCursor && port===link)void syncMarkerVisibility(target);
  if(row.result.navigate){
    valid();
    if(target!==owner || !allowed(row.result.navigate))throw Error('请先共享该目标站点');
    if(m.op==='openLinkTab'){
      const origin=new URL(row.result.navigate).origin;
      if(!await chrome.permissions.contains({origins:[origin+'/*']}))throw Error('此授权只适用于当前标签，请在原标签打开链接');
      const current=await chrome.tabs.get(owner.id);
      valid();
      if(target!==owner || current.url!==meta.url)throw Error('来源标签已变化');
      const child=await chrome.tabs.create({windowId:current.windowId,active:false,url:row.result.navigate});
      valid();
      if(target!==owner)throw Error('共享任务已切换');
      owner.members.push({id:child.id,openingOrigin:origin,createdByDSH:true});
      await groupCreated(owner,child,()=>pending.has(m.id) && link===port && Date.now()<m.deadline);
      return {openedTabId:String(child.id),sourceTabId:String(owner.id),requiresObservation:true};
    }
    const destination = new URL(row.result.navigate);
    const update = {url: destination.href};
    if (m.op === 'follow' && input.muteTaskTab === true && member?.createdByDSH === true &&
        destination.origin === BILI[0] && /\/video\/BV[A-Za-z0-9]+(?:\/|$)/.test(destination.pathname)) {
      const current = await chrome.tabs.get(tabId);
      valid();
      if (target !== owner || current.url !== meta.url || (current.pendingUrl && current.pendingUrl !== meta.url)) {
        throw Error('来源标签已变化，请重新观察');
      }
      // Set silence before the site creates its player. Preserve an existing mute and its owner.
      if (!current.mutedInfo?.muted) update.muted = true;
    }
    if(protectSelected){
      const current=await chrome.tabs.get(tabId);
      valid();
      if(target!==owner || current.active || current.url!==meta.url || (current.pendingUrl && current.pendingUrl!==meta.url))
        throw Object.assign(Error('任务页已切换，导航未发送'),{notDispatched:true});
    }
    await chrome.tabs.update(tabId, update);
    return {requiresObservation:true};
  }
  if(m.op==='observe'||m.op==='verifyPlayback'){
    const tab=await chrome.tabs.get(tabId);
    valid();
    if(target!==owner || tab.url!==meta.url)throw Error('任务页已变化，请重新观察');
    const tabMuted=tab.mutedInfo?.muted===true;
    row.result.tabActive=tab.active;row.result.tabMuted=tabMuted;
    row.result.extensionVersion=chrome.runtime.getManifest().version;
    const presentation=presentationState(tabId);
    if(presentation)row.result.backgroundPresentation=presentation;
    const videos=m.op==='observe'?row.result.videos:[row.result];
    for(const v of videos){v.elementMuted=v.muted===true;v.muted=v.elementMuted||tabMuted}
    if(m.op==='verifyPlayback')row.result.silenceVerified=row.result.elementStayedMuted||(tabStayedMuted&&tabMuted);
  }
  return row.result;
}
async function connectTab(tab,restore=false,members=[{id:tab.id}],groupTitle=null){
  if(!tab?.id||!tab.url?.startsWith('https://'))throw Error('请在 HTTPS 网页点击扩展图标');
  if(connected&&target?.id===tab.id)return;
  disconnect(!restore);const origin=new URL(tab.url).origin;target={id:tab.id,origin,members,groupTitle,bili:BILI.includes(origin),key:crypto.randomUUID()};
  const port=chrome.runtime.connectNative('local.dsh.whale_browser');link=port;
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{if(link===port)disconnect();reject(Error('请打开 DSH 的电脑控制插件'))},7000);
    port.onDisconnect.addListener(()=>{const reason=chrome.runtime.lastError?.message;clearTimeout(timer);if(link===port){const wasConnected=connected,ticket=generation;disconnect(false);if(wasConnected)void restoreTab(ticket)}reject(Error(reason||'已断开'))});
    port.onMessage.addListener(async msg=>{
      if(port!==link)return;
      if(msg.type==='released'){clearTimeout(timer);disconnect();reject(Error('共享已结束'));return}
      if(msg.type==='paired'){clearTimeout(timer);connected=true;await saveShare(target);await setIcon(tab.id,true);resolve();return}
      if(msg.type==='unavailable'){clearTimeout(timer);disconnect();reject(Error(msg.error));return}
      if(msg.type==='clear'){endPresentation();pending.clear();clearPage(target);activity=null;return}
       if(msg.type==='cancel'){endPresentation();pending.delete(msg.id);clearPage(target,msg.id);return}
      if(msg.type!=='request'||pending.size>2)return;pending.add(msg.id);
      try{const result=await execute(msg,port);if(link===port&&pending.has(msg.id))port.postMessage({type:'reply',id:msg.id,result})}
      catch(e){if(link===port&&pending.has(msg.id))port.postMessage({type:'reply',id:msg.id,error:String(e.message).slice(0,260),notDispatched:e.notDispatched===true})}
      finally{pending.delete(msg.id);if(activity?.id===msg.id){activity={...activity,at:Date.now(),label:activity.label==='正在操作'?'刚刚操作':'刚刚浏览'}}}
    });
  });
}
async function restoreTab(ticket){
  if(recovering||link||generation!==ticket)return;recovering=true;
  try{for(const delay of [250,1000,3000]){await new Promise(r=>setTimeout(r,delay));if(link||generation!==ticket)return;
    const {sharedTab}=await chrome.storage.session.get('sharedTab');if(!sharedTab)return;
    const tab=await chrome.tabs.get(sharedTab.id).catch(()=>null);
    if(!tab?.url){await chrome.storage.session.remove('sharedTab');return}
    const origin=new URL(tab.url).origin;if(origin!==sharedTab.origin&&!(BILI.includes(origin)&&BILI.includes(sharedTab.origin))){await chrome.storage.session.remove('sharedTab');return}
    if(generation!==ticket||link)return;try{await connectTab(tab,true,sharedTab.members,sharedTab.groupTitle);return}catch{}
  }}finally{recovering=false}
}
async function syncMarkerVisibility(owner){
  if(!owner)return;
  try {
    const tab=await chrome.tabs.get(owner.id);
    if(target!==owner || !allowed(tab.url))return;
    if(tab.active&&owner.visual?.mode==='companion')await prepareLayer(owner,tab);
    await chrome.scripting.executeScript({injectImmediately:true,target:{tabId:owner.id},world:'ISOLATED',
      func:(key,active)=>globalThis.__dshWhaleCursor?.setActive(key,active),
      args:[owner.key,tab.active]});
  } catch { /* The selected document can navigate during an activation event. */ }
}
chrome.tabs.onActivated.addListener(()=>{
  if(target)void syncMarkerVisibility(target);
  else if(!link)void restoreTab(generation);
});

chrome.runtime.onInstalled.addListener(()=>{
  chrome.contextMenus.removeAll(()=>chrome.contextMenus.create({id:'stop-sharing',title:'停止共享',contexts:['action']}));
});
chrome.contextMenus.onClicked.addListener(item=>{
  if(item.menuItemId==='stop-sharing'){cancelLaunch();disconnect()}
});
chrome.tabs.onRemoved.addListener(id=>{
  if(id===target?.id){disconnect();return}
  if(target?.members.some(member=>member.id===id)){
    target.members=target.members.filter(member=>member.id!==id);void saveShare(target).catch(()=>{});
  }
});
async function popupStatus() {
  const owner=target, epoch=generation;
  const [current]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
  const tab=owner ? await chrome.tabs.get(owner.id).catch(()=>null) : current;
  if(epoch!==generation||owner!==target) return popupStatus();
  if(owner && (!tab || (tab.status==='complete' && tab.url && tab.url!=='about:blank' && !allowed(tab.url)))) {
    disconnect();
    return popupStatus();
  }
  let url;
  try {url=new URL(tab?.url)} catch {}
  const usable=url?.protocol==='https:'&&!url.username&&!url.password;
  const showTitle=usable && (!owner || allowed(tab.url));
  const recent=activity && Date.now()-activity.at<3600;
  return {
    generation:epoch, id:tab?.id ?? null, connected, connecting:Boolean(owner&&!connected),
    shareable:Boolean(usable), here:Boolean(connected&&current?.id===owner?.id),
    site:showTitle ? url.hostname : '', title:showTitle ? tab.title?.slice(0,240) || '' : '',
    activity:connected && recent ? activity.label : '',
  };
}

async function popupAction(m) {
  if(m.op==='status')return popupStatus();
  if(m.generation!==undefined && m.generation!==generation)throw Error('共享状态已变化，请查看当前标签页。');
  if(m.op==='stop'){
    if(m.tabId!=null && m.tabId!==target?.id)throw Error('共享任务已变化，请查看当前标签页');
    cancelLaunch();disconnect();return {ok:true};
  }
  if(m.op==='view'){
    const owner=target;
    if(!owner||owner.id!==m.tabId)throw Error('任务标签已关闭。');
    const tab=await chrome.tabs.update(owner.id,{active:true});
    if(target===owner)await chrome.windows.update(tab.windowId,{focused:true});
    return {ok:true};
  }
  if(m.op!=='connect')throw Error('未知操作。');
  if(m.bili===true)throw Error('扩展已更新，请重新打开弹窗。');
  if(target)throw Error('已有任务标签，请先停止共享。');
  if(launchJob)throw Error('DSH 正在打开任务页。');
  const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
  if(!tab || tab.id!==m.tabId)throw Error('当前标签页已变化，请再选一次。');
  await connectTab(tab);
  return {ok:true};
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('popup.html'))return;
  popupAction(m).then(reply,e=>reply({error:e.message}));
  return true;
});

let taskPort=null, retryTicket=null, launchJob=null;
function requireLaunch(job){
  if(job!==launchJob || job.cancelled || Date.now()>=job.deadline)throw Error('任务已结束');
}
const shapeOf=w=>[w.left,w.top,w.width,w.height,w.state];
async function launchDedicated(job){
  requireLaunch(job);
  if(target)throw Error('已有任务标签，请先读取当前任务。');
  const epoch=generation;
  const win=await chrome.windows.getLastFocused({windowTypes:['normal']});
  requireLaunch(job);
  if(!win?.id || win.incognito || target || generation!==epoch)throw Error('普通 Chrome 窗口不可用或共享已变化');
  const [previous]=await chrome.tabs.query({windowId:win.id,active:true});
  requireLaunch(job);
  if(target||generation!==epoch)throw Error('共享已变化');
  job.creating=true;
  const tab=await chrome.tabs.create({windowId:win.id,url:BILI[0]+'/',active:false});
  job.tabId=tab.id;
  requireLaunch(job);
  if(target||generation!==epoch)throw Error('共享已变化，未连接新标签');
  const label=typeof job.taskTitle==='string'?job.taskTitle.replace(/[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+/gu,' ').trim():'';
  const shortLabel=[...label].slice(0,24).join('');
  await connectTab({...tab,url:BILI[0]+'/'},false,[{id:tab.id,createdByDSH:true}],shortLabel?'DSH · '+shortLabel:null);
  requireLaunch(job);
  if(target?.id===tab.id)await groupCreated(target,tab,()=>launchJob===job && !job.cancelled && Date.now()<job.deadline);
  while(true){
    requireLaunch(job);
    if(target?.id!==tab.id||!connected)throw Error('任务标签已停止共享');
    const current=await chrome.tabs.get(tab.id);
    requireLaunch(job);
    if(current.url && BILI.includes(new URL(current.url).origin)){
      const [source,selected,destination]=await Promise.all([
        chrome.windows.get(win.id),chrome.tabs.query({windowId:win.id,active:true}),chrome.windows.get(current.windowId)]);
      requireLaunch(job);
      return {tabId:String(tab.id),created:true,presentation:'inactive-tab',sourceWindowPreserved:shapeOf(source).every((v,i)=>v===shapeOf(win)[i]),
        sourceTabPreserved:Boolean(previous && selected[0]?.id===previous.id),taskWindowFocused:destination.focused};
    }
    if(current.url && current.url!=='about:blank')throw Error('任务页离开了哔哩哔哩');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
}
function cancelLaunch(){
  if(!launchJob)return;
  launchJob.cancelled=true;
  if(launchJob.tabId!=null && target?.id===launchJob.tabId)disconnect();
}
function listenForTasks(){
  if(taskPort || chrome.extension.inIncognitoContext)return;
  clearTimeout(retryTicket);
  const port=chrome.runtime.connectNative('local.dsh.whale_tasks');taskPort=port;
  port.onDisconnect.addListener(()=>{
    void chrome.runtime.lastError;
    if(taskPort!==port)return;
    taskPort=null;cancelLaunch();
    retryTicket=setTimeout(listenForTasks,5000);
  });
  port.onMessage.addListener(async msg=>{
    if(taskPort!==port)return;
    if(msg.type==='waiting'||msg.type==='clear'||(msg.type==='cancel'&&launchJob?.id===msg.id)){cancelLaunch();return}
    const manager=msg.op==='openExtensionsManager';
    if(msg.type!=='request'||(!manager && (msg.op!=='openTask'||msg.args?.site!=='bilibili')))return;
    if(launchJob || !Number.isFinite(msg.deadline)||Date.now()>=msg.deadline){
      port.postMessage({type:'reply',id:msg.id,error:'任务已过期或正在打开',notDispatched:true});return;
    }
    const job={id:msg.id,deadline:msg.deadline,cancelled:false,tabId:null,taskTitle:msg.args.taskTitle};launchJob=job;
    try {
      let result;
      if(manager){
        const win=await chrome.windows.getLastFocused({windowTypes:['normal']});
        requireLaunch(job);
        if(!win?.id || win.incognito)throw Error('没有可用的普通 Chrome 窗口');
        job.creating=true;
        const tab=await chrome.tabs.create({windowId:win.id,active:false,url:'chrome://extensions/'});
        result={created:true,tabId:String(tab.id),openedInBackground:tab.active===false};
      } else result=await launchDedicated(job);
      requireLaunch(job);
      port.postMessage({type:'reply',id:job.id,result});
    } catch(e){
      if(job.tabId!=null && target?.id===job.tabId)disconnect();
      if(taskPort===port)port.postMessage({type:'reply',id:job.id,error:e.message,notDispatched:job.tabId==null && !job.creating});
    } finally {if(launchJob===job)launchJob=null}
  });
}
chrome.runtime.onStartup.addListener(listenForTasks);
chrome.tabs.onActivated.addListener(listenForTasks);
listenForTasks();
