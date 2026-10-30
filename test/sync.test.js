// Тесты чистых помощников синхронизации (app/js/sync.js) и сериализации бэкапа
// (app/js/db.js → exportState). Сеть и IndexedDB не трогаем — только детерминированные
// функции: Sync ID, id чанка (SHA-256), base64url, формат экспорта.
// crypto.subtle.digest в Node 26 глобален. Запуск: из app/ — `node --test`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  isValidSyncId,
  generateSyncId,
  deriveChunkId,
  CHUNK_NAGRUZKA,
  CHUNK_META,
  _b64url,
  AAD_MAIN,
} from '../js/sync.js';
import { exportState } from '../js/db.js';
import { sealGCM, openGCM } from '../js/crypto.js';

// ─────────────────────────────────────────────────────────────────────────────
describe('base64url (_b64url) — url-safe без паддинга', () => {
  test('roundtrip произвольных байтов', () => {
    for (const len of [1, 16, 31, 32, 33, 64]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
      const enc = _b64url.enc(bytes);
      assert.deepEqual([..._b64url.dec(enc)], [...bytes]);
    }
  });
  test('нет символов +, /, = (безопасно для URL и имени файла)', () => {
    const bytes = new Uint8Array(48).map((_, i) => (i * 251) & 0xff); // провоцируем +//
    const enc = _b64url.enc(bytes);
    assert.doesNotMatch(enc, /[+/=]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Sync ID', () => {
  test('generateSyncId даёт валидный 32-байтный id', () => {
    const id = generateSyncId();
    assert.equal(isValidSyncId(id), true);
    assert.equal(_b64url.dec(id).length, 32);
  });
  test('два вызова дают разные id', () => {
    assert.notEqual(generateSyncId(), generateSyncId());
  });
  test('isValidSyncId: длина ровно 32 байта', () => {
    assert.equal(isValidSyncId(_b64url.enc(new Uint8Array(31))), false);
    assert.equal(isValidSyncId(_b64url.enc(new Uint8Array(33))), false);
    assert.equal(isValidSyncId(_b64url.enc(new Uint8Array(32))), true);
  });
  test('isValidSyncId: мусор → false, без исключений', () => {
    assert.equal(isValidSyncId(''), false);
    assert.equal(isValidSyncId('!!! не base64 !!!'), false);
    assert.equal(isValidSyncId(undefined), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('deriveChunkId — локатор ячейки = base64url(SHA-256(SyncID+label))', () => {
  const syncId = 'TESTSYNCID1234567890';

  test('детерминизм: тот же вход → тот же id', async () => {
    const a = await deriveChunkId(syncId, CHUNK_NAGRUZKA);
    const b = await deriveChunkId(syncId, CHUNK_NAGRUZKA);
    assert.equal(a, b);
  });

  test('разные метки → разные ячейки (данные vs мета не пересекаются)', async () => {
    const data = await deriveChunkId(syncId, CHUNK_NAGRUZKA);
    const meta = await deriveChunkId(syncId, CHUNK_META);
    assert.notEqual(data, meta);
  });

  test('разные Sync ID → разные ячейки', async () => {
    const a = await deriveChunkId('aaa', CHUNK_NAGRUZKA);
    const b = await deriveChunkId('bbb', CHUNK_NAGRUZKA);
    assert.notEqual(a, b);
  });

  // Ключевой инвариант: id должен совпадать с бэкап-Action (shell/openssl) байт-в-байт.
  // Независимо считаем ту же величину через node:crypto — если разойдётся, бэкап пойдёт
  // не в ту ячейку.
  test('совпадает с независимым SHA-256 → base64url (как в Action)', async () => {
    for (const label of [CHUNK_NAGRUZKA, CHUNK_META]) {
      const expected = createHash('sha256').update(syncId + label, 'utf8').digest('base64url');
      assert.equal(await deriveChunkId(syncId, label), expected);
    }
  });

  test('id — валидный base64url без +/=', async () => {
    const id = await deriveChunkId(syncId, CHUNK_NAGRUZKA);
    assert.doesNotMatch(id, /[+/=]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('exportState — формат резервной копии', () => {
  const state = {
    settings: { salary: 100000, banks: ['Альфа'], startPeriod: '2026-01-15' },
    regulars: [{ id: 'salary', name: 'ЗП', kind: 'income', amount: 100000, schedule: 'both', bank: null, active: true }],
    installments: [{ id: 'i1', name: 'iPhone', total: 60000, perPeriod: 20000, firstPeriod: '2026-01-15', bank: 'Тбанк', plan: null }],
    records: [{ id: 'r1', period: '2026-01-15', installmentId: 'i1', amount: 20000, bank: 'Тбанк', paid: true }],
  };

  test('валидный JSON с сигнатурой app/version', () => {
    const parsed = JSON.parse(exportState(state));
    assert.equal(parsed.app, 'nagruzka');
    assert.equal(parsed.version, 1);
    assert.match(parsed.exportedAt, /^\d{4}-\d{2}-\d{2}T/); // ISO-время
  });

  test('переносит все четыре раздела состояния без потерь', () => {
    const parsed = JSON.parse(exportState(state));
    assert.deepEqual(parsed.settings, state.settings);
    assert.deepEqual(parsed.regulars, state.regulars);
    assert.deepEqual(parsed.installments, state.installments);
    assert.deepEqual(parsed.records, state.records);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AAD чанка данных. С 1.8.3 это МЕТКА КОНТЕКСТА, а не id ячейки: привязка к id
// требовала Sync ID при восстановлении бэкапа, а защищала только от подмены
// блоба другой ячейкой того же ключа — которой в «Нагрузке» нет.
// Проверяем: новый формат читается, СТАРЫЙ тоже (иначе после обновления
// приложение не откроет то, что уже лежит на сервере), а чужой ключ — нет.
describe('AAD чанка: метка вместо id ячейки', () => {
  const KEY_BITS = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);
  const OTHER_BITS = new Uint8Array(32).map((_, i) => (i * 11 + 5) & 0xff);
  const key = (bits) => crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);

  test('AAD_MAIN — это метка чанка, а не хеш от Sync ID', async () => {
    assert.equal(AAD_MAIN, CHUNK_NAGRUZKA);
    const id = await deriveChunkId(generateSyncId(), CHUNK_NAGRUZKA);
    assert.notEqual(AAD_MAIN, id, 'метка не должна зависеть от Sync ID');
  });

  test('блоб новой схемы открывается без Sync ID', async () => {
    const k = await key(KEY_BITS);
    const sealed = await sealGCM(k, '{"app":"nagruzka"}', AAD_MAIN);
    assert.equal(await openGCM(k, sealed, AAD_MAIN), '{"app":"nagruzka"}');
  });

  test('блоб старой схемы (AAD = id ячейки) по-прежнему читается своим id', async () => {
    const k = await key(KEY_BITS);
    const id = await deriveChunkId('U'.repeat(43), CHUNK_NAGRUZKA);
    const sealed = await sealGCM(k, '{"старый":true}', id);
    await assert.rejects(() => openGCM(k, sealed, AAD_MAIN), 'меткой старый блоб не открыть');
    assert.equal(await openGCM(k, sealed, id), '{"старый":true}');
  });

  test('чужой ключ не открывает блоб, даже зная метку', async () => {
    const sealed = await sealGCM(await key(KEY_BITS), '{"мои":"деньги"}', AAD_MAIN);
    const other = await key(OTHER_BITS);
    await assert.rejects(() => openGCM(other, sealed, AAD_MAIN));
  });
});
