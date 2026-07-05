// Общее изменяемое состояние приложения (единый источник правды) + ядро мутаций.
// В ES-модулях нельзя переприсваивать импортированную let-привязку из другого модуля,
// поэтому состояние живёт в полях объекта S: модули читают/пишут S.state, S.timeline и т.д.

import { saveVault, saveLegacy } from './db.js';
import { buildTimeline } from './engine.js';
import { horizonEnd, TODAY } from './format.js';

export const S = {
  db: null,
  state: null,
  timeline: null,
  syncEngine: null,       // движок синка (null пока не настроен)
  vaultKey: null,         // ключ локального шифрования (= ключ синка), null пока не настроен
  vaultSalt: null,        // соль этого ключа (Uint8Array) — для синка и .nz
  currentKeyfile: null,   // кэш keyfile в памяти (для движка, который читает синхронно)
  syncStatus: 'off',      // off | locked | syncing | synced | offline | conflict | error
  view: { y: TODAY.getFullYear(), m: TODAY.getMonth() + 1, tab: 'periods', chartYear: TODAY.getFullYear() },
  zoomLevel: 1,           // текущий масштаб (для развилки раскладки «Периодов»)
};

// Пересчитать ленту периодов из текущего состояния.
export function recalc() { S.timeline = buildTimeline(S.state, horizonEnd()); }

// Персистентность (этап 4b): всё состояние сохраняется одним снимком.
// Есть ключ (синк настроен) → зашифрованный сейф (kv 'vault'); нет → плейнтекст-стора.
async function persist() {
  if (S.vaultKey) await saveVault(S.db, S.vaultKey, S.state);
  else await saveLegacy(S.db, S.state);
}

// После любого сохранения помечаем «грязным» для синка. Все мутаторы — это persist+markDirty,
// т.к. state в памяти всегда актуален (вызывающий код обновляет его до сохранения).
export const markDirty = () => S.syncEngine?.notifyLocalChange();
export const saveAll = async () => { await persist(); markDirty(); };
export const putRecord = saveAll, deleteRecord = saveAll;
export const putRegular = saveAll, deleteRegular = saveAll;
export const putInstallment = saveAll, deleteInstallment = saveAll;
export const putSettings = saveAll;

// Принять снимок из JSON (импорт файла / приём с сервера): заменить состояние и сохранить.
export async function adoptStateJSON(json) {
  const d = JSON.parse(json);
  if (d.app !== 'nagruzka' || !d.settings || !Array.isArray(d.records)) {
    throw new Error('Это не похоже на резервную копию «Нагрузки»');
  }
  S.state = {
    settings: d.settings,
    regulars: d.regulars || [],
    installments: d.installments || [],
    records: (d.records || []).slice().sort((a, b) => a.period < b.period ? -1 : a.period > b.period ? 1 : 0),
  };
  await persist();
}
