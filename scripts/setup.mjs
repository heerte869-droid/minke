#!/usr/bin/env node
/** Explicit setup only; default invocation verifies and prints the plan. */
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectHelper,installHelper,executableIn} from '../lib/install.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let source=join(root,'native','build','Whale Computer.app'),install=false,replace=false;
const args=process.argv.slice(2);
for(let i=0;i<args.length;i++){
 if(args[i]==='--install')install=true;
 else if(args[i]==='--replace')replace=true;
 else if(args[i]==='--source'&&args[i+1])source=resolve(args[++i]);
 else throw Error('Usage: node scripts/setup.mjs [--source APP] [--install [--replace]]');
}
if(replace&&!install)throw Error('--replace requires explicit --install.');
if(process.platform!=='darwin')throw Error('Computer Use requires macOS.');
const destination=join(homedir(),'.dsh','whale-computer','Whale Computer.app');
const verify=async app=>{execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{stdio:'pipe'})};
const assertIdle=async app=>{
 const target=executableIn(app);
 const processes=execFileSync('/bin/ps',['-ww','-axo','pid=,comm='],{encoding:'utf8'});
 if(processes.split('\n').some(line=>line.trim().replace(/^\d+\s+/,'')===target))throw Error('Installed helper is running. Pause and unload its plugin before replacing it.');
};
const plan=await inspectHelper(source);await verify(plan.source);
console.log(JSON.stringify({...plan,destination,installRequested:install,replaceRequested:replace,adHocSigned:true,notarized:false,startsHelper:false,requestsPermissions:false,editsDSHProfile:false},null,2));
if(!install){console.log('Inspection only. --install copies a new installation; --install --replace also preserves the existing app in a backup.');process.exit(0)}
const result=await installHelper({source:plan.source,destination,replace,verify,assertIdle});
console.log(JSON.stringify(result,null,2));
