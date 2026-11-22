import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import { z } from 'zod';
const name = '@local/dsh-whale-computer';
const snapshot = createTypertRemoteInfo({ package: name, methods: {
  'whaleDisplay/read': {
    service: 'whaleDisplay', description: 'Read the settings panel acknowledgement and connection state.',
    sourceLocation:{file:'index.js',line:80,column:1}, invocation: {kind: 'direct'}, parameters: [],
    result: {mode:'strict', typeSymbol:name+'#status', create:()=>z.string(), jsonSchema:{type:'string'}}
  }
}}, z);
export const TYPERT = { package:name, face:'host', schemas:[], get invocations(){return snapshot.descriptors}, model:{services:[], events:[], objects:[]} };
export const TYPERT_REMOTE = snapshot;
export default snapshot;
