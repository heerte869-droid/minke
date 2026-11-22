// Build-only utilities: importing this module performs no I/O or process launch.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const HELPER_SOURCES=Object.freeze(['Core.swift','Security.swift','SkyLight.swift','Actions.swift','Overlay.swift','main.swift']);
export const BUILD_INPUTS=Object.freeze([...HELPER_SOURCES,'fixture/main.swift','THIRD_PARTY_NOTICES.md','cursor-whale.png','cursor-whale-large.png']);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

async function directoryAt(location) {
  const absolute=path.resolve(location);
  if(await realpath(absolute)!==absolute || !(await lstat(absolute)).isDirectory())throw new Error('Build input directory must not redirect through a symlink');
  return absolute;
}
async function readRegular(root,name) {
  const file=path.join(root,name);
  if(!(await lstat(file)).isFile() || await realpath(file)!==file)throw new Error(`Build input must be a regular nonredirected file: ${name}`);
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    if(!(await handle.stat()).isFile())throw new Error(`Build input must be a regular file: ${name}`);
    return await handle.readFile();
  } finally {await handle.close();}
}

// Each digest and saved file comes from the same Buffer. This is deliberately
// NOT an atomic multi-file checkout, a hostile-filesystem sandbox, or a claim
// of reproducible binaries. Read-only files deter accidental edits; their owner
// can still change them. Post-build verification cannot exclude transient ABA.
export async function snapshotBuildInputs(nativeRoot,candidateDirectory) {
  const root=await directoryAt(nativeRoot);
  const parent=await directoryAt(candidateDirectory);
  const directory=path.join(parent,'Sources');
  await mkdir(directory,{mode:0o700}); // Exclusive: never reuse an existing snapshot.
  const hashes={};const paths={};
  for(const name of BUILD_INPUTS) {
    const bytes=await readRegular(root,name);
    const destination=path.join(directory,name);
    if(name.includes('/'))await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
    await writeFile(destination,bytes,{flag:'wx',mode:0o400});
    hashes[name]=digest(bytes);paths[name]=destination;
  }
  return Object.freeze({directory,hashes:Object.freeze(hashes),paths:Object.freeze(paths)});
}

export async function verifyBuildInputs(snapshot) {
  const directory=await directoryAt(snapshot.directory);
  if(Object.keys(snapshot.hashes).length!==BUILD_INPUTS.length || BUILD_INPUTS.some(name=>!Object.hasOwn(snapshot.hashes,name)))throw new Error('Build input snapshot has an incomplete manifest');
  for(const name of BUILD_INPUTS) {
    const bytes=await readRegular(directory,name);
    if(digest(bytes)!==snapshot.hashes[name])throw new Error(`Build input snapshot changed: ${name}`);
  }
}
