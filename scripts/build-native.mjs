import { mkdir, mkdtemp, realpath, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELPER_SOURCES, snapshotBuildInputs, verifyBuildInputs } from './native-build-inputs.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='darwin') throw new Error('Whale Computer native helper requires macOS');
const args=process.argv.slice(2);
if(args.some(arg=>arg!=='--candidate')||args.length>1)throw new Error('Usage: node scripts/build-native.mjs [--candidate]');
const candidate=args[0]==='--candidate';
let build=path.join(root,'native','build');
if(candidate){
  const native=path.join(root,'native');
  if(await realpath(native)!==path.join(await realpath(root),'native'))throw new Error('Candidate native directory must not redirect through a symlink');
  const candidates=path.join(native,'candidates');
  await mkdir(candidates,{recursive:true});
  if(await realpath(candidates)!==candidates)throw new Error('Candidate output must not redirect through a symlink');
  build=await mkdtemp(path.join(candidates,'cursor-'));
}
const inputs=candidate?await snapshotBuildInputs(path.join(root,'native'),build):null;
const inputPath=name=>inputs?inputs.paths[name]:path.join(root,'native',name);
const app=path.join(build,'Whale Computer.app');
const contents=path.join(app,'Contents');
await mkdir(path.join(contents,'MacOS'),{recursive:true});
await mkdir(path.join(contents,'Resources'),{recursive:true});
const cache=path.join(build,'module-cache');
await mkdir(cache,{recursive:true});
const env={...process.env,CLANG_MODULE_CACHE_PATH:cache,SWIFT_MODULECACHE_PATH:cache};
const deploymentTarget=process.arch==='arm64'?'arm64-apple-macosx14.0':'x86_64-apple-macosx14.0';
function run(command,args){
  const result=spawnSync(command,args,{cwd:root,env,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`${command} exited ${result.status}`);
}
run('/usr/bin/xcrun',['swiftc','-target',deploymentTarget,'-swift-version','5','-O','-module-cache-path',cache,
  '-framework','AppKit','-framework','ApplicationServices','-framework','ScreenCaptureKit','-framework','Vision','-framework','UniformTypeIdentifiers',
  ...HELPER_SOURCES.map(inputPath),
  '-o',path.join(contents,'MacOS','whale-helper')]);
await writeFile(path.join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.dsh.whale-computer.helper</string>
<key>CFBundleName</key><string>Computer Use Helper</string>
<key>CFBundleDisplayName</key><string>Computer Use Helper</string>
<key>CFBundleExecutable</key><string>whale-helper</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.4.1</string>
<key>CFBundleVersion</key><string>3</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Only explicitly authorized target-window screenshots are captured for your requested task.</string>
<key>NSAccessibilityUsageDescription</key><string>Observe and control only applications explicitly approved for your task.</string>
</dict></plist>\n`);
for (const file of ['cursor-whale.png','cursor-whale-large.png']) await copyFile(inputPath(file),path.join(contents,'Resources',file));
await copyFile(inputPath('THIRD_PARTY_NOTICES.md'),path.join(contents,'Resources','THIRD_PARTY_NOTICES.md'));
run('/usr/bin/codesign',['--force','--sign','-','--identifier','local.dsh.whale-computer.helper',app]);
const fixtureContents=path.join(build,'Computer Use Fixture.app','Contents');
await mkdir(path.join(fixtureContents,'MacOS'),{recursive:true});
run('/usr/bin/xcrun',['swiftc','-target',deploymentTarget,'-swift-version','5','-O','-module-cache-path',cache,'-framework','AppKit',inputPath('fixture/main.swift'),'-o',path.join(fixtureContents,'MacOS','computer-use-fixture')]);
await writeFile(path.join(fixtureContents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.dsh.computer-use.fixture</string><key>CFBundleName</key><string>Computer Use Fixture</string><key>CFBundleExecutable</key><string>computer-use-fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/></dict></plist>\n`);
run('/usr/bin/codesign',['--force','--sign','-','--identifier','local.dsh.computer-use.fixture',path.dirname(fixtureContents)]);
if(candidate){
  await verifyBuildInputs(inputs); // No successful report for missing/changed/redirected snapshots.
  const sourceHashes=Object.fromEntries(HELPER_SOURCES.map(name=>[name,inputs.hashes[name]]));
  const helper=path.join(contents,'MacOS','whale-helper');
  const inputSnapshot={directory:'Sources',hashAlgorithm:'sha256',files:inputs.hashes,verifiedAfterBuild:true,atomicSourceCheckout:false,hostileConcurrentMutationExcluded:false,binaryReproducibilityVerified:false};
  await writeFile(path.join(build,'build-report.json'),JSON.stringify({reportVersion:2,createdAt:new Date().toISOString(),mode:'isolated-cursor-candidate',deploymentTarget,helper,sourceHashOrigin:'frozen-candidate-inputs',sourceHashes,inputSnapshot,helperSha256:createHash('sha256').update(await readFile(helper)).digest('hex'),installed:false,guiActions:0,permissionRequests:0,empiricallyValidated:false},null,2)+'\n',{flag:'wx'});
  console.log(`Isolated candidate report: ${path.relative(root,path.join(build,'build-report.json'))}`);
}
console.log(`Built local ad-hoc signed helper: ${path.relative(root,app)}`);
console.log(`Built disposable fixture without launching: ${path.relative(root,path.dirname(fixtureContents))}`);
console.log('No installation, TCC prompt, target application launch, or desktop action performed.');
