// Синхронизация через Supabase (этап 4b), zero-knowledge.
// Сервер хранит ТОЛЬКО шифротекст: id (локатор), salt (для Argon2, не секрет), blob (iv+ct).
// Расшифровать может лишь тот, у кого пароль (+ keyfile, если синк настроен с ним). Доступ к таблице — только через
// RPC sync_pull/sync_push (перечислить чужие блобы нельзя). См. supabase-setup.sql.

import { SUPABASE_URL, SUPABASE_ANON } from './sync-config.js';
import { deriveKey, sealGCM, openGCM, randomSalt, b64 } from './crypto.js';

export function isConfigured() { return !!(SUPABASE_URL && SUPABASE_ANON); }

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
// AAD чанка данных = МЕТКА КОНТЕКСТА, а не id ячейки.
//
// Раньше привязывались к id (SHA-256(SyncID‖метка)), и из-за этого восстановление
// суточного бэкапа требовало ТРЕТЬЕГО артефакта — Sync ID — вдобавок к паролю и
// keyfile. Защищала эта привязка ровно от одного: подмены блоба другой ячейкой
// ТОГО ЖЕ ключа. В «Нагрузке» такой ячейки нет — шифрованный чанк один, а мета
// хранит соль открытым текстом. От чужих данных защищает ключ (свой пароль +
// keyfile), а от отката на свою же старую версию AAD не защищал никогда: метка
// у всех версий одна.
//
// Адресацию это не трогает: куда писать, по-прежнему решает chunkId ниже.
export const AAD_MAIN = CHUNK_NAGRUZKA;

// Чтение с откатом: новый формат (метка), затем старый (id ячейки). Нужно, чтобы
// после обновления приложение открыло то, что уже лежит на сервере; ближайшая
// запись пересоберёт блоб по-новому сама, без ручных миграций.
async function openChunk(key, bytes, chunkId) {
  try { return await openGCM(key, bytes, AAD_MAIN); }
  catch { return await openGCM(key, bytes, chunkId); }
}

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
    this.opts = opts; this.id = null; this.chunkId = null; this.metaId = null;
    this.key = null; this.salt = null; this.version = 0; this.pollMs = 5000;
    this._timer = null; this._pushTimer = null; this._queue = Promise.resolve();
    this._pendingWrite = Promise.resolve(); this._localRevision = 0;
    this._pendingBaseVersion = null; this.hasPendingLocalChanges = false; this.lastStatus = 'off';
  }
  status(s) { this.lastStatus = s; this.opts.onStatus?.(s); }
  _enqueue(task) { const run = this._queue.then(task, task); this._queue = run.catch(() => {}); return run; }
  _writePending(marker) {
    const write = this._pendingWrite.catch(() => {}).then(async () => { await this.opts.savePendingSync?.(marker); });
    this._pendingWrite = write; return write;
  }
  async _clearPending(expectedRevision) {
    await this._pendingWrite;
    if (expectedRevision !== undefined && expectedRevision !== this._localRevision) return false;
    await this.opts.clearPendingSync?.();
    if (expectedRevision !== undefined && expectedRevision !== this._localRevision) {
      this.hasPendingLocalChanges = true; this._pendingBaseVersion = this.version;
      await this._writePending({ baseVersion: this.version }); return false;
    }
    this.hasPendingLocalChanges = false; this._pendingBaseVersion = null; return true;
  }
  restorePending(marker) {
    const baseVersion = Number(marker?.baseVersion);
    if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) return false;
    this._pendingBaseVersion = baseVersion; this.version = baseVersion;
    this.hasPendingLocalChanges = true; this._localRevision++; return true;
  }
  async prepare(syncId) {
    this.id = syncId;
    this.chunkId = await deriveChunkId(syncId, CHUNK_NAGRUZKA);
    this.metaId = await deriveChunkId(syncId, CHUNK_META);
  }
  async unlock(id, passphrase) {
    await this.prepare(id);
    const kf = this.opts.getKeyfile() || null;
    let saltB64 = await metaGet(this.metaId); let legacy = null;
    if (!saltB64) {
      legacy = await pull(this.id);
      const seed = legacy ? legacy.salt : b64.enc(randomSalt());
      saltB64 = await metaInit(this.metaId, seed);
    }
    this.salt = b64.dec(saltB64); this.key = await deriveKey(passphrase, kf, this.salt);
    const chunk = await pull(this.chunkId);
    if (chunk) {
      const json = await openChunk(this.key, b64.dec(chunk.blob), this.chunkId);
      this.version = chunk.version; await this.opts.applyStateJSON(json);
    } else {
      if (legacy === null) legacy = await pull(this.id);
      this.version = 0;
      if (legacy) {
        const json = await openGCM(this.key, b64.dec(legacy.blob));
        await this.opts.applyStateJSON(json);
      }
      await this.pushNow();
    }
    if (!['offline', 'conflict', 'error'].includes(this.lastStatus)) this.status('synced');
  }
  async pushNow() {
    clearTimeout(this._pushTimer); this._pushTimer = null;
    return this._enqueue(() => this._pushNow());
  }
  async _pushNow() {
    if (!this.key) return;
    this.status('syncing');
    try {
      await this._pendingWrite;
      const revision = this._localRevision;
      const json = this.opts.getStateJSON();
      const baseVersion = this.hasPendingLocalChanges ? this._pendingBaseVersion : this.version;
      const blob = await sealGCM(this.key, json, AAD_MAIN);
      const r = await push(this.chunkId, b64.enc(this.salt), b64.enc(blob), baseVersion);
      if (!r.ok) {
        if (r.blob) {
          try {
            const remoteJSON = await openChunk(this.key, b64.dec(r.blob), this.chunkId);
            if (this._sameState(json, remoteJSON)) {
              this.version = r.version;
              if (this.hasPendingLocalChanges) {
                const cleared = await this._clearPending(revision);
                if (!cleared) {
                  this.status('syncing');
                  if (!this._pushTimer) this._pushTimer = setTimeout(() => this.pushNow(), 1500);
                  return;
                }
              }
              this.status('synced'); this.opts.onSaved?.(); return;
            }
          } catch { /* серверная копия отличается или не расшифровывается */ }
        }
        // При конфликте никогда не заменяем локальное состояние серверным автоматически.
        this.status('conflict'); return;
      }
      this.version = r.version;
      if (this._localRevision !== revision) {
        this.hasPendingLocalChanges = true; this._pendingBaseVersion = r.version;
        await this._writePending({ baseVersion: r.version });
        this.status('syncing');
        if (!this._pushTimer) this._pushTimer = setTimeout(() => this.pushNow(), 1500);
        return;
      }
      if (this.hasPendingLocalChanges) {
        const cleared = await this._clearPending(revision);
        if (!cleared) {
          this.status('syncing');
          if (!this._pushTimer) this._pushTimer = setTimeout(() => this.pushNow(), 1500);
          return;
        }
      }
      this.status('synced'); this.opts.onSaved?.();
    } catch (e) { this.status('offline'); }
  }
  _sameState(a, b) {
    try {
      const left = JSON.parse(a), right = JSON.parse(b);
      delete left.exportedAt; delete right.exportedAt;
      return JSON.stringify(left) === JSON.stringify(right);
    } catch { return false; }
  }
  async pullAndApply() { return this._enqueue(() => this._pullAndApply()); }
  async _pullAndApply() {
    if (!this.key || this.hasPendingLocalChanges) return;
    const revision = this._localRevision; let remote;
    try { remote = await pull(this.chunkId); }
    catch (e) { this.status('offline'); return; }
    if (this.hasPendingLocalChanges || revision !== this._localRevision) return;
    try {
      if (remote && remote.version > this.version) {
        const json = await openChunk(this.key, b64.dec(remote.blob), this.chunkId);
        if (this.hasPendingLocalChanges || revision !== this._localRevision) return;
        await this.opts.applyStateJSON(json); this.version = remote.version;
      }
      this.status('synced');
    } catch (e) { this.status('error'); }
  }
  async changePassword(newPass) {
    return this._enqueue(async () => {
      if (!this.key) throw new Error('Синхронизация не активна');
      const kf = this.opts.getKeyfile() || null;
      const newKey = await deriveKey(newPass, kf, this.salt);
      const blob = await sealGCM(newKey, this.opts.getStateJSON(), AAD_MAIN);
      const r = await push(this.chunkId, b64.enc(this.salt), b64.enc(blob), this.version);
      if (!r.ok) throw new Error('На сервере есть несинхронизированные изменения — подожди пару секунд и повтори');
      this.key = newKey; this.version = r.version; this.status('synced');
    });
  }
  notifyLocalChange() {
    if (!this.key) return Promise.resolve();
    if (!this.hasPendingLocalChanges) this._pendingBaseVersion = this.version;
    this.hasPendingLocalChanges = true; this._localRevision++;
    const write = this._writePending({ baseVersion: this._pendingBaseVersion });
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this.pushNow(), 1500);
    return write.catch((e) => { this.status('offline'); throw e; });
  }
  start() {
    this.stop();
    this._onVisible = () => { if (document.visibilityState === 'visible') this.pullAndApply(); };
    document.addEventListener('visibilitychange', this._onVisible);
    window.addEventListener('focus', this._onVisible);
    this._timer = setInterval(() => { if (document.visibilityState === 'visible') this.pullAndApply(); }, this.pollMs);
  }
  stop() {
    clearInterval(this._timer); this._timer = null; clearTimeout(this._pushTimer); this._pushTimer = null;
    if (this._onVisible) {
      document.removeEventListener('visibilitychange', this._onVisible);
      window.removeEventListener('focus', this._onVisible); this._onVisible = null;
    }
  }
}
export const _b64url = b64url; // экспорт для тестов
