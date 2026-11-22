import test from 'node:test';
import assert from 'node:assert/strict';
import {connectComputer} from '../lib/api.js';
function fixture() {
  let serial=0, at=1000, fail=false;
  const calls=[];
  const snap=()=>({snapshotId:'snapshot-'+(++serial),observedAt:at,tree:[{ref:'ref-'+serial,title:'Ready',role:'button',enabled:true}],text:'Page body',truncated:false});
  const tools={
    async whale_status(){return{enabled:true,paused:false}},
    async whale_apps(){return{apps:[{bundleId:'org.fixture',name:'Fixture'}]}},
    async whale_windows(){return{windows:[{windowId:7}]}},
    async whale_observe(args){calls.push(['observe',args]);return{snapshot:snap()}},
    async whale_action(args){calls.push(['action',args]);if(fail)throw Object.assign(new Error('uncertain'),{code:'action_outcome_unknown'});return{snapshot:snap(),dispatch:{verified:true}}},
    async whale_browser(args){calls.push(['browser',args]);if(args.operation==='tabs')return{tabs:[{tabId:'tab-a',url:'http://fixture.local/'}]};return{snapshot:{...snap(),tabId:'tab-a',url:'http://fixture.local/'}}},
    async whale_pause(){return{paused:true}}
  };
  return{api:connectComputer(tools,{now:()=>at}),calls,setTime:v=>at=v,setFail:v=>fail=v,tools};
}
test('persistent app/window objects preserve exact fresh snapshots and consume uncertain actions',async()=>{
 const f=fixture(),app=await f.api.getApp('Fixture');
 assert.equal(app,await f.api.getApp('org.fixture'));
 await assert.rejects(app.click('ref-1'),{code:'observation_required'});
 const observed=await app.getAXState();await app.click(observed.snapshot.tree[0].ref);
 assert.equal(f.calls[1][1].snapshotId,observed.snapshot.snapshotId);
 f.setFail(true);
 await assert.rejects(app.click([10,20]),{code:'action_outcome_unknown'});
 const actions=f.calls.length;
 await assert.rejects(app.click([10,20]),{code:'observation_required'});
 assert.equal(f.calls.length,actions,'No retry or automatic observation after uncertain dispatch');
});
test('sibling native surfaces cannot reuse observations superseded by another window',async()=>{
 const f=fixture(),app=await f.api.getApp('Fixture'),window=app.getWindow(7);
 assert.equal(window,app.getWindow(7));
 await app.getState();await window.getState();
 await assert.rejects(app.click([1,1]),{code:'observation_required'});
 await window.click([1,1]);
 assert.equal(f.calls.at(-1)[1].windowId,7);
});
test('stale snapshots, paused state and bounded waits remain explicit',async()=>{
 const f=fixture(),app=await f.api.getApp('Fixture');await app.getState();f.setTime(17000);
 await assert.rejects(app.click([1,1]),{code:'observation_required'});
 const match=await app.waitFor({text:'Ready',role:'button'},{timeoutMs:0});
 assert.equal(match.matched,true);assert.equal(match.attempts,1);
 await f.api.pause();await assert.rejects(app.click('ref-2'),{code:'observation_required'});
 await assert.rejects(app.waitFor({absent:true}),{code:'invalid_wait'});
 await assert.rejects(app.waitFor({text:'Ready'},{timeoutMs:10001}),{code:'invalid_wait'});
});
test('browser object uses fresh result observations and never fabricates an absent control on incomplete pages',async()=>{
 const f=fixture(),tab=await f.api.getTab('http://fixture.local/');
 await tab.getState();await tab.goto('http://fixture.local/next');
 assert.equal(f.calls.at(-1)[1].action,'navigate');
 f.tools.whale_browser=async args=>args.operation==='tabs'?{tabs:[{tabId:'tab-a',url:'http://fixture.local/'}]}:{snapshot:{snapshotId:'cut',observedAt:1000,tree:[],truncated:true}};
 const result=await tab.waitFor({text:'Missing',absent:true},{timeoutMs:0});
 assert.equal(result.matched,false);assert.equal(result.timedOut,true);
});

test('persistent objects resolve the current PTC tool binding for every call',async()=>{
 const f=fixture();let current=f.tools,usedNew=false;
 const api=connectComputer(()=>current,{now:()=>1000}),app=await api.getApp('Fixture');
 const state=await app.getState();
 current={...f.tools,whale_action:async args=>{usedNew=true;return{snapshot:{snapshotId:'new',observedAt:1000,tree:[]}}}};
 await app.click(state.snapshot.tree[0].ref);
 assert.equal(usedNew,true);
});
