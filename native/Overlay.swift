import AppKit
import QuartzCore

// Implementation self-description, not observed desktop visibility or permission.
// Shared by real status/ready and the pre-NSApplication pure self-test branch.
enum CursorCapability {
    static var descriptor:[String:Any] {
        ["schema":1,"kind":"software-overlay","visibility":"target-window",
         "independentNativePointer":false,"runtimeValidated":false]
    }
}

// Logical-point artwork geometry shared by drawing and target-relative positioning.
enum CursorDesign {
    static let extent:CGFloat=100
    static let hotspot=CGPoint(x:8,y:92)
    static var cgHotspotFraction:CGPoint {CGPoint(x:hotspot.x/extent,y:(extent-hotspot.y)/extent)}
}
// A value snapshot, not an atomic WindowServer/display observation.
struct CursorDisplayLayout {
    private let referenceY:CGFloat
    let cgScreenFrames:[CGRect]
    static func finiteRectangle(_ rect:CGRect)->Bool {
        [rect.origin.x,rect.origin.y,rect.size.width,rect.size.height,rect.maxX,rect.maxY].allSatisfy {$0.isFinite} && rect.size.width>0 && rect.size.height>0
    }
    init?(cocoaScreenFrames:[CGRect]) {
        guard let first=cocoaScreenFrames.first,cocoaScreenFrames.allSatisfy(Self.finiteRectangle) else {return nil}
        let referenceY=first.maxY
        let converted=cocoaScreenFrames.map {CGRect(x:$0.minX,y:referenceY-$0.maxY,width:$0.width,height:$0.height)}
        guard converted.allSatisfy(Self.finiteRectangle) else {return nil}
        self.referenceY=referenceY;cgScreenFrames=converted
    }
    func cocoaOrigin(forCGPanel panel:CGRect)->CGPoint? {
        guard Self.finiteRectangle(panel) else {return nil}
        let origin=CGPoint(x:panel.minX,y:referenceY-panel.maxY)
        return origin.x.isFinite && origin.y.isFinite ? origin : nil
    }
}

// The desktop, web marker and settings preview share the original transparent PNG.
enum CursorVariant:String,CaseIterable {
    case mini, large
    var resource:String { self == .mini ? "cursor-whale" : "cursor-whale-large" }
    var hotspot:CGFloat { self == .mini ? 48.0/512.0 : 88.0/1254.0 }
}
enum CursorArtwork {
    private static let sources: [CursorVariant:CGImageSource] = Dictionary(uniqueKeysWithValues: CursorVariant.allCases.compactMap { variant in
        guard let url=Bundle.main.url(forResource:variant.resource,withExtension:"png"),
              let source=CGImageSourceCreateWithURL(url as CFURL,nil) else {return nil}
        return (variant,source)
    })
    private static var thumbnail:(variant:CursorVariant,pixels:Int,image:CGImage)?
    static func draw(in bounds:NSRect,phase:String,variant:CursorVariant) {
        guard let context=NSGraphicsContext.current?.cgContext, let source=sources[variant] else {return}
        let pixels=max(1,Int(ceil(abs(context.convertToDeviceSpace(bounds).width))))
        if thumbnail?.variant != variant || thumbnail?.pixels != pixels {
            let options:[CFString:Any]=[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceThumbnailMaxPixelSize:pixels,kCGImageSourceShouldCacheImmediately:true]
            guard let rep=CGImageSourceCreateThumbnailAtIndex(source,0,options as CFDictionary) else {return}
            thumbnail=(variant,pixels,rep)
        }
        guard let image=thumbnail?.image else {return}
        context.saveGState();defer{context.restoreGState()}
        context.interpolationQuality = .high
        let offset=CGFloat(0.08) - variant.hotspot
        context.draw(image,in:bounds.offsetBy(dx:offset*bounds.width,dy:-offset*bounds.height))
        if phase=="waiting" {
            let circle=NSBezierPath(ovalIn:CGRect(x:bounds.minX+bounds.width*0.63,y:bounds.minY+bounds.height*0.57,width:bounds.width*0.24,height:bounds.height*0.24))
            NSColor(calibratedRed:0.73,green:0.84,blue:1,alpha:1).setStroke();circle.lineWidth=bounds.width*0.05;circle.stroke()
        }
    }
}
final class WhaleView:NSView {
    var artwork = CursorVariant.large { didSet { needsDisplay = true } }
    var phase="idle" {didSet {needsDisplay=true;synchronizeMotion()}}
    var reducedMotion=false {didSet {synchronizeMotion()}}
    var presentationVisible=false {didSet {synchronizeMotion()}}
    private let spinner=CAShapeLayer()
    private var motionObserver:NSObjectProtocol?
    override var isOpaque:Bool {false}
    override init(frame:NSRect) {
        super.init(frame:frame)
        wantsLayer=true;layerContentsRedrawPolicy = .onSetNeedsDisplay
        spinner.fillColor=nil;spinner.strokeColor=NSColor(calibratedRed:0.29,green:0.42,blue:0.94,alpha:1).cgColor
        spinner.lineCap = .round;layer?.addSublayer(spinner)
        motionObserver=NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,object:nil,queue:.main){[weak self] _ in self?.synchronizeMotion()}
        synchronizeMotion()
    }
    required init?(coder:NSCoder) {fatalError("init(coder:) has not been implemented")}
    override func draw(_ dirtyRect:NSRect) {CursorArtwork.draw(in:bounds,phase:phase,variant:artwork)}
    override func layout() {super.layout();synchronizeMotion()}
    override func viewDidChangeBackingProperties() {super.viewDidChangeBackingProperties();needsDisplay=true;synchronizeMotion()}
    private func synchronizeMotion() {
        guard let layer else {return}
        let unit=bounds.width/100
        CATransaction.begin();CATransaction.setDisableActions(true)
        layer.contentsScale=max(1,convertToBacking(NSRect(x:0,y:0,width:1,height:1)).width)
        spinner.contentsScale=layer.contentsScale
        spinner.bounds=CGRect(x:0,y:0,width:24*unit,height:24*unit)
        spinner.position=CGPoint(x:75*unit,y:69*unit)
        let arc=CGMutablePath();arc.addArc(center:CGPoint(x:12*unit,y:12*unit),radius:12*unit,startAngle:.pi/7,endAngle:.pi*6/7,clockwise:false)
        spinner.path=arc;spinner.lineWidth=5*unit;spinner.isHidden=phase != "waiting"
        CATransaction.commit()
        let animate=presentationVisible && phase=="waiting" && !reducedMotion && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if animate {
            if spinner.animation(forKey:"busy") == nil {
                let animation=CABasicAnimation(keyPath:"transform.rotation.z")
                animation.fromValue=0;animation.toValue = -Double.pi*2;animation.duration=1.2
                animation.repeatCount = .infinity;animation.timingFunction=CAMediaTimingFunction(name:.linear)
                spinner.add(animation,forKey:"busy")
            }
        } else {spinner.removeAnimation(forKey:"busy")}
    }
    deinit {if let motionObserver {NSWorkspace.shared.notificationCenter.removeObserver(motionObserver)}}
}

struct CursorConfiguration:Equatable {
    private(set) var variant = CursorVariant.large
    private(set) var mode="clean"
    private(set) var size:Double=28
    private(set) var holdMs:Double=1200
    private(set) var reducedMotion=false
    var descriptor:[String:Any] { ["variant":variant.rawValue,"mode":mode,"size":size,"holdMs":holdMs,"reducedMotion":reducedMotion] }
    mutating func apply(_ p:[String:Any]) throws -> [String:Any] {
        var proposed=self
        if let raw=p["variant"] {
            guard let key=raw as? String, let choice=CursorVariant(rawValue:key) else {throw NativeError("invalid_params","Unknown artwork variant")}
            proposed.variant=choice
        }
        if let value=p["mode"] as? String {guard ["clean","companion","hidden"].contains(value) else {throw NativeError("invalid_params","Unknown overlay mode")};proposed.mode=value}
        if p["size"] != nil {proposed.size=Double(try boundedInt(p["size"],28,20,128))}
        if p["holdMs"] != nil {proposed.holdMs=Double(try boundedInt(p["holdMs"],1200,300,5000))}
        if let value=p["reducedMotion"] as? Bool {proposed.reducedMotion=value}
        self=proposed
        return descriptor
    }
}
func cursorConfigurationSelfTest() throws -> Int {
    var passed=0
    func expect(_ value:Bool,_ label:String) throws {guard value else {throw NativeError("self_test_failed","cursor configuration: \(label)")};passed+=1}
    func reflects(_ report:[String:Any],_ c:CursorConfiguration)->Bool {
        report.count==5 && report["variant"] as? String == c.variant.rawValue && report["mode"] as? String==c.mode && report["size"] as? Double==c.size && report["holdMs"] as? Double==c.holdMs && report["reducedMotion"] as? Bool==c.reducedMotion
    }
    var c=CursorConfiguration()
    try expect(c.mode=="clean" && c.size==28 && c.holdMs==1200 && !c.reducedMotion,"small pointer defaults")
    try expect(reflects(c.descriptor,c),"default descriptor uses committed fields")
    let initial=c,empty=try c.apply([:])
    try expect(reflects(empty,c),"empty proposal reports existing state")
    try expect(c==initial,"missing fields preserve all values")
    let full=try c.apply(["mode":"companion","size":64,"holdMs":2200,"reducedMotion":true])
    try expect(c.mode=="companion" && c.size==64 && c.holdMs==2200 && c.reducedMotion,"valid multi-field proposal commits together")
    try expect(reflects(full,c),"success reports committed proposal")
    _=try c.apply(["mode":"clean","size":20,"holdMs":300])
    try expect(c.size==20 && c.holdMs==300 && c.mode=="clean","inclusive lower bounds accepted")
    try expect(c.reducedMotion,"sparse proposal preserves unmentioned flag")
    let upper=try c.apply(["mode":"hidden","size":128,"holdMs":5000])
    try expect(c.mode=="hidden" && c.size==128 && c.holdMs==5000,"inclusive upper bounds accepted")
    try expect(reflects(upper,c),"upper bounds report actual committed dimensions")
    _=try c.apply(["mode":"companion"])
    try expect(c.size==128 && c.holdMs==5000 && c.reducedMotion,"mode-only update does not reset geometry or timing")
    try expect(c.mode=="companion","mode-only update is applied")
    c=CursorConfiguration()
    let invalid:[[String:Any]]=[
        ["mode":"unknown"],["size":19],["size":129],["size":true],
        ["size":48.5],["size":Double.nan],["size":Double.infinity],["size":NSNull()],
        ["size":32,"holdMs":299],
        ["mode":"hidden","size":128,"holdMs":5001,"reducedMotion":true],
        ["size":64,"holdMs":true],["size":64,"holdMs":1200.5],
        ["size":64,"holdMs":Double.nan],["size":64,"holdMs":Double.infinity]
    ]
    for (index,proposal) in invalid.enumerated() {
        let before=c
        var code:String?
        do {_=try c.apply(proposal)} catch let error as NativeError {code=error.code}
        try expect(code=="invalid_params","invalid proposal \(index) is rejected")
        try expect(c==before,"invalid proposal \(index) commits no fields")
    }
    _=try c.apply(["size":128,"holdMs":5000,"reducedMotion":true])
    let large=c
    var code:String?
    do {_=try c.apply(["size":32,"holdMs":299])} catch let error as NativeError {code=error.code}
    try expect(code=="invalid_params","late validation failure is rejected from an existing large configuration")
    try expect(c==large,"late validation failure keeps the previous 128-point geometry and all flags")
    let retainedFrame=CursorVisibility.panelFrame(point:CGPoint(x:100,y:200),size:c.size)
    try expect(retainedFrame?.width==128 && retainedFrame?.height==128 && abs((retainedFrame?.minX ?? 0)-89.76)<0.000001 && abs((retainedFrame?.minY ?? 0)-189.76)<0.000001,"failed proposal retains the previous visibility rectangle and hotspot")
    let recovered=try c.apply(["size":48,"holdMs":1200])
    try expect(c.size==48 && c.holdMs==1200 && c.reducedMotion,"valid update after failure succeeds without unrelated resets")
    try expect(reflects(recovered,c),"post-failure success reports committed state")
    let beforeIgnored=c,ignored=try c.apply(["mode":7,"reducedMotion":"yes"])
    try expect(c==beforeIgnored,"legacy non-string mode/non-bool motion fields remain ignored")
    try expect(reflects(ignored,c),"ignored fields do not change the response contract")
    let allSizes=try (20...128).allSatisfy { value in
        var candidate=CursorConfiguration()
        let response=try candidate.apply(["size":value])
        guard let frame=CursorVisibility.panelFrame(point:CGPoint(x:100,y:200),size:candidate.size) else {return false}
        return candidate.size==Double(value) && reflects(response,candidate) && frame.width==candidate.size && frame.height==candidate.size
    }
    try expect(allSizes,"all 109 permitted integer sizes use committed dimensions for the visibility rectangle")
    return passed
}
func cursorLayoutSelfTest() throws -> Int {
    var passed=0
    func expect(_ value:Bool,_ label:String) throws {guard value else {throw NativeError("self_test_failed","cursor layout: \(label)")};passed+=1}
    let primary=CGRect(x:0,y:0,width:1440,height:900)
    let frames=[primary,CGRect(x:-1280,y:0,width:1280,height:800),CGRect(x:0,y:900,width:1200,height:800),CGRect(x:0,y:-768,width:1024,height:768)]
    guard let layout=CursorDisplayLayout(cocoaScreenFrames:frames) else {throw NativeError("self_test_failed","cursor layout fixture")}
    try expect(CursorDesign.extent==100 && CursorDesign.hotspot==CGPoint(x:8,y:92),"original design geometry")
    try expect(layout.cgScreenFrames.count==4,"all screens retained in input order")
    try expect(layout.cgScreenFrames[0]==primary,"primary fixed CG origin")
    try expect(layout.cgScreenFrames[1]==CGRect(x:-1280,y:100,width:1280,height:800),"left screen with negative X")
    try expect(layout.cgScreenFrames[2]==CGRect(x:0,y:-800,width:1200,height:800),"upper screen has negative CG Y")
    try expect(layout.cgScreenFrames[3]==CGRect(x:0,y:900,width:1024,height:768),"lower screen has positive CG Y")
    let panel=CGRect(x:92,y:192,width:100,height:100)
    try expect(layout.cocoaOrigin(forCGPanel:panel)==CGPoint(x:92,y:608),"explicit known Cocoa origin")
    let origin=layout.cocoaOrigin(forCGPanel:panel)!
    try expect(CGPoint(x:origin.x+8,y:origin.y+92)==CGPoint(x:100,y:700),"explicit original drawn hotspot recovers point")
    let points=[CGPoint(x:100,y:200),CGPoint(x:-1100,y:250),CGPoint(x:150,y:-600),CGPoint(x:150,y:1100)]
    let allAnchors=(20...128).allSatisfy { size in points.allSatisfy { point in
        guard let panel=CursorVisibility.panelFrame(point:point,size:Double(size)),let origin=layout.cocoaOrigin(forCGPanel:panel) else {return false}
        let x=origin.x+CGFloat(size)*CursorDesign.hotspot.x/CursorDesign.extent
        let y=origin.y+CGFloat(size)*CursorDesign.hotspot.y/CursorDesign.extent
        return abs(x-point.x)<0.00000001 && abs(y-(900-point.y))<0.00000001
    }}
    try expect(allAnchors,"all 109 integer sizes recover four explicit logical-point hotspots")
    try expect(CursorVisibility.panelFrame(point:CGPoint(x:100,y:200),size:32.5)?.width==32.5,"internal fractional-size compatibility unchanged")
    try expect(CursorDisplayLayout(cocoaScreenFrames:[])==nil,"empty layout rejected")
    try expect(CursorDisplayLayout(cocoaScreenFrames:[CGRect(x:0,y:0,width:0,height:900)])==nil,"zero screen width rejected")
    try expect(CursorDisplayLayout(cocoaScreenFrames:[CGRect(x:0,y:0,width:-1,height:900)])==nil,"negative screen width rejected")
    try expect(CursorDisplayLayout(cocoaScreenFrames:[CGRect(x:0,y:0,width:1440,height:0)])==nil,"zero screen height rejected")
    try expect(CursorDisplayLayout(cocoaScreenFrames:[CGRect(x:0,y:0,width:1440,height:-1)])==nil,"negative screen height rejected")
    try expect(CursorDisplayLayout(cocoaScreenFrames:[CGRect(x:Double.nan,y:0,width:1440,height:900)])==nil,"NaN screen origin rejected")
    try expect(CursorDisplayLayout(cocoaScreenFrames:[CGRect(x:0,y:0,width:1440,height:Double.infinity)])==nil,"infinite screen size rejected")
    try expect(CursorDisplayLayout(cocoaScreenFrames:[CGRect(x:0,y:-Double.infinity,width:1440,height:900)])==nil,"negative infinite screen origin rejected")
    let huge=Double.greatestFiniteMagnitude
    try expect(CursorDisplayLayout(cocoaScreenFrames:[CGRect(x:huge,y:0,width:huge,height:900)])==nil,"derived maxX overflow rejected")
    try expect(CursorDisplayLayout(cocoaScreenFrames:[CGRect(x:0,y:huge,width:1440,height:huge)])==nil,"derived maxY overflow rejected")
    try expect(CursorDisplayLayout(cocoaScreenFrames:[primary,CGRect(x:0,y:0,width:0,height:800)])==nil,"malformed later screen rejects whole snapshot")
    let tall=CGRect(x:0,y:0,width:100,height:huge*0.75)
    try expect(CursorDisplayLayout(cocoaScreenFrames:[tall,CGRect(x:200,y:-huge,width:100,height:1)])==nil,"converted origin overflow rejected")
    try expect(CursorDisplayLayout(cocoaScreenFrames:[tall,CGRect(x:200,y:-huge*0.5,width:100,height:huge*0.5)])==nil,"converted boundary overflow rejected")
    try expect(layout.cocoaOrigin(forCGPanel:CGRect(x:Double.nan,y:0,width:48,height:48))==nil,"NaN panel rejected")
    try expect(layout.cocoaOrigin(forCGPanel:CGRect(x:0,y:0,width:0,height:48))==nil,"zero panel rejected")
    try expect(layout.cocoaOrigin(forCGPanel:CGRect(x:0,y:0,width:-1,height:48))==nil,"negative panel rejected")
    try expect(layout.cocoaOrigin(forCGPanel:CGRect(x:huge,y:0,width:huge,height:48))==nil,"panel derived boundary overflow rejected")
    guard let tallLayout=CursorDisplayLayout(cocoaScreenFrames:[tall]) else {throw NativeError("self_test_failed","cursor tall layout fixture")}
    try expect(tallLayout.cocoaOrigin(forCGPanel:CGRect(x:0,y:-huge,width:48,height:48))==nil,"panel origin conversion overflow rejected")
    let targetFrame=CGRect(x:-1280,y:-800,width:2720,height:2468)
    let target=CursorWindowGeometry(id:7,pid:42,frame:targetFrame,onScreen:true,alpha:1,layer:0)
    func allowed(_ panel:CGRect)->Bool {CursorVisibility.permits(windows:[target],pid:42,windowID:7,expectedFrame:targetFrame,panel:panel,screens:layout.cgScreenFrames,overlayID:9,overlayPID:99)}
    try expect(!allowed(CGRect(x:-24,y:200,width:48,height:48)),"seamless horizontal cross-screen panel still suppressed")
    try expect(allowed(CGRect(x:-100,y:200,width:48,height:48)),"entire panel inside negative-X screen allowed")
    try expect(!allowed(CGRect(x:100,y:880,width:48,height:48)),"seamless vertical cross-screen panel still suppressed")
    try expect(allowed(CGRect(x:100,y:1000,width:48,height:48)),"entire panel inside lower screen allowed")
    let shifted=CursorDisplayLayout(cocoaScreenFrames:[CGRect(x:100,y:50,width:800,height:600)])
    try expect(shifted?.cgScreenFrames==[CGRect(x:100,y:0,width:800,height:600)] && shifted?.cocoaOrigin(forCGPanel:panel)==CGPoint(x:92,y:358),"first frame maxY remains reference, not height or main screen")
    var laterFrames=frames
    let snapshot=CursorDisplayLayout(cocoaScreenFrames:laterFrames)
    laterFrames[0]=CGRect(x:0,y:0,width:800,height:600)
    try expect(snapshot?.cgScreenFrames==layout.cgScreenFrames,"later caller array mutation cannot change stored layout")
    try expect(layout.cocoaOrigin(forCGPanel:CGRect(x:0,y:-Double.infinity,width:48,height:48))==nil,"negative infinite panel origin rejected")
    try expect(layout.cocoaOrigin(forCGPanel:CGRect(x:0,y:0,width:Double.infinity,height:48))==nil,"infinite panel size rejected")
    return passed
}

// Pure, deliberately conservative rectangle policy. No window/desktop queries here.
struct CursorWindowGeometry {
    let id:CGWindowID
    let pid:pid_t
    let frame:CGRect
    let onScreen:Bool
    let alpha:Double
    let layer:Int
}
// Pure decoder for the visited metadata prefix; no WindowServer queries here.
enum CursorWindowMetadata {
    private static func number(_ value:Any?)->Double? {
        guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),!(n is NSDecimalNumber),n.doubleValue.isFinite else {return nil}
        return n.doubleValue
    }
    private static func integer(_ value:Any?,min:Double,max:Double)->Double? {
        guard let n=number(value),n>=min,n<=max,n.rounded(.towardZero)==n else {return nil}
        return n
    }
    private static func frame(_ value:Any?)->CGRect? {
        guard let bounds=value as? [String:Any],let x=number(bounds["X"]),let y=number(bounds["Y"]),
              let width=number(bounds["Width"]),let height=number(bounds["Height"]),width>0,height>0 else {return nil}
        let rect=CGRect(x:x,y:y,width:width,height:height)
        return CursorDisplayLayout.finiteRectangle(rect) ? rect : nil
    }
    static func decode(_ raw:[[String:Any]],until windowID:CGWindowID)->[CursorWindowGeometry]? {
        guard raw.count<=2048 else {return nil}
        var windows:[CursorWindowGeometry]=[],seen=Set<CGWindowID>()
        for row in raw {
            guard let id=integer(row[kCGWindowNumber as String],min:1,max:Double(UInt32.max)),
                  let pid=integer(row[kCGWindowOwnerPID as String],min:1,max:Double(Int32.max)),
                  let rect=frame(row[kCGWindowBounds as String]),
                  let onScreen=row[kCGWindowIsOnscreen as String] as? NSNumber,CFGetTypeID(onScreen)==CFBooleanGetTypeID(),onScreen.boolValue,
                  let alpha=number(row[kCGWindowAlpha as String]),(0...1).contains(alpha),
                  let layer=integer(row[kCGWindowLayer as String],min:Double(Int32.min),max:Double(Int32.max)) else {return nil}
            let number=CGWindowID(id)
            guard seen.insert(number).inserted else {return nil}
            windows.append(CursorWindowGeometry(id:number,pid:pid_t(pid),frame:rect,onScreen:true,alpha:alpha,layer:Int(layer)))
            if number==windowID {return windows}
        }
        return nil
    }
}
func cursorMetadataSelfTest() throws -> Int {
    var passed=0
    func expect(_ value:Bool,_ label:String) throws {guard value else {throw NativeError("self_test_failed","cursor metadata: \(label)")};passed+=1}
    let idKey=kCGWindowNumber as String,pidKey=kCGWindowOwnerPID as String,boundsKey=kCGWindowBounds as String,
        onKey=kCGWindowIsOnscreen as String,alphaKey=kCGWindowAlpha as String,layerKey=kCGWindowLayer as String
    let bounds:[String:Any]=["X":0,"Y":0,"Width":500,"Height":400]
    func row(_ id:UInt32=7,_ pid:Int32=42)->[String:Any] {[idKey:id,pidKey:pid,boundsKey:bounds,onKey:true,alphaKey:1.0,layerKey:0]}
    func decode(_ rows:[[String:Any]])->[CursorWindowGeometry]? {CursorWindowMetadata.decode(rows,until:7)}
    func changed(_ key:String,_ value:Any)->[String:Any] {var result=row();result[key]=value;return result}
    func badBounds(_ key:String,_ value:Any)->[String:Any] {var result=bounds;result[key]=value;return result}
    let target=row(),front=row(8,77),decoded=decode([target])?.first
    try expect(decode([target])?.count==1,"one target row")
    try expect(decoded?.id==7 && decoded?.pid==42,"exact window and process identities")
    try expect(decoded?.frame==CGRect(x:0,y:0,width:500,height:400),"known bounds fields")
    var integral=target;integral[idKey]=7.0;integral[pidKey]=42.0;integral[layerKey]=0.0
    try expect(decode([integral])?.count==1,"integer-valued CFNumbers remain valid")
    try expect(decode([changed(layerKey,-1)])?.first?.layer == -1,"signed layer is preserved by decoder")
    try expect(decode([changed(alphaKey,0)])?.first?.alpha==0,"numeric zero alpha")
    try expect(decode([changed(alphaKey,1)])?.first?.alpha==1,"numeric one alpha")
    try expect(decode([changed(alphaKey,0.25)])?.first?.alpha==0.25,"fractional alpha remains legal")
    try expect(decode([front,target])?.count==2,"ordered prefix retained")
    try expect(decode([target,[:]])?.count==1,"invalid tail after first target is not parsed")
    try expect(decode([target,target])?.count==1,"duplicate after first target is not inspected")
    try expect(decode([target]+Array(repeating:front,count:2047))?.count==1,"2048 raw rows permitted before prefix decoding")
    try expect(decode([target]+Array(repeating:front,count:2048))==nil,"2049 raw rows rejected even with target first")
    try expect(decode([])==nil,"empty list fails closed")
    try expect(decode([front])==nil,"missing target fails closed")
    try expect(decode([front,front,target])==nil,"duplicate identity in visited prefix fails closed")
    let invalid:[(String,Any?,String)]=[
        (idKey,true,"Bool ID"),(idKey,8.5,"fractional ID"),(idKey,0,"zero ID"),(idKey,-1,"negative ID"),
        (idKey,Double(UInt32.max)+1,"ID overflow"),(idKey,Double.nan,"NaN ID"),(idKey,Double.infinity,"infinite ID"),
        (idKey,NSDecimalNumber(string:"8.0000000000000001"),"decimal ID must not round to an integer"),
        (pidKey,true,"Bool PID"),(pidKey,77.5,"fractional PID"),(pidKey,0,"zero PID"),(pidKey,-1,"negative PID"),
        (pidKey,Double(Int32.max)+1,"PID overflow"),(pidKey,Double.infinity,"infinite PID"),
        (alphaKey,false,"Bool alpha"),(alphaKey,Double.nan,"NaN alpha"),(alphaKey,1.01,"high alpha"),(alphaKey,-0.01,"negative alpha"),
        (layerKey,false,"Bool layer"),(layerKey,0.5,"fractional layer"),(layerKey,Double.nan,"NaN layer"),(layerKey,Double.infinity,"infinite layer"),
        (layerKey,Double(Int32.max)+1,"layer upper overflow"),(layerKey,Double(Int32.min)-1,"layer lower overflow"),
        (onKey,NSNumber(value:1),"numeric on-screen is not CFBoolean"),(onKey,false,"off-screen row"),
        (boundsKey,badBounds("Width",-1),"negative raw width"),(boundsKey,badBounds("Height",0),"zero raw height"),
        (boundsKey,badBounds("X",true),"Bool coordinate"),(boundsKey,badBounds("Y",Double.nan),"NaN coordinate"),
        (boundsKey,["X":Double.greatestFiniteMagnitude,"Y":0.0,"Width":Double.greatestFiniteMagnitude,"Height":1.0],"derived frame edge overflow"),
        (boundsKey,nil,"missing bounds")]
    for (key,value,label) in invalid {var bad=front;bad[key]=value;try expect(decode([bad,target])==nil,label)}
    try expect(CursorWindowMetadata.decode([row(UInt32.max,Int32.max)],until:UInt32.max)?.first?.pid==Int32.max,"upper legal ID and PID remain exact")
    let fractionalBounds:[String:Any]=["X":-1.25,"Y":0.5,"Width":500.75,"Height":400.25]
    try expect(decode([changed(boundsKey,fractionalBounds)])?.first?.frame==CGRect(x:-1.25,y:0.5,width:500.75,height:400.25),"fractional logical coordinates preserved")
    try expect(!CursorVisibility.valid(CGRect(x:0,y:0,width:-1,height:1)),"pure policy rejects original negative dimensions")
    try expect(!CursorVisibility.valid(CGRect(x:Double.greatestFiniteMagnitude,y:0,width:Double.greatestFiniteMagnitude,height:1)),"pure policy rejects derived edge overflow")
    return passed
}
enum CursorVisibility {
    static func valid(_ rect:CGRect)->Bool {CursorDisplayLayout.finiteRectangle(rect)}
    static func panelFrame(point:CGPoint,size:Double)->CGRect? {
        guard point.x.isFinite,point.y.isFinite,size.isFinite,(20...128).contains(size) else {return nil}
        // Derive CG top-left offsets from the same Cocoa-local point used by drawing.
        let offset=CursorDesign.cgHotspotFraction
        return CGRect(x:point.x-size*Double(offset.x),y:point.y-size*Double(offset.y),width:size,height:size)
    }
    // Keep the tip on the input point. Near an edge, first try a modest size
    // adjustment, then clip the drawing at the actual target window.
    static func drawingFrame(point:CGPoint,size:Double,inside frame:CGRect)->CGRect? {
        guard valid(frame),frame.contains(point),let preferred=panelFrame(point:point,size:size) else {return nil}
        if frame.contains(preferred) {return preferred}
        let h=CursorDesign.cgHotspotFraction
        let fit=min(size,(point.x-frame.minX)/h.x,(point.y-frame.minY)/h.y,
                    (frame.maxX-point.x)/(1-h.x),(frame.maxY-point.y)/(1-h.y))
        if fit>=max(20,min(32,size*0.75)) {return panelFrame(point:point,size:floor(fit))}
        return preferred
    }
    static func matching(_ lhs:CGRect,_ rhs:CGRect)->Bool {
        valid(lhs) && valid(rhs) && abs(lhs.minX-rhs.minX)<=0.5 && abs(lhs.minY-rhs.minY)<=0.5 && abs(lhs.width-rhs.width)<=0.5 && abs(lhs.height-rhs.height)<=0.5
    }
    // Screen-sized system surfaces can contain transparent regions. This test
    // identifies candidates only. Callers must still verify the actual AX hit.
    static func desktopSurface(_ w:CursorWindowGeometry, screens:[CGRect])->Bool {
        guard screens.contains(where:{matching(w.frame,$0)}) else {return false}
        guard let app=NSRunningApplication(processIdentifier:w.pid),let path=app.bundleURL?.standardizedFileURL.path else{return false}
        switch (app.bundleIdentifier,w.layer,path) {
        case ("com.apple.dock",Int(CGWindowLevelForKey(.dockWindow)),"/System/Library/CoreServices/Dock.app"),
             ("com.apple.screencaptureui",Int(CGWindowLevelForKey(.mainMenuWindow)),"/System/Library/CoreServices/screencaptureui.app"):
            return true
        default:return false
        }
    }
    // Keep an unobstructed rectangle containing the actual pointer tip.
    // Never enlarge the window or move the tip to get around an obstruction.
    static func visibleSlice(_ panel:CGRect, tip:CGPoint, blockers:[CGRect])->CGRect? {
        guard valid(panel), panel.contains(tip) else {return nil}
        var visible=panel
        for blocker in blockers {
            let cut=visible.intersection(blocker)
            if cut.isNull || cut.isEmpty {continue}
            if cut.contains(tip) {return nil}
            let a=visible
            let choices=[
                CGRect(x:a.minX,y:a.minY,width:cut.minX-a.minX-0.5,height:a.height),
                CGRect(x:cut.maxX+0.5,y:a.minY,width:a.maxX-cut.maxX-0.5,height:a.height),
                CGRect(x:a.minX,y:a.minY,width:a.width,height:cut.minY-a.minY-0.5),
                CGRect(x:a.minX,y:cut.maxY+0.5,width:a.width,height:a.maxY-cut.maxY-0.5)
            ]
            guard let largest=choices.filter({$0.size.width>0 && $0.size.height>0 && $0.contains(tip)})
                .max(by:{$0.width*$0.height<$1.width*$1.height}) else {return nil}
            visible=largest
        }
        return visible
    }
    static func denialReason(windows:[CursorWindowGeometry],pid:pid_t,windowID:CGWindowID,expectedFrame:CGRect,panel:CGRect,screens:[CGRect],overlayID:CGWindowID,overlayPID:pid_t)->String? {
        guard windowID>0,pid>0,valid(panel),valid(expectedFrame) else {return "invalid-target-geometry"}
        guard screens.contains(where:{valid($0) && $0.contains(panel)}) else {return "outside-display"}
        guard let index=windows.firstIndex(where:{$0.id==windowID}) else {return "target-not-listed"}
        let target=windows[index]
        guard target.pid==pid,target.onScreen,target.layer==0,target.alpha.isFinite,target.alpha>0,target.alpha<=1 else {return "target-not-visible"}
        guard matching(target.frame,expectedFrame) else {return "target-moved"}
        guard target.frame.contains(panel) else {return "outside-target"}
        for window in windows[..<index] {
            if window.id==overlayID && window.pid==overlayPID {continue}
            guard window.id>0,window.pid>0,valid(window.frame),window.alpha.isFinite,(0...1).contains(window.alpha),window.onScreen else {return "uncertain-window"}
            if window.alpha>0 && window.frame.intersects(panel) {return "target-occluded"}
        }
        return nil
    }
    static func permits(windows:[CursorWindowGeometry],pid:pid_t,windowID:CGWindowID,expectedFrame:CGRect,panel:CGRect,screens:[CGRect],overlayID:CGWindowID,overlayPID:pid_t)->Bool {
        denialReason(windows:windows,pid:pid,windowID:windowID,expectedFrame:expectedFrame,panel:panel,screens:screens,overlayID:overlayID,overlayPID:overlayPID)==nil
    }

}
func cursorVisibilitySelfTest() throws -> Int {
    var passed=0
    func expect(_ value:Bool,_ label:String) throws {guard value else {throw NativeError("self_test_failed","cursor policy: \(label)")};passed+=1}
    let frame=CGRect(x:100,y:100,width:600,height:500)
    let panel=CGRect(x:200,y:200,width:48,height:48)
    let screen=CGRect(x:0,y:0,width:1440,height:900)
    let tip=CGPoint(x:204,y:204)
    try expect(CursorVisibility.visibleSlice(panel,tip:tip,blockers:[panel])==nil,"covered tip hides")
    let cornerFit=CursorVisibility.drawingFrame(point:CGPoint(x:263,y:270),size:76,inside:CGRect(x:100,y:100,width:200,height:200))
    try expect(cornerFit.map{$0.width>=32 && $0.width<=33 && $0.maxY<=300}==true,"near-bottom fit keeps full readable artwork")
    let edge=CGRect(x:240,y:190,width:60,height:90)
    let partial=CursorVisibility.visibleSlice(panel,tip:tip,blockers:[edge])
    try expect(partial.map{$0.contains(tip) && !$0.intersects(edge) && $0.width<panel.width}==true,"only the visible part is retained")
    try expect(CursorVisibility.visibleSlice(panel,tip:tip,blockers:[])==panel,"unobscured sprite unchanged")

    func window(_ id:CGWindowID=7,_ pid:pid_t=42,_ rect:CGRect?=nil,_ visible:Bool=true,_ alpha:Double=1,_ layer:Int=0)->CursorWindowGeometry {
        CursorWindowGeometry(id:id,pid:pid,frame:rect ?? frame,onScreen:visible,alpha:alpha,layer:layer)
    }
    let edgePoint=CGPoint(x:150,y:544)
    let fitted=CursorVisibility.drawingFrame(point:edgePoint,size:76,inside:frame)
    try expect(fitted.map{frame.contains($0) && $0.width>=57 && abs($0.minY+$0.height*0.08-edgePoint.y)<0.001}==true,"edge fit retains tip and readable artwork")
    let corner=CGPoint(x:699,y:599)
    let cropped=CursorVisibility.drawingFrame(point:corner,size:76,inside:frame)
    try expect(cropped.map{$0.width==76 && $0.intersection(frame).contains(corner)}==true,"corner clips artwork without moving the tip")
    let target=window()
    func allowed(_ windows:[CursorWindowGeometry],_ rect:CGRect?=nil,_ screens:[CGRect]?=nil,_ expected:CGRect?=nil)->Bool {
        CursorVisibility.permits(windows:windows,pid:42,windowID:7,expectedFrame:expected ?? frame,panel:rect ?? panel,screens:screens ?? [screen],overlayID:9,overlayPID:99)
    }
    try expect(allowed([target]),"background target needs no foreground identity")
    try expect(!allowed([window(8,43,panel),target]),"foreign covering window suppresses")
    try expect(allowed([window(8,43,CGRect(x:800,y:50,width:100,height:100)),target]),"nonoverlapping foreground is permitted")
    try expect(allowed([window(9,99,panel),target]),"only exact own overlay is excluded")
    try expect(!allowed([window(9,43,panel),target]),"same overlay ID with foreign PID not excluded")
    try expect(!allowed([window(8,99,panel),target]),"other helper window not excluded")
    try expect(!allowed([window(8,43,panel,true,1,25),target]),"higher-level blocker also suppresses")
    try expect(allowed([window(8,43,panel,true,0),target]),"known alpha-zero blocker does not cover")
    try expect(!allowed([window(8,43,panel,true,.nan),target]),"unknown alpha fails closed")
    try expect(!allowed([]),"missing target suppresses")
    try expect(!allowed([window(7,43)]),"PID mismatch suppresses")
    try expect(!allowed([window(7,42,CGRect(x:110,y:100,width:600,height:500))]),"moved frame invalidates point")
    try expect(!allowed([window(7,42,frame,false)]),"offscreen target suppresses")
    try expect(!allowed([window(7,42,frame,true,0)]),"transparent target suppresses")
    try expect(!allowed([window(7,42,frame,true,1,3)]),"never raise panel for floating target")
    try expect(!allowed([target],CGRect(x:690,y:200,width:48,height:48)),"whole panel must fit target bounds")
    try expect(!allowed([target],panel,[CGRect(x:0,y:0,width:220,height:900)]),"whole panel must fit a physical screen")
    let left=CGRect(x:-1000,y:-600,width:900,height:550)
    let negative=CGRect(x:-800,y:-400,width:48,height:48)
    try expect(allowed([window(7,42,left)],negative,[CGRect(x:-1200,y:-800,width:1200,height:800)],left),"negative display coordinates supported")
    try expect(!allowed([target],panel,[CGRect(x:0,y:0,width:220,height:900),CGRect(x:230,y:0,width:1210,height:900)]),"screen gap and cross-screen panels suppress")
    try expect(CursorVisibility.panelFrame(point:CGPoint(x:100,y:200),size:100)==CGRect(x:92,y:192,width:100,height:100),"anchor agrees in CG top-left coordinates")
    try expect(CursorVisibility.panelFrame(point:CGPoint(x:100,y:200),size:19)==nil,"undersized cursor rejected")
    try expect(CursorVisibility.panelFrame(point:CGPoint(x:100,y:200),size:129)==nil,"oversized cursor rejected")
    try expect(CursorVisibility.panelFrame(point:CGPoint(x:100,y:200),size:.infinity)==nil,"nonfinite cursor size rejected")
    try expect(CursorVisibility.panelFrame(point:CGPoint(x:Double.nan,y:200),size:48)==nil,"nonfinite point rejected")
    try expect(!CursorVisibility.valid(CGRect(x:0,y:0,width:0,height:40)),"zero-area bounds rejected")
    try expect(!allowed([target],panel,[CGRect(x:Double.nan,y:0,width:1440,height:900)]),"malformed screen rejected")
    try expect(allowed([target,window(8,43,panel)]),"window below target cannot occlude")
    try expect(!allowed([window(8,43,panel,false),target]),"inconsistent onscreen evidence fails closed")
    try expect(!allowed([window(8,43,panel,true,1.1),target]),"out-of-range alpha fails closed")
    try expect(!allowed([target],panel,[screen],CGRect(x:100,y:100,width:601,height:500)),"resized snapshot invalidated")
    return passed
}
// Pure ownership bookkeeping shared by the real panel and early self-tests.
enum CursorPresentationOwner:Equatable { case action(UUID),preview }
struct CursorPresentationToken:Equatable {
    let id:UUID
    let owner:CursorPresentationOwner
}
struct CursorPresentationLifecycle {
    private(set) var current:CursorPresentationToken?
    @discardableResult mutating func begin(_ owner:CursorPresentationOwner)->CursorPresentationToken {
        let token=CursorPresentationToken(id:UUID(),owner:owner);current=token;return token
    }
    mutating func clear() {current=nil}
    func acceptsCompletion(_ actionID:UUID)->Bool {
        guard let current else {return false};return current.owner == .action(actionID)
    }
    func acceptsHide(_ token:CursorPresentationToken)->Bool {current==token}
}
func cursorLifecycleSelfTest() throws -> Int {
    var passed=0
    func expect(_ value:Bool,_ label:String) throws {guard value else {throw NativeError("self_test_failed","cursor lifecycle: \(label)")};passed+=1}
    var lifecycle=CursorPresentationLifecycle()
    let a=UUID(),b=UUID()
    try expect(lifecycle.current==nil,"initially absent")
    try expect(!lifecycle.acceptsCompletion(a),"hidden has no completion owner")
    let first=lifecycle.begin(.action(a))
    try expect(lifecycle.current?.owner == .action(a),"action owns its presentation")
    try expect(lifecycle.acceptsCompletion(a),"current action may settle")
    try expect(!lifecycle.acceptsCompletion(b),"foreign action may not settle")
    try expect(lifecycle.acceptsHide(first),"current timer accepted")
    let moved=lifecycle.begin(.action(a))
    try expect(moved != first,"same-action move has fresh display token")
    try expect(!lifecycle.acceptsHide(first),"old step timer cannot hide new step")
    try expect(lifecycle.acceptsHide(moved),"current step timer accepted")
    try expect(lifecycle.acceptsCompletion(a),"action completion follows its drag steps")
    let next=lifecycle.begin(.action(b))
    try expect(!lifecycle.acceptsCompletion(a),"old completion cannot settle next action")
    try expect(lifecycle.acceptsCompletion(b),"next action may settle itself")
    try expect(!lifecycle.acceptsHide(moved),"old action timer cannot hide next action")
    let preview=lifecycle.begin(.preview)
    try expect(!lifecycle.acceptsCompletion(b),"action completion cannot settle preview")
    try expect(lifecycle.current?.owner == .preview,"explicit preview has distinct ownership")
    try expect(lifecycle.acceptsHide(preview),"preview timer accepted")
    lifecycle.clear()
    try expect(lifecycle.current==nil,"clear removes ownership")
    try expect(!lifecycle.acceptsHide(preview),"clear invalidates preview timer")
    try expect(!lifecycle.acceptsCompletion(a),"clear rejects action completion")
    let resumed=lifecycle.begin(.action(a))
    try expect(!lifecycle.acceptsHide(first),"reused action ID never revives an old timer")
    try expect(lifecycle.acceptsHide(resumed),"fresh post-clear presentation accepted")
    let freshPreview=lifecycle.begin(.preview)
    try expect(freshPreview != preview,"preview replay gets fresh token")
    var other=CursorPresentationLifecycle();other.begin(.action(b))
    try expect(!other.acceptsHide(next),"tokens are isolated between lifecycle instances")
    lifecycle.clear();lifecycle.clear()
    try expect(lifecycle.current==nil,"repeated clear is idempotent")
    return passed
}
// Completion control flow only: no AppKit operations or desktop/window observations.
// All effects (including validity checks) stay behind the current-owner guard.
enum CursorCompletion {
    static func execute(ownsCompletion:()->Bool,valid:()->Bool,hide:()->Void,idle:()->Void,mode:()->String,holdMilliseconds:()->Double,scheduleHide:(Double)->Void) {
        guard ownsCompletion() else {return}
        guard valid() else {hide();return}
        idle()
        if mode()=="clean" {scheduleHide(holdMilliseconds()/1000)}
    }
}
func cursorCompletionSelfTest() throws -> Int {
    var passed=0
    func expect(_ value:Bool,_ label:String) throws {guard value else {throw NativeError("self_test_failed","cursor completion: \(label)")};passed+=1}
    var lifecycle=CursorPresentationLifecycle()
    let a=UUID(),b=UUID()
    // Closure spies exercise the production executor, not a real panel or desktop.
    var effects:[String]=[],scheduled:[Double]=[]
    func complete(_ actionID:UUID,hasTarget:Bool=true,allowed:Bool=true,mode:String="clean",holdMs:Double=1200) {
        effects=[];scheduled=[]
        CursorCompletion.execute(
            ownsCompletion:{effects.append("owner");return lifecycle.acceptsCompletion(actionID)},
            valid:{effects.append("valid");guard hasTarget else {return false};effects.append("allowed");return allowed},
            hide:{effects.append("hide")},
            idle:{effects.append("idle")},
            mode:{effects.append("mode");return mode},
            holdMilliseconds:{effects.append("hold");return holdMs},
            scheduleHide:{effects.append("schedule");scheduled.append($0)})
    }
    lifecycle.begin(.action(b))
    complete(a)
    try expect(effects==["owner"],"old action cannot check validity, hide, idle or schedule")
    try expect(scheduled.isEmpty,"old action schedules nothing")
    lifecycle.begin(.preview)
    complete(b)
    try expect(effects==["owner"],"action completion cannot touch a preview")
    try expect(scheduled.isEmpty,"preview ownership schedules nothing on action completion")
    lifecycle.clear()
    complete(a)
    try expect(effects==["owner"],"absent owner returns before validity or effects")
    try expect(scheduled.isEmpty,"absent owner schedules nothing")
    lifecycle.begin(.action(a))
    complete(a,hasTarget:false)
    try expect(effects==["owner","valid","hide"],"missing target hides without calling stillAllowed or idling")
    try expect(scheduled.isEmpty,"missing target does not schedule")
    complete(a,allowed:false)
    try expect(effects==["owner","valid","allowed","hide"],"cancelled target hides before idle or mode lookup")
    try expect(scheduled.isEmpty,"cancelled target does not schedule")
    complete(a)
    try expect(effects==["owner","valid","allowed","idle","mode","hold","schedule"],"clean completion preserves validity, idle, hold ordering")
    try expect(scheduled==[1.2],"default clean hold remains milliseconds converted to seconds")
    complete(a,holdMs:3500)
    try expect(effects==["owner","valid","allowed","idle","mode","hold","schedule"],"custom clean hold follows the same effect order")
    try expect(scheduled==[3.5],"configured clean hold reaches scheduler unchanged in seconds")
    complete(a,mode:"companion")
    try expect(effects==["owner","valid","allowed","idle","mode"],"companion idles without hiding or scheduling")
    try expect(scheduled.isEmpty,"companion schedules no hide")
    complete(a,mode:"hidden")
    try expect(effects==["owner","valid","allowed","idle","mode"],"executor adds no new hidden-mode behavior")
    try expect(scheduled.isEmpty,"non-clean hidden mode schedules no hide")
    let firstPreview=lifecycle.begin(.preview)
    let nextPreview=lifecycle.begin(.preview)
    try expect(!lifecycle.acceptsHide(firstPreview),"direct preview replay rejects the previous preview timer")
    try expect(lifecycle.acceptsHide(nextPreview),"direct preview replay retains its own timer")
    let nextAction=lifecycle.begin(.action(b))
    try expect(!lifecycle.acceptsHide(nextPreview),"direct preview-to-action rejects the preview timer")
    try expect(lifecycle.acceptsHide(nextAction),"direct preview-to-action retains its action timer")
    complete(a)
    try expect(effects==["owner"] && scheduled.isEmpty,"old completion cannot affect the action replacing a preview")
    complete(b)
    try expect(effects==["owner","valid","allowed","idle","mode","hold","schedule"] && scheduled==[1.2],"current replacement action can complete normally")
    return passed
}
// Shared refresh decisions only; AppKit/metadata access remains injected by WhaleOverlay.
// More cheap checks narrow stale effects; they cannot make sampling/ordering atomic.
enum CursorRefreshCycle {
    @discardableResult static func execute(ownsPresentation:()->Bool,stillAllowed:()->Bool,sample:()->[CursorWindowGeometry]?,permitted:([CursorWindowGeometry])->Bool,containsOverlay:([CursorWindowGeometry])->Bool,isVisible:()->Bool,position:()->Void,order:()->Void,suppress:()->Void,invalidate:()->Void)->Bool {
        func proceed()->Bool {
            guard ownsPresentation() else {return false}
            guard stillAllowed() else {if ownsPresentation() {invalidate()};return false}
            return ownsPresentation()
        }
        guard proceed() else {return false}
        guard let before=sample(),permitted(before) else {if proceed() {suppress()};return false}
        guard proceed() else {return false}
        position()
        if !isVisible() || !containsOverlay(before) {
            guard proceed() else {return false}
            order()
            guard proceed() else {return false}
            guard let after=sample(),permitted(after),containsOverlay(after) else {if proceed() {suppress()};return false}
        }
        return proceed()
    }
}
func cursorRefreshSelfTest() throws -> Int {
    var passed=0
    func expect(_ value:Bool,_ label:String) throws {guard value else {throw NativeError("self_test_failed","cursor refresh: \(label)")};passed+=1}
    let frame=CGRect(x:100,y:100,width:600,height:500),panel=CGRect(x:200,y:200,width:48,height:48),screen=CGRect(x:0,y:0,width:1440,height:900)
    let target=CursorWindowGeometry(id:7,pid:42,frame:frame,onScreen:true,alpha:1,layer:0)
    let own=CursorWindowGeometry(id:9,pid:99,frame:panel,onScreen:true,alpha:1,layer:0)
    let blocker=CursorWindowGeometry(id:8,pid:43,frame:panel,onScreen:true,alpha:1,layer:0)
    var lifecycle=CursorPresentationLifecycle()
    var token:CursorPresentationToken?
    var effects:[String]=[],queries=0,allowedChecks=0
    var replacement:CursorPresentationToken?
    var ready=false
    func run(before:[CursorWindowGeometry]?,after:[CursorWindowGeometry]?=nil,visible:Bool=false,allowedInitially:Bool=true,ownerInitially:Bool=true,changeAt:String?=nil,replaceOwner:Bool=false,reset:Bool=true) {
        if reset {lifecycle.clear();token=lifecycle.begin(.action(UUID()))}
        effects=[];queries=0;allowedChecks=0;replacement=nil
        var allowed=allowedInitially
        if !ownerInitially {replacement=lifecycle.begin(.preview)}
        func change(_ stage:String) {
            guard changeAt==stage else {return}
            if replaceOwner {replacement=lifecycle.begin(.preview)} else {allowed=false}
        }
        ready=CursorRefreshCycle.execute(
            ownsPresentation:{guard let token else {return false};return lifecycle.acceptsHide(token)},
            stillAllowed:{allowedChecks+=1;change("allowed");return allowed},
            sample:{queries+=1;change("sample\(queries)");return queries==1 ? before : after},
            permitted:{CursorVisibility.permits(windows:$0,pid:42,windowID:7,expectedFrame:frame,panel:panel,screens:[screen],overlayID:9,overlayPID:99)},
            containsOverlay:{$0.contains(where:{$0.id==9 && $0.pid==99})},
            isVisible:{visible},
            position:{effects.append("position");change("position")},
            order:{effects.append("order");change("order")},
            suppress:{effects.append("suppress")},
            invalidate:{effects.append("invalidate");lifecycle.clear()})
    }
    run(before:[target],ownerInitially:false)
    try expect(effects.isEmpty && queries==0 && allowedChecks==0,"stale owner does not query validity or metadata or mutate")
    try expect(lifecycle.current==replacement,"stale refresh preserves replacement owner")
    run(before:[target],allowedInitially:false)
    try expect(effects==["invalidate"] && queries==0,"initial cancellation invalidates before metadata")
    try expect(lifecycle.current==nil,"invalidation clears mocked presentation ownership")
    run(before:nil)
    try expect(effects==["suppress"] && queries==1,"missing metadata suppresses without positioning")
    try expect(lifecycle.current==token,"missing metadata retains owner for a later conservative retry")
    run(before:[blocker,target])
    try expect(effects==["suppress"] && queries==1,"occlusion suppresses without positioning or ordering")
    try expect(lifecycle.current==token,"occlusion retains the same presentation owner")
    run(before:[own,target],visible:true)
    try expect(effects==["position"] && queries==1,"already-visible valid overlay avoids reordering and a second metadata query")
    try expect(lifecycle.current==token && allowedChecks>=3,"already-visible path rechecks validity through the end")
    run(before:[target],after:[own,target])
    try expect(effects==["position","order"] && queries==2,"new display orders and verifies a second sample")
    try expect(lifecycle.current==token,"successful ordering retains ownership")
    run(before:[target])
    try expect(effects==["position","order","suppress"] && queries==2,"missing post-order metadata suppresses")
    try expect(lifecycle.current==token,"post-order sample failure may conservatively retry later")
    run(before:[target],after:[blocker,own,target])
    try expect(effects==["position","order","suppress"] && queries==2,"post-order occlusion suppresses")
    try expect(lifecycle.current==token,"post-order occlusion does not invalidate a still-authorized target")
    run(before:[target],after:[target])
    try expect(effects==["position","order","suppress"] && queries==2,"post-order sample must actually include this overlay")
    try expect(lifecycle.current==token,"absent overlay suppresses rather than silently succeeding")
    run(before:[own,target],visible:true,changeAt:"sample1")
    try expect(effects==["invalidate"] && queries==1,"cancellation during metadata stops before origin mutation even when visible")
    try expect(lifecycle.current==nil,"metadata-time cancellation clears ownership")
    run(before:[own,target],visible:true,changeAt:"position")
    try expect(effects==["position","invalidate"] && queries==1,"visible fast path checks cancellation after positioning")
    try expect(lifecycle.current==nil,"visible fast-path cancellation does not retain target ownership")
    run(before:[target],after:[own,target],changeAt:"position")
    try expect(effects==["position","invalidate"] && queries==1,"cancellation after positioning stops before ordering")
    try expect(lifecycle.current==nil,"pre-order cancellation invalidates instead of showing")
    run(before:[target],after:[own,target],changeAt:"order")
    try expect(effects==["position","order","invalidate"] && queries==1,"order-time cancellation avoids a further metadata query")
    try expect(lifecycle.current==nil,"order-time cancellation invalidates rather than merely suppressing")
    run(before:[target],after:[own,target],changeAt:"sample2")
    try expect(effects==["position","order","invalidate"] && queries==2,"post-order metadata cancellation is rechecked at completion")
    try expect(lifecycle.current==nil,"post-order cancellation clears ownership")
    for stage in ["sample1","position","order","sample2","allowed"] {
        run(before:[target],after:[own,target],changeAt:stage,replaceOwner:true)
        let expected=stage=="position" ? ["position"] : ["order","sample2"].contains(stage) ? ["position","order"] : []
        let expectedQueries=stage=="allowed" ? 0 : stage=="sample2" ? 2 : 1
        try expect(effects==expected && queries==expectedQueries,"owner replacement at \(stage) stops all later effects and metadata")
        try expect(lifecycle.current==replacement,"owner replacement at \(stage) is never hidden by the old refresh")
    }
    run(before:[blocker,target])
    let occludedToken=token
    run(before:[target],after:[own,target],reset:false)
    try expect(effects==["position","order"] && queries==2,"next cycle can conservatively restore the same target after occlusion")
    try expect(lifecycle.current==occludedToken,"occlusion recovery does not create or transfer presentation ownership")
    run(before:[target],after:[own,target]);try expect(ready,"verified post-order metadata permits reveal")
    run(before:[target],after:[target]);try expect(!ready,"missing window-server panel stays transparent")
    run(before:[own,target],visible:true,changeAt:"position");try expect(!ready,"cancelled positioning cannot reveal")
    run(before:[own,target],visible:true);try expect(ready,"current visible geometry can remain revealed")
    run(before:nil);try expect(!ready,"unknown metadata cannot reveal")
    return passed
}
private final class CursorPanel:NSPanel {
    override var canBecomeKey:Bool {false}
    override var canBecomeMain:Bool {false}
}

final class WhaleOverlay {
    private let panel:CursorPanel
    private let whale=WhaleView(frame:NSRect(x:0,y:0,width:28,height:28))
    private let clipView=NSView(frame:NSRect(x:0,y:0,width:28,height:28))
    private var configuration=CursorConfiguration()
    private var mode:String {configuration.mode}
    private var size:Double {configuration.size}
    private var holdMs:Double {configuration.holdMs}
    private struct Target {
        let pid:pid_t
        let bundle:String
        let processStart:ProcessStartIdentity
        let windowID:CGWindowID
        let frame:CGRect
        let panelFrame:CGRect
        let originalPoint:CGPoint
        let livePoint:(()->CGPoint?)?
        let hitBelongsToWindow:(CGPoint)->Bool
        let stillAllowed:()->Bool
    }
    private var target:Target?
    private var hideWork:DispatchWorkItem?
    private var lifecycle=CursorPresentationLifecycle()
    private var timer:Timer?
    private var workspaceObservers:[NSObjectProtocol]=[]
    private var screenObserver:NSObjectProtocol?
    private var lastCheck="not-presented"
    var diagnostics:[String:Any] {["visible":panel.isVisible && panel.alphaValue>0,"size":size,"phase":whale.phase,"lastCheck":lastCheck]}
    init() {
        panel=CursorPanel(contentRect:NSRect(x:0,y:0,width:28,height:28),styleMask:[.borderless,.nonactivatingPanel],backing:.buffered,defer:false)
        panel.isOpaque=false;panel.alphaValue=0;panel.backgroundColor = .clear;panel.hasShadow=false;panel.ignoresMouseEvents=true;panel.hidesOnDeactivate=false
        // Do not float over unrelated foreground windows or join another Space.
        panel.level = .normal;panel.collectionBehavior=[.transient,.ignoresCycle]
        panel.animationBehavior = .none
        clipView.wantsLayer=true;clipView.layer?.masksToBounds=true
        clipView.addSubview(whale);panel.contentView=clipView;panel.isExcludedFromWindowsMenu=true
        let tick=Timer(timeInterval:0.08,repeats:true) { [weak self] _ in self?.refresh() }
        timer=tick;RunLoop.main.add(tick,forMode:.common)
        let center=NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.activeSpaceDidChangeNotification,NSWorkspace.sessionDidResignActiveNotification,NSWorkspace.screensDidSleepNotification] {
            workspaceObservers.append(center.addObserver(forName:name,object:nil,queue:.main) { [weak self] _ in self?.hide() })
        }
        workspaceObservers.append(center.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:.main) { [weak self] _ in
            // Invalidate the displayed sample now; a later tick may conservatively revalidate.
            self?.panel.orderOut(nil);self?.whale.presentationVisible=false
        })
        screenObserver=NotificationCenter.default.addObserver(forName:NSApplication.didChangeScreenParametersNotification,object:nil,queue:.main) { [weak self] _ in self?.hide() }
    }
    // Reads only geometry/identity/visibility fields; never reads kCGWindowName,
    // persists raw dictionaries, captures pixels or requests any permissions.
    private func windowGeometry(until windowID:CGWindowID)->[CursorWindowGeometry]? {
        guard let raw=CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements],kCGNullWindowID) as? [[String:Any]] else {return nil}
        return CursorWindowMetadata.decode(raw,until:windowID)
    }
    private func refresh() {
        // Target-free explicit preview is not an action refresh and keeps its own timer.
        guard let target else {return}
        guard let token=lifecycle.current else {hide();return}
        guard target.stillAllowed() else {hide();return}
        guard let app=NSRunningApplication(processIdentifier:target.pid),!app.isTerminated,!app.isHidden,
              let started=processStartIdentity(for:app),
              app.bundleIdentifier==target.bundle || applicationOwningWindow(target.windowID,bundle:target.bundle) != nil else {
            panel.orderOut(nil);whale.presentationVisible=false;lastCheck="owner-unavailable";return
        }
        guard started==target.processStart else {hide();return}
        // Capture frame values once; conversion and position use this same layout.
        // This does not make OS queries or subsequent WindowServer operations atomic.
        let screenFrames=NSScreen.screens.map {$0.frame}
        guard let layout=CursorDisplayLayout(cocoaScreenFrames:screenFrames),
              let origin=layout.cocoaOrigin(forCGPanel:target.panelFrame) else {
            if lifecycle.acceptsHide(token) {hide()};return
        }
        let screens=layout.cgScreenFrames
        let ownPID=ProcessInfo.processInfo.processIdentifier
        // AppKit windowNumber and WindowServer CGWindowID are distinct namespaces.
        // This helper owns one normal-level panel; refuse ambiguous ownership.
        func ownIdentifier(_ windows:[CursorWindowGeometry])->CGWindowID? {
            let own=windows.filter{$0.pid==ownPID && $0.layer==0}
            return own.count==1 ? own[0].id : nil
        }
        if mode == "companion" {
            func suppress(_ reason:String) {
                panel.orderOut(nil);whale.presentationVisible=false;lastCheck=reason
            }
            guard let windows=windowGeometry(until:target.windowID),let live=windows.last,
                  live.id==target.windowID,live.pid==target.pid else {suppress("target-not-listed");return}
            let point:CGPoint
            if let resolve=target.livePoint {
                guard let value=resolve() else {suppress("control-not-visible");return}
                point=value
            } else {
                guard CursorVisibility.matching(live.frame,target.frame) else {suppress("target-moved");return}
                point=target.originalPoint
            }
            guard let drawing=CursorVisibility.drawingFrame(point:point,size:size,inside:live.frame),
                  let screen=screens.first(where:{$0.contains(point)}) else {suppress("outside-target");return}
            let preferred=drawing.intersection(live.frame).intersection(screen)
            let own=windows.filter{$0.pid==ownPID && $0.layer==Int(NSWindow.Level.floating.rawValue)}
            let overlayID=own.count==1 ? own[0].id : 0
            let desktopIDs=Set(windows.dropLast().filter{CursorVisibility.desktopSurface($0,screens:screens)}.map{$0.id})
            let filtered = !desktopIDs.isEmpty && target.hitBelongsToWindow(point)
                ? windows.filter{!desktopIDs.contains($0.id)} : windows
            let blockers=filtered.dropLast().filter{w in
                w.alpha>0 && !(w.pid==ownPID && w.id==overlayID)
            }.map{$0.frame}
            guard let clip=CursorVisibility.visibleSlice(preferred,tip:point,blockers:blockers) else {suppress("target-occluded");return}
            if let reason=CursorVisibility.denialReason(windows:filtered,pid:target.pid,windowID:target.windowID,expectedFrame:live.frame,panel:clip,screens:screens,overlayID:overlayID,overlayPID:ownPID){suppress(reason);return}
            guard let position=layout.cocoaOrigin(forCGPanel:clip),lifecycle.acceptsHide(token),target.stillAllowed() else {hide();return}
            panel.level = .floating
            setDrawing(size:clip.size,origin:CGPoint(x:drawing.minX-clip.minX,y:clip.maxY-drawing.maxY),extent:drawing.width)
            if panel.frame.origin != position {panel.setFrameOrigin(position)}
            panel.alphaValue=1
            if !panel.isVisible {panel.orderFrontRegardless()}
            whale.presentationVisible=panel.isVisible
            lastCheck=clip==preferred ? "companion-at-target":"companion-partially-visible"
            return
        }
        var orderedThisCycle=false,sawMetadata=false
        var denial="metadata-unavailable"
        let verified=CursorRefreshCycle.execute(
            ownsPresentation:{self.lifecycle.acceptsHide(token)},
            stillAllowed:target.stillAllowed,
            sample:{let sample=self.windowGeometry(until:target.windowID);sawMetadata = sample != nil;return sample},
            permitted:{let reason=CursorVisibility.denialReason(windows:$0,pid:target.pid,windowID:target.windowID,expectedFrame:target.frame,panel:target.panelFrame,screens:screens,overlayID:ownIdentifier($0) ?? 0,overlayPID:ownPID);denial=reason ?? "geometry-verified";return reason==nil},
            containsOverlay:{windows in
                guard let id=ownIdentifier(windows) else {return false}
                return windows.contains{$0.id==id && $0.onScreen && CursorVisibility.matching($0.frame,target.panelFrame)}
            },
            isVisible:{self.panel.isVisible},
            position:{self.panel.setFrameOrigin(origin)},
            // Stage invisibly at normal level, never a floating/always-top level.
            order:{
                self.panel.alphaValue=0;orderedThisCycle=true
                self.panel.orderFrontRegardless()
            },
            suppress:{
                self.panel.alphaValue=0;self.whale.presentationVisible=false
                if !orderedThisCycle {self.panel.orderOut(nil)}
            },
            invalidate:{self.hide()})
        guard lifecycle.acceptsHide(token) else {return}
        guard target.stillAllowed() else {hide();return}
        if verified {
            panel.alphaValue=1
            guard lifecycle.acceptsHide(token) else {return}
            guard target.stillAllowed() else {hide();return}
            lastCheck="verified-visible-region"
        } else {lastCheck=orderedThisCycle ? "awaiting-window-server" : (sawMetadata ? denial : "metadata-unavailable")}
        whale.presentationVisible=verified && panel.isVisible && panel.alphaValue>0

    }
    func changeArtwork(_ key:String) throws {
        _ = try configuration.apply(["variant":key]); whale.artwork=configuration.variant
    }
    func configure(_ p:[String:Any]) throws -> [String:Any] {
        // A resize invalidates the previously checked panel rectangle.
        hide()
        let result=try configuration.apply(p)
        // Both real dimensions come from the same fully validated committed value.
        let acceptedSize=configuration.size
        panel.level = mode == "companion" ? .floating : .normal
        whale.artwork=configuration.variant
        whale.reducedMotion=configuration.reducedMotion
        setDrawing(size:NSSize(width:acceptedSize,height:acceptedSize),origin:.zero,extent:acceptedSize)
        if mode=="hidden" {hide()}
        return result
    }
    private func setDrawing(size:NSSize,origin:CGPoint,extent:CGFloat) {
        if clipView.bounds.size != size {panel.setContentSize(size)}
        whale.frame=NSRect(origin:origin,size:NSSize(width:extent,height:extent))
    }
    func show(point:CGPoint,state:String,actionID:UUID,pid:pid_t,bundle:String,processStart:ProcessStartIdentity?,windowID:CGWindowID,frame:CGRect,livePoint:(()->CGPoint?)?,hitBelongsToWindow:@escaping (CGPoint)->Bool,stillAllowed:@escaping ()->Bool) {
        hide()
        guard mode != "hidden" else {lastCheck="mode-hidden";return}
        guard let processStart else {lastCheck="process-identity-unavailable";return}
        guard let drawing=CursorVisibility.drawingFrame(point:point,size:size,inside:frame) else {lastCheck="invalid-geometry";return}
        let bounds=drawing.intersection(frame)
        guard CursorVisibility.valid(bounds) else {lastCheck="outside-target";return}
        setDrawing(size:bounds.size,origin:CGPoint(x:drawing.minX-bounds.minX,y:bounds.maxY-drawing.maxY),extent:drawing.width)
        guard stillAllowed() else {lastCheck="cancelled";return}
        lifecycle.begin(.action(actionID))
        target=Target(pid:pid,bundle:bundle,processStart:processStart,windowID:windowID,frame:frame,panelFrame:bounds,originalPoint:point,livePoint:livePoint,hitBelongsToWindow:hitBelongsToWindow,stillAllowed:stillAllowed)
        whale.phase=state;whale.needsDisplay=true;refresh()
    }
    func browserActivity(check:() throws -> Void) throws {
        try check();hide()
    }
    func preview(check:() throws -> Void) throws {
        try check()
        let previous=lifecycle.current
        let screen=NSScreen.main
        try check()
        guard lifecycle.current==previous else {throw NativeError("cancelled","Preview ownership changed before setup")}
        hide()
        try check()
        guard lifecycle.current==nil else {throw NativeError("cancelled","A newer presentation replaced preview setup")}
        guard let screen else {return}
        // Explicit user preview only: not an action position or target visibility claim.
        let token=lifecycle.begin(.preview)
        func validate() throws {
            try check()
            guard lifecycle.acceptsHide(token) else {throw NativeError("cancelled","Preview presentation was invalidated")}
        }
        do {
            setDrawing(size:NSSize(width:size,height:size),origin:.zero,extent:size)
            whale.phase="idle";whale.needsDisplay=true
            let frame=screen.visibleFrame
            try validate()
            panel.setFrameOrigin(NSPoint(x:frame.midX,y:frame.midY))
            try validate()
            panel.alphaValue=1;lastCheck="appearance-preview"
            panel.orderFrontRegardless()
            whale.presentationVisible=panel.isVisible
            try validate()
            scheduleHide(after:2)
        } catch {
            // AppKit may reenter a pause/hide while ordering. If that cleared our
            // token, suppress a late order too; never hide a different new owner.
            // Post-order cleanup is not a zero-frame/WindowServer atomicity proof.
            if lifecycle.acceptsHide(token) || lifecycle.current==nil {hide()}
            throw error
        }
    }
    private func scheduleHide(after seconds:Double) {
        hideWork?.cancel()
        guard let token=lifecycle.current else {return}
        let work=DispatchWorkItem { [weak self] in guard let self,self.lifecycle.acceptsHide(token) else {return};self.hide() }
        hideWork=work;DispatchQueue.main.asyncAfter(deadline:.now()+seconds,execute:work)
    }
    func settle(actionID:UUID) {
        // Queue ordering is not the authority for completion ownership.
        CursorCompletion.execute(
            ownsCompletion:{self.lifecycle.acceptsCompletion(actionID)},
            valid:{guard let target=self.target else {return false};return target.stillAllowed()},
            hide:{self.hide()},
            idle:{self.whale.phase="idle";self.whale.needsDisplay=true},
            mode:{self.mode},
            holdMilliseconds:{self.holdMs},
            scheduleHide:{self.scheduleHide(after:$0)})
    }
    func paused() {whale.phase="paused";whale.needsDisplay=true;hide()}
    func hide() {lifecycle.clear();hideWork?.cancel();hideWork=nil;panel.alphaValue=0;panel.orderOut(nil);whale.presentationVisible=false;target=nil;lastCheck="hidden"}
    deinit {
        timer?.invalidate()
        for observer in workspaceObservers {NSWorkspace.shared.notificationCenter.removeObserver(observer)}
        if let screenObserver {NotificationCenter.default.removeObserver(screenObserver)}
    }
}
