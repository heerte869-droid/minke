import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {isOverview,readOverview,observeBilling} from '../browser-extension/billing-observation.js';

const overview='https://platform.openai.com/settings/organization/billing/overview';
test('background billing access distinguishes denied, missing and ambiguous tabs before reading',async t=>{
  assert.ok(isOverview(overview+'/'));assert.ok(!isOverview(overview+'-old'));assert.ok(!isOverview(overview+'#other'));
  assert.ok(!isOverview('https://platform.openai.com.evil.example/settings/organization/billing/overview'));
  let granted=false, tabs=[];t.after(()=>delete globalThis.chrome);
  globalThis.chrome={permissions:{contains:async()=>granted},tabs:{query:async()=>tabs}};
  const read=()=>observeBilling(()=>{});
  assert.equal((await read()).state,'needs_site_access');granted=true;assert.equal((await read()).state,'no_overview');
  tabs=[{id:1,url:overview},{id:2,url:overview}];assert.equal((await read()).state,'multiple_overviews');
  tabs=[{id:1,url:overview,incognito:true}];assert.equal((await read()).state,'no_overview');
});
test('billing reads only an adjacent labeled amount from a rendered document',async t=>{
  const b=await chromium.launch({executablePath:process.env.WHALE_TEST_CHROMIUM||chromium.executablePath(),headless:true});
  t.after(()=>b.close());const p=await b.newPage();await p.route(overview,r=>r.fulfill({contentType:'text/html',body:'<main></main>'}));await p.goto(overview);
  const read=async html=>{await p.locator('main').evaluate((n,s)=>n.innerHTML=s,html);return p.evaluate(readOverview,overview);};
  for(const amount of ['$0.00','$1,234.56','USD -12.50']){
    const r=await read('<section><h3>Credit balance</h3><div>'+amount+' <button>Add $50</button></div></section><section>Unrelated private information</section>');
    assert.equal(r.state,'read');assert.ok(!JSON.stringify(r).includes('private'));assert.equal(r.currency,'USD');
  }
  const wallet=await read('<h2>Free trial</h2><section><h3>Wallet balance</h3><div>$0.00<button>View usage</button></div></section>');
  const described=await read('<section><h3>Wallet balance</h3><p>Funds in your organization credit wallet.</p><strong>$1.23</strong></section><aside>Free trial</aside>');
  assert.equal(described.state,'read');assert.equal(described.amount,'1.23');
  const unrelated=await read('<section><h3>Wallet balance</h3><p>Your organization spending limit</p><strong>$900</strong></section>');
  assert.notEqual(unrelated.state,'read');
  assert.equal(wallet.state,'read');assert.equal(wallet.amount,'0.00');
  assert.equal((await read('<h2>Free trial</h2><section><p>Credit remaining</p><p>$5</p></section>')).state,'trial_credit_only');
  assert.notEqual((await read('<p>Credit balance</p><button>Pay $10</button>')).state,'read');
  assert.notEqual((await read('<p>Credit balance</p><p>Current usage $10</p>')).state,'read');
  assert.notEqual((await read('<section><b>Credit balance</b><i>$2</i></section><section><b>Available balance</b><i>$3</i></section>')).state,'read');
});