# Whale Computer v1 — module contract

All source in this project is ESM JavaScript (Node >=22.19) except the Swift helper. No TypeScript compilation is required for host code. The supported DSH SDK versions are recorded in package.json. The plugin communicates locally.

## Native stdio protocol

Helper executable at `native/build/Whale Computer.app/Contents/MacOS/whale-helper`, used directly from the plugin by default. An explicit helperPath can select a separate matching installation.

Each request and response is one bounded JSON line. stdout = protocol only, stderr = diagnostics (no content). AppKit runloop remains responsive while stdin read runs separately. v1 requests `{id:string,method:string,params:object}`; response `{id,result}` or `{id,error:{code,message,details?}}`. Notifications `{event:'paused'|'sessionAvailable'|'status',data:object}`. First notification `{event:'ready',data:{protocol:1,version:'0.4.10',...}}`. Max line 2MB; screenshots returned via base64 PNG only on explicit request, bounded dimensions/bytes (no arbitrary output paths).

Methods:
- `status {}` => `{protocol,version,permissions:{accessibility,screenCapture,inputMonitoring?},paused,capabilities,...}`. No permission prompts.
- `permissions.request {kind:'accessibility'|'screenCapture'|'inputMonitoring'}` => explicit user-initiated OS prompt only; blocked through model tool.
- `apps.find {query}` searches installed applications. `app.open {bundleId}` requests a background launch after host admission and target consent.
- `apps.list {}` => `{apps:[{bundleId,name,pid?,path?,running}],...}`; no AX content.
- `windows.list {bundleId}` => `{windows:[{windowId,pid,title,frame:{x,y,width,height},...}]}`; host read grant required.
- `observe {bundleId,windowId?,screenshot?:boolean,ocr?:boolean,maxNodes?:number,maxDepth?:number}` => snapshot below. Deny credential/security apps and AX secure fields, even if host is compromised by a model request.
- `action {bundleId,snapshotId,action,elementRef?,x?,y?,toX?,toY?,text?,key?,direction?,amount?,button?,count?,value?,selection?,axAction?,mode:'preserve'|'foreground'}` => `{dispatch:{route,verified:boolean,verification:string},snapshot}`. Validate exact snapshot/generation/window/process/frame before action. Each call follows the current DSH tool policy. Scoped read permission is separate. Never automatic preserve→foreground fallback. Coordinates are window-local points.
- `pause {}` => immediate cancellation generation + paused, release only own synthesized held inputs.
- `session.start {}` => host-only activation for a fresh admitted task in an enabled, unlocked console session without a persisted stop. Sleep clears outstanding authorizations. A wake notification never replays previous operations.
- `resume {}` => local user only via trusted UI; host model tool may NOT invoke.
- `overlay.configure {mode:'clean'|'companion'|'hidden',size:32..128,holdMs:300..5000,reducedMotion:boolean}`; nonactivating/click-through overlay. Installed stable hides for non-frontmost targets; the isolated, undeployed candidate instead uses conservative target-relative geometry/occlusion checks. Both hide for screenshots.
- `overlay.preview {}` user only; explicit target-free two-second appearance preview with global-front ordering, no input. This is not positioning, background-visibility or focus validation; not run in cursor-only work.
- `shutdown {}` => cancel all and exit.

### Candidate cursor self-report (informational only)

The isolated candidate adds this exact pure descriptor under `cursor` in `ready` / `status` and the pre-NSApplication `--self-test` result:

```json
{"schema":1,"kind":"software-overlay","visibility":"target-relative-conservative","independentNativePointer":false,"runtimeValidated":false}
```

Host `status.cursor` accepts only those five exact known field values from native ready or an explicitly user-requested diagnose response, projects a new whitelisted object, and adds fixed `source:'helper-self-report'`. Unrecognized/missing/malformed reports become `null`; unrelated raw cursor fields are dropped. `capabilities.overlay:true`, settings and caller payloads are not evidence. Only strict `native.connected===true` exposes the cached projection; disconnect and ready-without-report clear it, and responses from a disconnected generation cannot restore it.

The settings UI requires strict `nativeConnected===true` and all six known field values; otherwise it displays unknown. Rendering never auto-starts, diagnoses, mutates settings or requests permissions. A recognized report is labelled **helper self-report, not live accepted**: neither the schema nor source marker attests binary identity, actual display, an independent native input device, permission or per-action visibility. No authorization decision consumes this field. Installed legacy helpers remain unknown; do not infer this candidate behavior from their generic overlay capability.

Snapshot `{snapshotId,observedAt:number /*ms*/,bundleId,pid,processStart?:string,windowId,frame:{x,y,width,height},frontmost:boolean,tree:[{ref,role,title?,description?,value?,enabled,frame?,actions?:string[],secure?:boolean}],truncated:boolean,warnings:string[],image?:{base64,mediaType:'image/png',width,height,pointWidth,pointHeight},ocr?:[{text,confidence,frame}],...}`. refs opaque and snapshot-local. Do not rely on index across snapshots. Native cache max 32 snapshots, TTL 15 seconds; taking fresh snapshot invalidates prior target snapshot. Never return secure text in title/value/description/ocr. Image capability is not semantic verification.

Native actions: `click`, `type`, `setValue`, `press`, `scroll`, `drag`, `selectText`, `axAction`, `wait` (<=2s). Provide explicit `unsupported` errors where not implemented or cannot be safe; do not silently succeed. No script execution/clipboard/shell surface. Newlines in typing need explicit host approval warning as submit risk. `selectText` uses `{text,prefix?,suffix?}` if exact supported selection can be resolved.

## Browser adapter (Lead)

Export `BrowserAdapter` from `lib/browser.js`:
`new BrowserAdapter({workspace,now?,ttlMs?,connect?})`, `.connect({endpoint,signal})`, `.status()`, `.listTabs({signal})`, `.observe({tabId,screenshot?,signal})`, `.action({tabId,snapshotId,action,ref?,url?,text?,key?,value?,direction?,amount?,x?,y?,files?,signal})`, `.disconnect()`.
Node Playwright-core optional dependency. Explicit user configured loopback HTTP CDP only, endpoint validated before connection and redirects not allowed. Contexts/profiles never read/restarted; connected context is NOT isolated. Read per-origin/tab authorization enforced by coordinator. Browser snapshots use same identity/freshness pattern, DOM refs from bounded DOM traversal. No caller-provided JS execution. `action` aliases: navigate/click/type/setValue/press/select/scroll/drag/upload/wait. Upload canonical paths must be within workspace with symlinks resolved. Browser events are not proof server accepted a submission.

## Security module (Lead)

Export `PolicyError`, `PolicyStore`, `assertSafeTarget`, `validateAction`, `actionDigest`, `assertWorkspacePath`, `assertLocalEndpoint`. `PolicyStore({now?,ttlMs?})`: `.grant({sessionId,agentId,bundleId,access:'read'|'control',ttlMs?})`, `.require({sessionId,agentId,bundleId,access})`, `.revoke({sessionId?,agentId?,bundleId?})`, `.list({sessionId?,agentId?})`, `.pause()`, `.resume({userInitiated:true})`, `.assertRunning()`, `.issueConfirmation({sessionId,agentId,bundleId,snapshotId,action,args,ttlMs?}) -> opaque token`, `.consumeConfirmation(token,{same identity fields})`, `.clear()`.
Default no grants, controls require read+control, bounded memory/TTLs. All action calls MUST go through current DSH approval (not only risk-word matches); DSH `never` rejects. Consent token binds normalized full parameters and snapshot; one use/short lived. Approval request descriptions are plugin-generated and untrusted page text is not interpreted as consent. Model cannot directly grant, confirm, resume, set policies or endpoints. Persistent UI allowlists can govern discoverability only unless actual session grant freshly approved. Blocking password/security/terminal apps and URL schemes is defense in depth, not a complete sandbox.

## Host coordinator

Tools: `whale_status`, `whale_apps`, `whale_observe`, `whale_action`, `whale_browser` (typed operation enum), `whale_pause`. Discovery/status no content; observe requests read grant via native DSH approval if absent; control every action requests one-shot DSH approval, then issues/consumes bound token inside same operation. Use exec.agent's stable ID plus session identity, explicit deny when absent. Never accept user-supplied session IDs. Tool calls exclusive and cancellation propagated to native/browser; cancellation pauses/invalidates queues. Images saved via ctx.attachments.saveImages; render includes actual image attachment only if model supports images, text snapshot otherwise. Output never leaks base64 into text or logs.

UI uses authenticated existing DSH configForms for preferences and commands with revision handling. If a custom API is unavoidable, it must implement auth + strict same-origin + no CORS + CSRF and be reviewed first; NO naked localhost routes. User-only commands (`pause/resume/revoke/permissions/preview`) should travel through authenticated settings mutation or supported gateway, never model tool. Use nonce command envelope to avoid replay on host restart. Config defaults enabled=true, mode=auto, screenshots=false, overlay=companion. Backend initialization is lazy. Enabling the plugin does not request macOS permissions. An explicit stop is persisted per profile.

## Source/validation policy

Original art + source. If adapting permissive SkyLight code, preserve exact attribution+MIT notice in THIRD_PARTY_NOTICES; no Codex code/text/art. All tests run in project-specific directories, no deletion/move of existing user files. Compiling source is fine; actual desktop actions/OS prompts only after explicit testing authorization. No global settings or TCC resets.
