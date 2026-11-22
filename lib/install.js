import {access,cp,lstat,mkdir,mkdtemp,open,readFile,realpath,rename,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
export const executableIn=app=>path.join(app,'Contents','MacOS','whale-helper');
const sha=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const exists=async file=>{try{return await lstat(file)}catch(e){if(e.code==='ENOENT')return null;throw e}};
export async function inspectHelper(source){
 const absolute=path.resolve(source);
 if(await realpath(absolute)!==absolute || !(await lstat(absolute)).isDirectory())throw Error('Source must be a regular app directory without redirected paths.');
 const executable=executableIn(absolute);
 if(await realpath(executable)!==executable || !(await lstat(executable)).isFile())throw Error('Helper executable must be a regular file.');
 await access(executable,constants.X_OK);
 return{source:absolute,sha256:await sha(executable)};
}
/** No implicit install, execution, TCC request or profile edit. */
export async function installHelper({source,destination,replace=false,verify,assertIdle}){
 if(typeof verify!=='function'||typeof assertIdle!=='function')throw Error('Signature verification and idle check are required.');
 const plan=await inspectHelper(source);await verify(plan.source);
 destination=path.resolve(destination);const parent=path.dirname(destination);
 await mkdir(parent,{recursive:true,mode:0o700});
 if(await realpath(parent)!==parent)throw Error('Installation directory must not redirect.');
 const lock=await open(path.join(parent,'.install.lock'),'wx',0o600);
 let staging,backupPath,committed=false;
 try{
  const previous=await exists(destination);
  if(previous){
   if(previous.isSymbolicLink()||!previous.isDirectory()||await realpath(destination)!==destination)throw Error('Existing installation is not a regular app directory.');
   if(await sha(executableIn(destination))===plan.sha256)return{destination,unchanged:true,sha256:plan.sha256};
   if(!replace)throw Error('Existing installation requires explicit --replace; nothing was changed.');
  }
  await assertIdle(destination);
  staging=await mkdtemp(path.join(parent,'.stage-'));
  const staged=path.join(staging,'Whale Computer.app');
  await cp(plan.source,staged,{recursive:true,force:false,errorOnExist:true,preserveTimestamps:true,dereference:false});
  await verify(staged);
  if(await sha(executableIn(staged))!==plan.sha256)throw Error('Staged executable does not match the reviewed source.');
  await assertIdle(destination);
  if(previous){
   const backups=path.join(parent,'backups');await mkdir(backups,{recursive:true,mode:0o700});
   if(await realpath(backups)!==backups)throw Error('Backup directory must not redirect.');
   const slot=await mkdtemp(path.join(backups,'helper-'));
   backupPath=path.join(slot,'Whale Computer.app');
   await rename(destination,backupPath);
  }
  try{
   await rename(staged,destination);committed=true;
   await verify(destination);
   if(await sha(executableIn(destination))!==plan.sha256)throw Error('Installed executable differs from the staged candidate.');
  }catch(error){
   if(committed && await sha(executableIn(destination)).catch(()=>null)===plan.sha256)await rename(destination,path.join(staging,'failed-install.app'));
   if(backupPath && !await exists(destination))await rename(backupPath,destination);
   throw error;
  }
  return{destination,backupPath:backupPath??null,sha256:plan.sha256,unchanged:false};
 }finally{
  await lock.close();await rm(path.join(parent,'.install.lock'),{force:true});
  if(staging)await rm(staging,{recursive:true,force:true});
 }
}
