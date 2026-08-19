// Вкладка «История»: лента изменений из state.history (пункт 4 роадмапа).
// Читает лог и ничего в него не пишет — источник событий это logChange() в формах.
//
// Лента идёт СВЕРХУ ВНИЗ от свежего к старому и группируется по дням: вопрос
// «когда я поставил галку» почти всегда про недавнее, листать снизу незачем.

import { S } from '../store.js';
import { $, $$, esc } from '../dom.js';
import { HISTORY_LIMIT } from '../store.js';
import { fmtMoney } from '../engine.js';
import { fmtPeriodFull, todayISO, TODAY } from '../format.js';
import { icon } from '../icons.js';

// Событие → как его назвать в ленте и чем пометить. Ключ = `${e}/${act}`, потому
// что «удалён платёж» и «удалена рассрочка» читаются по-разному.
const ACTS = {
  'record/paid':        { verb: 'Оплачен',            ic: 'status',       tone: 'green' },
  'record/unpaid':      { verb: 'Снята оплата',       ic: 'once',         tone: 'yellow' },
  'record/create':      { verb: 'Добавлен',           ic: 'plus',         tone: 'muted' },
  'record/edit':        { verb: 'Изменён',            ic: 'pencil',       tone: 'accent' },
  'record/delete':      { verb: 'Удалён',             ic: 'x',            tone: 'red' },
  'regular/create':     { verb: 'Новый регулярный',   ic: 'plus',         tone: 'muted' },
  'regular/edit':       { verb: 'Изменён регулярный', ic: 'pencil',       tone: 'accent' },
  'regular/delete':     { verb: 'Удалён регулярный',  ic: 'x',            tone: 'red' },
  'regular/on':         { verb: 'Включён регулярный', ic: 'reg',          tone: 'green' },
  'regular/off':        { verb: 'Выключен регулярный',ic: 'reg',          tone: 'yellow' },
  'installment/create': { verb: 'Новая рассрочка',    ic: 'plus',         tone: 'muted' },
  'installment/edit':   { verb: 'Изменена рассрочка', ic: 'pencil',       tone: 'accent' },
  'installment/delete': { verb: 'Удалена рассрочка',  ic: 'x',            tone: 'red' },
  'settings/edit':      { verb: 'Изменена',           ic: 'pencil',       tone: 'accent' },
};

// Фильтры: по намерению человека, а не по типу сущности. «Оплата» — это и галка,
// и её снятие; «создано и удалено» — появление и исчезновение чего угодно.
const FILTERS = [
  { key: 'all',  name: 'всё' },
  { key: 'pay',  name: 'оплата',            acts: ['paid', 'unpaid'] },
  { key: 'edit', name: 'правки',            acts: ['edit', 'on', 'off'] },
  { key: 'life', name: 'создано и удалено', acts: ['create', 'delete'] },
];

const getFilter = () => localStorage.getItem('historyFilter') || 'all';

// Поле → как назвать его в строке «было → стало». Незнакомые поля не печатаем:
// лучше молчание, чем «endPeriod: null → 2026-12-31» в пользовательской ленте.
const FIELD = {
  amount:   { name: 'сумма',   fmt: v => v == null ? '—' : fmtMoney(v) },
  total:    { name: 'сумма',   fmt: v => v == null ? '—' : fmtMoney(v) },
  name:     { name: 'название',fmt: v => v || '—' },
  bank:     { name: 'банк',    fmt: v => v || 'без банка' },
  period:   { name: 'дата',    fmt: v => v ? fmtPeriodFull(v) : '—' },
  count:    { name: 'платежей',fmt: v => v == null ? '—' : String(v) },
  schedule: { name: 'когда',   fmt: v => ({ both: 'каждый период', mid: '15-е число', end: 'конец месяца' })[v] || '—' },
};

// «сумма 42 000 ₽ → 43 500 ₽», по строке на изменённое поле.
function diffHTML(it) {
  if (!it.was && !it.now) return '';
  const keys = [...new Set([...Object.keys(it.was || {}), ...Object.keys(it.now || {})])].filter(k => FIELD[k]);
  if (!keys.length) return '';
  const parts = keys.map(k => {
    const f = FIELD[k];
    const to = esc(f.fmt(it.now?.[k]));
    // У создания «было» нет — печатаем только итог, иначе строка врёт про «→».
    // Пустое значение при этом молчит: «банк без банка» у нового платежа — шум.
    if (!it.was || !(k in it.was)) {
      const v = it.now?.[k];
      return (v == null || v === '') ? '' : `<span class="hi-f">${f.name} ${to}</span>`;
    }
    return `<span class="hi-f">${f.name} <span class="hi-was">${esc(f.fmt(it.was[k]))}</span> → ${to}</span>`;
  }).filter(Boolean);
  return parts.length ? `<div class="hi-diff">${parts.join('')}</div>` : '';
}

// Заголовок дня: «Сегодня» / «Вчера» / «14 августа 2026». Считаем от НАСТОЯЩЕГО
// сегодня (TODAY), как и везде в приложении, а не от просматриваемого месяца.
function dayLabel(iso) {
  const today = todayISO();
  if (iso === today) return 'Сегодня';
  const y = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - 1);
  const yIso = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  if (iso === yIso) return 'Вчера';
  return fmtPeriodFull(iso);
}

const localDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);

export function renderHistory() {
  const filter = getFilter();
  const acts = FILTERS.find(f => f.key === filter)?.acts;
  const all = S.state.history || [];
  const items = (acts ? all.filter(it => acts.includes(it.act)) : all).slice().reverse();

  // Группировка по дню устройства, а не по UTC: событие в 02:00 должно попасть
  // в свою ночь, а не во вчерашнюю.
  const days = [];
  for (const it of items) {
    const day = localDay(it.t);
    if (!days.length || days[days.length - 1].day !== day) days.push({ day, rows: [] });
    days[days.length - 1].rows.push(it);
  }

  const rowHTML = (it) => {
    const a = ACTS[`${it.e}/${it.act}`] || { verb: it.act, ic: 'once', tone: 'muted' };
    return `
      <div class="hi-row">
        <span class="hi-t">${hhmm(it.t)}</span>
        <span class="hi-ic tone-${a.tone}">${icon(a.ic)}</span>
        <span class="hi-txt">
          <span class="hi-main">${a.verb} «${esc(it.name || '—')}»</span>
          ${it.period ? `<span class="hi-sub">${fmtPeriodFull(it.period)}</span>` : ''}
          ${diffHTML(it)}
        </span>
      </div>`;
  };

  const empty = all.length
    ? 'Событий такого типа пока нет.'
    : 'Пока пусто. Здесь появится всё, что вы меняли: отметки об оплате, правки сумм, новые платежи.';

  $('#view-history').innerHTML = `
    <div class="section-head"><h2>История</h2></div>
    <section class="card">
      <div class="chips hi-filters">
        ${FILTERS.map(f => `<button type="button" class="chip pick ${f.key === filter ? 'sel' : ''}" data-hf="${f.key}">${f.name}</button>`).join('')}
      </div>
      ${days.length
        ? days.map(g => `<div class="hi-day">${dayLabel(g.day)}</div>${g.rows.map(rowHTML).join('')}`).join('')
        : `<div class="empty small">${empty}</div>`}
      ${all.length >= HISTORY_LIMIT
        ? `<p class="hint">Лог хранит последние ${HISTORY_LIMIT} событий — более старые подрезаны. Полная картина остаётся в суточном бэкапе.</p>`
        : ''}
    </section>`;

  $$('#view-history [data-hf]').forEach(el => {
    el.addEventListener('click', () => {
      localStorage.setItem('historyFilter', el.dataset.hf);
      renderHistory();     // без render(): меняется только эта вкладка
    });
  });
}
