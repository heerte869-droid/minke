// Runs in Chrome's isolated world, in the selected top-level document only.
export async function operate(input) {
  let attempted=false;
  try {
  if(location.origin!==input.origin||location.href!==input.url||Date.now()>=input.deadline)throw Error('页面已变化或请求已过期，请重新观察');
  const secret='input[type=password],[autocomplete*="password" i],[autocomplete*="cc-" i],[autocomplete*="one-time-code" i]';
  const key='__dshWhaleTabState';const words=v=>String(v??'').replace(/\s+/g,' ').trim();
  const safeLink=n=>{try{const u=new URL(n.href);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href.slice(0,1500):''}catch{return ''}};
  function labelText(label) {
    const walker=document.createTreeWalker(label,NodeFilter.SHOW_TEXT);
    const parts=[];
    for(let node=walker.nextNode();node;node=walker.nextNode()){
      if(!node.parentElement.closest('select,textarea,button,input,[contenteditable=true],script,style'))parts.push(node.nodeValue);
    }
    return words(parts.join(' '));
  }
  function label(n) {
    const ids=words(n.getAttribute('aria-labelledby')).split(' ').filter(Boolean);
    const referenced=words(ids.map(id=>document.getElementById(id)).filter(Boolean).map(labelText).join(' '));
    const associated=words(Array.from(n.labels??[],labelText).join(' '));
    return words(referenced||n.getAttribute('aria-label')||associated||n.getAttribute('title')||n.getAttribute('placeholder')||
      (n.matches('input[type=button],input[type=submit],input[type=reset]')?n.value:'')||n.innerText||n.querySelector('img')?.alt||n.tagName).slice(0,150);
  }
  function roleOf(n) {
    if(n.matches('select'))return n.multiple||n.size>1?'listbox':'combobox';
    if(n.matches('input[type=checkbox],input[type=radio]'))return n.type;
    if(n.matches('a[href]'))return 'link';
    if(n.matches('video'))return 'video';
    if(n.matches('button,[role=button],input[type=button],input[type=submit],input[type=reset]'))return 'button';
    return 'textbox';
  }
  function playerId(video) {
    const players=globalThis.__dshWhalePlayers??=new WeakMap();
    const previous=players.get(video);
    if(previous?.src===video.currentSrc)return previous.id;
    const id=crypto.randomUUID();
    players.set(video,{id,src:video.currentSrc});
    return id;
  }
  if(input.op==='verifyPlayback'){
    const players=[...document.querySelectorAll('video')];
    const v=input.expectedPlayerId?players.find(el=>playerId(el)===input.expectedPlayerId):players.find(el=>!el.paused)??players[0];
    if(!v)throw Error('No video in this page');
    const from=v.currentTime,src=v.currentSrc,initial=document.visibilityState;
    let switched=false,sought=v.seeking,stayedMuted=v.muted;
    const changeView=()=>{switched=true};
    const seek=()=>{sought=true};
    const checkSound=()=>{if(!v.muted)stayedMuted=false};
    document.addEventListener('visibilitychange',changeView);
    v.addEventListener('seeking',seek);
    v.addEventListener('volumechange',checkSound);
    try{await new Promise(resolve=>setTimeout(resolve,2200))}
    finally{document.removeEventListener('visibilitychange',changeView);v.removeEventListener('seeking',seek);v.removeEventListener('volumechange',checkSound)}
    if(!v.isConnected||v.currentSrc!==src||location.href!==input.url)throw Error('Video changed during verification');
    return {playerId:playerId(v),elementStayedMuted:stayedMuted&&v.muted,visibility:switched||initial!==document.visibilityState?'mixed':initial,
      verified:!sought&&!v.seeking&&!v.paused&&!v.ended&&v.currentTime-from>=1,
      from:+from.toFixed(2),to:+v.currentTime.toFixed(2),paused:v.paused,muted:v.muted,title:document.title.slice(0,200),url:location.href};
  }
  if(input.op==='observe'){
    const nodes=new Map(),tree=[],videos=[];let truncated=false;
    let optionBudget=120;
    for(const n of document.querySelectorAll('input:not([type=hidden]),textarea,select,button,a[href],[role=button],video,[contenteditable=true]')){
      if(n.matches(secret)||n.closest('[inert],[hidden]')||n.getBoundingClientRect().width<1||n.getBoundingClientRect().height<1||getComputedStyle(n).visibility==='hidden')continue;
      if(tree.length>=130){truncated=true;break}
      const ref=String(tree.length+1),title=label(n),href=n.tagName==='A'?safeLink(n):'';
      const role=roleOf(n),row={ref,role,title};
      if(href)row.href=new URL(href).origin+new URL(href).pathname.slice(0,180);
      if(n.matches(':disabled,[aria-disabled=true]'))row.disabled=true;
      if(role==='checkbox'||role==='radio'){row.checked=n.checked;if(n.indeterminate)row.indeterminate=true}
      if(role==='textbox'){
        row.type=n.type??'text';
        if(n.readOnly)row.readOnly=true;
        if(n.matches('input[type=email],input[type=tel],input[type=file]'))row.hasValue=!!n.value;
        else row.value=String(n.value??'').slice(0,160);
      }
      if(n instanceof HTMLSelectElement){
        row.multiple=n.multiple;
        row.optionCount=n.options.length;
        const count=Math.min(n.options.length,50,optionBudget);
        optionBudget-=count;
        row.options=Array.from({length:count},(_,i)=>{
          const o=n.options[i];
          return {label:o.label.slice(0,150),selected:o.selected,disabled:o.matches(':disabled')};
        });
      }
      nodes.set(ref,{n,title,href,role,type:n.type});tree.push(row);
    }
    for(const v of [...document.querySelectorAll('video')].slice(0,3))videos.push({playerId:playerId(v),paused:v.paused,ended:v.ended,currentTime:Number(v.currentTime.toFixed(2)),duration:Number.isFinite(v.duration)?Math.round(v.duration):null,readyState:v.readyState,muted:v.muted});
    const snapshotId=crypto.randomUUID(),observedAt=Date.now();
    globalThis[key]={nodes,url:location.href,snapshotId,observedAt};
    return {snapshotId,observedAt,url:location.href,title:document.title.slice(0,250),visibility:document.visibilityState,tree,truncated,videos,text:(document.body?.innerText??'').slice(0,3500)};
  }
  const s=globalThis[key];
  if(input.op!=='checkVideoMute')delete globalThis[key];
  if(!s||s.snapshotId!==input.snapshotId||s.url!==location.href||Date.now()-s.observedAt>=15000)throw Error('控件观察已过期，请重新观察');
  if(input.op==='navigate')return {navigate:input.destination};
  const rec=s.nodes.get(input.ref);let el=rec?.n;
  if(input.op==='follow'&&rec?.href&&(!el?.isConnected||safeLink(el)!==rec.href)){
    const alternatives=[...document.querySelectorAll('a[href]')].filter(n=>safeLink(n)===rec.href&&label(n)===rec.title&&n.getBoundingClientRect().width>0);
    if(alternatives.length===1)el=alternatives[0];
  }
  if(!el?.isConnected||el.matches(secret)||el.closest('[inert],[hidden]')||el.matches(':disabled,[aria-disabled=true]')||label(el)!==rec.title||roleOf(el)!==rec.role||el.type!==rec.type||(rec.href&&safeLink(el)!==rec.href))throw Error('目标控件已变化，请重新观察');
  if(input.expectedPlayerId&&(!(el instanceof HTMLVideoElement)||playerId(el)!==input.expectedPlayerId))throw Error('播放器或片源已变化，请重新观察');
  const protectedDialog=[...document.querySelectorAll(secret)].some(n=>{const r=n.getBoundingClientRect();if(!r.width||!r.height||r.bottom<=0||r.top>=innerHeight)return false;const at=document.elementFromPoint(Math.min(innerWidth-1,Math.max(0,r.x+r.width/2)),Math.min(innerHeight-1,Math.max(0,r.y+r.height/2)));return at===n||n.contains(at)});
  if(protectedDialog)throw Error('页面显示了登录或安全输入框，请手动处理');
  if(input.op==='checkVideoMute'){
    if(!(el instanceof HTMLVideoElement))throw Error('请选择 video 控件');
    return {elementMuted:el.muted};
  }
  el.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
  if(['click','fill','follow','submit','selectOption','setChecked'].includes(input.op)){
    const r=el.getBoundingClientRect();if(r.width<=0||r.height<=0)throw Error('目标已隐藏，请重新观察');
    const cx=(Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,cy=(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2,at=document.elementFromPoint(cx,cy);
    if(!at||!(el===at||el.contains(at)))throw Error('目标被遮挡，请重新观察');
  }
  globalThis.__dshWhaleShareKey=input.shareKey;
  globalThis.__dshWhaleFlight=input.callId;
  const active=()=>globalThis.__dshWhaleFlight===input.callId && globalThis.__dshWhaleShareKey===input.shareKey;
  if(input.showCursor)globalThis.__dshWhaleCursor?.point(el,input.shareKey);
  if(input.op==='follow'){
    if(!rec.href)throw Error('请选择链接');
    if(!document.hidden&&input.showCursor)await new Promise(resolve=>setTimeout(resolve,160));
    if(!active()||!el.isConnected||location.href!==input.url||Date.now()>=input.deadline)throw Error('目标已变化，请重新观察');
    return {navigate:rec.href};
  }
  const fireChanges=()=>{el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))};
  switch(input.op){
    case 'click':attempted=true;el.click();break;
    case 'setChecked':{
      if(!el.matches('input[type=checkbox],input[type=radio]')||typeof input.checked!=='boolean')throw Error('请选择复选框或单选按钮，并指定勾选状态');
      if(el.checked!==input.checked||el.indeterminate){
        if(el.type==='radio'&&!input.checked)throw Error('请选中同组的另一个单选按钮');
        attempted=true;
        if(el.indeterminate&&el.checked===input.checked){el.indeterminate=false;fireChanges()}
        else el.click();
      }
      return {fieldVerified:el.isConnected&&!el.indeterminate&&el.checked===input.checked,changed:attempted};
    }
    case 'selectOption':{
      if(!(el instanceof HTMLSelectElement)||!Array.isArray(input.labels)||(!el.multiple&&input.labels.length!==1))throw Error('请按页面显示的名称选择选项');
      const options=Array.from(el.options),desired=new Set();
      for(const name of input.labels){
        const matches=options.filter(o=>o.label===name);
        if(matches.length!==1||matches[0].matches(':disabled'))throw Error('选项不可用或名称不唯一，请重新观察');
        desired.add(matches[0]);
      }
      const matches=()=>Array.from(el.options).filter(o=>o.selected).length===desired.size && [...desired].every(o=>o.selected&&o.closest('select')===el);
      if(!matches()){
        if(options.some(o=>o.selected&&o.matches(':disabled')&&!desired.has(o)))throw Error('所选项目包含禁用选项');
        attempted=true;
        if(el.multiple){for(const o of options)o.selected=desired.has(o)}
        else el.selectedIndex=options.indexOf([...desired][0]);
        fireChanges();
      }
      return {fieldVerified:el.isConnected&&matches(),changed:attempted};
    }
    case 'fill':{
      const types=['text','search','url','tel','email','number','date','time','month','week','datetime-local'];
      if(!(el instanceof HTMLTextAreaElement||el instanceof HTMLInputElement&&types.includes(el.type))||el.readOnly||typeof input.text!=='string')throw Error('请选择可填写的输入框');
      const probe=el.cloneNode(false);
      probe.value=input.text;
      if(probe.value!==input.text)throw Error('内容格式与输入框不符');
      const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      attempted=true;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el,input.text);fireChanges();
      return {fieldVerified:el.isConnected&&el.value===input.text,changed:true};
    }
    case 'submit':if(!el.form)throw Error('此输入框无表单，请点击页面搜索按钮');attempted=true;el.form.requestSubmit();break;
    case 'play':case 'pauseVideo':{
      if(!(el instanceof HTMLVideoElement))throw Error('请选择 video 控件');
      if(input.op==='pauseVideo'){attempted=true;el.pause();break}
      const transfer=input.useTaskTabMute===true;
      if(transfer && [...document.querySelectorAll('dialog[open],[role=dialog],[aria-modal=true]')].some(dialog=>
        dialog.getClientRects().length && getComputedStyle(dialog).visibility!=='hidden' &&
        /扫码登录|扫描二维码登录|密码登录|登录后(?:才能|继续)?观看|安全验证|验证码|试看(?:已)?结束|付费观看/.test(dialog.innerText||'')))
        throw Error('当前视频存在观看提示，请查看页面状态');
      if(transfer && (!input.expectedPlayerId || !document.hidden || !el.muted || !el.paused || el.ended || el.readyState<2))
        throw Error('播放器状态已变化，请重新观察');
      attempted=true;
      let timer;
      try{
        const silentViaTab=input.silentViaTab===true;
        if(transfer || silentViaTab)el.muted=false;
        else if(input.muted===true)el.muted=true;
        await Promise.race([el.play(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('播放器未响应')),2500)})]);
      }catch(e){
        if((transfer || input.silentViaTab===true) && el.isConnected && !el.muted)el.muted=true;
        if(!input.silentViaTab || e.name!=='NotAllowedError' || !active() || Date.now()>=input.deadline || !el.isConnected)throw e;
        // Chrome can require the first start to use element mute. Preserve that working path.
        clearTimeout(timer);
        await Promise.race([el.play(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('播放器未响应')),2500)})]);
      }finally{clearTimeout(timer)}
      return {dispatched:true,usedTaskTabMute:transfer};
    }
    default:throw Error('Unsupported action');
  }
  return {dispatched:true};
  }catch(e){return {failure:String(e.message).slice(0,220),notDispatched:!attempted}}
}
