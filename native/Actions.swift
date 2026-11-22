import Foundation
import AppKit
import ApplicationServices

extension NativeEngine {
    func validatedSnapshot(_ p:[String:Any],generation:UInt64) throws -> (SnapshotRecord,WindowTarget,ElementRecord?) {
        try state.check(generation)
        let bundle=try str(p,"bundleId",max:255);try safeBundle(bundle)
        var snapshot=try cache.get(str(p,"snapshotId",max:128),bundle:bundle,generation:generation)
        snapshot.deniedOrigins=Array(Set(snapshot.deniedOrigins + (try deniedOrigins(p))))
        let element:ElementRecord?
        if let ref=p["elementRef"] as? String {
            guard let found=snapshot.elements[ref] else { throw NativeError("stale_element","Element ref does not belong to this snapshot") }; element=found
        } else { element=nil }
        return (snapshot,try revalidate(snapshot,element:element),element)
    }
    // A full-display Dock surface can contain transparent regions. Inspect only the
    // hit's PID before querying a window, and never request its title or content.
    private func hitMatchesWindow(_ point: CGPoint, _ window: AXUIElement, _ pid: pid_t) -> Bool {
        let system = AXUIElementCreateSystemWide()
        var element: AXUIElement?, owner: pid_t = 0, hitWindow: CFTypeRef?
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &element) == .success,
              let element, AXUIElementGetPid(element, &owner) == .success, owner == pid else { return false }
        if CFEqual(element, window) { return true }
        AXUIElementSetMessagingTimeout(element, 0.10)
        guard AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &hitWindow) == .success,
              let hitWindow else { return false }
        return CFEqual(hitWindow, window)
    }
    private func presentCursor(point:CGPoint,phase:String,actionID:UUID,snapshot:SnapshotRecord,generation:UInt64,element:AXUIElement?=nil) {
        DispatchQueue.main.async { [weak self] in
            // This is visual-only. Input still consumes the original observation and its normal freshness checks.
            let livePoint:(()->CGPoint?)?=element.map { control in
                return {
                    guard let win=ax(control,kAXWindowAttribute),CFGetTypeID(win)==AXUIElementGetTypeID(),
                          CFEqual(win,snapshot.window),let r=axFrame(control),CursorVisibility.valid(r) else {return nil}
                    return CGPoint(x:r.midX,y:r.midY)
                }
            }
            self?.overlay?.show(point:point,state:phase,actionID:actionID,pid:snapshot.pid,bundle:snapshot.bundle,processStart:snapshot.processStart,windowID:snapshot.windowID,frame:snapshot.frame,livePoint:livePoint,hitBelongsToWindow:{ [weak self] at in self?.hitMatchesWindow(at, snapshot.window, snapshot.pid) ?? false },stillAllowed:{ [weak self] in
                guard let self else {return false}
                let now=millis();guard now>=snapshot.at,now-snapshot.at<=15000 else {return false}
                do {try self.state.check(generation);return true} catch {return false}
            })
        }
    }
    func perform(_ p:[String:Any],generation:UInt64) throws -> [String:Any] {
        let (s,t,e)=try validatedSnapshot(p,generation:generation)
        let action=try str(p,"action",max:32)
        let mode=p["mode"] as? String ?? "preserve"
        guard mode=="auto" || mode=="preserve" || mode=="foreground" else { throw NativeError("invalid_params","Unknown input mode") }
        guard !s.secure else { throw NativeError("secure_content","Windows containing secure controls cannot be controlled") }
        if e == nil || mode=="foreground" {
            guard s.complete else {throw NativeError("incomplete_observation","Raw or foreground input requires complete secure-field inspection")}
            try assertCaptureSafety(s)
        }
        // One action consumes its observation even on a delivery/verification failure.
        rawFocus=e?.element;defer {rawFocus=nil;state.endRawInput(generation)}
        cache.consume(s.id)
        var route="accessibility";var verified=false;var verification="Post-action state is returned; application effect must be reviewed."
        let at:CGPoint = try actionPoint(p,snapshot:s,element:e)
        let cursorActionID=UUID()
        presentCursor(point:at,phase:["type","setValue","selectText"].contains(action) ? "typing" : action == "wait" ? "waiting" : action == "click" ? "click" : "moving",actionID:cursorActionID,snapshot:s,generation:generation,element:(p["x"]==nil && p["y"]==nil ? e?.element:nil))
        defer { DispatchQueue.main.async { [weak self] in self?.overlay?.settle(actionID:cursorActionID) } }
        let dispatchStart=state.dispatchCount
        do {
        switch action {
        case "wait":
            let amount=try boundedInt(p["amount"],250,0,2000)
            let until=Date().addingTimeInterval(Double(amount)/1000)
            while Date()<until { try state.check(generation);Thread.sleep(forTimeInterval:0.02) }
            route="wait"; verified=true;verification="Bounded wait completed without cancellation."
        case "setValue":
            guard let e else { throw NativeError("invalid_params","setValue requires an elementRef") }
            let text=try textParam(p,preferred:"value",allowEmpty:true)
            try setAXValue(s,e,text,generation:generation)
            verified=axString(e.element,kAXValueAttribute,limit:65536)==text
            verification=verified ? "AXValue read-back matched the requested value." : "AX accepted the value but read-back did not confirm it."
        case "selectText":
            guard let e else { throw NativeError("invalid_params","selectText requires an elementRef") }
            try selectText(s,e,p,generation:generation)
            verified=true;verification="AXSelectedTextRange read-back matched the unique requested range."
        case "type":
            let text=try textParam(p,preferred:"text",allowEmpty:true)
            if let e, axString(e.element,kAXRoleAttribute)==kAXTextFieldRole || axString(e.element,kAXRoleAttribute)==kAXTextAreaRole {
                var settable=DarwinBoolean(false)
                let selection=ax(e.element,kAXSelectedTextRangeAttribute)
                if AXUIElementIsAttributeSettable(e.element,kAXSelectedTextAttribute as CFString,&settable) == .success,settable.boolValue,selection != nil {
                    _=try revalidate(s,element:e)
                    try state.dispatch(generation) {
                        guard AXUIElementSetAttributeValue(e.element,kAXSelectedTextAttribute as CFString,text as CFString) == .success else { throw NativeError("delivery_failed","AX selected-text edit was rejected; no keyboard retry performed") }
                    }
                    verification="AX selected-text edit accepted; inspect fresh state to verify the resulting document."
                } else if let value=axString(e.element,kAXValueAttribute,limit:65536),
                          let range=ax(e.element,kAXSelectedTextRangeAttribute),
                          CFGetTypeID(range)==AXValueGetTypeID(),
                          AXUIElementIsAttributeSettable(e.element,kAXValueAttribute as CFString,&settable) == .success, settable.boolValue {
                    var selected=CFRange()
                    let original=value as NSString
                    guard original.length<65536,AXValueGetValue(range as! AXValue,.cfRange,&selected),selected.location>=0,selected.length>=0,
                          selected.location<=original.length,selected.length<=original.length-selected.location else {throw NativeError("selection_unavailable","Cannot locate the selected range; use setValue only for intended whole-field replacement")}
                    let replacement=original.replacingCharacters(in:NSRange(location:selected.location,length:selected.length),with:text)
                    try setAXValue(s,e,replacement,generation:generation)
                    verified=axString(e.element,kAXValueAttribute,limit:65536)==replacement
                    verification="Background AX field value checked after replacing its selected range."
                } else {
                    if mode != "preserve" {try prepareKeyboard(s,t,p,generation:generation);try typeUnicode(text,snapshot:s,target:t,generation:generation);route="app-unicode"}
                    else {try targetedUnicode(text,snapshot:s,target:t,generation:generation);route="targeted-unicode"}
                }
            } else {
                if mode != "preserve" {try prepareKeyboard(s,t,p,generation:generation);try typeUnicode(text,snapshot:s,target:t,generation:generation);route="app-unicode"}
                else {try targetedUnicode(text,snapshot:s,target:t,generation:generation);route="targeted-unicode"}
            }
        case "click":
            let count=try boundedInt(p["count"],1,1,2);let button=p["button"] as? String ?? "left"
            guard ["left","right"].contains(button) else { throw NativeError("invalid_params","Only left and right clicks are supported") }
            if let element=try semanticClickTarget(s,e,point:at),count==1,button=="left",axActions(element).contains(kAXPressAction) {
                if let e { _=try revalidate(s,element:e) } else { _=try revalidate(s) }
                try state.dispatch(generation) { guard AXUIElementPerformAction(element,kAXPressAction as CFString) == .success else { throw NativeError("delivery_failed","AXPress was rejected") } }
                verification="AXPress accepted; action effect is not inferred from the transport response."
            } else {
                let group=Int64.random(in:1...Int64.max)
                for i in 1...count {
                    try targetedPointer(.down,point:at,button:button,count:i,group:group,snapshot:s,target:t,generation:generation)
                    Thread.sleep(forTimeInterval:0.028)
                    try targetedPointer(.up,point:at,button:button,count:i,group:group,snapshot:s,target:t,generation:generation)
                    if i<count { Thread.sleep(forTimeInterval:0.06) }
                }
                route="targeted-pointer"
            }
        case "axAction":
            guard let e else { throw NativeError("invalid_params","axAction requires elementRef") }
            let action=try str(p,"axAction",max:128)
            let allowed=Set([kAXPressAction,kAXIncrementAction,kAXDecrementAction,kAXConfirmAction,kAXCancelAction,kAXShowMenuAction,kAXPickAction,kAXRaiseAction,"AXScrollUpByPage","AXScrollDownByPage","AXScrollLeftByPage","AXScrollRightByPage"])
            guard allowed.contains(action),axActions(e.element).contains(action),action != kAXRaiseAction else { throw NativeError("unsupported","AX action is not advertised or not permitted in this mode") }
            _=try revalidate(s,element:e)
            try state.dispatch(generation) { guard AXUIElementPerformAction(e.element,action as CFString) == .success else { throw NativeError("delivery_failed","AX action rejected") } }
        case "press":
            let chord=try KeyChord.parse(str(p,"key",max:128))
            if mode != "preserve" {try prepareKeyboard(s,t,p,generation:generation);try key(chord,snapshot:s,target:t,generation:generation);route="app-key"}
            else {try targetedKey(chord,snapshot:s,target:t,generation:generation);route="targeted-key"}
        case "scroll":
            let direction=try str(p,"direction",max:8)
            guard ["up","down","left","right"].contains(direction) else { throw NativeError("invalid_params","Invalid scroll direction") }
            let amount=try boundedInt(p["amount"],300,1,3000)
            let semantic=["up":"AXScrollUpByPage","down":"AXScrollDownByPage","left":"AXScrollLeftByPage","right":"AXScrollRightByPage"][direction]!
            if let e,axActions(e.element).contains(semantic) {
                let pageSize=(direction=="up" || direction=="down") ? (e.frame?.height ?? s.frame.height) : (e.frame?.width ?? s.frame.width)
                let pages=max(1,min(20,Int(ceil(Double(amount)/max(1,pageSize)))))
                route="accessibility-page-approximation";verification="This AX control exposes page scrolling only; requested pixels were rounded up to \(pages) page action(s), not verified pixel displacement."
                for _ in 0..<pages {
                    _=try revalidate(s,element:e)
                    try state.dispatch(generation) { guard AXUIElementPerformAction(e.element,semantic as CFString) == .success else { throw NativeError("delivery_failed","Semantic scroll rejected") } }
                }
            } else {
                let vertical=(direction=="up" ? 1 : direction=="down" ? -1 : 0)*amount
                let horizontal=(direction=="left" ? 1 : direction=="right" ? -1 : 0)*amount
                guard let event=CGEvent(scrollWheelEvent2Source:nil,units:.pixel,wheelCount:2,wheel1:Int32(vertical),wheel2:Int32(horizontal),wheel3:0) else { throw NativeError("delivery_failed","Cannot construct scroll event") }
                event.location=at;event.setIntegerValueField(.eventSourceUserData,value:WhaleEvents.tag)
                try privateInput.stamp(event,pid:s.pid,window:s.windowID,local:CGPoint(x:at.x-s.frame.minX,y:at.y-s.frame.minY),group:Int64.random(in:1...Int64.max))
                try targetedDispatch(event,s,t,generation:generation);route="targeted-scroll"
            }
        case "drag":
            guard let x=p["toX"] as? Double,let y=p["toY"] as? Double,x.isFinite,y.isFinite,x>=0,y>=0,x<s.frame.width,y<s.frame.height else { throw NativeError("invalid_params","Drag destination must be inside the exact window") }
            let destination=CGPoint(x:s.frame.minX+x,y:s.frame.minY+y)
            let group=Int64.random(in:1...Int64.max)
            try targetedPointer(.down,point:at,button:"left",count:1,group:group,snapshot:s,target:t,generation:generation)
            for step in 1...20 {
                let f=Double(step)/20;let point=CGPoint(x:at.x+(destination.x-at.x)*f,y:at.y+(destination.y-at.y)*f)
                try targetedPointer(.drag,point:point,button:"left",count:1,group:group,snapshot:s,target:t,generation:generation)
                presentCursor(point:point,phase:"moving",actionID:cursorActionID,snapshot:s,generation:generation)
                Thread.sleep(forTimeInterval:0.012)
            }
            try targetedPointer(.up,point:destination,button:"left",count:1,group:group,snapshot:s,target:t,generation:generation);route="targeted-drag"
        default: throw NativeError("unsupported","Unsupported native action")
        }
        try state.check(generation)
        // Bounds settling time and checks cancellation; no arbitrary sleeps or replay.
        let settle=Date().addingTimeInterval(0.12)
        while Date()<settle { try state.check(generation);Thread.sleep(forTimeInterval:0.02) }
        let post=try observe(["bundleId":s.bundle,"windowId":Int(s.windowID),"deniedOrigins":s.deniedOrigins],generation:generation)
        return ["dispatch":["route":route,"dispatched":state.dispatchCount != dispatchStart,"verified":verified,"verification":verification],"snapshot":post]
        } catch {
            if state.dispatchCount != dispatchStart {
                let changed=state.pause();state.releaseOwnInputs();if changed {pausedNotification?()}
                throw NativeError("action_uncertain","Input may already have taken effect; do not automatically retry. Resume explicitly and obtain a fresh observation.",details:["dispatched":true,"verified":false,"requiresObservation":true,"doNotRetry":true,"cause":(error as? NativeError)?.code ?? "native_failure"])
            }
            throw error
        }
    }
    func textParam(_ p:[String:Any],preferred:String,allowEmpty:Bool) throws -> String {
        guard let text=p[preferred] as? String,(allowEmpty || !text.isEmpty),text.utf8.count<=16384,!text.unicodeScalars.contains(where:{$0.value==0}) else { throw NativeError("invalid_params","Text must be a bounded Unicode string without NUL") }
        return text
    }
    func setAXValue(_ s:SnapshotRecord,_ e:ElementRecord,_ text:String,generation:UInt64) throws {
        guard [kAXTextFieldRole,kAXTextAreaRole,kAXComboBoxRole].contains(e.role) else { throw NativeError("unsupported","setValue is limited to editable text controls") }
        var settable=DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(e.element,kAXValueAttribute as CFString,&settable) == .success,settable.boolValue else { throw NativeError("unsupported","AXValue is not settable") }
        _=try revalidate(s,element:e)
        try state.dispatch(generation) { guard AXUIElementSetAttributeValue(e.element,kAXValueAttribute as CFString,text as CFString) == .success else { throw NativeError("delivery_failed","AX value assignment rejected") } }
    }
    func selectText(_ s:SnapshotRecord,_ e:ElementRecord,_ p:[String:Any],generation:UInt64) throws {
        let selection=p["selection"] as? [String:Any] ?? p
        guard let needle=selection["text"] as? String,!needle.isEmpty,needle.utf8.count<=8192,
              let value=axString(e.element,kAXValueAttribute,limit:65536) else { throw NativeError("invalid_params","A bounded selection object and readable text value are required") }
        let ns=value as NSString;let prefix=selection["prefix"] as? String ?? "";let suffix=selection["suffix"] as? String ?? ""
        let combined=prefix+needle+suffix
        let first=ns.range(of:combined)
        guard first.location != NSNotFound,ns.range(of:combined,options:[],range:NSRange(location:first.location+first.length,length:ns.length-first.location-first.length)).location==NSNotFound else { throw NativeError("ambiguous_selection","Text selection must match uniquely") }
        var range=CFRange(location:first.location+(prefix as NSString).length,length:(needle as NSString).length)
        guard let axRange=AXValueCreate(.cfRange,&range) else { throw NativeError("unsupported","Unable to construct text range") }
        var settable=DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(e.element,kAXSelectedTextRangeAttribute as CFString,&settable) == .success,settable.boolValue else { throw NativeError("unsupported","Selection range is not settable") }
        _=try revalidate(s,element:e)
        try state.dispatch(generation) { guard AXUIElementSetAttributeValue(e.element,kAXSelectedTextRangeAttribute as CFString,axRange) == .success else { throw NativeError("delivery_failed","Selection was rejected") } }
        var read=CFRange();guard let result=ax(e.element,kAXSelectedTextRangeAttribute),CFGetTypeID(result)==AXValueGetTypeID(),AXValueGetValue(result as! AXValue,.cfRange,&read),read.location==range.location,read.length==range.length else { throw NativeError("verification_failed","Selection read-back did not match") }
    }
    func actionPoint(_ p:[String:Any],snapshot s:SnapshotRecord,element:ElementRecord?) throws -> CGPoint {
        if p["x"] != nil || p["y"] != nil {
            guard let x=p["x"] as? Double,let y=p["y"] as? Double,x.isFinite,y.isFinite,x>=0,y>=0,x<s.frame.width,y<s.frame.height else { throw NativeError("invalid_params","Coordinates must be finite window-local points inside target") }
            return CGPoint(x:s.frame.minX+x,y:s.frame.minY+y)
        }
        if let frame=element?.frame { return CGPoint(x:frame.midX,y:frame.midY) }
        return CGPoint(x:s.frame.midX,y:s.frame.midY)
    }
    func semanticClickTarget(_ s:SnapshotRecord,_ e:ElementRecord?,point:CGPoint) throws -> AXUIElement? {
        if let e { return e.element }
        let root=AXUIElementCreateApplication(s.pid);var hit:AXUIElement?
        guard AXUIElementCopyElementAtPosition(root,Float(point.x),Float(point.y),&hit) == .success,let hit,!isSecure(hit),let cached=s.elements.values.first(where:{CFEqual($0.element,hit)}) else { return nil }
        _=try revalidate(s,element:cached)
        return hit
    }
    func foreground(_ t:WindowTarget,_ p:[String:Any],generation:UInt64) throws {
        guard p["foregroundApproved"] as? Bool == true else { throw NativeError("approval_required","Foreground input requires a separate trusted approval") }
        try state.beginRawInput(generation)
        guard CGPreflightListenEventAccess() else { throw NativeError("permission_denied","Foreground mode requires Input Monitoring so human input can cancel safely") }
        let monitorReady=DispatchQueue.main.sync { () -> Bool in
            if eventMonitor == nil { eventMonitor=WhaleEvents(state:state,onPause:{ [weak self] in self?.pausedNotification?() }) }
            return eventMonitor?.start() ?? false
        }
        guard monitorReady else { throw NativeError("permission_denied","Human-input cancellation monitor is unavailable") }
        for key in UInt16(0)...UInt16(127) {
            guard !CGEventSource.keyState(.combinedSessionState,key:key) else { throw NativeError("human_input_active","A physical key is held; refusing foreground takeover") }
        }
        for button in UInt32(0)...UInt32(2) {
            if let b=CGMouseButton(rawValue:button),CGEventSource.buttonState(.combinedSessionState,button:b) { throw NativeError("human_input_active","A mouse button is held; refusing foreground takeover") }
        }
        try state.check(generation)
        // Never auto-activate: foreground compatibility is safe only when the user has
        // explicitly made the exact target app/window active; avoids a focus race.
        guard t.app.isActive else { throw NativeError("foreground_required","Bring the target application to the foreground before retrying") }
        try checkForegroundIdentity(t)
    }
    func checkForegroundIdentity(_ target:WindowTarget) throws {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier==target.app.processIdentifier else { throw NativeError("focus_changed","Target is no longer foreground") }
        let root=AXUIElementCreateApplication(target.app.processIdentifier)
        guard let focused=ax(root,kAXFocusedWindowAttribute),CFEqual(focused,target.element) else { throw NativeError("focus_changed","The exact target window is not focused") }
        if let element=ax(root,kAXFocusedUIElementAttribute),CFGetTypeID(element)==AXUIElementGetTypeID(),isSecure(element as! AXUIElement) {throw NativeError("secure_content","Focused secure control cannot receive input")}
    }
    func checkKeyboardTarget(_ target:WindowTarget) throws {
        let root=AXUIElementCreateApplication(target.app.processIdentifier)
        guard let focused=ax(root,kAXFocusedUIElementAttribute),CFGetTypeID(focused)==AXUIElementGetTypeID() else {throw NativeError("focus_changed","No exact keyboard target is exposed")}
        let element=focused as! AXUIElement
        guard !isSecure(element),let owner=ax(element,kAXWindowAttribute),CFEqual(owner,target.element) else {throw NativeError("secure_content","Keyboard focus is secure or belongs to another window")}
        if let expected=rawFocus,!CFEqual(element,expected) {throw NativeError("focus_changed","Keyboard focus no longer matches the requested elementRef")}
    }
    private func prepareKeyboard(_ s:SnapshotRecord,_ t:WindowTarget,_ p:[String:Any],generation:UInt64) throws {
        guard p["foregroundApproved"] as? Bool == true, s.complete else {throw NativeError("incomplete_observation","A fresh, complete and admitted action is required")}
        try assertCaptureSafety(s)
        if t.app.isActive {try foreground(t,p,generation:generation)}
        else if rawFocus == nil {throw NativeError("element_required","Use an observed input ref for a background keyboard action")}
        try checkKeyRecipient(s,t,generation:generation)
    }
    private func checkKeyRecipient(_ s:SnapshotRecord,_ t:WindowTarget,generation:UInt64) throws {
        try state.check(generation);_=try revalidate(s)
        let root=AXUIElementCreateApplication(s.pid)
        guard let window=ax(root,kAXFocusedWindowAttribute),CFEqual(window,t.element) else {throw NativeError("focus_changed","The application no longer owns this focus target")}
        try checkKeyboardTarget(t)
    }
    private func releaseKey(_ event:CGEvent,_ s:SnapshotRecord) {
        guard let app=NSRunningApplication(processIdentifier:s.pid),!app.isTerminated,app.bundleIdentifier==s.bundle,processStartIdentity(for:app)==s.processStart else {return}
        event.postToPid(s.pid)
    }

    func checkForeground(_ s:SnapshotRecord,_ t:WindowTarget,generation:UInt64) throws {
        try state.check(generation);_=try revalidate(s);try checkForegroundIdentity(t)
    }
    enum PointerPhase { case down,up,drag }
    func key(_ chord:KeyChord,snapshot:SnapshotRecord,target:WindowTarget,generation:UInt64) throws {
        try checkKeyRecipient(snapshot,target,generation:generation)
        guard let down=CGEvent(keyboardEventSource:nil,virtualKey:chord.code,keyDown:true),let up=CGEvent(keyboardEventSource:nil,virtualKey:chord.code,keyDown:false) else { throw NativeError("delivery_failed","Cannot construct key event") }
        down.flags=chord.flags;up.flags=chord.flags
        for event in [down,up] {event.setIntegerValueField(.eventSourceUserData,value:WhaleEvents.tag)}
        let token="foreground-key-\(chord.code)"
        try state.dispatchTracking(generation,token:token,release:{[weak self] in self?.releaseKey(up,snapshot)}) {down.postToPid(snapshot.pid)}
        try checkKeyRecipient(snapshot,target,generation:generation)
        try state.dispatchRelease(generation,token:token) { up.postToPid(snapshot.pid) }
    }
    func typeUnicode(_ text:String,snapshot:SnapshotRecord,target:WindowTarget,generation:UInt64) throws {
        for character in text {
            try checkKeyRecipient(snapshot,target,generation:generation)
            let units=Array(String(character).utf16)
            guard units.count<=128,let down=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true),let up=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false) else { throw NativeError("unsupported","Unicode grapheme exceeds input limit") }
            units.withUnsafeBufferPointer { buffer in down.keyboardSetUnicodeString(stringLength:units.count,unicodeString:buffer.baseAddress!);up.keyboardSetUnicodeString(stringLength:units.count,unicodeString:buffer.baseAddress!) }
            down.flags=[];up.flags=[]
            for event in [down,up] { event.setIntegerValueField(.eventSourceUserData,value:WhaleEvents.tag) }
            try state.dispatchTracking(generation,token:"foreground-unicode",release:{[weak self] in self?.releaseKey(up,snapshot)}) {down.postToPid(snapshot.pid)}
            try checkKeyRecipient(snapshot,target,generation:generation)
            try state.dispatchRelease(generation,token:"foreground-unicode") { up.postToPid(snapshot.pid) }
            Thread.sleep(forTimeInterval:0.005)
        }
    }
    // Set by protocol startup; invoked only for pause metadata, never content.
    static var unused=0
}
// Notification callback is stored outside the engine extension's instance layout.
private var enginePauseCallback: (() -> Void)?
extension NativeEngine { var pausedNotification:(() -> Void)? {get {enginePauseCallback} set {enginePauseCallback=newValue}} }

final class WhaleEvents {
    static let tag:Int64=0x5748414C45
    let state:SafetyState
    let onPause:()->Void
    private let cancellation=DispatchQueue(label:"local.whale-computer.interruption",qos:.userInteractive)
    private var tap:CFMachPort?
    private var source:CFRunLoopSource?
    init(state:SafetyState,onPause:@escaping ()->Void) {self.state=state;self.onPause=onPause}
    func start() -> Bool {
        if let tap {CGEvent.tapEnable(tap:tap,enable:true);return CGEvent.tapIsEnabled(tap:tap)}
        guard CGPreflightListenEventAccess() else {return false}
        let types:[CGEventType]=[.keyDown,.keyUp,.flagsChanged,.leftMouseDown,.leftMouseUp,.rightMouseDown,.rightMouseUp,.mouseMoved,.leftMouseDragged,.rightMouseDragged,.scrollWheel]
        let mask=types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let context=Unmanaged.passUnretained(self).toOpaque()
        tap=CGEvent.tapCreate(tap:.cgSessionEventTap,place:.headInsertEventTap,options:.listenOnly,eventsOfInterest:mask,callback:{ _,type,event,raw in
            guard let raw else {return Unmanaged.passUnretained(event)}
            let monitor=Unmanaged<WhaleEvents>.fromOpaque(raw).takeUnretainedValue()
            let disabled=type == .tapDisabledByTimeout || type == .tapDisabledByUserInput
            let escape=type == .keyDown && event.getIntegerValueField(.keyboardEventKeycode)==53
            if disabled || event.getIntegerValueField(.eventSourceUserData) != WhaleEvents.tag {
                if let ticket=monitor.state.interruptionTicket(isEscape:escape,force:disabled) {
                    // Never block the system event-tap thread on AX dispatch or
                    // cleanup. A later explicit resume invalidates an old ticket.
                    monitor.cancellation.async { [weak monitor] in
                        guard let monitor,monitor.state.interruptIfCurrent(ticket) else {return}
                        monitor.state.releaseOwnInputs();monitor.onPause()
                    }
                }
            }
            return Unmanaged.passUnretained(event)
        },userInfo:context)
        guard let tap else {return false}
        source=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,tap,0)
        if let source {CFRunLoopAddSource(CFRunLoopGetMain(),source,.commonModes)}
        CGEvent.tapEnable(tap:tap,enable:true)
        return true
    }
    deinit {if let tap {CGEvent.tapEnable(tap:tap,enable:false)};if let source {CFRunLoopRemoveSource(CFRunLoopGetMain(),source,.commonModes)}}
}
