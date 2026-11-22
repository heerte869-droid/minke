import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Coordinator} from '../lib/coordinator.js';
import {registerTools} from '../index.js';

test('browser-only controls use CDP without starting a desktop helper', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dsh-browser-only-'));
  const endpoint='http://127.0.0.1:9222';
  let connected=false;
  const co=new Coordinator({browserOnly:true,
    getConfig:()=>({enabled:true,sessionAccess:true,browserEndpoint:endpoint}),getWorkspace:async()=>dir,
    deniedOrigins:['http://127.0.0.1:59721'],approval:{request:async()=>'allowed-once'},
    createBrowser:workspace=>{
      assert.equal(workspace,dir);
      return {status:()=>({connected}),connect:async args=>{assert.equal(args.endpoint,endpoint);connected=true;},
        listTabs:async()=>[{tabId:'test',url:'https://example.org'}],disconnect:async()=>{connected=false;}};
    }
  });
  t.after(async()=>{await co.dispose();await rm(dir,{recursive:true,force:true});});
  co.bindProfile(dir);
  const names=[];
  registerTools({tools:{register:tool=>names.push(tool.name)}},co);
  assert.deepEqual(names.sort(),['whale_browser','whale_pause','whale_status']);
  const list=()=>co.browser({operation:'tabs'},{name:'whale_browser',callId:crypto.randomUUID(),agent:{id:'a',session:{id:'s'}}});
  assert.equal((await list()).tabs[0].tabId,'test');
  assert.equal(co.status().nativeConnected,false);
  await co.userCommand('pause');
  await assert.rejects(list,{code:'paused'});
  await co.userCommand('resume');
  assert.equal((await list()).tabs[0].tabId,'test');
});
