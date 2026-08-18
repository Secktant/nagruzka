// Тесты подбора расписания рассрочки (app/js/autoplan.js). Модуль чистый —
// ни DOM, ни состояния, поэтому кейсы задаются готовым окном периодов.
// Запуск: из app/ — `node --test`.
//
// Классы эквивалентности, ради которых тесты и написаны: каскад уровней
// 50 → 65 → перегруз, уплотнение плана внутри срока, нулевой доход, период уже
// за порогом, «мне должны» в периоде, окно из одной даты, долг меньше
// минимального платежа, остаток от деления, пустое окно.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { autoDistribute, LEVELS, MIN_PAYMENT } from '../js/autoplan.js';

// окно из n периодов с одинаковым доходом и заданными расходами
const win = (expenses, income = 70000) => expenses.map((expense, i) => ({
  period: `2026-0${1 + Math.floor(i / 2)}-${i % 2 ? '28' : '15'}`,
  income,
  expense,
}));

const sum = (plan) => plan.reduce((s, it) => s + it.amount, 0);

describe('autoDistribute — базовое поведение', () => {
  test('пустой долг и пустое окно не ломают вызов', () => {
    assert.equal(autoDistribute({ periods: win([0, 0]), total: 0 }).ok, false);
    assert.equal(autoDistribute({ periods: win([0, 0]), total: 0 }).reason, 'no-total');
    assert.equal(autoDistribute({ periods: [], total: 10000 }).reason, 'no-periods');
    assert.deepEqual(autoDistribute({ periods: [], total: 10000 }).plan, []);
  });

  test('план всегда покрывает долг ровно, без недобора и перебора', () => {
    for (const total of [1000, 4000, 50000, 33333, 99999]) {
      const r = autoDistribute({ periods: win([0, 0, 0, 0, 0, 0]), total });
      assert.equal(sum(r.plan), total, `total=${total}`);
    }
  });

  test('остаток от деления уходит в последний платёж, и он не больше прочих', () => {
    // 50 000 на 7 периодов: 7143 × 6 + 7142
    const r = autoDistribute({ periods: win(new Array(8).fill(66000)), total: 50000 });
    assert.equal(sum(r.plan), 50000);
    const last = r.plan[r.plan.length - 1].amount;
    assert.ok(last <= r.payment, 'последний платёж не больше остальных');
    assert.ok(last > 0, 'последний платёж положительный');
    for (const it of r.plan.slice(0, -1)) assert.equal(it.amount, r.payment);
  });

  test('одна дата в окне — один платёж на всю сумму', () => {
    const r = autoDistribute({ periods: win([0]), total: 20000 });
    assert.equal(r.plan.length, 1);
    assert.equal(r.plan[0].amount, 20000);
  });

  test('долг меньше минимального платежа не даёт ноль платежей', () => {
    const r = autoDistribute({ periods: win([0, 0, 0, 0]), total: 700 });
    assert.equal(r.ok, true);
    assert.equal(r.plan.length, 1);
    assert.equal(r.plan[0].amount, 700);
  });

  test('мельче MIN_PAYMENT не дробим', () => {
    // 4 000 ₽ при пустом окне из 30 дат: не больше 4 платежей по 1 000
    const r = autoDistribute({ periods: win(new Array(30).fill(0)), total: 4000 });
    assert.ok(r.count <= 4, `ожидали ≤4 платежей, получили ${r.count}`);
    assert.ok(r.payment >= MIN_PAYMENT);
  });
});

describe('autoDistribute — каскад уровней', () => {
  test('свободное окно: минимальное число платежей под «спокойно»', () => {
    // доход 70 000, порог 50% = 35 000 свободного места в каждом периоде
    const r = autoDistribute({ periods: win([0, 0, 0, 0]), total: 60000 });
    assert.equal(r.level, LEVELS[0]);
    assert.equal(r.count, 2, 'два платежа по 30 000 влезают в 50%');
    assert.equal(r.payment, 30000);
    assert.ok(r.peak <= 0.5 + 1e-9);
  });

  test('когда под 50% не влезает — поднимаемся до 65%, но не выше', () => {
    // в каждом периоде уже 40 000 из 70 000 (57%) — «спокойно» недостижимо ни при каком N
    const r = autoDistribute({ periods: win(new Array(6).fill(40000)), total: 30000 });
    assert.equal(r.level, LEVELS[1]);
    assert.ok(r.peak > 0.5 && r.peak <= 0.75 + 1e-9, `peak=${r.peak}`);
    assert.deepEqual(r.over, [], 'на уровне 75% перегруженных периодов нет');
  });

  test('не влезает и в 65% — план строится, но level=null и перечислены перегруженные', () => {
    const r = autoDistribute({ periods: win(new Array(3).fill(60000)), total: 60000 });
    assert.equal(r.ok, true);
    assert.equal(r.level, null, 'ни один уровень не выдержал');
    assert.equal(sum(r.plan), 60000, 'долг всё равно разложен полностью');
    assert.ok(r.over.length > 0, 'перегруженные периоды названы');
    for (const x of r.over) assert.ok(x.load > 0.75);
  });

  test('перегруз раскладывается с минимально возможным пиком', () => {
    // 2 свободных периода и 2 забитых: пик должен опираться на свободные
    const periods = win([0, 0, 68000, 68000]);
    const r = autoDistribute({ periods, total: 120000 });
    assert.equal(sum(r.plan), 120000);
    // альтернатива «всё в один период» дала бы 120000/70000 ≈ 171%
    assert.ok(r.peak < 1.7, `пик ${r.peak} должен быть меньше однопериодного`);
  });
});

describe('autoDistribute — уплотнение внутри срока', () => {
  test('пропущенные даты занимаются, дата закрытия не съезжает', () => {
    // 1-й и 4-й периоды свободны, 2-й и 3-й заняты на 10 000. Минимальный план —
    // два платежа по 30 000 на 1-й и 4-й: 2-й и 3-й перепрыгнуты, хотя срок уже
    // отдан до 4-го. Уплотнение раскладывает те же 60 000 на все четыре даты.
    const r = autoDistribute({ periods: win([0, 10000, 10000, 0]), total: 60000 });
    assert.equal(r.count, 4, 'заняты все четыре даты, а не две');
    assert.equal(r.payment, 15000);
    assert.equal(sum(r.plan), 60000, 'сумма плана равна долгу');
    assert.equal(r.plan[r.plan.length - 1].period, win([0, 0, 0, 0])[3].period,
      'закрывается тем же периодом, что и минимальный план');
    assert.ok(r.peak < 30000 / 70000, `пик должен упасть, получили ${r.peak}`);
  });

  test('дробление без выигрыша не делаем: свободное окно остаётся коротким планом', () => {
    // Все даты свободны — перепрыгивать нечего, лишние строки ничего не дают.
    const r = autoDistribute({ periods: win([0, 0, 0, 0]), total: 60000 });
    assert.equal(r.count, 2);
  });
});

describe('autoDistribute — свойства периодов', () => {
  test('периоды с нулевым доходом пропускаются, а не считаются свободными', () => {
    const periods = [
      { period: '2026-01-15', income: 0, expense: 0 },
      { period: '2026-01-31', income: 70000, expense: 0 },
      { period: '2026-02-15', income: 70000, expense: 0 },
    ];
    const r = autoDistribute({ periods, total: 40000 });
    assert.ok(!r.plan.some(it => it.period === '2026-01-15'), 'дата без дохода не занята');
    assert.equal(sum(r.plan), 40000);
  });

  test('окно только из бездоходных периодов = отказ', () => {
    const periods = [
      { period: '2026-01-15', income: 0, expense: 0 },
      { period: '2026-01-31', income: 0, expense: 0 },
    ];
    const r = autoDistribute({ periods, total: 5000 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-periods');
  });

  test('загруженные даты выпадают: платежи встают на свободные', () => {
    // 15-е числа забиты под завязку, 28-е свободны
    const periods = win([69000, 0, 69000, 0, 69000, 0]);
    const r = autoDistribute({ periods, total: 60000 });
    assert.equal(r.level, LEVELS[0]);
    for (const it of r.plan) assert.ok(it.period.endsWith('-28'), `${it.period} должен быть свободной датой`);
  });

  test('«мне должны» в периоде увеличивает свободное место', () => {
    // отрицательный расход = деньги вернутся, значит места больше обычного
    const withOwed = autoDistribute({ periods: win([-30000]), total: 60000 });
    assert.equal(withOwed.level, LEVELS[0], 'в 50% укладываемся одним платежом');
    const plain = autoDistribute({ periods: win([0]), total: 60000 });
    assert.equal(plain.level, null, 'без возврата тот же платёж уже перегруз');
  });

  test('период, уже перешедший порог, не берётся на своём уровне', () => {
    // 38 000 из 70 000 — это 54%, «спокойно» там уже недостижимо
    const periods = [
      { period: '2026-01-15', income: 70000, expense: 38000 },
      { period: '2026-01-31', income: 70000, expense: 0 },
      { period: '2026-02-15', income: 70000, expense: 0 },
    ];
    const r = autoDistribute({ periods, total: 60000 });
    assert.equal(r.level, LEVELS[0]);
    assert.ok(!r.plan.some(it => it.period === '2026-01-15'));
  });
});

describe('autoDistribute — план пригоден к сохранению', () => {
  test('даты не повторяются и идут по возрастанию', () => {
    const r = autoDistribute({ periods: win(new Array(10).fill(20000)), total: 90000 });
    const dates = r.plan.map(it => it.period);
    assert.equal(new Set(dates).size, dates.length, 'дубликатов дат нет');
    assert.deepEqual(dates, [...dates].sort(), 'даты по возрастанию');
  });

  test('все суммы целые и положительные', () => {
    const r = autoDistribute({ periods: win(new Array(9).fill(11000)), total: 77777 });
    for (const it of r.plan) {
      assert.ok(Number.isInteger(it.amount), `${it.amount} не целое`);
      assert.ok(it.amount > 0, `${it.amount} не положительное`);
    }
  });
});
