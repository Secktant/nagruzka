// Синхронизация через Supabase (этап 4b), zero-knowledge.
// Сервер хранит ТОЛЬКО шифротекст: id (локатор), salt (для Argon2, не секрет), blob (iv+ct).
// Расшифровать может лишь тот, у кого пароль (+ keyfile, если синк настроен с ним). Доступ к таблице — только через
// RPC sync_pull/sync_push (перечислить чужие блобы нельзя). См. supabase-setup.sql.

import { SUPABASE_URL, SUPABASE_ANON } from './sync-config.js';
import { deriveKey, sealGCM, openGCM, randomSalt, b64 } from './crypto.js';
import { logEvent } from './diagnostics.js';

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
async function rpc(fn, body, signal) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', signal,
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
export async function pull(id, signal) {
  const rows = await rpc('sync_pull', { p_id: id }, signal);
  return (rows && rows[0]) || null;
}

// Записать снимок с оптимистичной блокировкой по версии.
// -> { ok:true, version } при успехе | { ok:false, version, salt, blob } при конфликте.
export async function push(id, saltB64, blobB64, baseVersion, signal) {
  const rows = await rpc('sync_push', {
    p_id: id, p_salt: saltB64, p_blob: blobB64, p_base_version: baseVersion,
  }, signal);
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

// Отпечаток сравнивает содержимое, а не время экспорта или порядок ключей JSON.
// Неизвестная база после обновления считается несинхронизированной: обе копии сохраняются.
function stateText(json) {
  const d = JSON.parse(json);
  return JSON.stringify({
    settings: d.settings, regulars: d.regulars || [], installments: d.installments || [],
    records: (d.records || []).slice().sort((a, b) => a.period < b.period ? -1 : a.period > b.period ? 1 : 0),
    history: d.history || [],
  }, (_, value) => value && !Array.isArray(value) && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
}
async function fingerprint(json) {
  return b64.enc(await crypto.subtle.digest('SHA-256', teId.encode(stateText(json))));
}

// Долговечная база = версия сервера + отпечаток подтверждённого снимка.
// Отличие сейфа от базы означает pending даже после аварийного перезапуска.
export class SyncEngine {
  constructor(opts) {
    this.opts = opts;
    this.id = this.chunkId = this.metaId = this.key = this.salt = null;
    this.journal = { version: 0, hash: null, conflict: null };
    this.version = 0;
    this.enabled = false;
    this.pollMs = 5000;
    this._generation = 0;
    this._revision = 0;
    this._queue = Promise.resolve();
  }

  status(s) { logEvent('SYNC_STATUS', { status: s }); this.opts.onStatus?.(s); }
  get conflict() { return this.journal.conflict; }
  _current(g) { return this.enabled && g === this._generation; }

  async prepare(syncId) {
    this.id = syncId;
    this.chunkId = await deriveChunkId(syncId, CHUNK_NAGRUZKA);
    this.metaId = await deriveChunkId(syncId, CHUNK_META);
    this.journal = await this.opts.loadSyncState?.(this.chunkId)
      || { version: 0, hash: null, conflict: null };
    this.version = this.journal.version;
  }

  async _storage(fn) {
    try { return await fn(); }
    catch (e) { e.syncStatus = 'storage-error'; throw e; }
  }
  async _network(fn) {
    try { return await fn(); }
    catch (e) { e.syncStatus = 'offline'; throw e; }
  }
  async _remember(journal, g) {
    if (!this._current(g)) return false;
    await this._storage(() => this.opts.saveSyncState?.(this.chunkId, journal));
    if (!this._current(g)) return false;
    this.journal = journal;
    this.version = journal.version;
    return true;
  }

  // Единая очередь для push, pull, решения конфликта и смены пароля.
  _run(fn, rethrow = false) {
    const g = this._generation;
    const task = this._queue.then(async () => {
      if (!this._current(g) || !this.key) return false;
      this._controller = new AbortController();
      try {
        await this._storage(() => this.opts.flushLocalChanges?.());
        if (!this._current(g)) return false;
        return await fn(g);
      } catch (e) {
        if (this._current(g)) this.status(e.syncStatus || 'error');
        if (rethrow) throw e;
        return false;
      }
    });
    this._queue = task.catch(() => {});
    return task;
  }

  async _settled(g, saved = false) {
    await this._storage(() => this.opts.flushLocalChanges?.());
    const json = this.opts.getStateJSON(), hash = await fingerprint(json);
    if (!this._current(g)) return false;
    if (this.conflict) { this.status('conflict'); return false; }
    if (hash !== this.journal.hash || stateText(json) !== stateText(this.opts.getStateJSON())) {
      this.status('pending'); this._schedulePush(); return false;
    }
    this.status('synced');
    if (saved) this.opts.onSaved?.();
    return true;
  }

  async _conflict(remote, g) {
    if (await this._remember({ ...this.journal, conflict: remote }, g)) this.status('conflict');
    return false;
  }
  _open(remote, key = this.key) {
    return remote.legacy
      ? openGCM(key, b64.dec(remote.blob))
      : openChunk(key, b64.dec(remote.blob), this.chunkId);
  }

  async _receive(remote, g, chooseRemote = false) {
    const json = await this._open(remote);
    const remoteHash = await fingerprint(json);
    const local = this.opts.getStateJSON(), revision = this._revision;
    const localHash = await fingerprint(local);
    if (!this._current(g)) return false;
    const unchanged = () => this._current(g) && revision === this._revision
      && stateText(local) === stateText(this.opts.getStateJSON());
    if (!unchanged()) return this._conflict(remote, g);
    if (localHash !== remoteHash) {
      if (!chooseRemote && (localHash !== this.journal.hash || remote.version < this.version)) {
        return this._conflict(remote, g);
      }
      const applied = await this._storage(() => this.opts.applyStateJSON(json, unchanged));
      if (applied === false || !this._current(g)) return this._conflict(remote, g);
    }
    if (!await this._remember({ version: remote.version, hash: remoteHash, conflict: null }, g)) return false;
    if (remote.legacy) return this._push(g);
    return this._settled(g);
  }

  async _push(g, baseVersion = this.version, newKey = null, resolving = false) {
    if (this.conflict && !resolving) { this.status('conflict'); return false; }
    // Снимок и версия фиксируются вместе ДО шифрования и других await.
    const json = this.opts.getStateJSON(), base = baseVersion;
    this.status('syncing');
    const hash = await fingerprint(json);
    const blob = await sealGCM(newKey || this.key, json, AAD_MAIN);
    if (!this._current(g)) return false;
    const r = await this._network(() => push(this.chunkId, b64.enc(this.salt), b64.enc(blob), base, this._controller.signal));
    if (!this._current(g)) return false;
    if (!r.ok) {
      const remoteJSON = await this._open(r); // чужой ключ не превращаем в якобы разрешимый конфликт
      if (!newKey && stateText(remoteJSON) === stateText(this.opts.getStateJSON())) return this._receive(r, g);
      return this._conflict(r, g);
    }
    if (newKey) {
      // Локальный сейф и ключ сохраняются до следующей операции очереди.
      await this._storage(() => this.opts.onKeyChanged?.(newKey, this.salt));
      this.key = newKey;
    }
    if (!await this._remember({ version: r.version, hash, conflict: null }, g)) return false;
    const settled = await this._settled(g, true);
    return newKey ? true : settled;
  }

  pushNow() {
    clearTimeout(this._pushTimer);
    return this._run(g => this._push(g));
  }
  async _sync(g) {
    if (this.conflict) { this.status('conflict'); return false; }
    this.status('syncing');
    let remote = await this._network(() => pull(this.chunkId, this._controller.signal));
    if (!this._current(g)) return false;
    if (!remote && this.version === 0) {
      const legacy = await this._network(() => pull(this.id, this._controller.signal));
      if (!this._current(g)) return false;
      if (legacy) remote = { ...legacy, version: 0, legacy: true };
    }
    if (!remote) {
      if (this.version) throw new Error('Серверная копия отсутствует');
      return this._push(g);
    }
    if (remote.version !== this.version || !this.journal.hash || remote.legacy) return this._receive(remote, g);
    if (await fingerprint(this.opts.getStateJSON()) !== this.journal.hash) return this._push(g);
    return this._settled(g);
  }
  pullAndApply() { return this._run(g => this._sync(g)); }

  // Проверяем временный ключ, не меняя рабочий ключ при неверном пароле.
  // Применение снимка идёт отдельно после надёжного сохранения локального сейфа.
  async unlock(id, passphrase) {
    await this.stop();
    await this._queue;
    await this.prepare(id);
    const g = this._generation;
    let saltB64 = await metaGet(this.metaId);
    let legacy = null;
    if (!saltB64) {
      legacy = await pull(id);
      saltB64 = await metaInit(this.metaId, legacy?.salt || b64.enc(randomSalt()));
    }
    const salt = b64.dec(saltB64);
    const candidate = await deriveKey(passphrase, this.opts.getKeyfile?.() || null, salt);
    const remote = await pull(this.chunkId);
    if (remote) await this._open(remote, candidate);
    else {
      legacy ||= await pull(id);
      if (legacy) await openGCM(candidate, b64.dec(legacy.blob));
      // Если сервер пуст, пароль проверяет сохранённый сейф (при его наличии).
      else await this.opts.verifyLocalKey?.(candidate);
    }
    if (g !== this._generation) throw new Error('Включение синхронизации отменено');
    let journal = this.journal;
    if (this.conflict) {
      // Конфликт мог быть сохранён до смены пароля на другом устройстве.
      let json;
      try { json = await this._open(this.conflict, candidate); }
      catch { json = await this._open(this.conflict, this.key); }
      const blob = await sealGCM(candidate, json, this.conflict.legacy ? undefined : AAD_MAIN);
      journal = { ...journal, conflict: { ...this.conflict, blob: b64.enc(blob), salt: saltB64 } };
    }
    await this.opts.onKeyChanged?.(candidate, salt, { chunkId: this.chunkId, journal });
    // Callback сохраняет сейф, ключ и журнал одной транзакцией.
    this.journal = journal;
    this.key = candidate; this.salt = salt;
  }

  changePassword(newPass) {
    return this._run(async g => {
      if (!await this._sync(g)) throw new Error('Сначала дождись синхронизации или разреши конфликт');
      const newKey = await deriveKey(newPass, this.opts.getKeyfile?.() || null, this.salt);
      if (!this._current(g)) throw new Error('Синхронизация выключена');
      if (!await this._push(g, this.version, newKey)) throw new Error('Смена пароля не завершена');
      return true;
    }, true);
  }

  async getConflictCopies() {
    const remote = this.conflict;
    if (!remote) return null;
    return { local: this.opts.getStateJSON(), remote: await this._open(remote), version: remote.version };
  }
  resolveConflict(choice) {
    return this._run(async g => {
      const remote = this.conflict;
      if (!remote) return true;
      if (choice === 'remote') return this._receive(remote, g, true);
      if (choice !== 'local') throw new Error('Неизвестный вариант');
      // Явный выбор локальной копии разрешает запись только поверх показанной версии.
      return this._push(g, remote.version, null, true);
    }, true);
  }

  _schedulePush() {
    if (!this.enabled || !this.key || this.conflict) return;
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(() => this.pushNow(), 1500);
  }
  notifyLocalChange() {
    this._revision++;
    if (this.enabled) this.status(this.conflict ? 'conflict' : 'pending');
    this._schedulePush();
  }
  async start() {
    if (this.enabled) return;
    const g = this._generation;
    await this.opts.setEnabled?.(true);
    if (g !== this._generation) return;
    this.enabled = true;
    this._generation++;
    this._onVisible = () => { if (document.visibilityState === 'visible') this.pullAndApply(); };
    document.addEventListener('visibilitychange', this._onVisible);
    window.addEventListener('focus', this._onVisible);
    window.addEventListener('online', this._onVisible);
    this._timer = setInterval(this._onVisible, this.pollMs);
    this.status(this.conflict ? 'conflict' : 'pending');
  }
  stop() {
    this.enabled = false;
    this._generation++;
    this._controller?.abort();
    clearInterval(this._timer); clearTimeout(this._pushTimer);
    if (this._onVisible) {
      document.removeEventListener('visibilitychange', this._onVisible);
      window.removeEventListener('focus', this._onVisible);
      window.removeEventListener('online', this._onVisible);
      this._onVisible = null;
    }
    this.status('off');
    return this.opts.setEnabled?.(false);
  }
}

export const _b64url = b64url; // экспорт для тестов
