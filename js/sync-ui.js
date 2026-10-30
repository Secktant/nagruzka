// UI-обвязка синхронизации и замка: статус/тост/баннер соединения, фабрика
// SyncEngine с колбэками на S, включение замка (двухшаговая модалка, «свежий»
// клик для WebAuthn) и стартовый гейт (биометрия → пароль-фолбэк).

import { S, adoptStateJSON } from './store.js';
import { render } from './render.js';
import { $, openModal, closeModal } from './dom.js';
import { icon } from './icons.js';
import { exportState, getKeyfile, setLock, clearSyncKey, hasVault, loadVault } from './db.js';
import { deriveKeyRaw, importAesKey } from './crypto.js';
import { SyncEngine } from './sync.js';
import { webauthnSupported, registerBiometric, unlockBiometric } from './lock.js';

export function updateSyncStatusUI() {
  const el = $('#sync-status');
  if (!el) return;
  const map = {
    off: ['—', ''], locked: ['🔒 заблокировано', 'off'],
    syncing: ['синхронизация…', 'on'], synced: ['✓ синхронизировано', 'on'],
    offline: ['⚠ сервер недоступен', 'warn'], conflict: ['⚠ был конфликт, взято свежее', 'warn'],
    error: ['⚠ ошибка', 'warn'],
  };
  const [text, cls] = map[S.syncStatus] || ['—', ''];
  if (S.syncStatus === 'syncing') el.innerHTML = '<span class="mini-spin" aria-hidden="true"></span> синхронизация…';
  else el.textContent = text;
  el.className = 'keyfile-status ' + cls;
}

export function createSyncEngine() {
  return new SyncEngine({
    getStateJSON: () => exportState(S.state),
    applyStateJSON: async (json) => {
      await adoptStateJSON(json);          // заменить состояние и сохранить (сейф/плейнтекст), без эха
      render();
    },
    getKeyfile: () => S.currentKeyfile || null,
    onStatus: (s) => { S.syncStatus = s; updateSyncStatusUI(); updateConnBanner(s); },
    onSaved: () => showToast('ok', '✓ Сохранено и синхронизировано', 2000), // на каждую правку
  });
}

// Глобальная плашка связи: [точка][текст][×]. Зелёная/жёлтая авто-исчезают,
// красная висит до восстановления; если закрыть красную крестиком — вернётся через 30с.
let toastTimer = null;        // авто-скрытие
let reappearTimer = null;     // возврат «красной» после закрытия крестиком
let prevConn = null;          // synced | offline | error — «зелёную» показываем только при первом/после сбоя
let sticky = null;            // {kind,text} последней висящей (bad) плашки — для возврата через 30с

function renderToast(kind, text) {
  const el = $('#toast');
  if (!el) return null;
  el.innerHTML = `<span class="toast-dot"></span><span class="toast-msg"></span><button class="toast-x" type="button" aria-label="Закрыть">${icon('x')}</button>`;
  const msg = el.querySelector('.toast-msg');
  msg.textContent = text; msg.title = text;          // одна строка + ellipsis; полный текст — в title
  el.className = 'toast show ' + kind;
  el.querySelector('.toast-x').onclick = () => dismissToast(kind);
  return el;
}
export function showToast(kind, text, autohideMs) {
  clearTimeout(toastTimer); clearTimeout(reappearTimer);
  const el = renderToast(kind, text);
  if (!el) return;
  sticky = kind === 'bad' ? { kind, text } : null;   // висящая проблема — помним для возврата
  if (autohideMs) toastTimer = setTimeout(() => el.classList.remove('show'), autohideMs);
}
export function hideToast() {
  const el = $('#toast');
  clearTimeout(toastTimer); clearTimeout(reappearTimer); sticky = null;
  if (el) el.classList.remove('show');
}
// Крестик: гасим. Красную (bad) возвращаем через 30с, если проблема ещё жива
// (sticky не сброшен переходом в synced/off/locked).
function dismissToast(kind) {
  const el = $('#toast');
  clearTimeout(toastTimer); clearTimeout(reappearTimer);
  if (el) el.classList.remove('show');
  if (kind === 'bad' && sticky) {
    const again = sticky;
    reappearTimer = setTimeout(() => {
      if (sticky && sticky.text === again.text) showToast(again.kind, again.text, 0);
    }, 30000);
  }
}
export function updateConnBanner(s) {
  if (s === 'syncing') return;                       // транзиентное — не трогаем плашку
  if (s === 'off' || s === 'locked') { hideToast(); prevConn = null; return; }
  if (s === 'conflict') { showToast('warn', 'Был конфликт — взято свежее', 3000); return; }
  if (s === 'synced') {
    if (prevConn !== 'synced') showToast('ok', 'Соединение установлено', 2500); // первый раз / после сбоя
    prevConn = 'synced'; return;
  }
  if (s === 'offline') { showToast('bad', 'Синхронизация приостановлена', 0); prevConn = 'offline'; return; }
  if (s === 'error')   { showToast('bad', 'Не удалось расшифровать — проверь пароль/keyfile', 0); prevConn = 'error'; return; }
}

// Включение замка (Шаг 5): двухшаговая модалка. Шаг 1 — пароль в поле окна (не системный
// prompt) → деривация+проверка ключа (Argon2). Шаг 2 — регистрация биометрии ПРЯМО по нажатию
// кнопки (create() как первый вызов на свежем жесте при сфокусированном документе — иначе iOS
// Safari бросает «document is not focused»). rawK держится в замыкании между шагами.
export async function openLockSetup() {
  const salt = S.vaultSalt || (await getSyncKey(S.db))?.salt;
  if (!S.vaultKey || !salt) { alert('Сначала включи синхронизацию — замок использует тот же ключ.'); return; }
  openModal(`
    <h3>Включить замок</h3>
    <p class="hint">Подтверди пароль (тот же, что синхронизация).</p>
    <input type="password" id="lk-pass" class="num" autocomplete="current-password" placeholder="Пароль" style="width:100%">
    <div class="lock-err" id="lk-err"></div>
    <div class="form-actions" style="margin-top:10px">
      <button class="btn" id="lk-cancel">Отмена</button>
      <button class="btn primary" id="lk-next">Далее</button>
    </div>`);
  const err = (m) => { const e = $('#lk-err'); if (e) e.textContent = m || ''; };
  $('#lk-cancel').onclick = closeModal;
  $('#lk-next').onclick = async () => {
    const pass = $('#lk-pass').value;
    if (!pass) return;
    err('Проверяю…');
    let rawK;
    try {
      rawK = await deriveKeyRaw(pass, S.currentKeyfile, salt);
      if (await hasVault(S.db)) await loadVault(S.db, await importAesKey(rawK)); // проверка пароля
    } catch { err('Неверный пароль или keyfile.'); return; }

    const finish = async (bio) => {
      await setLock(S.db, { salt, bio });
      await clearSyncKey(S.db); // убрать свободно-используемый кэш → гейт на следующем старте
      closeModal();
      alert('Замок включён ✓ При следующем открытии приложение спросит ' + (bio ? 'Face/Touch ID (или пароль).' : 'пароль.'));
      render();
    };

    // Шаг 2: выбор способа. Кнопка Face/Touch ID = свежий жест для create().
    $('#modal-body').innerHTML = `
      <h3>Замок</h3>
      <p class="hint">Пароль подтверждён.${webauthnSupported() ? ' Включить вход по Face / Touch ID? Иначе — только пароль.' : ' Устройство не поддерживает Face/Touch ID — замок будет по паролю.'}</p>
      <div class="lock-err" id="lk-err2"></div>
      <div class="form-actions" style="margin-top:10px">
        <button class="btn" id="lk-passonly">Только пароль</button>
        ${webauthnSupported() ? `<button class="btn primary" id="lk-bio">Включить Face / Touch ID</button>` : ''}
      </div>`;
    const err2 = (m) => { const e = $('#lk-err2'); if (e) e.textContent = m || ''; };
    $('#lk-passonly').onclick = () => finish(null);
    const bioBtn = $('#lk-bio');
    if (bioBtn) bioBtn.onclick = async () => {
      err2('Приложи Face / Touch ID…');
      try {
        const bio = await registerBiometric(rawK); // create() первым — фокус+жест на месте
        await finish(bio);
      } catch (e) {
        err2('Не вышло: ' + (e.message || 'отменено') + '. Можно «Только пароль».');
      }
    };
  };
}

// Экран-замок (Шаг 5): блокирует приложение, пока K не получен биометрией или паролём.
// Сначала АВТО-попытка Face/Touch ID; после MAX неудач открывается вход по паролю.
// Без зарегистрированной биометрии (замок только с паролём) — пароль сразу.
const LOCK_MAX_BIO = 5;
export function runLockGate(lock) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'lock-overlay';
    ov.innerHTML = `
      <div class="lock-box">
        <div class="lock-logo">${icon('lock')}</div>
        <div class="lock-title">Нагрузка</div>
        <div class="lock-status" id="lock-status"></div>
        <button class="btn primary" id="lock-bio" hidden>Повторить · Face / Touch ID</button>
        <button class="btn" id="lock-pass" hidden>Войти по паролю</button>
        <div class="lock-err" id="lock-err"></div>
      </div>`;
    document.body.appendChild(ov);
    const statusEl = ov.querySelector('#lock-status');
    const errEl = ov.querySelector('#lock-err');
    const bioBtn = ov.querySelector('#lock-bio');
    const passBtn = ov.querySelector('#lock-pass');
    const setStatus = (m) => { statusEl.textContent = m || ''; };
    const setErr = (m) => { errEl.textContent = m || ''; };
    const done = (key) => { ov.remove(); resolve(key); };
    const revealPassword = () => { bioBtn.hidden = true; passBtn.hidden = false; };

    let attempts = 0;
    // isAuto=true — попытка при появлении замка (без жеста): на iOS падает («not focused»),
    // поэтому её НЕ считаем за неудачу, просто показываем кнопку. Считаем только по нажатию.
    const tryBio = async (isAuto) => {
      bioBtn.hidden = true;
      setErr(''); setStatus('Разблокировка по Face / Touch ID…');
      let key = null;
      try {
        key = await importAesKey(await unlockBiometric(lock.bio));
      } catch (e) {
        setStatus('');
        if (!isAuto) attempts++;
        if (attempts >= LOCK_MAX_BIO) {
          setErr(`Не удалось ${LOCK_MAX_BIO} раз — войди по паролю.`);
          revealPassword();
        } else {
          setErr(isAuto ? 'Нажми, чтобы разблокировать.' : `Не вышло (${attempts}/${LOCK_MAX_BIO}). Повтори.`);
          bioBtn.hidden = false;
        }
        return;
      }
      // Страховка: ключ развернулся, но подходит ли он к сейфу? Рассинхрон возможен,
      // если пароль меняли (биометрия заворачивает старый ключ) — повторять Face ID
      // бессмысленно, сбрасываем устаревшую биометрию и уводим на пароль.
      try {
        if (await hasVault(S.db)) await loadVault(S.db, key);
        done(key);
      } catch (e) {
        setStatus('');
        await setLock(S.db, { salt: lock.salt, bio: null }).catch(() => {});
        setErr('Ключ Face/Touch ID устарел (менялся пароль?) — войди по паролю и включи замок заново.');
        revealPassword();
      }
    };
    bioBtn.onclick = () => tryBio(false);

    passBtn.onclick = async () => {
      const pass = prompt('Пароль (тот же, что синхронизация):');
      if (!pass) return;
      setErr(''); setStatus('Проверяю…');
      try {
        const key = await importAesKey(await deriveKeyRaw(pass, S.currentKeyfile, lock.salt));
        if (await hasVault(S.db)) await loadVault(S.db, key); // бросит при неверном пароле/keyfile
        done(key);
      } catch (e) {
        setStatus(''); setErr('Неверный пароль или keyfile.');
      }
    };

    if (lock.bio) tryBio(true);  // авто-попытка биометрии при появлении замка (без жеста)
    else revealPassword();        // биометрии нет — сразу пароль
  });
}
