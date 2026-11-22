import AppKit
import Foundation

// Disposable local fixture. Never opens real documents, notes, accounts, or profiles.
func emit(_ value:[String:Any]) {if let data=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]) {FileHandle.standardOutput.write(data);FileHandle.standardOutput.write(Data([10]))}}
final class DragPad:NSView {
    var changed:(()->Void)?
    var drags=0
    private var dot=CGPoint(x:40,y:50)
    override init(frame:NSRect) {super.init(frame:frame);setAccessibilityElement(true);setAccessibilityRole(.image);setAccessibilityLabel("Fixture Drag Pad");setAccessibilityValue("drag count 0")}
    required init?(coder:NSCoder) {fatalError("not used")}
    override func draw(_ dirtyRect:NSRect) {NSColor.windowBackgroundColor.setFill();bounds.fill();NSColor.systemBlue.setFill();NSBezierPath(ovalIn:NSRect(x:dot.x-12,y:dot.y-12,width:24,height:24)).fill()}
    override func mouseDown(with event:NSEvent) {dot=convert(event.locationInWindow,from:nil);needsDisplay=true}
    override func mouseDragged(with event:NSEvent) {dot=convert(event.locationInWindow,from:nil);drags+=1;setAccessibilityValue("drag count \(drags)");needsDisplay=true;changed?()}
    override func mouseUp(with event:NSEvent) {changed?()}
}
final class Fixture:NSObject,NSApplicationDelegate,NSTextFieldDelegate {
    var window:NSWindow!
    let text=NSTextField(frame:NSRect(x:24,y:400,width:510,height:32))
    let count=NSButton(frame:NSRect(x:24,y:352,width:170,height:32))
    let scroll=NSScrollView(frame:NSRect(x:24,y:24,width:290,height:306))
    let pad=DragPad(frame:NSRect(x:336,y:24,width:198,height:306))
    var clicks=0
    func state() {emit(["event":"fixture","data":["clicks":clicks,"text":text.stringValue,"drags":pad.drags,"scrollY":scroll.contentView.bounds.origin.y]])}
    func applicationDidFinishLaunching(_ notification:Notification) {
        window=NSWindow(contentRect:NSRect(x:200,y:180,width:560,height:470),styleMask:[.titled,.closable,.miniaturizable],backing:.buffered,defer:false)
        window.title="Computer Use Fixture — Disposable"
        window.isReleasedWhenClosed=false
        let content=window.contentView!
        let heading=NSTextField(labelWithString:"Disposable data only · no real documents")
        heading.frame=NSRect(x:24,y:440,width:510,height:20);content.addSubview(heading)
        text.placeholderString="Fixture text / 中文测试";text.setAccessibilityLabel("Fixture Text");text.delegate=self;content.addSubview(text)
        count.title="Fixture Count";count.target=self;count.action=#selector(increment);content.addSubview(count)
        let document=NSTextView(frame:NSRect(x:0,y:0,width:270,height:2600))
        document.isEditable=false;document.isSelectable=false;document.string=(1...120).map{"Disposable fixture row \($0)"}.joined(separator:"\n")
        document.setAccessibilityLabel("Fixture Scroll Document")
        scroll.documentView=document;scroll.hasVerticalScroller=true;scroll.setAccessibilityLabel("Fixture Scroll");content.addSubview(scroll)
        scroll.contentView.postsBoundsChangedNotifications=true
        NotificationCenter.default.addObserver(forName:NSView.boundsDidChangeNotification,object:scroll.contentView,queue:.main) {[weak self] _ in self?.state()}
        pad.changed={[weak self] in self?.state()};content.addSubview(pad)
        if CommandLine.arguments.contains("--secure") {
            let secret=NSSecureTextField(frame:NSRect(x:212,y:352,width:322,height:32));secret.stringValue="fixture-secret-never-observe";secret.setAccessibilityLabel("Fixture Secure Control");content.addSubview(secret)
        }
        // Establish this app's own key window without activating it or moving the user's cursor.
        window.makeKeyAndOrderFront(nil);window.makeFirstResponder(text)
        // Keep the disposable target visibly exposed without activating its app.
        // This is the positive visibility fixture, never a production focus fallback.
        window.orderFrontRegardless()
        emit(["event":"ready","data":["bundleId":Bundle.main.bundleIdentifier ?? "","pid":ProcessInfo.processInfo.processIdentifier,"disposable":true]])
        state()
    }
    @objc func increment() {clicks+=1;state()}
    func controlTextDidChange(_ obj:Notification) {state()}
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool {true}
}
let app=NSApplication.shared
let delegate=Fixture();app.delegate=delegate
app.setActivationPolicy(.regular)
app.run()
