import { SEED } from './seed.js';
import {
  initStore, loadState, exportState,
  saveVault, loadVault, hasVault, clearPlaintextStores, clearVault, saveLegacy,
  getKeyfile, setKeyfile, clearKeyfile,
  getSyncId, setSyncId, clearSyncId,
  getSyncKey, setSyncKey, clearSyncKey,
  getLock, setLock, clearLock,
} from './db.js';
import {
  buildTimeline, installmentSummaries, generatePeriods, monthlyLoads, yearlyLoads,
  fmtMoney, groupThousands, fmtPeriod, fmtMonth, loadZone,
} from './engine.js';
import { generateKeyfile, encryptText, encryptTextWithKey, decryptToText, inspect, deriveKeyRaw, importAesKey } from './crypto.js';
import { SyncEngine, isConfigured as syncConfigured, generateSyncId, isValidSyncId, deriveChunkId, CHUNK_NAGRUZKA } from './sync.js';
import { webauthnSupported, registerBiometric, unlockBiometric } from './lock.js';

// Персистентность (этап 4b): всё состояние сохраняется одним снимком через persist().
// Есть ключ (синк настроен) → зашифрованный сейф (kv 'vault'); нет → плейнтекст-стора.
// После любого сохранения помечаем «грязным» для синка. Все мутаторы — это persist+markDirty,
// т.к. state в памяти всегда актуален (вызывающий код обновляет его до сохранения).
const markDirty = () => syncEngine?.notifyLocalChange();
async function persist() {
  if (vaultKey) await saveVault(db, vaultKey, state);
  else await saveLegacy(db, state);
}
const saveAll = async () => { await persist(); markDirty(); };
const putRecord = saveAll, deleteRecord = saveAll;
const putRegular = saveAll, deleteRegular = saveAll;
const putInstallment = saveAll, deleteInstallment = saveAll;
const putSettings = saveAll;

// Принять снимок из JSON (импорт файла / приём с сервера): заменить состояние и сохранить.
async function adoptStateJSON(json) {
  const d = JSON.parse(json);
  if (d.app !== 'nagruzka' || !d.settings || !Array.isArray(d.records)) {
    throw new Error('Это не похоже на резервную копию «Нагрузки»');
  }
  state = {
    settings: d.settings,
    regulars: d.regulars || [],
    installments: d.installments || [],
    records: (d.records || []).slice().sort((a, b) => a.period < b.period ? -1 : a.period > b.period ? 1 : 0),
  };
  await persist();
}

let db, state, timeline;
let syncEngine = null;       // движок синка (null пока не настроен)
let vaultKey = null;         // ключ локального шифрования (= ключ синка), null пока не настроен
let vaultSalt = null;        // соль этого ключа (Uint8Array) — для синка и .nz
let currentKeyfile = null;   // кэш keyfile в памяти (для движка, который читает синхронно)
let syncStatus = 'off';      // off | locked | syncing | synced | offline | conflict | error
const TODAY = new Date();
let view = { y: TODAY.getFullYear(), m: TODAY.getMonth() + 1, tab: 'periods', chartYear: TODAY.getFullYear() };
let zoomLevel = 1; // текущий масштаб (для развилки раскладки «Периодов»)

// Режим «Периодов»: на широком экране и масштабе < 150% — лента-прогноз за год
// (скролл, навигация по годам); иначе (телефон ИЛИ 150%) — один месяц, навигация по месяцам.
const isWide = () => window.matchMedia('(min-width: 1180px)').matches;
const isForecast = () => isWide() && zoomLevel < 1.5;

const HORIZON_MONTHS = 18;

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = p => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// ── денежный ввод: type=text с пробелами + свои стрелки ±1 ₽ ──
const parseMoney = v => {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace('−', '-').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};
function fmtNumEditor(n) {
  if (n === '' || n == null || (typeof n === 'number' && isNaN(n))) return '';
  const num = typeof n === 'number' ? n : parseMoney(n);
  if (isNaN(num)) return '';
  const neg = num < 0, abs = Math.abs(num);
  const int = Math.trunc(abs), frac = Math.round((abs - int) * 100);
  let s = String(int);
  if (int >= 10000) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  if (frac) s += ',' + String(frac).padStart(2, '0');
  return (neg ? '-' : '') + s;
}
// name|value|extra-attrs(класс/placeholder/aria) → разметка поля со стрелками
function moneyInput(name, value, attrs = '') {
  const v = value === '' || value == null ? '' : fmtNumEditor(value);
  return `<span class="num">
    <input type="text" inputmode="decimal" class="num-field" ${name ? `name="${name}"` : ''} value="${v}" ${attrs}>
    <span class="num-steps">
      <button type="button" class="num-step up" tabindex="-1" aria-label="+1 ₽">▲</button>
      <button type="button" class="num-step down" tabindex="-1" aria-label="−1 ₽">▼</button>
    </span>
  </span>`;
}
// Глобальная обвязка для всех money-полей внутри #modal (вешается один раз).
function wireMoneyInputs(root) {
  root.addEventListener('focusin', e => {
    if (e.target.classList?.contains('num-field')) {
      e.target.value = String(e.target.value).replace(/\s/g, '');
    }
  });
  root.addEventListener('focusout', e => {
    if (e.target.classList?.contains('num-field') && e.target.value !== '') {
      e.target.value = fmtNumEditor(parseMoney(e.target.value));
    }
  });
  root.addEventListener('click', e => {
    const step = e.target.closest('.num-step');
    if (!step) return;
    const field = step.closest('.num').querySelector('.num-field');
    const cur = parseMoney(field.value) || 0;
    field.value = fmtNumEditor(cur + (step.classList.contains('up') ? 1 : -1));
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function todayISO() {
  return `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, '0')}-${String(TODAY.getDate()).padStart(2, '0')}`;
}
function horizonEnd() {
  // последний день месяца через HORIZON_MONTHS — чтобы последний месяц был ПОЛНЫМ
  // (иначе обрывались на 28-м и терялся период конца месяца, 31-е → месяц неполный в графике)
  const d = new Date(TODAY.getFullYear(), TODAY.getMonth() + HORIZON_MONTHS + 1, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtPeriodFull(p) {
  return `${fmtPeriod(p)} ${p.slice(0, 4)}`;
}

// ───────────────────────── рендер ─────────────────────────

function recalc() { timeline = buildTimeline(state, horizonEnd()); }

function render() {
  recalc();
  $('#month-nav').style.visibility = view.tab === 'periods' ? 'visible' : 'hidden';
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === view.tab));
  $$('.view').forEach(v => v.hidden = v.id !== `view-${view.tab}`);
  if (view.tab === 'periods') renderPeriods();
  if (view.tab === 'debts') renderDebts();
  if (view.tab === 'chart') renderChart();
  if (view.tab === 'settings') renderSettings();
}

// ───────────────────────── периоды ─────────────────────────

function renderPeriods() {
  const forecast = isForecast();
  document.querySelector('.shell')?.classList.toggle('forecast-mode', forecast);
  const prefix = `${view.y}-${String(view.m).padStart(2, '0')}`;
  // forecast: вся лента года (с января выбранного года), навигация по годам;
  // иначе: один месяц, навигация по месяцам.
  $('#month-title').textContent = forecast ? String(view.y) : fmtMonth(view.y, view.m);
  const days = forecast
    ? [...timeline.values()].filter(d => d.period >= `${view.y}-01-01` && d.period < `${view.y + 1}-01-01`)
    : [...timeline.values()].filter(d => d.period.startsWith(prefix));
  const container = $('#periods');
  if (!days.length) {
    container.innerHTML = forecast
      ? `<div class="empty">За ${view.y} год периодов нет. История с января 2026.</div>`
      : `<div class="empty">Нет периодов в этом месяце — история с января 2026.</div>`;
    return;
  }
  const today = todayISO();
  const legend = `<div class="pay-legend">
    <span><span class="pay-type">🔁</span> постоянный</span>
    <span><span class="pay-type">💳</span> рассрочка</span>
    <span><span class="pay-type">💵</span> разовый</span>
    <span><span class="pay-type">🤝</span> мне должны</span>
  </div>`;
  container.innerHTML = legend + days.map(d => periodCard(d, today)).join('');

  container.querySelectorAll('input[type=checkbox][data-pay]').forEach(cb => {
    cb.addEventListener('change', () => togglePaid(cb.dataset.pay, cb.checked));
  });
  container.querySelectorAll('[data-edit-pay]').forEach(el => {
    el.addEventListener('click', () => openPaymentForm(el.dataset.period, el.dataset.editPay));
  });
  container.querySelectorAll('[data-add-pay]').forEach(el => {
    el.addEventListener('click', () => openPaymentForm(el.dataset.addPay, null));
  });
  container.querySelectorAll('[data-edit-income]').forEach(el => {
    el.addEventListener('click', () => openIncomeForm(el.dataset.editIncome));
  });

  // перетаскивание платежей между периодами (десктоп; на тач-устройствах нативный
  // HTML5-DnD не стартует — там перенос через форму). Разовый — двигаем запись;
  // платёж рассрочки — пере-датируем (виртуальный слот плана / реальную запись).
  const byPeriodAsc = (a, b) => a.period < b.period ? -1 : 1;
  container.querySelectorAll('[draggable=true][data-src]').forEach(h => {
    h.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', JSON.stringify({
        rec: h.dataset.rec || null, inst: h.dataset.inst || null, src: h.dataset.src,
      }));
      e.dataTransfer.effectAllowed = 'move';
      h.closest('.pay')?.classList.add('dragging');
    });
    h.addEventListener('dragend', () => h.closest('.pay')?.classList.remove('dragging'));
  });
  container.querySelectorAll('[data-drop-period]').forEach(card => {
    card.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; card.classList.add('drop-target'); });
    card.addEventListener('dragleave', e => { if (!card.contains(e.relatedTarget)) card.classList.remove('drop-target'); });
    card.addEventListener('drop', async e => {
      e.preventDefault();
      card.classList.remove('drop-target');
      let data; try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      const target = card.dataset.dropPeriod;
      if (!data?.src || !target || target === data.src) return;

      if (data.inst) {                                   // платёж рассрочки
        const inst = state.installments.find(i => i.id === data.inst);
        if (!inst) return;
        if (data.rec) {                                  // реальная запись → факт-дата, старый слот плана убрать
          const rec = state.records.find(r => r.id === data.rec);
          if (!rec) return;
          rec.period = target;
          if (inst.plan) inst.plan = inst.plan.filter(it => it.period !== data.src);
          state.records.sort(byPeriodAsc);
          await putRecord(db, rec);
          await putInstallment(db, inst);
        } else {                                         // виртуальный слот плана → пере-датировать
          if (!inst.plan) return;
          if (inst.plan.some(it => it.period === target)) return; // дата уже занята этой рассрочкой
          const slot = inst.plan.find(it => it.period === data.src);
          if (!slot) return;
          slot.period = target;
          inst.plan.sort(byPeriodAsc);
          await putInstallment(db, inst);
        }
      } else if (data.rec) {                             // разовый платёж
        const rec = state.records.find(r => r.id === data.rec);
        if (!rec) return;
        rec.period = target;
        state.records.sort(byPeriodAsc);
        await putRecord(db, rec);
      }
      render();
    });
  });
}

function periodCard(d, today) {
  const z = d.zone || { key: 'none', label: '—' };
  const pct = d.load == null ? '—' : Math.round(d.load * 100) + '%';
  const barW = d.load == null ? 0 : Math.min(100, d.load * 100);
  const isCurrent = d.period >= today && today > addDays(d.period, -16);
  const payments = d.payments.map(p => paymentRow(d.period, p)).join('') ||
    `<div class="empty small">Платежей нет</div>`;

  const chips = Object.keys(d.bankTouched).sort().map(bank => {
    const due = d.perBank[bank] || 0;
    return due > 0
      ? `<span class="chip due">${esc(bank)} — занести ${fmtMoney(due)}</span>`
      : `<span class="chip done">${esc(bank)} — закрыто ✓</span>`;
  }).join('');

  return `
  <section class="card ${isCurrent ? 'current' : ''}" data-drop-period="${d.period}">
    <header class="card-head">
      <div class="card-date">${fmtPeriod(d.period)}${isCurrent ? '<span class="now-dot" title="ближайший период"></span>' : ''}</div>
      <div class="head-right">
        <div class="badge zone-${z.key}">${pct} · ${z.label}</div>
        <button class="icon-btn" title="Добавить платёж" data-add-pay="${d.period}">+</button>
      </div>
    </header>
    <div class="bar"><div class="bar-fill zone-${z.key}" style="width:${barW}%"></div></div>
    <div class="stats">
      <div class="clickable" data-edit-income="${d.period}" title="Править доход периода">
        <span class="lbl">Доход ✎</span><span class="val">${fmtMoney(d.income)}</span>
      </div>
      <div><span class="lbl">Платежи</span><span class="val">${fmtMoney(d.totalExpense)}</span></div>
      <div><span class="lbl">Останется</span><span class="val ${d.leftover < 0 ? 'neg' : ''}">${fmtMoney(d.leftover)}</span></div>
      <div><span class="lbl">С переносом</span><span class="val ${d.carry < 0 ? 'neg' : ''}">${fmtMoney(d.carry)}</span></div>
    </div>
    <div class="payments">${payments}</div>
    ${chips ? `<div class="chips">${chips}</div>` : ''}
  </section>`;
}

function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function payKey(p) {
  return p.virtual ? `v|${p.regularId || p.installmentId}` : `r|${p.id}`;
}

// Тип платежа → иконка-маркер (постоянный / из рассрочки / разовый / «мне должны»)
function payTypeMark(p) {
  const owed = !p.regularId && !p.installmentId && p.amount < 0;  // дебиторка: разовый минус
  const m = owed ? ['owed', '🤝', 'Вам должны (вернётся)']
    : p.regularId ? ['reg', '🔁', 'Постоянный платёж']
    : p.installmentId ? ['inst', '💳', 'Платёж по рассрочке']
    : ['once', '💵', 'Разовый платёж'];
  return `<span class="pay-type ${m[0]}" title="${m[2]}" aria-label="${m[2]}">${m[1]}</span>`;
}

function paymentRow(period, p) {
  const progress = p.instProgress
    ? `<span class="inst-tag">${p.instProgress.paidCount}/${p.instProgress.totalCount}</span>` : '';
  const bank = p.bank ? `<span class="bank-tag">${esc(p.bank)}</span>` : '';
  // перетаскивать между периодами можно: разовый реальный платёж и ЛЮБОЙ платёж рассрочки
  // (регулярные — нет, они повторяются). data-rec — для реальной записи, data-inst — для рассрочки.
  const movable = (!p.virtual && !p.regularId && !p.installmentId) || !!p.installmentId;
  const drag = movable
    ? `draggable="true" data-src="${period}"${(p.id && !p.virtual) ? ` data-rec="${p.id}"` : ''}${p.installmentId ? ` data-inst="${p.installmentId}"` : ''}`
    : '';
  return `
  <div class="pay ${p.paid ? 'paid' : ''} ${movable ? 'movable' : ''}">
    <input type="checkbox" data-pay="${esc(`${period}|${payKey(p)}`)}" ${p.paid ? 'checked' : ''}>
    <span class="pay-main clickable" data-edit-pay="${esc(payKey(p))}" data-period="${period}" ${drag} title="${movable ? 'Тащи в другой период или кликни, чтобы править' : 'Править платёж'}">
      ${payTypeMark(p)}
      <span class="pay-name">${esc(p.name)}${progress}${bank}</span>
      <span class="pay-amount ${p.amount < 0 ? 'neg' : ''}">${fmtMoney(p.amount)}</span>
    </span>
  </div>`;
}

function findPayment(period, key) {
  const [type, id] = key.split('|');
  const day = timeline.get(period);
  if (type === 'r') return day.payments.find(x => !x.virtual && x.id === id);
  return day.payments.find(x => x.virtual && (x.regularId === id || x.installmentId === id));
}

async function togglePaid(fullKey, checked) {
  const [period, type, id] = fullKey.split('|');
  if (type === 'r') {
    const rec = state.records.find(r => r.id === id);
    if (!rec) return;
    rec.paid = checked;
    await putRecord(db, rec);
  } else {
    const p = findPayment(period, `${type}|${id}`);
    if (!p) return;
    await materialize(period, p, { paid: checked });
  }
  render();
}

// Виртуальный платёж превращаем в запись (с привязкой к источнику).
async function materialize(period, p, overrides = {}) {
  const rec = {
    id: uid('m'), period, kind: 'expense', name: p.name,
    amount: p.amount, bank: p.bank, paid: p.paid, ...overrides,
  };
  if (p.regularId) rec.regularId = p.regularId;
  if (p.installmentId) rec.installmentId = p.installmentId;
  state.records.push(rec);
  state.records.sort((a, b) => a.period < b.period ? -1 : 1);
  await putRecord(db, rec);
  return rec;
}

// ───────────────────────── модалка ─────────────────────────

function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').showModal();
}
function closeModal() { $('#modal').close(); }

function bankChipsHTML(selected) {
  const chips = state.settings.banks.map(b => `
    <button type="button" class="chip pick ${b === selected ? 'sel' : ''}" data-bank="${esc(b)}">${esc(b)}</button>`).join('');
  return `
  <div class="chips" id="bank-chips">
    <button type="button" class="chip pick ${!selected ? 'sel' : ''}" data-bank="">без банка</button>
    ${chips}
    <button type="button" class="chip pick add" id="add-bank">+ банк</button>
  </div>`;
}

function wireBankChips(onChange) {
  $('#bank-chips').addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'add-bank') {
      const name = prompt('Название банка');
      if (!name || !name.trim()) return;
      const bank = name.trim();
      if (!state.settings.banks.includes(bank)) {
        state.settings.banks.push(bank);
        await putSettings(db, state.settings);
      }
      btn.insertAdjacentHTML('beforebegin',
        `<button type="button" class="chip pick" data-bank="${esc(bank)}">${esc(bank)}</button>`);
      btn.previousElementSibling.click();
      return;
    }
    $$('#bank-chips .pick').forEach(c => c.classList.remove('sel'));
    btn.classList.add('sel');
    onChange?.(btn.dataset.bank || null);
  });
}

const selectedBank = () => $('#bank-chips .pick.sel')?.dataset.bank || null;

// ─────────────────── форма платежа (добавить/править) ───────────────────

function openPaymentForm(period, key) {
  const p = key ? findPayment(period, key) : null;
  const isNew = !p;
  const isVirtual = p?.virtual;
  const names = [...new Set(state.records
    .filter(r => r.kind === 'expense' && !r.skipped).map(r => r.name).reverse())];

  // разовый платёж (можно делать отрицательным = «мне должны»)
  const isOneOff = isNew || (!p?.regularId && !p?.installmentId);
  const isInst = !!p?.installmentId;
  const instObj = isInst ? state.installments.find(i => i.id === p.installmentId) : null;
  // для виртуального платежа рассрочки берём сумму из СЛОТА плана (а не из p.amount,
  // которая может быть «капнута» остатком при досрочном погашении)
  const planSlot = (isVirtual && instObj?.plan) ? instObj.plan.find(it => it.period === period) : null;
  const amountDefault = planSlot ? planSlot.amount : (p ? p.amount : '');
  // перенос на другую дату — обычный разовый платёж (для submit-ветки)
  const canMove = !isNew && !isVirtual && !p.installmentId && !p.regularId;
  // поле «Дата» показываем для разового И для рассрочки (не для регулярного и не для нового)
  const showDate = !isNew && !p.regularId;
  const movePeriods = showDate ? generatePeriods(state.settings.startPeriod, horizonEnd()) : [];
  if (showDate && !movePeriods.includes(period)) { movePeriods.push(period); movePeriods.sort(); }

  openModal(`
  <form id="pay-form" class="form">
    <h3>${isNew ? 'Новый платёж' : 'Платёж'} · ${fmtPeriodFull(period)}</h3>
    ${isVirtual && !isInst ? `<p class="hint">Это регулярный платёж — правка коснётся только этого периода.</p>` : ''}
    ${isInst ? `<p class="hint">Платёж по рассрочке. Дату можно поменять (например, оплатил раньше срока).</p>` : ''}
    <label>Название
      <input name="name" required autocomplete="off" list="name-suggest"
        value="${esc(p?.name || '')}" ${p?.installmentId ? 'readonly' : ''}>
      <datalist id="name-suggest">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist>
    </label>
    <label>Сумма, ₽
      ${moneyInput('amount', amountDefault, 'placeholder="5 000" required')}
    </label>
    ${isOneOff ? `<p class="hint" id="owe-hint" hidden>Минус — это деньги, которые <b>должны вам</b> (вернётся): уменьшит нагрузку периода.</p>` : ''}
    <div class="lbl-like">Банк</div>
    ${bankChipsHTML(p?.bank || null)}
    ${showDate ? `<label style="margin-top:12px">Дата
      <select name="period">${movePeriods.map(pp => `<option value="${pp}" ${pp === period ? 'selected' : ''}>${fmtPeriodFull(pp)}</option>`).join('')}</select>
    </label>` : ''}
    <div class="form-actions">
      ${!isNew ? `<button type="button" class="btn danger" id="pay-delete">${isVirtual && p.regularId ? 'Убрать из периода' : 'Удалить'}</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn" id="modal-cancel">Отмена</button>
      <button class="btn primary">Сохранить</button>
    </div>
  </form>`);

  wireBankChips();
  $('#modal-cancel').onclick = closeModal;

  // подсказку про минус показываем только когда в сумме реально стоит минус
  const oweHint = $('#owe-hint');
  const amtInp = $('#pay-form [name=amount]');
  if (oweHint && amtInp) {
    const syncHint = () => {
      const v = amtInp.value.trim();
      oweHint.hidden = !(v.startsWith('-') || v.startsWith('−'));
    };
    amtInp.addEventListener('input', syncHint);
    syncHint(); // при правке уже отрицательной записи — показать сразу
  }

  const delBtn = $('#pay-delete');
  if (delBtn) delBtn.onclick = async () => {
    if (isVirtual) {
      if (p.regularId) { // скрыть регулярный в этом периоде
        await materialize(period, p, { skipped: true, paid: false });
      } else {
        alert('Платёж по рассрочке нельзя удалить отсюда — правьте рассрочку на вкладке «Долги».');
        return;
      }
    } else {
      if (!confirm(`Удалить «${p.name}»?`)) return;
      if (p.regularId) { // вместо удаления — скрыть, иначе вернётся виртуальный
        const rec = state.records.find(r => r.id === p.id);
        rec.skipped = true; rec.paid = false;
        await putRecord(db, rec);
      } else {
        state.records = state.records.filter(r => r.id !== p.id);
        await deleteRecord(db, p.id);
      }
    }
    closeModal(); render();
  };

  $('#pay-form').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = f.get('name').trim();
    const amount = parseMoney(f.get('amount'));
    const bank = selectedBank();
    if (!name) return; // поле name с required — пустым сюда не дойдёт
    // разовый платёж может быть отрицательным (это «мне должны» — уменьшает нагрузку);
    // регулярные/рассрочки — строго больше нуля
    if (!Number.isFinite(amount) || amount === 0 || (!isOneOff && amount < 0)) {
      const inp = e.target.querySelector('[name=amount]');
      inp?.setCustomValidity(isOneOff ? 'Сумма не может быть нулём (минус — если деньги должны вам)' : 'Введите сумму больше нуля');
      inp?.reportValidity();
      inp?.addEventListener('input', () => inp.setCustomValidity(''), { once: true });
      return;
    }
    if (isNew) {
      const rec = { id: uid('p'), period, kind: 'expense', name, amount, bank, paid: false };
      state.records.push(rec);
      state.records.sort((a, b) => a.period < b.period ? -1 : 1);
      await putRecord(db, rec);
    } else if (isInst) {
      // платёж рассрочки: дата меняет либо слот плана (виртуальный), либо период записи (реальный)
      const inst = state.installments.find(i => i.id === p.installmentId);
      const newPeriod = (showDate && f.get('period')) || period;
      if (isVirtual) {
        if (inst?.plan) {
          if (newPeriod !== period && inst.plan.some(it => it.period === newPeriod)) {
            alert('У рассрочки уже есть платёж на эту дату.'); return;
          }
          const slot = inst.plan.find(it => it.period === period);
          if (slot) { slot.period = newPeriod; slot.amount = amount; inst.plan.sort((a, b) => a.period < b.period ? -1 : 1); }
          await putInstallment(db, inst);
        }
      } else {
        const rec = state.records.find(r => r.id === p.id);
        rec.amount = amount; rec.bank = bank;
        if (newPeriod !== rec.period) {                 // переезд на факт-дату, старый слот плана убрать
          if (inst?.plan) inst.plan = inst.plan.filter(it => it.period !== rec.period);
          rec.period = newPeriod;
          state.records.sort((a, b) => a.period < b.period ? -1 : 1);
          if (inst) await putInstallment(db, inst);
        }
        await putRecord(db, rec);
      }
    } else if (isVirtual) {
      await materialize(period, p, { name, amount, bank });
    } else {
      const rec = state.records.find(r => r.id === p.id);
      Object.assign(rec, { name, amount, bank });
      const newPeriod = f.get('period');
      if (canMove && newPeriod && newPeriod !== rec.period) {
        rec.period = newPeriod;                       // перенос на другую дату
        state.records.sort((a, b) => a.period < b.period ? -1 : 1);
      }
      await putRecord(db, rec);
    }
    closeModal(); render();
  };
}

// ─────────────────── форма дохода периода ───────────────────

function openIncomeForm(period) {
  const recs = state.records.filter(r => r.period === period && r.kind === 'income');
  const salaryReg = state.regulars.find(r => r.kind === 'income' && r.active);
  const rows = recs.map(r => ({ id: r.id, name: r.name, amount: r.amount }));
  if (!rows.length && salaryReg) {
    rows.push({ id: null, name: salaryReg.name, amount: salaryReg.amount, virtual: true });
  }

  const rowHTML = (r, i) => `
  <div class="income-row" data-i="${i}">
    <input name="iname" value="${esc(r.name)}" placeholder="Название">
    ${moneyInput('iamount', r.amount, 'placeholder="Сумма"')}
    <button type="button" class="icon-btn danger" data-del-row="${i}" ${r.virtual ? 'disabled title="Основной доход — правьте сумму"' : ''}>×</button>
  </div>`;

  openModal(`
  <form id="income-form" class="form">
    <h3>Доход · ${fmtPeriodFull(period)}</h3>
    <p class="hint">Факт бывает другим — правьте сумму. Вторая выплата — кнопкой ниже.</p>
    <div id="income-rows">${rows.map(rowHTML).join('')}</div>
    <button type="button" class="btn" id="add-income-row">+ добавить выплату</button>
    <div class="form-actions">
      <span class="spacer"></span>
      <button type="button" class="btn" id="modal-cancel">Отмена</button>
      <button class="btn primary">Сохранить</button>
    </div>
  </form>`);

  $('#modal-cancel').onclick = closeModal;
  const deleted = new Set();

  $('#income-rows').addEventListener('click', e => {
    const btn = e.target.closest('[data-del-row]');
    if (!btn || btn.disabled) return;
    const i = Number(btn.dataset.delRow);
    if (rows[i].id) deleted.add(rows[i].id);
    btn.closest('.income-row').remove();
  });

  $('#add-income-row').onclick = () => {
    rows.push({ id: null, name: '', amount: '' });
    $('#income-rows').insertAdjacentHTML('beforeend', rowHTML(rows[rows.length - 1], rows.length - 1));
  };

  $('#income-form').onsubmit = async e => {
    e.preventDefault();
    const domRows = $$('#income-rows .income-row');
    for (const el of domRows) {
      const i = Number(el.dataset.i);
      const name = el.querySelector('[name=iname]').value.trim();
      const amount = parseMoney(el.querySelector('[name=iamount]').value);
      if (!name || !Number.isFinite(amount)) continue;
      const src = rows[i];
      if (src.id) {
        const rec = state.records.find(r => r.id === src.id);
        Object.assign(rec, { name, amount });
        await putRecord(db, rec);
      } else if (src.virtual) {
        if (amount !== src.amount || name !== src.name) { // материализуем только изменённый
          const rec = { id: uid('i'), period, kind: 'income', name, amount, bank: null, paid: false, regularId: salaryReg?.id };
          state.records.push(rec);
          await putRecord(db, rec);
        }
      } else {
        const rec = { id: uid('i'), period, kind: 'income', name, amount, bank: null, paid: false };
        state.records.push(rec);
        await putRecord(db, rec);
      }
    }
    for (const id of deleted) {
      state.records = state.records.filter(r => r.id !== id);
      await deleteRecord(db, id);
    }
    state.records.sort((a, b) => a.period < b.period ? -1 : 1);
    closeModal(); render();
  };
}

// ───────────────────────── долги ─────────────────────────

function renderDebts() {
  const sums = installmentSummaries(state, timeline);
  const open = sums.filter(s => !s.closed);
  const closed = sums.filter(s => s.closed);

  const card = s => {
    const pctPaid = s.inst.total > 0 ? Math.min(100, s.paidSum / s.inst.total * 100) : 0;
    return `
    <section class="card debt clickable ${s.underScheduled ? 'under' : ''}" data-debt="${esc(s.inst.id)}">
      <header class="card-head">
        <div class="card-date">${esc(s.inst.name)}${s.inst.bank ? ` <span class="bank-tag">${esc(s.inst.bank)}</span>` : ''}</div>
        <div class="badge ${s.closed ? 'zone-green' : s.underScheduled ? 'zone-red' : 'zone-none'}">${s.closed ? 'закрыта ✓' : fmtMoney(s.remaining) + ' осталось'}</div>
      </header>
      <div class="bar"><div class="bar-fill zone-green" style="width:${pctPaid}%"></div></div>
      <div class="stats">
        <div><span class="lbl">Внесено</span><span class="val">${fmtMoney(s.paidSum)} из ${fmtMoney(s.inst.total)}</span></div>
        <div><span class="lbl">Платежей</span><span class="val">${s.paidCount}/${s.totalCount}</span></div>
        ${s.closed
          ? `<div><span class="lbl">Статус</span><span class="val">закрыта</span></div>`
          : `<div><span class="lbl">Следующий</span><span class="val">${s.nextPayment ? fmtMoney(s.nextPayment.amount) + ' · ' + fmtPeriod(s.nextPayment.period) : '—'}</span></div>`}
        <div><span class="lbl">${s.closed ? 'Закрыта' : 'Закроется'}</span><span class="val">${s.underScheduled ? '—' : (s.closePeriod ? fmtPeriodFull(s.closePeriod) : '—')}</span></div>
      </div>
      ${s.underScheduled ? `<div class="debt-warn">⚠ Расписанием закрыто ${fmtMoney(s.scheduledSum)} из ${fmtMoney(s.inst.total)} — не хватает платежей на <b>${fmtMoney(s.shortfall)}</b>. Откройте и добавьте «+ платёж».</div>` : ''}
    </section>`;
  };

  $('#view-debts').innerHTML = `
    <div class="section-head">
      <h2>Долги и рассрочки</h2>
      <button class="btn primary" id="add-debt">+ рассрочка</button>
    </div>
    ${open.map(card).join('') || '<div class="empty">Активных рассрочек нет 🎉</div>'}
    ${closed.length ? `<h3 class="muted-head">Закрытые</h3>${closed.map(card).join('')}` : ''}`;

  $('#add-debt').onclick = () => openDebtForm(null);
  $$('#view-debts [data-debt]').forEach(el => {
    el.addEventListener('click', () => openDebtForm(el.dataset.debt));
  });
}

function loadBadge(load) {
  if (load == null) return '<span class="dp-load">—</span>';
  const z = loadZone(load);
  return `<span class="dp-load zone-text-${z.key}">${Math.round(load * 100)}%</span>`;
}

function openDebtForm(instId) {
  const inst = instId ? state.installments.find(i => i.id === instId) : null;
  const sums = inst ? installmentSummaries(state, timeline).find(s => s.inst.id === instId) : null;
  const isNew = !inst;
  const locked = !isNew && sums.closed;   // закрыта (всё оплачено) → только просмотр
  const dis = locked ? 'disabled' : '';
  const today = todayISO();

  const allPeriods = generatePeriods(today.slice(0, 7) + '-01', horizonEnd());
  // ближайший будущий период (>= сегодня): авто-платежи ставим только сюда и дальше,
  // чтобы не назначить на уже прошедшую дату (напр. сегодня 16-е, а период 15-е — вчера)
  const firstFuture = allPeriods.find(p => p >= today) || allPeriods[0];
  // used — даты, занятые другими строками: их в выпадашке делаем недоступными (без дублей)
  const periodOptions = (sel, used) => {
    // прошлые периоды не предлагаем; но текущую дату строки оставляем (вдруг платёж просрочен).
    // позже даты окончания тоже не предлагаем (рассрочка имеет срок).
    const end = endVal();
    const base = allPeriods.filter(p => (p >= today && (!end || p <= end)) || p === sel);
    const list = (sel && !base.includes(sel)) ? [sel, ...base].sort() : base;
    return list
      .map(p => `<option value="${p}" ${p === sel ? 'selected' : ''} ${used && used.has(p) && p !== sel ? 'disabled' : ''}>${fmtPeriodFull(p)}</option>`).join('');
  };

  // Существующая рассрочка: все её платежи (записи + хвост) с нагрузкой периода.
  const payRows = [];
  if (!isNew) {
    for (const day of timeline.values()) {
      for (const p of day.payments) {
        if (p.installmentId === inst.id) payRows.push({ ...p, period: day.period, load: day.load });
      }
    }
  }

  // Новая рассрочка: редактируемое расписание (по умолчанию — авто-распределение).
  // end (опц.) — дата окончания: дальше неё платежи не ставим (рассрочка имеет срок).
  const autoSchedule = (total, per, first, end) => {
    const out = []; let rem = total;
    for (const p of allPeriods) {
      if (p < first) continue;
      if (end && p > end) break;     // строго до даты окончания
      if (rem <= 0) break;
      const a = Math.min(per, rem);
      out.push({ period: p, amount: a });
      rem -= a;
    }
    return out;
  };
  // текущая дата окончания из формы ('' = без ограничения)
  const endVal = () => $('#debt-form')?.endPeriod?.value || '';
  // <option>-ы для селектора даты окончания: периоды от start включительно + «без ограничения»
  const endOptions = (sel, start) => `<option value="">— без ограничения —</option>` +
    allPeriods.filter(p => p >= (start || firstFuture) || p === sel)
      .map(p => `<option value="${p}" ${p === sel ? 'selected' : ''}>${fmtPeriodFull(p)}</option>`).join('');
  // сколько свободных периодов в диапазоне [from..end] без занятых оплаченными
  const periodsInRange = (from, end, paidSet) => allPeriods
    .filter(p => p >= from && (!end || p <= end) && !(paidSet && paidSet.has(p))).length;
  let schedule = isNew ? [] : null;

  // Существующая рассрочка работает через ЧЕРНОВИК: правки сумм/дат/«+ платёж»/«↻»/
  // пропусков копятся в памяти и применяются только по «Сохранить». «Отмена» — откат.
  // paid-строки неизменны (только показ); неоплаченные — редактируемы.
  let draftRows = isNew ? null : payRows.map(p => ({
    paid: !!p.paid,
    period: p.period,
    amount: p.amount,
    origAmount: p.amount,
    prevAmount: null,        // запомненная сумма для тоггла «пропустить ↔ вернуть»
    name: p.name, bank: p.bank,
  }));
  const byPeriod = (a, b) => a.period < b.period ? -1 : 1;

  openModal(`
  <form id="debt-form" class="form ${locked ? 'locked' : ''}">
    <h3>${isNew ? 'Новая рассрочка' : esc(inst.name)}${locked ? ' · закрыта ✓' : ''}</h3>
    <label>Название
      <input name="name" required value="${esc(inst?.name || '')}" placeholder="Ноутбук" ${dis}>
    </label>
    <div class="row2">
      <label>Общая сумма, ₽
        ${moneyInput('total', inst?.total ?? '', `placeholder="50 000" ${dis}`)}
      </label>
      <label>Платёж в период, ₽
        ${moneyInput('perPeriod', inst?.perPeriod ?? '', `placeholder="5 000" ${dis}`)}
      </label>
    </div>
    ${!isNew && !locked ? `
    <label>Последний платёж не позже
      <select name="endPeriod">${endOptions(inst?.endPeriod || '', firstFuture)}</select>
    </label>
    <button type="button" class="btn small" id="debt-recalc">↻ Обновить</button>` : ''}
    ${!isNew ? `
    <div class="row2">
      <label>Внесено, ₽
        <input value="${fmtNumEditor(sums.paidSum)}" disabled>
      </label>
      <label>Осталось оплатить, ₽
        ${moneyInput('remaining', sums.remaining, dis)}
      </label>
    </div>
    ${locked ? '' : `<p class="hint">Поля связаны: ошиблись с ценой — правьте общую сумму; погасили досрочно —
    правьте «осталось». Внесённое не меняется.</p>`}
    <div class="lbl-like">Платежи по рассрочке</div>
    <div class="debt-pays" id="debt-pays"></div>
    ${locked ? '' : `<button type="button" class="btn small" id="debt-add-pay">+ платёж</button>
    <p class="hint">Суммы и даты можно поправить — дату меняйте в выпадашке периода. «×» — удалить
    платёж. Изменения применяются по «Сохранить» (до этого «Отмена» всё откатит).</p>`}` : ''}
    ${isNew ? `
    <div class="row2">
      <label>Первый платёж
        <select name="firstPeriod">${periodOptions(firstFuture)}</select>
      </label>
      <label>Последний платёж не позже
        <select name="endPeriod">${endOptions('', firstFuture)}</select>
      </label>
    </div>
    <div class="sched-head">
      <span class="lbl-like">Расписание платежей</span>
      <button type="button" class="btn small" id="sched-auto" title="Перераспределить автоматически">↻ авто</button>
    </div>
    <div class="sched-list" id="sched-list"></div>
    <button type="button" class="btn small" id="sched-add">+ платёж</button>` : ''}
    <div class="lbl-like" style="margin-top:12px">Банк</div>
    ${bankChipsHTML(inst?.bank || null)}
    <div id="debt-preview" class="preview-box" hidden></div>
    <div class="form-actions">
      ${!isNew ? `<button type="button" class="btn danger" id="debt-delete">Удалить</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn" id="modal-cancel">${locked ? 'Закрыть' : 'Отмена'}</button>
      ${locked ? '' : '<button class="btn primary">Сохранить</button>'}
    </div>
  </form>`);

  wireBankChips(updatePreview);
  $('#modal-cancel').onclick = closeModal;
  const form = $('#debt-form');

  // ── существующая: всё через черновик draftRows; в БД ничего до «Сохранить» ──
  function renderPayRows() {
    const box = $('#debt-pays');
    if (!box) return;
    const used = new Set(draftRows.map(r => r.period));
    box.innerHTML = draftRows.map((r, i) => `
      <div class="debt-pay-row ${r.amount === 0 ? 'skipped' : ''}" data-dpi="${i}">
        <span class="dp-status ${r.paid ? 'ok' : ''}">${r.paid ? '✓' : 'план'}</span>
        ${r.paid
          ? `<span class="dp-period">${fmtPeriodFull(r.period)}</span>`
          : `<select data-row-period title="Перенести на другую дату">${periodOptions(r.period, used)}</select>`}
        <span class="dp-load" data-row-load></span>
        ${moneyInput('', r.amount, `data-row-amount aria-label="Сумма платежа" ${r.paid ? 'disabled' : ''}`)}
        ${r.paid ? '<span></span>' : `<button type="button" class="icon-btn danger" data-row-del title="Удалить платёж">×</button>`}
      </div>`).join('') || '<div class="empty small">Платежей пока нет</div>';
    updatePreview();
  }

  if (!isNew) {
    form.addEventListener('input', updatePreview);
    form.total.addEventListener('input', () => {
      form.remaining.value = fmtNumEditor(Math.max(0, parseMoney(form.total.value) - sums.paidSum));
    });
    form.remaining.addEventListener('input', () => {
      form.total.value = fmtNumEditor(sums.paidSum + parseMoney(form.remaining.value));
    });

    const pays = $('#debt-pays');
    if (pays) {
      // смена даты платежа: проверяем уникальность, пересортируем, перерисовываем
      pays.addEventListener('change', e => {
        const row = e.target.closest('.debt-pay-row'); if (!row) return;
        const i = Number(row.dataset.dpi);
        if (e.target.matches('[data-row-period]')) {
          const v = e.target.value;
          if (draftRows.some((r, j) => j !== i && r.period === v)) { renderPayRows(); return; } // дубль — откат
          draftRows[i].period = v;
          draftRows.sort(byPeriod);
          renderPayRows();
        }
      });
      // правка суммы: без перерисовки (чтобы не терять фокус), только класс + предпросмотр
      pays.addEventListener('input', e => {
        const row = e.target.closest('.debt-pay-row'); if (!row) return;
        const i = Number(row.dataset.dpi);
        if (e.target.matches('[data-row-amount]')) {
          draftRows[i].amount = parseMoney(e.target.value) || 0;
          row.classList.toggle('skipped', draftRows[i].amount === 0);
        }
      });
      // × — удалить платёж из черновика (дата освобождается, её можно занять заново)
      pays.addEventListener('click', e => {
        const del = e.target.closest('[data-row-del]'); if (!del) return;
        const i = Number(del.closest('.debt-pay-row').dataset.dpi);
        draftRows.splice(i, 1);
        renderPayRows();
      });
    }

    // + платёж: новая строка-черновик на ближайшую свободную дату (сумма = min(платёж, остаток))
    const addPay = $('#debt-add-pay');
    if (addPay) addPay.onclick = () => {
      const end = endVal();
      const used = new Set(draftRows.map(r => r.period));
      const next = allPeriods.find(p => p >= today && (!end || p <= end) && !used.has(p));
      if (!next) { alert(end ? `До ${fmtPeriodFull(end)} свободных дат больше нет — сдвиньте дату окончания.` : 'Свободных дат в горизонте больше нет.'); return; }
      const total = parseMoney(form.total.value) || inst.total || 0;
      const planned = draftRows.reduce((s, r) => s + (r.amount || 0), 0);
      const remaining = Math.round(total - planned);
      const per = parseMoney(form.perPeriod.value) || inst.perPeriod || 0;
      const amount = remaining > 0 ? Math.min(per || remaining, remaining) : per;
      draftRows.push({ paid: false, period: next, amount: amount > 0 ? amount : (per || 0), origAmount: amount, prevAmount: null, name: inst.name, bank: inst.bank });
      draftRows.sort(byPeriod);
      renderPayRows();
    };

    // ↻ «Обновить» — пересобрать неоплаченный хвост под «платёж в период»
    const recalcBtn = $('#debt-recalc');
    if (recalcBtn) recalcBtn.onclick = () => rebuildTail(parseMoney(form.perPeriod.value));

    renderPayRows();
  }

  // Пересборка неоплаченного хвоста существующей рассрочки под newPer (в черновик).
  // opts.silent — без диалогов (для кнопки «Платить по рекомендуемой»).
  function rebuildTail(newPer, opts = {}) {
    if (!(newPer > 0)) { if (!opts.silent) alert('Укажите «платёж в период» больше нуля.'); return; }
    const total = parseMoney(form.total.value) || inst.total;
    const paidRows = draftRows.filter(r => r.paid);
    const paidPeriods = new Set(paidRows.map(r => r.period));
    const paidSum = paidRows.reduce((s, r) => s + r.amount, 0);
    const remaining = Math.max(0, Math.round(total - paidSum));
    if (remaining <= 0) { if (!opts.silent) alert('По рассрочке уже всё оплачено — пересчитывать нечего.'); return; }
    const end = endVal();
    const lastPaid = [...paidPeriods].sort().pop() || '';
    const startFrom = allPeriods.find(p => p >= today && p > lastPaid && !paidPeriods.has(p))
      || allPeriods.find(p => p >= today && !paidPeriods.has(p));
    const tail = startFrom ? autoSchedule(remaining, newPer, startFrom, end).filter(it => !paidPeriods.has(it.period)) : [];
    if (!tail.length) { if (!opts.silent) alert('Нет свободных дат в горизонте для пересчёта.'); return; }
    if (!opts.silent) {
      const lastAmt = tail[tail.length - 1].amount;
      const tailSum = tail.reduce((s, x) => s + x.amount, 0);
      const shortfall = Math.round(remaining - tailSum);
      let msg = `Обновить под платёж ${fmtMoney(newPer)}?\n\nОстаток ${fmtMoney(remaining)} → ${tail.length} ${plural(tail.length, 'платёж', 'платежа', 'платежей')} (последний ${fmtMoney(lastAmt)}).`;
      if (end && shortfall > 0) {
        const N = periodsInRange(startFrom, end, paidPeriods);
        const rec = N > 0 ? Math.ceil(remaining / N) : 0;
        msg += `\n\n⚠ До ${fmtPeriodFull(end)} не хватает ${fmtMoney(shortfall)}. Чтобы уложиться — платите по ${fmtMoney(rec)}.`;
      }
      msg += `\n\nТекущие неоплаченные платежи будут заменены.`;
      if (!confirm(msg)) return;
    }
    draftRows = [...paidRows, ...tail.map(it => ({ paid: false, period: it.period, amount: it.amount, origAmount: it.amount, prevAmount: null, name: inst.name, bank: inst.bank }))].sort(byPeriod);
    renderPayRows();
  }

  // ── новая: расписание ──
  function regenSchedule() {
    const total = parseMoney(form.total.value);
    const per = parseMoney(form.perPeriod.value);
    const first = form.firstPeriod.value;
    if (!(total > 0) || !(per > 0)) { schedule = []; renderSchedule(); return; }
    schedule = autoSchedule(total, per, first, endVal());
    renderSchedule();
  }

  function renderSchedule() {
    const list = $('#sched-list');
    if (!list) return;
    const used = new Set(schedule.map(s => s.period));
    list.innerHTML = schedule.map((row, i) => `
      <div class="sched-row" data-si="${i}">
        <select data-sched-period>${periodOptions(row.period, used)}</select>
        ${moneyInput('', row.amount, 'data-sched-amount')}
        <span class="sched-load" data-sched-load></span>
        <button type="button" class="icon-btn danger" data-sched-del title="Убрать платёж">×</button>
      </div>`).join('') || '<div class="empty small">Добавьте платёж кнопкой ниже</div>';
    updatePreview();
  }

  const firstFreePeriod = (after) => {
    const end = endVal();
    const free = p => !end || p <= end;
    const used = new Set(schedule.map(s => s.period));
    return allPeriods.find(p => p > after && free(p) && !used.has(p))
      || allPeriods.find(p => p >= firstFuture && free(p) && !used.has(p));
  };

  if (isNew) {
    regenSchedule();
    ['total', 'perPeriod', 'firstPeriod', 'endPeriod'].forEach(n =>
      form[n].addEventListener((n === 'firstPeriod' || n === 'endPeriod') ? 'change' : 'input', regenSchedule));
    $('#sched-auto').onclick = regenSchedule;
    $('#sched-add').onclick = () => {
      const per = parseMoney(form.perPeriod.value) || 0;
      const total = parseMoney(form.total.value) || 0;
      const planSum = schedule.reduce((s, x) => s + (x.amount || 0), 0);
      const remaining = total > 0 ? Math.round(total - planSum) : per;
      if (total > 0 && remaining <= 0) return;                 // всё уже распределено
      const last = schedule.length ? schedule[schedule.length - 1].period : form.firstPeriod.value;
      const next = firstFreePeriod(last);
      if (!next) { alert('Свободных дат в горизонте больше нет.'); return; }
      const amount = total > 0 ? Math.min(per || remaining, remaining) : per; // последний = остаток
      schedule.push({ period: next, amount: amount > 0 ? amount : per });
      renderSchedule();
    };
    const list = $('#sched-list');
    list.addEventListener('change', e => {
      const row = e.target.closest('.sched-row'); if (!row) return;
      const i = Number(row.dataset.si);
      // даты уникальны: дубль выбрать нельзя (опции disabled), но на всякий — защита
      if (e.target.matches('[data-sched-period]')) {
        if (schedule.some((s, j) => j !== i && s.period === e.target.value)) { renderSchedule(); return; }
        schedule[i].period = e.target.value;
        renderSchedule();
      }
    });
    list.addEventListener('input', e => {
      const row = e.target.closest('.sched-row'); if (!row) return;
      const i = Number(row.dataset.si);
      if (e.target.matches('[data-sched-amount]')) { schedule[i].amount = parseMoney(e.target.value) || 0; updatePreview(); }
    });
    list.addEventListener('click', e => {
      const del = e.target.closest('[data-sched-del]'); if (!del) return;
      const i = Number(del.closest('.sched-row').dataset.si);
      schedule.splice(i, 1);
      renderSchedule();
    });
  }

  // Черновик существующей рассрочки → state для расчёта ленты (как при «Сохранить»):
  // убираем неоплаченные записи этой рассрочки, хвост берём из draftRows (план).
  function draftStateFor() {
    const records = state.records.filter(r => !(r.installmentId === inst.id && !r.paid));
    const plan = draftRows.filter(r => !r.paid && r.amount > 0).map(r => ({ period: r.period, amount: r.amount }));
    const draftInst = {
      ...inst, plan,
      total: parseMoney(form.total.value) || inst.total,
      perPeriod: parseMoney(form.perPeriod.value) || inst.perPeriod,
      bank: selectedBank(), name: form.name.value || inst.name,
    };
    const installments = state.installments.map(x => x.id === inst.id ? draftInst : x);
    return { ...state, records, installments };
  }

  // Предпросмотр + нагрузка на каждую дату.
  function updatePreview() {
    if (isNew) {  // «+ платёж» недоступна, когда расписание уже покрывает общую сумму
      const t = parseMoney(form.total.value) || 0;
      const sum = schedule.reduce((s, x) => s + (x.amount || 0), 0);
      const addBtn = $('#sched-add');
      if (addBtn) { addBtn.disabled = t > 0 && sum >= t - 0.5; addBtn.title = addBtn.disabled ? 'Всё распределено' : ''; }
    } else {       // «+ платёж» недоступна, когда черновик покрывает общую сумму
      const t = parseMoney(form.total.value) || inst.total || 0;
      const planned = draftRows.reduce((s, r) => s + (r.amount || 0), 0);
      const addBtn = $('#debt-add-pay');
      if (addBtn) { addBtn.disabled = t > 0 && planned >= t - 0.5; addBtn.title = addBtn.disabled ? 'Всё распределено' : ''; }
    }
    const box = $('#debt-preview');
    const plan = (isNew ? schedule : draftRows.map(r => ({ period: r.period, amount: r.amount })))
      .filter(it => it.amount > 0);

    const draft = isNew
      ? { id: 'draft', name: form.name.value || 'рассрочка', total: plan.reduce((s, x) => s + x.amount, 0), perPeriod: parseMoney(form.perPeriod.value) || 0, bank: selectedBank(), plan }
      : null;
    const draftState = isNew ? { ...state, installments: [...state.installments, draft] } : draftStateFor();
    const draftTl = buildTimeline(draftState, horizonEnd());

    // нагрузка на дату в строках расписания / платежей
    if (isNew) {
      $$('#sched-list .sched-row').forEach(rowEl => {
        const i = Number(rowEl.dataset.si);
        const day = draftTl.get(schedule[i]?.period);
        rowEl.querySelector('[data-sched-load]').innerHTML = loadBadge(day ? day.load : null);
      });
    } else {
      $$('#debt-pays .debt-pay-row').forEach(rowEl => {
        const i = Number(rowEl.dataset.dpi);
        const day = draftTl.get(draftRows[i]?.period);
        rowEl.querySelector('[data-row-load]').innerHTML = loadBadge(day ? day.load : null);
      });
    }
    if (!box) return;
    if (!plan.length) { box.hidden = true; return; }

    const n = plan.length;
    const closeP = plan[plan.length - 1].period;
    const last = plan[plan.length - 1].amount;
    const planSum = plan.reduce((s, x) => s + x.amount, 0);
    const enteredTotal = isNew ? (parseMoney(form.total.value) || planSum)
      : (parseMoney(form.total.value) || inst.total || planSum);
    const shortfall = Math.round(enteredTotal - planSum);
    // диффы нагрузки — только по периодам, где есть платёж (иначе список дат
    // не сходится с числом платежей: освобождённые периоды выглядят как лишние строки)
    const planPeriods = new Set(plan.map(it => it.period));
    const diffs = [];
    for (const day of draftTl.values()) {
      if (!planPeriods.has(day.period)) continue;
      const before = timeline.get(day.period);
      if (before && day.load != null && Math.round(day.load * 100) !== Math.round((before.load ?? 0) * 100)) {
        diffs.push({ p: day.period, from: before.load ?? 0, to: day.load, zone: loadZone(day.load) });
      }
    }
    box.hidden = false;
    const recalcHint = isNew ? '«↻ авто»' : '«↻ Обновить»';
    // рекомендованный платёж, чтобы уложиться до даты окончания (если задана и не влезаем)
    const end = endVal();
    const paidPeriods = isNew ? new Set() : new Set(draftRows.filter(r => r.paid).map(r => r.period));
    const paidSum = isNew ? 0 : draftRows.filter(r => r.paid).reduce((s, r) => s + r.amount, 0);
    const rangeStart = isNew ? form.firstPeriod.value
      : (allPeriods.find(p => p >= today && !paidPeriods.has(p)) || firstFuture);
    const N = end ? periodsInRange(rangeStart, end, paidPeriods) : 0;
    const rec = (end && N > 0) ? Math.ceil((enteredTotal - paidSum) / N) : 0;
    const overEnd = end ? plan.some(it => it.period > end) : false;   // платёж позже даты
    const misfit = end && rec > 0 && (shortfall > 0 || overEnd);       // не укладываемся в срок
    const overpay = Math.round(-shortfall);                            // платежи > общей суммы

    let head;
    if (overpay > 0) {
      head = `<div class="warn">⚠ Платежи на <b>${fmtMoney(overpay)}</b> больше общей суммы —
        ${fmtMoney(planSum)} из ${fmtMoney(enteredTotal)}. Уменьшите суммы или нажмите ${recalcHint}.</div>`;
    } else if (misfit) {
      const why = shortfall > 0
        ? `До <b>${fmtPeriodFull(end)}</b> не хватает <b>${fmtMoney(shortfall)}</b>.`
        : `Платежи выходят за <b>${fmtPeriodFull(end)}</b>.`;
      head = `<div class="warn">⚠ ${why}
        Чтобы уложиться — платите по <b>${fmtMoney(rec)}</b> в период.
        <button type="button" class="btn small" id="apply-rec">Платить по ${fmtMoney(rec)}</button></div>`;
    } else if (shortfall > 0) {
      head = `<div class="warn">⚠ Платежи покрывают ${fmtMoney(planSum)} из ${fmtMoney(enteredTotal)} — не хватает на <b>${fmtMoney(shortfall)}</b>. Нажмите ${recalcHint} или «+ платёж».</div>`;
    } else {
      head = `<div><b>${n}</b> ${plural(n, 'платёж', 'платежа', 'платежей')} · последний ${fmtMoney(last)} · закроется <b>${fmtPeriodFull(closeP)}</b></div>`;
    }
    box.innerHTML = `
      ${head}
      ${diffs.slice(0, 4).map(d => `
        <div class="diff">${fmtPeriod(d.p)}: ${Math.round(d.from * 100)}% → <b class="zone-text-${d.zone.key}">${Math.round(d.to * 100)}% ${d.zone.label}</b></div>`).join('')}
      ${diffs.length > 4 ? `<div class="diff muted">…и ещё ${diffs.length - 4} ${plural(diffs.length - 4, 'период', 'периода', 'периодов')}</div>` : ''}`;

    const applyBtn = $('#apply-rec');
    if (applyBtn) applyBtn.onclick = () => {
      form.perPeriod.value = fmtNumEditor(rec);
      if (isNew) regenSchedule(); else rebuildTail(rec, { silent: true });
    };
  }

  const delBtn = $('#debt-delete');
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm(`Удалить рассрочку «${inst.name}»? История платежей останется обычными записями.`)) return;
    state.installments = state.installments.filter(i => i.id !== inst.id);
    await deleteInstallment(db, inst.id);
    closeModal(); render();
  };

  form.onsubmit = async e => {
    e.preventDefault();
    if (locked) return;                 // закрытая рассрочка — не сохраняем
    const name = form.name.value.trim();
    const per = parseMoney(form.perPeriod.value);
    if (!name) return;
    if (isNew) {
      const plan = schedule.filter(it => it.amount > 0).sort((a, b) => a.period < b.period ? -1 : 1);
      if (!plan.length) { alert('Добавьте хотя бы один платёж в расписание.'); return; }
      const dates = plan.map(p => p.period);
      if (new Set(dates).size !== dates.length) { alert('В расписании повторяются даты — сделайте их уникальными.'); return; }
      const planSum = plan.reduce((s, x) => s + x.amount, 0);
      const total = parseMoney(form.total.value) || planSum;  // общая сумма = введённая
      if (planSum < total - 0.5) {
        if (!confirm(`Расписание покрывает только ${fmtMoney(planSum)} из ${fmtMoney(total)} — не хватает платежей на ${fmtMoney(total - planSum)}.\n\nСохранить как есть? Платежи можно добавить позже.`)) return;
      } else if (planSum > total + 0.5) {
        if (!confirm(`Платежи (${fmtMoney(planSum)}) больше общей суммы (${fmtMoney(total)}) на ${fmtMoney(planSum - total)} — это переплата.\n\nСохранить как есть?`)) return;
      }
      const rec = {
        id: uid('inst'), name, total, perPeriod: per || plan[0].amount,
        bank: selectedBank(), firstPeriod: plan[0].period, plan,
        endPeriod: form.endPeriod.value || null,
      };
      state.installments.push(rec);
      await putInstallment(db, rec);
    } else {
      // применяем черновик: даты уникальны, неоплаченный хвост пересобираем как plan,
      // оплаченные записи не трогаем (они в state.records и в plan не попадают)
      const periods = draftRows.map(r => r.period);
      if (new Set(periods).size !== periods.length) { alert('У платежей повторяются даты — сделайте их уникальными.'); return; }
      const total = parseMoney(form.total.value) || inst.total;
      const plan = draftRows.filter(r => !r.paid && r.amount > 0)
        .map(r => ({ period: r.period, amount: r.amount }))
        .sort((a, b) => a.period < b.period ? -1 : 1);
      const planSum = plan.reduce((s, x) => s + x.amount, 0);
      const paidSum = draftRows.filter(r => r.paid).reduce((s, r) => s + r.amount, 0);
      if (paidSum + planSum < total - 0.5) {
        if (!confirm(`Платежи покрывают ${fmtMoney(paidSum + planSum)} из ${fmtMoney(total)} — не хватает на ${fmtMoney(total - paidSum - planSum)}.\n\nСохранить как есть? Платежи можно добавить позже.`)) return;
      } else if (paidSum + planSum > total + 0.5) {
        if (!confirm(`Платежи (${fmtMoney(paidSum + planSum)}) больше общей суммы (${fmtMoney(total)}) на ${fmtMoney(paidSum + planSum - total)} — это переплата.\n\nСохранить как есть?`)) return;
      }
      // выбрасываем прежние неоплаченные записи рассрочки — их роль теперь играет plan
      const dropIds = state.records.filter(r => r.installmentId === inst.id && !r.paid).map(r => r.id);
      state.records = state.records.filter(r => !dropIds.includes(r.id));
      for (const id of dropIds) await deleteRecord(db, id);
      Object.assign(inst, { name, perPeriod: per || inst.perPeriod, bank: selectedBank(), total, plan, endPeriod: form.endPeriod?.value || null });
      await putInstallment(db, inst);
    }
    closeModal(); render();
  };
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ───────────────────────── график ─────────────────────────

function renderChart() {
  const today = todayISO();
  const all = [...timeline.values()];
  const from = all.findIndex(d => d.period >= today);
  const data = all.slice(Math.max(0, from - 2), Math.max(0, from - 2) + 26); // ~год вперёд

  if (!data.length) { $('#view-chart').innerHTML = '<div class="empty">Нет данных</div>'; return; }

  const W = 800, H = 300, PL = 56, PR = 16, PT = 18, PB = 46;
  const xs = i => PL + i * (W - PL - PR) / Math.max(1, data.length - 1);
  const vals = data.map(d => d.carry);
  const lo = Math.min(0, ...vals), hi = Math.max(...vals) * 1.06 || 1;
  const ys = v => PT + (hi - v) * (H - PT - PB) / (hi - lo || 1);

  const pts = data.map((d, i) => `${xs(i).toFixed(1)},${ys(d.carry).toFixed(1)}`).join(' ');
  const area = `${PL},${ys(0)} ${pts} ${xs(data.length - 1)},${ys(0)}`;
  const minIdx = vals.indexOf(Math.min(...vals.slice(2)));
  const k = v => Math.abs(v) >= 1000 ? Math.round(v / 1000) + ' к' : Math.round(v);

  const monthLabels = data.map((d, i) => {
    if (!d.period.endsWith('-15')) return '';
    const [y, m] = d.period.split('-');
    return `<text x="${xs(i)}" y="${H - PB + 18}" class="ch-lbl" text-anchor="middle">${fmtMonth(+y, +m).slice(0, 3).toLowerCase()}</text>`;
  }).join('');

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const v = lo + (hi - lo) * t;
    return `<g><line x1="${PL}" x2="${W - PR}" y1="${ys(v)}" y2="${ys(v)}" class="ch-grid"/>
      <text x="${PL - 8}" y="${ys(v) + 4}" class="ch-lbl" text-anchor="end">${k(v)}</text></g>`;
  }).join('');

  const todayX = data.findIndex(d => d.period >= today);
  const dots = data.map((d, i) => `
    <circle cx="${xs(i)}" cy="${ys(d.carry)}" r="${i === minIdx ? 5 : 3}"
      class="${i === minIdx ? 'ch-dot min' : 'ch-dot'}">
      <title>${fmtPeriodFull(d.period)}: ${fmtMoney(d.carry)} (нагрузка ${d.load == null ? '—' : Math.round(d.load * 100) + '%'})</title>
    </circle>`).join('');

  $('#view-chart').innerHTML = `
    <div class="section-head"><h2>Остаток с переносом · год вперёд</h2></div>
    <div class="card">
      <svg viewBox="0 0 ${W} ${H}" class="chart">
        ${yTicks}
        ${lo < 0 ? `<line x1="${PL}" x2="${W - PR}" y1="${ys(0)}" y2="${ys(0)}" class="ch-zero"/>` : ''}
        ${todayX >= 0 ? `<line x1="${xs(todayX)}" x2="${xs(todayX)}" y1="${PT}" y2="${H - PB}" class="ch-today"/>
          <text x="${xs(todayX)}" y="${PT - 4}" class="ch-lbl accent" text-anchor="middle">сегодня</text>` : ''}
        <polygon points="${area}" class="ch-area"/>
        <polyline points="${pts}" class="ch-line"/>
        ${dots}
        ${monthLabels}
      </svg>
      <p class="hint">Минимум за период: <b>${fmtMoney(vals[minIdx])}</b> — ${fmtPeriodFull(data[minIdx].period)}.
      Перенос копится с января 2026 и учитывает только платежи из календаря.</p>
    </div>
    ${monthlyLoadChart(view.chartYear)}
    ${yearlyLoadChart()}`;

  const yp = $('#chart-year-prev'); if (yp) yp.onclick = () => { view.chartYear--; renderChart(); };
  const yn = $('#chart-year-next'); if (yn) yn.onclick = () => { view.chartYear++; renderChart(); };
}

// 12 месячных слотов года (с пустыми, если данных нет).
function monthsForYear(year) {
  const byM = new Map(monthlyLoads(timeline).filter(x => x.y === year).map(x => [x.m, x]));
  const out = [];
  for (let m = 1; m <= 12; m++) {
    out.push(byM.get(m) || { y: year, m, ym: `${year}-${String(m).padStart(2, '0')}`, income: 0, expense: 0, load: null, zone: null });
  }
  return out;
}

// Столбчатый график помесячной нагрузки за выбранный год + стрелки навигации.
function monthlyLoadChart(year) {
  const all = monthlyLoads(timeline);
  const dataYears = [...new Set(all.filter(x => x.income > 0 || x.expense > 0).map(x => x.y))];
  const minY = dataYears.length ? Math.min(...dataYears) : year;
  const maxY = dataYears.length ? Math.max(...dataYears) : year;
  const allowedMin = minY - 1, allowedMax = maxY;

  const months = monthsForYear(year);
  const hasData = months.some(m => m.load != null);
  const curYM = todayISO().slice(0, 7);

  const W = 820, H = 280, PL = 40, PR = 16, PT = 24, PB = 40;
  const n = 12, gap = 12;
  const bw = (W - PL - PR - gap * (n - 1)) / n;
  const maxLoad = Math.max(1, ...months.map(m => m.load || 0)) * 1.05;
  const ys = v => PT + (1 - v / maxLoad) * (H - PT - PB);
  const baseY = H - PB;

  const guides = [0.5, 0.75, 1].map(t => `
    <line x1="${PL}" x2="${W - PR}" y1="${ys(t)}" y2="${ys(t)}" class="ch-grid"/>
    <text x="${W - PR}" y="${ys(t) - 3}" class="ch-lbl" text-anchor="end">${Math.round(t * 100)}%</text>`).join('');

  const bars = months.map((m, i) => {
    const x = PL + i * (bw + gap);
    const h = m.load == null ? 0 : Math.max(2, baseY - ys(m.load));
    const z = m.zone ? m.zone.key : 'none';
    const pct = m.load == null ? '' : Math.round(m.load * 100) + '%';
    const isCur = m.ym === curYM;
    return `
      <g>
        <rect x="${x}" y="${baseY - h}" width="${bw}" height="${h}" rx="4" class="ch-bar zone-${z} ${isCur ? 'cur' : ''}">
          <title>${fmtMonth(m.y, m.m)}: нагрузка ${pct || '—'}, списания ${fmtMoney(m.expense)} из ${fmtMoney(m.income)}</title>
        </rect>
        <text x="${x + bw / 2}" y="${baseY - h - 6}" class="ch-lbl" text-anchor="middle">${pct}</text>
        <text x="${x + bw / 2}" y="${H - PB + 16}" class="ch-lbl" text-anchor="middle">${MON3[m.m - 1]}</text>
      </g>`;
  }).join('');

  return `
    <div class="section-head" style="margin-top:18px">
      <h2>Нагрузка по месяцам</h2>
      <div class="year-nav">
        <button id="chart-year-prev" aria-label="Предыдущий год" ${year <= allowedMin ? 'disabled' : ''}>‹</button>
        <span>${year}</span>
        <button id="chart-year-next" aria-label="Следующий год" ${year >= allowedMax ? 'disabled' : ''}>›</button>
      </div>
    </div>
    <div class="card">
      <svg viewBox="0 0 ${W} ${H}" class="chart">
        ${guides}
        <line x1="${PL}" x2="${W - PR}" y1="${baseY}" y2="${baseY}" class="ch-grid"/>
        ${bars}
        ${!hasData ? `<text x="${W / 2}" y="${(PT + baseY) / 2}" class="ch-empty" text-anchor="middle">Нет данных за ${year}</text>` : ''}
      </svg>
      <p class="hint">Сумма всех списаний за месяц делённая на доход. Текущий месяц обведён.
      Зелёный ≤50%, жёлтый ≤75%, красный выше, тёмный — перегруз.</p>
    </div>`;
}

// Столбчатый график нагрузки по годам (26, 27 …).
function yearlyLoadChart() {
  const years = yearlyLoads(timeline);
  if (!years.length) return '';

  const W = 800, H = 240, PL = 40, PR = 16, PT = 24, PB = 40;
  const n = years.length, gap = 40;
  const bw = Math.min(120, (W - PL - PR) / n - gap);
  const totalW = n * bw + (n - 1) * gap;
  const startX = PL + ((W - PL - PR) - totalW) / 2;
  const maxLoad = Math.max(1, ...years.map(y => y.load || 0)) * 1.05;
  const ys = v => PT + (1 - v / maxLoad) * (H - PT - PB);
  const baseY = H - PB;

  const guides = [0.5, 0.75, 1].map(t => `
    <line x1="${PL}" x2="${W - PR}" y1="${ys(t)}" y2="${ys(t)}" class="ch-grid"/>
    <text x="${W - PR}" y="${ys(t) - 3}" class="ch-lbl" text-anchor="end">${Math.round(t * 100)}%</text>`).join('');

  const bars = years.map((yr, i) => {
    const x = startX + i * (bw + gap);
    const h = yr.load == null ? 0 : Math.max(2, baseY - ys(yr.load));
    const z = yr.zone ? yr.zone.key : 'none';
    const pct = yr.load == null ? '—' : Math.round(yr.load * 100) + '%';
    return `
      <g>
        <rect x="${x}" y="${baseY - h}" width="${bw}" height="${h}" rx="5" class="ch-bar zone-${z}">
          <title>${yr.year}: нагрузка ${pct}, списания ${fmtMoney(yr.expense)} из ${fmtMoney(yr.income)}</title>
        </rect>
        <text x="${x + bw / 2}" y="${baseY - h - 7}" class="ch-lbl" text-anchor="middle">${pct}</text>
        <text x="${x + bw / 2}" y="${H - PB + 22}" class="ch-yr" text-anchor="middle">${String(yr.year).slice(2)}</text>
      </g>`;
  }).join('');

  return `
    <div class="section-head" style="margin-top:18px"><h2>Нагрузка по годам</h2></div>
    <div class="card">
      <svg viewBox="0 0 ${W} ${H}" class="chart">
        ${guides}
        <line x1="${PL}" x2="${W - PR}" y1="${baseY}" y2="${baseY}" class="ch-grid"/>
        ${bars}
      </svg>
      <p class="hint">Средняя нагрузка за год: все списания делённые на весь доход.
      Год показан двумя цифрами (26 = 2026).</p>
    </div>`;
}

const MON3 = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

// ───────────────────────── настройки ─────────────────────────

async function renderSettings() {
  const regs = state.regulars.filter(r => r.kind === 'expense');
  const salary = state.regulars.find(r => r.kind === 'income');
  const schedName = { both: 'каждый период', mid: '15-е число', end: 'конец месяца' };
  const kf = await getKeyfile(db); // Uint8Array | undefined
  const sid = await getSyncId(db); // base64url-строка | undefined

  // Замок (Шаг 5): включается, когда есть мастер-ключ (vaultKey); использует тот же ключ.
  const lock = await getLock(db);
  const lockCard = (vaultKey || lock) ? `
    <section class="card">
      <h3>Замок · Face / Touch ID</h3>
      ${lock
        ? `<div class="keyfile-status">Включён${lock.bio ? ' · вход по Face/Touch ID' : ' · только пароль'}. При открытии приложение спрашивает ${lock.bio ? 'Face/Touch ID (или пароль).' : 'пароль.'}</div>
           <div class="form-actions" style="justify-content:flex-start;margin-top:10px">
             <button class="btn danger" id="lock-disable">Выключить замок</button>
           </div>`
        : `<div class="keyfile-status off">Выключен — данные шифруются, но открытие без пароля.</div>
           <div class="form-actions" style="justify-content:flex-start;margin-top:10px">
             <button class="btn primary" id="lock-enable" ${vaultKey ? '' : 'disabled'}>Включить замок (Face/Touch ID)</button>
           </div>
           ${vaultKey ? '<p class="hint">Один раз подтвердишь пароль → дальше вход по Face/Touch ID (пароль — запасной).</p>' : '<p class="hint">Сначала включи синхронизацию — замок использует тот же ключ.</p>'}`}
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
        ${state.settings.banks.map(b => `<span class="chip">${esc(b)} <button class="chip-x" data-rm-bank="${esc(b)}">×</button></span>`).join('')}
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
        ${(syncStatus === 'synced' || syncStatus === 'syncing')
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
    await putRegular(db, salary); // без render — не теряем фокус при наборе
  });

  $('#add-regular').onclick = () => openRegularForm(null);
  $$('#view-settings [data-reg]').forEach(el => {
    el.addEventListener('click', () => openRegularForm(el.dataset.reg));
  });

  // Замок (Шаг 5): включение/выключение. Использует тот же ключ, что синк (vaultKey/vaultSalt).
  if ($('#lock-enable')) $('#lock-enable').onclick = async () => {
    const salt = vaultSalt || (await getSyncKey(db))?.salt;
    if (!vaultKey || !salt) { alert('Сначала включи синхронизацию — замок использует тот же ключ.'); return; }
    const pass = prompt('Подтверди пароль (тот же, что синхронизация), чтобы включить замок:');
    if (!pass) return;
    let rawK;
    try {
      rawK = await deriveKeyRaw(pass, currentKeyfile, salt);
      if (await hasVault(db)) await loadVault(db, await importAesKey(rawK)); // проверка пароля
    } catch { alert('Пароль или keyfile не подходят.'); return; }
    let bio = null;
    if (webauthnSupported()) {
      try { bio = await registerBiometric(rawK); }
      catch (e) { if (!confirm('Биометрию включить не вышло (' + (e.message || 'отменено') + ').\nВключить замок только с паролем?')) return; }
    } else if (!confirm('Это устройство не поддерживает Face/Touch ID для входа. Включить замок только с паролем?')) {
      return;
    }
    await setLock(db, { salt, bio });
    await clearSyncKey(db); // убрать свободно-используемый кэш → гейт на следующем старте
    alert('Замок включён ✓ При следующем открытии приложение спросит ' + (bio ? 'Face/Touch ID (или пароль).' : 'пароль.'));
    render();
  };
  if ($('#lock-disable')) $('#lock-disable').onclick = async () => {
    if (!confirm('Выключить замок? Открытие перестанет спрашивать Face/Touch ID/пароль (данные останутся зашифрованы).')) return;
    await clearLock(db);
    if (vaultKey && vaultSalt) await setSyncKey(db, { key: vaultKey, salt: vaultSalt }); // вернуть «запомнить на устройстве»
    alert('Замок выключен.');
    render();
  };

  $('#settings-banks').addEventListener('click', async e => {
    if (e.target.id === 'settings-add-bank') {
      const name = prompt('Название банка');
      if (!name || !name.trim()) return;
      if (!state.settings.banks.includes(name.trim())) {
        state.settings.banks.push(name.trim());
        await putSettings(db, state.settings);
      }
      render();
    }
    const rm = e.target.dataset.rmBank;
    if (rm && confirm(`Убрать банк «${rm}» из списка? Старые платежи не изменятся.`)) {
      state.settings.banks = state.settings.banks.filter(b => b !== rm);
      await putSettings(db, state.settings);
      render();
    }
  });

  $('#export-btn').onclick = () => {
    const blob = new Blob([exportState(state)], { type: 'application/json' });
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
    await setKeyfile(db, bytes);
    currentKeyfile = bytes;
    downloadBytes(bytes, 'nagruzka.key');
    alert('keyfile создан и скачан.\n\nПерекиньте nagruzka.key на второе устройство (AirDrop) и там нажмите «Загрузить keyfile». Этот файл — НЕ для отправки вместе с зашифрованной копией.');
    render();
  };
  if ($('#kf-download')) $('#kf-download').onclick = () => downloadBytes(kf, 'nagruzka.key');
  if ($('#kf-clear')) $('#kf-clear').onclick = async () => {
    if (!confirm('Удалить keyfile с этого устройства? Зашифрованные с ним копии перестанут открываться здесь, пока не загрузите keyfile снова.')) return;
    await clearKeyfile(db);
    currentKeyfile = null;
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
    await setKeyfile(db, bytes);
    currentKeyfile = bytes;
    alert('keyfile загружен ✓');
    render();
  });

  // --- зашифрованная копия ---
  $('#enc-export-btn').onclick = async () => {
    try {
      let bytes;
      if (syncEngine?.key && syncEngine?.salt) {
        // один пароль: файл шифруется ключом синхронизации (keyfile для синка обязателен),
        // открывается тем же паролем приложения — отдельный пароль для файла не нужен.
        bytes = await encryptTextWithKey(exportState(state), syncEngine.key, syncEngine.salt, !!kf);
      } else {
        // синхронизация не настроена — задаём пароль для файла вручную
        const pass = prompt('Пароль для шифрования (запиши — без него файл не открыть):');
        if (!pass) return;
        const again = prompt('Повтори пароль:');
        if (pass !== again) { alert('Пароли не совпали.'); return; }
        bytes = await encryptText(exportState(state), pass, kf);
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
      downloadBytes(exportState(state), `nagruzka-before-import-${todayISO()}.json`, 'application/json');
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
    if (!syncEngine) syncEngine = createSyncEngine();

    if ($('#sid-create')) $('#sid-create').onclick = async () => {
      const id = generateSyncId();
      await setSyncId(db, id);
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
      if (vaultKey) { await saveLegacy(db, state); await clearVault(db); vaultKey = null; }
      if (syncEngine) { syncEngine.stop(); syncEngine.key = null; }
      syncStatus = 'off';
      await clearSyncKey(db);
      await setSyncId(db, txt);
      alert('Sync ID сохранён ✓ Теперь включи синхронизацию.');
      render();
    };
    if ($('#sid-clear')) $('#sid-clear').onclick = async () => {
      if (!confirm('Удалить Sync ID с этого устройства? Синхронизация здесь отключится.')) return;
      if (vaultKey) { await saveLegacy(db, state); await clearVault(db); vaultKey = null; } // вернуть в плейнтекст
      if (syncEngine) { syncEngine.stop(); syncEngine.key = null; }
      syncStatus = 'off';
      await clearSyncId(db);
      await clearSyncKey(db);
      render();
    };

    if ($('#sync-on')) $('#sync-on').onclick = async () => {
      const pass = prompt('Пароль синхронизации (запомнится на этом устройстве; сам пароль не хранится):');
      if (!pass) return;
      try {
        syncStatus = 'syncing'; updateSyncStatusUI();
        await syncEngine.unlock(sid, pass);   // деривация ключа + первая сверка с сервером
        await setSyncKey(db, { key: syncEngine.key, salt: syncEngine.salt }); // запомнить на устройстве
        vaultKey = syncEngine.key;             // включаем локальное шифрование тем же ключом
        if (!(await hasVault(db))) {            // первая настройка → перенести плейнтекст в сейф
          await saveVault(db, vaultKey, state);
          await clearPlaintextStores(db);
        }
        syncEngine.start();                    // фоновый опрос
        render();
      } catch (err) {
        syncStatus = 'off';
        alert(err.message || 'Не удалось включить синхронизацию');
        render();
      }
    };
    if ($('#sync-off')) $('#sync-off').onclick = async () => {
      syncEngine.stop();        // только остановить обмен; ключ и сейф оставляем —
      syncStatus = 'off';       // локальные данные должны читаться без пароля (замок — Шаг 5)
      render();
    };
    if ($('#sync-pass')) $('#sync-pass').onclick = async () => {
      const p1 = prompt('Новый пароль синхронизации (надёжный — запиши в менеджер паролей):');
      if (!p1) return;
      if (p1.length < 6) { alert('Слишком короткий — минимум 6 символов.'); return; }
      const p2 = prompt('Повтори новый пароль:');
      if (p1 !== p2) { alert('Пароли не совпали.'); return; }
      try {
        await syncEngine.changePassword(p1);                               // перешифровать + выложить
        await setSyncKey(db, { key: syncEngine.key, salt: syncEngine.salt }); // запомнить новый ключ
        vaultKey = syncEngine.key;                                          // и пересохранить сейф новым ключом
        if (await hasVault(db)) await saveVault(db, vaultKey, state);
        alert('Пароль синхронизации изменён ✓\n\nНа ДРУГИХ устройствах синк покажет «не удалось расшифровать» — там нажми «Выключить» и снова «Включить» уже с новым паролем.');
        render();
      } catch (err) {
        alert(err.message);
      }
    };
  }
}

function openRegularForm(regId) {
  const reg = regId ? state.regulars.find(r => r.id === regId) : null;
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
    state.regulars = state.regulars.filter(r => r.id !== reg.id);
    await deleteRegular(db, reg.id);
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
      state.regulars.push(rec);
      await putRegular(db, rec);
    } else {
      Object.assign(reg, data);
      await putRegular(db, reg);
    }
    closeModal(); render();
  };
}

// ───────────────────────── запуск ─────────────────────────

function shiftMonth(delta) {
  view.m += delta;
  if (view.m < 1) { view.m = 12; view.y--; }
  if (view.m > 12) { view.m = 1; view.y++; }
  render();
}
// стрелки в «Периодах»: в режиме прогноза листают ГОД, иначе — месяц
function periodsNav(delta) {
  if (isForecast()) { view.y += delta; render(); }
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
  const [text, cls] = map[syncStatus] || ['—', ''];
  el.textContent = text;
  el.className = 'keyfile-status ' + cls;
}

function createSyncEngine() {
  return new SyncEngine({
    getStateJSON: () => exportState(state),
    applyStateJSON: async (json) => {
      await adoptStateJSON(json);          // заменить состояние и сохранить (сейф/плейнтекст), без эха
      render();
    },
    getKeyfile: () => currentKeyfile || null,
    onStatus: (s) => { syncStatus = s; updateSyncStatusUI(); updateConnBanner(s); },
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
    const tryBio = async () => {
      bioBtn.hidden = true;
      setErr(''); setStatus('Разблокировка по Face / Touch ID…');
      try {
        done(await importAesKey(await unlockBiometric(lock.bio)));
      } catch (e) {
        attempts++;
        setStatus('');
        if (attempts >= LOCK_MAX_BIO) {
          setErr(`Не удалось ${LOCK_MAX_BIO} раз — войди по паролю.`);
          revealPassword();
        } else {
          setErr(`Не вышло (${attempts}/${LOCK_MAX_BIO}). Повтори.`);
          bioBtn.hidden = false;
        }
      }
    };
    bioBtn.onclick = tryBio;

    passBtn.onclick = async () => {
      const pass = prompt('Пароль (тот же, что синхронизация):');
      if (!pass) return;
      setErr(''); setStatus('Проверяю…');
      try {
        const key = await importAesKey(await deriveKeyRaw(pass, currentKeyfile, lock.salt));
        if (await hasVault(db)) await loadVault(db, key); // бросит при неверном пароле/keyfile
        done(key);
      } catch (e) {
        setStatus(''); setErr('Неверный пароль или keyfile.');
      }
    };

    if (lock.bio) tryBio();      // авто-попытка биометрии при появлении замка
    else revealPassword();        // биометрии нет — сразу пароль
  });
}

async function main() {
  db = await initStore(SEED);
  currentKeyfile = await getKeyfile(db);
  const lock = await getLock(db);

  if (lock) {
    // ЗАМОК (Шаг 5): K открывается биометрией/паролём (overlay блокирует до успеха).
    vaultKey = await runLockGate(lock);
    vaultSalt = lock.salt;
  } else {
    // Путь 4b: свободно-используемый кэш-ключ «запомнить на устройстве».
    const saved = await getSyncKey(db);
    if (saved?.key) { vaultKey = saved.key; vaultSalt = saved.salt; }
  }

  // Загрузка состояния: есть ключ → зашифрованный сейф; иначе плейнтекст (или seed).
  if (vaultKey && await hasVault(db)) {
    state = await loadVault(db, vaultKey);
  } else {
    state = await loadState(db);
    if (vaultKey && !lock) {                    // 4b-миграция плейнтекст→сейф (вне замка-гейта)
      await saveVault(db, vaultKey, state);
      if (await loadVault(db, vaultKey)) await clearPlaintextStores(db); // чистим только после успешного чтения
    }
  }

  if (syncConfigured()) {
    syncEngine = createSyncEngine();
    const sid = await getSyncId(db);
    if (sid && vaultKey) {
      await syncEngine.prepare(sid);   // вычислить id чанка/меты из Sync ID
      syncEngine.key = vaultKey;
      syncEngine.salt = vaultSalt;
      syncEngine.version = 0;      // подтянем актуальную версию из сервера ниже
      syncStatus = 'synced';
      syncEngine.start();
      syncEngine.pullAndApply();
    }
  }
  $('#prev-month').addEventListener('click', () => periodsNav(-1));
  $('#next-month').addEventListener('click', () => periodsNav(1));

  // масштаб контента (только .view — топбар/таббар не трогаем). Хранится в localStorage.
  // Макс 150% — на нём «Периоды» переключаются в режим одного месяца (крупно, без скролла).
  const clampZoom = z => Math.min(1.5, Math.max(0.6, Math.round(z * 10) / 10));
  function applyZoom(z) {
    z = clampZoom(z);
    zoomLevel = z;
    $$('.view').forEach(v => { v.style.zoom = z; });
    const el = $('#zoom-val'); if (el) el.textContent = Math.round(z * 100) + '%';
    localStorage.setItem('zoom', String(z));
    return z;
  }
  // меняем масштаб и, если открыты «Периоды», перерисовываем (на пороге 150% меняется раскладка)
  const setZoom = z => { zoom = applyZoom(z); if (view.tab === 'periods') renderPeriods(); };
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
  $$('.tab').forEach(t => t.addEventListener('click', () => { view.tab = t.dataset.tab; render(); }));
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  $('#modal-close').onclick = closeModal;
  // пересечение порога ширины (узкий ↔ широкий) — перерисовать «Периоды» в нужном режиме
  window.matchMedia('(min-width: 1180px)').addEventListener('change', () => {
    if (view.tab === 'periods') renderPeriods();
  });
  wireMoneyInputs(document);
  render();
}

main();
