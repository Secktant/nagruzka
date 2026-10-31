import { test } from 'node:test';
import assert from 'node:assert/strict';

const KEY = 'nagruzka:diagnostic-log';

function setupStorage({ failFirst = false } = {}) {
  const data = new Map();
  let writes = 0;
  globalThis.localStorage = {
    getItem: key => data.get(key) ?? null,
    setItem(key, value) {
      writes++;
      if (failFirst && writes === 1) {
        const error = new Error('quota');
        error.name = 'QuotaExceededError';
        throw error;
      }
      data.set(key, value);
    },
    removeItem: key => data.delete(key),
  };
  globalThis.window = { addEventListener() {} };
  return { data, get writes() { return writes; } };
}

async function loadFresh() {
  return import('../js/diagnostics.js?test=' + Math.random());
}

test('diagnostics caches entries and preserves boolean details', async () => {
  const storage = setupStorage();
  const log = await loadFresh();
  log.clearLog();
  log.logEvent('SYNC_RETRY', { status: false, stage: 'push' });
  assert.equal(log.getLogEntries()[0].details.status, 'false');
  assert.equal(storage.writes, 0, 'write is debounced');
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(storage.writes, 1);
  assert.equal(JSON.parse(storage.data.get(KEY))[0].details.status, 'false');
});

test('diagnostics retries quota failure with a compact recent tail', async () => {
  const storage = setupStorage({ failFirst: true });
  const log = await loadFresh();
  log.clearLog();
  for (let i = 0; i < 60; i++) log.logEvent('EVENT_' + i);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(storage.writes, 2);
  const saved = JSON.parse(storage.data.get(KEY));
  assert.equal(saved.length, 50);
  assert.equal(saved[0].event, 'EVENT_10');
  assert.equal(log.getLogEntries().length, 60, 'in-memory journal keeps the full recent history');
});

test('clearLog cancels pending writes and clears memory and disk', async () => {
  const storage = setupStorage();
  const log = await loadFresh();
  log.logEvent('PENDING');
  log.clearLog();
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.deepEqual(log.getLogEntries(), []);
  assert.equal(storage.data.has(KEY), false);
  assert.equal(storage.writes, 0);
});
