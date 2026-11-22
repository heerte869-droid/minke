import Foundation
import ApplicationServices
import Darwin

func normalizedOrigin(_ input:String) -> (String,Int)? {
    guard let url=URLComponents(string:input),let scheme=url.scheme?.lowercased(),["http","https"].contains(scheme),url.user==nil,url.password==nil,var host=url.host?.lowercased() else {return nil}
    host=host.trimmingCharacters(in:CharacterSet(charactersIn:"[]"))
    while host.hasSuffix(".") {host.removeLast()}
    var address=in_addr()
    let loopback=host=="localhost" || host=="::1" || host.hasPrefix("::ffff:127.") || (inet_aton(host,&address)==1 && (UInt32(bigEndian:address.s_addr)>>24)==127)
    return (loopback ? "loopback" : host,url.port ?? (scheme=="https" ? 443 : 80))
}
func forbiddenOrigin(_ input:String,denied:[String]) -> Bool {
    guard let value=normalizedOrigin(input) else {return false}
    return denied.contains { raw in
        guard let origin=normalizedOrigin(raw) else {return false}
        guard origin.1==value.1 else {return false}
        // The local control plane uses an ephemeral nonstandard port. Refuse ANY
        // host at that port, not only textual loopback: DNS rebinding, aliases,
        // unusual IP spellings and mapped IPv6 cannot bypass this boundary.
        return origin.0==value.0 || (origin.1 != 80 && origin.1 != 443)
    }
}
func isBrowserBundle(_ bundle:String)->Bool {
    ["chrome","chromium","safari","firefox","brave","edge","vivaldi","opera","arc"].contains {bundle.lowercased().contains($0)}
}
extension NativeEngine {
    func deniedOrigins(_ p:[String:Any]) throws -> [String] {
        guard let values=p["deniedOrigins"] else {return []}
        guard let values=values as? [String],values.count<=32,values.allSatisfy({$0.utf8.count<=2048 && normalizedOrigin($0) != nil}) else {throw NativeError("invalid_params","Invalid trusted control-plane origin list")}
        return values
    }
    func assertControlPlane(_ window:AXUIElement,bundle:String,denied:[String]) throws {
        // No HTTP probes, DNS queries, browser profiles, or page scripts. Every
        // embedded WebArea must independently expose its own proven document URL.
        // Browser origin uncertainty falls back to the separately secured CDP adapter.
        let browser=isBrowserBundle(bundle)
        if browser && denied.isEmpty {throw NativeError("browser_origin_unknown","Native browser observation requires trusted deniedOrigins from the host")}
        var queue:[AXUIElement]=[window];var index=0;var documentKnown=false;var visited=AXIdentitySet()
        while index<queue.count {
            guard index<4000 else {throw NativeError("browser_origin_unknown","Cannot completely inspect window origins")}
            let element=queue[index];index+=1
            guard visited.insert(element) else {continue}
            guard let role=axString(element,kAXRoleAttribute) else {throw NativeError("browser_origin_unknown","An AX node has no inspectable role")}
            var nodeSourceKnown=false
            for attribute in ["AXURL","AXDocument"] {
                guard let value=ax(element,attribute) else {continue}
                let raw:String?
                if let url=value as? URL {raw=url.absoluteString} else {raw=value as? String}
                guard let raw else {throw NativeError("browser_origin_unknown","An exposed document URL cannot be decoded")}
                if forbiddenOrigin(raw,denied:denied) {throw NativeError("control_plane_forbidden","The DSH control-plane page cannot be observed or controlled")}
                if attribute=="AXDocument" || role=="AXWebArea" {
                    if normalizedOrigin(raw) != nil {nodeSourceKnown=true;documentKnown=true}
                    else if browser || role=="AXWebArea" {throw NativeError("browser_origin_unknown","Web document is not a provable HTTP(S) target; use authorized CDP")}
                }
            }
            if role=="AXWebArea" && (denied.isEmpty || !nodeSourceKnown) {throw NativeError("browser_origin_unknown","Every embedded WebArea needs its own trustworthy origin and host control-plane exclusions")}
            if isSecure(element) {continue}
            var children:CFTypeRef?
            let result=AXUIElementCopyAttributeValue(element,kAXChildrenAttribute as CFString,&children)
            guard result == .success || result == .noValue || result == .attributeUnsupported else {throw NativeError("browser_origin_unknown","AX origin inspection is incomplete")}
            if let list=children as? [AXUIElement] {
                guard queue.count+list.count<=4000 else {throw NativeError("browser_origin_unknown","Origin inspection exceeded its limit")};queue.append(contentsOf:list)
            }
        }
        if browser && !documentKnown {throw NativeError("browser_origin_unknown","Browser does not expose a trustworthy document origin through AX; use authorized CDP")}
    }
}
