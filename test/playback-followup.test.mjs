import assert from 'node:assert/strict';
import test from 'node:test';
import {PlaybackFollowup} from '../lib/playback-followup.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(fn) {
  for (let i=0; i<150; i++) { if (fn()) return; await sleep(5); }
  assert.fail('follow-up did not settle');
}
const reading = (from,to,visible) => ({
  from,to,verified:to-from>=1,selectedBefore:visible,selectedAfter:visible,
  visibility:visible?'visible':'hidden',paused:false,muted:true,playerId:'player-a'
});

test('a hidden sample and later selected sample are kept without counting a rewind or mixed visibility',async()=>{
  const watcher=new PlaybackFollowup();
  const seq=[reading(0,0,false), {...reading(1,4,false),selectedAfter:null}, reading(5,7,false),
    reading(1,3,true), reading(8,10,true)];
  try {
    const initial=watcher.start('a',async()=>seq.shift(),{intervalMs:1,durationMs:1000});
    assert.equal(initial.status,'checking');assert.equal(watcher.get('b'),undefined);
    await until(()=>!watcher.checking);
    const r=watcher.get('a');
    assert.equal(r.reason,'viewed_after_background');assert.equal(r.samples,5);assert.equal(r.verifiedSamples,4);assert.equal(r.lastVerified.to,10);
    assert.equal(r.background.from,5);assert.equal(r.viewedAfterBackground.from,8);
    r.background.to=99;assert.equal(watcher.get('a').background.to,7);
  } finally {watcher.clear()}
});
test('expiration retains zero progress and cancellation does not accept an in-flight sample',async()=>{
  const w=new PlaybackFollowup();
  try {
    w.start('a',async()=>reading(0,0,false),{intervalMs:2,durationMs:25});
    await until(()=>!w.checking);assert.equal(w.get('a').reason,'time_limit');assert.equal(w.get('a').background,null);
    const caller=new AbortController();let resolveRead;
    w.start('a',async()=>new Promise(r=>{resolveRead=r}),{parentSignal:caller.signal});
    await until(()=>!!resolveRead);caller.abort();resolveRead(reading(3,5,false));await sleep(3);
    assert.equal(w.get('a').reason,'cancelled');assert.equal(w.get('a').samples,0);
  } finally {w.clear()}
});
test('a new player at the same URL cannot inherit a background playback receipt',async()=>{
  const w=new PlaybackFollowup();
  const samples=[reading(8,10,false),{...reading(30,32,true),playerId:'player-b'}];
  try {
    w.start('tab',async()=>samples.shift(),{intervalMs:1,durationMs:500});
    await until(()=>!w.checking);
    const r=w.get('tab');
    assert.equal(r.reason,'player_changed');
    assert.equal(r.lastVerified.playerId,'player-a');
    assert.equal(r.viewedAfterBackground,null);
  }finally{w.clear()}
});
test('older extensions still report individual progress without certifying a continuous player',async()=>{
  const w=new PlaybackFollowup();
  const samples=[{...reading(8,10,false),playerId:undefined},{...reading(12,14,true),playerId:undefined}];
  try {
    w.start('tab',async()=>samples.shift(),{intervalMs:1,durationMs:150});
    await until(()=>!w.checking);
    const r=w.get('tab');
    assert.equal(r.background.to,10);assert.equal(r.latest.to,14);
    assert.equal(r.verifiedSamples,2);assert.equal(r.viewedAfterBackground,null);
  }finally{w.clear()}
});
test('a late response from a replaced task cannot update the new receipt',async()=>{
  const w=new PlaybackFollowup();let endOld;
  try {
    w.start('a',async()=>new Promise(r=>{endOld=r}));await until(()=>!!endOld);
    w.start('b',async()=>{throw Object.assign(Error('changed'),{code:'followup_target_changed'})});
    endOld(reading(8,10,false));await until(()=>!w.checking);
    assert.equal(w.get('a'),undefined);assert.equal(w.get('b').reason,'target_changed');
    assert.equal(w.get('b').samples,0);
  } finally {w.clear()}
});
test('direct readings keep the correct watch, mute setting, order and observed pauses',()=>{
  const w=new PlaybackFollowup();
  try {
    w.start('a',async()=>null,{requireMuted:true});
    assert.equal(w.beginSample('other'),null);
    const slow=w.beginSample('a'),direct=w.beginSample('a');
    direct({...reading(2,5,false),muted:false});
    slow(reading(0,2,false));
    assert.equal(w.get('a').background,null);
    assert.equal(w.get('a').samples,1);
    w.beginSample('a')(reading(5,8,false));
    w.beginSample('a')({...reading(8,8,false),paused:true});
    w.beginSample('a')(reading(8,11,true));
    const receipt=w.get('a');
    assert.equal(receipt.background.to,8);
    assert.equal(receipt.backgroundPause.from,8);
    assert.equal(receipt.viewedAfterBackground.to,11);
    assert.equal(w.beginSample('a'),null);
    w.start('a',async()=>null);
    direct(reading(12,14,false));
    assert.equal(w.get('a').latest,null);
  }finally{w.clear()}
});
