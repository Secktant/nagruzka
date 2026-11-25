import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSnapshots, saveSnapshots, fetchSnapshots } from '../tools/backup/backup.mjs';
import { deriveKey, sealGCM, decryptToText } from '../js/crypto.js';

const row = (id = 'a', version = '1') => ({
  backup_id: id.repeat(64), version, updated_at: '2026-11-14T00:00:00Z',
  salt: Buffer.alloc(16, 1).toString('base64'), blob: Buffer.alloc(30, 2).toString('base64'),
});
const payload = (...snapshots) => ({ format: 1, count: snapshots.length, snapshots });
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'nagruzka-backup-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('новые ID появляются автоматически; повтор стабилен; удалённые строки сохраняются', async t => {
  const path = await directory(t);
  await writeFile(join(path, 'latest.nz'), 'previous backup');
  await saveSnapshots(payload(row('a'), row('b')), path);
  const firstIndex = await readFile(join(path, 'index.json'), 'utf8');
  await saveSnapshots(payload(row('b'), row('a')), path);
  assert.equal(await readFile(join(path, 'index.json'), 'utf8'), firstIndex);
  await saveSnapshots(payload(row('b', '2'), row('c')), path);
  assert.equal((await readdir(join(path, 'snapshots'))).length, 6);
  assert.equal(await readFile(join(path, 'latest.nz'), 'utf8'), 'previous backup');
  const index = JSON.parse(await readFile(join(path, 'index.json'), 'utf8'));
  assert.deepEqual(index.snapshots.map(item => item.backup_id), ['b'.repeat(64), 'c'.repeat(64)]);
});

test('структурная ошибка второй строки не изменяет первую и индекс', async t => {
  const path = await directory(t);
  await saveSnapshots(payload(row()), path);
  const index = await readFile(join(path, 'index.json'), 'utf8');
  const snapshot = await readFile(join(path, 'snapshots', 'a'.repeat(64) + '.json'), 'utf8');
  await assert.rejects(saveSnapshots(payload(row('a', '2'), { ...row('b'), backup_id: ['b'.repeat(64)] }), path));
  assert.equal(await readFile(join(path, 'index.json'), 'utf8'), index);
  assert.equal(await readFile(join(path, 'snapshots', 'a'.repeat(64) + '.json'), 'utf8'), snapshot);
});

test('отклоняет пустые/неполные ответы, дубликаты, пути, неверные версии и типы', () => {
  const invalid = [
    payload(), { ...payload(row()), count: 2 }, payload(row(), row()),
    payload({ ...row(), backup_id: '../outside' }), payload({ ...row(), version: '1.5' }),
    payload({ ...row(), version: 9007199254740992 }), payload({ ...row(), updated_at: 'bad' }),
    payload({ ...row(), salt: null }), payload({ ...row(), blob: [] }),
    payload({ ...row('b'), backup_id: ['b'.repeat(64)] }, row('a')),
  ];
  for (const data of invalid) assert.throws(() => prepareSnapshots(data));
  assert.equal(prepareSnapshots(payload(row('a', '9007199254740993')))[0].metadata.version, '9007199254740993');
});

test('проекция ответа не переносит случайные секретные поля в файлы', () => {
  const [result] = prepareSnapshots(payload({ ...row(), id: 'synthetic-private-id', token: 'synthetic-token' }));
  assert.equal(result.json.includes('synthetic'), false);
});

test('ошибка файловой записи прерывает бэкап', async t => {
  const path = await directory(t);
  await writeFile(join(path, 'snapshots'), 'blocked');
  await assert.rejects(saveSnapshots(payload(row()), path));
  assert.deepEqual(await readdir(path), ['snapshots']);
});

test('RPC передаёт токен только в теле запроса; HTTP 401 завершает выгрузку ошибкой', async () => {
  const config = { url: 'https://example.invalid', anon: 'public-key', token: 'f'.repeat(64) };
  let calls = 0;
  const request = async (url, options) => {
    calls++;
    assert.equal(url.pathname, '/rest/v1/rpc/backup_export');
    assert.equal(url.search, '');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { p_token: config.token });
    return new Response('sensitive response', { status: 401 });
  };
  await assert.rejects(fetchSnapshots(config, request), error => !error.message.includes('sensitive'));
  assert.equal(calls, 1);
  assert.deepEqual(await fetchSnapshots(config, async () => Response.json(payload(row()))), payload(row()));
});

test('NZENC1 открывается настоящей криптографией с текущим, legacy и старым AAD', async () => {
  const source = await readFile(new URL('../js/vendor/argon2.umd.min.js', import.meta.url), 'utf8');
  new Function('self', 'window', 'globalThis', source)(globalThis, globalThis, globalThis);
  const salt = Buffer.alloc(16, 1), password = 'synthetic-backup-test';
  for (const [aad, keyfile] of [['nagruzka:main', undefined], [undefined, undefined], ['old-chunk-id', Buffer.alloc(32, 3)]]) {
    const key = await deriveKey(password, keyfile, salt);
    const text = JSON.stringify({ records: [{ amount: 100 }] });
    const blob = await sealGCM(key, text, aad);
    const [snapshot] = prepareSnapshots(payload({ ...row(), blob: Buffer.from(blob).toString('base64') }));
    assert.equal(snapshot.nz.subarray(0, 7).toString('hex'), '4e5a454e433101');
    assert.equal(await decryptToText(snapshot.nz, password, keyfile, aad), text);
  }
});


test('невалидные тестовые строки архивируются отдельно, сохраняя хорошие копии', async t => {
  const path = await directory(t);
  await saveSnapshots(payload(row('a')), path);
  const previous = await readFile(join(path, 'snapshots', 'a'.repeat(64) + '.nz'));
  const result = await saveSnapshots(payload({ ...row('a', '2'), salt: 'bad' }, row('b')), path);
  assert.deepEqual(result, { count: 2, rejected: 1 });
  assert.deepEqual(await readFile(join(path, 'snapshots', 'a'.repeat(64) + '.nz')), previous);
  assert.equal(JSON.parse(await readFile(join(path, 'snapshots', 'a'.repeat(64) + '.json'))).version, '1');
  const rejected = JSON.parse(await readFile(join(path, 'rejected', 'a'.repeat(64) + '.json')));
  assert.equal(rejected.salt, 'bad');
  assert.equal(rejected.restorable, false);
  const index = JSON.parse(await readFile(join(path, 'index.json')));
  assert.deepEqual(index.snapshots.map(item => item.restorable), [false, true]);
  for (const invalid of [
    { salt: Buffer.alloc(15).toString('base64') },
    { blob: Buffer.alloc(27).toString('base64') }, { blob: row().blob + '\n' },
  ]) assert.equal(prepareSnapshots(payload({ ...row(), ...invalid }))[0].metadata.restorable, false);
});
