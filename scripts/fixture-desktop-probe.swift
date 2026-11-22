import AppKit
import ApplicationServices
import Foundation

// Read-only acceptance metadata. Never activates apps, queries AX, posts input,
// captures pixels, or reads titles/documents. Optional overlay checking emits only
// geometry of the exact owned helper, plus a count of rectangular occluders.
// No privacy request API is used. Only the dedicated fixture is enumerated.
let applications = NSRunningApplication.runningApplications(withBundleIdentifier: "local.dsh.computer-use.fixture")
let fixtures: [[String: Any]] = applications.filter { !$0.isTerminated }.map {
    ["pid": Int($0.processIdentifier), "executablePath": $0.executableURL?.resolvingSymlinksInPath().path ?? ""]
}
let cursor = CGEvent(source: nil)?.location
var output: [String: Any] = [
    "frontmostPID": NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) } as Any? ?? NSNull(),
    "fixtures": fixtures,
    "readOnly": true
]
if let cursor { output["cursor"] = ["x": cursor.x, "y": cursor.y] }
else { output["cursor"] = NSNull() }
func argumentPID(_ name:String)->Int32? {
    guard let i=CommandLine.arguments.firstIndex(of:name),i+1<CommandLine.arguments.count else {return nil}
    return Int32(CommandLine.arguments[i+1])
}
if let helperPID=argumentPID("--overlay-pid"),helperPID>0 {
    let raw=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] ?? []
    var owned:[[String:Any]]=[]
    for (index,info) in raw.enumerated() {
        guard let pid=info[kCGWindowOwnerPID as String] as? Int,pid==Int(helperPID),
              let dict=info[kCGWindowBounds as String] as? [String:Any],let frame=CGRect(dictionaryRepresentation:dict as CFDictionary) else {continue}
        let blockers=raw[..<index].filter { other in
            guard (other[kCGWindowAlpha as String] as? Double ?? 1)>0,
                  let bounds=other[kCGWindowBounds as String] as? [String:Any],let rect=CGRect(dictionaryRepresentation:bounds as CFDictionary) else {return true}
            return rect.intersects(frame)
        }.count
        owned.append(["windowId":info[kCGWindowNumber as String] ?? 0,"alpha":info[kCGWindowAlpha as String] ?? 0,"layer":info[kCGWindowLayer as String] ?? 0,
          "frame":["x":frame.minX,"y":frame.minY,"width":frame.width,"height":frame.height],"rectangularBlockers":blockers])
    }
    output["ownedOverlayWindows"]=owned
}
guard let data = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]) else { exit(3) }
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([10]))
