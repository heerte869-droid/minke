import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {EXTENSION_ID} from '../lib/extension-id.js';

const archive=process.argv[2];
if(!archive)throw Error('Usage: node scripts/check-release.mjs <plugin.tgz>');
const run=(bin,args)=>execFileSync(bin,args,{maxBuffer:32*1024*1024});
const entries=run('tar',['-tzf',archive]).toString().trim().split('\n');
const forbidden=/(^|\/)(\.git|\.DS_Store|work|research|candidates|node_modules|playback-extension|HANDOFF\.md|\.env(?:\..*)?|[^/]+\.(?:pem|key|log|zstd))($|\/)/;
assert(entries.every(name=>name.startsWith('package/')&&!name.split('/').includes('..')&&!forbidden.test(name)),'unexpected private or development member');
const helperEntry=run('tar',['-tvzf',archive,'package/native/build/Whale Computer.app/Contents/MacOS/whale-helper']).toString();
assert.match(helperEntry,/^-rwx/,'the packaged native helper must be executable after installation');
const member=name=>run('tar',['-xOf',archive,'package/'+name]);
assert.deepEqual(entries.filter(name=>name.endsWith('.zip')),['package/assets/DSH-Chrome.zip']);
const docNames=entries.filter(name=>name.startsWith('package/docs/')&&!name.endsWith('/')).sort();
assert.deepEqual(docNames,['API.md','EXTENSION.zh.md','PLUGIN.zh.md','TESTING.md'].map(s=>'package/docs/'+s).sort());
const manifest=JSON.parse(member('browser-extension/manifest.json'));
assert.equal(manifest.version,JSON.parse(await readFile(new URL('../browser-extension/manifest.json',import.meta.url))).version);
const id=createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)
  .replace(/[a-f0-9]/g,n=>String.fromCharCode(97+parseInt(n,16)));
assert.equal(id,EXTENSION_ID);
assert(manifest.permissions.includes('debugger'));
assert.equal(manifest.externally_connectable,undefined);
const tmp=await mkdtemp(path.join(os.tmpdir(),'dsh-release-check-'));
try{
  const file=path.join(tmp,'extension.zip');
  const bytes=member('assets/DSH-Chrome.zip');
  await writeFile(file,bytes);
  assert(bytes.equals(await readFile(new URL('../assets/DSH-Chrome.zip',import.meta.url))));
  const zipped=run('unzip',['-Z1',file]).toString().trim().split('\n');
  assert.deepEqual(zipped.filter(s=>s.endsWith('manifest.json')),['manifest.json']);
  const shipped=entries.filter(s=>s.startsWith('package/browser-extension/')&&!s.endsWith('/'))
    .map(s=>s.slice('package/browser-extension/'.length));
  assert.deepEqual([...zipped].sort(),shipped.sort());
  for(const name of zipped)assert(member('browser-extension/'+name).equals(run('unzip',['-p',file,name])),name);
}finally{await rm(tmp,{recursive:true,force:true})}
console.log('Release verified: one browser package, stable extension identity, matching payloads.');
