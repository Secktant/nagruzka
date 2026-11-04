import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SyncEngine, AAD_MAIN } from '../js/sync.js';
import { importAesKey, deriveKey, sealGCM, openGCM, b64 } from '../js/crypto.js';
import { exportState } from '../js/db.js';

const key = await importAesKey(new Uint8Array(32).fill(7));
new Function('self', 'window', 'globalThis', readFileSync(new URL('../js/vendor/argon2.umd.min.js', import.meta.url), 'utf8'))(globalThis, globalThis, globalThis);
const salt = new Uint8Array(16).fill(9);
const snapshot = (id) => exportState({
  settings: { salary: 100, banks: [], startPeriod: '2026-01-15' },
  regulars: [], installments: [], history: [],
  records: [{ id, amount: 100, period: '2026-01-15', paid: false }],
});
const recordId = (json) => JSON.parse(json).records[0].id;
const sealed = async (json, version, aad = AAD_MAIN) => ({
  salt: b64.enc(salt), blob: b64.enc(await sealGCM(key, json, aad)), version,
});
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
let server, offline, calls, engines, originalFetch, journals, enabled, savedCount;
beforeEach(async () => {
  originalFetch = globalThis.fetch;
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  globalThis.window = new EventTarget();
  server = await sealed(snapshot('base'), 1);
  offline = false; calls = []; engines = []; journals = new Map(); enabled = true; savedCount = 0;
  globalThis.fetch = async (url, options) => {
    const fn = url.split('/').pop(), body = JSON.parse(options.body);
    calls.push({ fn, ...body });
    if (offline) throw new TypeError('synthetic offline');
    let result;
    if (fn === 'sync_pull') result = server ? [structuredClone(server)] : [];
    else if (fn === 'sync_push') {
      if (body.p_base_version !== (server?.version || 0)) result = [{ ok: false, ...server }];
      else {
        server = { salt: body.p_salt, blob: body.p_blob, version: (server?.version || 0) + 1 };
        result = [{ ok: true, version: server.version }];
      }
    } else if (fn === 'sync_meta_get' || fn === 'sync_meta_init') result = b64.enc(salt);
    else throw new Error('Unexpected RPC: ' + fn);
    return { ok: true, json: async () => result };
  };
});
afterEach(async () => {
  for (const engine of engines) await engine.stop();
  globalThis.fetch = originalFetch;
  delete globalThis.document; delete globalThis.window;
});

async function device(local = { json: snapshot('base') }, overrides = {}) {
  const statuses = [];
  const engine = new SyncEngine({
    getStateJSON: () => local.json,
    applyStateJSON: async (json, isCurrent = () => true) => {
      if (!isCurrent()) return false;
      local.json = json;
      return true;
    },
    loadSyncState: async id => structuredClone(journals.get(id)),
    saveSyncState: async (id, state) => { journals.set(id, structuredClone(state)); },
    setEnabled: async value => { enabled = value; },
    flushLocalChanges: async () => {},
    onStatus: s => statuses.push(s),
    onSaved: () => { savedCount++; },
    ...overrides,
  });
  await engine.prepare('synthetic-device-id');
  engine.key = key; engine.salt = salt;
  await engine.start(); engines.push(engine);
  return { engine, local, statuses, status: () => statuses.at(-1) };
}

test('офлайн-правка переживает перезапуск и отправляется поверх прежней базы', async () => {
  const a = await device();
  await a.engine.pullAndApply();
  a.local.json = snapshot('local-new'); a.engine.notifyLocalChange();
  offline = true;
  await a.engine.pushNow();
  assert.equal(a.status(), 'offline');
  await a.engine.stop();
  const b = await device(a.local);
  offline = false;
  await b.engine.pullAndApply();
  assert.equal(recordId(b.local.json), 'local-new');
  assert.equal(recordId(await openGCM(key, b64.dec(server.blob), AAD_MAIN)), 'local-new');
  assert.equal(b.status(), 'synced');
});

test('push и pull сериализованы: снимок отправляется с исходной базовой версией', async () => {
  const a = await device(); await a.engine.pullAndApply();
  a.local.json = snapshot('local-new');
  server = await sealed(snapshot('other-device'), 2);
  const entered = deferred(), gate = deferred();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  crypto.subtle.encrypt = async (...args) => { entered.resolve(); await gate.promise; return encrypt(...args); };
  try {
    const sending = a.engine.pushNow(); await entered.promise;
    const receiving = a.engine.pullAndApply();
    await new Promise(r => setImmediate(r));
    gate.resolve(); await Promise.all([sending, receiving]);
    assert.equal(calls.find(c => c.fn === 'sync_push').p_base_version, 1);
    assert.equal(recordId(a.local.json), 'local-new');
    assert.equal(recordId(await openGCM(key, b64.dec(server.blob), AAD_MAIN)), 'other-device');
    assert.equal(a.status(), 'conflict');
  } finally { gate.resolve(); crypto.subtle.encrypt = encrypt; }
});

test('отказ записи не подтверждает серверную версию; следующая попытка применяет её', async () => {
  let fail = false, attempts = 0;
  const local = { json: snapshot('base') };
  const a = await device(local, { applyStateJSON: async json => {
    attempts++;
    if (fail) throw new Error('synthetic disk full');
    local.json = json; return true;
  } });
  await a.engine.pullAndApply();
  const before = attempts;
  server = await sealed(snapshot('other-device'), 2); fail = true;
  await a.engine.pullAndApply();
  assert.equal(a.engine.version, 1);
  assert.notEqual(a.status(), 'synced');
  assert.equal(recordId(local.json), 'base');
  fail = false; await a.engine.pullAndApply();
  assert.equal(attempts, before + 2);
  assert.equal(a.engine.version, 2);
  assert.equal(recordId(local.json), 'other-device');
});

test('stop отменяет отложенную отправку и не отправляет последующие правки', async t => {
  const a = await device(); await a.engine.pullAndApply();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  a.local.json = snapshot('local-new'); a.engine.notifyLocalChange();
  await a.engine.stop();
  a.engine.notifyLocalChange();
  t.mock.timers.tick(2000);
  await new Promise(r => setImmediate(r));
  await a.engine.pushNow(); await a.engine.pullAndApply();
  assert.equal(calls.filter(c => c.fn === 'sync_push').length, 0);
  assert.equal(enabled, false);
});

test('конфликт хранит обе копии через перезапуск и не разрешается фоновым опросом', async () => {
  const a = await device(); await a.engine.pullAndApply();
  a.local.json = snapshot('local-new'); a.engine.notifyLocalChange();
  server = await sealed(snapshot('other-device'), 2);
  await a.engine.pullAndApply();
  assert.equal(a.status(), 'conflict');
  await a.engine.stop();
  const b = await device(a.local);
  offline = true;
  await b.engine.pullAndApply();
  const copies = await b.engine.getConflictCopies();
  assert.equal(recordId(copies.local), 'local-new');
  assert.equal(recordId(copies.remote), 'other-device');
  assert.equal(b.status(), 'conflict');
  assert.doesNotMatch(JSON.stringify([...journals.values()]), /other-device|local-new/);
});

test('выбор серверной копии применяется только явно и сохраняет правильную базу', async () => {
  const a = await device(); await a.engine.pullAndApply();
  a.local.json = snapshot('local-new');
  server = await sealed(snapshot('other-device'), 2);
  await a.engine.pushNow();
  assert.equal(recordId(a.local.json), 'local-new');
  assert.equal(await a.engine.resolveConflict('remote'), true);
  assert.equal(recordId(a.local.json), 'other-device');
  assert.equal(a.engine.version, 2);
  assert.equal(a.engine.conflict, null);
  await a.engine.stop();
  const b = await device(a.local); await b.engine.pullAndApply();
  assert.equal(b.status(), 'synced');
});

test('выбор локальной копии сохраняет конфликт при сбое сети и проверяет версию сервера', async () => {
  const a = await device(); await a.engine.pullAndApply();
  a.local.json = snapshot('local-new');
  server = await sealed(snapshot('other-device'), 2);
  await a.engine.pullAndApply();
  offline = true;
  await assert.rejects(a.engine.resolveConflict('local'));
  assert.ok(a.engine.conflict);
  offline = false;
  server = await sealed(snapshot('even-newer'), 3);
  assert.equal(await a.engine.resolveConflict('local'), false);
  assert.equal(recordId((await a.engine.getConflictCopies()).remote), 'even-newer');
  assert.equal(recordId(a.local.json), 'local-new');
  assert.equal(await a.engine.resolveConflict('local'), true);
  assert.equal(recordId(await openGCM(key, b64.dec(server.blob), AAD_MAIN)), 'local-new');
});

test('новая правка во время отправки остаётся pending без ложного подтверждения', async () => {
  const a = await device(); await a.engine.pullAndApply();
  a.local.json = snapshot('first-edit');
  const entered = deferred(), gate = deferred();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    if (args[0].endsWith('sync_push')) { entered.resolve(); await gate.promise; }
    return fetch(...args);
  };
  const sending = a.engine.pushNow(); await entered.promise;
  a.local.json = snapshot('second-edit'); a.engine.notifyLocalChange();
  gate.resolve(); await sending;
  assert.equal(a.status(), 'pending'); assert.equal(savedCount, 0);
  await a.engine.pullAndApply();
  assert.equal(recordId(await openGCM(key, b64.dec(server.blob), AAD_MAIN)), 'second-edit');
  assert.equal(a.status(), 'synced'); assert.equal(savedCount, 1);
});

test('правка во время pull не заменяется входящим снимком', async () => {
  const a = await device(); await a.engine.pullAndApply();
  server = await sealed(snapshot('other-device'), 2);
  const entered = deferred(), gate = deferred(), fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { entered.resolve(); await gate.promise; return fetch(...args); };
  const receiving = a.engine.pullAndApply(); await entered.promise;
  a.local.json = snapshot('local-new'); a.engine.notifyLocalChange();
  gate.resolve(); await receiving;
  assert.equal(recordId(a.local.json), 'local-new'); assert.equal(a.status(), 'conflict');
});

test('stop игнорирует даже ответ сети, которая не поддерживает AbortSignal', async () => {
  const a = await device(); await a.engine.pullAndApply();
  server = await sealed(snapshot('other-device'), 2);
  const entered = deferred(), gate = deferred(), fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { entered.resolve(); await gate.promise; return fetch(...args); };
  const receiving = a.engine.pullAndApply(); await entered.promise;
  await a.engine.stop(); gate.resolve(); await receiving;
  assert.equal(recordId(a.local.json), 'base'); assert.equal(a.status(), 'off');
  assert.equal(a.engine.version, 1);
});

test('потерянный ответ успешного push распознаётся по содержимому после перезапуска', async () => {
  const a = await device(); await a.engine.pullAndApply();
  a.local.json = snapshot('local-new');
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const result = await fetch(...args);
    if (args[0].endsWith('sync_push')) throw new TypeError('lost reply');
    return result;
  };
  await a.engine.pushNow(); assert.equal(a.status(), 'offline');
  await a.engine.stop(); globalThis.fetch = fetch;
  const b = await device(a.local); await b.engine.pullAndApply();
  assert.equal(b.status(), 'synced'); assert.equal(b.engine.conflict, null);
  assert.equal(recordId(b.local.json), 'local-new');
});

test('сбой сохранения базы не выдаётся за успех; подтверждение можно повторить', async () => {
  let fail = false;
  const a = await device(undefined, { saveSyncState: async (id, data) => {
    if (fail) throw new Error('disk full');
    journals.set(id, structuredClone(data));
  } });
  await a.engine.pullAndApply();
  a.local.json = snapshot('local-new'); fail = true;
  await a.engine.pushNow();
  assert.equal(a.engine.version, 1); assert.equal(a.status(), 'storage-error');
  assert.equal(savedCount, 0);
  fail = false; await a.engine.pullAndApply();
  assert.equal(a.engine.version, 2); assert.equal(a.status(), 'synced');
});

test('неуспешное локальное сохранение блокирует обмен и зелёное подтверждение', async () => {
  let fail = false;
  const a = await device(undefined, { flushLocalChanges: async () => {
    if (fail) throw new Error('disk full');
  } });
  await a.engine.pullAndApply(); fail = true;
  a.local.json = snapshot('local-new');
  const before = calls.length;
  await a.engine.pushNow(); await a.engine.pullAndApply();
  assert.equal(calls.length, before); assert.equal(a.status(), 'storage-error');
  assert.equal(savedCount, 0);
});

test('обновление со старой версии без базы сохраняет отличающиеся копии', async () => {
  const a = await device({ json: snapshot('old-installation-offline-edit') });
  await a.engine.pullAndApply();
  assert.equal(a.status(), 'conflict');
  assert.equal(recordId(a.local.json), 'old-installation-offline-edit');
  assert.equal(recordId((await a.engine.getConflictCopies()).remote), 'base');
});

test('совместимость старого AAD чанка и независимость от exportedAt', async () => {
  const a = await device();
  server = await sealed(snapshot('base'), 1, a.engine.chunkId);
  await a.engine.pullAndApply();
  a.local.json = JSON.stringify({ ...JSON.parse(a.local.json), exportedAt: '1999-01-01T00:00:00Z' });
  await a.engine.pullAndApply();
  assert.equal(a.status(), 'synced');
  assert.equal(calls.filter(c => c.fn === 'sync_push').length, 0);
});

test('неверный пароль не заменяет рабочий ключ и не возобновляет обмен', async () => {
  const a = await device(); await a.engine.pullAndApply();
  await assert.rejects(a.engine.unlock('synthetic-device-id', 'synthetic-wrong-passphrase'), /расшифровать/);
  assert.equal(a.engine.key, key); assert.equal(a.engine.enabled, false);
  a.engine.notifyLocalChange(); await a.engine.pushNow();
  assert.equal(calls.filter(c => c.fn === 'sync_push').length, 0);
});

test('смена пароля сериализуется с обменом и использует настоящий Argon2/AES', async () => {
  let localKey;
  const a = await device(undefined, { onKeyChanged: async candidate => { localKey = candidate; } });
  await a.engine.pullAndApply();
  assert.equal(await a.engine.changePassword('synthetic-new-passphrase'), true);
  assert.equal(a.engine.key, localKey);
  assert.equal(recordId(await openGCM(localKey, b64.dec(server.blob), AAD_MAIN)), 'base');
  await assert.rejects(openGCM(key, b64.dec(server.blob), AAD_MAIN));
});

test('CAS-конфликт с одинаковыми данными не подтверждает смену пароля', async () => {
  let keyChanges = 0;
  const a = await device(undefined, { onKeyChanged: async () => { keyChanges++; } });
  await a.engine.pullAndApply();
  const fetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    if (args[0].endsWith('sync_push')) server.version++;
    return fetch(...args);
  };
  await assert.rejects(a.engine.changePassword('synthetic-new-password'), /не завершена/);
  assert.equal(keyChanges, 0); assert.equal(a.engine.key, key);
});

test('конфликт остаётся читаемым после подключения новым паролем другого устройства', async () => {
  const a = await device(undefined, { onKeyChanged: async (_key, _salt, extra) => {
    journals.set(extra.chunkId, structuredClone(extra.journal));
  } });
  await a.engine.pullAndApply();
  a.local.json = snapshot('local-new');
  server = await sealed(snapshot('other-device'), 2);
  await a.engine.pullAndApply();
  const newKey = await deriveKey('synthetic-new-password', null, salt);
  server = { ...server, version: 3, blob: b64.enc(await sealGCM(newKey, snapshot('other-device'), AAD_MAIN)) };
  await a.engine.unlock('synthetic-device-id', 'synthetic-new-password');
  const copies = await a.engine.getConflictCopies();
  assert.equal(recordId(copies.local), 'local-new');
  assert.equal(recordId(copies.remote), 'other-device');
  const persisted = journals.get(a.engine.chunkId);
  assert.equal(recordId(await openGCM(newKey, b64.dec(persisted.conflict.blob), AAD_MAIN)), 'other-device');
});
