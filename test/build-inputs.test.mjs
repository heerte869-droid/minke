import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { BUILD_INPUTS, HELPER_SOURCES, snapshotBuildInputs, verifyBuildInputs } from '../scripts/native-build-inputs.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,omit=[]) {
  const tempParent=await realpath(os.tmpdir());
  const base=await realpath(await mkdtemp(path.join(tempParent,'dsh-build-inputs-')));
  t.after(async()=>{
    // Verify the exact owned absolute root before recursively deleting fixtures.
    assert.equal(path.dirname(base),tempParent);
    assert.ok(path.basename(base).startsWith('dsh-build-inputs-'));
    assert.equal(await realpath(base),base);
    await rm(base,{recursive:true});
  });
  const source=path.join(base,'native'),output=path.join(base,'candidate');
  await mkdir(source);await mkdir(output);
  for(const name of BUILD_INPUTS) {
    if(omit.includes(name))continue;
    const file=path.join(source,name);
    await mkdir(path.dirname(file),{recursive:true});
    await writeFile(file,`Original bytes for ${name}\n`);
  }
  return {base,source,output};
}
async function removeOwned(root,target) {
  const absolute=path.resolve(target);
  assert.equal(await realpath(root),root);
  assert.ok(absolute.startsWith(root+path.sep));
  assert.equal(await realpath(absolute),absolute);
  await rm(absolute,{recursive:true});
}

test('candidate snapshot records the same bytes saved for all sources and the original cursor artwork',async t=>{
  const f=await fixture(t);const snapshot=await snapshotBuildInputs(f.source,f.output);
  assert.equal(snapshot.directory,path.join(f.output,'Sources'));
  assert.ok(BUILD_INPUTS.includes('cursor-whale.png'));assert.equal(HELPER_SOURCES.length,6);
  assert.deepEqual(Object.keys(snapshot.hashes),BUILD_INPUTS);
  for(const name of BUILD_INPUTS) {
    const saved=await readFile(snapshot.paths[name]);
    assert.equal(snapshot.paths[name],path.join(snapshot.directory,name));
    assert.deepEqual(saved,await readFile(path.join(f.source,name)));
    assert.equal(snapshot.hashes[name],digest(saved));
    if(process.platform!=='win32')assert.equal((await lstat(snapshot.paths[name])).mode&0o222,0);
  }
  assert.notEqual(snapshot.paths['main.swift'],snapshot.paths['fixture/main.swift']);
  await verifyBuildInputs(snapshot);
});

test('editing checkout after snapshot cannot change compiler input bytes or their hashes',async t=>{
  const f=await fixture(t);const snapshot=await snapshotBuildInputs(f.source,f.output);
  const recorded={...snapshot.hashes};
  for(const name of BUILD_INPUTS)await writeFile(path.join(f.source,name),'Changed checkout\n');
  for(const name of BUILD_INPUTS) {
    assert.notEqual(digest(await readFile(path.join(f.source,name))),recorded[name]);
    assert.equal(digest(await readFile(snapshot.paths[name])),recorded[name]);
  }
  await verifyBuildInputs(snapshot);
});

test('snapshot creation refuses an existing Sources directory without overwriting',async t=>{
  const f=await fixture(t);const destination=path.join(f.output,'Sources');
  await mkdir(destination);const marker=path.join(destination,'marker');await writeFile(marker,'preserve');
  await assert.rejects(snapshotBuildInputs(f.source,f.output),{code:'EEXIST'});
  assert.equal(await readFile(marker,'utf8'),'preserve');
});

test('snapshot creation refuses an existing Sources file',async t=>{
  const f=await fixture(t);const destination=path.join(f.output,'Sources');
  await writeFile(destination,'preserve');
  await assert.rejects(snapshotBuildInputs(f.source,f.output),{code:'EEXIST'});
  assert.equal(await readFile(destination,'utf8'),'preserve');
});

test('source symlink file is not followed',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t,['Core.swift']);
  await symlink(path.join(f.source,'Security.swift'),path.join(f.source,'Core.swift'));
  await assert.rejects(snapshotBuildInputs(f.source,f.output),/regular nonredirected file/);
});

test('source intermediate symlink directory is not followed',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t,['fixture/main.swift']);const other=path.join(f.base,'other');
  await mkdir(other);await writeFile(path.join(other,'main.swift'),'not a fixture input');
  await symlink(other,path.join(f.source,'fixture'));
  await assert.rejects(snapshotBuildInputs(f.source,f.output),/regular nonredirected file/);
});

test('source nonregular file and missing input fail closed',async t=>{
  const f=await fixture(t,['Core.swift']);
  await assert.rejects(snapshotBuildInputs(f.source,f.output),{code:'ENOENT'});
  const second=path.join(f.base,'second-candidate');await mkdir(second);await mkdir(path.join(f.source,'Core.swift'));
  await assert.rejects(snapshotBuildInputs(f.source,second),/regular nonredirected file/);
});

for(const name of ['Overlay.swift','fixture/main.swift','THIRD_PARTY_NOTICES.md']) {
  test(`post-build verification rejects changed snapshot bytes: ${name}`,async t=>{
    const f=await fixture(t);const snapshot=await snapshotBuildInputs(f.source,f.output);
    await chmod(snapshot.paths[name],0o600);await writeFile(snapshot.paths[name],'tampered');
    await assert.rejects(verifyBuildInputs(snapshot),/Build input snapshot changed/);
  });
}

test('post-build verification rejects a removed snapshot file',async t=>{
  const f=await fixture(t);const snapshot=await snapshotBuildInputs(f.source,f.output);
  await removeOwned(snapshot.directory,snapshot.paths['Core.swift']);
  await assert.rejects(verifyBuildInputs(snapshot),{code:'ENOENT'});
});

test('post-build verification rejects a snapshot replaced with a directory',async t=>{
  const f=await fixture(t);const snapshot=await snapshotBuildInputs(f.source,f.output);
  await removeOwned(snapshot.directory,snapshot.paths['Core.swift']);await mkdir(snapshot.paths['Core.swift']);
  await assert.rejects(verifyBuildInputs(snapshot),/regular nonredirected file/);
});

test('post-build verification rejects a snapshot symlink even with identical bytes',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t);const snapshot=await snapshotBuildInputs(f.source,f.output);
  await removeOwned(snapshot.directory,snapshot.paths['Core.swift']);
  await symlink(path.join(f.source,'Core.swift'),snapshot.paths['Core.swift']);
  await assert.rejects(verifyBuildInputs(snapshot),/regular nonredirected file/);
});

test('post-build verification rejects an intermediate snapshot directory symlink',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t);const snapshot=await snapshotBuildInputs(f.source,f.output);
  await removeOwned(snapshot.directory,path.join(snapshot.directory,'fixture'));
  await symlink(path.join(f.source,'fixture'),path.join(snapshot.directory,'fixture'));
  await assert.rejects(verifyBuildInputs(snapshot),/regular nonredirected file/);
});

test('snapshot roots cannot redirect through symlinks',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t);const redirected=path.join(f.base,'redirected');await symlink(f.output,redirected);
  await assert.rejects(snapshotBuildInputs(f.source,redirected),/must not redirect/);
  const redirectedSource=path.join(f.base,'redirected-native');await symlink(f.source,redirectedSource);
  await assert.rejects(snapshotBuildInputs(redirectedSource,f.output),/must not redirect/);
});

test('post-build verification refuses incomplete or extra manifest entries',async t=>{
  const f=await fixture(t);const snapshot=await snapshotBuildInputs(f.source,f.output);
  await assert.rejects(verifyBuildInputs({...snapshot,hashes:{}}),/incomplete manifest/);
  await assert.rejects(verifyBuildInputs({...snapshot,hashes:{...snapshot.hashes,extra:'0'.repeat(64)}}),/incomplete manifest/);
});

test('builder wiring uses snapshot routes for helper, fixture and notice and verifies before report',async()=>{
  // Static wiring regression only: this does NOT execute a compiler or helper.
  const script=await readFile(new URL('../scripts/build-native.mjs',import.meta.url),'utf8');
  assert.match(script,/const inputs=candidate\?await snapshotBuildInputs\(/);
  assert.match(script,/const inputPath=name=>inputs\?inputs.paths\[name\]:path.join\(root,'native',name\)/);
  assert.match(script,/HELPER_SOURCES.map\(inputPath\)/);
  assert.match(script,/copyFile\(inputPath\('THIRD_PARTY_NOTICES.md'\)/);
  assert.match(script,/inputPath\('fixture\/main.swift'\)/);
  const verify=script.indexOf('await verifyBuildInputs(inputs)');
  const report=script.indexOf("await writeFile(path.join(build,'build-report.json')");
  assert.ok(verify>=0&&report>verify);
  assert.match(script,/reportVersion:2/);
  assert.match(script,/sourceHashOrigin:'frozen-candidate-inputs'/);
});
