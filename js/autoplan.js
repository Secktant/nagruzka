// Подбор расписания рассрочки под свободное место в периодах («↻ авто» в форме Долгов).
//
// Чистый модуль: ни DOM, ни S — вход и выход обычные объекты. Это осознанно:
// вьюхи тестами не покрыты, а логика с порогами, остатками и округлением без
// тестов сгниёт на первой правке. Здесь она под node --test целиком.
//
// Задача: разложить долг РАВНЫМИ платежами (последний добирает остаток от
// деления) так, чтобы нагрузка периода осталась в зоне. Границы берём те же,
// что у loadZone(): до 50% «спокойно», до 75% «ощутимо». Поэтому и отчёт в UI
// говорит словами зон, а не голыми процентами — один словарь с карточками.
//
// Один платёж на период: план ключуется датой, две суммы в одну дату не кладём.
// Значит проверка вместимости у периодов независимая, и подбор идёт в два шага:
//   1) минимальное N, при котором N периодов держат платёж ceil(total/N) — оно
//      задаёт ДАТУ ЗАКРЫТИЯ (долг лучше гасить раньше);
//   2) уплотнение: та же дата закрытия, но платежи раскладываются по всем
//      подходящим датам внутри срока, а не только по самым свободным.
// Второй шаг и есть ответ на «почему вся сумма упала в один свободный период».

// Потолок подбора — 65%, а не 75%: «ощутимо» начинается с 50%, и жить у самой
// границы красной зоны некомфортно. Всё, что выше, авто не предлагает само —
// только по подтверждению.
export const LEVELS = [0.5, 0.65];

// Мельче не дробим: иначе долг в 4 000 ₽ размажется на 36 платежей по 111 ₽.
// Долг меньше минимума не запрещаем — он просто станет одним платежом.
export const MIN_PAYMENT = 1000;

// Насколько должен упасть пик, чтобы дробление окупало лишние строки в плане.
export const SPREAD_GAIN = 0.05;

const payment = (total, n) => Math.ceil(total / n);

// Самые ранние N периодов, которые держат платёж a под уровнем level.
// «Самые ранние» = закрыть долг быстрее; загруженные даты выпадают сами —
// отсюда и поведение «если все 15-е заняты, платежи встанут на 30-е».
function pickEarliest(usable, a, level, n) {
  const out = [];
  for (const p of usable) {
    if (p.expense + a <= p.income * level) out.push(p);
    if (out.length === n) return out;
  }
  return null;
}

// N периодов с наименьшей ИТОГОВОЙ нагрузкой — для случая, когда ни один
// уровень не выдержал и остаётся минимизировать пик.
function pickLeastLoaded(usable, a, n) {
  return [...usable]
    .sort((x, y) => (x.expense + a) / x.income - (y.expense + a) / y.income)
    .slice(0, n)
    .sort((x, y) => (x.period < y.period ? -1 : 1));
}

function build(picked, total, n) {
  const a = payment(total, n);
  const plan = picked.map((p, i) => ({
    period: p.period,
    amount: i === n - 1 ? total - a * (n - 1) : a,
  }));
  const loads = picked.map((p, i) => (p.expense + plan[i].amount) / p.income);
  return { plan, payment: a, count: n, peak: Math.max(...loads), loads };
}

// Минимальный план берёт самые ранние подходящие даты и потому ПЕРЕПРЫГИВАЕТ
// занятые: два платежа встают на 1-й и 4-й период, а 2-й и 3-й пропущены — срок
// уже отдан, а нагрузка собрана в две даты. Здесь план уплотняется: занимаем и
// пропущенные даты (платежи мельче — они наконец влезают), дата закрытия при
// этом НЕ съезжает, потому что окно ограничено последней датой минимального
// плана. Самая дробная раскладка даёт самый низкий пик, поэтому идём от неё
// вниз; принимаем только если пик падает на SPREAD_GAIN — иначе лишние строки
// в расписании ни за что.
function spread(usable, base, total, level, minPayment) {
  const last = base.plan[base.plan.length - 1].period;
  const window = usable.filter(p => p.period <= last);
  for (let n = window.length; n > base.count; n--) {
    const a = payment(total, n);
    if (a < minPayment || a * (n - 1) >= total) continue;
    const picked = pickEarliest(window, a, level, n);
    if (!picked) continue;
    const r = build(picked, total, n);
    return r.peak <= base.peak - SPREAD_GAIN ? r : base;
  }
  return base;
}

/**
 * @param {object} o
 * @param {Array<{period:string,income:number,expense:number}>} o.periods
 *   окно, УЖЕ отфильтрованное вызывающим (даты от первого платежа до окончания,
 *   без занятых оплаченными платежами этой же рассрочки), по возрастанию даты.
 *   income/expense — базовые, БЕЗ текущей рассрочки, иначе она конкурирует сама с собой.
 * @param {number} o.total общая сумма долга
 * @returns {{ok:boolean, reason?:string, plan:Array<{period:string,amount:number}>,
 *            level:number|null, payment:number, count:number, peak:number,
 *            over:Array<{period:string,load:number}>}}
 *   level — уровень, в который уложились (0.5 / 0.75), либо null, если не уложились
 *   ни в один: тогда plan всё равно построен (с минимально возможным пиком), но
 *   применять его вызывающий обязан только по подтверждению.
 */
export function autoDistribute({ periods, total, minPayment = MIN_PAYMENT }) {
  const empty = { plan: [], level: null, payment: 0, count: 0, peak: 0, over: [] };
  if (!(total > 0)) return { ok: false, reason: 'no-total', ...empty };
  // Нулевой доход в периоде — не «нагрузка 0%», а неопределённость: процент от
  // нуля не считается. Такие даты просто не рассматриваем.
  const usable = (periods || []).filter(p => p.income > 0);
  if (!usable.length) return { ok: false, reason: 'no-periods', ...empty };

  const nMax = Math.max(1, Math.min(usable.length, Math.floor(total / minPayment)));
  // Пропускаем N, при котором на последний платёж не остаётся денег
  // (ceil-округление съедает остаток). При MIN_PAYMENT=1000 недостижимо,
  // но алгоритм не должен зависеть от значения константы.
  const valid = (n) => payment(total, n) * (n - 1) < total;

  for (const level of LEVELS) {
    for (let n = 1; n <= nMax; n++) {
      if (!valid(n)) continue;
      const picked = pickEarliest(usable, payment(total, n), level, n);
      if (picked) {
        const base = build(picked, total, n);
        return { ok: true, level, over: [], ...spread(usable, base, total, level, minPayment) };
      }
    }
  }

  // Ни один уровень не выдержал. Раскладываем с минимально возможным пиком:
  // больше платежей → меньше сумма → ниже нагрузка, но приходится брать всё
  // менее удобные даты, поэтому перебираем N честно, а не берём максимальное.
  let best = null;
  for (let n = 1; n <= nMax; n++) {
    if (!valid(n)) continue;
    const r = build(pickLeastLoaded(usable, payment(total, n), n), total, n);
    if (!best || r.peak < best.peak - 1e-9) best = r;
  }
  const over = best.plan
    .map((it, i) => ({ period: it.period, load: best.loads[i] }))
    .filter(x => x.load > LEVELS[LEVELS.length - 1]);
  return { ok: true, level: null, over, ...best };
}
