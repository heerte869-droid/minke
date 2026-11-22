// Installed in the selected document's isolated world. It only draws a cursor.
(() => {
  const name='__dshWhaleCursor';
  if(globalThis[name])return globalThis[name].info();
  const bitmaps=new Map(), generations=new Map();
  let requested=null,state=null,host=null,canvas=null,tag=null,anchor=null,resize=null;
  let raf=0,tick=0,hideTimer=0,remaining=0,visibleSince=null,actionUntil=0,action=false;
  const css=(el,props)=>{for(const [k,v] of Object.entries(props))el.style.setProperty(k,v,'important')};
  const visible=()=>state?.active && !document.hidden;
  function unmount(){
    if(host?.matches(':popover-open'))host.hidePopover();
    host?.remove();host=null;canvas=null;tag=null;
  }
  function stopTimers(){
    clearInterval(tick);tick=0;clearTimeout(hideTimer);hideTimer=0;
    cancelAnimationFrame(raf);raf=0;
  }
  function clear(){
    stopTimers();resize?.disconnect();resize=null;anchor=null;action=false;visibleSince=null;remaining=0;
    window.removeEventListener('scroll',queue,true);window.removeEventListener('resize',queue);
    document.removeEventListener('fullscreenchange',fullscreen);document.removeEventListener('visibilitychange',onVisibility);
    window.removeEventListener('pagehide',clear);unmount();state=null;
    delete globalThis.__dshWhaleMarker;
  }
  function disarm(key,epoch){
    generations.set(key,Math.max(generations.get(key)??-1,epoch));
    if(state?.key===key&&state.epoch<=epoch)clear();
  }
  function rect(el){
    if(!el?.isConnected)return null;
    const r=el.getBoundingClientRect(),left=Math.max(0,r.left),top=Math.max(0,r.top);
    const right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
    return right-left>=2&&bottom-top>=2 ? {left,top,right,bottom,w:right-left,h:bottom-top} : null;
  }
  function watchAnchor(el){
    if(anchor===el)return;
    resize?.disconnect();anchor=el;
    if(el){resize??=new ResizeObserver(queue);resize.observe(el)}
  }
  function player(){
    // A site may retain hidden preload players alongside the displayed player.
    let best=null,area=0;
    for(const v of document.querySelectorAll('video')){
      const r=rect(v);if(r&&r.w*r.h>area){best=v;area=r.w*r.h}
    }
    return best;
  }
  function mount(){
    if(host?.isConnected)return;
    unmount();
    host=document.createElement('div');host.inert=true;host.setAttribute('aria-hidden','true');host.setAttribute('data-dsh-cursor','');
    css(host,{all:'initial',position:'fixed','pointer-events':'none','z-index':'2147483647',margin:'0',padding:'0',border:'0',background:'transparent',overflow:'visible',inset:'auto',transform:'none',opacity:'1'});
    // A manual top-layer element also works when the fullscreen element is a
    // replaced <video>, which cannot paint child overlays.
    if(typeof host.showPopover==='function')host.setAttribute('popover','manual');
    canvas=document.createElement('canvas');canvas.inert=true;canvas.setAttribute('aria-hidden','true');
    css(canvas,{all:'initial',display:'block',width:'100%',height:'100%','pointer-events':'none'});
    tag=document.createElement('span');tag.textContent='DSH';
    css(tag,{all:'initial',position:'absolute',left:'52%',top:'0',font:'600 10px/15px -apple-system, sans-serif',color:'#fff',background:'#43366c','border-radius':'5px',padding:'0 4px','pointer-events':'none'});
    host.append(canvas,tag);document.documentElement.append(host);globalThis.__dshWhaleMarker=canvas;
    paint();
  }
  function paint(){
    const bitmap=bitmaps.get(state?.variant);if(!canvas||!bitmap)return;
    const size=state.size,density=Math.min(3,Math.max(1,devicePixelRatio||1));
    canvas.width=canvas.height=Math.ceil(size*density);
    const ctx=canvas.getContext('2d');ctx.imageSmoothingQuality='high';ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
    css(host,{width:size+'px',height:size+'px'});
  }
  function conceal(){
    if(!host)return;
    if(host.matches(':popover-open'))host.hidePopover();
    css(host,{display:'none'});
  }
  function render(){
    if(!state||!document.documentElement){conceal();return}
    let box=rect(anchor),park=false;
    if(!box)action=false;
    if(state.mode==='companion' && (!box || (anchor?.tagName==='VIDEO'&&performance.now()>actionUntil) || !action)){
      const v=player();
      if(v){watchAnchor(v);box=rect(v);park=true}
      else if(!box||!action){
        const focus=document.activeElement;
        const heading=[...document.querySelectorAll('h1,input[type=search],input[placeholder],main h2')].find(el=>el.type!=='password'&&rect(el));
        const resting=focus?.matches('button,a[href],input[type=search]')&&rect(focus)?focus:heading;
        watchAnchor(resting||null);box=rect(resting);park=true;
      }
    }
    if(!box || (state.mode==='clean' && !action)){conceal();return}
    mount();
    if(!canvas)return;
    const {size,hotspot}=state;
    let x=box.left+box.w/2-size*hotspot,y=box.top+box.h/2-size*hotspot;
    if(park){
      x=Math.max(box.left+3,box.right-size-10);
      y=anchor?.tagName==='VIDEO'?Math.max(box.top+4,box.bottom-size-50):box.top+Math.max(0,(box.h-size)/2);
      x=Math.max(0,Math.min(x,innerWidth-size));y=Math.max(0,Math.min(y,innerHeight-size));
    }
    css(host,{left:x+'px',top:y+'px',display:'block'});
    if(host.hasAttribute('popover')&&!host.matches(':popover-open')){try{host.showPopover()}catch{}}
  }
  function queue(){if(!raf&&visible())raf=requestAnimationFrame(()=>{raf=0;render()})}
  function fullscreen(){unmount();render()}
  function onVisibility(){
    if(!state)return;
    if(visibleSince!==null&&state.mode==='clean')remaining-=performance.now()-visibleSince;
    visibleSince=null;stopTimers();
    if(!visible()){render();return}
    if(state.mode==='clean'&&action){
      if(remaining<=0){action=false;conceal();return}
      visibleSince=performance.now();
      hideTimer=setTimeout(()=>{action=false;visibleSince=null;conceal()},remaining);
    }
    render();
    if(state.mode==='companion')tick=setInterval(render,400);
  }
  async function bind(p){
    if(location.href!==p.url||p.epoch<=(generations.get(p.key)??-1))return false;
    if(requested?.key===p.key&&requested.epoch>p.epoch)return false;
    requested={key:p.key,epoch:p.epoch,url:p.url};
    if(!bitmaps.has(p.variant)){
      if(!p.data)return false;
      const bytes=Uint8Array.from(atob(p.data.split(',')[1]),c=>c.charCodeAt(0));
      const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
      if(!bitmaps.has(p.variant))bitmaps.set(p.variant,image);else image.close();
    }
    if(location.href!==p.url||p.epoch<=(generations.get(p.key)??-1))return false;
    if(requested.key!==p.key||requested.epoch!==p.epoch||requested.url!==p.url)return false;
    const same=state?.key===p.key && state.url===p.url;
    const repaint=!same||state.size!==p.size||state.variant!==p.variant;
    if(!same)clear();
    state={...p};delete state.data;
    window.addEventListener('resize',queue);window.addEventListener('scroll',queue,true);
    document.addEventListener('fullscreenchange',fullscreen);document.addEventListener('visibilitychange',onVisibility);
    window.addEventListener('pagehide',clear,{once:true});
    if(repaint)paint();
    onVisibility();return true;
  }
  function point(el,key){
    if(!state||state.key!==key||state.url!==location.href)return;
    watchAnchor(el);action=true;actionUntil=performance.now()+950;
    remaining=state.hold;visibleSince=null;onVisibility();
  }
  function setActive(key,active){if(state?.key===key&&state.active!==active){state.active=active;onVisibility()}}
  const api={bind,point,setActive,disarm,info:()=>({cached:[...bitmaps.keys()]})};
  globalThis[name]=api;
  return api.info();
})()
