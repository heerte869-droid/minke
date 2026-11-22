import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {registerBrowserHost} from '../scripts/setup-browser.mjs';

const bundle=fileURLToPath(new URL('../browser-extension/',import.meta.url));
export function installationFolder(profileDir){
  if(profileDir){
    // Prefer the stable DSH profile path when this copy is the installed package.
    return path.join(profileDir,'node_modules','@local','dsh-whale-computer','browser-extension');
  }
  return path.resolve(bundle);
}
export async function prepareChromeInstall({profileDir,chromeDir=path.join(os.homedir(),'Library/Application Support/Google/Chrome'),
    openManager=()=>promisify(execFile)('/usr/bin/open',['-b','com.google.Chrome','chrome://extensions/'],{timeout:5000})}={}){
  if(!profileDir)throw Object.assign(Error('DSH 尚未就绪'),{code:'chrome_bridge_unavailable'});
  // Chrome creates its data directory on first run. Open the normal installation surface on demand only.
  let managerOpened=false;
  try{await openManager();managerOpened=true}catch{}
  try{if(managerOpened)await fs.mkdir(chromeDir,{recursive:true,mode:0o700});else await fs.access(chromeDir)}catch(e){throw Object.assign(Error('请先安装并打开 Chrome，再准备扩展。'),{code:e.code==='ENOENT'?'chrome_not_initialized':'chrome_registration_failed'})}
  try{await registerBrowserHost({profileDir,userDataDir:chromeDir})}
  catch{throw Object.assign(Error('无法注册当前用户的 Chrome 本机连接'),{code:'chrome_registration_failed'})}
  const folder=installationFolder(profileDir);
  const real=await fs.realpath(bundle);
  const stable=await fs.realpath(folder).catch(()=>null);
  return {directory:stable===real?folder:real,managerOpened};
}
