// SPDX-License-Identifier: MIT
// Portions of the private event-routing recipe adapted from trycua/cua.
// Copyright (c) 2026 Cua AI, Inc. See THIRD_PARTY_NOTICES.md.
// Swift control flow, capability checks, policy, and cancellation are original.
import Foundation
import AppKit
import ApplicationServices
import Darwin

// Private API: optional, user-enabled, capability-probed, never an automatic HID fallback.
// No CGEvent object-layout offsets, no authentication-envelope memory probing,
// and no defocus/activation records are used. Applications requiring those are refused.
final class SkyLightBridge {
    typealias Post = @convention(c) (pid_t,UnsafeMutableRawPointer)->Void
    typealias Location = @convention(c) (UnsafeMutableRawPointer,Double,Double)->Void
    typealias Field = @convention(c) (UnsafeMutableRawPointer,UInt32,Int64)->Void
    private let handle:UnsafeMutableRawPointer?
    private let post:Post?
    private let location:Location?
    private let field:Field?
    var enabled=false
    init() {
        handle=dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",RTLD_LAZY|RTLD_LOCAL)
        if let handle {
            post=dlsym(handle,"SLEventPostToPid").map {unsafeBitCast($0,to:Post.self)}
            location=dlsym(handle,"CGEventSetWindowLocation").map {unsafeBitCast($0,to:Location.self)}
            field=dlsym(handle,"SLEventSetIntegerValueField").map {unsafeBitCast($0,to:Field.self)}
        } else {post=nil;location=nil;field=nil}
    }
    var available:Bool {post != nil && location != nil && field != nil && ProcessInfo.processInfo.operatingSystemVersion.majorVersion>=27}
    func info()->[String:Any] {
        ["enabled":enabled,"available":available,"implementation":"SkyLight exact PID/window, macOS27+ window-local stamps","authenticationEnvelope":false,"focusMutation":false,"empiricallyValidated":false]
    }
    func require(_ bundle:String,keyboard:Bool) throws {
        guard enabled else {throw NativeError("background_unavailable","Optional private targeted input is disabled; enable it explicitly in user settings")}
        guard available else {throw NativeError("background_unavailable","Required private event symbols or macOS27 coordinate contract are unavailable")}
        if keyboard && ["chrome","chromium","brave","edge","electron","catalyst"].contains(where:{bundle.lowercased().contains($0)}) {
            throw NativeError("background_unavailable","This app may require an unaudited private authentication envelope; use browser DOM or semantic AX input")
        }
    }
    static func stamps(pid:pid_t,window:CGWindowID,group:Int64,phase:Int64,button:Int64,count:Int64)->[(UInt32,Int64)] {
        [(0,phase),(1,count),(3,button),(7,3),(40,Int64(pid)),(51,Int64(window)),(58,group),(91,Int64(window)),(92,Int64(window))]
    }
    func stamp(_ event:CGEvent,pid:pid_t,window:CGWindowID,local:CGPoint,group:Int64,phase:Int64=3,button:Int64=0,count:Int64=1) throws {
        guard let location,let field,available else {throw NativeError("background_unavailable","Private window stamps are unavailable")}
        let pointer=Unmanaged.passUnretained(event).toOpaque()
        location(pointer,local.x,local.y)
        for (key,value) in Self.stamps(pid:pid,window:window,group:group,phase:phase,button:button,count:count) {field(pointer,key,value)}
        event.setIntegerValueField(.eventSourceUserData,value:WhaleEvents.tag)
    }
    func send(_ event:CGEvent,pid:pid_t) throws {
        guard let post,available else {throw NativeError("background_unavailable","Private PID transport is unavailable")}
        post(pid,Unmanaged.passUnretained(event).toOpaque())
    }
}
extension NativeEngine {
    func backgroundPreflight(_ s:SnapshotRecord,_ t:WindowTarget,keyboard:Bool,generation:UInt64) throws {
        try privateInput.require(s.bundle,keyboard:keyboard)
        try state.beginRawInput(generation)
        guard CGPreflightListenEventAccess() else {throw NativeError("permission_denied","Targeted raw input requires Input Monitoring for human-input cancellation")}
        let monitoring=DispatchQueue.main.sync {()->Bool in
            if eventMonitor == nil {eventMonitor=WhaleEvents(state:state,onPause:{[weak self] in self?.pausedNotification?()})}
            return eventMonitor?.start() ?? false
        }
        guard monitoring else {throw NativeError("permission_denied","Human-input cancellation monitor is unavailable")}
        try state.check(generation);_=try revalidate(s)
        let root=AXUIElementCreateApplication(s.pid)
        // An existing exact app-local key window is mandatory. Do not synthesize
        // no-raise focus records or mutate another app's foreground focus.
        guard let window=ax(root,kAXFocusedWindowAttribute),CFEqual(window,t.element) else {throw NativeError("background_unavailable","Exact target is not the application's existing focused window")}
        if keyboard {
            guard let focused=ax(root,kAXFocusedUIElementAttribute),CFGetTypeID(focused)==AXUIElementGetTypeID() else {throw NativeError("background_unavailable","No exact focused input element is exposed")}
            let element=focused as! AXUIElement
            if let expected=rawFocus,!CFEqual(element,expected) {throw NativeError("focus_changed","Focused input does not match the requested elementRef")}
            guard !isSecure(element),let owner=ax(element,kAXWindowAttribute),CFEqual(owner,t.element) else {throw NativeError("secure_content","Focused element is secure or belongs to another window")}
        }
        // Refuse if any visible field became secure after the original observation.
        try assertCaptureSafety(s)
    }
    func targetedDispatch(_ event:CGEvent,_ s:SnapshotRecord,_ t:WindowTarget,generation:UInt64,keyboard:Bool=false,tracking:(String,()->Void)?=nil,releaseToken:String?=nil) throws {
        try backgroundPreflight(s,t,keyboard:keyboard,generation:generation)
        let previous=NSWorkspace.shared.frontmostApplication?.processIdentifier
        let cursor=CGEvent(source:nil)?.location
        if let (token,release)=tracking {
            var deliveryError:Error?
            try state.dispatchTracking(generation,token:token,release:release) {do {try privateInput.send(event,pid:s.pid)} catch {deliveryError=error}}
            if let error=deliveryError {state.removeRelease(token);throw error}
        } else if let token=releaseToken {try state.dispatchRelease(generation,token:token) {try privateInput.send(event,pid:s.pid)}}
        else {try state.dispatch(generation) {try privateInput.send(event,pid:s.pid)}}
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier==previous else {
            state.pause();state.releaseOwnInputs();pausedNotification?()
            throw NativeError("foreground_changed","Target app changed foreground as a side effect; control paused")
        }
        if let cursor,let after=CGEvent(source:nil)?.location,(abs(cursor.x-after.x)>0.5 || abs(cursor.y-after.y)>0.5) {
            state.pause();state.releaseOwnInputs();pausedNotification?()
            throw NativeError("cursor_changed","Cursor changed during targeted dispatch; control paused without restoring user cursor")
        }
    }
    func targetedPointer(_ phase:PointerPhase,point:CGPoint,button:String,count:Int,group:Int64,snapshot s:SnapshotRecord,target t:WindowTarget,generation:UInt64) throws {
        let b:CGMouseButton=button=="right" ? .right : .left
        let type:CGEventType=phase == .drag ? (b == .right ? .rightMouseDragged : .leftMouseDragged) : phase == .down ? (b == .right ? .rightMouseDown : .leftMouseDown) : (b == .right ? .rightMouseUp : .leftMouseUp)
        guard let event=CGEvent(mouseEventSource:nil,mouseType:type,mouseCursorPosition:point,mouseButton:b),let release=CGEvent(mouseEventSource:nil,mouseType:b == .right ? .rightMouseUp : .leftMouseUp,mouseCursorPosition:point,mouseButton:b) else {throw NativeError("delivery_failed","Cannot create targeted pointer event")}
        let local=CGPoint(x:point.x-s.frame.minX,y:point.y-s.frame.minY)
        event.flags=[];release.flags=[]
        try privateInput.stamp(event,pid:s.pid,window:s.windowID,local:local,group:group,button:Int64(b.rawValue),count:Int64(count))
        try privateInput.stamp(release,pid:s.pid,window:s.windowID,local:local,group:group,button:Int64(b.rawValue),count:Int64(count))
        let token="targeted-pointer-\(b.rawValue)"
        let cleanup:()->Void = { [weak self] in
            guard let self,let app=NSRunningApplication(processIdentifier:s.pid),app.bundleIdentifier==s.bundle,processStartIdentity(for:app)==s.processStart else {return}
            try? self.privateInput.send(release,pid:s.pid)
        }
        try targetedDispatch(event,s,t,generation:generation,tracking:phase != .up ? (token,cleanup) : nil,releaseToken:phase == .up ? token : nil)
    }
    func targetedKey(_ chord:KeyChord,snapshot s:SnapshotRecord,target t:WindowTarget,generation:UInt64) throws {
        guard let down=CGEvent(keyboardEventSource:nil,virtualKey:chord.code,keyDown:true),let up=CGEvent(keyboardEventSource:nil,virtualKey:chord.code,keyDown:false) else {throw NativeError("delivery_failed","Cannot create targeted key event")}
        down.flags=chord.flags;up.flags=chord.flags
        let group=Int64.random(in:1...Int64.max)
        for event in [down,up] {try privateInput.stamp(event,pid:s.pid,window:s.windowID,local:CGPoint(x:s.frame.width/2,y:s.frame.height/2),group:group)}
        let token="targeted-key-\(chord.code)"
        let cleanup:()->Void = {[weak self] in
            guard let self,let app=NSRunningApplication(processIdentifier:s.pid),app.bundleIdentifier==s.bundle,processStartIdentity(for:app)==s.processStart else {return};try? self.privateInput.send(up,pid:s.pid)
        }
        try targetedDispatch(down,s,t,generation:generation,keyboard:true,tracking:(token,cleanup))
        try targetedDispatch(up,s,t,generation:generation,keyboard:true,releaseToken:token)
    }
    func targetedUnicode(_ text:String,snapshot s:SnapshotRecord,target t:WindowTarget,generation:UInt64) throws {
        for character in text {
            let units=Array(String(character).utf16)
            guard units.count<=128,let down=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:true),let up=CGEvent(keyboardEventSource:nil,virtualKey:0,keyDown:false) else {throw NativeError("unsupported","Cannot encode Unicode grapheme")}
            units.withUnsafeBufferPointer { buffer in down.keyboardSetUnicodeString(stringLength:units.count,unicodeString:buffer.baseAddress!);up.keyboardSetUnicodeString(stringLength:units.count,unicodeString:buffer.baseAddress!) }
            let group=Int64.random(in:1...Int64.max)
            for event in [down,up] {event.flags=[];try privateInput.stamp(event,pid:s.pid,window:s.windowID,local:CGPoint(x:s.frame.width/2,y:s.frame.height/2),group:group)}
            let cleanup:()->Void = {[weak self] in
                guard let self,let app=NSRunningApplication(processIdentifier:s.pid),app.bundleIdentifier==s.bundle,processStartIdentity(for:app)==s.processStart else {return};try? self.privateInput.send(up,pid:s.pid)
            }
            try targetedDispatch(down,s,t,generation:generation,keyboard:true,tracking:("targeted-unicode",cleanup))
            try targetedDispatch(up,s,t,generation:generation,keyboard:true,releaseToken:"targeted-unicode")
            Thread.sleep(forTimeInterval:0.005)
        }
    }
}
