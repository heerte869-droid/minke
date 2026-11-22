import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Coordinator } from '../lib/coordinator.js';
import { BUILD_INPUTS, HELPER_SOURCES, verifyBuildInputs } from '../scripts/native-build-inputs.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute=promisify(execFile);
const root=fileURLToPath(new URL('..',import.meta.url));
const candidate=process.env.COMPUTER_USE_CANDIDATE_HELPER;

async function explicitCandidate() {
  const project=await realpath(root);
  const candidateRoot=await realpath(path.join(project,'native/candidates'));
  assert.equal(candidateRoot,path.join(project,'native/candidates'),'Candidate root must not redirect');
  const binary=await realpath(candidate);
  assert.ok(binary.startsWith(candidateRoot+path.sep),'Candidate must resolve beneath the isolated candidate directory');
  assert.equal(path.basename(binary),'whale-helper');
  assert.ok((await stat(binary)).isFile());
  const directory=path.resolve(path.dirname(binary),'../../..');
  assert.equal(path.dirname(directory),candidateRoot);
  assert.ok(path.basename(directory).startsWith('cursor-'));
  assert.equal(binary,path.join(directory,'Whale Computer.app/Contents/MacOS/whale-helper'));
  const report=JSON.parse(await readFile(path.join(directory,'build-report.json'),'utf8'));
  assert.equal(report.reportVersion,2);
  assert.equal(report.helper,binary);
  assert.equal(createHash('sha256').update(await readFile(binary)).digest('hex'),report.helperSha256);
  assert.equal(report.installed,false);assert.equal(report.empiricallyValidated,false);
  return {binary,directory,report};
}

test('isolated candidate runs only explicit pure cursor-policy self-tests',{skip:!candidate||process.platform!=='darwin'},async()=>{
  const {binary}=await explicitCandidate();
  const {stdout,stderr}=await execute(binary,['--self-test'],{timeout:10000,maxBuffer:1024*1024});
  assert.equal(stderr,'');
  const {result}=JSON.parse(stdout);
  assert.ok(result.cursorPolicyAssertions>=30,'Must execute the new geometry/identity/occlusion cases, not the old installed binary');
  assert.ok(result.cursorLifecycleAssertions>=24,'Must execute current action/preview/late-hide ownership cases');
  assert.ok(Number.isSafeInteger(result.cursorCompletionAssertions)&&result.cursorCompletionAssertions>=24,'Must execute shared completion flow with spy effects, not only ownership bookkeeping');
  assert.ok(Number.isSafeInteger(result.cursorRefreshAssertions)&&result.cursorRefreshAssertions>=40,'Must execute shared refresh cancellation/ownership/occlusion flow, not an older candidate');
  assert.ok(Number.isSafeInteger(result.cursorConfigurationAssertions)&&result.cursorConfigurationAssertions>=48,'Must execute shared all-or-nothing configuration validation, not an older candidate');
  assert.ok(Number.isSafeInteger(result.cursorLayoutAssertions)&&result.cursorLayoutAssertions>=36,'Must execute shared design/layout coordinate cases, not an older candidate');
  assert.ok(Number.isSafeInteger(result.cursorMetadataAssertions)&&result.cursorMetadataAssertions>=52,'Must execute the production-shared strict metadata decoder and raw-rectangle cases');
  assert.ok(Number.isSafeInteger(result.cursorAdmissionAssertions)&&result.cursorAdmissionAssertions>=3,'Must execute current generation-only paused-preview admission cases');
  assert.ok(result.axIdentityAssertions>=5);
  assert.ok(result.inputInterruptionAssertions>=11);
  assert.ok(result.passed>=298);
  assert.equal(result.passed,32+result.axIdentityAssertions+result.inputInterruptionAssertions+result.cursorAdmissionAssertions+result.cursorPolicyAssertions+result.cursorLifecycleAssertions+result.cursorCompletionAssertions+result.cursorRefreshAssertions+result.cursorConfigurationAssertions+result.cursorLayoutAssertions+result.cursorMetadataAssertions,'Report each assertion group once');
  assert.equal(result.guiActions,0);
  assert.equal(result.permissionPrompts,0);
  assert.deepEqual(result.cursor,{schema:1,kind:'software-overlay',visibility:'target-window',independentNativePointer:false,runtimeValidated:false},'Self-description is shared with status; it must not attest live cursor behavior');
  // Feed real pre-AppKit output through an in-memory ready event, never NativeClient.
  const native=new EventEmitter();native.connected=true;
  const coordinator=new Coordinator({native,getConfig:()=>({enabled:false})});
  try {
    native.emit('ready',{cursor:result.cursor});
    const status=coordinator.status();
    assert.deepEqual(status.cursor,{...result.cursor,source:'helper-self-report'});
    assert.equal(status.enabled,false);assert.equal(status.paused,true);
  } finally {await coordinator.dispose();}
});

test('explicit candidate evidence covers all frozen inputs without implying atomic checkout or runtime acceptance',{skip:!candidate||process.platform!=='darwin'},async()=>{
  const {directory,report}=await explicitCandidate();
  assert.equal(report.sourceHashOrigin,'frozen-candidate-inputs');
  const snapshot=report.inputSnapshot;
  assert.equal(snapshot.directory,'Sources');assert.equal(snapshot.hashAlgorithm,'sha256');
  assert.deepEqual(Object.keys(snapshot.files),BUILD_INPUTS);
  assert.equal(snapshot.verifiedAfterBuild,true);
  assert.equal(snapshot.atomicSourceCheckout,false);
  assert.equal(snapshot.hostileConcurrentMutationExcluded,false);
  assert.equal(snapshot.binaryReproducibilityVerified,false);
  await verifyBuildInputs({directory:path.join(directory,'Sources'),hashes:snapshot.files});
  assert.deepEqual(Object.keys(report.sourceHashes),HELPER_SOURCES);
  for(const [name,hash] of Object.entries(report.sourceHashes))assert.equal(hash,snapshot.files[name]);
});

test('candidate builder refuses extra arguments before creating build output',{skip:process.platform!=='darwin'},async()=>{
  await assert.rejects(execute(process.execPath,[path.join(root,'scripts/build-native.mjs'),'--candidate','--overwrite-installed'],{timeout:5000}),error=>{
    assert.equal(error.code,1);
    assert.match(error.stderr,/Usage: node scripts\/build-native.mjs/);
    assert.equal(error.stdout,'');
    return true;
  });
});
