// Синхронизация через Supabase (этап 4b), zero-knowledge.
// Сервер хранит ТОЛЬКО шифротекст: id (локатор), salt (для Argon2, не секрет), blob (iv+ct).
// Расшифровать может лишь тот, у кого пароль + keyfile. Доступ к таблице — только через
// RPC sync_pull/sync_push (перечислить чужие блобы нельзя). См. supabase-setup.sql.

import { SUPABASE_URL, SUPABASE_ANON } from './sync-config.js';
import { deriveKey, sealGCM, openGCM, randomSalt } from './crypto.js';

export function isConfigured() { return !!(SUPABASE_URL && SUPABASE_ANON); }

// --- base64 ---
const b64 = {
  enc: (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))),
  dec: (str) => Uint8Array.from(atob(str), c => c.charCodeAt(0)),
};
// base64url без паддинга — для Sync ID в URL/файле
const b64url = {
  enc: (bytes) => b64.enc(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (str) => b64.dec(str.replace(/-/g, '+').replace(/_/g, '/')),
};

// --- Sync ID: 32 случайных байта, base64url-строка ---
export function generateSyncId() { return b64url.enc(crypto.getRandomValues(new Uint8Array(32))); }
export function isValidSyncId(str) {
  try { return b64url.dec(str).length === 32; } catch { return false; }
}

// --- id чанка (этап 4a): base64url(SHA-256(utf8(SyncID + label))) ---
// Детерминированный неперечислимый локатор ячейки. Должен считаться БАЙТ-В-БАЙТ так же
// в бэкап-Action (shell): printf '%s' "${SYNC_ID}${label}" | openssl dgst -sha256 -binary
//                         | openssl base64 | tr '+/' '-_' | tr -d '='
const teId = new TextEncoder();
export const CHUNK_NAGRUZKA = 'nagruzka:main'; // единственный чанк Нагрузки
export const CHUNK_META = 'meta';              // строка-мета: канонная соль аккаунта
export async function deriveChunkId(syncId, label) {
  const digest = await crypto.subtle.digest('SHA-256', teId.encode(syncId + label));
  return b64url.enc(new Uint8Array(digest));
}

// --- REST: вызов RPC-функции PostgREST ---
async function rpc(fn, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON,
      'Authorization': `Bearer ${SUPABASE_ANON}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Сервер синка: HTTP ${res.status}`);
  return res.json();
}

// Прочитать снимок по id. -> { salt, blob, version, updated_at } | null
export async function pull(id) {
  const rows = await rpc('sync_pull', { p_id: id });
  return (rows && rows[0]) || null;
}

// Записать снимок с оптимистичной блокировкой по версии.
// -> { ok:true, version } при успехе | { ok:false, version, salt, blob } при конфликте.
export async function push(id, saltB64, blobB64, baseVersion) {
  const rows = await rpc('sync_push', {
    p_id: id, p_salt: saltB64, p_blob: blobB64, p_base_version: baseVersion,
  });
  return rows[0];
}

// --- account-мета: одна соль Argon2 на аккаунт (этап 4a) ---
// sync_meta_get → text|null (соль base64). sync_meta_init → insert-once, возвращает
// фактически хранимую соль (существующую, если уже была) — так соль фиксируется навсегда.
export async function metaGet(id) {
  return rpc('sync_meta_get', { p_id: id });          // скаляр text|null
}
export async function metaInit(id, saltB64) {
  return rpc('sync_meta_init', { p_id: id, p_salt: saltB64 }); // скаляр text
}

// --- движок: связывает синк с приложением через колбэки (без импорта app.js) ---
// opts: {
//   getStateJSON: () => string                 // текущее состояние -> JSON для шифрования
//   applyStateJSON: async (json) => void        // принять удалённое состояние (импорт)
//   getKeyfile: () => Uint8Array|undefined       // второй фактор
//   onStatus: (status) => void                   // 'locked'|'syncing'|'synced'|'offline'|'conflict'|'error'
// }
export class SyncEngine {
  constructor(opts) {
    this.opts = opts;
    this.id = null;           // сырой Sync ID (пользовательский локатор)
    this.chunkId = null;      // id ячейки данных = SHA-256(SyncID‖"nagruzka:main")
    this.metaId = null;       // id строки-меты = SHA-256(SyncID‖"meta")
    this.key = null;          // сессионный CryptoKey (в памяти, не хранится)
    this.salt = null;         // Uint8Array (канонная соль аккаунта, из меты)
    this.version = 0;         // последняя известная версия сервера (по чанку)
    this.pollMs = 5000;       // «почти realtime» опрос пока активна вкладка
    this._timer = null;
    this._pushTimer = null;
  }

  status(s) { this.opts.onStatus?.(s); }

  // Вычислить локаторы (id чанка/меты) из сырого Sync ID. Зовётся в unlock и при
  // восстановлении сохранённого ключа на старте (app.js), до любых сетевых вызовов.
  async prepare(syncId) {
    this.id = syncId;
    this.chunkId = await deriveChunkId(syncId, CHUNK_NAGRUZKA);
    this.metaId  = await deriveChunkId(syncId, CHUNK_META);
  }

  // Разблокировка: один раз за сессию вводится пароль, деривируется ключ (Argon2 ~1c).
  // Канонная соль берётся из строки-меты (одна на аккаунт). Если меты ещё нет —
  // заводим её солью старого single-blob (тогда ключ не меняется) или новой случайной.
  // Данные читаем из ЧАНКА; если чанка нет, но есть старый single-blob — МИГРИРУЕМ
  // (расшифровать старый без AAD → записать как чанк с AAD). Старый блоб не трогаем.
  async unlock(id, passphrase) {
    await this.prepare(id);
    const kf = this.opts.getKeyfile() || null;

    // 1. канонная соль аккаунта
    let saltB64 = await metaGet(this.metaId);
    let legacy = null;
    if (!saltB64) {
      legacy = await pull(this.id);                       // старый single-blob (id = сырой Sync ID)
      const seed = legacy ? legacy.salt : b64.enc(randomSalt());
      saltB64 = await metaInit(this.metaId, seed);        // insert-once → фактически сохранённая
    }
    this.salt = b64.dec(saltB64);
    this.key = await deriveKey(passphrase, kf, this.salt);

    // 2. данные из чанка / миграция / первый push
    const chunk = await pull(this.chunkId);
    if (chunk) {
      const json = await openGCM(this.key, b64.dec(chunk.blob), this.chunkId); // бросит при неверном пароле
      this.version = chunk.version;
      await this.opts.applyStateJSON(json);
    } else {
      if (legacy === null) legacy = await pull(this.id);  // могли не тянуть выше (мета уже была)
      this.version = 0;
      if (legacy) {
        // соль меты = соль legacy → ключ совпадает; legacy зашифрован БЕЗ AAD
        const json = await openGCM(this.key, b64.dec(legacy.blob)); // проверка пароля + миграция
        await this.opts.applyStateJSON(json);
      }
      await this.pushNow();                                // создаём чанк (с AAD) из текущего состояния
    }
    this.status('synced');
  }

  // Зашифровать текущее состояние и выгрузить (с разрешением конфликта).
  async pushNow() {
    if (!this.key) return;
    this.status('syncing');
    try {
      const blob = await sealGCM(this.key, this.opts.getStateJSON(), this.chunkId);
      const r = await push(this.chunkId, b64.enc(this.salt), b64.enc(blob), this.version);
      if (r.ok) {
        this.version = r.version;
        this.status('synced');
        this.opts.onSaved?.();   // правка сохранена и улетела на сервер — для зелёной плашки
      } else {
        // на сервере оказалось свежее: тянем и применяем, затем статус «конфликт»
        await this.pullAndApply();
        this.status('conflict');
      }
    } catch (e) {
      this.status('offline');
    }
  }

  // Проверить сервер и применить, если версия выше нашей.
  async pullAndApply() {
    if (!this.key) return;
    let remote;
    try {
      remote = await pull(this.chunkId);       // сеть
    } catch (e) {
      this.status('offline'); return;          // сервер реально недоступен
    }
    try {
      if (remote && remote.version > this.version) {
        const json = await openGCM(this.key, b64.dec(remote.blob), this.chunkId); // расшифровка
        this.version = remote.version;
        await this.opts.applyStateJSON(json);
      }
      this.status('synced');                   // связь есть (применили или нечего)
    } catch (e) {
      this.status('error');                    // не сервер, а пароль/keyfile
    }
  }

  // Сменить пароль синка: перешифровать снимок новым ключом и выложить.
  // Соль НЕ меняем (она канонная, в мете — иначе свежее устройство по мете вывело бы
  // не тот ключ; смена пароля её менять не обязана). Новый ключ = Argon2(новыйПароль, та же соль).
  async changePassword(newPass) {
    if (!this.key) throw new Error('Синхронизация не активна');
    const kf = this.opts.getKeyfile() || null;
    const newKey = await deriveKey(newPass, kf, this.salt);
    const blob = await sealGCM(newKey, this.opts.getStateJSON(), this.chunkId);
    const r = await push(this.chunkId, b64.enc(this.salt), b64.enc(blob), this.version);
    if (!r.ok) throw new Error('На сервере есть несинхронизированные изменения — подожди пару секунд и повтори');
    this.key = newKey;
    this.version = r.version;
    this.status('synced');
  }

  // Дебаунс выгрузки после локальной правки.
  notifyLocalChange() {
    if (!this.key) return;
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this.pushNow(), 1500);
  }

  start() {
    this.stop();
    // мгновенная сверка при возврате в приложение (фокус/появление вкладки)
    this._onVisible = () => { if (document.visibilityState === 'visible') this.pullAndApply(); };
    document.addEventListener('visibilitychange', this._onVisible);
    window.addEventListener('focus', this._onVisible);
    // плюс фоновый опрос, пока вкладка активна
    this._timer = setInterval(() => {
      if (document.visibilityState === 'visible') this.pullAndApply();
    }, this.pollMs);
  }
  stop() {
    clearInterval(this._timer); this._timer = null;
    if (this._onVisible) {
      document.removeEventListener('visibilitychange', this._onVisible);
      window.removeEventListener('focus', this._onVisible);
      this._onVisible = null;
    }
  }
}

export const _b64 = b64, _b64url = b64url; // экспорт для тестов
