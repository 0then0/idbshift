import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('Historical Dexie baseline stays explicit and Playwright browser packages stay aligned', () => {
  const lock = JSON.parse(
    readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'),
  );
  assert.equal(
    lock.packages[''].devDependencies.dexie,
    '4.4.7',
    'Changing the historical experiment requires an explicit baseline review',
  );
  assert.equal(lock.packages['node_modules/dexie'].version, '4.4.7');
  const playwright = lock.packages['node_modules/@playwright/test'].version;
  assert.equal(lock.packages['node_modules/playwright'].version, playwright);
  assert.equal(lock.packages['node_modules/playwright-core'].version, playwright);
});
