import { SEED } from './seed.js';
import {
  initStore, loadState, exportState,
  saveVault, loadVault, hasVault, clearPlaintextStores, clearVault, saveLegacy,
  getKeyfile, setKeyfile, clearKeyfile,
  getSyncId, setSyncId, clearSyncId,
  getSyncKey, setSyncKey, clearSyncKey,
  getLock, setLock, clearLock,
} from './db.js';
import { generatePeriods, fmtMoney } from './engine.js';
import { render, registerViews } from './render.js';
import { renderPeriods, isForecast } from './views/periods.js';
import { bankChipsHTML, wireBankChips, selectedBank } from './chips.js';
import { generateKeyfile, encryptText, encryptTextWithKey, decryptToText, inspect, deriveKeyRaw, importAesKey } from './crypto.js';
import { SyncEngine, isConfigured as syncConfigured, generateSyncId, isValidSyncId, deriveChunkId, CHUNK_NAGRUZKA } from './sync.js';
import { webauthnSupported, registerBiometric, unlockBiometric } from './lock.js';
import { todayISO, horizonEnd } from './format.js';
import { $, $$, esc, uid, parseMoney, moneyInput, wireMoneyInputs, openModal, closeModal } from './dom.js';
import { S, markDirty, adoptStateJSON, putRegular, deleteRegular, putSettings } from './store.js';

// Вьюхи, ещё не вынесенные в модули, регистрируются в диспетчере (см. render.js).
registerViews({ settings: renderSettings });


// ───────────────────────── настройки ─────────────────────────

async function renderSettings() {
  const regs = S.state.regulars.filter(r => r.kind === 'expense');
  const salary = S.state.regulars.find(r => r.kind === 'income');
  const schedName = { both: 'каждый период', mid: '15-е число', end: 'конец месяца' };
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
      <h3>Зарплата</h3>
      <label class="inline-label">Сумма за период, ₽
        ${moneyInput('', salary?.amount ?? 70000, 'id="salary-input"')}
      </label>
      <p class="hint">Подставляется в каждый период (15-е и конец месяца). Факт правится в самом периоде.</p>
    </section>

    <section class="card">
      <div class="section-head"><h3>Регулярные платежи</h3>
        <button class="btn" id="add-regular">+ добавить</button></div>
      ${regs.map(r => `
        <div class="pay ${r.active ? '' : 'paid'} clickable" data-reg="${r.id}">
          <span class="pay-main">
            <span class="pay-name">${esc(r.name)}
              <span class="bank-tag">${schedName[r.schedule]}</span>
              ${r.bank ? `<span class="bank-tag">${esc(r.bank)}</span>` : ''}
              ${r.active ? '' : '<span class="bank-tag">выключен</span>'}</span>
            <span class="pay-amount">${fmtMoney(r.amount)}</span>
          </span>
        </div>`).join('') || '<div class="empty small">Пока пусто</div>'}
      <p class="hint">Изменение суммы влияет только на будущие периоды — история уже записана.</p>
    </section>

    <section class="card">
      <h3>Банки</h3>
      <div class="chips" id="settings-banks">
        ${S.state.settings.banks.map(b => `<span class="chip">${esc(b)} <button class="chip-x" data-rm-bank="${esc(b)}">×</button></span>`).join('')}
        <button type="button" class="chip pick add" id="settings-add-bank">+ банк</button>
      </div>
    </section>

    <section class="card">
      <h3>Данные</h3>
      <div class="form-actions" style="justify-content:flex-start">
        <button class="btn" id="export-btn">⬇ Экспорт в файл</button>
        <button class="btn" id="import-btn">⬆ Импорт из файла</button>
        <input type="file" id="import-file" accept=".json" hidden>
      </div>
      <p class="hint">Резервная копия — обычный JSON, без пароля. Удобно для бэкапа на этом
      устройстве; не передавайте такой файл через сеть.</p>
    </section>

    <section class="card">
      <h3>Зашифрованная копия · синхронизация</h3>
      <div class="keyfile-status ${kf ? 'on' : 'off'}">
        ${kf
          ? 'keyfile активен — второй фактор включён'
          : 'keyfile не задан — копия защищена только паролем'}
      </div>
      <div class="form-actions" style="justify-content:flex-start;margin-top:8px">
        ${kf
          ? `<button class="btn" id="kf-download">⬇ Скачать keyfile</button>
             <button class="btn danger" id="kf-clear">Удалить keyfile</button>`
          : `<button class="btn" id="kf-create">Создать keyfile</button>`}
        <button class="btn" id="kf-load">⬆ Загрузить keyfile</button>
        <input type="file" id="kf-file" hidden>
      </div>
      <div class="form-actions" style="justify-content:flex-start;margin-top:10px">
        <button class="btn primary" id="enc-export-btn">🔒 Зашифровать и сохранить</button>
        <button class="btn" id="enc-import-btn">🔓 Загрузить зашифрованную</button>
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
          : `<button class="btn primary" id="sync-on" ${(!sid || !kf) ? 'disabled' : ''}>▶ Включить синхронизацию</button>`}
      </div>
      ${(!sid || !kf) ? `<p class="hint">
        ${!sid ? 'Создай Sync ID на одном устройстве, «Скопировать» → на втором «Вставить» тот же. ' : ''}
        ${!kf ? '<b>Нужен keyfile</b> (выше) — без него синк не расшифровать.' : ''}
      </p>` : ''}
    </section>` : ''}
    ${lockCard}`;

  $('#salary-input').addEventListener('input', async e => {
    const v = parseMoney(e.target.value);
    if (!(v > 0) || !salary) return;
    salary.amount = v;
    await putRegular(S.db, salary); // без render — не теряем фокус при наборе
  });

  $('#add-regular').onclick = () => openRegularForm(null);
  $$('#view-settings [data-reg]').forEach(el => {
    el.addEventListener('click', () => openRegularForm(el.dataset.reg));
  });

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

  $('#settings-banks').addEventListener('click', async e => {
    if (e.target.id === 'settings-add-bank') {
      const name = prompt('Название банка');
      if (!name || !name.trim()) return;
      if (!S.state.settings.banks.includes(name.trim())) {
        S.state.settings.banks.push(name.trim());
        await putSettings(S.db, S.state.settings);
      }
      render();
    }
    const rm = e.target.dataset.rmBank;
    if (rm && confirm(`Убрать банк «${rm}» из списка? Старые платежи не изменятся.`)) {
      S.state.settings.banks = S.state.settings.banks.filter(b => b !== rm);
      await putSettings(S.db, S.state.settings);
      render();
    }
  });

  $('#export-btn').onclick = () => {
    const blob = new Blob([exportState(S.state)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nagruzka-backup-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  $('#import-btn').onclick = () => $('#import-file').click();
  $('#import-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Импорт ЗАМЕНИТ все текущие данные содержимым файла. Продолжить?')) return;
    try {
      await adoptStateJSON(await file.text());
      render();
      markDirty(); // если синк включён — выгрузить импортированные данные на сервер
      alert('Импорт выполнен ✓');
    } catch (err) {
      alert('Не получилось: ' + err.message);
    }
  });

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
    const file = e.target.files[0];
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
        'Импорт ЗАМЕНИТ все текущие данные. Перед заменой скачается бэкап текущего состояния. Продолжить?'
      );
      if (!ok) return;
      downloadBytes(exportState(S.state), `nagruzka-before-import-${todayISO()}.json`, 'application/json');
      await adoptStateJSON(json);
      render();
      markDirty(); // если синк включён — выгрузить импортированные данные на сервер
      alert('Импорт выполнен ✓');
    } catch (err) {
      alert(err.message);
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

    if ($('#sync-on')) $('#sync-on').onclick = async () => {
      const pass = prompt('Пароль синхронизации (запомнится на этом устройстве; сам пароль не хранится):');
      if (!pass) return;
      try {
        S.syncStatus = 'syncing'; updateSyncStatusUI();
        await S.syncEngine.unlock(sid, pass);   // деривация ключа + первая сверка с сервером
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

function openRegularForm(regId) {
  const reg = regId ? S.state.regulars.find(r => r.id === regId) : null;
  const isNew = !reg;

  openModal(`
  <form id="reg-form" class="form">
    <h3>${isNew ? 'Новый регулярный платёж' : esc(reg.name)}</h3>
    <label>Название
      <input name="name" required value="${esc(reg?.name || '')}" placeholder="Интернет">
    </label>
    <div class="row2">
      <label>Сумма, ₽
        ${moneyInput('amount', reg?.amount ?? '', '')}
      </label>
      <label>Когда
        <select name="schedule">
          <option value="mid" ${reg?.schedule === 'mid' ? 'selected' : ''}>15-е число</option>
          <option value="end" ${reg?.schedule === 'end' ? 'selected' : ''}>конец месяца</option>
          <option value="both" ${reg?.schedule === 'both' ? 'selected' : ''}>каждый период</option>
        </select>
      </label>
    </div>
    <label class="check-label">
      <input type="checkbox" name="active" ${reg?.active !== false ? 'checked' : ''}> Активен
    </label>
    ${isNew ? '<p class="hint">Новый платёж появится только в будущих периодах — прошлое не трогаем.</p>' : ''}
    <div class="lbl-like">Банк</div>
    ${bankChipsHTML(reg?.bank || null)}
    <div class="form-actions">
      ${!isNew ? `<button type="button" class="btn danger" id="reg-delete">Удалить</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn" id="modal-cancel">Отмена</button>
      <button class="btn primary">Сохранить</button>
    </div>
  </form>`);

  wireBankChips();
  $('#modal-cancel').onclick = closeModal;

  const delBtn = $('#reg-delete');
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm(`Удалить «${reg.name}»? История останется, будущие периоды очистятся.`)) return;
    S.state.regulars = S.state.regulars.filter(r => r.id !== reg.id);
    await deleteRegular(S.db, reg.id);
    closeModal(); render();
  };

  $('#reg-form').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const data = {
      name: f.name.value.trim(),
      amount: parseMoney(f.amount.value),
      schedule: f.schedule.value,
      active: f.active.checked,
      bank: selectedBank(),
    };
    if (!data.name || !Number.isFinite(data.amount)) return;
    if (isNew) {
      // новый регулярный действует только с ближайшего будущего периода
      const since = generatePeriods(todayISO().slice(0, 7) + '-01', horizonEnd())
        .find(p => p >= todayISO());
      const rec = { id: uid('reg'), kind: 'expense', since, ...data };
      S.state.regulars.push(rec);
      await putRegular(S.db, rec);
    } else {
      Object.assign(reg, data);
      await putRegular(S.db, reg);
    }
    closeModal(); render();
  };
}

// ───────────────────────── запуск ─────────────────────────

function shiftMonth(delta) {
  S.view.m += delta;
  if (S.view.m < 1) { S.view.m = 12; S.view.y--; }
  if (S.view.m > 12) { S.view.m = 1; S.view.y++; }
  render();
}
// стрелки в «Периодах»: в режиме прогноза листают ГОД, иначе — месяц
function periodsNav(delta) {
  if (isForecast()) { S.view.y += delta; render(); }
  else shiftMonth(delta);
}

function updateSyncStatusUI() {
  const el = $('#sync-status');
  if (!el) return;
  const map = {
    off: ['—', ''], locked: ['🔒 заблокировано', 'off'],
    syncing: ['⟳ синхронизация…', 'on'], synced: ['✓ синхронизировано', 'on'],
    offline: ['⚠ сервер недоступен', 'warn'], conflict: ['⚠ был конфликт, взято свежее', 'warn'],
    error: ['⚠ ошибка', 'warn'],
  };
  const [text, cls] = map[S.syncStatus] || ['—', ''];
  el.textContent = text;
  el.className = 'keyfile-status ' + cls;
}

function createSyncEngine() {
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

// Глобальная плашка связи: зелёная (на связи, авто-исчезает), красная (висит до восстановления).
let toastTimer = null;
let prevConn = null; // synced | offline | error — для показа «зелёной» только при первом/после сбоя
function showToast(kind, text, autohideMs) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = text;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  if (autohideMs) toastTimer = setTimeout(() => el.classList.remove('show'), autohideMs);
}
function hideToast() { const el = $('#toast'); if (el) { clearTimeout(toastTimer); el.classList.remove('show'); } }
function updateConnBanner(s) {
  if (s === 'syncing') return;                       // транзиентное — не трогаем плашку
  if (s === 'off' || s === 'locked') { hideToast(); prevConn = null; return; }
  if (s === 'conflict') { showToast('warn', 'Был конфликт — взято свежее', 3000); return; }
  if (s === 'synced') {
    if (prevConn !== 'synced') showToast('ok', 'Соединение установлено', 2500); // первый раз / после сбоя
    prevConn = 'synced'; return;
  }
  if (s === 'offline') { showToast('bad', 'Синхронизация приостановлена', 0); prevConn = 'offline'; return; }
  if (s === 'error')   { showToast('bad', '⚠ Не удалось расшифровать — проверь пароль/keyfile', 0); prevConn = 'error'; return; }
}

// Включение замка (Шаг 5): двухшаговая модалка. Шаг 1 — пароль в поле окна (не системный
// prompt) → деривация+проверка ключа (Argon2). Шаг 2 — регистрация биометрии ПРЯМО по нажатию
// кнопки (create() как первый вызов на свежем жесте при сфокусированном документе — иначе iOS
// Safari бросает «document is not focused»). rawK держится в замыкании между шагами.
async function openLockSetup() {
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
function runLockGate(lock) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'lock-overlay';
    ov.innerHTML = `
      <div class="lock-box">
        <div class="lock-logo">🔒</div>
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

async function main() {
  S.db = await initStore(SEED);
  S.currentKeyfile = await getKeyfile(S.db);
  const lock = await getLock(S.db);

  if (lock) {
    // ЗАМОК (Шаг 5): K открывается биометрией/паролём (overlay блокирует до успеха).
    S.vaultKey = await runLockGate(lock);
    S.vaultSalt = lock.salt;
  } else {
    // Путь 4b: свободно-используемый кэш-ключ «запомнить на устройстве».
    const saved = await getSyncKey(S.db);
    if (saved?.key) { S.vaultKey = saved.key; S.vaultSalt = saved.salt; }
  }

  // Загрузка состояния: есть ключ → зашифрованный сейф; иначе плейнтекст (или seed).
  if (S.vaultKey && await hasVault(S.db)) {
    S.state = await loadVault(S.db, S.vaultKey);
  } else {
    S.state = await loadState(S.db);
    if (S.vaultKey && !lock) {                    // 4b-миграция плейнтекст→сейф (вне замка-гейта)
      await saveVault(S.db, S.vaultKey, S.state);
      if (await loadVault(S.db, S.vaultKey)) await clearPlaintextStores(S.db); // чистим только после успешного чтения
    }
  }

  if (syncConfigured()) {
    S.syncEngine = createSyncEngine();
    const sid = await getSyncId(S.db);
    if (sid && S.vaultKey) {
      await S.syncEngine.prepare(sid);   // вычислить id чанка/меты из Sync ID
      S.syncEngine.key = S.vaultKey;
      S.syncEngine.salt = S.vaultSalt;
      S.syncEngine.version = 0;      // подтянем актуальную версию из сервера ниже
      S.syncStatus = 'synced';
      S.syncEngine.start();
      S.syncEngine.pullAndApply();
    }
  }
  $('#prev-month').addEventListener('click', () => periodsNav(-1));
  $('#next-month').addEventListener('click', () => periodsNav(1));

  // масштаб контента (только .view — топбар/таббар не трогаем). Хранится в localStorage.
  // Макс 150% — на нём «Периоды» переключаются в режим одного месяца (крупно, без скролла).
  const clampZoom = z => Math.min(1.5, Math.max(0.6, Math.round(z * 10) / 10));
  function applyZoom(z) {
    z = clampZoom(z);
    S.zoomLevel = z;
    $$('.view').forEach(v => { v.style.zoom = z; });
    const el = $('#zoom-val'); if (el) el.textContent = Math.round(z * 100) + '%';
    localStorage.setItem('zoom', String(z));
    return z;
  }
  // меняем масштаб и, если открыты «Периоды», перерисовываем (на пороге 150% меняется раскладка)
  const setZoom = z => { zoom = applyZoom(z); if (S.view.tab === 'periods') renderPeriods(); };
  let zoom = applyZoom(parseFloat(localStorage.getItem('zoom')) || 1);
  $('#zoom-in').onclick = () => setZoom(zoom + 0.1);
  $('#zoom-out').onclick = () => setZoom(zoom - 0.1);
  // хоткеи Cmd/Ctrl +/−/0 ведём через НАШ масштаб (и глушим браузерный зум,
  // иначе два зума складываются и счётчик не совпадает)
  window.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === '=' || e.key === '+')      { e.preventDefault(); setZoom(zoom + 0.1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(zoom - 0.1); }
    else if (e.key === '0')                  { e.preventDefault(); setZoom(1); }
  });
  $$('.tab').forEach(t => t.addEventListener('click', () => { S.view.tab = t.dataset.tab; render(); }));
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  $('#modal-close').onclick = closeModal;
  // пересечение порога ширины (узкий ↔ широкий) — перерисовать «Периоды» в нужном режиме
  window.matchMedia('(min-width: 1180px)').addEventListener('change', () => {
    if (S.view.tab === 'periods') renderPeriods();
  });
  wireMoneyInputs(document);
  render();
}

main();
