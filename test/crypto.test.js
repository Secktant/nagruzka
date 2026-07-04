// Тесты крипто-ядра (app/js/crypto.js). WebCrypto (crypto.subtle) в Node 26 глобален,
// Argon2 поднимаем из vendor-UMD в globalThis.hashwasm (как в браузере через <script>).
// Покрываем: файловый формат .nz (Argon2id + AES-GCM), keyfile как второй фактор,
// сессионный AES-слой синка (sealGCM/openGCM) и привязку к чанку через AAD.
//
// Argon2id здесь настоящий (64 МБ, 3 прохода ~0.3–0.5 c на вызов), поэтому число
// деривирующих тестов держим небольшим. Запуск: из app/ — `node --test`.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  deriveKeyRaw,
  importAesKey,
  encryptText,
  decryptToText,
  inspect,
  sealGCM,
  openGCM,
  generateKeyfile,
} from '../js/crypto.js';

// Поднять Argon2 в globalThis.hashwasm до первого вызова деривации.
before(() => {
  const path = fileURLToPath(new URL('../js/vendor/argon2.umd.min.js', import.meta.url));
  const src = readFileSync(path, 'utf8');
  const g = globalThis;
  new Function('self', 'window', 'globalThis', src)(g, g, g);
  assert.equal(typeof g.hashwasm?.argon2id, 'function', 'Argon2 не загрузился');
});

const te = new TextEncoder();
const salt16 = () => new Uint8Array(16).fill(7); // фиксированная соль для детерминизма

// ─────────────────────────────────────────────────────────────────────────────
describe('sealGCM / openGCM — сессионный AES-слой синка', () => {
  test('roundtrip: что запечатали, то и открыли', async () => {
    const key = await importAesKey(new Uint8Array(32).fill(1));
    const sealed = await sealGCM(key, 'привет, мир');
    assert.ok(sealed instanceof Uint8Array);
    assert.ok(sealed.length > 12); // iv(12) + шифротекст + тег
    assert.equal(await openGCM(key, sealed), 'привет, мир');
  });

  test('чужой ключ не открывает', async () => {
    const k1 = await importAesKey(new Uint8Array(32).fill(1));
    const k2 = await importAesKey(new Uint8Array(32).fill(2));
    const sealed = await sealGCM(k1, 'секрет');
    await assert.rejects(() => openGCM(k2, sealed), /расшифровать/);
  });

  test('AAD привязывает шифротекст к ячейке чанка', async () => {
    const key = await importAesKey(new Uint8Array(32).fill(3));
    const sealed = await sealGCM(key, 'данные чанка', 'chunk-A');
    // тем же AAD — открывается
    assert.equal(await openGCM(key, sealed, 'chunk-A'), 'данные чанка');
    // другим AAD — подмена в чужой чанк отбивается GCM-тегом
    await assert.rejects(() => openGCM(key, sealed, 'chunk-B'), /расшифровать/);
    // без AAD, когда запечатано С ним — тоже мимо
    await assert.rejects(() => openGCM(key, sealed), /расшифровать/);
  });

  test('каждый seal со свежим IV → разный шифротекст того же текста', async () => {
    const key = await importAesKey(new Uint8Array(32).fill(4));
    const a = await sealGCM(key, 'одно и то же');
    const b = await sealGCM(key, 'одно и то же');
    assert.notDeepEqual([...a], [...b]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('inspect — разбор заголовка .nz без расшифровки', () => {
  test('битые/чужие байты отвергаются', () => {
    assert.throws(() => inspect(new Uint8Array(10)), /не зашифрованный файл/);
    assert.throws(() => inspect(te.encode('это просто текст, не nz-файл вовсе')), /не зашифрованный файл/);
  });

  test('флаг keyfile читается из заголовка', async () => {
    const noKf = await encryptText('{"a":1}', 'пароль', null);
    assert.equal(inspect(noKf).needsKeyfile, false);

    const kf = generateKeyfile();
    const withKf = await encryptText('{"a":1}', 'пароль', kf);
    assert.equal(inspect(withKf).needsKeyfile, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('deriveKeyRaw — Argon2id детерминизм и факторы', () => {
  test('одинаковые пароль+соль+keyfile → одинаковые 32 байта', async () => {
    const s = salt16();
    const a = await deriveKeyRaw('пароль', null, s);
    const b = await deriveKeyRaw('пароль', null, s);
    assert.equal(a.length, 32);
    assert.deepEqual([...a], [...b]);
  });

  test('другой пароль → другой ключ', async () => {
    const s = salt16();
    const a = await deriveKeyRaw('пароль-1', null, s);
    const b = await deriveKeyRaw('пароль-2', null, s);
    assert.notDeepEqual([...a], [...b]);
  });

  test('keyfile — второй фактор: тот же пароль, но с keyfile → другой ключ', async () => {
    const s = salt16();
    const kf = new Uint8Array(32).fill(9);
    const noKf = await deriveKeyRaw('пароль', null, s);
    const withKf = await deriveKeyRaw('пароль', kf, s);
    assert.notDeepEqual([...noKf], [...withKf]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('encryptText / decryptToText — полный файловый цикл .nz', () => {
  test('roundtrip без keyfile', async () => {
    const plain = JSON.stringify({ settings: { salary: 123 }, records: [] });
    const file = await encryptText(plain, 'секрет', null);
    assert.equal(await decryptToText(file, 'секрет', null), plain);
  });

  test('неверный пароль отвергается', async () => {
    const file = await encryptText('{"x":1}', 'верный', null);
    await assert.rejects(() => decryptToText(file, 'неверный', null), /Не удалось расшифровать/);
  });

  test('roundtrip с keyfile; без keyfile тот же пароль не открывает', async () => {
    const kf = generateKeyfile();
    const plain = '{"secret":true}';
    const file = await encryptText(plain, 'пароль', kf);
    assert.equal(await decryptToText(file, 'пароль', kf), plain);
    await assert.rejects(() => decryptToText(file, 'пароль', null), /Не удалось расшифровать/);
  });
});
