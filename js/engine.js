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
// Попадает ли регулярный в период по расписанию (записи периода не учитываются).
// Одно правило на двоих: buildTimeline и freezeRegular обязаны видеть одно и то же.
function regularFits(reg, p) {
  if (!reg.active) return false;
  if (reg.since && p < reg.since) return false; // новый регулярный — только с этой даты вперёд
  return reg.schedule === 'both' ||
    (reg.schedule === 'mid' && isMidPeriod(p)) ||
    (reg.schedule === 'end' && !isMidPeriod(p));
}

// Заморозка прошлого регулярного — звать ПЕРЕД его правкой, выключением или удалением.
// Прошлые вхождения, которые ещё виртуальные (не отмечены, не правлены, не скрыты),
// движок считает по ТЕКУЩЕЙ сумме регулярного — и правка переписала бы историю задним
// числом. Здесь они превращаются в записи с ещё старыми значениями. Прошлое = периоды
// строго раньше today; today и дальше получают новые значения.
// Доход: зарплата в периоде виртуальна, только если там нет НИ ОДНОЙ записи дохода
// (то же правило, что hasIncomeRecord в buildTimeline).
//
// since — с какого периода регулярный начисляется после правки. Без сдвига прошлое
// всё равно поменялось бы: смена расписания (15-е → каждый период) или повторное
// включение дорисовали бы платежи в прошлые даты, где записей нет.
//
// Сумма 0 = «не настроено» (зарплата на свежей установке): замораживать нечего, и
// первый ввод суммы, как и раньше, заполняет прошлое. since = null — не сдвигать.
export function freezeRegular(state, reg, today) {
  if (!reg.amount) return { records: [], since: null };
  const records = [];
  for (const p of generatePeriods(state.settings.startPeriod, today)) {
    if (p >= today || !regularFits(reg, p)) continue;
    const recs = state.records.filter(r => r.period === p);
    if (recs.some(r => r.regularId === reg.id)) continue;
    if (reg.kind === 'income' && recs.some(r => r.kind === 'income')) continue;
    records.push({
      id: `frz-${reg.id}-${p}`, period: p, kind: reg.kind, name: reg.name,
      amount: reg.amount, bank: reg.bank ?? null, paid: false, regularId: reg.id,
    });
  }
  const [y, m] = today.split('-').map(Number);
  const mid = iso(y, m, 15);
  return { records, since: today <= mid ? mid : iso(y, m, eom(y, m)) };
}

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
      planVirt: 0, // сколько уже выгенерено виртуалок из плана (для капа по остатку)
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
      if (!regularFits(reg, p)) continue;
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
        // Слотов на одну дату может быть НЕСКОЛЬКО (перенесли платёж на занятую
        // дату) — складываем их в один платёж, а не берём первый попавшийся.
        const planned = inst.plan.reduce((s, it) => it.period === p ? s + it.amount : s, 0);
        if (!planned) continue;
        // не проектируем платежи дальше реального остатка: если долг уже покрыт
        // записями (досрочно закрыли) — будущие слоты плана не «фоним».
        const room = inst.total - st.scheduled - st.planVirt;
        if (room <= 0) continue;
        const amount = Math.min(planned, room);
        st.planVirt += amount;
        payments.push({
          id: `virt-${inst.id}-${p}`, name: inst.name, amount,
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

    // Внести в банк: сумма НЕоплаченных платежей периода по банку.
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

// Обязательства ВНЕ показанного месяца: что просрочено слева и что осталось справа.
// from/to — первый и последний период месяца (даты, а не ym: разбирать строки не надо).
//
// Считаем ТОЛЬКО разовые платежи и рассрочки. Регулярные — не долг, а настройка
// из вкладки «Деньги»: они будут всегда, и их сумма «впереди» бесконечна.
// «Мне должны» (amount < 0) тоже мимо — это приход, а не обязательство.
//
// Границы подобраны так, чтобы три числа НЕ пересекались и складывались в весь
// долг: просрочено (< from) + месяц (from..to) + впереди (> to). Для рассрочки
// «впереди» = остаток долга МИНУС всё её неоплаченное до конца месяца — тогда
// недорасписанная рассрочка (расписанием закрыто меньше долга) не занижает итог.
// Просрочка меряется от СЕГОДНЯ, а не от просматриваемого месяца: открыв сентябрь,
// нельзя объявлять просроченными августовские платежи, до которых ещё неделя.
// Граница — раньше сегодня И раньше месяца сразу (min): вторая половина условия
// не даёт задвоения, когда смотришь ПРОШЛЫЙ месяц — иначе его же платежи попали бы
// и в «просрочено», и в «внести за месяц» на одном экране.
export function outstanding(state, timeline, from, to, today) {
  const cutoff = today && today < from ? today : from;
  const add = (acc, bank, amount) => {
    acc.count++; acc.sum += amount;
    const key = bank || '';
    acc.perBank[key] = (acc.perBank[key] || 0) + amount;
  };
  const blank = () => ({ count: 0, sum: 0, perBank: {} });
  const overdue = blank();
  const once = blank();
  const inst = blank();
  // сколько у каждой рассрочки висит неоплаченным до конца месяца включительно
  const instBefore = new Map();

  for (const day of timeline.values()) {
    for (const p of day.payments) {
      if (p.paid || p.regularId || p.amount <= 0) continue;
      if (day.period < cutoff) {
        add(overdue, p.bank, p.amount);
        if (p.installmentId) instBefore.set(p.installmentId, (instBefore.get(p.installmentId) || 0) + p.amount);
      } else if (day.period <= to) {
        if (p.installmentId) instBefore.set(p.installmentId, (instBefore.get(p.installmentId) || 0) + p.amount);
      } else if (!p.installmentId) {
        add(once, p.bank, p.amount);   // рассрочки берём остатком долга ниже, а не платежами
      }
    }
  }

  for (const s of installmentSummaries(state, timeline)) {
    if (s.closed) continue;
    const ahead = Math.max(0, Math.round(s.remaining - (instBefore.get(s.inst.id) || 0)));
    if (ahead > 0) add(inst, s.inst.bank, ahead);
  }

  const perBank = {};
  for (const src of [once.perBank, inst.perBank]) {
    for (const [bank, v] of Object.entries(src)) perBank[bank] = (perBank[bank] || 0) + v;
  }
  return {
    overdue,
    ahead: { once, inst, sum: once.sum + inst.sum, perBank },
  };
}

// Разовые платежи для «Долгов»: годы → месяцы → строки, от ранних к поздним.
// Разовый = не регулярный, не рассрочка и сумма > 0 — то же правило, что в
// outstanding(): «мне должны» (отрицательные) сюда не входят вовсе.
// Итоги на каждом уровне: left — не оплачено, paid — оплачено, unpaid — сколько
// неоплаченных. overdue — не оплачен и дата периода уже прошла.
export function oneOffSummary(timeline, today) {
  const blank = () => ({ left: 0, paid: 0, unpaid: 0 });
  const add = (t, p) => { if (p.paid) t.paid += p.amount; else { t.left += p.amount; t.unpaid++; } };
  const total = blank();
  const years = [];
  for (const day of timeline.values()) {          // лента уже по возрастанию дат
    for (const p of day.payments) {
      if (p.regularId || p.installmentId || !(p.amount > 0)) continue;
      const year = day.period.slice(0, 4), month = day.period.slice(0, 7);
      let y = years[years.length - 1];
      if (!y || y.year !== year) years.push(y = { year, ...blank(), months: [] });
      let m = y.months[y.months.length - 1];
      if (!m || m.month !== month) y.months.push(m = { month, ...blank(), rows: [] });
      m.rows.push({ ...p, period: day.period, overdue: !p.paid && day.period < today });
      add(total, p); add(y, p); add(m, p);
    }
  }
  return { ...total, years };
}

// Сводка по рассрочкам из готовой ленты: внесено, осталось, дата закрытия.
export function installmentSummaries(state, timeline) {
  const out = [];
  for (const inst of state.installments) {
    const linked = state.records.filter(r => r.installmentId === inst.id);
    const paidSum = linked.filter(r => r.paid).reduce((s, r) => s + r.amount, 0);
    const paidCount = linked.filter(r => r.paid).length;
    let totalCount = 0, lastPeriod = null, nextPayment = null, scheduledSum = 0;
    for (const day of timeline.values()) {
      for (const p of day.payments) {
        if (p.installmentId !== inst.id) continue;
        totalCount++;
        scheduledSum += p.amount;        // сколько всего расписано платежами
        lastPeriod = day.period;
        if (!p.paid && !nextPayment) nextPayment = { period: day.period, amount: p.amount };
      }
    }
    // оплаченные записи до начала ленты тоже считаются
    for (const r of linked) {
      if (r.period < state.settings.startPeriod) { totalCount++; scheduledSum += r.amount; }
    }
    const remaining = Math.max(0, inst.total - paidSum);
    // недопокрытие: расписанием закрыто меньше, чем общая сумма долга
    const shortfall = Math.max(0, Math.round(inst.total - scheduledSum));
    out.push({
      inst, paidSum, paidCount, totalCount, remaining, scheduledSum,
      shortfall, underScheduled: shortfall > 0,
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

// Доля регулярных платежей в месячном доходе. Месяц = ДВА периода, поэтому
// «каждый период» стоит вдвое дороже суммы в строке — без этого проценты не
// сойдутся с итогом. Проценты округляются до десятой у каждой строки, а итог —
// СУММА уже округлённых: так столбец на экране всегда складывается в итог.
// Выключенные платежи и нулевые суммы дают pct: null и в итог не идут.
export function regularShares(regulars, salaryPerPeriod) {
  const income = salaryPerPeriod > 0 ? salaryPerPeriod * 2 : 0;
  const rows = new Map();
  let sum = 0, pct = 0;
  for (const r of regulars) {
    if (r.kind !== 'expense') continue;
    const monthly = r.amount * (r.schedule === 'both' ? 2 : 1);
    if (!r.active || !(monthly > 0)) { rows.set(r.id, { monthly, pct: null }); continue; }
    const p = income ? Math.round(monthly / income * 1000) / 10 : null;
    rows.set(r.id, { monthly, pct: p });
    sum += monthly;
    if (p != null) pct += p;
  }
  return { income, rows, sum, pct: income ? Math.round(pct * 10) / 10 : null };
}

const MONTHS_GEN = ['января','февраля','марта','апреля','мая','июня',
  'июля','августа','сентября','октября','ноября','декабря'];
const MONTHS_NOM = ['Январь','Февраль','Март','Апрель','Май','Июнь',
  'Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];

export function fmtPeriod(p) {
  const [y, m, d] = p.split('-').map(Number);
  return `${d} ${MONTHS_GEN[m - 1]}`;
}
// Месяц в родительном падеже: «после августа», «после мая». Склеивать окончание
// к именительному нельзя — выйдет «майа»/«июнья».
export const monthGen = (m) => MONTHS_GEN[m - 1];
export const monthNom = (m) => MONTHS_NOM[m - 1];
export function fmtMonth(y, m) {
  return `${MONTHS_NOM[m - 1]} ${y}`;
}
