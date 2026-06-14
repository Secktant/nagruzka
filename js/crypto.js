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

// plaintext: строка (JSON). Возвращает Uint8Array — содержимое файла.
export async function encryptText(plaintext, password, keyfileBytes) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, keyfileBytes, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plaintext))
  );
  const flags = keyfileBytes ? FLAG_KEYFILE : 0;
  const out = new Uint8Array(6 + 1 + 16 + 12 + ct.length);
  out.set(MAGIC, 0);
  out[6] = flags;
  out.set(salt, 7);
  out.set(iv, 23);
  out.set(ct, 35);
  return out;
}

// Разбирает заголовок без расшифровки: нужен ли keyfile.
export function inspect(bytes) {
  const b = new Uint8Array(bytes);
  if (b.length < 35 || MAGIC.some((m, i) => b[i] !== m)) {
    throw new Error('Это не зашифрованный файл «Нагрузки»');
  }
  return { needsKeyfile: (b[6] & FLAG_KEYFILE) !== 0 };
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
