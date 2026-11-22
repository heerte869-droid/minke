/* Original, build-free DSH client bundle. No HTTP desktop-control routes. */
window.__ModuleLoader__.load({
  id: '@local/dsh-whale-computer',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const css = `
.wc {
  --wc-ink:var(--dsw-alias-label-primary,#202633);
  --wc-muted:var(--dsw-alias-label-secondary,#586375);
  --wc-base:var(--dsw-alias-settings-card-fill,#fff);
  --wc-line:color-mix(in srgb,var(--wc-ink) 15%,transparent);
  --wc-soft:color-mix(in srgb,var(--wc-ink) 5%,var(--wc-base));
  --wc-hover:color-mix(in srgb,var(--wc-ink) 9%,var(--wc-base));
  --wc-blue:#376dcc;
  --wc-good:color-mix(in srgb,#1b986d 72%,var(--wc-ink));
  --wc-red:color-mix(in srgb,#cb525c 70%,var(--wc-ink));
  --wc-ease:cubic-bezier(.2,.7,.2,1);
  container-type:inline-size;
  width:100%;max-width:900px;margin:0 auto;padding:12px 0 30px;
  color:var(--wc-ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
}
.wc *, .wc *::before,.wc *::after{box-sizing:border-box}
.wc h1,.wc h2,.wc p{margin:0}
.wc h1{font-size:25px;line-height:1.25;font-weight:680;letter-spacing:-.035em}
.wc h2{font-size:16px;line-height:1.4;font-weight:650;letter-spacing:-.012em}
.wc button,.wc input,.wc select{font:inherit;color:inherit}
.wc :focus-visible{outline:2px solid #6197ef;outline-offset:3px}
.wc [hidden]{display:none}
.wc-install .wc-field{display:flex;align-items:center;gap:8px}.wc-install input{min-width:0;flex:1;font:inherit;padding:5px 7px;color:inherit;background:var(--wc-base);border:1px solid var(--wc-line);border-radius:6px}
.wc button,.wc summary,.wc select,.wc input{touch-action:manipulation}
.wc button:disabled,.wc input:disabled,.wc select:disabled{opacity:.5;cursor:not-allowed}
.wc-header,.wc-section-heading,.wc-row,.wc-titleline,.wc-controls,.wc-field,.wc-form,.wc-permission,.wc-connection,.wc-actions{display:flex;align-items:center;gap:10px}
.wc-header,.wc-section-heading,.wc-row,.wc-permission,.wc-connection{justify-content:space-between}
.wc-header,.wc-titleline,.wc-controls{flex-wrap:wrap}
.wc-header{gap:12px;padding-bottom:10px}
.wc-titleline{gap:10px}.wc-controls{gap:8px}
.wc-state{display:inline-flex;align-items:center;gap:6px;color:var(--wc-muted);font-size:12px;font-weight:600}
.wc-state::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}
.wc-state.running,.wc-result.granted{color:var(--wc-good)}
.wc-subline,.wc-note,.wc-row small,.wc-feedback,.wc-error,.wc-result,.wc-size-value{font-size:12px}
.wc-subline,.wc-note,.wc-row small,.wc-result,.wc-size-value{color:var(--wc-muted)}
.wc-subline{display:flex;align-items:center;flex-wrap:wrap;gap:3px 10px}
.wc-subline span+span{padding-inline-start:10px;border-inline-start:1px solid var(--wc-line)}
.wc-note,.wc-row small{display:block;line-height:1.55}
.wc-row label,.wc-row strong,.wc-field-label{font-size:13px;font-weight:550}
.wc-row small{font-weight:400;margin-top:2px}
.wc-button{position:relative;display:inline-flex;align-items:center;justify-content:center;min-height:32px;
  padding:5px 11px;border:1px solid var(--wc-line);border-radius:8px;
  background:var(--wc-soft);color:var(--wc-ink);cursor:pointer;font-size:12px!important;font-weight:580!important;line-height:1.4;
  transition:background-color 110ms var(--wc-ease),border-color 110ms var(--wc-ease)}
.wc-button.primary{color:#fff;background:var(--wc-blue);border-color:transparent}
.wc-button.danger{color:var(--wc-red);background:transparent;border-color:color-mix(in srgb,var(--wc-red) 35%,transparent)}
.wc-button.quiet{background:transparent}
.wc-button:active:not(:disabled){box-shadow:inset 0 0 0 1px currentColor}
.wc-button[aria-busy=true] .wc-button-text{opacity:.12}
.wc-button[aria-busy=true]::after{content:'';position:absolute;width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:wc-spin 850ms linear infinite}
@keyframes wc-spin{to{transform:rotate(360deg)}}
.wc-button:focus-visible,.wc-summary:focus-visible{z-index:1}
.wc-disclosure>summary{display:flex;align-items:center;gap:8px;width:fit-content;max-width:100%;
  padding:8px 1px;cursor:pointer;list-style:none;color:var(--wc-muted);font-weight:550;font-size:12px;border-radius:3px}
.wc-disclosure>summary::-webkit-details-marker{display:none}
.wc-disclosure>summary::before{content:'';border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;width:6px;height:6px;transform:rotate(-45deg);transition:transform 125ms var(--wc-ease);margin:0 3px 2px 2px}
.wc-disclosure[open]>summary::before{transform:rotate(45deg)}
.wc-control{margin-top:6px}.wc-control-body{padding:0 0 5px}
.wc-control-body>p{margin:6px 0}
.wc-section{margin-top:15px;padding-top:16px;border-top:1px solid var(--wc-line);min-width:0}
.wc-section-heading{gap:10px;margin-bottom:12px;flex-wrap:wrap}
.wc-props{display:grid;gap:12px;align-content:center;min-width:0}
.wc-appearance{border:1px solid var(--wc-line);background:var(--wc-soft);border-radius:13px;display:grid;grid-template-columns:minmax(115px,31%) minmax(0,1fr);overflow:hidden}
.wc-cursor-preview{display:grid;place-items:center;min-height:146px;min-width:0;overflow:hidden;
  background-color:color-mix(in srgb,var(--wc-base) 89%,#7398ee);
  background-image:radial-gradient(circle,color-mix(in srgb,var(--wc-ink) 13%,transparent) .7px,transparent .9px);
  background-size:12px 12px;border-inline-end:1px solid var(--wc-line)}
.wc-cursor{display:block;max-width:none;pointer-events:none}
.wc-props{padding:14px 16px}.wc-choice-row,.wc-size-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px}
.wc-field-label{color:var(--wc-ink)}.wc-size-value{font-variant-numeric:tabular-nums}
.wc-variant-choices{display:inline-flex;gap:2px;padding:3px;background:var(--wc-base);border:1px solid var(--wc-line);border-radius:8px}
.wc-variant-choices label{position:relative;cursor:pointer}
.wc-variant-choices input{position:absolute;opacity:0;width:1px;height:1px}
.wc-variant-choices span{display:block;padding:3px 10px;min-width:43px;border-radius:5px;text-align:center;font-size:12px;color:var(--wc-muted)}
.wc-variant-choices input:checked+span{color:var(--wc-ink);font-weight:650;background:var(--wc-hover);box-shadow:0 1px 2px #0001}
.wc-variant-choices input:focus-visible+span{outline:2px solid #6197ef;outline-offset:1px}
.wc-variant-choices input:disabled+span{opacity:.5;cursor:not-allowed}
.wc-variant-choices label:active input:not(:disabled)+span{box-shadow:inset 0 0 0 1px var(--wc-line)}
.wc input[type=range]{display:block;accent-color:var(--wc-blue);width:100%;margin:2px 0 0;height:22px;cursor:pointer}
.wc-row,.wc-permission{min-height:39px;padding:7px 0;border-bottom:1px solid var(--wc-line)}
.wc-row:last-child,.wc-permission:last-child{border-bottom:0}
.wc input[type=checkbox]{appearance:none;position:relative;width:34px;height:20px;flex:none;margin:0;background:color-mix(in srgb,var(--wc-ink) 30%,var(--wc-base));border:1px solid var(--wc-line);border-radius:99px;cursor:pointer}
.wc input[type=checkbox]::before{content:'';position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:white;box-shadow:0 1px 2px #0002;transition:transform 130ms var(--wc-ease)}
.wc input[type=checkbox]:checked{background:var(--wc-blue);border-color:var(--wc-blue)}
.wc input[type=checkbox]:checked::before{transform:translateX(14px)}
.wc input[type=checkbox]:active:not(:disabled){box-shadow:0 0 0 2px var(--wc-line)}
.wc select,.wc input[type=text],.wc input[type=number]{background:var(--wc-base);color:inherit;border:1px solid var(--wc-line);border-radius:7px;min-height:32px;padding:4px 8px;max-width:100%;min-width:0}
.wc select{max-width:200px;font-size:12px}.wc input[type=number]{width:84px;font-variant-numeric:tabular-nums}
.wc input[type=text]{flex:1;width:100%;font:12px/1.5 ui-monospace,monospace}
.wc-form{gap:6px;margin-top:5px}.wc-form button{flex:none}
.wc-form-label{font-size:12px;font-weight:580}
.wc-advanced{margin-top:5px}.wc-status-label{white-space:nowrap;flex-shrink:0}
.wc-status-text{min-width:0;text-align:end;color:var(--wc-muted);font-size:12px;line-height:1.5;white-space:normal}
.wc-result{font-weight:520}.wc-permission>span:first-child,.wc-connection strong{font-size:13px;font-weight:550}
.wc-permission .wc-button{min-height:26px;padding:2px 8px;font-size:11px!important}
.wc-connection{margin:1px 0 5px}.wc-secondary{display:grid;gap:0 28px}
.wc-feedback{margin-top:8px;padding:7px 10px;border-radius:6px;background:var(--wc-soft);color:var(--wc-muted)}
.wc-feedback.error,.wc-error{color:var(--wc-red)}.wc-error{margin-top:5px}
.wc input[aria-invalid=true]{border-color:var(--wc-red)}
.wc :disabled{transition:none}
@media(hover:hover) and (pointer:fine){
  .wc-button:not(:disabled):hover,.wc-variant-choices label:hover input:not(:checked):not(:disabled)+span{background:var(--wc-hover)}
  .wc-button.primary:not(:disabled):hover{background:#295cae}
  .wc-button.danger:not(:disabled):hover{background:color-mix(in srgb,var(--wc-red) 9%,transparent)}
  .wc-disclosure>summary:hover{color:var(--wc-ink)}
  .wc select:hover:not(:disabled),.wc input[type=text]:hover:not(:disabled),.wc input[type=number]:hover:not(:disabled){border-color:var(--wc-muted)}
}
@container(min-width:730px){.wc-secondary{grid-template-columns:1fr 1fr}.wc-props{grid-template-columns:1fr 1fr;gap:22px}.wc-choice-row{display:grid;justify-content:start}.wc-cursor-preview{min-height:138px}}
@container(max-width:390px){.wc-props{padding:10px}.wc-appearance{grid-template-columns:minmax(100px,36%) minmax(0,1fr)}.wc-choice-row{display:grid;justify-content:start}.wc-cursor-preview{min-height:144px}.wc-titleline{gap:8px}.wc-variant-choices span{padding:3px 7px;min-width:38px}}
@container(max-width:290px){.wc-appearance{grid-template-columns:1fr}.wc-cursor-preview{border-inline-end:0;border-bottom:1px solid var(--wc-line)}.wc-choice-row{display:flex}.wc-row{flex-wrap:wrap}}
.wc.reduced *,.wc.reduced *::before,.wc.reduced *::after{animation:none!important;transition:none!important}
@media(prefers-reduced-motion:reduce){.wc *,.wc *::after,.wc *::before{animation:none!important;transition:none!important}}
`;
    function cursorGlyph(size,variant) {
      return h('img',{className:'wc-cursor',alt:'',width:size,height:size,src:typeof WhaleCursorPNG==='object'?WhaleCursorPNG[variant]:'assets/'+(variant==='mini'?'cursor-whale.png':'cursor-whale-large.png')});
    }
    const parse = raw => { try { const value = JSON.parse(raw || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; } };
    function Section({ form, useSnapshot, readDisplay }) {
      if (!form || !useSnapshot) return null;
      return h(Loaded, { form, useSnapshot, readDisplay });
    }
    function Loaded({ form, useSnapshot, readDisplay }) {
      const state = useSnapshot(value => value); const value = state.value ?? {};
      const [display, setDisplay] = React.useState('');
      React.useEffect(() => {
        if (!readDisplay) return;
        let active = true, timer;
        const refresh = async () => {
          try { const next = await readDisplay(); if (active) setDisplay(next); }
          catch { if (active) setDisplay(''); }
          if (active) timer = setTimeout(refresh, document.hidden ? 2500 : 400);
        };
        void refresh();
        return () => { active = false; clearTimeout(timer); };
      }, [readDisplay]);
      const response = parse(readDisplay ? display : value.response); const status = response.status ?? {};
      const cursor = status.cursor;
      const variant = value.cursorVariant === 'mini' ? 'mini' : 'large';
      const cursorReported = status.nativeConnected === true && cursor !== null && typeof cursor === 'object' && !Array.isArray(cursor)
        && cursor.schema === 1 && cursor.kind === 'software-overlay' && cursor.visibility === 'target-window'
        && cursor.independentNativePointer === false && cursor.runtimeValidated === false && cursor.source === 'helper-self-report';
      const [feedbackArea,setFeedbackArea] = React.useState('control');
      const [fieldError,setFieldError] = React.useState({});
      const [feedback, setFeedback] = React.useState(null); const [busy, setBusy] = React.useState(false); const [pending, setPending] = React.useState(null);
      React.useEffect(() => {
        if (!feedback || feedback.error || busy || pending) return;
        const timer = setTimeout(() => setFeedback(null), 4200);
        return () => clearTimeout(timer);
      }, [feedback, busy, pending]);
      const [endpoint, setEndpoint] = React.useState(value.browserEndpoint ?? '');
      const [cursorSize, setCursorSize] = React.useState(value.cursorSize ?? 28);
      const [cursorHold, setCursorHold] = React.useState(String(value.cursorHoldMs ?? 1800));
      React.useEffect(() => { setCursorSize(value.cursorSize ?? 28); }, [value.cursorSize]);
      React.useEffect(() => { setCursorHold(String(value.cursorHoldMs ?? 1800)); }, [value.cursorHoldMs]);
      const writable = state.status === 'ready' && state.writable === true;
      const activeRequest = React.useRef(null);
      const mounted = React.useRef(true);
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; activeRequest.current = null; }; }, []);
      function begin(kind, priority = false) {
        if (!mounted.current || !writable || (activeRequest.current && !priority)) return null;
        if (priority && activeRequest.current?.kind === kind) return null;
        const request = { id: globalThis.crypto.randomUUID(), kind };
        activeRequest.current = request;
        setBusy(true); setFeedback(null);
        return request;
      }
      function owns(request) { return mounted.current && activeRequest.current === request; }
      function finish(request) {
        if (!owns(request)) return false;
        activeRequest.current = null; setBusy(false); return true;
      }

      React.useEffect(() => { setEndpoint(value.browserEndpoint ?? ''); }, [value.browserEndpoint]);
      React.useEffect(() => {
        if (!pending || activeRequest.current?.id !== pending.nonce) return;
        if (response.boot && response.boot !== pending.boot) { activeRequest.current = null; setPending(null); setBusy(false); setFeedback({ error: true, text: '宿主已重启，旧命令已失效。请检查状态后重新操作。' }); return; }
        if (response.ackNonce !== pending.nonce) return;
        activeRequest.current = null; setPending(null); setBusy(false);
        const failures = { chrome_bridge_unavailable:'DSH 浏览器服务尚未就绪，请稍后重试。', chrome_not_initialized:'请先安装并打开 Chrome 一次，然后重试。', chrome_registration_failed:'无法写入 Chrome 本机连接，请检查当前用户的目录权限。', session_inactive:'Mac 解锁并返回当前会话后即可继续。', protocol_mismatch: '电脑控制组件版本不匹配，请更新组件后重试。', helper_missing: '尚未找到电脑控制组件，请先完成安装。', helper_disconnected: '电脑控制连接已断开，请重新检查连接。', helper_timeout: '电脑控制组件响应超时，操作已暂停，请检查状态。', permission_denied: '系统权限尚未就绪，请检查下方授权状态。', state_changed: '操作已被较新的停止或设置更改取消。', cancelled: '操作已取消，请检查当前状态。' };
        const labels = { pause: '已暂停并清除授权', resume: '已恢复操作。', diagnose: '权限状态已更新。', revoke: '已撤销全部授权并暂停', permissions: '权限请求已处理。', prepareChromeInstall:response.result?.managerOpened?'扩展目录已准备好。':'扩展目录已准备好，请手动打开 chrome://extensions。', downloadExtension:'已保存到下载文件夹：'+(response.result?.filename||'DSH-Chrome.zip'), extensionDisconnect:'已断开浏览器扩展',preview: '已显示光标预览' };
        setFeedback({ error: response.outcome !== 'completed', text: response.outcome === 'completed' ? labels[pending.op] : (failures[response.result?.code] ?? '操作未完成，请检查连接和权限后重试。') });
      }, [response.ackNonce, response.boot, response.outcome, pending]);
      React.useEffect(() => {
        if (!pending) return;
        const timer = setTimeout(() => { if (activeRequest.current?.id !== pending.nonce) return; activeRequest.current = null; setBusy(false); setPending(null); setFeedback({ error: true, text: '未收到宿主执行确认。不能视为成功；请重新检查连接。' }); }, 25_000);
        return () => clearTimeout(timer);
      }, [pending]);
      async function save(ops, success = '设置已保存。', area = 'control') {
        const request = begin('save'); if (!request) return;
        setFeedbackArea(area);
        try {
          const accepted = await form.mutate(ops, state.revision);
          if (!owns(request)) return;
          if (!accepted) throw new Error('not accepted');
          setFeedback({ error: false, text: success, savedWhileRunning: running && ops.some(item => item.path[0] !== 'cursorVariant') });
        } catch {
          if (owns(request)) setFeedback({ error: true, text: '保存失败或设置已被其他窗口更改。已保留当前输入；请刷新状态后重试。' });
        } finally { finish(request); }
      }
      async function command(op, extra = {}) {
        if (!response.boot || typeof response.boot !== 'string') {
          setFeedback({ error: true, text: '尚未连接到 DSH，请检查插件是否运行。' }); return;
        }
        const request = begin(op, op === 'pause'); if (!request) return;
        setFeedbackArea(({preview:'cursor', diagnose:'permissions', permissions:'permissions', extensionDisconnect:'browser', downloadExtension:'browser', prepareChromeInstall:'browser'})[op] ?? 'control');
        const envelope = { boot: response.boot, nonce: request.id, op, ...extra };
        setPending(envelope);
        setFeedback({ error: false, text: '正在等待 DSH 确认…' });
        const ops = [{ op: 'set', path: ['command'], value: JSON.stringify(envelope) }];
        if (op === 'resume' && value.enabled !== true) ops.unshift({op:'set',path:['enabled'],value:true});
        if (op === 'pause') ops.unshift({ op: 'set', path: ['enabled'], value: false });
        try { if (!await form.mutate(ops, state.revision)) throw new Error('not accepted'); }
        catch {
          if (owns(request)) {
            finish(request); setPending(null);
            setFeedback({ error: true, text: '命令未被设置服务接受，不能视为已执行。' });
          }
        }
      }
      function saveEndpoint(event) {
        event.preventDefault();
        const next = endpoint.trim();
        if (next) {
          let url;
          try { url = new URL(next); } catch {}
          if (!url || url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || Number(url.port) < 1 ||
            url.username || url.password || url.search || url.hash || !['/', '/json/version'].includes(url.pathname)) {
            setFieldError(old=>({...old,endpoint:'请输入本机地址和端口，例如 http://127.0.0.1:9222。'})); return;
          }
        }
        setFieldError(old=>({...old,endpoint:''}));
        save([{ op: 'set', path: ['browserEndpoint'], value: next }], undefined, 'browser');
      }
      const controlState=status.controlState ?? (value.enabled===false?'stopped':status.paused===false?'running':status.pauseReason==='session-or-sleep'?'waiting_session':'paused');
      const running=Boolean(response.boot && ['running','standby'].includes(controlState));
      const wantResume=response.boot && ['stopped','paused'].includes(controlState) && pending?.op!=='resume';
      const browserOnly=status.browserOnly===true;
      const browserState=!response.boot?'loading':status.extensionState ?? (status.extensionConnected?'shared':status.extensionAutoReady?'ready':'not_connected');
      const browserReady=browserState==='ready'||browserState==='shared';
      const browserLabel={loading:'等待连接状态',not_connected:'未连接',waiting:'等待 Chrome 加载',offline:'已断开',multiple:'多个配置已连接',ready:'可自动调用',shared:'已共享'}[browserState];
      const installDirectory=response.installDirectory || (response.operation==='prepareChromeInstall' && response.result?.directory);
      async function copyInstallDirectory(event){
        const field=event.currentTarget.parentElement?.querySelector('input');
        try{await navigator.clipboard.writeText(installDirectory);setFeedbackArea('browser');setFeedback({text:'目录已复制。'})}
        catch{field?.focus();field?.select();setFeedbackArea('browser');setFeedback({text:'已选中目录，可按 ⌘C 复制。'})}
      }
      const stateLabel=!response.boot?'正在连接':({standby:'已就绪',running:'运行可用',stopped:'已停止',waiting_session:'等待解锁或唤醒',paused:'已暂停'}[controlState]??'正在连接');
      const locked = !writable || busy;
      const button = (label, op, style = '', extra = {}, name = label) => h('button', {
        type: 'button', className: 'wc-button ' + style, 'aria-label': name,
        disabled: !writable || !response.boot || (busy && op !== 'pause'),
        'aria-busy': pending?.op === op && (op !== 'permissions' || pending.kind === extra.kind),
        onClick: () => command(op, extra),
      }, h('span', { className: 'wc-button-text' }, label));
      const toggle = (key, title, detail, area = 'control') =>
        h('div', { className: 'wc-row', key },
          h('label', { htmlFor: 'wc-' + key }, h('strong', null, title), detail && h('small', null, detail)),
          h('input', { id: 'wc-' + key, type: 'checkbox', checked: value[key] === true, disabled: locked,
            onChange: e => save([{ op: 'set', path: [key], value: e.target.checked }], undefined, area) }));
      const heading = (title, action) => h('div', { className: 'wc-section-heading' }, h('h2', null, title), action);
      const disclosure = (label, body, cls = 'wc-advanced') => h('details', { className: 'wc-disclosure ' + cls, open: browserOnly && label==='浏览器调试连接' ? true : undefined },
        h('summary', null, label), body);
      const message = area => feedback && feedbackArea === area &&
        h('div', { className: 'wc-feedback' + (feedback.error ? ' error' : ''), role: feedback.error ? 'alert' : 'status' }, feedback.savedWhileRunning && status.paused === true ? '设置已保存，电脑控制已暂停。' : feedback.text);
      const permissionRow = ([key, title]) => {
        const granted = status.nativeConnected === true ? status.permissions?.[key] : undefined;
        return h('div', { className: 'wc-permission', key }, h('span', null, title),
          h('div', { className: 'wc-field' },
            h('span', { className: 'wc-result' + (granted === true ? ' granted' : '') },
              granted === true ? '已授权' : granted === false ? '未授权' : '未检查'),
            granted !== true && button('申请', 'permissions', 'quiet', { kind: key }, '申请' + title)));
      };
      function commitSize(event) {
        const next = Number(event.currentTarget.value);
        if (next !== (value.cursorSize ?? 28)) save([{ op: 'set', path: ['cursorSize'], value: next }], undefined, 'cursor');
      }
      return h('main', { className: 'wc' + (value.reducedMotion ? ' reduced' : ''), 'aria-label': '电脑控制设置' },
        h('header', { className: 'wc-hero' },
          h('div', { className: 'wc-header' },
            h('div', { className: 'wc-titleline' }, h('h1', null, '电脑控制'),
              h('span', { className: 'wc-state' + (running ? ' running' : ''), role: 'status' }, stateLabel)),
            h('div', { className: 'wc-controls' },
              wantResume ? button('恢复操作','resume','primary') : button('停止操作','pause','danger'))),
          h('div', { className: 'wc-subline' },
            h('span', null, !response.boot ? '等待组件响应' : browserOnly ? 'Chrome 浏览器控制' : status.nativeConnected ? '电脑控制组件已连接' : controlState==='standby' ? '首次操作时连接电脑控制组件' : '电脑控制组件未连接'),
            value.sessionAccess && h('span', null, '遵循会话权限')),
          !browserOnly && !value.enabled && h('p',{className:'wc-note'},'电脑控制可访问工作区外的应用。允许截图后，窗口画面可能发送给当前模型。'),
          message('control'),
          !writable && h('p', { className: 'wc-feedback', role: 'status' }, state.status === 'ready' ? '当前设置为只读。' : '正在加载设置。'),
          disclosure('控制与安全', h('div', { className: 'wc-control-body' },
            toggle('sessionAccess', '沿用 DSH 会话权限', '已获准的调用可以读取本次任务使用的应用。'),
            toggle('screenshots', '允许屏幕捕获与 OCR', '按需截取目标窗口。截图可能发送给当前模型。'),
            !browserOnly && toggle('privateSkyLight', '实验性 PID / 窗口输入', '下次操作时生效。部分应用可能不支持。'),
            !browserOnly && h('p', { className: 'wc-note' }, '桌面操作可访问工作区外的应用。')), 'wc-control')),
        h('section', { className: 'wc-section' },
          heading('光标外观', !browserOnly && button('在屏幕上预览', 'preview', 'quiet')),
          h('div', { className: 'wc-appearance' },
            h('div', { className: 'wc-cursor-preview', role: 'img', 'aria-label': '鲸鱼娘光标外观预览' }, cursorGlyph(cursorSize, variant)),
            h('div', { className: 'wc-props' },
              h('div', { className: 'wc-choice-row' }, h('span', { className: 'wc-field-label', id: 'wc-variant-name' }, '鲸鱼娘版本'),
                h('div', { className: 'wc-variant-choices', role: 'radiogroup', 'aria-labelledby': 'wc-variant-name' },
                  [['mini','迷你'],['large','大号']].map(([key, label]) => h('label', { key },
                    h('input', { name: 'wc-variant', type: 'radio', value: key, checked: variant === key, disabled: locked,
                      onChange: () => save([{ op:'set', path:['cursorVariant'], value:key }], '已切换鲸鱼娘版本。', 'cursor') }),
                    h('span', null, label))))),
              h('div', null, h('div', { className: 'wc-size-head' }, h('label', { className: 'wc-field-label', htmlFor: 'wc-size' }, '整体大小'),
                h('span', { className: 'wc-size-value', 'aria-hidden':true }, cursorSize + ' pt')),
                h('input', { id: 'wc-size', type:'range', min:20, max:128, step:2, value:cursorSize, disabled:locked,
                  'aria-valuetext': cursorSize + ' 点', onChange:e=>setCursorSize(Number(e.target.value)),
                  onPointerUp: commitSize, onKeyUp: e=>{ if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key)) commitSize(e); },
                  onBlur:commitSize })))),
          message('cursor'),
          disclosure('显示选项', h('div', null,
            h('div', { className: 'wc-row' }, h('label', { htmlFor:'wc-overlay' }, '显示方式'),
              h('select', { id:'wc-overlay', value:value.overlayMode ?? 'companion', disabled:locked,
                onChange:e=>save([{op:'set',path:['overlayMode'],value:e.target.value}],undefined,'cursor') },
                h('option',{value:'clean'},'动作后收起'),h('option',{value:'companion'},'跟随操作目标'),h('option',{value:'hidden'},'隐藏'))),
            (value.overlayMode ?? 'companion') === 'clean' && h('div', { className:'wc-row' }, h('label',{htmlFor:'wc-hold'},'收起延迟（毫秒）'),
              h('input',{id:'wc-hold',type:'number',min:300,max:5000,step:1,value:cursorHold,disabled:locked,'aria-invalid':Boolean(fieldError.hold),
                'aria-describedby':fieldError.hold?'wc-hold-error':undefined, onChange:e=>{setCursorHold(e.target.value);setFieldError(old=>({...old,hold:''}));},
                onBlur:e=>{const n=Number(e.target.value);if(!Number.isInteger(n)||n<300||n>5000){setFieldError(old=>({...old,hold:'请输入 300–5000 之间的整数。'}));return;}
                  if(n!==(value.cursorHoldMs??1800)) save([{op:'set',path:['cursorHoldMs'],value:n}],undefined,'cursor');}})),
            fieldError.hold && (value.overlayMode ?? 'companion') === 'clean' && h('p',{id:'wc-hold-error',className:'wc-error',role:'alert'},fieldError.hold),
            toggle('reducedMotion','减少动态效果','保留静态忙碌提示，同时遵循系统设置。','cursor'),
            !browserOnly && h('div',{className:'wc-row'},h('span',{className:'wc-status-label'},'后台可见性'),
              h('span',{className:'wc-status-text'},cursorReported?'支持在目标窗口显示':'尚未取得组件报告'))))),
        h('div', { className: 'wc-secondary' },
          !browserOnly && h('section', { className: 'wc-section' },
            heading('系统权限', button('检查权限', 'diagnose', 'quiet')),
            [['accessibility','辅助功能'],['screenCapture','屏幕录制'],['inputMonitoring','输入监控']].map(permissionRow),
            message('permissions')),
          h('section', { className: 'wc-section' },
            heading('浏览器连接', !browserOnly && !['ready','shared','multiple','offline'].includes(browserState) &&
              button(browserState==='waiting'?'打开扩展管理页':'安装 Chrome 扩展','prepareChromeInstall','quiet')),
            !browserOnly && h('div',{className:'wc-connection'},h('strong',null,'Chrome 扩展'),
              h('div',{className:'wc-field'},h('span',{className:'wc-result'+(browserReady?' granted':''),role:'status'},browserLabel),
                browserState==='shared' && button('断开扩展','extensionDisconnect','quiet'))),
            !browserOnly && browserState==='not_connected' && h('p',{className:'wc-note'},'首次使用需在 Chrome 中安装一次。已安装可直接打开 Chrome。'),
            browserState==='offline' && h('p',{className:'wc-note'},'打开已启用 DSH 扩展的 Chrome 配置即可重连。'),
            browserState==='multiple' && h('p',{className:'wc-note'},'在要使用的 Chrome 网页打开 DSH 扩展，选择「共享当前页」。'),
            browserState==='waiting' && h('div',{className:'wc-install'},
              h('p',{className:'wc-note'},'在 chrome://extensions 开启开发者模式，点「加载已解压的扩展程序」，选择下列目录。'),
              installDirectory && h('div',{className:'wc-field'},h('input',{readOnly:true,value:installDirectory,'aria-label':'扩展目录',onFocus:e=>e.target.select()}),
                h('button',{type:'button',className:'wc-button quiet',onClick:copyInstallDirectory},'复制目录'))),
            !browserOnly && disclosure('其他安装方式',h('div',null,
              button('下载 ZIP','downloadExtension','quiet'),
              browserState==='offline' && button('重新配置连接','prepareChromeInstall','quiet'),
              h('p',{className:'wc-note'},'手动分发可下载 ZIP。首次在本机使用时仍需配置本机连接。'))),
            disclosure('浏览器调试连接', h('div',null,
              h('label',{htmlFor:'wc-endpoint',className:'wc-form-label'},'本机浏览器调试地址'),
              h('form',{className:'wc-form',onSubmit:saveEndpoint},h('input',{id:'wc-endpoint',type:'text',inputMode:'url',
                placeholder:'http://127.0.0.1:9222',value:endpoint,disabled:locked,autoComplete:'off',spellCheck:false,
                'aria-invalid':Boolean(fieldError.endpoint),'aria-describedby':fieldError.endpoint?'wc-endpoint-error':undefined,
                onChange:e=>{setEndpoint(e.target.value);setFieldError(old=>({...old,endpoint:''}));}}),
                h('button',{type:'submit',className:'wc-button',disabled:locked||endpoint.trim()===(value.browserEndpoint??'')},'保存')),
              fieldError.endpoint && h('p',{id:'wc-endpoint-error',className:'wc-error',role:'alert'},fieldError.endpoint),
              h('p',{className:'wc-note'},'已连接的调试浏览器：'+(Number.isInteger(status.browserConnections)?status.browserConnections:'未知')))),
            message('browser'))));
    }
    return { name: 'whale-computer-client', inject: ['slots', 'configForms', 'remote'], apply(ctx) {
      ctx.effect(() => { const tag = document.createElement('style'); tag.dataset.plugin = 'whale-computer'; tag.textContent = css; document.head.appendChild(tag); return () => tag.remove(); });
      function section(scope, readDisplay) {
        scope.effect(() => scope.configForms.whileServed(['whale-computer'], () => scope.slots.inject('settings.section', () =>
          scope.slots.register({ name: 'settings.section', id: 'whale-computer', order: 35, label: () => '电脑控制', inject: () => {
            const form = scope.configForms.get('whale-computer');
            return { form, readDisplay, hooks: { snapshot: form } };
          } }, Section))));
      }
      if (typeof WhaleDisplayTransport === 'undefined') { section(ctx); return; }
      ctx.effect(async () => {
        const dispose = await ctx.remote.$mount(WhaleDisplayTransport.TYPERT_REMOTE);
        return () => dispose();
      });
      ctx.inject(['remote','remote.whaleDisplay','slots','configForms'], child => {
        section(child, async () => {
          const result = await child.remote.whaleDisplay.read();
          if (!result.ok) throw new Error('Host status unavailable: ' + result.error.code);
          return result.value;
        });
      });
    } };
  },
});
