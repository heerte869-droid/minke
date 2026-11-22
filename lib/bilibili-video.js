const HOME = 'https://www.bilibili.com';
const SEARCH = 'https://search.bilibili.com';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class VideoTaskFailure extends Error {
  constructor(stage, message) { super(message); this.stage=stage; }
}
// The current Chrome extension forwards DOMException.message, not its name.
// Recognize only explicit browser replies. A timeout is never a policy denial.
export function playRefusal(error) {
  if (error?.code!=='extension_refused' || error.details?.notDispatched) return null;
  const message=String(error.message);
  if (/^play\(\) failed because the user didn't interact with the document first(?:[. ]|$)/i.test(message)) {
    return {code:'autoplay_not_allowed',reason:'Chrome 拒绝了这次自动播放请求。'};
  }
  if (/^the play\(\) request was interrupted by a call to pause\(\)(?:[. ]|$)/i.test(message)) {
    return {code:'interrupted_by_pause',reason:'播放请求被暂停操作中断。'};
  }
  if (/^(failed to load because no supported source was found|the element has no supported sources)[.]?$/i.test(message)) {
    return {code:'unsupported_source',reason:'播放器报告没有支持的媒体源。'};
  }
  return null;
}
const segmenter = new Intl.Segmenter('zh', {granularity:'word'});
const normalize = text => String(text ?? '').normalize('NFKC').toLowerCase();
function searchTerms(query) {
  return [...new Set([...segmenter.segment(normalize(query))]
    .filter(part=>part.isWordLike).map(part=>part.segment))];
}
function rankedVideos(snapshot, terms) {
  const byId=new Map();
  for (const link of snapshot.tree || []) {
    if (link.role!=='link' || !link.href)continue;
    let url;
    try {url=new URL(link.href)} catch {continue}
    const id=url.pathname.match(/(?:^|\/)video\/(BV[A-Za-z0-9]+)(?:\/|$)/)?.[1];
    if (url.origin!==HOME || !id)continue;
    const title=normalize(link.title).trim();
    if (!title || title==='a' || (/^[\d\s:.,万亿千百]+$/u.test(title) && /\d:\d{2}/.test(title)))continue;
    const matched=terms.filter(term=>title.includes(term));
    const score=matched.reduce((sum,term)=>sum+term.length,0);
    const existing=byId.get(id);
    if (!existing || score>existing.score || (score===existing.score && title.length<normalize(existing.title).length)) {
      byId.set(id,{id,ref:link.ref,title:link.title,matched,score,complete:terms.length>0 && matched.length===terms.length});
    }
  }
  // For partials put candidates containing the leading query term within
  // reach of the model, even when many unrelated titles match only the action.
  const lead=terms[0];
  return [...byId.values()].sort((a,b)=>Number(b.complete)-Number(a.complete) ||
    Number(b.matched.includes(lead))-Number(a.matched.includes(lead)) || b.score-a.score);
}
function restricted(snap) {
  return /访问出错|访问受限|安全验证|完成验证码|HTTP\s*412|错误[码号][：:]?\s*412/i.test((snap.title||'')+' '+(snap.text||'').slice(0,700));
}
export async function searchAndPlay(bridge,tabId,query,signal,config,audioMode='muted',resultId,searchOnly=false,fallbackQuery,publicIndexAllowed=false) {
  if(!['muted','preserve'].includes(audioMode))throw new VideoTaskFailure('播放设置','未知的音频选项。');
  const muteRequested=audioMode==='muted';
  const serial=bridge.serial;
  let stage='读取任务页';
  const fail=message=>{throw new VideoTaskFailure(stage,message)};
  function current() {
    signal.throwIfAborted();
    if (serial!==bridge.serial || !bridge.connected) fail('共享连接已变化。');
  }
  async function request(op,args) {
    current();
    const reply=await bridge.request(op,args,signal);
    current();
    return reply;
  }
  async function locationOfTask() {
    const m=await request('meta',{});
    if (m.tabId!==tabId || ![HOME,SEARCH].includes(new URL(m.url).origin)) fail('任务标签或站点已变化。');
    return {tabId,url:m.url,active:m.active,windowFocused:m.windowFocused,bounds:m.windowBounds};
  }
  async function observe(route) {
    const snap=await request('observe',{tabId,url:route.url});
    if (snap.url!==route.url) fail('读取期间页面已切换。');
    if (restricted(snap)) fail('B 站返回访问限制或验证页面。');
    return snap;
  }
  async function waitFor(matches,pick,timeoutMessage='等待页面就绪超时。',firstRoute) {
    const end=Date.now()+14000;
    while(Date.now()<end) {
      const route=firstRoute ?? await locationOfTask();
      firstRoute=undefined;
      if(matches(new URL(route.url))) {
        let snap;
        try {snap=await observe(route)} catch(error) {
          if (!['extension_refused','extension_timeout'].includes(error.code)) throw error;
          await sleep(220);continue; // Only the read is retried while a document commits.
        }
        const value=pick(snap);
        if(value)return {route,snap,value};
      }
      await sleep(220);
    }
    fail(timeoutMessage);
  }
  const display={showCursor:config.overlayMode!=='hidden',cursorMode:config.overlayMode??'companion',
    size:config.cursorSize,variant:config.cursorVariant,cursorHold:config.overlayMode==='companion'?6500:(config.cursorHoldMs??1800)};
  const argsFor=(s,ref)=>({tabId,url:s.route.url,...display,snapshotId:s.snap.snapshotId,ref});
  async function searchPage(keyword, force=false) {
    const initial=await locationOfTask(),search=new URL('/all',SEARCH);search.searchParams.set('keyword',keyword);
    const onSearch=url=>url.origin===SEARCH && url.searchParams.get('keyword')===keyword;
    stage='搜索';
    if(resultId && !onSearch(new URL(initial.url)))fail('当前页已离开这次搜索，请先读取新的搜索结果。');
    if(force || !onSearch(new URL(initial.url))){
      const start=await waitFor(url=>[HOME,SEARCH].includes(url.origin),()=>true,undefined,initial);
      await request('navigate',{tabId,url:start.route.url,snapshotId:start.snap.snapshotId,destination:search.href,backgroundSearch:true});
    }
    return {onSearch,initial};
  }
  try {
    const terms=searchTerms(query);
    if(searchOnly){
      const pool=new Map(),attempts=[];
      const fold=t=>normalize(t).replace(/[^\p{L}\p{N}]+/gu,'');
      // Retain the series and the quoted work name; translated subtitles can swamp mixed-language search.
      const parts=query.match(/^(.*?)[《“「"]([^》”」"]+)[》”」"]/u);
      const prefix=parts?.[1].replace(/[\s:：|｜—–-]+$/u,'').trim();
      const core=parts?.[2].trim();
      const variants=[query,prefix && core ? prefix+' '+core:null,fallbackQuery||core];
      const used=new Set();
      for(const keyword of variants){
        if(!keyword || used.has(normalize(keyword)))continue;
        used.add(normalize(keyword));
        const {onSearch:isPage}=await searchPage(keyword,true);
        stage='读取搜索结果';
        let fingerprint,stableSince;
        const page=await waitFor(isPage,snap=>{
          const list=rankedVideos(snap,terms);
          if(list.length){
            if(list.some(v=>fold(v.title)===fold(query)))return list;
            const key=list.map(v=>v.id+' '+v.title).join('\n');
            if(fingerprint!==key){fingerprint=key;stableSince=Date.now();return null;}
            return Date.now()-stableSince>=(list.length<8?1200:450)?list:null;
          }
          if(/没有找到相关|未找到相关|暂无搜索结果/.test(snap.text||''))return [];
          return null;
        });
        for(const video of page.value){
          const prior=pool.get(video.id);
          if(!prior||video.score>prior.score)pool.set(video.id,video);
        }
        attempts.push({query:keyword,observed:page.value.length,truncated:page.snap.truncated===true});
        if([...pool.values()].some(v=>fold(v.title)===fold(query)))break;
      }
      const ranked=[...pool.values()].sort((a,b)=>Number(fold(b.title)===fold(query))-Number(fold(a.title)===fold(query)) ||
        Number(b.complete)-Number(a.complete) || b.score-a.score);
      const exactTitleFound=ranked.some(v=>fold(v.title)===fold(query));
      const lookupWords=query.replace(/[^\p{L}\p{N}]+/gu,' ').trim();
      return {query,tabId,url:(await locationOfTask()).url,attempts,observed:pool.size,exactTitleFound,
        ...(!exactTitleFound && publicIndexAllowed && lookupWords ? {publicIndexQuery:'site:bilibili.com/video '+lookupWords}:{}),
        results:ranked.slice(0,8).map(({id,title,matched})=>({id,title,matched,url:HOME+'/video/'+id+'/'})),untrustedContent:true};
    }
    const {onSearch,initial}=await searchPage(query);
    stage='读取搜索结果';
    let firstResultsAt;
    const result=await waitFor(onSearch,snap=>{
      const videos=rankedVideos(snap,terms);
      if(resultId)return videos.find(video=>video.id===resultId);
      if(!videos.length)return null;
      // A single word in an expanded title may name an animal, game or product.
      // Let the agent compare the visible titles instead of assuming the top hit.
      const singleTerm=terms.length===1;
      if(!singleTerm && videos[0].complete)return videos[0];
      firstResultsAt ??= Date.now();
      if(videos.length<8 && Date.now()-firstResultsAt<900)return null;
      const full=videos.filter(video=>video.complete);
      if(singleTerm && full.length===1 && normalize(full[0].title).trim()===terms[0])return full[0];
      const ambiguous=singleTerm && full.length>0;
      return {
        reason:ambiguous?'ambiguous_topic':'partial_title_match',
        candidates:videos.slice(0,ambiguous?8:5).map(({id,title,matched})=>({id,title,matched}))
      };
    },resultId?'所选视频已不在当前结果中。':'搜索结果中未找到可读的视频标题。');
    if(result.value.candidates) {
      return {query,tabId,url:result.route.url,verified:false,stage,playbackState:'needs_selection',
        selectionReason:result.value.reason,candidates:result.value.candidates,untrustedContent:true,
        reason:result.value.reason==='ambiguous_topic'
          ? '单个关键词不足以确定视频主题。请根据任务对照标题，选中相关候选后继续。'
          : '没有标题完整匹配搜索词。请按实际标题选择相关视频，或调整搜索词。'};
    }
    const id=result.value.id;
    const onVideo=url=>url.origin===HOME&&url.pathname.split('/').includes(id);
    stage='打开搜索结果';
    const followVideo = selection => request('follow', {
      ...argsFor(selection, selection.value.ref),
      backgroundSearch:true,
      muteTaskTab: muteRequested
    });
    try {await followVideo(result)}
    catch(error) {
      if(signal.aborted||error instanceof VideoTaskFailure)throw error;
      if(error.details?.notDispatched){
        // Only a stale, explicitly unsent link can be resolved again.
        if(!/已变化|已过期|重新观察/.test(error.message)||/遮挡|敏感|验证/.test(error.message))throw error;
        const same=await waitFor(onSearch,snap=>rankedVideos(snap,terms).find(video=>video.id===id));
        await followVideo(same);
      }
      // For an uncertain dispatch, confirm the original result by URL. Never click twice.
    }
    stage='定位播放器';
    const arrival=Date.now();
    const player=await waitFor(onVideo,snap=>{
      if(!snap.videos?.some(v=>v.readyState>=2)&&Date.now()-arrival<(snap.visibility==='hidden'?2500:9500))return null;
      return snap.tree?.find(node=>node.role==='video');
    });
    stage=muteRequested?'静音播放':'播放';
    let refused=null;
    try {await request('play',{...argsFor(player,player.value.ref),muted:muteRequested})}
    catch(error) {
      if(error.details?.notDispatched||signal.aborted||error instanceof VideoTaskFailure)throw error;
      refused=playRefusal(error);
      // The site can start playback independently. Preserve the refusal while
      // still measuring the player, without sending another input.
    }
    stage='核实播放';
    let route=await locationOfTask();
    if(!onVideo(new URL(route.url)))fail('播放器已离开所选视频。');
    const deadline=Date.now()+12000;
    let proof;
    for (;;) {
      const currentRoute=route;
      if(!onVideo(new URL(currentRoute.url)))fail('核实期间任务页已切换视频。');
      try {
        proof=await request('verifyPlayback',{tabId,url:currentRoute.url});
      } catch(error) {
        // A player can replace its initial empty media element during a read.
        // Only measurements are repeated. A play or click is never repeated here.
        if(!['extension_refused','extension_timeout'].includes(error.code) || Date.now()>=deadline)throw error;
        await sleep(250);
        route=await locationOfTask();
        continue;
      }
      if(!onVideo(new URL(proof.url)))fail('核实期间任务页已切换视频。');
      if(proof.verified && Number.isFinite(proof.from) && Number.isFinite(proof.to) && proof.to-proof.from>=1)break;
      if(Date.now()>=deadline || proof.paused || proof.visibility==='hidden') {
        const status=await observe(await locationOfTask());
        if(!onVideo(new URL(status.url)))fail('核实期间任务页已切换视频。');
        if(status.visibility==='hidden' && status.videos?.length && status.videos.every(v=>v.readyState===0)){
          return {query,tabId,title:status.title,url:status.url,verified:false,stage,
            playbackState:'unconfirmed_hidden',requiresObservation:true,doNotReplay:true,
            ...(refused && {playRequest:refused.code}),
            reason:(refused?.reason??'')+'视频已在后台标签打开，尚未载入可播放的数据。'};
        }
        if(!proof.paused && Date.now()<deadline)continue;
        if(status.videos?.length && status.videos.every(v=>v.readyState===0)){
          if(Date.now()<deadline){await sleep(300);continue}
          fail('标签已打开，播放器仍没有可播放的媒体数据。');
        }
        if(proof.paused && proof.visibility==='hidden' && status.visibility==='hidden' && proof.tabActive===false){
          const video=status.videos?.find(v=>v.playerId && v.playerId===proof.playerId);
          return {query,tabId,title:status.title,url:status.url,stage,verified:false,
            playbackState:'paused_hidden',requiresObservation:true,doNotReplay:true,
            from:proof.from,to:proof.to,paused:true,visibility:'hidden',tabActive:false,
            ...(proof.playerId && {playerId:proof.playerId}),
            ...(typeof proof.tabMuted==='boolean' && {tabMuted:proof.tabMuted}),
            ...(typeof proof.elementMuted==='boolean' && {elementMuted:proof.elementMuted}),
            ...(video && {readyState:video.readyState}),
            ...(refused && {playRequest:refused.code}),
            reason:(refused?.reason??'')+'采样结束时后台播放器已暂停。'};
        }
        if(proof.paused)fail((refused?.reason??'')+'播放器已暂停，未确认持续播放。');
        fail('未取得同一视频的两次递增时间。');
      }
    }
    if(muteRequested && (proof.muted!==true || proof.silenceVerified===false))fail('播放有进度，但未确认静音。');
    const final=await locationOfTask();if(!onVideo(new URL(final.url)))fail('回读后任务标签已切换视频。');
    return {query,tabId,title:proof.title,url:proof.url,from:proof.from,to:proof.to,muted:proof.muted,audioMode,visibility:proof.visibility,verified:true,
      ...(refused && {playRequest:refused.code}),
      tabActive:final.active,initiallyActive:initial.active,windowFocused:final.windowFocused,initialWindowFocused:initial.windowFocused};
  } catch(error) {
    if(signal.aborted||error instanceof VideoTaskFailure)throw error;
    const reason={extension_timeout:'扩展没有及时返回。',extension_disconnected:'Chrome 扩展已断开。',extension_refused:'扩展未能完成这一阶段。'}[error.code];
    throw new VideoTaskFailure(stage,reason||'未取得可验证的页面结果。');
  }
}
