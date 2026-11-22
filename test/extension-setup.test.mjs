import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {downloadExtension} from '../lib/download-extension.js';
import {EXTENSION_ID} from '../lib/extension-id.js';

test('setup registers the stable extension ID and delivers one complete browser package per request',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-extension-setup-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dirs={profileDir:path.join(root,'DSH'),chromeDir:path.join(root,'Chrome'),downloadsDir:path.join(root,'Downloads')};
  await Promise.all(Object.values(dirs).map(dir=>fs.mkdir(dir)));
  const first=await downloadExtension(dirs);
  const again=await downloadExtension(dirs);
  assert.notEqual(first.filename,again.filename);
  const expected=await fs.readFile(new URL('../assets/DSH-Chrome.zip',import.meta.url));
  for(const {filename} of [first,again])assert.deepEqual(await fs.readFile(path.join(dirs.downloadsDir,filename)),expected);
  for(const name of ['local.dsh.whale_browser','local.dsh.whale_tasks']){
    const host=JSON.parse(await fs.readFile(path.join(dirs.chromeDir,'NativeMessagingHosts',name+'.json'),'utf8'));
    assert.deepEqual(host.allowed_origins,['chrome-extension://'+EXTENSION_ID+'/']);
    assert.ok((await fs.stat(host.path)).mode & 0o100);
  }
});
