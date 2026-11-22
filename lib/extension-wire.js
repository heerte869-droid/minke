import {createConnection} from 'node:net';
export const MAX_FRAME=256*1024;
export function lines(onMessage, onError) {
  let buffer=Buffer.alloc(0), broken=false;
  return bytes=>{
    if(broken)return;
    buffer=Buffer.concat([buffer,bytes]);
    try {
      for(let end;(end=buffer.indexOf(10))>=0;){
        if(end>MAX_FRAME)throw Error('frame too large');
        const frame=JSON.parse(buffer.subarray(0,end).toString('utf8'));buffer=buffer.subarray(end+1);onMessage(frame);
      }
      if(buffer.length>MAX_FRAME)throw Error('frame too large');
    }catch(e){broken=true;onError(e)}
  };
}
export function writeLine(stream,value){const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>MAX_FRAME)throw Error('frame too large');stream.write(bytes+'\n')}
