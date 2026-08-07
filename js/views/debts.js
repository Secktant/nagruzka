// Вкладка «Долги»: список рассрочек со сводками и форма рассрочки
// (создание/правка, редактируемое расписание платежей с нагрузкой на дату).
// Черновой пересчёт расписания идёт по draft-состоянию (buildTimeline), в базу
// пишется только по «Сохранить».

import { S, recalc, putInstallment, deleteInstallment, deleteRecord } from '../store.js';
import { render } from '../render.js';
import { $, $$, esc, uid, parseMoney, fmtNumEditor, moneyInput, openModal, closeModal } from '../dom.js';
import { bankChipsHTML, wireBankChips, selectedBank } from '../chips.js';
import { buildTimeline, installmentSummaries, generatePeriods, fmtMoney, fmtPeriod, loadZone } from '../engine.js';
import { todayISO, horizonEnd, fmtPeriodFull, plural } from '../format.js';
import { icon } from '../icons.js';
import { autoDistribute, LEVELS } from '../autoplan.js';

export function renderDebts() {
  const sums = installmentSummaries(S.state, S.timeline);
  const open = sums.filter(s => !s.closed);
  const closed = sums.filter(s => s.closed);

  // Итоги: по открытым — сколько ещё платить (и сколько уже внесено), по закрытым —
  // сколько всего выплачено. Всё уже посчитано в installmentSummaries, только суммируем.
  const total = (arr, f) => arr.reduce((n, s) => n + f(s), 0);
  const remaining = total(open, s => s.remaining);
  const paidOpen = total(open, s => s.paidSum);
  const plannedOpen = total(open, s => s.inst.total);
  const closedTotal = total(closed, s => s.inst.total);

  // Закрытые свёрнуты по умолчанию — не мозолят глаза. Состояние помним, иначе
  // блок схлопывался бы на каждой перерисовке (паттерн как у «Легенды» в Периодах).
  const closedOpen = localStorage.getItem('closedDebtsOpen') === '1';

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
    ${(open.length || closed.length) ? `
    <div class="debt-totals">
      ${open.length ? `
      <div class="dt-cell">
        <span class="dt-lbl">Осталось выплатить</span>
        <span class="dt-val">${fmtMoney(remaining)}</span>
        <span class="dt-sub">внесено ${fmtMoney(paidOpen)} из ${fmtMoney(plannedOpen)}</span>
      </div>` : ''}
      ${closed.length ? `
      <div class="dt-cell">
        <span class="dt-lbl">Закрыто всего</span>
        <span class="dt-val">${fmtMoney(closedTotal)}</span>
        <span class="dt-sub">${closed.length} ${plural(closed.length, 'рассрочка', 'рассрочки', 'рассрочек')}</span>
      </div>` : ''}
    </div>` : ''}
    ${open.map(card).join('') || '<div class="empty">Активных рассрочек нет 🎉</div>'}
    ${closed.length ? `
    <details class="debt-closed" id="closed-debts"${closedOpen ? ' open' : ''}>
      <summary>${icon('chevronRight', 'leg-caret')}Закрытые<span class="dc-count">${closed.length}</span></summary>
      <div class="dc-body">${closed.map(card).join('')}</div>
    </details>` : ''}`;

  const closedEl = $('#closed-debts');
  if (closedEl) closedEl.addEventListener('toggle', () => localStorage.setItem('closedDebtsOpen', closedEl.open ? '1' : '0'));

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
      <button type="button" class="btn small" id="sched-auto" title="Подобрать платежи под свободное место в периодах">↻ авто</button>
    </div>
    <div class="auto-note" id="sched-note" hidden></div>
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
  // Живой ввод остаётся ТУПЫМ — равномерное расписание по «платежу в период».
  // Умный подбор живёт только на кнопке «↻ авто»: иначе суммы прыгали бы прямо
  // во время набора, и понять, что ты набираешь, стало бы невозможно.
  function regenSchedule() {
    autoNote = null; pendingAuto = null;   // заметка описывает ПРЕЖНЮЮ раскладку — устарела
    const total = parseMoney(form.total.value);
    const per = parseMoney(form.perPeriod.value);
    const first = form.firstPeriod.value;
    if (!(total > 0) || !(per > 0)) { schedule = []; renderSchedule(); return; }
    schedule = autoSchedule(total, per, first, endVal());
    renderSchedule();
  }

  // ── «↻ авто»: подбор под свободное место в периодах ──
  // Заметка живёт отдельно от #debt-preview: тот пересобирается на каждый ввод,
  // а заметка должна пережить перерисовку строк после применения плана.
  let autoNote = null;      // { cls, html } или null
  let pendingAuto = null;   // план, ждущий подтверждения (перегруз)

  const noteZone = (key, word) => `<span class="zone-text-${key}">«${word}»</span>`;

  function autoFill() {
    const total = parseMoney(form.total.value);
    const first = form.firstPeriod.value;
    const end = endVal();
    // Для НОВОЙ рассрочки S.timeline и есть чистая база: её самой в состоянии ещё нет,
    // поэтому конкурировать сама с собой она не может.
    const periods = [...S.timeline.values()]
      .filter(d => d.period >= first && (!end || d.period <= end))
      .map(d => ({ period: d.period, income: d.income, expense: d.totalExpense }));

    const r = autoDistribute({ periods, total });
    pendingAuto = null;

    if (!r.ok) {
      autoNote = {
        cls: 'warn',
        html: r.reason === 'no-total'
          ? 'Укажите общую сумму — тогда авто подберёт платежи под свободное место.'
          : `Между ${fmtPeriodFull(first)}${end ? ` и ${fmtPeriodFull(end)}` : ''} нет дат с доходом. Сдвиньте даты или задайте зарплату во вкладке «Деньги».`,
      };
      renderSchedule();
      return;
    }

    const head = `<b>${r.count} ${plural(r.count, 'платёж', 'платежа', 'платежей')} по ${fmtMoney(r.payment)}</b>`;
    const last = r.plan[r.plan.length - 1].period;

    if (r.level === LEVELS[0]) {
      autoNote = { cls: 'ok', html: `${head}, последний ${fmtPeriodFull(last)}.<br>Все периоды остаются в ${noteZone('green', 'спокойно')}.` };
    } else if (r.level === LEVELS[1]) {
      const n = r.loads.filter(l => l > LEVELS[0]).length;
      autoNote = {
        cls: 'ok',
        html: `${head}, последний ${fmtPeriodFull(last)}.<br>В ${noteZone('green', 'спокойно')} не уложилось — ${n} ${plural(n, 'период', 'периода', 'периодов')} ${plural(n, 'станет', 'станут', 'станут')} ${noteZone('yellow', 'ощутимо')}.`,
      };
    } else {
      // Перегруз применяем только по подтверждению — план ждёт в pendingAuto
      pendingAuto = r.plan;
      const rows = r.over.map(x =>
        `<div class="ao-row"><span>${fmtPeriod(x.period)}</span><span class="zone-text-${loadZone(x.load).key}">${Math.round(x.load * 100)}%</span></div>`).join('');
      const n = r.over.length;
      // «выше «ощутимо»» — а не «во впритык»: перегруз тоже выше 75%, и одна
      // формулировка обязана быть верной для обеих зон (проценты в строках
      // скажут точнее, а цвет — насколько всё плохо).
      autoNote = {
        cls: 'warn',
        html: `Меньше чем на ${head} расписать не выходит.<br>${n} ${plural(n, 'период', 'периода', 'периодов')} ${plural(n, 'уходит', 'уходят', 'уходят')} выше ${noteZone('yellow', 'ощутимо')}:
          <div class="ao-list">${rows}</div>
          <button type="button" class="btn small" id="auto-apply">Расписать всё равно</button>`,
      };
    }

    if (!pendingAuto) applyAuto(r.plan, r.payment);
    else renderSchedule();
  }

  // Применение подобранного плана: расписание + «платёж в период» (чтобы форма
  // осталась связной — поле показывает ту сумму, что реально стоит в строках).
  function applyAuto(plan, per) {
    schedule = plan.map(it => ({ period: it.period, amount: it.amount }));
    if (per > 0) form.perPeriod.value = fmtNumEditor(per);
    renderSchedule();
  }

  // Любая ручная правка строки делает заметку неправдой — гасим её.
  function dropNote() { autoNote = null; pendingAuto = null; }

  function renderNote() {
    const el = $('#sched-note');
    if (!el) return;
    el.hidden = !autoNote;
    if (!autoNote) { el.innerHTML = ''; return; }
    el.className = `auto-note ${autoNote.cls}`;
    el.innerHTML = autoNote.html;
    const apply = $('#auto-apply');
    if (apply) apply.onclick = () => {
      const plan = pendingAuto;
      pendingAuto = null;
      autoNote = { cls: 'ok', html: `Расписано ${plan.length} ${plural(plan.length, 'платежом', 'платежами', 'платежами')} с перегрузкой — проверьте проценты в строках.` };
      applyAuto(plan, plan[0]?.amount || 0);
    };
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
    renderNote();
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
    $('#sched-auto').onclick = autoFill;
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
        dropNote();
        renderSchedule();
      }
    });
    list.addEventListener('input', e => {
      const row = e.target.closest('.sched-row'); if (!row) return;
      const i = Number(row.dataset.si);
      if (e.target.matches('[data-sched-amount]')) {
        schedule[i].amount = parseMoney(e.target.value) || 0;
        dropNote(); renderNote();
        updatePreview();
      }
    });
    list.addEventListener('click', e => {
      const del = e.target.closest('[data-sched-del]'); if (!del) return;
      const i = Number(del.closest('.sched-row').dataset.si);
      schedule.splice(i, 1);
      dropNote();
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
