// Замок приложения (Шаг 5): вход по Face/Touch ID (WebAuthn PRF) с откатом на пароль.
// Мастер-ключ K (шифрует сейф/синк) на устройстве с замком НЕ хранится в готовом виде:
// либо разворачивается биометрией из wrap(K), либо выводится из пароля Argon2.
// Регистрация per-device, опт-ин. PRF появился в Safari 18/iOS 18; нет PRF → только пароль.

import { sealGCM, openGCM, importAesKey } from './crypto.js';

const te = new TextEncoder();
const b64 = {
  enc: (b) => btoa(String.fromCharCode(...new Uint8Array(b))),
  dec: (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};
const PRF_SALT = te.encode('nagruzka:prf:v1'); // фиксированная PRF-соль (метка приложения)
const rpId = () => location.hostname;

// Базовая поддержка WebAuthn (платформенный аутентификатор). Реальную поддержку PRF
// узнаём только при регистрации (есть ли results.first); нет PRF → биометрия недоступна.
export function webauthnSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
}

// PRF-секрет ассерцией (после Face/Touch ID). rawId — Uint8Array credentialId.
async function prfAssert(rawId) {
  const assertion = await navigator.credentials.get({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rpId: rpId(),
    allowCredentials: [{ id: rawId, type: 'public-key' }],
    userVerification: 'required',
    extensions: { prf: { eval: { first: PRF_SALT } } },
    timeout: 60000,
  }});
  const res = assertion.getClientExtensionResults().prf?.results?.first;
  return res ? new Uint8Array(res) : null;
}

// Зарегистрировать биометрию на этом устройстве: завернуть rawK (32 байта).
// -> { credentialId, wrapped } для хранения | бросает (отмена / нет PRF).
export async function registerBiometric(rawK) {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { id: rpId(), name: 'Нагрузка' },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'nagruzka', displayName: 'Нагрузка' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: {
      authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred',
    },
    extensions: { prf: { eval: { first: PRF_SALT } } },
    timeout: 60000,
  }});
  const rawId = new Uint8Array(cred.rawId);
  // PRF на create отдают не все платформы → если нет, добираем ассерцией
  let secret = cred.getClientExtensionResults().prf?.results?.first;
  secret = secret ? new Uint8Array(secret) : await prfAssert(rawId);
  if (!secret) throw new Error('Устройство не поддерживает PRF — биометрия недоступна');
  const wrapKey = await importAesKey(secret);
  const wrapped = await sealGCM(wrapKey, b64.enc(rawK)); // base64(rawK) под PRF-ключом
  return { credentialId: b64.enc(rawId), wrapped: b64.enc(wrapped) };
}

// Разблокировать биометрией: -> rawK (Uint8Array) | бросает.
export async function unlockBiometric(bio) {
  const secret = await prfAssert(b64.dec(bio.credentialId));
  if (!secret) throw new Error('Биометрия не дала ключ');
  const wrapKey = await importAesKey(secret);
  const rawKb64 = await openGCM(wrapKey, b64.dec(bio.wrapped));
  return b64.dec(rawKb64);
}
