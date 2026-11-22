import path from 'node:path';
import {lstatSync,writeFileSync,unlinkSync} from 'node:fs';

// A deliberate stop belongs to the DSH profile, including stops triggered by Esc.
export class ControlIntent {
  constructor(profileDir) {
    this.file=path.join(profileDir,'.whale-control-stopped');
    try { lstatSync(this.file); this.stopped=true; }
    catch(error){ if(error.code!=='ENOENT')throw error; this.stopped=false; }
  }
  stop(){
    this.stopped=true;
    try { writeFileSync(this.file,'stopped\n',{flag:'wx',mode:0o600}); }
    catch(error){ if(error.code!=='EEXIST')throw error; }
  }
  resume(){
    try { unlinkSync(this.file); }
    catch(error){ if(error.code!=='ENOENT')throw error; }
    this.stopped=false;
  }
}
