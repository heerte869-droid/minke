import Foundation
import AppKit
import ApplicationServices
import Darwin

let outputLock=NSLock()
func emit(_ value:[String:Any]) {
    guard JSONSerialization.isValidJSONObject(value),let data=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]) else {return}
    outputLock.lock();defer {outputLock.unlock()}
    if data.count>2*1024*1024 {
        let id=value["id"] as? String ?? ""
        let fallback:[String:Any]=["id":id,"error":["code":"response_limit","message":"Response exceeds 2MB; reduce observation/capture bounds"]]
        if let small=try? JSONSerialization.data(withJSONObject:fallback) {try? FileHandle.standardOutput.write(contentsOf:small+Data([10]))}
        return
    }
    try? FileHandle.standardOutput.write(contentsOf:data+Data([10]))
}
func failure(_ id:String,_ error:Error) {
    if let e=error as? NativeError {var payload:[String:Any]=["code":e.code,"message":e.message];if let details=e.details {payload["details"]=details};emit(["id":id,"error":payload])}
    else {emit(["id":id,"error":["code":"native_failure","message":"Native operation failed without content diagnostics"]])}
}
if CommandLine.arguments.contains("--self-test") {
    do {emit(["result":try coreSelfTest()]);exit(0)} catch {failure("self-test",error);exit(1)}
}
signal(SIGPIPE,SIG_IGN)
let application=NSApplication.shared
// A timeout on the system-wide AX object applies to every AX operation in this process.
// Keep cursor visibility probes from changing it while an input is in flight.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)
application.setActivationPolicy(.accessory)
let engine=NativeEngine()
let work=DispatchQueue(label:"local.whale-computer.native.serial",qos:.userInitiated)
engine.overlay=WhaleOverlay()
engine.pausedNotification={emit(["event":"paused","data":["paused":true,"generation":engine.state.generation,"reason":"human_input_or_native_safety_stop"]]);DispatchQueue.main.async{engine.overlay?.paused()}}
// Environment changes invalidate old work immediately. Only a new request can
// start a new generation, after the system confirms the current console session.
final class SessionAvailability: @unchecked Sendable {
    private let lock=NSLock()
    private var holds=Set<String>()
    func change(_ name:String,blocked:Bool) -> Bool {
        lock.lock(); defer {lock.unlock()}
        if blocked {holds.insert(name)} else {holds.remove(name)}
        return holds.isEmpty
    }
    func available() -> Bool {
        lock.lock(); defer {lock.unlock()}
        guard holds.isEmpty, let session=CGSessionCopyCurrentDictionary() as? [String:Any],
              (session[kCGSessionUserIDKey as String] as? NSNumber)?.uint32Value == getuid(),
              session[kCGSessionOnConsoleKey as String] as? Bool == true,
              session[kCGSessionLoginDoneKey as String] as? Bool == true,
              session["CGSSessionScreenIsLocked"] as? Bool != true else {return false}
        let main=CGMainDisplayID()
        return CGDisplayIsActive(main) != 0 && CGDisplayIsAsleep(main)==0
    }
}
let sessionAvailability=SessionAvailability()
let workspace=NSWorkspace.shared.notificationCenter
var observers:[NSObjectProtocol]=[]
func watchSession(_ center:NotificationCenter,_ off:Notification.Name,_ on:Notification.Name,_ name:String) {
    observers.append(center.addObserver(forName:off,object:nil,queue:nil){ _ in
        _=sessionAvailability.change(name,blocked:true)
        engine.state.pause();engine.state.releaseOwnInputs()
        emit(["event":"paused","data":["paused":true,"reason":"session_or_sleep"]])
        DispatchQueue.main.async{engine.overlay?.hide()}
    })
    observers.append(center.addObserver(forName:on,object:nil,queue:nil){ _ in
        if sessionAvailability.change(name,blocked:false) && sessionAvailability.available() {
            emit(["event":"sessionAvailable","data":[:]])
        }
    })
}
watchSession(workspace,NSWorkspace.willSleepNotification,NSWorkspace.didWakeNotification,"system")
watchSession(workspace,NSWorkspace.screensDidSleepNotification,NSWorkspace.screensDidWakeNotification,"screens")
watchSession(workspace,NSWorkspace.sessionDidResignActiveNotification,NSWorkspace.sessionDidBecomeActiveNotification,"console")
watchSession(DistributedNotificationCenter.default(),Notification.Name("com.apple.screenIsLocked"),Notification.Name("com.apple.screenIsUnlocked"),"lock")
let seenLock=NSLock();var seenIDs=Set<String>()
func process(_ request:[String:Any]) {
    guard let id=request["id"] as? String,!id.isEmpty,id.utf8.count<=128,
          let method=request["method"] as? String,method.utf8.count<=64,
          let params=request["params"] as? [String:Any] else {failure(request["id"] as? String ?? "",NativeError("invalid_request","Expected bounded id, method, and params object"));return}
    seenLock.lock();let fresh=seenIDs.insert(id).inserted
    if seenIDs.count>4096 {seenIDs=[id]};seenLock.unlock()
    guard fresh else {failure(id,NativeError("duplicate_id","Duplicate request id rejected"));return}
    if method=="pause" {
        let changed=engine.state.pause(userStop:params["manualStop"] as? Bool == true);engine.state.releaseOwnInputs();DispatchQueue.main.async {engine.overlay?.paused()}
        _=changed // Command pause replies only; spontaneous pauses alone emit notifications.
        emit(["id":id,"result":["paused":true,"generation":engine.state.generation]]);return
    }
    if method=="shutdown" {
        engine.state.pause();engine.state.releaseOwnInputs();emit(["id":id,"result":["shutdown":true]])
        DispatchQueue.main.async {engine.overlay?.hide();NSApplication.shared.terminate(nil)};return
    }
    let admittedGeneration=engine.state.generation
    work.async {
        let dispatchAtStart=engine.state.dispatchCount
        do {
            var result:[String:Any]
            if ["apps.list","apps.find","windows.list","observe","app.open","action"].contains(method) {
                try engine.state.check(admittedGeneration)
                if let bundle=params["bundleId"] as? String {try safeBundle(bundle)}
            }
            switch method {
            case "status":result=engine.status()
            case "apps.list":result=engine.apps()
            case "session.start":
                try engine.state.checkGeneration(admittedGeneration)
                guard sessionAvailability.available() else {throw NativeError("session_inactive","Console session is locked, inactive or asleep")}
                engine.privateInput.enabled=params["privateSkyLight"] as? Bool == true
                let escapeStopAvailable=engine.startInterruptMonitor()
                try engine.state.resume(expected:admittedGeneration,automatic:true)
                result=["paused":false,"escapeStopAvailable":escapeStopAvailable,"privateInput":engine.privateInput.info()]
            case "resume":
                guard params["userInitiated"] as? Bool == true else {throw NativeError("user_required","Resume is available only from the trusted user settings flow")}
                try engine.state.checkGeneration(admittedGeneration)
                guard sessionAvailability.available() else {throw NativeError("session_inactive","Console session is locked, inactive or asleep")}
                let escapeStopAvailable=engine.startInterruptMonitor()
                try engine.state.resume(expected:admittedGeneration);result=["paused":false,"generation":engine.state.generation,"escapeStopAvailable":escapeStopAvailable]
            case "permissions.request":
                guard params["userInitiated"] as? Bool == true else {throw NativeError("user_required","Permission prompts require an explicit user settings command")}
                let kind=try str(params,"kind",max:32)
                guard ["accessibility","screenCapture","inputMonitoring"].contains(kind) else {throw NativeError("invalid_params","Unsupported permission kind")}
                let granted:Bool=DispatchQueue.main.sync {
                    if kind=="accessibility" {let options=[kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary;return AXIsProcessTrustedWithOptions(options)}
                    if kind=="inputMonitoring" {return CGRequestListenEventAccess()}
                    return CGRequestScreenCaptureAccess()
                }
                result=["kind":kind,"granted":granted,"permissions":engine.permissions()]
            case "apps.find":
                try engine.state.check(admittedGeneration)
                result=try engine.findApps(str(params,"query",max:255))
            case "app.open":
                try engine.state.check(admittedGeneration)
                result=try engine.openApplication(str(params,"bundleId",max:255),generation:admittedGeneration)
            case "windows.list":
                try engine.state.check(admittedGeneration)
                result=try engine.windows(str(params,"bundleId",max:255),denied:engine.deniedOrigins(params))
            case "observe":result=try engine.observe(params,generation:admittedGeneration)
            case "revalidate":
                _=try engine.validatedSnapshot(params,generation:admittedGeneration)
                result=["valid":true,"generation":admittedGeneration]
            case "action":
                defer {engine.state.releaseOwnInputs()}
                result=try engine.perform(params,generation:admittedGeneration)
            case "input.configure":
                guard params["userInitiated"] as? Bool == true,let enabled=params["privateSkyLight"] as? Bool else {throw NativeError("user_required","Private input configuration requires a trusted user command")}
                guard admittedGeneration==engine.state.generation else {throw NativeError("cancelled","Newer stop invalidated input configuration")}
                engine.privateInput.enabled=enabled;result=engine.privateInput.info()
            case "browser.taskPlacement":
                try engine.state.check(admittedGeneration)
                result=DispatchQueue.main.sync {backgroundPlaybackLayout()}
                try engine.state.check(admittedGeneration)
            case "overlay.artwork":
                let key=try str(params,"variant",max:12)
                try DispatchQueue.main.sync { try engine.overlay?.changeArtwork(key) }
                result=["variant":key]
            case "overlay.configure":
                try engine.state.checkGeneration(admittedGeneration)
                result=try DispatchQueue.main.sync {
                    try engine.state.checkGeneration(admittedGeneration)
                    let configured=try engine.overlay?.configure(params) ?? [:]
                    try engine.state.checkGeneration(admittedGeneration)
                    return configured
                }
            case "overlay.browserActivity":
                try engine.state.check(admittedGeneration)
                try DispatchQueue.main.sync {
                    try engine.overlay?.browserActivity(check: { try engine.state.check(admittedGeneration) })
                }
                result = ["accepted": true]
            case "overlay.preview":
                guard params["userInitiated"] as? Bool == true else {throw NativeError("user_required","Overlay preview is user only")}
                try engine.state.checkGeneration(admittedGeneration)
                try DispatchQueue.main.sync {
                    try engine.state.checkGeneration(admittedGeneration)
                    try engine.overlay?.preview(check:{try engine.state.checkGeneration(admittedGeneration)})
                    try engine.state.checkGeneration(admittedGeneration)
                }
                result=["preview":true]
            default:throw NativeError("method_not_found","Unknown native method")
            }
            emit(["id":id,"result":result])
        } catch {
            if method=="action",engine.state.dispatchCount==dispatchAtStart,let failureInfo=error as? NativeError {
                failure(id,NativeError(failureInfo.code,failureInfo.message,details:["notDispatched":true]))
            } else {failure(id,error)}
        }
    }
}
DispatchQueue.global(qos:.userInitiated).async {
    var buffer=Data();var discarding=false
    do {
        var bytes=[UInt8](repeating:0,count:65536)
        while true {
            let count=bytes.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO,$0.baseAddress!,65536) }
            if count==0 {break}
            if count<0 {if errno==EINTR {continue};throw NativeError("input_failure","Native input read failed")}
            for byte in bytes.prefix(count) {
                if byte==10 {
                    if discarding {discarding=false;buffer.removeAll(keepingCapacity:true);continue}
                    let line=buffer;buffer.removeAll(keepingCapacity:true)
                    guard !line.isEmpty else {continue}
                    do {
                        guard let object=try JSONSerialization.jsonObject(with:line) as? [String:Any] else {throw NativeError("invalid_request","Request must be an object")}
                        process(object)
                    } catch {failure("",error is NativeError ? error : NativeError("parse_error","Invalid JSON request"))}
                } else if !discarding {
                    buffer.append(byte)
                    if buffer.count>2*1024*1024 {discarding=true;buffer.removeAll(keepingCapacity:true);failure("",NativeError("line_limit","JSON line exceeds 2MB"))}
                }
            }
        }
    } catch {failure("",NativeError("input_failure","Native input stream closed unexpectedly"))}
    engine.state.pause();engine.state.releaseOwnInputs()
    DispatchQueue.main.async {engine.overlay?.hide();NSApplication.shared.terminate(nil)}
}
emit(["event":"ready","data":engine.status()])
application.run()
