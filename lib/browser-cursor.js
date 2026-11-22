import { readFile } from 'node:fs/promises';
const assets = new Map();
function imageURL(variant) {
  const file = variant === 'mini' ? 'cursor-whale.png' : 'cursor-whale-large.png';
  if (!assets.has(file)) assets.set(file,readFile(new URL('../assets/'+file,import.meta.url)).then(data=>'data:image/png;base64,'+data.toString('base64')));
  return assets.get(file);
}

// This function runs only in the already approved document containing the target.
async function createMarker({ origin, url, hotspot }) {
  if (location.origin !== origin) return null;
  const image = new Image();
  image.alt = '';
  image.src = url;
  let timer;
  try {
    await Promise.race([image.decode(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('image timeout')),600); })]);
  } finally { clearTimeout(timer); }
  const host = document.createElement('div');
  host.setAttribute('data-whale-ai-pointer','');
  host.setAttribute('aria-hidden','true');
  host.inert = true;
  host.style.cssText = 'all:initial!important;position:fixed!important;top:0!important;left:0!important;pointer-events:none!important;z-index:2147483647!important;margin:0!important;padding:0!important;border:0!important;';
  const shadow = host.attachShadow({mode:'closed'});
  image.style.cssText='display:block;width:100%;height:100%;pointer-events:none;user-select:none;';
  shadow.append(image);
  let expiry, removeListeners = () => {};
  function disarm() { removeListeners(); removeListeners = () => {}; }
  function hide() { disarm(); clearTimeout(expiry); host.remove(); }
  return {
    arm({node, action, point, size, hold, origin: expected}) {
      hide();
      if (document.hidden || location.origin !== expected || (node && !node.isConnected)) return false;
      const parent = node?.closest('dialog[open]') || document.fullscreenElement || document.documentElement;
      const place = (x,y) => {
        if (!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=innerWidth||y>=innerHeight||document.hidden) return;
        host.style.setProperty('width',size+'px','important');
        host.style.setProperty('height',size+'px','important');
        // Each original drawing has its own normalized tip.
        host.style.setProperty('transform','translate('+ (x-size*hotspot)+'px,'+(y-size*hotspot)+'px)','important');
        if (!host.isConnected) parent.append(host);
        clearTimeout(expiry); expiry=setTimeout(hide,hold);
      };
      const r=node?.getBoundingClientRect();
      if (action==='click'||action==='hover'||action==='drag') {
        const type=action==='hover'?'pointermove':'pointerdown';
        const listener=e=>{
          if (!e.isTrusted || (node && !e.composedPath().includes(node)) ||
            (!node && (!point || Math.abs(e.clientX-point.x)>2 || Math.abs(e.clientY-point.y)>2))) return;
          place(e.clientX,e.clientY);
          disarm();
        };
        window.addEventListener(type,listener,true);
        removeListeners=()=>window.removeEventListener(type,listener,true);
        expiry=setTimeout(hide,3200);
        // Hover can stay at exactly the previous point and emit no event.
        if (action==='hover'&&r) place(r.x+r.width/2,r.y+r.height/2);
      } else if (r) place(r.x+r.width/2,r.y+r.height/2);
      else if (point) place(point.x,point.y);
      else return false;
      return true;
    },
    disarm, hide,
  };
}
export class BrowserCursor {
  #entry; #epoch=0;
  async arm(page,element,args,pref,signal) {
    if (!pref || pref.mode==='hidden') { await this.clear(); return false; }
    const frame=element?.frame ?? page.mainFrame();
    const url=frame.url(), origin=new URL(url).origin;
    if (origin!==new URL(page.url()).origin) return false;
    const variant=pref.variant === 'mini' ? 'mini' : 'large';
    if (this.#entry && (this.#entry.variant!==variant||this.#entry.frame!==frame||this.#entry.url!==url)) await this.clear();
    const epoch=this.#epoch;
    try {
      if (!this.#entry) {
        const handle=await frame.evaluateHandle(createMarker,{origin,url:await imageURL(variant),hotspot:variant==='mini'?48/512:88/1254});
        if(signal?.aborted||epoch!==this.#epoch){await handle.dispose();return false;}
        this.#entry={handle,frame,url,variant};
      }
      const parameters={node:element?.handle??null,action:args.action,
        point:args.x===undefined?null:{x:args.x,y:args.y},size:Math.max(20,Math.min(128,pref.size??28)),
        hold:Math.max(300,Math.min(5000,pref.hold??1800)),origin};
      const armed=await this.#entry.handle.evaluate((r,p)=>r?.arm(p)??false,parameters);
      if(signal?.aborted||epoch!==this.#epoch){await this.clear();return false;}
      return armed;
    }catch{await this.clear();return false;}
  }
  async settled(){await this.#entry?.handle.evaluate(r=>r?.disarm()).catch(()=>{});}
  async clear(){
    this.#epoch++; const entry=this.#entry;this.#entry=undefined;
    if(entry){await entry.handle.evaluate(r=>r?.hide()).catch(()=>{});await entry.handle.dispose().catch(()=>{});}
  }
}
