// Вкладка «Настройки»: экспорт/импорт (только шифрованный .nz — plaintext-JSON убран
// как небезопасный), keyfile, Sync ID, синхронизация, замок. Хендлеры мутируют
// S и зовут render(); включение/выключение синка и замка — через sync-ui.
// Зарплата, регулярные платежи и банки уехали во вкладку «Деньги» (views/money.js) —
// это данные, а не настройки приложения; здесь остался только «системный» слой.
// ВНИМАНИЕ БЕЗОПАСНОСТИ: логика ключей/сейфа перенесена ДОСЛОВНО — не менять при распиле.

import { S, markDirty, adoptStateJSON } from '../store.js';
import { render } from '../render.js';
import { $, esc, parseMoney, withBusy } from '../dom.js';
import { icon } from '../icons.js';
import { todayISO } from '../format.js';
import { generateKeyfile, encryptText, encryptTextWithKey, decryptToText, inspect } from '../crypto.js';
import { isConfigured as syncConfigured, generateSyncId, isValidSyncId, deriveChunkId, CHUNK_NAGRUZKA } from '../sync.js';
import { createSyncEngine, updateSyncStatusUI, openLockSetup } from '../sync-ui.js';
import {
  exportState,
  saveVault, hasVault, clearPlaintextStores, clearVault, saveLegacy,
  getKeyfile, setKeyfile, clearKeyfile,
  getSyncId, setSyncId, clearSyncId,
  setSyncKey, clearSyncKey,
  getLock, setLock, clearLock,
} from '../db.js';

// <input type="file"> НЕ шлёт change, если выбран тот же самый файл, что и в прошлый раз.
// На успешном пути инпут пересоздаётся вызовом render(), а на неудачном (неверный пароль,
// чужой файл, отказ от замены) — оставался с прежним значением, и повторная попытка с ТЕМ ЖЕ
// файлом молча не срабатывала до перезагрузки страницы. Поэтому чистим value всегда.
function resetFileInput(input) {
  if (input) input.value = '';
}

export async function renderSettings() {
  const kf = await getKeyfile(S.db); // Uint8Array | undefined
  const sid = await getSyncId(S.db); // base64url-строка | undefined

  // Замок (Шаг 5): включается, когда есть мастер-ключ (S.vaultKey); использует тот же ключ.
  const lock = await getLock(S.db);
  const lockCard = (S.vaultKey || lock) ? `
    <section class="card">
      <h3>Замок · Face / Touch ID</h3>
      ${lock
        ? `<div class="keyfile-status">Включён${lock.bio ? ' · вход по Face/Touch ID' : ' · только пароль'}. При открытии приложение спрашивает ${lock.bio ? 'Face/Touch ID (или пароль).' : 'пароль.'}</div>
           <div class="form-actions" style="justify-content:flex-start;margin-top:10px">
             <button class="btn danger" id="lock-disable">Выключить замок</button>
           </div>`
        : `<div class="keyfile-status off">Выключен — данные шифруются, но открытие без пароля.</div>
           <div class="form-actions" style="justify-content:flex-start;margin-top:10px">
             <button class="btn primary" id="lock-enable" ${S.vaultKey ? '' : 'disabled'}>Включить замок (Face/Touch ID)</button>
           </div>
           ${S.vaultKey ? '<p class="hint">Один раз подтвердишь пароль → дальше вход по Face/Touch ID (пароль — запасной).</p>' : '<p class="hint">Сначала включи синхронизацию — замок использует тот же ключ.</p>'}`}
    </section>` : '';

  $('#view-settings').innerHTML = `
    <div class="section-head"><h2>Настройки</h2></div>

    <section class="card">
      <h3>Резервная копия · синхронизация</h3>
      <div class="keyfile-status ${kf ? 'on' : 'off'}">
        ${kf
          ? 'keyfile активен — второй фактор включён'
          : 'keyfile не задан — копия защищена только паролем'}
      </div>
      <div class="form-actions" style="justify-content:flex-start;margin-top:8px">
        ${kf
          ? `<button class="btn" id="kf-download">${icon('download')} Скачать keyfile</button>
             <button class="btn danger" id="kf-clear">Удалить keyfile</button>`
          : `<button class="btn" id="kf-create">Создать keyfile</button>`}
        <button class="btn" id="kf-load">${icon('upload')} Загрузить keyfile</button>
        <input type="file" id="kf-file" hidden>
      </div>
      <div class="form-actions" style="justify-content:flex-start;margin-top:10px">
        <button class="btn primary" id="enc-export-btn">${icon('lock')} Зашифровать и сохранить</button>
        <button class="btn" id="enc-import-btn">${icon('unlock')} Загрузить зашифрованную</button>
        <input type="file" id="enc-import-file" hidden>
      </div>
      <p class="hint">Один пароль на всё: файл открывается тем же паролем, что синхронизация (+ keyfile). Отдельный пароль для файла задавать не нужно.</p>
    </section>

    ${syncConfigured() ? `
    <section class="card">
      <h3>Синхронизация · realtime</h3>
      <div id="sync-status" class="keyfile-status"></div>

      <div class="lbl-like" style="margin-top:12px">Sync ID — должен СОВПАДАТЬ на обоих устройствах</div>
      ${sid
        ? `<input id="sid-show" class="num" readonly value="${esc(sid)}"
             style="width:100%;font-family:ui-monospace,monospace;font-size:12px;letter-spacing:.3px">`
        : `<div class="keyfile-status off">не задан — нужен для связи устройств</div>`}
      <div class="form-actions" style="justify-content:flex-start;margin-top:8px">
        ${sid
          ? `<button class="btn" id="sid-copy">📋 Скопировать</button>
             <button class="btn danger" id="sid-clear">Удалить</button>`
          : `<button class="btn" id="sid-create">Создать Sync ID</button>`}
        <button class="btn" id="sid-paste">Вставить Sync ID</button>
      </div>

      <div class="form-actions" style="justify-content:flex-start;margin-top:10px">
        ${(S.syncStatus === 'synced' || S.syncStatus === 'syncing')
          ? `<button class="btn" id="sync-off">Выключить синхронизацию</button>
             <button class="btn" id="sync-pass">Сменить пароль</button>`
          : `<button class="btn primary" id="sync-on" ${(!sid || !kf) ? 'disabled' : ''}>${icon('reg')} Включить синхронизацию</button>`}
      </div>
      ${(!sid || !kf) ? `<p class="hint">
        ${!sid ? 'Создай Sync ID на одном устройстве, «Скопировать» → на втором «Вставить» тот же. ' : ''}
        ${!kf ? '<b>Нужен keyfile</b> (выше) — без него синк не расшифровать.' : ''}
      </p>` : ''}
    </section>` : ''}
    ${lockCard}`;

  // Замок (Шаг 5): включение через модалку (пароль в окне + Face ID по отдельной кнопке —
  // иначе iOS Safari бросает «document is not focused» на create() после нативного prompt).
  if ($('#lock-enable')) $('#lock-enable').onclick = () => openLockSetup();
  if ($('#lock-disable')) $('#lock-disable').onclick = async () => {
    if (!confirm('Выключить замок? Открытие перестанет спрашивать Face/Touch ID/пароль (данные останутся зашифрованы).')) return;
    await clearLock(S.db);
    if (S.vaultKey && S.vaultSalt) await setSyncKey(S.db, { key: S.vaultKey, salt: S.vaultSalt }); // вернуть «запомнить на устройстве»
    alert('Замок выключен.');
    render();
  };

  // --- keyfile (второй фактор) ---
  const downloadBytes = (bytes, name, type = 'application/octet-stream') => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if ($('#kf-create')) $('#kf-create').onclick = async () => {
    const bytes = generateKeyfile();
    await setKeyfile(S.db, bytes);
    S.currentKeyfile = bytes;
    downloadBytes(bytes, 'nagruzka.key');
    alert('keyfile создан и скачан.\n\nПерекиньте nagruzka.key на второе устройство (AirDrop) и там нажмите «Загрузить keyfile». Этот файл — НЕ для отправки вместе с зашифрованной копией.');
    render();
  };
  if ($('#kf-download')) $('#kf-download').onclick = () => downloadBytes(kf, 'nagruzka.key');
  if ($('#kf-clear')) $('#kf-clear').onclick = async () => {
    if (!confirm('Удалить keyfile с этого устройства? Зашифрованные с ним копии перестанут открываться здесь, пока не загрузите keyfile снова.')) return;
    await clearKeyfile(S.db);
    S.currentKeyfile = null;
    render();
  };
  $('#kf-load').onclick = () => $('#kf-file').click();
  $('#kf-file').addEventListener('change', async e => {
    const input = e.target;
    try {
      const file = input.files[0];
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length !== 32) {
        alert('Это не похоже на keyfile «Нагрузки» (ожидается 32 байта).');
        return;
      }
      await setKeyfile(S.db, bytes);
      S.currentKeyfile = bytes;
      alert('keyfile загружен ✓');
      render();
    } finally {
      resetFileInput(input);
    }
  });

  // --- зашифрованная копия ---
  $('#enc-export-btn').onclick = async () => {
    try {
      let bytes;
      if (S.syncEngine?.key && S.syncEngine?.salt) {
        // один пароль: файл шифруется ключом синхронизации (keyfile для синка обязателен),
        // открывается тем же паролем приложения — отдельный пароль для файла не нужен.
        bytes = await encryptTextWithKey(exportState(S.state), S.syncEngine.key, S.syncEngine.salt, !!kf);
      } else {
        // синхронизация не настроена — задаём пароль для файла вручную
        const pass = prompt('Пароль для шифрования (запиши — без него файл не открыть):');
        if (!pass) return;
        const again = prompt('Повтори пароль:');
        if (pass !== again) { alert('Пароли не совпали.'); return; }
        bytes = await encryptText(exportState(S.state), pass, kf);
      }
      downloadBytes(bytes, `nagruzka-${todayISO()}.nz`);
      alert('Зашифрованная копия сохранена ✓' + (kf ? '\n(с keyfile)' : '\n(без keyfile — только пароль)'));
    } catch (err) {
      alert('Не получилось: ' + err.message);
    }
  };

  $('#enc-import-btn').onclick = () => $('#enc-import-file').click();
  $('#enc-import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const meta = inspect(bytes); // проверка сигнатуры + нужен ли keyfile
      if (meta.needsKeyfile && !kf) {
        alert('Этот файл зашифрован с keyfile, а на устройстве его нет. Сначала загрузите keyfile.');
        return;
      }
      const pass = prompt('Пароль от копии (обычно — пароль синхронизации):');
      if (!pass) return;
      const useKf = meta.needsKeyfile ? kf : null;
      // Бэкап чанка привязан к AAD=id чанка; ручной экспорт и legacy-бэкап — без AAD.
      // Пробуем с AAD, при неудаче — без (неверный пароль провалит обе → корректная ошибка).
      const chunkAad = sid ? await deriveChunkId(sid, CHUNK_NAGRUZKA) : null;
      let json;
      try {
        json = await decryptToText(bytes, pass, useKf, chunkAad);
      } catch (e1) {
        if (!chunkAad) throw e1;
        json = await decryptToText(bytes, pass, useKf); // ретрай без AAD
      }
      // что внутри — показываем перед заменой
      const data = JSON.parse(json);
      const when = (data.exportedAt || '').slice(0, 10);
      const ok = confirm(
        `Расшифровано ✓\nДата копии: ${when || '—'}\n` +
        `Записей: ${data.records?.length ?? 0}, рассрочек: ${data.installments?.length ?? 0}\n\n` +
        'Импорт ЗАМЕНИТ все текущие данные. Продолжить?'
      );
      if (!ok) return;
      await adoptStateJSON(json);
      render();
      markDirty(); // если синк включён — выгрузить импортированные данные на сервер
      alert('Импорт выполнен ✓');
    } catch (err) {
      alert(err.message);
    } finally {
      resetFileInput(e.target);
    }
  });

  // --- синхронизация (этап 4b) ---
  if (syncConfigured()) {
    updateSyncStatusUI();
    if (!S.syncEngine) S.syncEngine = createSyncEngine();

    if ($('#sid-create')) $('#sid-create').onclick = async () => {
      const id = generateSyncId();
      await setSyncId(S.db, id);
      alert('Sync ID создан.\n\nНа этом устройстве нажми «Скопировать», на втором — «Вставить». Через Universal Clipboard скопированное на Маке вставляется прямо на айфоне.');
      render();
    };
    if ($('#sid-copy')) $('#sid-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(sid); alert('Sync ID скопирован ✓'); }
      catch { const i = $('#sid-show'); i.focus(); i.select(); document.execCommand('copy'); alert('Sync ID выделен — Cmd/долгий тап → Копировать'); }
    };
    if ($('#sid-paste')) $('#sid-paste').onclick = async () => {
      const txt = (prompt('Вставь Sync ID со второго устройства:') || '').trim();
      if (!txt) return;
      if (!isValidSyncId(txt)) { alert('Это не похоже на Sync ID «Нагрузки».'); return; }
      // смена Sync ID = другая ячейка: возвращаем данные в плейнтекст, сбрасываем ключ/сейф
      if (S.vaultKey) { await saveLegacy(S.db, S.state); await clearVault(S.db); S.vaultKey = null; }
      if (S.syncEngine) { S.syncEngine.stop(); S.syncEngine.key = null; }
      S.syncStatus = 'off';
      await clearSyncKey(S.db);
      await setSyncId(S.db, txt);
      alert('Sync ID сохранён ✓ Теперь включи синхронизацию.');
      render();
    };
    if ($('#sid-clear')) $('#sid-clear').onclick = async () => {
      if (!confirm('Удалить Sync ID с этого устройства? Синхронизация здесь отключится.')) return;
      if (S.vaultKey) { await saveLegacy(S.db, S.state); await clearVault(S.db); S.vaultKey = null; } // вернуть в плейнтекст
      if (S.syncEngine) { S.syncEngine.stop(); S.syncEngine.key = null; }
      S.syncStatus = 'off';
      await clearSyncId(S.db);
      await clearSyncKey(S.db);
      render();
    };

    if ($('#sync-on')) $('#sync-on').onclick = async (e) => {
      const btn = e.currentTarget;
      const pass = prompt('Пароль синхронизации (запомнится на этом устройстве; сам пароль не хранится):');
      if (!pass) return;
      try {
        S.syncStatus = 'syncing'; updateSyncStatusUI();
        await withBusy(btn, () => S.syncEngine.unlock(sid, pass));   // Argon2 (~1с) + первая сверка с сервером
        // «Запомнить на устройстве» — только БЕЗ замка: при замке K не должен лежать готовым.
        if (!(await getLock(S.db))) await setSyncKey(S.db, { key: S.syncEngine.key, salt: S.syncEngine.salt });
        S.vaultKey = S.syncEngine.key;             // включаем локальное шифрование тем же ключом
        S.vaultSalt = S.syncEngine.salt;
        const firstVault = !(await hasVault(S.db));
        await saveVault(S.db, S.vaultKey, S.state);  // сейф всегда перешифрован ТЕКУЩИМ ключом
        if (firstVault) await clearPlaintextStores(S.db); // первая настройка → плейнтекст убрать
        S.syncEngine.start();                    // фоновый опрос
        render();
      } catch (err) {
        S.syncStatus = 'off';
        alert(err.message || 'Не удалось включить синхронизацию');
        render();
      }
    };
    if ($('#sync-off')) $('#sync-off').onclick = async () => {
      S.syncEngine.stop();        // только остановить обмен; ключ и сейф оставляем —
      S.syncStatus = 'off';       // локальные данные должны читаться без пароля (замок — Шаг 5)
      render();
    };
    if ($('#sync-pass')) $('#sync-pass').onclick = async () => {
      const p1 = prompt('Новый пароль синхронизации (надёжный — запиши в менеджер паролей):');
      if (!p1) return;
      if (p1.length < 6) { alert('Слишком короткий — минимум 6 символов.'); return; }
      const p2 = prompt('Повтори новый пароль:');
      if (p1 !== p2) { alert('Пароли не совпали.'); return; }
      try {
        await S.syncEngine.changePassword(p1);                               // перешифровать + выложить
        S.vaultKey = S.syncEngine.key;                                          // и пересохранить сейф новым ключом
        if (await hasVault(S.db)) await saveVault(S.db, S.vaultKey, S.state);
        // При активном замке кэш-ключ НЕ восстанавливаем (иначе K снова лежит в готовом
        // виде и гейт обесценен), а биометрия заворачивает СТАРЫЙ ключ → сбрасываем её,
        // иначе на старте она развернёт ключ, которым сейф уже не открыть.
        const lock = await getLock(S.db);
        if (lock) {
          const hadBio = !!lock.bio;
          await setLock(S.db, { salt: lock.salt, bio: null });
          await clearSyncKey(S.db); // старый кэш-ключ (если остался) больше не нужен и не должен лежать
          alert('Пароль синхронизации изменён ✓\n\nЗамок теперь открывается НОВЫМ паролем.'
            + (hadBio ? '\nFace/Touch ID сброшен (он был привязан к старому паролю) — включи заново: Настройки → «Выключить замок» → «Включить замок».' : '')
            + '\n\nНа ДРУГИХ устройствах синк покажет «не удалось расшифровать» — там нажми «Выключить» и снова «Включить» уже с новым паролем.');
        } else {
          await setSyncKey(S.db, { key: S.syncEngine.key, salt: S.syncEngine.salt }); // запомнить новый ключ
          alert('Пароль синхронизации изменён ✓\n\nНа ДРУГИХ устройствах синк покажет «не удалось расшифровать» — там нажми «Выключить» и снова «Включить» уже с новым паролем.');
        }
        render();
      } catch (err) {
        alert(err.message);
      }
    };
  }
}

