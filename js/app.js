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
  buildTimeline, installmentSummaries, generatePeriods,
  fmtMoney, fmtPeriod, fmtMonth, loadZone,
} from './engine.js';
import { renderChart } from './views/chart.js';
import { generateKeyfile, encryptText, encryptTextWithKey, decryptToText, inspect, deriveKeyRaw, importAesKey } from './crypto.js';
import { SyncEngine, isConfigured as syncConfigured, generateSyncId, isValidSyncId, deriveChunkId, CHUNK_NAGRUZKA } from './sync.js';
import { webauthnSupported, registerBiometric, unlockBiometric } from './lock.js';
import { todayISO, horizonEnd, fmtPeriodFull, addDays, payKey, payTypeMark, plural } from './format.js';
import { $, $$, esc, uid, parseMoney, fmtNumEditor, moneyInput, wireMoneyInputs, openModal, closeModal } from './dom.js';
import {
  S, recalc, markDirty, adoptStateJSON,
  putRecord, deleteRecord, putRegular, deleteRegular, putInstallment, deleteInstallment, putSettings,
} from './store.js';


// Режим «Периодов»: на широком экране и масштабе < 150% — лента-прогноз за год
// (скролл, навигация по годам); иначе (телефон ИЛИ 150%) — один месяц, навигация по месяцам.
const isWide = () => window.matchMedia('(min-width: 1180px)').matches;
const isForecast = () => isWide() && S.zoomLevel < 1.5;

// ───────────────────────── рендер ─────────────────────────


function render() {
  recalc();
  $('#month-nav').style.visibility = S.view.tab === 'periods' ? 'visible' : 'hidden';
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === S.view.tab));
  $$('.view').forEach(v => v.hidden = v.id !== `view-${S.view.tab}`);
  if (S.view.tab === 'periods') renderPeriods();
  if (S.view.tab === 'debts') renderDebts();
  if (S.view.tab === 'chart') renderChart();
  if (S.view.tab === 'settings') renderSettings();
}

// ───────────────────────── периоды ─────────────────────────

function renderPeriods() {
  const forecast = isForecast();
  document.querySelector('.shell')?.classList.toggle('forecast-mode', forecast);
  const prefix = `${S.view.y}-${String(S.view.m).padStart(2, '0')}`;
  // forecast: вся лента года (с января выбранного года), навигация по годам;
  // иначе: один месяц, навигация по месяцам.
  $('#month-title').textContent = forecast ? String(S.view.y) : fmtMonth(S.view.y, S.view.m);
  const days = forecast
    ? [...S.timeline.values()].filter(d => d.period >= `${S.view.y}-01-01` && d.period < `${S.view.y + 1}-01-01`)
    : [...S.timeline.values()].filter(d => d.period.startsWith(prefix));
  const container = $('#periods');
  if (!days.length) {
    container.innerHTML = forecast
      ? `<div class="empty">За ${S.view.y} год периодов нет. История с января 2026.</div>`
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
        const inst = S.state.installments.find(i => i.id === data.inst);
        if (!inst) return;
        if (data.rec) {                                  // реальная запись → факт-дата, старый слот плана убрать
          const rec = S.state.records.find(r => r.id === data.rec);
          if (!rec) return;
          rec.period = target;
          if (inst.plan) inst.plan = inst.plan.filter(it => it.period !== data.src);
          S.state.records.sort(byPeriodAsc);
          await putRecord(S.db, rec);
          await putInstallment(S.db, inst);
        } else {                                         // виртуальный слот плана → пере-датировать
          if (!inst.plan) return;
          if (inst.plan.some(it => it.period === target)) return; // дата уже занята этой рассрочкой
          const slot = inst.plan.find(it => it.period === data.src);
          if (!slot) return;
          slot.period = target;
          inst.plan.sort(byPeriodAsc);
          await putInstallment(S.db, inst);
        }
      } else if (data.rec) {                             // разовый платёж
        const rec = S.state.records.find(r => r.id === data.rec);
        if (!rec) return;
        rec.period = target;
        S.state.records.sort(byPeriodAsc);
        await putRecord(S.db, rec);
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
  const day = S.timeline.get(period);
  if (type === 'r') return day.payments.find(x => !x.virtual && x.id === id);
  return day.payments.find(x => x.virtual && (x.regularId === id || x.installmentId === id));
}

async function togglePaid(fullKey, checked) {
  const [period, type, id] = fullKey.split('|');
  if (type === 'r') {
    const rec = S.state.records.find(r => r.id === id);
    if (!rec) return;
    rec.paid = checked;
    await putRecord(S.db, rec);
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
  S.state.records.push(rec);
  S.state.records.sort((a, b) => a.period < b.period ? -1 : 1);
  await putRecord(S.db, rec);
  return rec;
}

// ───────────────────────── модалка ─────────────────────────

function bankChipsHTML(selected) {
  const chips = S.state.settings.banks.map(b => `
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
      if (!S.state.settings.banks.includes(bank)) {
        S.state.settings.banks.push(bank);
        await putSettings(S.db, S.state.settings);
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
  const names = [...new Set(S.state.records
    .filter(r => r.kind === 'expense' && !r.skipped).map(r => r.name).reverse())];

  // разовый платёж (можно делать отрицательным = «мне должны»)
  const isOneOff = isNew || (!p?.regularId && !p?.installmentId);
  const isInst = !!p?.installmentId;
  const instObj = isInst ? S.state.installments.find(i => i.id === p.installmentId) : null;
  // для виртуального платежа рассрочки берём сумму из СЛОТА плана (а не из p.amount,
  // которая может быть «капнута» остатком при досрочном погашении)
  const planSlot = (isVirtual && instObj?.plan) ? instObj.plan.find(it => it.period === period) : null;
  const amountDefault = planSlot ? planSlot.amount : (p ? p.amount : '');
  // перенос на другую дату — обычный разовый платёж (для submit-ветки)
  const canMove = !isNew && !isVirtual && !p.installmentId && !p.regularId;
  // поле «Дата» показываем для разового И для рассрочки (не для регулярного и не для нового)
  const showDate = !isNew && !p.regularId;
  const movePeriods = showDate ? generatePeriods(S.state.settings.startPeriod, horizonEnd()) : [];
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
        const rec = S.state.records.find(r => r.id === p.id);
        rec.skipped = true; rec.paid = false;
        await putRecord(S.db, rec);
      } else {
        S.state.records = S.state.records.filter(r => r.id !== p.id);
        await deleteRecord(S.db, p.id);
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
      S.state.records.push(rec);
      S.state.records.sort((a, b) => a.period < b.period ? -1 : 1);
      await putRecord(S.db, rec);
    } else if (isInst) {
      // платёж рассрочки: дата меняет либо слот плана (виртуальный), либо период записи (реальный)
      const inst = S.state.installments.find(i => i.id === p.installmentId);
      const newPeriod = (showDate && f.get('period')) || period;
      if (isVirtual) {
        if (inst?.plan) {
          if (newPeriod !== period && inst.plan.some(it => it.period === newPeriod)) {
            alert('У рассрочки уже есть платёж на эту дату.'); return;
          }
          const slot = inst.plan.find(it => it.period === period);
          if (slot) { slot.period = newPeriod; slot.amount = amount; inst.plan.sort((a, b) => a.period < b.period ? -1 : 1); }
          await putInstallment(S.db, inst);
        }
      } else {
        const rec = S.state.records.find(r => r.id === p.id);
        rec.amount = amount; rec.bank = bank;
        if (newPeriod !== rec.period) {                 // переезд на факт-дату, старый слот плана убрать
          if (inst?.plan) inst.plan = inst.plan.filter(it => it.period !== rec.period);
          rec.period = newPeriod;
          S.state.records.sort((a, b) => a.period < b.period ? -1 : 1);
          if (inst) await putInstallment(S.db, inst);
        }
        await putRecord(S.db, rec);
      }
    } else if (isVirtual) {
      await materialize(period, p, { name, amount, bank });
    } else {
      const rec = S.state.records.find(r => r.id === p.id);
      Object.assign(rec, { name, amount, bank });
      const newPeriod = f.get('period');
      if (canMove && newPeriod && newPeriod !== rec.period) {
        rec.period = newPeriod;                       // перенос на другую дату
        S.state.records.sort((a, b) => a.period < b.period ? -1 : 1);
      }
      await putRecord(S.db, rec);
    }
    closeModal(); render();
  };
}

// ─────────────────── форма дохода периода ───────────────────

function openIncomeForm(period) {
  const recs = S.state.records.filter(r => r.period === period && r.kind === 'income');
  const salaryReg = S.state.regulars.find(r => r.kind === 'income' && r.active);
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
        const rec = S.state.records.find(r => r.id === src.id);
        Object.assign(rec, { name, amount });
        await putRecord(S.db, rec);
      } else if (src.virtual) {
        if (amount !== src.amount || name !== src.name) { // материализуем только изменённый
          const rec = { id: uid('i'), period, kind: 'income', name, amount, bank: null, paid: false, regularId: salaryReg?.id };
          S.state.records.push(rec);
          await putRecord(S.db, rec);
        }
      } else {
        const rec = { id: uid('i'), period, kind: 'income', name, amount, bank: null, paid: false };
        S.state.records.push(rec);
        await putRecord(S.db, rec);
      }
    }
    for (const id of deleted) {
      S.state.records = S.state.records.filter(r => r.id !== id);
      await deleteRecord(S.db, id);
    }
    S.state.records.sort((a, b) => a.period < b.period ? -1 : 1);
    closeModal(); render();
  };
}

// ───────────────────────── долги ─────────────────────────

function renderDebts() {
  const sums = installmentSummaries(S.state, S.timeline);
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
  const inst = instId ? S.state.installments.find(i => i.id === instId) : null;
  const sums = inst ? installmentSummaries(S.state, S.timeline).find(s => s.inst.id === instId) : null;
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
    for (const day of S.timeline.values()) {
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

  // Черновик существующей рассрочки → S.state для расчёта ленты (как при «Сохранить»):
  // убираем неоплаченные записи этой рассрочки, хвост берём из draftRows (план).
  function draftStateFor() {
    const records = S.state.records.filter(r => !(r.installmentId === inst.id && !r.paid));
    const plan = draftRows.filter(r => !r.paid && r.amount > 0).map(r => ({ period: r.period, amount: r.amount }));
    const draftInst = {
      ...inst, plan,
      total: parseMoney(form.total.value) || inst.total,
      perPeriod: parseMoney(form.perPeriod.value) || inst.perPeriod,
      bank: selectedBank(), name: form.name.value || inst.name,
    };
    const installments = S.state.installments.map(x => x.id === inst.id ? draftInst : x);
    return { ...S.state, records, installments };
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
    const draftState = isNew ? { ...S.state, installments: [...S.state.installments, draft] } : draftStateFor();
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
      const before = S.timeline.get(day.period);
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
    S.state.installments = S.state.installments.filter(i => i.id !== inst.id);
    await deleteInstallment(S.db, inst.id);
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
      S.state.installments.push(rec);
      await putInstallment(S.db, rec);
    } else {
      // применяем черновик: даты уникальны, неоплаченный хвост пересобираем как plan,
      // оплаченные записи не трогаем (они в S.state.records и в plan не попадают)
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
      const dropIds = S.state.records.filter(r => r.installmentId === inst.id && !r.paid).map(r => r.id);
      S.state.records = S.state.records.filter(r => !dropIds.includes(r.id));
      for (const id of dropIds) await deleteRecord(S.db, id);
      Object.assign(inst, { name, perPeriod: per || inst.perPeriod, bank: selectedBank(), total, plan, endPeriod: form.endPeriod?.value || null });
      await putInstallment(S.db, inst);
    }
    closeModal(); render();
  };
}

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
