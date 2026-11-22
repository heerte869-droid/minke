import {copyFile, readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {registerBrowserHost} from '../scripts/setup-browser.mjs';

export async function downloadExtension({
  profileDir, downloadsDir=path.join(os.homedir(),'Downloads'),
  chromeDir=path.join(os.homedir(),'Library/Application Support/Google/Chrome')
}={}) {
  if (!profileDir) throw Object.assign(Error('DSH 浏览器连接尚未就绪'),{code:'chrome_bridge_unavailable'});
  // Register only on this user-initiated settings action, before reporting success.
  await registerBrowserHost({userDataDir:chromeDir,profileDir});
  const archive=new URL('../assets/DSH-Chrome.zip',import.meta.url);
  const manifest=JSON.parse(await readFile(new URL('../browser-extension/manifest.json',import.meta.url),'utf8'));
  const stem='DSH-Chrome-'+manifest.version;
  for(let index=0;index<1000;index++){
    const filename=stem+(index?' ('+index+')':'')+'.zip';
    try {
      await copyFile(archive,path.join(downloadsDir,filename),constants.COPYFILE_EXCL);
      return {filename};
    } catch(error){ if(error.code!=='EEXIST')throw error; }
  }
  throw Error('下载目录中的同名文件过多');
}
