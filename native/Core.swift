import Foundation
import Darwin
import AppKit
import ApplicationServices
import ScreenCaptureKit
import Vision
import ImageIO
import UniformTypeIdentifiers

struct NativeError: Error {
    let code: String
    let message: String
    let details: [String:Any]?
    init(_ code: String, _ message: String, details:[String:Any]? = nil) { self.code = code; self.message = message; self.details=details }
}
func millis() -> Double { Date().timeIntervalSince1970 * 1000 }
func rectJSON(_ r: CGRect) -> [String: Double] { ["x":r.origin.x,"y":r.origin.y,"width":r.width,"height":r.height] }
func sameRect(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX-b.minX)<0.5 && abs(a.minY-b.minY)<0.5 && abs(a.width-b.width)<0.5 && abs(a.height-b.height)<0.5
}
// Chrome can expose the same normal window with a one-point top-edge offset
// in AX and WindowServer. This is only for discovery; action revalidation
// still compares two AX frames with the original strict geometry rule.
func chromeTopEdgeMatch(_ ax:CGRect,_ cg:CGRect)->Bool {
    abs(ax.minX-cg.minX)<0.5 && abs(ax.width-cg.width)<0.5 &&
    abs(ax.height-cg.height)<0.5 && abs(ax.minY-cg.minY)<=1.0
}
func sameChromeWindowTitle(_ lhs:String,_ rhs:String)->Bool {
    func stripBrand(_ title:String)->String {
        for suffix in [" - Google Chrome"," – Google Chrome"] where title.hasSuffix(suffix) {
            return String(title.dropLast(suffix.count))
        }
        return title
    }
    let a=stripBrand(lhs),b=stripBrand(rhs)
    return !a.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && a==b
}
func boundedInt(_ value: Any?, _ defaultValue: Int, _ minValue: Int, _ maxValue: Int) throws -> Int {
    guard let value = value else { return defaultValue }
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
          n.doubleValue.rounded() == n.doubleValue, n.doubleValue >= Double(minValue), n.doubleValue <= Double(maxValue) else {
        throw NativeError("invalid_params", "Integer is outside the permitted range")
    }
    return n.intValue
}
func str(_ p: [String: Any], _ key: String, max: Int = 8192) throws -> String {
    guard let s = p[key] as? String, !s.isEmpty, s.utf8.count <= max else { throw NativeError("invalid_params", "Missing or invalid \(key)") }
    return s
}
func safeBundle(_ id: String) throws {
    let v = id.lowercased()
    let denied = ["terminal","iterm","warp","ghostty","alacritty","kitty","password","keychain","securityagent","systempreferences","systemsettings","loginwindow","authorizationhost","whale-computer","whalecomputer","deepseek","chatgpt","codex"]
    guard id.count <= 255, id.contains("."), !denied.contains(where: { v.contains($0) }) else {
        throw NativeError("forbidden_target", "Credential, security, terminal, and control-plane apps cannot be observed or controlled")
    }
}
final class SafetyState: @unchecked Sendable {
    private let lock = NSLock()
    private var _paused = true
    private var userStopped=false
    private var _generation: UInt64 = 0
    private var _dispatchCount: UInt64 = 0
    var dispatchCount:UInt64 {lock.lock();defer {lock.unlock()};return _dispatchCount}
    private let inputScopeLock=NSLock()
    private var inputScopeGeneration:UInt64=0
    private var rawInputGeneration:UInt64?
    // Called with the safety lock held; the event tap reads only this short lock.
    private func resetInputScope() {
        inputScopeLock.lock();inputScopeGeneration=_generation;rawInputGeneration=nil;inputScopeLock.unlock()
    }
    func beginRawInput(_ expected:UInt64) throws {
        lock.lock();defer{lock.unlock()}
        guard !_paused,expected==_generation else {throw NativeError("cancelled","Raw input was invalidated")}
        inputScopeLock.lock();rawInputGeneration=expected;inputScopeLock.unlock()
    }
    func endRawInput(_ expected:UInt64) {
        inputScopeLock.lock();defer{inputScopeLock.unlock()}
        if rawInputGeneration==expected {rawInputGeneration=nil}
    }
    func interruptionTicket(isEscape:Bool,force:Bool=false)->UInt64? {
        inputScopeLock.lock();defer{inputScopeLock.unlock()}
        return isEscape || force || rawInputGeneration==inputScopeGeneration ? inputScopeGeneration : nil
    }
    func shouldInterruptHumanInput(isEscape:Bool)->Bool {interruptionTicket(isEscape:isEscape) != nil}
    func interruptIfCurrent(_ expected:UInt64)->Bool {
        lock.lock();defer{lock.unlock()}
        guard expected==_generation else {return false}
        userStopped=true;_paused=true;_generation &+= 1;resetInputScope();return true
    }
    private var releases: [String: () -> Void] = [:]
    func removeRelease(_ token:String) {lock.lock();releases.removeValue(forKey:token);lock.unlock()}
    func dispatchTracking(_ generation:UInt64,token:String,release:@escaping ()->Void,_ body:()->Void) throws {
        lock.lock();defer {lock.unlock()}
        guard !_paused,generation==_generation else {throw NativeError("cancelled","Input was cancelled before dispatch")}
        releases[token]=release;_dispatchCount &+= 1;body()
    }
    func dispatchRelease(_ generation:UInt64,token:String,_ body:() throws -> Void) throws {
        lock.lock();defer {lock.unlock()}
        guard !_paused,generation==_generation else {throw NativeError("cancelled","Release cancelled before delivery")}
        guard releases[token] != nil else {throw NativeError("cancelled","No owned held input exists for this release")}
        _dispatchCount &+= 1
        try body();releases.removeValue(forKey:token)
    }
    var paused: Bool { lock.lock(); defer { lock.unlock() }; return _paused }
    var generation: UInt64 { lock.lock(); defer { lock.unlock() }; return _generation }
    func check(_ generation: UInt64) throws {
        lock.lock(); defer { lock.unlock() }
        if _paused { throw NativeError("paused", "Computer control is paused") }
        if generation != _generation { throw NativeError("cancelled", "Operation was invalidated") }
    }
    // Explicit overlay setup/preview may run while paused. Only the admission
    // generation must match; never hold this mutex across main.sync or AppKit.
    func checkGeneration(_ expected: UInt64) throws {
        lock.lock(); defer { lock.unlock() }
        guard expected == _generation else { throw NativeError("cancelled", "A newer control state invalidated this queued operation") }
    }
    @discardableResult func pause(userStop:Bool=false) -> Bool { lock.lock(); if userStop {userStopped=true};let changed = !_paused; _paused = true; _generation &+= 1; resetInputScope(); lock.unlock(); return changed }
    func resume(expected: UInt64? = nil, automatic:Bool=false) throws {
        lock.lock(); defer { lock.unlock() }
        if let expected, expected != _generation { throw NativeError("cancelled", "A newer stop invalidated the queued resume") }
        if automatic && userStopped {throw NativeError("user_required","Explicit stop requires a settings resume")}
        userStopped=false;_paused = false; _generation &+= 1;resetInputScope()
    }
    // Hold the cancellation mutex for each atomic native dispatch, never for waits/AX traversal.
    func dispatch(_ generation: UInt64, _ body: () throws -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        guard !_paused, generation == _generation else { throw NativeError("cancelled", "Dispatch cancelled before delivery") }
        _dispatchCount &+= 1
        try body()
    }
    func releaseOwnInputs() {
        lock.lock();let callbacks=Array(releases.values);releases=[:];lock.unlock()
        for callback in callbacks {callback()}
    }
}
struct KeyChord {
    let code: CGKeyCode
    let flags: CGEventFlags
    static func parse(_ value: String) throws -> KeyChord {
        let parts=value.lowercased().split(separator:"+").map(String.init)
        guard !parts.isEmpty, parts.count<=5 else { throw NativeError("invalid_params","Invalid key chord") }
        var flags=CGEventFlags(); var seen=Set<String>()
        for part in parts.dropLast() {
            guard seen.insert(part).inserted else { throw NativeError("invalid_params","Duplicate modifier") }
            switch part { case "cmd","command","meta":flags.insert(.maskCommand); case "ctrl","control":flags.insert(.maskControl); case "alt","option":flags.insert(.maskAlternate); case "shift":flags.insert(.maskShift); default:throw NativeError("invalid_params","Unsupported key modifier") }
        }
        let named:[String:CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46,"enter":36,"return":36,"tab":48,"space":49,"backspace":51,"delete":51,"escape":53,"esc":53,"home":115,"pageup":116,"end":119,"pagedown":121,"left":123,"right":124,"down":125,"up":126,"forwarddelete":117]
        guard let code=named[parts.last!] else { throw NativeError("unsupported","Key is not in the bounded supported key set") }
        return KeyChord(code:code,flags:flags)
    }
}
struct AXIdentitySet {
    private var buckets:[CFHashCode:[AXUIElement]]=[:]
    private let hash:(AXUIElement)->CFHashCode
    init(hash:@escaping (AXUIElement)->CFHashCode={CFHash($0)}) {self.hash=hash}
    mutating func insert(_ element:AXUIElement)->Bool {
        let key=hash(element)
        if buckets[key]?.contains(where:{CFEqual($0,element)}) == true {return false}
        buckets[key,default:[]].append(element);return true
    }
}
func axIdentitySelfTest() throws -> Int {
    var passed=0
    func expect(_ value:Bool,_ label:String) throws {guard value else {throw NativeError("self_test_failed","AX identity: \(label)")};passed+=1}
    let a=AXUIElementCreateApplication(getpid()),b=AXUIElementCreateApplication(getpid()+1)
    var set=AXIdentitySet(hash:{_ in 0})
    try expect(set.insert(a),"first node retained")
    try expect(!set.insert(a),"same object visited once")
    try expect(set.insert(b),"distinct app survives a forced hash collision")
    try expect(!set.insert(b),"second object visited once")
    try expect(!set.insert(AXUIElementCreateApplication(getpid())),"equivalent AX handle is deduplicated")
    return passed
}
func ax(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element,key as CFString,&value) == .success else { return nil }
    return value
}
func axString(_ e: AXUIElement, _ key: String, limit: Int=4096) -> String? {
    guard let value=ax(e,key) as? String else { return nil }; return String(value.prefix(limit))
}
func axFrame(_ e: AXUIElement) -> CGRect? {
    guard let p=ax(e,kAXPositionAttribute), CFGetTypeID(p)==AXValueGetTypeID(), let s=ax(e,kAXSizeAttribute), CFGetTypeID(s)==AXValueGetTypeID() else { return nil }
    var point=CGPoint.zero; var size=CGSize.zero
    guard AXValueGetValue(p as! AXValue,.cgPoint,&point), AXValueGetValue(s as! AXValue,.cgSize,&size), size.width>0,size.height>0 else { return nil }
    return CGRect(origin:point,size:size)
}
func axActions(_ e: AXUIElement) -> [String] { var actions: CFArray?; guard AXUIElementCopyActionNames(e,&actions) == .success else { return [] }; return (actions as? [String] ?? []).prefix(32).map { String($0.prefix(128)) } }
func isSecure(_ e: AXUIElement) -> Bool {
    let role=axString(e,kAXRoleAttribute) ?? ""; let sub=axString(e,kAXSubroleAttribute) ?? ""
    return role.lowercased().contains("secure") || sub.lowercased().contains("secure") || (ax(e,"AXProtectedContent") as? Bool == true)
}
func fingerprintValue(_ value:CFTypeRef?) -> String {
    guard let value else {return "<unavailable>"}
    if let string=value as? String {return "string:"+string}
    if let number=value as? NSNumber {return "number:\(CFGetTypeID(value)):\(number.stringValue)"}
    if CFGetTypeID(value)==AXValueGetTypeID() {
        let boxed=value as! AXValue
        if AXValueGetType(boxed) == .cfRange {var range=CFRange();if AXValueGetValue(boxed,.cfRange,&range) {return "range:\(range.location):\(range.length)"}}
    }
    return "<CF-type:\(CFGetTypeID(value))>"
}
func axFingerprint(_ element:AXUIElement) -> Int {
    guard !isSecure(element) else {return 0}
    var hash=Hasher()
    for attribute in [kAXRoleAttribute,"AXIdentifier",kAXTitleAttribute,kAXDescriptionAttribute,kAXValueAttribute,kAXSelectedTextRangeAttribute,kAXEnabledAttribute] {
        hash.combine(attribute);hash.combine(fingerprintValue(ax(element,attribute)))
    }
    hash.combine(axActions(element).sorted())
    return hash.finalize()
}
struct ElementRecord {
    let element: AXUIElement
    let frame: CGRect?
    let role: String
    let secure: Bool
    let path: [Int]
    let fingerprint: Int
}
struct ProcessStartIdentity:Equatable {
    let seconds:UInt64
    let microseconds:UInt64
}
// launchDate is absent for apps not started by LaunchServices. Use the public
// kernel process-start fields so direct-launched apps still have a real identity.
func processStartIdentity(for app:NSRunningApplication)->ProcessStartIdentity? {
    guard app.processIdentifier>0 else {return nil}
    var info=proc_bsdinfo()
    let size=Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(app.processIdentifier,PROC_PIDTBSDINFO,0,&info,size)==size,
          info.pbi_pid==UInt32(app.processIdentifier),info.pbi_start_tvsec>0,info.pbi_start_tvusec<1_000_000 else {return nil}
    return ProcessStartIdentity(seconds:info.pbi_start_tvsec,microseconds:info.pbi_start_tvusec)
}
// Resolve an explicitly selected window by its WindowServer owner. The
// Launch Services list can transiently omit a running application.
func applicationOwningWindow(_ id:CGWindowID,bundle:String)->NSRunningApplication? {
    let list=CGWindowListCopyWindowInfo([.optionAll,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]]
    guard let row=list?.first(where:{($0[kCGWindowNumber as String] as? UInt32)==id}),
          let pid=row[kCGWindowOwnerPID as String] as? Int32,pid>0,
          let app=NSRunningApplication(processIdentifier:pid),!app.isTerminated else {return nil}
    if let reported=app.bundleIdentifier {return reported==bundle ? app : nil}
    // Launch Services may not have the bundle metadata when a window is
    // already on screen. Check the kernel's executable path against the
    // bundle's own declared main executable before using its identifier.
    var bytes=[CChar](repeating:0,count:4*Int(MAXPATHLEN))
    guard proc_pidpath(pid,&bytes,UInt32(bytes.count))>0 else {return nil}
    let executable=URL(fileURLWithPath:String(cString:bytes)).resolvingSymlinksInPath()
    let directory=executable.deletingLastPathComponent()
    guard directory.lastPathComponent=="MacOS",directory.deletingLastPathComponent().lastPathComponent=="Contents",
          let running=Bundle(url:directory.deletingLastPathComponent().deletingLastPathComponent()),
          running.bundleIdentifier==bundle,running.executableURL?.resolvingSymlinksInPath()==executable else {return nil}
    return app
}
struct SnapshotRecord {
    let id: String
    let bundle: String
    let pid: pid_t
    let processStart: ProcessStartIdentity
    let windowID: CGWindowID
    let window: AXUIElement
    let frame: CGRect
    let generation: UInt64
    let at: Double
    let elements: [String: ElementRecord]
    let secure: Bool
    let complete: Bool
    let tree: [[String: Any]]
    var deniedOrigins: [String]
}
final class SnapshotStore {
    private var snapshots:[String:SnapshotRecord]=[:]
    func put(_ snapshot: SnapshotRecord) {
        snapshots=snapshots.filter { millis()-$0.value.at<15000 && $0.value.bundle != snapshot.bundle }
        if snapshots.count>=32, let oldest=snapshots.min(by:{$0.value.at<$1.value.at})?.key { snapshots.removeValue(forKey:oldest) }
        snapshots[snapshot.id]=snapshot
    }
    func get(_ id:String, bundle:String, generation:UInt64, now:Double=millis()) throws -> SnapshotRecord {
        guard let s=snapshots[id],s.bundle==bundle else { throw NativeError("stale_snapshot","Snapshot is not current for this target") }
        guard now>=s.at,now-s.at<=15000,s.generation==generation else { throw NativeError("stale_snapshot","Snapshot expired or was cancelled") }
        return s
    }
    func consume(_ id:String) { snapshots.removeValue(forKey:id) }
}
struct WindowTarget {
    let app: NSRunningApplication
    let id: CGWindowID
    let element: AXUIElement
    let frame: CGRect
    let title: String
}
// A read-only placement recommendation for a newly created Chrome task window.
// No AX action is sent, and neither window IDs nor other applications' metadata
// leave this function. Prefer an exposed strip so Chromium can load video
// without bringing the user's original window or the task window forward.
func backgroundPlaybackLayout() -> [String:Any] {
    guard let screen=NSScreen.screens.first(where:{s in
        let id=(s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
        return CGDisplayIsBuiltin(id) != 0 && CGDisplayIsActive(id) != 0 && CGDisplayIsAsleep(id)==0
    }),let number=screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else{return [:]}
    let physical=CGDisplayBounds(number.uint32Value),visible=screen.visibleFrame
    let usable=CGRect(x:physical.minX+visible.minX-screen.frame.minX,
                      y:physical.minY+screen.frame.maxY-visible.maxY,width:visible.width,height:visible.height).insetBy(dx:6,dy:6)
    guard usable.width>=600,usable.height>=420 else{return [:]}
    guard let rows=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],0) as? [[String:Any]] else{return [:]}
    let covers=rows.compactMap{row->CGRect? in
        guard row[kCGWindowLayer as String] as? Int==0,(row[kCGWindowAlpha as String] as? Double ?? 0)>0,
              let b=row[kCGWindowBounds as String] as? NSDictionary,let r=CGRect(dictionaryRepresentation:b as CFDictionary),
              r.intersects(usable) else{return nil}
        return r
    }
    let size=CGSize(width:min(960,usable.width),height:min(680,usable.height))
    let candidates=[CGPoint(x:usable.minX,y:usable.minY),CGPoint(x:usable.maxX-size.width,y:usable.minY),
                    CGPoint(x:usable.minX,y:usable.maxY-size.height),CGPoint(x:usable.maxX-size.width,y:usable.maxY-size.height)]
    func score(_ p:CGPoint)->Int{
        var available=0
        for x in stride(from:p.x+8,to:p.x+size.width-8,by:24){
            for y in stride(from:p.y+92,to:p.y+size.height-8,by:24){
                let point=CGPoint(x:x,y:y)
                if !covers.contains(where:{$0.contains(point)}){available+=1}
            }
        }
        return available
    }
    var best=candidates[0],highest=score(best)
    for p in candidates.dropFirst(){let n=score(p);if n>highest{best=p;highest=n}}
    return ["left":Int(ceil(best.x)),"top":Int(ceil(best.y)),"width":Int(size.width),"height":Int(size.height),"exposedEstimate":highest>0]
}

final class NativeEngine: @unchecked Sendable {
    let state=SafetyState()
    let cache=SnapshotStore()
    let privateInput=SkyLightBridge()
    var overlay: WhaleOverlay?
    var badge: WhaleActivityBadge?
    var eventMonitor: WhaleEvents?
    var rawFocus: AXUIElement?
    private var lastTrees: [String:[[String:Any]]]=[:]
    func startInterruptMonitor()->Bool {
        guard CGPreflightListenEventAccess() else {return false}
        return DispatchQueue.main.sync {
            if self.eventMonitor == nil {self.eventMonitor=WhaleEvents(state:self.state,onPause:{[weak self] in self?.pausedNotification?()})}
            return self.eventMonitor?.start() ?? false
        }
    }
    func permissions() -> [String:Bool] {
        ["accessibility":AXIsProcessTrusted(),"screenCapture":CGPreflightScreenCaptureAccess(),"inputMonitoring":CGPreflightListenEventAccess()]
    }
    func status() -> [String:Any] {
        let display: [String:Any] = Thread.isMainThread ? (overlay?.diagnostics ?? [:]) : DispatchQueue.main.sync {overlay?.diagnostics ?? [:]}
        let activity:[String:Any] = Thread.isMainThread ? (badge?.diagnostics ?? [:]) : DispatchQueue.main.sync {badge?.diagnostics ?? [:]}
        return ["activity":activity,"protocol":1,"version":"0.4.1","permissions":permissions(),"paused":state.paused,"generation":state.generation,
         "privateInput":privateInput.info(),"overlayDiagnostics":display,
         "cursor":CursorCapability.descriptor,
         "capabilities":["accessibility":true,"windowCapture":true,"ocr":true,"unicode":true,"overlay":true,"foregroundInput":true,"strictBackground":"AX-first; optional PID/window SkyLight","privateSkyLight":privateInput.available,"recordReplay":false,"remoteControl":false],
         "warnings":["Capabilities describe implemented routes, not granted permission or verified application support.","Private input is optional, requires user enablement, and has not been validated in every application; never falls back to global HID."]]
    }
    func runningApp(_ bundle:String) throws -> NSRunningApplication {
        try safeBundle(bundle)
        guard let app=NSRunningApplication.runningApplications(withBundleIdentifier:bundle).first,!app.isTerminated else { throw NativeError("app_not_running","Requested application is not running") }
        return app
    }
    func requireAX() throws { guard AXIsProcessTrusted() else { throw NativeError("permission_denied","Accessibility permission is not granted; use the user settings flow") } }
    func apps() -> [String:Any] {
        let rows=NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap { app -> [String:Any]? in
            guard let bundle=app.bundleIdentifier else { return nil }
            var row:[String:Any] = ["bundleId":bundle,"name":app.localizedName ?? bundle,"pid":Int(app.processIdentifier),"running":true,"frontmost":app.isActive]
            if let path=app.bundleURL?.path { row["path"]=path }; return row
        }
        return ["apps":rows]
    }
    func findApps(_ query:String) throws -> [String:Any] {
        guard !query.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,query.utf8.count<=255 else {throw NativeError("invalid_params","Use an application name or bundle ID")}
        let running=NSWorkspace.shared.runningApplications
        var urls:[URL]=running.compactMap{$0.bundleURL}
        if let exact=NSWorkspace.shared.urlForApplication(withBundleIdentifier:query){urls.append(exact)}
        let roots=["/Applications","/Applications/Utilities","/System/Applications","/System/Applications/Utilities",FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path]
        for root in roots {
            guard let entries=try? FileManager.default.contentsOfDirectory(at:URL(fileURLWithPath:root),includingPropertiesForKeys:nil,options:[.skipsHiddenFiles]) else {continue}
            urls.append(contentsOf:entries.filter{$0.pathExtension=="app"}.prefix(500))
        }
        var seen=Set<String>(),rows:[[String:Any]]=[]
        for url in urls.prefix(1500) {
            guard let bundle=Bundle(url:url),let id=bundle.bundleIdentifier,(try? safeBundle(id)) != nil,!seen.contains(id) else {continue}
            let name=(bundle.localizedInfoDictionary?["CFBundleDisplayName"] as? String) ?? (bundle.localizedInfoDictionary?["CFBundleName"] as? String) ?? (bundle.infoDictionary?["CFBundleName"] as? String) ?? url.deletingPathExtension().lastPathComponent
            guard id==query || name.localizedCaseInsensitiveContains(query) || url.deletingPathExtension().lastPathComponent.localizedCaseInsensitiveContains(query) else {continue}
            seen.insert(id)
            let instances=running.filter{$0.bundleIdentifier==id && !$0.isTerminated}
            var row:[String:Any]=["bundleId":id,"name":name,"path":url.path,"running":!instances.isEmpty,"instanceCount":instances.count]
            if let app=instances.first {row["pid"]=Int(app.processIdentifier);row["frontmost"]=app.isActive}
            rows.append(row);if rows.count>=50{break}
        }
        return ["apps":rows]
    }
    func openApplication(_ bundle:String,generation:UInt64) throws -> [String:Any] {
        try safeBundle(bundle);try state.check(generation)
        if let app=NSRunningApplication.runningApplications(withBundleIdentifier:bundle).first,!app.isTerminated {
            return ["bundleId":bundle,"pid":Int(app.processIdentifier),"opened":false,"running":true,"activationRequested":false]
        }
        guard let url=NSWorkspace.shared.urlForApplication(withBundleIdentifier:bundle) else {throw NativeError("app_not_found","Choose an installed application identity from app discovery")}
        let completed=DispatchSemaphore(value:0),lock=NSLock()
        var resultApp:NSRunningApplication?,resultError:Error?
        try DispatchQueue.main.sync {
            try self.state.check(generation)
            let config=NSWorkspace.OpenConfiguration();config.activates=false;config.addsToRecentItems=false
            NSWorkspace.shared.openApplication(at:url,configuration:config){app,error in
                lock.lock();resultApp=app;resultError=error;lock.unlock();completed.signal()
            }
        }
        let deadline=Date().addingTimeInterval(8)
        while completed.wait(timeout:.now()+0.05) == .timedOut {
            if Date()>=deadline || state.paused || state.generation != generation {
                throw NativeError("launch_unverified","Application launch may have occurred; inspect state before retrying",details:["mayHaveDispatched":true])
            }
        }
        lock.lock();let app=resultApp,error=resultError;lock.unlock()
        guard error==nil,let app,app.bundleIdentifier==bundle,!app.isTerminated else {throw NativeError("launch_unverified","Application launch could not be verified",details:["mayHaveDispatched":true])}
        do {try state.check(generation)} catch {throw NativeError("cancelled","Launch completed after cancellation; do not replay",details:["mayHaveDispatched":true])}
        return ["bundleId":bundle,"pid":Int(app.processIdentifier),"opened":true,"running":true,"activationRequested":false]
    }
    func windows(_ bundle:String,denied:[String]=[]) throws -> [String:Any] {
        let app=try runningApp(bundle); try requireAX()
        let root=AXUIElementCreateApplication(app.processIdentifier); AXUIElementSetMessagingTimeout(root,0.8)
        var windowValue:CFTypeRef?
        let windowStatus=AXUIElementCopyAttributeValue(root,kAXWindowsAttribute as CFString,&windowValue)
        guard windowStatus == .success || windowStatus == .noValue else {throw NativeError("window_discovery_unavailable","Application windows are not accessible yet (AX code \(windowStatus.rawValue))")}
        let ws=windowValue as? [AXUIElement] ?? []
        let cg=CGWindowListCopyWindowInfo([.optionAll,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
        var result:[[String:Any]]=[],rejected:[String]=[],unmatched:[[String:Any]]=[]
        for w in ws.prefix(128) {
            do {try assertControlPlane(w,bundle:bundle,denied:denied)} catch {rejected.append((error as? NativeError)?.code ?? "window_inspection_failed");continue}
            guard let frame=axFrame(w) else {rejected.append("window_geometry_unavailable");continue}
            guard let id=matchWindow(app,w,frame,cg,ws) else {
                rejected.append("window_identity_unmatched")
                let candidates=cg.filter{($0[kCGWindowOwnerPID as String] as? Int)==Int(app.processIdentifier) && ($0[kCGWindowLayer as String] as? Int ?? 0)==0}.compactMap { info -> [String:Any]? in
                    guard let bounds=info[kCGWindowBounds as String] as? [String:Any],let rect=CGRect(dictionaryRepresentation:bounds as CFDictionary) else {return nil}
                    return ["windowId":info[kCGWindowNumber as String] ?? 0,"frame":rectJSON(rect)]
                }
                unmatched.append(["axFrame":rectJSON(frame),"candidates":candidates]);continue
            }
            result.append(["windowId":Int(id),"pid":Int(app.processIdentifier),"title":axString(w,kAXTitleAttribute,limit:512) ?? "","frame":rectJSON(frame),"minimized":ax(w,kAXMinimizedAttribute) as? Bool ?? false,"hidden":app.isHidden,"frontmost":app.isActive])
        }
        return ["windows":result,"discovery":["axWindowCount":ws.count,"rejected":rejected,"unmatchedGeometry":unmatched,"ready":!result.isEmpty]]
    }
    func matchWindow(_ app:NSRunningApplication,_ element:AXUIElement,_ frame:CGRect,_ infos:[[String:Any]],_ peers:[AXUIElement]) -> CGWindowID? {
        let pid=app.processIdentifier
        let title=axString(element,kAXTitleAttribute) ?? ""
        let matches=infos.filter { info in
            guard (info[kCGWindowOwnerPID as String] as? Int)==Int(pid),(info[kCGWindowLayer as String] as? Int ?? 0)==0,
                  let bounds=info[kCGWindowBounds as String] as? [String:Any], let rect=CGRect(dictionaryRepresentation:bounds as CFDictionary) else { return false }
            return sameRect(frame,rect)
        }
        if matches.count==1 { return (matches[0][kCGWindowNumber as String] as? NSNumber)?.uint32Value }
        let exact=matches.filter { ($0[kCGWindowName as String] as? String)==title }
        if !matches.isEmpty {
            return exact.count==1 ? (exact[0][kCGWindowNumber as String] as? NSNumber)?.uint32Value : nil
        }
        guard app.bundleIdentifier=="com.google.Chrome",
              axString(element,kAXSubroleAttribute)==kAXStandardWindowSubrole else {return nil}
        let candidates=infos.compactMap { info -> (CGWindowID,CGRect,String)? in
            guard (info[kCGWindowOwnerPID as String] as? Int)==Int(pid),
                  (info[kCGWindowLayer as String] as? Int)==0,
                  let dict=info[kCGWindowBounds as String] as? NSDictionary,
                  let rect=CGRect(dictionaryRepresentation:dict as CFDictionary),chromeTopEdgeMatch(frame,rect),
                  let id=info[kCGWindowNumber as String] as? NSNumber else{return nil}
            return (id.uint32Value,rect,info[kCGWindowName as String] as? String ?? "")
        }
        guard candidates.count==1, let candidate=candidates.first,
              sameChromeWindowTitle(title,candidate.2) else{return nil}
        for peer in peers where !CFEqual(peer,element) {
            guard let other=axFrame(peer),!chromeTopEdgeMatch(other,candidate.1) else{return nil}
        }
        return candidate.0
    }
    func target(_ bundle:String,_ requested:CGWindowID?) throws -> WindowTarget {
        try safeBundle(bundle)
        let app:NSRunningApplication
        if let requested {
            var owner=applicationOwningWindow(requested,bundle:bundle)
            if owner==nil {
                // Retry only the ownership lookup. No input has been sent here.
                Thread.sleep(forTimeInterval:0.025)
                owner=applicationOwningWindow(requested,bundle:bundle)
            }
            guard let owner else {throw NativeError("window_unavailable","The selected window has no matching application owner")}
            app=owner
        } else {
            app=try runningApp(bundle)
        }
        try requireAX()
        let root=AXUIElementCreateApplication(app.processIdentifier); AXUIElementSetMessagingTimeout(root,0.8)
        let ws=ax(root,kAXWindowsAttribute) as? [AXUIElement] ?? []
        let cg=CGWindowListCopyWindowInfo([.optionAll,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
        var candidates:[WindowTarget]=[]
        for w in ws {
            guard let frame=axFrame(w),let id=matchWindow(app,w,frame,cg,ws),requested==nil || requested==id else { continue }
            guard ax(w,kAXMinimizedAttribute) as? Bool != true,!app.isHidden else { if requested==id { throw NativeError("window_unavailable","Minimized or hidden windows are not actionable") }; continue }
            candidates.append(WindowTarget(app:app,id:id,element:w,frame:frame,title:axString(w,kAXTitleAttribute,limit:512) ?? ""))
        }
        if candidates.count==1 { return candidates[0] }
        if requested==nil, let focus=ax(root,kAXFocusedWindowAttribute),let found=candidates.first(where:{CFEqual($0.element,focus)}) { return found }
        throw NativeError("window_unavailable","No unique matching AX/WindowServer window; specify a current windowId")
    }
    func revalidate(_ s:SnapshotRecord, element:ElementRecord?=nil) throws -> WindowTarget {
        try state.check(s.generation)
        guard millis()-s.at<=15000 else { throw NativeError("stale_snapshot","Snapshot expired") }
        let t=try target(s.bundle,s.windowID)
        guard t.app.processIdentifier==s.pid,processStartIdentity(for:t.app)==s.processStart,CFEqual(t.element,s.window),sameRect(t.frame,s.frame) else { throw NativeError("stale_snapshot","Target process, window identity, or geometry changed") }
        try assertControlPlane(t.element,bundle:s.bundle,denied:s.deniedOrigins)
        if let e=element {
            guard !e.secure,!isSecure(e.element) else { throw NativeError("secure_content","Secure controls are never actionable") }
            var current:AXUIElement=t.element
            for index in e.path {
                guard let children=ax(current,kAXChildrenAttribute) as? [AXUIElement],index<children.count else { throw NativeError("stale_element","Element path changed") }
                current=children[index]
            }
            guard CFEqual(current,e.element),(axString(current,kAXRoleAttribute) ?? "")==e.role,axFingerprint(current)==e.fingerprint else { throw NativeError("stale_element","Exact element identity or semantic fingerprint changed") }
            if let old=e.frame { guard let now=axFrame(current),sameRect(now,old) else { throw NativeError("stale_element","Element geometry changed") } }
            guard ax(current,kAXEnabledAttribute) as? Bool != false else { throw NativeError("disabled_element","Element is disabled") }
        }
        return t
    }
    func observe(_ p:[String:Any],generation:UInt64) throws -> [String:Any] {
        try state.check(generation)
        let bundle=try str(p,"bundleId",max:255)
        let window:CGWindowID? = p["windowId"] == nil ? nil : CGWindowID(try boundedInt(p["windowId"],0,1,Int(UInt32.max)))
        let t=try target(bundle,window)
        guard let processIdentity=processStartIdentity(for:t.app) else {throw NativeError("process_identity_unavailable","Cannot establish the target process start identity")}
        let denied=try deniedOrigins(p)
        try assertControlPlane(t.element,bundle:bundle,denied:denied)
        let maxNodes=try boundedInt(p["maxNodes"],250,1,2000); let maxDepth=try boundedInt(p["maxDepth"],16,1,64)
        let snapshotID=UUID().uuidString
        let filterRole=p["role"] as? String
        if let role=filterRole, !["AXTextField","AXTextArea","AXComboBox","AXButton","AXLink"].contains(role){throw NativeError("invalid_params","Unsupported role filter")}
        let traversalLimit=filterRole == nil ? maxNodes : 1500
        var elements:[String:ElementRecord]=[:]; var tree:[[String:Any]]=[]; var secure=false; var truncated=false; var complete=true
        var queue:[(AXUIElement,Int,[Int])]=[(t.element,0,[])]
        var visited=AXIdentitySet(); var cursor=0
        while cursor<queue.count {
            try state.check(generation)
            let (e,depth,path)=queue[cursor]; cursor+=1
            if !visited.insert(e) {continue}
            if cursor>traversalLimit || tree.count>=maxNodes { truncated=true; break }
            let ref=UUID().uuidString; let role=axString(e,kAXRoleAttribute) ?? "AXUnknown"; let secret=isSecure(e); secure = secure || secret
            if filterRole == nil || role == filterRole {
            let frame=axFrame(e)
            elements[ref]=ElementRecord(element:e,frame:frame,role:role,secure:secret,path:path,fingerprint:axFingerprint(e))
            var row:[String:Any] = ["ref":ref,"role":role,"enabled":ax(e,kAXEnabledAttribute) as? Bool ?? true,"actions":secret ? [] : axActions(e),"depth":depth,"secure":secret]
            if role=="AXRadioButton",!secret {
                if let selected=ax(e,kAXSelectedAttribute) as? Bool {row["selected"]=selected}
                else if let value=ax(e,kAXValueAttribute) as? NSNumber {row["selected"]=value.intValue==1}
            }
            if let frame { row["frame"]=rectJSON(CGRect(x:frame.minX-t.frame.minX,y:frame.minY-t.frame.minY,width:frame.width,height:frame.height)) }
            if !secret {
                if let title=axString(e,kAXTitleAttribute,limit:512) { row["title"]=title }
                if let desc=axString(e,kAXDescriptionAttribute,limit:512) { row["description"]=desc }
                if let value=axString(e,kAXValueAttribute) { row["value"]=value }
                if ["AXTextField","AXComboBox","AXTextArea"].contains(role) {
                    if let hint=axString(e,"AXPlaceholderValue",limit:240), !hint.isEmpty {row["placeholder"]=hint}
                    var writable=DarwinBoolean(false)
                    row["valueSettable"]=AXUIElementIsAttributeSettable(e,kAXValueAttribute as CFString,&writable) == .success && writable.boolValue
                }
            }
            tree.append(row)
            }
            if secret { continue }
            var children:CFTypeRef?
            let result=AXUIElementCopyAttributeValue(e,kAXChildrenAttribute as CFString,&children)
            if result != .success && result != .attributeUnsupported && result != .noValue { complete=false }
            if let list=children as? [AXUIElement],!list.isEmpty {
                if depth>=maxDepth { truncated=true; continue }
                for (i,child) in list.prefix(traversalLimit+1).enumerated() { queue.append((child,depth+1,path+[i])) }
                if list.count>traversalLimit+1 { truncated=true }
            }
        }
        guard processStartIdentity(for:t.app)==processIdentity else {throw NativeError("stale_snapshot","Target process changed during observation")}
        let rec=SnapshotRecord(id:snapshotID,bundle:bundle,pid:t.app.processIdentifier,processStart:processIdentity,windowID:t.id,window:t.element,frame:t.frame,generation:generation,at:millis(),elements:elements,secure:secure,complete:complete && !truncated,tree:tree,deniedOrigins:denied)
        _=try revalidate(rec)
        cache.put(rec)
        var warnings:[String]=[]
        if truncated { warnings.append("AX traversal was truncated; narrow the observation before acting.") }
        if secure { warnings.append("Secure fields were redacted; images and OCR for this window are denied.") }
        if !complete { warnings.append("AX observation is incomplete; images and OCR are denied.") }
        var out:[String:Any]=["snapshotId":snapshotID,"observedAt":rec.at,"bundleId":bundle,"pid":Int(rec.pid),"windowId":Int(t.id),"frame":rectJSON(t.frame),"frontmost":t.app.isActive,"tree":tree,"treeComplete":rec.complete,"truncated":truncated,"warnings":warnings,"generation":generation,"source":"accessibility"]
        let started=Date(timeIntervalSince1970:Double(rec.processStart.seconds)+Double(rec.processStart.microseconds)/1_000_000)
        out["processStart"]=ISO8601DateFormatter().string(from:started);out["processIdentitySource"]="kernel"
        if p["diff"] as? Bool == true,let old=lastTrees[bundle] {
            // Keep full current refs; diff is informational and cannot authorize old refs.
            let normalize:([[String:Any]])->[String] = { $0.map { (($0["role"] as? String) ?? "") + "|" + (($0["title"] as? String) ?? "") + "|" + (($0["value"] as? String) ?? "") } }
            out["diff"]=["previousCount":old.count,"currentCount":tree.count,"changed":normalize(old) != normalize(tree)]
        }
        lastTrees[bundle]=tree
        if p["screenshot"] as? Bool == true || p["ocr"] as? Bool == true {
            guard !rec.secure,rec.complete else { cache.consume(rec.id); throw NativeError("secure_capture_denied","Cannot prove a complete secure-field-free window; image/OCR refused") }
            let capture=try captureWindow(rec)
            try state.check(generation); _=try revalidate(rec)
            if p["screenshot"] as? Bool == true { out["image"]=capture.image }
            if p["ocr"] as? Bool == true { out["ocr"]=try recognize(capture.cgImage,frame:rec.frame) }
        }
        return out
    }
    struct Capture { let cgImage:CGImage; let image:[String:Any] }
    func assertCaptureSafety(_ s:SnapshotRecord) throws {
        _=try revalidate(s)
        var queue:[(AXUIElement,Int)]=[(s.window,0)];var cursor=0;var visited=AXIdentitySet()
        while cursor<queue.count {
            try state.check(s.generation)
            guard cursor<4000 else {throw NativeError("secure_capture_denied","Cannot completely inspect window for secure controls")}
            let (element,depth)=queue[cursor];cursor+=1
            guard visited.insert(element) else {continue}
            guard axString(element,kAXRoleAttribute) != nil,!isSecure(element) else {throw NativeError("secure_capture_denied","Secure or inaccessible AX control prevents image/OCR")}
            var value:CFTypeRef?
            let result=AXUIElementCopyAttributeValue(element,kAXChildrenAttribute as CFString,&value)
            guard result == .success || result == .noValue || result == .attributeUnsupported else {throw NativeError("secure_capture_denied","AX inspection failed; image/OCR denied")}
            if let children=value as? [AXUIElement],!children.isEmpty {
                guard depth<64,children.count<=4000,queue.count+children.count<=4000 else {throw NativeError("secure_capture_denied","AX safety scan limit exceeded")}
                for child in children {queue.append((child,depth+1))}
            }
        }
    }
    func captureWindow(_ s:SnapshotRecord) throws -> Capture {
        try assertCaptureSafety(s)
        guard CGPreflightScreenCaptureAccess() else { throw NativeError("permission_denied","Screen Recording permission is not granted") }
        guard !s.secure,s.complete else { throw NativeError("secure_capture_denied","Secure or incomplete window cannot be captured") }
        // The single-window filter below excludes the separate cursor panel.
        let done=DispatchSemaphore(value:0)
        final class Box: @unchecked Sendable { var image:CGImage?; var error:Error? }
        let box=Box()
        Task {
            do {
                let content=try await SCShareableContent.excludingDesktopWindows(true,onScreenWindowsOnly:true)
                guard let window=content.windows.first(where:{$0.windowID==s.windowID && $0.owningApplication?.processID==s.pid}),sameRect(window.frame,s.frame) else { throw NativeError("window_unavailable","No exact on-screen capture window; Stage Manager/minimized representations are refused") }
                let filter=SCContentFilter(desktopIndependentWindow:window)
                let config=SCStreamConfiguration()
                let scale=min(2.0,2048.0/max(s.frame.width,s.frame.height))
                config.width=max(1,Int(s.frame.width*scale)); config.height=max(1,Int(s.frame.height*scale)); config.showsCursor=false;config.ignoreShadowsSingleWindow=true
                box.image=try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:config)
            } catch { box.error=error }
            done.signal()
        }
        guard done.wait(timeout:.now()+8) == .success else { throw NativeError("capture_timeout","Window capture timed out") }
        if let error=box.error as? NativeError { throw error }
        guard let image=box.image else { throw NativeError("capture_failed","ScreenCaptureKit could not capture the exact window") }
        try assertCaptureSafety(s)
        guard image.width<=4096,image.height<=4096 else { throw NativeError("capture_limit","Capture dimensions exceeded the limit") }
        let data=NSMutableData()
        guard let destination=CGImageDestinationCreateWithData(data as CFMutableData,UTType.png.identifier as CFString,1,nil) else { throw NativeError("capture_failed","PNG encoder unavailable") }
        CGImageDestinationAddImage(destination,image,nil)
        guard CGImageDestinationFinalize(destination),data.length<=1024*1024 else { throw NativeError("capture_limit","PNG exceeds 1MB; reduce the target window size") }
        return Capture(cgImage:image,image:["base64":(data as Data).base64EncodedString(),"mediaType":"image/png","width":image.width,"height":image.height,"pointWidth":s.frame.width,"pointHeight":s.frame.height])
    }
    func recognize(_ image:CGImage,frame:CGRect) throws -> [[String:Any]] {
        let request=VNRecognizeTextRequest(); request.recognitionLevel = .accurate; request.usesLanguageCorrection=false
        request.recognitionLanguages=["zh-Hans","en-US"]
        try VNImageRequestHandler(cgImage:image,options:[:]).perform([request])
        return (request.results ?? []).prefix(500).compactMap { item in
            guard let candidate=item.topCandidates(1).first else { return nil }
            let box=item.boundingBox
            return ["text":String(candidate.string.prefix(2048)),"confidence":candidate.confidence,"frame":rectJSON(CGRect(x:box.minX*frame.width,y:(1-box.maxY)*frame.height,width:box.width*frame.width,height:box.height*frame.height))]
        }
    }
}

// Pure state checks. Compiled with the helper; execution requires separate scope.
func overlayAdmissionSelfTest() throws -> Int {
    var passed=0
    func expect(_ condition:Bool,_ label:String) throws {guard condition else {throw NativeError("self_test_failed",label)};passed+=1}
    let state=SafetyState();let admitted=state.generation
    try state.checkGeneration(admitted)
    try expect(state.paused,"overlay generation check allows paused")
    state.pause() // Even a duplicate pause invalidates an already admitted preview.
    do {try state.checkGeneration(admitted);throw NativeError("self_test_failed","old overlay survived stop")}
    catch let e as NativeError {try expect(e.code=="cancelled","stop invalidates queued overlay")}
    let beforeResume=state.generation;try state.resume()
    do {try state.checkGeneration(beforeResume);throw NativeError("self_test_failed","old overlay survived resume")}
    catch let e as NativeError {try expect(e.code=="cancelled","resume invalidates queued overlay")}
    return passed
}
func inputInterruptionSelfTest() throws -> Int {
    var passed=0
    func expect(_ value:Bool,_ label:String) throws {guard value else {throw NativeError("self_test_failed","input interruption: \(label)")};passed+=1}
    let state=SafetyState()
    try expect(!state.shouldInterruptHumanInput(isEscape:false),"ordinary input does not interrupt paused semantic state")
    try expect(state.shouldInterruptHumanInput(isEscape:true),"Escape remains an explicit stop")
    try state.resume();let first=state.generation
    try expect(!state.shouldInterruptHumanInput(isEscape:false),"semantic operations coexist with physical mouse activity")
    try state.beginRawInput(first)
    try expect(state.shouldInterruptHumanInput(isEscape:false),"raw input is protected against physical activity")
    state.endRawInput(first)
    try expect(!state.shouldInterruptHumanInput(isEscape:false),"finished raw input cannot poison later semantic work")
    try state.beginRawInput(first);state.pause()
    try expect(!state.shouldInterruptHumanInput(isEscape:false),"pause invalidates the raw owner")
    try state.resume();let second=state.generation;try state.beginRawInput(second)
    state.endRawInput(first)
    try expect(state.shouldInterruptHumanInput(isEscape:false),"old cleanup cannot clear a newer raw owner")
    state.endRawInput(second)
    try expect(!state.shouldInterruptHumanInput(isEscape:false),"current owner releases interruption scope")
    do {try state.beginRawInput(first);throw NativeError("self_test_failed","stale raw owner accepted")}
    catch let error as NativeError {try expect(error.code=="cancelled","stale raw scope refused")}
    let oldTicket=state.interruptionTicket(isEscape:true)!
    try state.resume()
    try expect(!state.interruptIfCurrent(oldTicket),"late input event cannot cancel a newer explicit resume")
    let currentTicket=state.interruptionTicket(isEscape:true)!
    try expect(state.interruptIfCurrent(currentTicket) && state.paused,"current Escape cancels without holding the event tap")
    return passed
}
// Pure non-GUI self tests: no AX queries, TCC prompts, capture, or synthesized input.
func coreSelfTest() throws -> [String:Any] {
    var passed=0
    func expect(_ condition:Bool,_ label:String) throws { guard condition else { throw NativeError("self_test_failed",label) }; passed+=1 }
    let original=CGRect(x:100,y:50,width:800,height:600)
    try expect(chromeTopEdgeMatch(original,original.offsetBy(dx:0,dy:1)),"Chrome one-point top edge")
    try expect(!chromeTopEdgeMatch(original,original.offsetBy(dx:0,dy:2)),"Chrome unrelated top edge")
    try expect(!chromeTopEdgeMatch(original,original.offsetBy(dx:1,dy:0)),"Chrome horizontal movement")
    try expect(sameChromeWindowTitle("Public video - Google Chrome","Public video"),"Chrome title suffix")
    try expect(!sameChromeWindowTitle("Public video","Different video"),"Chrome mismatched title")
    try expect(!sameChromeWindowTitle(" - Google Chrome",""),"Chrome missing title")
    try expect(sameRect(CGRect(x:1,y:2,width:3,height:4),CGRect(x:1.1,y:2.1,width:3,height:4)),"rectangle tolerance")
    try expect(!sameRect(CGRect(x:1,y:2,width:3,height:4),CGRect(x:2,y:2,width:3,height:4)),"geometry invalidation")
    try expect(try boundedInt(42,1,0,100)==42,"bounded integer")
    do { _=try boundedInt(true,1,0,100); throw NativeError("self_test_failed","boolean accepted") } catch let e as NativeError { try expect(e.code=="invalid_params","boolean integer refusal") }
    do { try safeBundle("com.apple.Terminal"); throw NativeError("self_test_failed","terminal accepted") } catch let e as NativeError { try expect(e.code=="forbidden_target","target denylist") }
    try safeBundle("com.apple.TextEdit"); passed+=1
    try expect(try KeyChord.parse("CMD+SHIFT+A").code==0,"bounded key parser")
    do { _=try KeyChord.parse("cmd+F25"); throw NativeError("self_test_failed","unknown key accepted") } catch let e as NativeError { try expect(e.code=="unsupported","unknown key refusal") }
    let state=SafetyState();try expect(state.paused,"paused by default");try state.resume();let generation=state.generation;try state.check(generation);passed+=1
    state.pause();do { try state.check(generation);throw NativeError("self_test_failed","pause ineffective") } catch let e as NativeError { try expect(e.code=="paused","pause") }
    try state.resume();do { try state.check(generation);throw NativeError("self_test_failed","old generation accepted") } catch let e as NativeError { try expect(e.code=="cancelled","generation invalidation") }
    var calls=0; do { try state.dispatch(generation) {calls+=1} } catch {}; try expect(calls==0,"no stale dispatch")
    let admitted=state.generation;state.pause()
    do {try state.resume(expected:admitted);throw NativeError("self_test_failed","queued resume survived pause")} catch let e as NativeError {try expect(e.code=="cancelled","queued resume invalidated")}
    try expect(!state.pause(),"duplicate pause is not a transition")
    try state.resume();let active=state.generation;var releaseCount=0
    try state.dispatchTracking(active,token:"pure-test",release:{releaseCount+=1}) {calls+=1}
    state.pause();state.releaseOwnInputs();state.releaseOwnInputs();try expect(releaseCount==1,"release own held input once")
    do {try state.dispatchTracking(active,token:"rejected",release:{releaseCount+=1}) {calls+=1}} catch {}
    state.releaseOwnInputs();try expect(releaseCount==1,"refused down does not synthesize up")
    for origin in ["http://localhost:59721/path","http://127.0.0.1:59721","http://[::1]:59721","http://2130706433:59721","http://localhost.:59721"] {try expect(forbiddenOrigin(origin,denied:["http://127.0.0.1:59721"]),"loopback aliases denied")}
    try expect(!forbiddenOrigin("http://127.0.0.1:59722",denied:["http://127.0.0.1:59721"]),"distinct port is not the control origin")
    for origin in ["https://alias.example:59721","http://[::ffff:7f00:1]:59721","http://127.1:59721"] {try expect(forbiddenOrigin(origin,denied:["http://127.0.0.1:59721"]),"control-plane nonstandard port cannot be aliased")}
    try expect(fingerprintValue(NSNumber(value:1)) != fingerprintValue(NSNumber(value:2)),"numeric values have distinct semantic fingerprints")
    try expect(fingerprintValue(kCFBooleanTrue) != fingerprintValue(kCFBooleanFalse),"boolean values have distinct semantic fingerprints")
    var rangeA=CFRange(location:0,length:2);var rangeB=CFRange(location:1,length:2)
    try expect(fingerprintValue(AXValueCreate(.cfRange,&rangeA)) != fingerprintValue(AXValueCreate(.cfRange,&rangeB)),"text selection participates in semantic fingerprint")
    try state.resume();let releaseGeneration=state.generation;var completedUps=0;var leakedCleanup=0
    try state.dispatchTracking(releaseGeneration,token:"completed",release:{leakedCleanup+=1}) {}
    try state.dispatchRelease(releaseGeneration,token:"completed") {completedUps+=1}
    state.pause();state.releaseOwnInputs();try expect(completedUps==1 && leakedCleanup==0,"completed up atomically removes ownership before pause")
    do {try state.dispatchRelease(releaseGeneration,token:"completed") {completedUps+=1}} catch {}
    try expect(completedUps==1,"paused release cannot post an additional up")
    let stamps=Dictionary(uniqueKeysWithValues:SkyLightBridge.stamps(pid:42,window:77,group:9,phase:3,button:0,count:2))
    try expect(stamps[40]==42 && stamps[51]==77 && stamps[91]==77 && stamps[92]==77 && stamps[58]==9,"private exact PID/window routing plan")
    let identityAssertions=try axIdentitySelfTest();passed+=identityAssertions
    let interruptionAssertions=try inputInterruptionSelfTest();passed+=interruptionAssertions
    let cursorAssertions=try cursorVisibilitySelfTest();passed+=cursorAssertions
    let lifecycleAssertions=try cursorLifecycleSelfTest();passed+=lifecycleAssertions
    let completionAssertions=try cursorCompletionSelfTest();passed+=completionAssertions
    let refreshAssertions=try cursorRefreshSelfTest();passed+=refreshAssertions
    let configurationAssertions=try cursorConfigurationSelfTest();passed+=configurationAssertions
    let layoutAssertions=try cursorLayoutSelfTest();passed+=layoutAssertions
    let metadataAssertions=try cursorMetadataSelfTest();passed+=metadataAssertions
    let admissionAssertions=try overlayAdmissionSelfTest();passed+=admissionAssertions
    return ["passed":passed,"axIdentityAssertions":identityAssertions,"inputInterruptionAssertions":interruptionAssertions,"cursorAdmissionAssertions":admissionAssertions,"cursorPolicyAssertions":cursorAssertions,"cursorLifecycleAssertions":lifecycleAssertions,"cursorCompletionAssertions":completionAssertions,"cursorRefreshAssertions":refreshAssertions,"cursorConfigurationAssertions":configurationAssertions,"cursorLayoutAssertions":layoutAssertions,"cursorMetadataAssertions":metadataAssertions,"cursor":CursorCapability.descriptor,"guiActions":0,"permissionPrompts":0]
}
