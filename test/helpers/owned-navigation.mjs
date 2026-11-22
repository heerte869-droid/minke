import assert from 'node:assert/strict';

// Test-only barrier for the two connections to our disposable browser. Cached
// URL equality (including same-URL reloads) must not stand in for a fresh event.
export async function gotoOwnedFixture(ownerPage, adapterPage, url) {
  const expected = new URL(url).href;
  const adapterNavigated = adapterPage.waitForEvent('framenavigated', {
    predicate: frame => frame === adapterPage.mainFrame() && frame.url() === expected,
    timeout: 5000,
  });
  // Subscribe before navigating; neither connection alone is a completion oracle.
  await Promise.all([adapterNavigated, Promise.resolve().then(() => ownerPage.goto(expected))]);
  assert.equal(ownerPage.url(), expected);
  assert.equal(adapterPage.url(), expected);
}
