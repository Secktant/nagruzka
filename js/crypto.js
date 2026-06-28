// Шифрование резервной копии «Нагрузки».
// Ключ = Argon2id(пароль ⨁ keyfile). Шифр = AES-256-GCM (AEAD: шифрует + проверяет
// целостность). Argon2id — memory-hard, дорогой для перебора при утечке файла.
// keyfile — второй фактор: 32 случайных байта, хранятся только на устройствах,
// с зашифрованным файлом НИКОГДА не передаются.

// Формат файла (бинарный):
//   "NZENC1" (6 байт) | flags (1) | salt (16) | iv (12) | ciphertext (+ GCM-тег)
// flags bit0 = при шифровании использовался keyfile.

const MAGIC = [0x4e, 0x5a, 0x45, 0x4e, 0x43, 0x31]; // "NZENC1"
const FLAG_KEYFILE = 0x01;

// Параметры Argon2id: 64 МБ памяти, 3 прохода (~0.3–0.5 c на десктопе).
const ARGON = { parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 32 };

const te = new TextEncoder();
const td = new TextDecoder();

function argon2() {
  const h = globalThis.hashwasm;
  if (!h || !h.argon2id) throw new Error('Модуль Argon2 не загрузился');
  return h.argon2id;
}

// 32 случайных байта для keyfile.
export function generateKeyfile() {
  return crypto.getRandomValues(new Uint8Array(32));
}

async function deriveAesKey(password, keyfileBytes, salt) {
  const pw = te.encode(password);
  const kf = keyfileBytes || new Uint8Array(0);
  const combined = new Uint8Array(pw.length + kf.length);
  combined.set(pw, 0);
  combined.set(kf, pw.length);
  const raw = await argon2()({
    password: combined, salt,
    parallelism: ARGON.parallelism, iterations: ARGON.iterations,
    memorySize: ARGON.memorySize, hashLength: ARGON.hashLength,
    outputType: 'binary',
  });
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

// Упаковка в файловый формат NZENC1 (общая для обоих путей шифрования).
function packNz(salt, iv, ct, usedKeyfile) {
  const out = new Uint8Array(6 + 1 + 16 + 12 + ct.length);
  out.set(MAGIC, 0);
  out[6] = usedKeyfile ? FLAG_KEYFILE : 0;
  out.set(salt, 7);
  out.set(iv, 23);
  out.set(ct, 35);
  return out;
}

// plaintext: строка (JSON). Возвращает Uint8Array — содержимое файла.
export async function encryptText(plaintext, password, keyfileBytes) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveAesKey(password, keyfileBytes, salt);
  return encryptTextWithKey(plaintext, key, salt, !!keyfileBytes);
}

// Зашифровать ГОТОВЫМ ключом и заданной солью (16 байт) — чтобы у файла не было
// СВОЕГО пароля: напр. сессионным ключом синхронизации. Файл самодостаточен (соль
// зашита внутрь) и открывается тем же паролем приложения через decryptToText.
export async function encryptTextWithKey(plaintext, key, salt, usedKeyfile) {
  if (!salt || salt.length !== 16) throw new Error('Соль должна быть 16 байт');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plaintext))
  );
  return packNz(salt, iv, ct, usedKeyfile);
}

// Разбирает заголовок без расшифровки: нужен ли keyfile.
export function inspect(bytes) {
  const b = new Uint8Array(bytes);
  if (b.length < 35 || MAGIC.some((m, i) => b[i] !== m)) {
    throw new Error('Это не зашифрованный файл «Нагрузки»');
  }
  return { needsKeyfile: (b[6] & FLAG_KEYFILE) !== 0 };
}

// --- для синхронизации (этап 4b) ---
// В файловом сценарии ключ деривируется на каждый файл (своя соль). Для синка это дорого:
// Argon2 ~1 c на каждую отправку. Поэтому ключ деривируется ОДИН раз за сессию с
// фиксированной солью (хранится на сервере, не секрет), кэшируется в памяти, а каждая
// выгрузка/загрузка — это быстрый AES-GCM с разовым IV.

export const SYNC_SALT_LEN = 16;
export function randomSalt() { return crypto.getRandomValues(new Uint8Array(SYNC_SALT_LEN)); }

// Сессионный ключ: Argon2id(пароль ⨁ keyfile, salt). Зовётся один раз при разблокировке синка.
export const deriveKey = deriveAesKey;

// seal: text -> Uint8Array(iv(12) | ciphertext). Быстро, Argon2 не вызывается.
// aad (опц., строка) — привязка к ячейке (id чанка): тот же шифротекст нельзя
// подставить в другой чанк. Старые блобы писались БЕЗ aad — для них не передаём.
export async function sealGCM(key, text, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params = { name: 'AES-GCM', iv };
  if (aad != null) params.additionalData = te.encode(aad);
  const ct = new Uint8Array(await crypto.subtle.encrypt(params, key, te.encode(text)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

// open: Uint8Array(iv | ciphertext) -> text. Бросает, если ключ/aad не подошли.
// aad ДОЛЖЕН совпадать с тем, что был при sealGCM (иначе GCM-тег не сойдётся).
export async function openGCM(key, bytes, aad) {
  const b = new Uint8Array(bytes);
  const iv = b.slice(0, 12);
  const ct = b.slice(12);
  const params = { name: 'AES-GCM', iv };
  if (aad != null) params.additionalData = te.encode(aad);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(params, key, ct);
  } catch {
    throw new Error('Не удалось расшифровать снимок: неверный пароль/keyfile');
  }
  return td.decode(plain);
}

// bytes: содержимое файла. Возвращает расшифрованную строку (JSON).
export async function decryptToText(bytes, password, keyfileBytes) {
  const b = new Uint8Array(bytes);
  inspect(b); // проверка сигнатуры
  const salt = b.slice(7, 23);
  const iv = b.slice(23, 35);
  const ct = b.slice(35);
  const key = await deriveAesKey(password, keyfileBytes, salt);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  } catch {
    // GCM не сошёлся: неверный пароль, не тот keyfile или битый файл
    throw new Error('Не удалось расшифровать: неверный пароль/keyfile или файл повреждён');
  }
  return td.decode(plain);
}
