import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';

test('popup supports keyboard sharing, pending input, focus recovery and errors',async t=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.WHALE_TEST_CHROMIUM || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:320,height:250},reducedMotion:'reduce'});
  await page.addInitScript(()=>{
    const fixture=window.popupFixture={calls:[],fail:false,release:null,
      state:{id:12,generation:3,connected:false,connecting:false,shareable:true,here:true,title:'项目文档',site:'example.org'}};
    Object.defineProperty(window.chrome,'runtime',{configurable:true,value:{async sendMessage(message){
      if(message.op==='status')return {...fixture.state};
      fixture.calls.push(message.op);
      await new Promise(resolve=>{fixture.release=resolve});
      if(fixture.fail)return {error:'连接已断开'};
      fixture.state.connected=message.op==='connect';
      fixture.state.generation++;
      return {ok:true};
    }}});
  });
  await page.goto(new URL('../browser-extension/popup.html',import.meta.url).href);
  const share=page.getByRole('button',{name:'共享当前页'}),stop=page.getByRole('button',{name:'停止共享'});
  await page.getByText('未共享',{exact:true}).waitFor();
  assert.deepEqual(await page.locator('button:visible').allTextContents(),['共享当前页']);
  await share.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.popupFixture.release!==null);
  assert.ok(await share.isDisabled());
  await share.evaluate(b=>b.click());
  assert.deepEqual(await page.evaluate(()=>window.popupFixture.calls),['connect']);
  await page.evaluate(()=>window.popupFixture.release());
  await stop.waitFor();
  assert.deepEqual(await page.locator('button:visible').allTextContents(),['停止共享']);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'stop');
  await page.evaluate(()=>{window.popupFixture.fail=true;window.popupFixture.release=null});
  await page.keyboard.press('Space');
  await page.waitForFunction(()=>window.popupFixture.release!==null);
  await page.evaluate(()=>window.popupFixture.release());
  await page.getByText('连接已断开',{exact:true}).waitFor();
  assert.ok(await stop.isEnabled());
  assert.equal(await page.locator('output').getAttribute('role'),'status');
});
