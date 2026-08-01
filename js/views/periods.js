// Вкладка «Периоды»: лента карточек (месяц или прогноз-год), платежи с чекбоксами,
// drag-and-drop между периодами, формы платежа и дохода. Мутации → put*/delete* +
// render(); виртуальные платежи материализуются записями при правке (materialize).

import { S, putRecord, deleteRecord, putInstallment } from '../store.js';
import { render } from '../render.js';
import { $, esc, uid, parseMoney, moneyInput, openModal, closeModal, navGutter } from '../dom.js';
import { bankChipsHTML, wireBankChips, selectedBank } from '../chips.js';
import { generatePeriods, fmtMoney, fmtPeriod, fmtMonth, groupThousands } from '../engine.js';
import { todayISO, horizonEnd, fmtPeriodFull, addDays, payKey, payTypeMark } from '../format.js';
import { icon } from '../icons.js';
import { renderRail } from './rail.js';

// Режим «Периодов»: на широком экране и масштабе < 150% — лента-прогноз за год
// (скролл, навигация по годам); иначе (телефон ИЛИ 150%) — один месяц, навигация по месяцам.
// Меряем ширину, доступную КОНТЕНТУ (окно минус левое меню), а не ширину окна:
// с открытым меню на 1280px под ленту года места уже нет. navGutter() = 0, когда
// меню внизу панелью, — тогда поведение ровно прежнее.
const isWide = () => window.innerWidth - navGutter() >= 1180;
export const isForecast = () => isWide() && S.zoomLevel < 1.5;

// ── Подсветка платежей выбранного банка ──
// Жест «посмотреть сейчас», а не настройка: живёт в памяти модуля, НЕ в localStorage,
// и умирает при перезагрузке. Пережить перерисовку обязан (иначе гаснет от любой галки),
// поэтому applyBankFocus() зовётся в конце renderPeriods.
// Скоуп — карточка: чипы банков принадлежат конкретному периоду.
let bankFocus = null;   // null | { period, bank }

function applyBankFocus(container) {
  // период мог уйти с экрана (сменили месяц) — тогда подсветка теряет смысл
  if (bankFocus && !container.querySelector(`.card[data-drop-period="${bankFocus.period}"]`)) bankFocus = null;

  container.querySelectorAll('.bank-chip').forEach(c => {
    c.classList.toggle('sel', !!bankFocus
      && c.dataset.period === bankFocus.period && c.dataset.bankChip === bankFocus.bank);
  });
  container.querySelectorAll('.card[data-drop-period]').forEach(card => {
    const active = !!bankFocus && card.dataset.dropPeriod === bankFocus.period;
    card.querySelectorAll('.pay').forEach(row => {
      const match = active && row.dataset.bank === bankFocus.bank;
      row.classList.toggle('bank-hl', match);
      row.classList.toggle('bank-dim', active && !match);
    });
  });
}

// ── Сорт+фильтр (пункт 2 дорожной карты). Фильтр глобальный, сорт по-карточно —
// оба в localStorage. Дефолтный порядок НЕ трогаем: сортировка включается только
// явным тапом по колонке (1-й тап — направление, 2-й — обратное, 3-й — сброс). ──
const PAY_TYPES = ['reg', 'inst', 'once', 'owed'];
const TYPE_NAME = { reg: 'Постоянные', inst: 'Рассрочка', once: 'Разовые', owed: 'Мне должны' };
const payTypeKey = p => (!p.regularId && !p.installmentId && p.amount < 0) ? 'owed'
  : p.regularId ? 'reg' : p.installmentId ? 'inst' : 'once';

function getFilter() {
  try {
    const a = JSON.parse(localStorage.getItem('payFilter'));
    if (Array.isArray(a)) { const s = new Set(a.filter(t => PAY_TYPES.includes(t))); if (s.size) return s; }
  } catch { /* нет/битое → показываем всё */ }
  return new Set(PAY_TYPES);
}
function setFilter(set) {
  if (set.size === 0 || set.size >= PAY_TYPES.length) localStorage.removeItem('payFilter'); // «всё» = без фильтра
  else localStorage.setItem('payFilter', JSON.stringify([...set]));
}
function getSorts() { try { return JSON.parse(localStorage.getItem('paySort')) || {}; } catch { return {}; } }
function setSort(period, s) {
  const all = getSorts();
  if (s) all[period] = s; else delete all[period];
  localStorage.setItem('paySort', JSON.stringify(all));
}
// фильтр по типу + сорт по колонке (status/type/amount) для показа платежей периода
function arrangePayments(list, filter, sort) {
  let out = list.filter(p => filter.has(payTypeKey(p)));
  if (sort) {
    const ORDER = { reg: 0, inst: 1, once: 2, owed: 3 };
    const val = p => sort.key === 'status' ? (p.paid ? 1 : 0)
      : sort.key === 'type' ? ORDER[payTypeKey(p)] : p.amount;
    out = [...out].sort((a, b) => (val(a) - val(b)) * (sort.dir === 'asc' ? 1 : -1));
  }
  return out;
}
function onSortClick(period, key) {
  const cur = getSorts()[period];
  const primary = key === 'amount' ? 'desc' : 'asc';       // логичный первый клик
  let next;
  if (!cur || cur.key !== key) next = { key, dir: primary };
  else if (cur.dir === primary) next = { key, dir: primary === 'asc' ? 'desc' : 'asc' };
  else next = null;                                        // третий клик — сброс к исходному порядку
  setSort(period, next);
  renderPeriods();
}
function openFilterModal() {
  const cur = getFilter();
  const opts = PAY_TYPES.map(t => `
    <label class="filter-opt">
      <input type="checkbox" data-ftype="${t}" ${cur.has(t) ? 'checked' : ''}>
      <span class="pay-type ${t}">${icon(t)}</span> ${TYPE_NAME[t]}
    </label>`).join('');
  openModal(`
    <h3>Показывать</h3>
    <p class="hint">Какие платежи видны во всех периодах.</p>
    <label class="filter-opt filter-all"><input type="checkbox" id="f-all" ${cur.size >= PAY_TYPES.length ? 'checked' : ''}> Всё</label>
    <div class="filter-list">${opts}</div>
    <div class="form-actions">
      <button class="btn" id="f-cancel">Отмена</button>
      <button class="btn primary" id="f-apply">Применить</button>
    </div>`);
  const boxes = () => [...document.querySelectorAll('#modal [data-ftype]')];
  const allBox = $('#f-all');
  const syncAll = () => { allBox.checked = boxes().every(b => b.checked); };
  allBox.addEventListener('change', () => boxes().forEach(b => { b.checked = allBox.checked; }));
  boxes().forEach(b => b.addEventListener('change', syncAll));
  $('#f-cancel').onclick = closeModal;
  $('#f-apply').onclick = () => {
    setFilter(new Set(boxes().filter(b => b.checked).map(b => b.dataset.ftype)));
    closeModal();
    renderPeriods();
  };
}

export function renderPeriods() {
  renderRail();   // рельс — часть экрана «Периоды», диспетчер о нём не знает
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
  const filter = getFilter();
  const sorts = getSorts();
  const legendOpen = localStorage.getItem('legendOpen') === '1';
  const filterActive = filter.size < PAY_TYPES.length;
  const filterLabel = !filterActive ? 'Фильтр'
    : filter.size === 1 ? TYPE_NAME[[...filter][0]] : `${filter.size} типа`;
  const toolbar = `<div class="pay-toolbar">
    <details class="pay-legend" id="pay-legend"${legendOpen ? ' open' : ''}>
      <summary>${icon('chevronRight', 'leg-caret')}Легенда</summary>
      <div class="legend-items">
        <span><span class="pay-type reg">${icon('reg')}</span> постоянный</span>
        <span><span class="pay-type inst">${icon('inst')}</span> рассрочка</span>
        <span><span class="pay-type once">${icon('once')}</span> разовый</span>
        <span><span class="pay-type owed">${icon('owed')}</span> мне должны</span>
      </div>
    </details>
    <button class="pay-toolbtn${filterActive ? ' act' : ''}" id="pay-filter-btn" title="Фильтр по типу">${icon('funnel')}<span>${filterLabel}</span></button>
  </div>`;
  // Прокрутка внутри списков платежей должна пережить перерисовку: карточки
  // пересобираются целиком (innerHTML ниже), а это обнуляет scrollTop — отметив
  // галку в прокрученном списке, пользователь улетал в начало. Ключ — период карточки.
  const scrolled = new Map();
  container.querySelectorAll('.card[data-drop-period]').forEach(card => {
    const list = card.querySelector('.payments');
    if (list?.scrollTop) scrolled.set(card.dataset.dropPeriod, list.scrollTop);
  });

  // Число колонок сетки берём из данных, а не из auto-fit: периодов в месяце
  // ровно столько, сколько их есть, и на широком экране они обязаны стоять в
  // ряд. auto-fit меряет ширину трека и на 150% ставил их друг под друга —
  // возвращая ровно ту пустоту, ради которой всё затевалось.
  container.style.setProperty('--period-cols', days.length);
  container.innerHTML = toolbar + days.map(d => periodCard(d, today, filter, sorts)).join('');

  // назад после пересборки (браузер сам обрежет, если список стал короче)
  scrolled.forEach((top, period) => {
    const list = container.querySelector(`.card[data-drop-period="${period}"] .payments`);
    if (list) list.scrollTop = top;
  });

  // легенда свёрнута по умолчанию; запоминаем открыто/закрыто (иначе схлопывается на перерисовке)
  const legendEl = container.querySelector('#pay-legend');
  if (legendEl) legendEl.addEventListener('toggle', () => localStorage.setItem('legendOpen', legendEl.open ? '1' : '0'));
  $('#pay-filter-btn')?.addEventListener('click', openFilterModal);
  // «Скрыто фильтром» — тупик без выхода: даём выход прямо из пустого места
  container.querySelectorAll('[data-clear-filter]').forEach(el =>
    el.addEventListener('click', () => { setFilter(new Set(PAY_TYPES)); renderPeriods(); }));
  container.querySelectorAll('[data-sort]').forEach(btn =>
    btn.addEventListener('click', () => onSortClick(btn.dataset.period, btn.dataset.sort)));

  container.querySelectorAll('input[type=checkbox][data-pay]').forEach(cb => {
    cb.addEventListener('change', () => togglePaid(cb.dataset.pay, cb.checked));
  });

  // Повторный тап по тому же банку снимает подсветку. Полный render() тут не нужен:
  // меняются только классы — дешевле и не сбрасывает прокрутку списка.
  container.querySelectorAll('.bank-chip').forEach(c => {
    c.addEventListener('click', () => {
      const same = bankFocus && bankFocus.period === c.dataset.period && bankFocus.bank === c.dataset.bankChip;
      bankFocus = same ? null : { period: c.dataset.period, bank: c.dataset.bankChip };
      applyBankFocus(container);
    });
  });
  applyBankFocus(container);
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

// Доля дорожки шкалы, занятая доходом: хвост справа отдан перегрузу, поэтому
// «больше ста» читается как выход за отметку. Раньше заливка упиралась в край,
// и 101% выглядел ровно как 300%.
const INCOME_AT = 77;

function periodCard(d, today, filter, sorts) {
  const z = d.zone || { key: 'none', label: '—' };
  const has = d.load != null;
  const pct = has ? Math.round(d.load * 100) + '%' : '—';
  const fillW = has ? Math.min(d.load, 1) * INCOME_AT : 0;
  // перегруз рисуем до +30% дохода: дальше полоса перестаёт что-либо добавлять,
  // а точную величину говорит подпись «не хватает N».
  const overW = has && d.load > 1 ? Math.min(d.load - 1, 0.3) * INCOME_AT : 0;
  // Каждый факт живёт в одном месте: у шкалы — слово зоны, величину нехватки
  // говорит строка денег ниже («−19 200 ₽ не хватает»), поэтому здесь её нет.
  const caption = has ? z.label : 'дохода нет';
  // carry — накопительный остаток, поэтому «пришло с прошлого» = carry − leftover
  const prev = d.carry - d.leftover;
  const carryVal = `<span class="${d.carry < 0 ? 'neg' : ''}">${fmtMoney(d.carry)}</span>`;
  const carryLine = Math.round(prev) === 0
    ? `${carryVal} дальше`
    : `${prev > 0 ? '+' : ''}${fmtMoney(prev)} с прошлого → ${carryVal} дальше`;
  const isCurrent = d.period >= today && today > addDays(d.period, -16);
  const sort = sorts[d.period] || null;
  const shown = arrangePayments(d.payments, filter, sort);
  const sortHead = d.payments.length ? sortHeader(d.period, sort) : '';
  const payments = shown.map(p => paymentRow(d.period, p)).join('') || (d.payments.length
    ? `<div class="empty small">Все платежи скрыты фильтром.<br>
        <button type="button" class="linkish" data-clear-filter>Показать все типы</button></div>`
    : `<div class="empty small">Пусто. Добавьте платёж кнопкой + в шапке.</div>`);

  // Чипы банков кликабельны: тап подсвечивает платежи этого банка в своей карточке
  // (см. bankFocus/applyBankFocus). Поэтому button, а не span — это управляющий элемент.
  const chips = Object.keys(d.bankTouched).sort().map(bank => {
    const due = d.perBank[bank] || 0;
    const body = due > 0 ? `${esc(bank)} — занести ${fmtMoney(due)}` : `${esc(bank)} — закрыто ✓`;
    return `<button type="button" class="chip bank-chip ${due > 0 ? 'due' : 'done'}"
      data-bank-chip="${esc(bank)}" data-period="${d.period}"
      title="Показать платежи банка">${body}</button>`;
  }).join('');

  return `
  <section class="card ${isCurrent ? 'current' : ''}" data-drop-period="${d.period}">
    <header class="card-head">
      <div class="card-date">${fmtPeriod(d.period)}${isCurrent ? '<span class="now-dot" title="ближайший период"></span>' : ''}</div>
      <div class="head-right">
        <button class="icon-btn" title="Добавить платёж" data-add-pay="${d.period}">${icon('plus')}</button>
      </div>
    </header>
    <div class="gauge">
      <span class="gauge-num zone-text-${z.key}">${pct}</span>
      <span class="gauge-cap">${caption}</span>
    </div>
    <div class="track">
      <div class="track-fill zone-${z.key}" style="width:${fillW}%"></div>
      ${overW ? `<div class="track-over" style="left:${INCOME_AT}%;width:${overW}%"></div>` : ''}
      <div class="track-mark" style="left:${INCOME_AT}%"></div>
      <div class="track-lbl" style="left:${INCOME_AT}%">доход</div>
    </div>
    <div class="money">
      <div class="money-in">
        <button type="button" class="mi-inc" data-edit-income="${d.period}" title="Править доход периода">${groupThousands(d.income)}${icon('pencil')}</button>
        <span>− ${fmtMoney(d.totalExpense)}</span>
      </div>
      <div class="money-left">
        <span class="ml-val ${d.leftover < 0 ? 'neg' : ''}">${fmtMoney(d.leftover)}</span><span class="ml-lbl">${d.leftover < 0 ? 'не хватает' : 'останется'}</span>
      </div>
      <div class="money-carry">${carryLine}</div>
    </div>
    ${sortHead}
    <div class="payments">${payments}</div>
    ${chips ? `<div class="chips">${chips}</div>` : ''}
  </section>`;
}

// Заголовок-сортировка (по-карточно): статус / тип / сумма. Каретка ↑↓ на активной.
function sortHeader(period, sort) {
  const col = (key, inner, title) => {
    const on = sort && sort.key === key;
    const caret = on ? icon(sort.dir === 'asc' ? 'caretUp' : 'caretDown', 'sort-car') : '';
    return `<button type="button" class="sort-col${on ? ' on' : ''}" data-sort="${key}" data-period="${period}" title="${title}">${inner}${caret}</button>`;
  };
  return `<div class="sort-head">
    ${col('status', icon('status'), 'Сортировать по статусу (оплачен)')}
    ${col('type', icon('typeList') + '<span>тип</span>', 'Сортировать по типу')}
    <span class="sort-spacer"></span>
    ${col('amount', '<span class="sort-rub">₽</span>', 'Сортировать по сумме')}
  </div>`;
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
  <div class="pay ${p.paid ? 'paid' : ''} ${movable ? 'movable' : ''}" data-bank="${esc(p.bank || '')}">
    <input type="checkbox" data-pay="${esc(`${period}|${payKey(p)}`)}" ${p.paid ? 'checked' : ''}>
    <span class="pay-main clickable" data-edit-pay="${esc(payKey(p))}" data-period="${period}" ${drag} title="${movable ? 'Тащи в другой период или кликни, чтобы править' : 'Править платёж'}">
      ${payTypeMark(p)}
      <span class="pay-name"><span class="pn-text">${esc(p.name)}</span>${progress}${bank}</span>
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
  // разовый платёж: знак задаём тумблером «Трата / Мне должны», поле показывает величину
  // (иначе на iOS цифровая клавиатура без минуса — дебиторку не ввести).
  const owedDefault = isOneOff && amountDefault !== '' && amountDefault < 0;
  const amountField = amountDefault === '' ? '' : Math.abs(amountDefault);
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
      ${moneyInput('amount', amountField, 'placeholder="5 000" required')}
    </label>
    ${isOneOff ? `
    <div class="chips" id="sign-toggle">
      <button type="button" class="chip pick ${owedDefault ? '' : 'sel'}" data-sign="expense">Трата</button>
      <button type="button" class="chip pick ${owedDefault ? 'sel' : ''}" data-sign="owed">${icon('owed')} Мне должны</button>
    </div>
    <p class="hint" id="owe-hint" ${owedDefault ? '' : 'hidden'}>«Мне должны» — деньги, которые <b>вернутся</b>: уменьшат нагрузку периода.</p>` : ''}
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

  // тумблер знака «Трата / Мне должны» (только у разового платежа). Величину пишем в поле,
  // знак — тут: на iOS цифровая клавиатура без минуса, дебиторку иначе не ввести.
  const signToggle = $('#sign-toggle');
  const oweHint = $('#owe-hint');
  const amtInp = $('#pay-form [name=amount]');
  if (signToggle) {
    const setSign = (sign) => {
      signToggle.querySelectorAll('.pick').forEach(b => b.classList.toggle('sel', b.dataset.sign === sign));
      if (oweHint) oweHint.hidden = sign !== 'owed';
    };
    signToggle.addEventListener('click', (e) => {
      const b = e.target.closest('.pick');
      if (b) setSign(b.dataset.sign);
    });
    // десктоп: печать минуса переводит в «Мне должны» и убирает минус из поля (поле = величина)
    amtInp?.addEventListener('input', () => {
      if (/[-−]/.test(amtInp.value)) {
        amtInp.value = amtInp.value.replace(/[-−]/g, '');
        setSign('owed');
      }
    });
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
    // у разового знак берём из тумблера (поле = величина); у остальных — как есть (только плюс)
    let amount = parseMoney(f.get('amount'));
    if (isOneOff) {
      amount = Math.abs(amount);
      if ($('#sign-toggle .pick.sel')?.dataset.sign === 'owed') amount = -amount;
    }
    const bank = selectedBank();
    if (!name) return; // поле name с required — пустым сюда не дойдёт
    // разовый платёж может быть отрицательным (это «мне должны» — уменьшает нагрузку);
    // регулярные/рассрочки — строго больше нуля
    if (!Number.isFinite(amount) || amount === 0 || (!isOneOff && amount < 0)) {
      const inp = e.target.querySelector('[name=amount]');
      inp?.setCustomValidity(isOneOff ? 'Введите сумму (для долга вам — переключатель «Мне должны»)' : 'Введите сумму больше нуля');
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
    const domRows = document.querySelectorAll('#income-rows .income-row');
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

