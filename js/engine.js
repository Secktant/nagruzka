// Движок периодов и расчётов. Периоды не хранятся — генерируются:
// 15-е число и последний день каждого месяца.

export function eom(year, month) { // month: 1..12
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Все периоды от startISO до endISO включительно, по возрастанию.
export function generatePeriods(startISO, endISO) {
  const out = [];
  let [y, m] = startISO.split('-').map(Number);
  const end = endISO;
  while (true) {
    const mid = iso(y, m, 15);
    const last = iso(y, m, eom(y, m));
    if (mid > end) break;
    if (mid >= startISO) out.push(mid);
    if (last >= startISO && last <= end) out.push(last);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

export function isMidPeriod(periodISO) {
  return periodISO.endsWith('-15');
}

export function loadZone(load) {
  if (load == null) return null;
  if (load > 1) return { key: 'over', label: 'перегруз' };
  if (load > 0.75) return { key: 'red', label: 'впритык' };
  if (load > 0.5) return { key: 'yellow', label: 'ощутимо' };
  return { key: 'green', label: 'спокойно' };
}

// Строит полную ленту периодов с платежами и расчётами.
// state: { settings, regulars, installments, records }
// Возвращает Map periodISO -> {
//   income, payments[], totalExpense, load, zone, leftover, carry, perBank
// }
// payment: { id, name, amount, bank, paid, virtual, regularId?, installmentId?, instProgress? }
export function buildTimeline(state, endISO) {
  const { settings, regulars, installments, records } = state;
  const periods = generatePeriods(settings.startPeriod, endISO);

  const recsByPeriod = new Map();
  for (const r of records) {
    if (!recsByPeriod.has(r.period)) recsByPeriod.set(r.period, []);
    recsByPeriod.get(r.period).push(r);
  }

  // Состояние рассрочек: сколько уже расписано (записями), чтобы догенерировать хвост.
  const instState = new Map();
  for (const inst of installments) {
    const linked = records.filter(r => r.installmentId === inst.id);
    instState.set(inst.id, {
      inst,
      scheduled: linked.reduce((s, r) => s + r.amount, 0),
      paidAmount: linked.filter(r => r.paid).reduce((s, r) => s + r.amount, 0),
      lastLinkedPeriod: linked.reduce((max, r) => r.period > max ? r.period : max, ''),
      paidCount: linked.filter(r => r.paid).length,
      linkedCount: linked.length,
    });
  }

  const timeline = new Map();
  let carry = 0;

  for (const p of periods) {
    const recs = recsByPeriod.get(p) || [];
    const payments = [];
    let income = 0;
    let hasIncomeRecord = false;

    for (const r of recs) {
      if (r.skipped) continue; // скрыт, но блокирует виртуальный регулярный
      if (r.kind === 'income') { income += r.amount; hasIncomeRecord = true; }
      // нулевой платёж не показываем: для рассрочки это «пропустить период»
      else if (r.amount !== 0) payments.push({ ...r, virtual: false });
    }

    // Регулярные: виртуальный платёж, если в периоде нет записи с этим regularId.
    for (const reg of regulars) {
      if (!reg.active) continue;
      if (reg.since && p < reg.since) continue; // новый регулярный — только с этой даты вперёд
      const fits = reg.schedule === 'both' ||
        (reg.schedule === 'mid' && isMidPeriod(p)) ||
        (reg.schedule === 'end' && !isMidPeriod(p));
      if (!fits) continue;
      const exists = recs.some(r => r.regularId === reg.id);
      if (exists) continue;
      if (reg.kind === 'income') {
        if (!hasIncomeRecord) income += reg.amount;
      } else {
        payments.push({
          id: `virt-${reg.id}-${p}`, name: reg.name, amount: reg.amount,
          bank: reg.bank, paid: false, virtual: true, regularId: reg.id,
        });
      }
    }

    // Рассрочки: либо явное расписание (plan), либо авто-хвост.
    for (const st of instState.values()) {
      const inst = st.inst;
      const hasRec = recs.some(r => r.installmentId === inst.id);
      if (inst.plan) {
        if (hasRec) continue; // запись этого периода уже отрисована (или обнулена)
        const item = inst.plan.find(it => it.period === p);
        if (!item || !item.amount) continue;
        payments.push({
          id: `virt-${inst.id}-${p}`, name: inst.name, amount: item.amount,
          bank: inst.bank, paid: false, virtual: true, installmentId: inst.id,
        });
        continue;
      }
      // авто-распределение: догенерировать хвост после последней привязанной записи
      const remaining = inst.total - st.scheduled;
      if (remaining <= 0) continue;
      if (p <= st.lastLinkedPeriod || p < inst.firstPeriod) continue;
      const amount = Math.min(inst.perPeriod, remaining);
      st.scheduled += amount;
      payments.push({
        id: `virt-${inst.id}-${p}`, name: inst.name, amount,
        bank: inst.bank, paid: false, virtual: true, installmentId: inst.id,
      });
    }

    const totalExpense = payments.reduce((s, x) => s + x.amount, 0);
    const load = income > 0 ? totalExpense / income : null;
    const leftover = income - totalExpense;
    carry += leftover;

    // Занести в банк: сумма НЕоплаченных платежей периода по банку.
    const perBank = {};
    const bankTouched = {};
    for (const x of payments) {
      if (!x.bank) continue;
      bankTouched[x.bank] = true;
      if (!x.paid) perBank[x.bank] = (perBank[x.bank] || 0) + x.amount;
    }

    timeline.set(p, {
      period: p, income, payments, totalExpense, load,
      zone: loadZone(load), leftover, carry, perBank, bankTouched,
    });
  }

  // Прогресс рассрочек «4/7»: считаем платёжные строки прямо из ленты.
  const instTotals = new Map();
  for (const inst of installments) {
    let total = 0, paid = 0;
    for (const day of timeline.values()) {
      for (const x of day.payments) {
        if (x.installmentId !== inst.id) continue;
        total++; if (x.paid) paid++;
      }
    }
    // оплаченные записи раньше начала ленты
    for (const r of records) {
      if (r.installmentId === inst.id && r.period < settings.startPeriod) {
        total++; if (r.paid) paid++;
      }
    }
    instTotals.set(inst.id, { totalCount: total, paidCount: paid });
  }
  for (const day of timeline.values()) {
    for (const x of day.payments) {
      if (!x.installmentId) continue;
      const t = instTotals.get(x.installmentId);
      if (t) x.instProgress = t;
    }
  }

  return timeline;
}

// Сводка по рассрочкам из готовой ленты: внесено, осталось, дата закрытия.
export function installmentSummaries(state, timeline) {
  const out = [];
  for (const inst of state.installments) {
    const linked = state.records.filter(r => r.installmentId === inst.id);
    const paidSum = linked.filter(r => r.paid).reduce((s, r) => s + r.amount, 0);
    const paidCount = linked.filter(r => r.paid).length;
    let totalCount = 0, lastPeriod = null, nextPayment = null;
    for (const day of timeline.values()) {
      for (const p of day.payments) {
        if (p.installmentId !== inst.id) continue;
        totalCount++;
        lastPeriod = day.period;
        if (!p.paid && !nextPayment) nextPayment = { period: day.period, amount: p.amount };
      }
    }
    // оплаченные записи до начала ленты тоже считаются
    totalCount += linked.filter(r => r.period < state.settings.startPeriod).length;
    const remaining = Math.max(0, inst.total - paidSum);
    out.push({
      inst, paidSum, paidCount, totalCount, remaining,
      closed: remaining <= 0,
      closePeriod: lastPeriod,
      nextPayment,
    });
  }
  return out;
}

const THIN = ' '; // узкий неразрывный пробел
// Группировка тысяч пробелами — начиная с 10 000 (меньше — без пробелов).
export function groupThousands(n) {
  const neg = n < 0;
  let s = String(Math.abs(Math.round(n)));
  if (Math.abs(n) >= 10000) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
  return (neg ? '−' : '') + s;
}
export const fmtMoney = (n) => groupThousands(n) + THIN + '₽';

// Нагрузка по месяцам: [{ ym:'2026-06', y, m, income, expense, load, zone }]
export function monthlyLoads(timeline) {
  const byMonth = new Map();
  for (const d of timeline.values()) {
    const ym = d.period.slice(0, 7);
    if (!byMonth.has(ym)) byMonth.set(ym, { ym, income: 0, expense: 0 });
    const e = byMonth.get(ym);
    e.income += d.income;
    e.expense += d.totalExpense;
  }
  return [...byMonth.values()].map(e => {
    const load = e.income > 0 ? e.expense / e.income : null;
    const [y, m] = e.ym.split('-').map(Number);
    return { ...e, y, m, load, zone: loadZone(load) };
  });
}

// Нагрузка по годам: [{ year, income, expense, load, zone }]
export function yearlyLoads(timeline) {
  const byYear = new Map();
  for (const d of timeline.values()) {
    const y = Number(d.period.slice(0, 4));
    if (!byYear.has(y)) byYear.set(y, { year: y, income: 0, expense: 0 });
    const e = byYear.get(y);
    e.income += d.income;
    e.expense += d.totalExpense;
  }
  return [...byYear.values()].map(e => {
    const load = e.income > 0 ? e.expense / e.income : null;
    return { ...e, load, zone: loadZone(load) };
  });
}

const MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня',
  'июля','августа','сентября','октября','ноября','декабря'];
const MONTHS_NOM = ['Январь','Февраль','Март','Апрель','Май','Июнь',
  'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

export function fmtPeriod(p) {
  const [y, m, d] = p.split('-').map(Number);
  return `${d} ${MONTHS_GEN[m - 1]}`;
}
export function fmtMonth(y, m) {
  return `${MONTHS_NOM[m - 1]} ${y}`;
}
