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
    this.id = null;
    this.key = null;          // сессионный CryptoKey (в памяти, не хранится)
    this.salt = null;         // Uint8Array
    this.version = 0;         // последняя известная версия сервера
    this.pollMs = 5000;       // «почти realtime» опрос пока активна вкладка
    this._timer = null;
    this._pushTimer = null;
  }

  status(s) { this.opts.onStatus?.(s); }

  // Разблокировка: один раз за сессию вводится пароль, деривируется ключ (Argon2 ~1c).
  // Если на сервере уже есть снимок — берём его соль и проверяем пароль расшифровкой.
  async unlock(id, passphrase) {
    this.id = id;
    const remote = await pull(id);
    const kf = this.opts.getKeyfile() || null;
    if (remote) {
      this.salt = b64.dec(remote.salt);
      this.key = await deriveKey(passphrase, kf, this.salt);
      // проверяем пароль и сразу применяем, если на сервере свежее
      const json = await openGCM(this.key, b64.dec(remote.blob)); // бросит при неверном пароле
      this.version = remote.version;
      await this.opts.applyStateJSON(json);
    } else {
      // сервер пуст — это первое устройство: новая соль, потом первый push
      this.salt = randomSalt();
      this.key = await deriveKey(passphrase, kf, this.salt);
      this.version = 0;
      await this.pushNow();
    }
    this.status('synced');
  }

  // Зашифровать текущее состояние и выгрузить (с разрешением конфликта).
  async pushNow() {
    if (!this.key) return;
    this.status('syncing');
    try {
      const blob = await sealGCM(this.key, this.opts.getStateJSON());
      const r = await push(this.id, b64.enc(this.salt), b64.enc(blob), this.version);
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
      remote = await pull(this.id);            // сеть
    } catch (e) {
      this.status('offline'); return;          // сервер реально недоступен
    }
    try {
      if (remote && remote.version > this.version) {
        const json = await openGCM(this.key, b64.dec(remote.blob)); // расшифровка
        this.version = remote.version;
        await this.opts.applyStateJSON(json);
      }
      this.status('synced');                   // связь есть (применили или нечего)
    } catch (e) {
      this.status('error');                    // не сервер, а пароль/keyfile
    }
  }

  // Сменить пароль синка: перешифровать снимок новым ключом (новая соль) и выложить.
  async changePassword(newPass) {
    if (!this.key) throw new Error('Синхронизация не активна');
    const kf = this.opts.getKeyfile() || null;
    const newSalt = randomSalt();
    const newKey = await deriveKey(newPass, kf, newSalt);
    const blob = await sealGCM(newKey, this.opts.getStateJSON());
    const r = await push(this.id, b64.enc(newSalt), b64.enc(blob), this.version);
    if (!r.ok) throw new Error('На сервере есть несинхронизированные изменения — подожди пару секунд и повтори');
    this.salt = newSalt;
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
