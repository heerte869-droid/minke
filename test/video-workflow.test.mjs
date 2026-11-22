import test from 'node:test';
import assert from 'node:assert/strict';
import {searchAndPlay,VideoTaskFailure} from '../lib/bilibili-video.js';

function fixture({muted=true, staleFollow=false, uncertainFollow=false, rejectedPlay=false, changeConnection=false, extraResults=[], verifySequence=[], hiddenAfterPlay=false, hiddenReady=false, playFailure=null, query='鲸鱼 科普', resultTitle='鲸鱼科普'}={}) {
  const url='https://www.bilibili.com/video/BV1Example/';
  let current='https://www.bilibili.com/',revision=0;
  const calls=[],playOptions=[],followMute=[];
  const bridge={serial:1,connected:true,async request(op,args) {
    calls.push(op);
    if(op==='meta')return {url:current,tabId:'5',active:false};
    if(op==='observe'){
      const onVideo=current===url,search=current.startsWith('https://search.bilibili.com/');
      const deferred=onVideo && hiddenAfterPlay && calls.includes('play');
      return {url:current,visibility:deferred||hiddenReady?'hidden':'visible',snapshotId:String(++revision),tree:onVideo?[{role:'video',ref:'v'}]:search?[...(typeof extraResults==='function'?extraResults(new URL(current).searchParams.get('keyword')):extraResults),{role:'link',ref:'link',href:url,title:resultTitle}]:[],videos:onVideo?[{playerId:'fixture-player',muted,paused:false,readyState:deferred?0:3}]:[]};
    }
    if(op==='navigate'){current=args.destination;return {requiresObservation:true};}
    if(op==='follow'){
      followMute.push(args.muteTaskTab);
      if (staleFollow && followMute.length === 1) {
        throw Object.assign(Error('链接已变化，请重新观察'), {details: {notDispatched:true}});
      }
      assert.equal(args.ref,'link');
      current=url;
      if(uncertainFollow)throw Object.assign(new Error('lost reply'),{code:'extension_timeout'});
      return {requiresObservation:true};
    }
    if(op==='play'){
      playOptions.push(args.muted);
      if(changeConnection)this.serial++;
      if(playFailure)throw playFailure;
      if(rejectedPlay)throw Object.assign(new Error('control gone'),{code:'extension_refused',details:{notDispatched:true}});
      return {dispatched:true};
    }
    if(op==='verifyPlayback' && verifySequence.length){const next=verifySequence.shift();if(next instanceof Error)throw next;return {url:current,...next};}
    if(op==='verifyPlayback')return {verified:true,url:current,title:'鲸鱼科普',from:1.2,to:3.4,muted,tabActive:false};
    throw Error(op);
  }};
  return {calls,playOptions,followMute,go:(audioMode,resultId,searchOnly,fallbackQuery,publicIndexAllowed)=>searchAndPlay(bridge,'5',query,new AbortController().signal,{},audioMode,resultId,searchOnly,fallbackQuery,publicIndexAllowed)};
}
test('video verifies mute and progression; uncertain navigation is observed without replay',async()=>{
  const f=fixture({uncertainFollow:true});const proof=await f.go();
  assert.equal(proof.verified,true);assert.equal(proof.muted,true);assert.equal(proof.tabActive,false);
  assert.equal(f.calls.filter(x=>x==='follow').length,1);assert.equal(f.calls.filter(x=>x==='play').length,1);
});
test('muted viewing requests tab silence when following the same refreshed result',async()=>{
  const f=fixture({staleFollow:true});
  assert.equal((await f.go('muted')).verified,true);
  assert.deepEqual(f.followMute,[true,true]);
  assert.equal(f.calls.filter(op=>op==='play').length,1);
});
test('pause interruption is identified without replaying a cold hidden video',async()=>{
  const f=fixture({playFailure:Object.assign(Error('The play() request was interrupted by a call to pause().'),{code:'extension_refused'}),
    hiddenAfterPlay:true,verifySequence:[{verified:false,visibility:'hidden',paused:true,from:0,to:0}]});
  const r=await f.go();
  assert.equal(r.playRequest,'interrupted_by_pause');
  assert.equal(r.verified,false);
  assert.deepEqual(f.playOptions,[true]);
});
test('time progression alone cannot certify a muted viewing task',async()=>{
  await assert.rejects(fixture({muted:false}).go(),e=>e instanceof VideoTaskFailure&&e.stage==='核实播放');
});
test('an explicitly unsent play reports its stage and is never retried',async()=>{
  const f=fixture({rejectedPlay:true});await assert.rejects(f.go(),e=>e instanceof VideoTaskFailure&&e.stage==='静音播放');
  assert.equal(f.calls.filter(x=>x==='play').length,1);assert.ok(!f.calls.includes('verifyPlayback'));
});
test('a changed shared connection cannot verify an old action',async()=>{
  const f=fixture({changeConnection:true});await assert.rejects(f.go(),e=>e instanceof VideoTaskFailure);assert.ok(!f.calls.includes('verifyPlayback'));
});

test('search ranks the requested video ahead of unrelated promotions and partial title matches',async()=>{
  const f=fixture({extraResults:[
    {role:'link',ref:'ad',href:'https://www.bilibili.com/video/BV1Promotion/',title:'游泳耳机测评'},
    {role:'link',ref:'partial',href:'https://www.bilibili.com/video/BV1Other/',title:'科普园地'}
  ]});
  assert.equal((await f.go()).verified,true);
});
test('a replaced initial media element is remeasured without another play',async()=>{
  const f=fixture({verifySequence:[Object.assign(new Error('Video changed during verification'),{code:'extension_refused'})]});
  assert.equal((await f.go()).verified,true);
  assert.equal(f.calls.filter(op=>op==='play').length,1);
});
test('a ready player paused by the page or person stays paused',async()=>{
  const f=fixture({verifySequence:[{verified:false,paused:true,from:61,to:61}]});
  await assert.rejects(f.go(),error=>error instanceof VideoTaskFailure && error.message.includes('已暂停'));
  assert.equal(f.calls.filter(op=>op==='play').length,1);
});

test('a loaded hidden pause returns the measured player and time without replay',async()=>{
  const sample={playerId:'fixture-player',verified:false,paused:true,tabActive:false,visibility:'hidden',
    tabMuted:true,elementMuted:true,from:4.7,to:4.7};
  const f=fixture({hiddenReady:true,verifySequence:[sample]});
  const result=await f.go();
  assert.equal(result.playbackState,'paused_hidden');
  assert.equal(result.playerId,sample.playerId);
  assert.deepEqual([result.from,result.to,result.readyState],[4.7,4.7,3]);
  assert.ok(result.tabMuted&&result.elementMuted&&result.doNotReplay);
  assert.deepEqual(f.playOptions,[true]);
});
test('a cold background tab returns the chosen video without claiming playback or sending another input',async()=>{
  const f=fixture({hiddenAfterPlay:true,verifySequence:[{verified:false,visibility:'hidden',paused:false,from:0,to:0}]});
  const result=await f.go();
  assert.equal(result.verified,false);assert.equal(result.playbackState,'unconfirmed_hidden');
  assert.match(result.url,/BV1Example/);assert.equal(result.requiresObservation,true);
  assert.equal(f.calls.filter(op=>op==='play').length,1);
});

test('ordinary playback preserves the page setting whether it starts muted or not',async()=>{
  for(const muted of [false,true]){
    const f=fixture({muted});
    const proof=await f.go('preserve');
    assert.equal(proof.verified,true);assert.equal(proof.muted,muted);
    assert.deepEqual(f.followMute,[false]);assert.equal(proof.audioMode,'preserve');assert.deepEqual(f.playOptions,[false]);
  }
});
test('legacy requests remain silent, and unknown audio modes cannot dispatch',async()=>{
  const f=fixture();await f.go();assert.deepEqual(f.playOptions,[true]);
  const invalid=fixture();await assert.rejects(invalid.go('other'),VideoTaskFailure);
  assert.deepEqual(invalid.calls,[]);
});

test('explicit Chrome autoplay denial survives empty hidden media without a replay',async()=>{
  const playFailure=Object.assign(new Error("play() failed because the user didn't interact with the document first."),{code:'extension_refused'});
  const f=fixture({playFailure,hiddenAfterPlay:true,verifySequence:[{verified:false,visibility:'hidden',paused:true,from:0,to:0}]});
  const r=await f.go('preserve');
  assert.equal(r.verified,false);assert.equal(r.playRequest,'autoplay_not_allowed');
  assert.equal(f.playOptions.length,1);
});
test('an independent player start is measured even if the explicit request was denied',async()=>{
  const playFailure=Object.assign(new Error("play() failed because the user didn't interact with the document first."),{code:'extension_refused'});
  const f=fixture({playFailure,muted:false});const r=await f.go('preserve');
  assert.equal(r.verified,true);assert.equal(r.playRequest,'autoplay_not_allowed');assert.equal(f.playOptions.length,1);
});

test('a matching action with a different subject stays a candidate; an observed choice can continue',async()=>{
  const f=fixture({query:'海豹打哈欠',resultTitle:'海豹的午休',extraResults:[
    {role:'link',ref:'thumb',href:'https://www.bilibili.com/video/BV1Rabbit/',title:'3.2万 10 00:52'},
    {role:'link',ref:'rabbit',href:'https://www.bilibili.com/video/BV1Rabbit/',title:'我赌你没看过兔兔打哈欠！'}
  ]});
  const first=await f.go();
  assert.equal(first.playbackState,'needs_selection');
  assert.deepEqual(new Set(first.candidates.map(c=>c.id)),new Set(['BV1Rabbit','BV1Example']));
  assert.equal(first.candidates.filter(c=>c.id==='BV1Rabbit').length,1);
  assert.ok(!f.calls.includes('play') && !f.calls.includes('follow'));
  const picked=await f.go('preserve','BV1Example');
  assert.equal(picked.verified,true);assert.equal(f.calls.filter(op=>op==='navigate').length,1);
});
test('a supplied result id cannot start a blind navigation from a different document',async()=>{
  const f=fixture();await assert.rejects(f.go('preserve','BV1Example'),VideoTaskFailure);
  assert.deepEqual(f.calls,['meta']);
});

test('a subject-only candidate survives a page full of unrelated matching actions',async()=>{
  const extraResults=Array.from({length:8},(_,i)=>({role:'link',ref:'r'+i,href:'https://www.bilibili.com/video/BV1Rabbit'+i+'/',title:'兔兔打哈欠'}));
  const f=fixture({query:'海豹打哈欠',resultTitle:'海豹困到张大嘴巴',extraResults});
  const result=await f.go();assert.equal(result.playbackState,'needs_selection');
  assert.equal(result.candidates[0].id,'BV1Example');assert.equal(result.candidates.length,5);
  assert.deepEqual(f.playOptions,[]);
});

test('a broad jellyfish search asks the agent to distinguish gaming from the aquarium video',async()=>{
  const f=fixture({query:'水母',resultTitle:'水族馆里的水母缓慢游动',extraResults:[
    {role:'link',ref:'g',href:'https://www.bilibili.com/video/BV1Game/',title:'【炉石梗百科】飞行水母FJ'}
  ]});
  const offered=await f.go('preserve');
  assert.equal(offered.selectionReason,'ambiguous_topic');
  assert.deepEqual(offered.candidates.map(r=>r.id),['BV1Game','BV1Example']);
  assert.ok(!f.calls.includes('play') && !f.calls.includes('follow'));
  assert.equal((await f.go('preserve','BV1Example')).verified,true);
});
test('a single exact title can still be opened directly',async()=>{
  assert.equal((await fixture({query:'水母',resultTitle:'水母'}).go()).verified,true);
});

test('title lookup returns observed links without playback',async()=>{const f=fixture({});const r=await f.go('muted',undefined,true);assert.ok(r.results[0].url.includes(r.results[0].id));assert.ok(!f.calls.includes('follow')&&!f.calls.includes('play'));});

test('search fallback is skipped when all title terms match',async()=>{const f=fixture({});await f.go('muted',undefined,true,'alternate');assert.equal(f.calls.filter(x=>x==='navigate').length,1);});

test('a later query promotes the original exact title even below eight unrelated cards',async()=>{
  const query='动画 | 《Example》 | 副标题';
  const extraResults=keyword=>{
    if(keyword!=='动画 Example')return [];
    const rows=Array.from({length:16},(_,i)=>({role:'link',href:'https://www.bilibili.com/video/BV'+i+'/',title:'动画 Example '+i}));
    return [...rows,{role:'link',href:'https://www.bilibili.com/video/BVexact/',title:query}];
  };
  const proof=await fixture({query,resultTitle:'其他短片',extraResults}).go('muted',undefined,true,'副标题');
  assert.equal(proof.results[0].id,'BVexact');assert.deepEqual(proof.attempts.map(a=>a.query),[query,'动画 Example']);
});

test('placeholder anchor waits for the populated title',async()=>{
  let reads=0;
  const f=fixture({query:'Classic Film',resultTitle:'A',extraResults:()=>++reads<2?[]:[{role:'link',href:'https://www.bilibili.com/video/BVfilm/',title:'Classic Film'}]});
  const r=await f.go('muted',undefined,true);
  assert.equal(r.results[0].id,'BVfilm');assert.equal(r.exactTitleFound,true);assert.ok(reads>=2);assert.equal(r.publicIndexQuery,undefined);
});
test('only an explicitly enabled miss includes a public index query',async()=>{
  for(const allow of [false,true]){
    const r=await fixture({query:'Example：“Film”',resultTitle:'Another film'}).go('muted',undefined,true,undefined,allow);
    assert.equal(r.exactTitleFound,false);assert.equal(r.publicIndexQuery,allow?'site:bilibili.com/video Example Film':undefined);
  }
});
