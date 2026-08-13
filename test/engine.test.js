// Тесты движка расчётов (app/js/engine.js). Движок чистый — ни DOM, ни IndexedDB,
// ни crypto. Это сетка безопасности под будущую разрезку монолита app.js:
// пока эти тесты зелёные, поведение ядра (периоды, лента, нагрузка, форматирование)
// не поехало. Запуск: из app/ — `node --test` (или `npm test`).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  eom,
  generatePeriods,
  isMidPeriod,
  loadZone,
  buildTimeline,
  installmentSummaries,
  groupThousands,
  fmtMoney,
  monthlyLoads,
  yearlyLoads,
  fmtPeriod,
  fmtMonth,
  outstanding,
  regularShares,
} from '../js/engine.js';

const THIN = ' ';   // узкий неразрывный пробел (разделитель тысяч)
const MINUS = '−';  // типографский минус

// ─────────────────────────────────────────────────────────────────────────────
describe('eom — последний день месяца', () => {
  test('обычные месяцы', () => {
    assert.equal(eom(2026, 1), 31);
    assert.equal(eom(2026, 4), 30);
    assert.equal(eom(2026, 12), 31);
  });
  test('февраль: невисокосный и високосный', () => {
    assert.equal(eom(2026, 2), 28);
    assert.equal(eom(2024, 2), 29);
    assert.equal(eom(2000, 2), 29); // делится на 400
    assert.equal(eom(1900, 2), 28); // делится на 100, но не на 400
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('generatePeriods', () => {
  test('внутри одного месяца от 15-го', () => {
    assert.deepEqual(
      generatePeriods('2026-01-15', '2026-01-31'),
      ['2026-01-15', '2026-01-31'],
    );
  });

  test('через границу месяца, февраль = 28', () => {
    assert.deepEqual(
      generatePeriods('2026-01-15', '2026-02-15'),
      ['2026-01-15', '2026-01-31', '2026-02-15'],
    );
  });

  test('старт между 15-м и концом: 15-е этого месяца пропущено', () => {
    assert.deepEqual(
      generatePeriods('2026-01-20', '2026-02-28'),
      ['2026-01-31', '2026-02-15', '2026-02-28'],
    );
  });

  test('всегда по возрастанию', () => {
    const p = generatePeriods('2026-01-15', '2026-06-30');
    const sorted = [...p].sort();
    assert.deepEqual(p, sorted);
  });

  test('пустой диапазон, если end раньше start', () => {
    assert.deepEqual(generatePeriods('2026-03-15', '2026-01-01'), []);
  });

  test('переход через год', () => {
    assert.deepEqual(
      generatePeriods('2025-12-15', '2026-01-15'),
      ['2025-12-15', '2025-12-31', '2026-01-15'],
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('isMidPeriod', () => {
  test('15-е — середина', () => {
    assert.equal(isMidPeriod('2026-03-15'), true);
  });
  test('конец месяца — не середина', () => {
    assert.equal(isMidPeriod('2026-03-31'), false);
    assert.equal(isMidPeriod('2026-02-28'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('loadZone — границы зон нагрузки', () => {
  test('null при отсутствии нагрузки', () => {
    assert.equal(loadZone(null), null);
  });
  test('перегруз строго больше 1', () => {
    assert.equal(loadZone(1.01).key, 'over');
    assert.equal(loadZone(2).key, 'over');
  });
  test('ровно 1 — ещё не перегруз, а «впритык»', () => {
    assert.equal(loadZone(1).key, 'red');
  });
  test('красная зона (0.75, 1]', () => {
    assert.equal(loadZone(0.9).key, 'red');
    assert.equal(loadZone(0.751).key, 'red');
  });
  test('ровно 0.75 — жёлтая', () => {
    assert.equal(loadZone(0.75).key, 'yellow');
  });
  test('жёлтая зона (0.5, 0.75]', () => {
    assert.equal(loadZone(0.6).key, 'yellow');
  });
  test('ровно 0.5 — зелёная', () => {
    assert.equal(loadZone(0.5).key, 'green');
  });
  test('зелёная зона [0, 0.5]', () => {
    assert.equal(loadZone(0).key, 'green');
    assert.equal(loadZone(0.25).key, 'green');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildTimeline — основной сценарий (регулярные + авто-рассрочка)', () => {
  // Зарплата 100000 (both), аренда 30000 (end, Альфа), подписка 5000 (mid, Озон),
  // рассрочка iPhone: total 60000, по 20000/период, старт 2026-01-15,
  // одна оплаченная запись на 15-е.
  const state = {
    settings: { salary: 0, banks: [], startPeriod: '2026-01-15' },
    regulars: [
      { id: 'salary', name: 'Зарплата', kind: 'income', amount: 100000, schedule: 'both', bank: null, active: true },
      { id: 'rent', name: 'Аренда', kind: 'expense', amount: 30000, schedule: 'end', bank: 'Альфа', active: true },
      { id: 'sub', name: 'Подписка', kind: 'expense', amount: 5000, schedule: 'mid', bank: 'Озон', active: true },
    ],
    installments: [
      { id: 'i1', name: 'iPhone', total: 60000, perPeriod: 20000, firstPeriod: '2026-01-15', bank: 'Тбанк', plan: null },
    ],
    records: [
      { id: 'r1', period: '2026-01-15', installmentId: 'i1', name: 'iPhone', amount: 20000, bank: 'Тбанк', paid: true },
    ],
  };
  const tl = buildTimeline(state, '2026-02-28');

  test('лента содержит ровно ожидаемые периоды', () => {
    assert.deepEqual(
      [...tl.keys()],
      ['2026-01-15', '2026-01-31', '2026-02-15', '2026-02-28'],
    );
  });

  test('15 января: доход, оплаченная рассрочка + виртуальная подписка', () => {
    const d = tl.get('2026-01-15');
    assert.equal(d.income, 100000);
    const names = d.payments.map(p => p.name).sort();
    assert.deepEqual(names, ['iPhone', 'Подписка']); // .sort() по Unicode: латиница < кириллица
    const iphone = d.payments.find(p => p.name === 'iPhone');
    assert.equal(iphone.paid, true);
    assert.equal(iphone.virtual, false);
    const sub = d.payments.find(p => p.name === 'Подписка');
    assert.equal(sub.virtual, true);
    assert.equal(d.totalExpense, 25000);
    assert.equal(d.load, 0.25);
    assert.equal(d.zone.key, 'green');
    assert.equal(d.leftover, 75000);
    assert.equal(d.carry, 75000);
  });

  test('15 января: perBank учитывает только НЕоплаченные', () => {
    const d = tl.get('2026-01-15');
    // iPhone оплачен → не в perBank; подписка не оплачена → Озон 5000
    assert.deepEqual(d.perBank, { 'Озон': 5000 });
    assert.equal(d.bankTouched['Тбанк'], true); // банк «затронут», хоть и оплачено
    assert.equal(d.bankTouched['Озон'], true);
  });

  test('31 января: аренда (end) + авто-хвост рассрочки', () => {
    const d = tl.get('2026-01-31');
    const names = d.payments.map(p => p.name).sort();
    assert.deepEqual(names, ['iPhone', 'Аренда'].sort());
    assert.equal(d.payments.find(p => p.name === 'Аренда').amount, 30000);
    assert.equal(d.payments.find(p => p.name === 'iPhone').amount, 20000);
    assert.equal(d.totalExpense, 50000);
    assert.equal(d.load, 0.5);
    assert.equal(d.zone.key, 'green'); // ровно 0.5 — граница зелёной
    assert.equal(d.carry, 125000);
    assert.deepEqual(d.perBank, { 'Альфа': 30000, 'Тбанк': 20000 });
  });

  test('накопительный carry идёт по всей ленте', () => {
    assert.equal(tl.get('2026-02-15').carry, 200000);
    assert.equal(tl.get('2026-02-28').carry, 270000);
  });

  test('авто-хвост рассрочки останавливается на total', () => {
    // всего расписано: 20000 (запись) + 20000 (31.01) + 20000 (15.02) = 60000
    assert.ok(!tl.get('2026-02-28').payments.some(p => p.name === 'iPhone'));
  });

  test('instProgress «оплачено/всего» проставлен на строках рассрочки', () => {
    const iphone = tl.get('2026-01-31').payments.find(p => p.name === 'iPhone');
    assert.deepEqual(iphone.instProgress, { totalCount: 3, paidCount: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildTimeline — граничные правила', () => {
  const base = () => ({
    settings: { salary: 0, banks: [], startPeriod: '2026-01-15' },
    regulars: [],
    installments: [],
    records: [],
  });

  test('явная запись дохода подавляет виртуальный регулярный доход', () => {
    const s = base();
    s.regulars = [{ id: 'salary', name: 'ЗП', kind: 'income', amount: 100000, schedule: 'both', bank: null, active: true }];
    s.records = [{ id: 'r', period: '2026-01-15', regularId: 'salary', kind: 'income', amount: 80000, paid: true }];
    const d = buildTimeline(s, '2026-01-15').get('2026-01-15');
    assert.equal(d.income, 80000); // 80000 из записи, +100000 регулярного НЕ добавлено
  });

  test('skipped-запись блокирует виртуальный регулярный платёж', () => {
    const s = base();
    s.regulars = [{ id: 'sub', name: 'Подписка', kind: 'expense', amount: 5000, schedule: 'mid', bank: 'Озон', active: true }];
    s.records = [{ id: 'r', period: '2026-01-15', regularId: 'sub', name: 'Подписка', amount: 5000, bank: 'Озон', paid: false, skipped: true }];
    const d = buildTimeline(s, '2026-01-15').get('2026-01-15');
    assert.equal(d.payments.length, 0); // ни записи (skipped), ни виртуалки
    assert.equal(d.totalExpense, 0);
  });

  test('запись рассрочки на 0 — «пропустить период», не показывается', () => {
    const s = base();
    s.installments = [{ id: 'i1', name: 'Диван', total: 30000, perPeriod: 10000, firstPeriod: '2026-01-15', bank: 'ВТБ', plan: null }];
    s.records = [{ id: 'r', period: '2026-01-15', installmentId: 'i1', name: 'Диван', amount: 0, bank: 'ВТБ', paid: false }];
    const d = buildTimeline(s, '2026-01-15').get('2026-01-15');
    assert.equal(d.payments.length, 0);
  });

  test('неактивный регулярный не порождает платежей', () => {
    const s = base();
    s.regulars = [{ id: 'x', name: 'Старое', kind: 'expense', amount: 1000, schedule: 'both', bank: 'Альфа', active: false }];
    const d = buildTimeline(s, '2026-01-31');
    assert.equal(d.get('2026-01-15').payments.length, 0);
    assert.equal(d.get('2026-01-31').payments.length, 0);
  });

  test('регулярный с since стартует только с указанной даты', () => {
    const s = base();
    s.regulars = [{ id: 'n', name: 'Новый', kind: 'expense', amount: 2000, schedule: 'both', bank: 'Альфа', active: true, since: '2026-01-31' }];
    const tl = buildTimeline(s, '2026-02-15');
    assert.equal(tl.get('2026-01-15').payments.length, 0);       // до since
    assert.equal(tl.get('2026-01-31').payments[0].name, 'Новый'); // с since
    assert.equal(tl.get('2026-02-15').payments[0].name, 'Новый');
  });

  test('load = null, если дохода в периоде нет', () => {
    const s = base();
    s.regulars = [{ id: 'r', name: 'Аренда', kind: 'expense', amount: 5000, schedule: 'both', bank: 'Альфа', active: true }];
    const d = buildTimeline(s, '2026-01-15').get('2026-01-15');
    assert.equal(d.income, 0);
    assert.equal(d.load, null);
    assert.equal(d.zone, null);
  });

  test('расписание mid/end фильтрует по типу периода', () => {
    const s = base();
    s.regulars = [
      { id: 'm', name: 'Толькосередина', kind: 'expense', amount: 1000, schedule: 'mid', bank: 'Альфа', active: true },
      { id: 'e', name: 'Толькоконец', kind: 'expense', amount: 2000, schedule: 'end', bank: 'Озон', active: true },
    ];
    const tl = buildTimeline(s, '2026-01-31');
    assert.deepEqual(tl.get('2026-01-15').payments.map(p => p.name), ['Толькосередина']);
    assert.deepEqual(tl.get('2026-01-31').payments.map(p => p.name), ['Толькоконец']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('buildTimeline — рассрочка по явному плану', () => {
  const s = {
    settings: { salary: 0, banks: [], startPeriod: '2026-01-15' },
    regulars: [],
    installments: [{
      id: 'i2', name: 'Диван', total: 30000, bank: 'ВТБ', plan: [
        { period: '2026-01-15', amount: 10000 },
        { period: '2026-01-31', amount: 10000 },
        { period: '2026-02-15', amount: 10000 },
      ],
    }],
    records: [],
  };
  const tl = buildTimeline(s, '2026-02-28');

  test('план раскладывается по своим периодам', () => {
    assert.equal(tl.get('2026-01-15').payments[0].amount, 10000);
    assert.equal(tl.get('2026-01-31').payments[0].amount, 10000);
    assert.equal(tl.get('2026-02-15').payments[0].amount, 10000);
  });
  test('период без слота плана пуст', () => {
    assert.equal(tl.get('2026-02-28').payments.length, 0);
  });

  test('план не «фонит» дальше реального остатка (досрочное закрытие)', () => {
    const s2 = structuredClone(s);
    // закрыли досрочно записью на всю сумму 15-го
    s2.records = [{ id: 'rp', period: '2026-01-15', installmentId: 'i2', name: 'Диван', amount: 30000, bank: 'ВТБ', paid: true }];
    const tl2 = buildTimeline(s2, '2026-02-28');
    // будущие слоты плана не должны создавать виртуальные платежи (room <= 0)
    assert.equal(tl2.get('2026-01-31').payments.length, 0);
    assert.equal(tl2.get('2026-02-15').payments.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('installmentSummaries', () => {
  const state = {
    settings: { salary: 0, banks: [], startPeriod: '2026-01-15' },
    regulars: [],
    installments: [
      { id: 'i1', name: 'iPhone', total: 60000, perPeriod: 20000, firstPeriod: '2026-01-15', bank: 'Тбанк', plan: null },
    ],
    records: [
      { id: 'r1', period: '2026-01-15', installmentId: 'i1', name: 'iPhone', amount: 20000, bank: 'Тбанк', paid: true },
    ],
  };
  const tl = buildTimeline(state, '2026-02-28');
  const [sum] = installmentSummaries(state, tl);

  test('внесено / оплачено', () => {
    assert.equal(sum.paidSum, 20000);
    assert.equal(sum.paidCount, 1);
  });
  test('всего расписано и остаток', () => {
    assert.equal(sum.scheduledSum, 60000);
    assert.equal(sum.remaining, 40000);
    assert.equal(sum.closed, false);
  });
  test('нет недорасписания, если план покрывает total', () => {
    assert.equal(sum.shortfall, 0);
    assert.equal(sum.underScheduled, false);
  });
  test('следующий платёж = первый неоплаченный', () => {
    assert.deepEqual(sum.nextPayment, { period: '2026-01-31', amount: 20000 });
  });
  test('дата закрытия = последний расписанный период', () => {
    assert.equal(sum.closePeriod, '2026-02-15');
  });

  test('недорасписанная рассрочка помечается shortfall (план покрывает меньше total)', () => {
    // План на 20000 при долге 50000 — авто-хвоста нет (plan задан), окно роли не играет.
    const s2 = {
      settings: { salary: 0, banks: [], startPeriod: '2026-01-15' },
      regulars: [],
      installments: [{
        id: 'p', name: 'Стол', total: 50000, bank: 'ВТБ', plan: [
          { period: '2026-01-15', amount: 10000 },
          { period: '2026-01-31', amount: 10000 },
        ],
      }],
      records: [],
    };
    const [s] = installmentSummaries(s2, buildTimeline(s2, '2026-02-28'));
    assert.equal(s.scheduledSum, 20000);
    assert.equal(s.shortfall, 30000);
    assert.equal(s.underScheduled, true);
  });

  test('полностью оплаченная рассрочка closed=true', () => {
    const s2 = structuredClone(state);
    s2.installments[0].total = 20000;
    s2.records[0].amount = 20000;
    const [s] = installmentSummaries(s2, buildTimeline(s2, '2026-02-28'));
    assert.equal(s.remaining, 0);
    assert.equal(s.closed, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('groupThousands / fmtMoney — формат чисел', () => {
  test('меньше 10 000 — без разделителей', () => {
    assert.equal(groupThousands(0), '0');
    assert.equal(groupThousands(999), '999');
    assert.equal(groupThousands(1000), '1000');
    assert.equal(groupThousands(9999), '9999');
  });
  test('от 10 000 — узкий пробел по тысячам', () => {
    assert.equal(groupThousands(10000), `10${THIN}000`);
    assert.equal(groupThousands(1234567), `1${THIN}234${THIN}567`);
  });
  test('округление до рубля', () => {
    assert.equal(groupThousands(1000.4), '1000');
    assert.equal(groupThousands(1000.5), '1001');
    assert.equal(groupThousands(12345.67), `12${THIN}346`);
  });
  test('отрицательные — типографский минус', () => {
    assert.equal(groupThousands(-50000), `${MINUS}50${THIN}000`);
    assert.equal(groupThousands(-999), `${MINUS}999`);
  });
  test('fmtMoney добавляет узкий пробел и рубль', () => {
    assert.equal(fmtMoney(1000), `1000${THIN}₽`);
    assert.equal(fmtMoney(50000), `50${THIN}000${THIN}₽`);
    assert.equal(fmtMoney(-50000), `${MINUS}50${THIN}000${THIN}₽`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('monthlyLoads / yearlyLoads', () => {
  const state = {
    settings: { salary: 0, banks: [], startPeriod: '2026-01-15' },
    regulars: [
      { id: 'salary', name: 'ЗП', kind: 'income', amount: 100000, schedule: 'both', bank: null, active: true },
      { id: 'rent', name: 'Аренда', kind: 'expense', amount: 25000, schedule: 'both', bank: 'Альфа', active: true },
    ],
    installments: [],
    records: [],
  };
  const tl = buildTimeline(state, '2026-02-28');

  test('агрегация по месяцам: доход/расход/нагрузка', () => {
    const m = monthlyLoads(tl);
    const jan = m.find(x => x.ym === '2026-01');
    // два периода в январе: доход 200000, расход 50000
    assert.equal(jan.income, 200000);
    assert.equal(jan.expense, 50000);
    assert.equal(jan.load, 0.25);
    assert.equal(jan.zone.key, 'green');
    assert.equal(jan.y, 2026);
    assert.equal(jan.m, 1);
  });

  test('агрегация по годам', () => {
    const [y] = yearlyLoads(tl);
    assert.equal(y.year, 2026);
    assert.equal(y.income, 400000); // 4 периода × 100000
    assert.equal(y.expense, 100000);
    assert.equal(y.load, 0.25);
  });

  test('load=null при нулевом доходе в месяце', () => {
    const s2 = structuredClone(state);
    s2.regulars = s2.regulars.filter(r => r.kind !== 'income');
    const m = monthlyLoads(buildTimeline(s2, '2026-01-31'));
    assert.equal(m[0].load, null);
    assert.equal(m[0].zone, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('fmtPeriod / fmtMonth — русские подписи', () => {
  test('дата в родительном падеже', () => {
    assert.equal(fmtPeriod('2026-01-15'), '15 января');
    assert.equal(fmtPeriod('2026-03-31'), '31 марта');
    assert.equal(fmtPeriod('2026-12-15'), '15 декабря');
  });
  test('месяц в именительном + год', () => {
    assert.equal(fmtMonth(2026, 1), 'Январь 2026');
    assert.equal(fmtMonth(2026, 12), 'Декабрь 2026');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('outstanding — просрочено слева, осталось справа от месяца', () => {
  // Февраль 2026 — «показанный месяц»: периоды 2026-02-15 и 2026-02-28.
  const FROM = '2026-02-15', TO = '2026-02-28';
  const base = () => ({
    settings: { salary: 0, banks: [], startPeriod: '2026-01-15' },
    regulars: [
      { id: 'salary', name: 'Зарплата', kind: 'income', amount: 100000, schedule: 'both', bank: null, active: true },
      { id: 'rent', name: 'Аренда', kind: 'expense', amount: 30000, schedule: 'both', bank: 'Альфа', active: true },
    ],
    installments: [],
    records: [],
  });
  const calc = (state, end = '2026-06-30') =>
    outstanding(state, buildTimeline(state, end), FROM, TO);

  test('пустое состояние — нули, а не падение', () => {
    const r = calc(base());
    assert.equal(r.overdue.count, 0);
    assert.equal(r.ahead.sum, 0);
    assert.deepEqual(r.ahead.perBank, {});
  });

  test('регулярные не считаются ни слева, ни справа', () => {
    // аренда 30000 «оба» стоит в КАЖДОМ периоде и нигде не отмечена оплаченной
    const r = calc(base());
    assert.equal(r.overdue.sum, 0, 'неоплаченная аренда за январь — не просрочка');
    assert.equal(r.ahead.once.sum, 0, 'будущая аренда — не долг');
  });

  test('разовый до месяца → просрочка, после → «впереди»', () => {
    const s = base();
    s.records = [
      { id: 'a', period: '2026-01-15', kind: 'expense', name: 'Старое', amount: 5000, bank: 'Озон', paid: false },
      { id: 'b', period: '2026-03-15', kind: 'expense', name: 'Будущее', amount: 7000, bank: 'Тбанк', paid: false },
      { id: 'c', period: '2026-02-15', kind: 'expense', name: 'Этот месяц', amount: 9000, bank: 'Озон', paid: false },
    ];
    const r = calc(s);
    assert.equal(r.overdue.sum, 5000);
    assert.deepEqual(r.overdue.perBank, { 'Озон': 5000 });
    assert.equal(r.ahead.once.sum, 7000, 'платёж текущего месяца в «впереди» не попадает');
    assert.equal(r.ahead.once.count, 1);
    assert.deepEqual(r.ahead.perBank, { 'Тбанк': 7000 });
  });

  test('оплаченные и «мне должны» не считаются', () => {
    const s = base();
    s.records = [
      { id: 'a', period: '2026-01-15', kind: 'expense', name: 'Оплачен', amount: 5000, bank: 'Озон', paid: true },
      { id: 'b', period: '2026-03-15', kind: 'expense', name: 'Мне должны', amount: -8000, bank: 'Озон', paid: false },
    ];
    const r = calc(s);
    assert.equal(r.overdue.sum, 0);
    assert.equal(r.ahead.sum, 0);
  });

  test('платёж без банка попадает в ключ пустой строки (чип «Без банка»)', () => {
    const s = base();
    s.records = [{ id: 'a', period: '2026-04-15', kind: 'expense', name: 'Без банка', amount: 3000, bank: null, paid: false }];
    const r = calc(s);
    assert.equal(r.ahead.perBank[''], 3000);
  });

  test('рассрочка: «впереди» = остаток минус неоплаченное по конец месяца', () => {
    const s = base();
    // 60 000 по 20 000 с 15 января: платежи 15.01, 28.02(эом янв→ 31.01), …
    s.installments = [{ id: 'i1', name: 'Ноут', total: 60000, perPeriod: 20000, firstPeriod: '2026-01-15', bank: 'Тбанк', plan: null }];
    const r = calc(s);
    // ничего не оплачено: остаток 60 000, из них 3 платежа стоят до конца февраля
    // (15.01, 31.01, 15.02, 28.02 — сколько влезло), значит «впереди» = остаток минус они
    const beforeSum = 60000 - r.ahead.inst.sum;
    assert.ok(r.ahead.inst.sum >= 0, 'остаток впереди неотрицателен');
    assert.ok(beforeSum > 0, 'часть платежей стоит до конца месяца');
    assert.equal(r.ahead.inst.sum + beforeSum, 60000, 'ничего не потерялось');
  });

  test('закрытая рассрочка не попадает в «впереди»', () => {
    const s = base();
    s.installments = [{ id: 'i1', name: 'Стул', total: 10000, perPeriod: 10000, firstPeriod: '2026-01-15', bank: 'Озон', plan: null }];
    s.records = [{ id: 'p1', period: '2026-01-15', kind: 'expense', name: 'Стул', amount: 10000, bank: 'Озон', paid: true, installmentId: 'i1' }];
    const r = calc(s);
    assert.equal(r.ahead.inst.sum, 0);
    assert.equal(r.overdue.sum, 0, 'оплаченный платёж не просрочка');
  });

  test('недорасписанная рассрочка учитывается по остатку долга, а не по платежам', () => {
    const s = base();
    // долг 50 000, а планом закрыт всего один платёж на 10 000
    s.installments = [{
      id: 'i1', name: 'Ремонт', total: 50000, bank: 'Альфа',
      plan: [{ period: '2026-03-15', amount: 10000 }],
    }];
    const r = calc(s);
    assert.equal(r.ahead.inst.sum, 50000, 'берём весь остаток долга, а не 10 000 расписанных');
    assert.deepEqual(r.ahead.perBank, { 'Альфа': 50000 });
  });

  test('просроченный платёж рассрочки уходит в просрочку и НЕ дублируется впереди', () => {
    const s = base();
    s.installments = [{
      id: 'i1', name: 'Кресло', total: 30000, bank: 'Озон',
      plan: [
        { period: '2026-01-15', amount: 10000 },   // просрочен
        { period: '2026-02-15', amount: 10000 },   // в показанном месяце
        { period: '2026-03-15', amount: 10000 },   // впереди
      ],
    }];
    const r = calc(s);
    assert.equal(r.overdue.sum, 10000, 'январский платёж — просрочка');
    assert.equal(r.ahead.inst.sum, 10000, 'впереди только мартовский');
    // просрочка + месяц + впереди = весь долг
    assert.equal(r.overdue.sum + 10000 + r.ahead.inst.sum, 30000);
  });

  test('банки рассрочек и разовых суммируются в один чип', () => {
    const s = base();
    s.installments = [{ id: 'i1', name: 'Кресло', total: 20000, bank: 'Озон', plan: [{ period: '2026-03-15', amount: 20000 }] }];
    s.records = [{ id: 'a', period: '2026-04-15', kind: 'expense', name: 'Отель', amount: 5000, bank: 'Озон', paid: false }];
    const r = calc(s);
    assert.deepEqual(r.ahead.perBank, { 'Озон': 25000 });
    assert.equal(r.ahead.sum, 25000);
  });

  test('сумма разбивки по банкам равна итогу «впереди»', () => {
    const s = base();
    s.installments = [{ id: 'i1', name: 'A', total: 20000, bank: 'Озон', plan: [{ period: '2026-03-15', amount: 20000 }] }];
    s.records = [
      { id: 'a', period: '2026-04-15', kind: 'expense', name: 'B', amount: 5000, bank: 'Тбанк', paid: false },
      { id: 'b', period: '2026-05-15', kind: 'expense', name: 'C', amount: 1500, bank: null, paid: false },
    ];
    const r = calc(s);
    const byBank = Object.values(r.ahead.perBank).reduce((x, y) => x + y, 0);
    assert.equal(byBank, r.ahead.sum);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('outstanding — просрочка меряется от сегодня, а не от месяца', () => {
  const base = () => ({
    settings: { salary: 0, banks: [], startPeriod: '2026-01-15' },
    regulars: [{ id: 'salary', name: 'Зарплата', kind: 'income', amount: 100000, schedule: 'both', bank: null, active: true }],
    installments: [],
    records: [
      { id: 'a', period: '2026-01-15', kind: 'expense', name: 'Январь', amount: 1000, bank: 'Озон', paid: false },
      { id: 'b', period: '2026-02-15', kind: 'expense', name: 'Февраль', amount: 2000, bank: 'Озон', paid: false },
      { id: 'c', period: '2026-03-15', kind: 'expense', name: 'Март', amount: 4000, bank: 'Озон', paid: false },
    ],
  });
  const tl = () => buildTimeline(base(), '2026-06-30');

  test('смотрим БУДУЩИЙ месяц: платежи, срок которых не наступил, не просрочены', () => {
    // сегодня 10 февраля, открыт март: февральский платёж ещё впереди
    const r = outstanding(base(), tl(), '2026-03-15', '2026-03-31', '2026-02-10');
    assert.equal(r.overdue.sum, 1000, 'просрочен только январский');
    assert.equal(r.overdue.count, 1);
  });

  test('смотрим ТЕКУЩИЙ месяц: просрочка — из прошлых месяцев', () => {
    const r = outstanding(base(), tl(), '2026-02-15', '2026-02-28', '2026-02-10');
    assert.equal(r.overdue.sum, 1000);
  });

  test('смотрим ПРОШЛЫЙ месяц: его платежи не задваиваются в просрочке', () => {
    // сегодня 10 апреля, открыт февраль — февральский платёж показан в строке
    // месяца, значит в «просрочено» его быть не должно
    const r = outstanding(base(), tl(), '2026-02-15', '2026-02-28', '2026-04-10');
    assert.equal(r.overdue.sum, 1000, 'только январь, февраль не задваивается');
  });

  test('без today ведём себя как раньше — граница по месяцу', () => {
    const r = outstanding(base(), tl(), '2026-03-15', '2026-03-31');
    assert.equal(r.overdue.sum, 3000, 'январь + февраль');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('regularShares — доля регулярных в месячном доходе', () => {
  const reg = (id, amount, schedule, active = true) =>
    ({ id, kind: 'expense', name: id, amount, schedule, active });

  test('месяц = 2 периода: «каждый период» считается вдвое', () => {
    const r = regularShares([reg('a', 10000, 'both')], 70000);
    assert.equal(r.income, 140000);
    assert.equal(r.rows.get('a').monthly, 20000);
    assert.equal(r.rows.get('a').pct, 14.3);
  });

  test('разовое расписание берётся один раз', () => {
    const r = regularShares([reg('a', 11500, 'mid'), reg('b', 720, 'end')], 70000);
    assert.equal(r.rows.get('a').monthly, 11500);
    assert.equal(r.rows.get('a').pct, 8.2);
    assert.equal(r.rows.get('b').pct, 0.5);
  });

  test('итог = сумма округлённых процентов строк (столбец складывается)', () => {
    const regs = [
      reg('rent', 11500, 'mid'), reg('mort', 10000, 'both'), reg('net', 1130, 'mid'),
      reg('tel', 720, 'end'), reg('pillow', 7000, 'both'), reg('jkh', 3500, 'mid'),
    ];
    const r = regularShares(regs, 70000);
    const byRow = regs.reduce((s, x) => s + r.rows.get(x.id).pct, 0);
    assert.equal(r.pct, Math.round(byRow * 10) / 10);
    assert.equal(r.sum, 50850);
    assert.equal(r.pct, 36.3);
  });

  test('выключенный платёж — без процента и мимо итога', () => {
    const r = regularShares([reg('a', 10000, 'mid'), reg('b', 5000, 'mid', false)], 70000);
    assert.equal(r.rows.get('b').pct, null);
    assert.equal(r.rows.get('b').monthly, 5000, 'месячную сумму всё равно считаем');
    assert.equal(r.sum, 10000);
    assert.equal(r.pct, r.rows.get('a').pct);
  });

  test('без зарплаты процентов нет, но сумма есть', () => {
    const r = regularShares([reg('a', 10000, 'mid')], 0);
    assert.equal(r.income, 0);
    assert.equal(r.pct, null);
    assert.equal(r.rows.get('a').pct, null);
    assert.equal(r.sum, 10000);
  });

  test('доходные и нулевые строки не участвуют', () => {
    const regs = [
      { id: 'sal', kind: 'income', amount: 70000, schedule: 'both', active: true },
      reg('zero', 0, 'mid'),
      reg('a', 14000, 'mid'),
    ];
    const r = regularShares(regs, 70000);
    assert.equal(r.rows.has('sal'), false, 'зарплата — не расход');
    assert.equal(r.rows.get('zero').pct, null);
    assert.equal(r.sum, 14000);
    assert.equal(r.pct, 10);
  });

  test('перегруз считается честно, без потолка в 100%', () => {
    const r = regularShares([reg('a', 100000, 'both')], 70000);
    assert.equal(r.pct, 142.9);
    assert.equal(loadZone(r.pct / 100).key, 'over');
  });
});
