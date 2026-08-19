// IndexedDB-хранилище. Стора: kv (настройки), regulars, installments, records.
// Этап 4b: при настроенном ключе данные лежат не плейнтекстом, а одним зашифрованным
// снимком в kv 'vault' (см. saveVault/loadVault), плейнтекст-стора пусты.

import { sealGCM, openGCM } from './crypto.js';

const DB_NAME = 'nagruzka';
const DB_VERSION = 1;
const STORES = ['regulars', 'installments', 'records'];
const VAULT_AAD = 'nz:vault';

const sortRecords = (records) =>
  records.slice().sort((a, b) => a.period < b.period ? -1 : a.period > b.period ? 1 : 0);

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('kv');
      for (const s of STORES) db.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    fn(t.objectStore(store));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

function getAll(db, store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getKV(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('kv').objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function initStore(seed) {
  const db = await openDB();
  const settings = await getKV(db, 'settings');
  const vaultActive = await getKV(db, 'vaultActive');
  // не сеять поверх зашифрованного сейфа (плейнтекст-настройки удалены при миграции)
  if (!settings && !vaultActive) await writeAll(db, seed);
  return db;
}

async function writeAll(db, data) {
  await tx(db, 'kv', 'readwrite', s => {
    s.put(data.settings, 'settings');
    s.put(data.history || [], 'history');   // лог не массив записей, а одно значение — ему хватает kv
  });
  for (const name of STORES) {
    await tx(db, name, 'readwrite', s => {
      s.clear();
      (data[name] || []).forEach(r => s.put(r));
    });
  }
}

export async function loadState(db) {
  const [settings, regulars, installments, records, history] = await Promise.all([
    getKV(db, 'settings'),
    getAll(db, 'regulars'),
    getAll(db, 'installments'),
    getAll(db, 'records'),
    getKV(db, 'history'),
  ]);
  return { settings, regulars, installments, records: sortRecords(records), history: history || [] };
}

// --- Локальное шифрование «на месте» (этап 4b) ---
// Сейф = весь снимок состояния, зашифрованный ключом синка (AES-GCM + AAD-привязка).
// Когда сейф активен, плейнтекст-стора пусты, истина — в kv 'vault'.
export async function saveVault(db, key, state) {
  const blob = await sealGCM(key, exportState(state), VAULT_AAD);
  await tx(db, 'kv', 'readwrite', s => s.put(blob, 'vault'));
}
export async function loadVault(db, key) {
  const blob = await getKV(db, 'vault');
  if (!blob) return null;
  const d = JSON.parse(await openGCM(key, blob, VAULT_AAD)); // бросит при неверном ключе
  return {
    settings: d.settings,
    regulars: d.regulars || [],
    installments: d.installments || [],
    records: sortRecords(d.records || []),
    history: d.history || [],   // сейф, записанный до 1.8.0, лога не содержит
  };
}
export const hasVault = (db) => getKV(db, 'vault').then(v => !!v);

// Переход на сейф: стираем плейнтекст-данные и ставим маркер (чтобы initStore не сеял).
export async function clearPlaintextStores(db) {
  for (const name of STORES) await tx(db, name, 'readwrite', s => s.clear());
  // history тоже плейнтекст и тоже персональные данные — уносим вместе с settings,
  // иначе после включения сейфа лог остался бы лежать в открытом виде.
  await tx(db, 'kv', 'readwrite', s => { s.delete('settings'); s.delete('history'); s.put(true, 'vaultActive'); });
}

// Сохранение БЕЗ ключа (синк/пароль ещё не настроены) — прежний плейнтекст-путь.
export const saveLegacy = (db, state) => writeAll(db, state);

// Снять сейф (при отвязке Sync ID): убрать шифроснимок и маркер. Перед вызовом
// данные обычно возвращают в плейнтекст через saveLegacy.
export const clearVault = (db) => tx(db, 'kv', 'readwrite', s => { s.delete('vault'); s.delete('vaultActive'); });

// Замок приложения (этап 5): { salt: Uint8Array, bio?: {credentialId, wrapped} }.
// Наличие записи = замок включён → на старте гейт (биометрия/пароль). В экспорт не идёт.
export const getLock = (db) => getKV(db, 'lock');
export const setLock = (db, obj) => tx(db, 'kv', 'readwrite', s => s.put(obj, 'lock'));
export const clearLock = (db) => tx(db, 'kv', 'readwrite', s => s.delete('lock'));

// keyfile — второй фактор шифрования. Хранится в kv как Uint8Array, в экспорт НЕ попадает.
export const getKeyfile = (db) => getKV(db, 'keyfile');
export const setKeyfile = (db, bytes) => tx(db, 'kv', 'readwrite', s => s.put(bytes, 'keyfile'));
export const clearKeyfile = (db) => tx(db, 'kv', 'readwrite', s => s.delete('keyfile'));

// Sync ID — локатор «ячейки» на сервере синка (этап 4b). Тоже в kv, в экспорт НЕ попадает.
export const getSyncId = (db) => getKV(db, 'syncId');
export const setSyncId = (db, str) => tx(db, 'kv', 'readwrite', s => s.put(str, 'syncId'));
export const clearSyncId = (db) => tx(db, 'kv', 'readwrite', s => s.delete('syncId'));

// Сессионный ключ синка для «запомнить на устройстве»: { key: CryptoKey (неэкспортируемый), salt }.
// Хранится в kv, в экспорт НЕ попадает. Позволяет возобновлять синк без повторного ввода пароля.
export const getSyncKey = (db) => getKV(db, 'syncKey');
export const setSyncKey = (db, obj) => tx(db, 'kv', 'readwrite', s => s.put(obj, 'syncKey'));
export const clearSyncKey = (db) => tx(db, 'kv', 'readwrite', s => s.delete('syncKey'));

export function exportState(state) {
  return JSON.stringify({
    app: 'nagruzka', version: 1, exportedAt: new Date().toISOString(),
    settings: state.settings,
    regulars: state.regulars,
    installments: state.installments,
    records: state.records,
    history: state.history || [],
  }, null, 2);
}
