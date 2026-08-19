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

// ─────────────────── история изменений (пункт 4) ───────────────────
// Лог живёт ВНУТРИ снимка (state.history), а не отдельной инфраструктурой: тогда
// он шифруется, синкается и попадает в .nz вместе с данными сам собой.
//
// Потолок обязателен: снимок льётся в Supabase целиком, поэтому бесконечный лог
// однажды упрётся в лимит чанка. Кольцевой буфер — подрезаем самое старое.
export const HISTORY_LIMIT = 1000;

// Запись: { t, e, act, id, name, period?, was?, now? }
//   t    — НАСТЕННЫЕ часы устройства (Date.now()), а НЕ TODAY: событие произошло
//          в конкретную минуту, подменять её «сегодня» приложения нельзя.
//   e    — 'record' | 'regular' | 'installment' | 'settings'
//   act  — 'create' | 'edit' | 'delete' | 'paid' | 'unpaid' | 'on' | 'off'
//   was/now — только изменённые поля, парой: { amount: 42000 } → { amount: 43500 }
//
// Вызывается из СЕМАНТИЧЕСКИХ точек вьюх, а не из saveAll: generic-сохранение не
// знает, что именно изменилось. Персист не делает — его делает saveAll рядом,
// иначе на каждое действие уходило бы две записи снимка.
export function logChange(e, act, obj, extra) {
  if (!S.state) return;
  const h = (S.state.history ||= []);
  h.push({
    t: Date.now(), e, act,
    id: obj?.id ?? null,
    name: obj?.name ?? '',
    ...(obj?.period ? { period: obj.period } : {}),
    ...extra,
  });
  if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
}

// Изменённые поля пары объектов → { was, now } или null, если ничего не поменялось.
// Нужен, чтобы вьюхи не писали сравнение полей по копии на каждую форму.
export function diffFields(before, after, fields) {
  const was = {}, now = {};
  let changed = false;
  for (const f of fields) {
    if (before?.[f] === after?.[f]) continue;
    was[f] = before?.[f] ?? null;
    now[f] = after?.[f] ?? null;
    changed = true;
  }
  return changed ? { was, now } : null;
}

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
    // Снимок со старого устройства (или из бэкапа до 1.8.0) лога не содержит.
    history: d.history || [],
  };
  await persist();
}
