import {execFileSync} from 'node:child_process';
import {mkdtemp, rename, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const files=['manifest.json','worker.js','task-tabs.js','playback-presentation.js','page.js','cursor-layer.js','popup.html','popup.js','popup.css',
  'cursor-large.png','cursor-mini.png','README.txt',...['16','32','48','128'].map(size=>'icons/dsh-'+size+'.png')];
const temp=await mkdtemp(path.join(root,'assets/.zip-'));
try {
  const archive=path.join(temp,'extension.zip');
  execFileSync('/usr/bin/zip',['-q','-X',archive,...files],{cwd:path.join(root,'browser-extension')});
  await rename(archive,path.join(root,'assets/DSH-Chrome.zip'));
} finally {await rm(temp,{recursive:true,force:true})}
