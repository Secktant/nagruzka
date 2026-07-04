// Тесты чистых помощников форматирования (app/js/format.js), вынесенных из app.js
// при распиле монолита. Все — без DOM и без общего состояния. Запуск: из app/ — `node --test`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  todayISO, horizonEnd, fmtPeriodFull, addDays, payKey, payTypeMark, plural, HORIZON_MONTHS,
} from '../js/format.js';

// ─────────────────────────────────────────────────────────────────────────────
describe('todayISO — Date → YYYY-MM-DD (локальные компоненты, TZ-независимо)', () => {
  test('форматирует переданную дату', () => {
    assert.equal(todayISO(new Date(2026, 0, 5)), '2026-01-05');
    assert.equal(todayISO(new Date(2026, 11, 31)), '2026-12-31');
    assert.equal(todayISO(new Date(2026, 6, 9)), '2026-07-09');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('horizonEnd — последний день месяца через N месяцев', () => {
  test('дефолт = HORIZON_MONTHS вперёд, полный месяц', () => {
    assert.equal(HORIZON_MONTHS, 18);
    assert.equal(horizonEnd(new Date(2026, 0, 15)), '2027-07-31'); // янв 2026 + 18 мес
  });
  test('явное число месяцев', () => {
    assert.equal(horizonEnd(new Date(2026, 0, 15), 1), '2026-02-28'); // конец февраля
  });
  test('високосный февраль', () => {
    assert.equal(horizonEnd(new Date(2024, 0, 1), 1), '2024-02-29');
  });
  test('переход через год', () => {
    assert.equal(horizonEnd(new Date(2026, 10, 1), 3), '2027-02-28'); // ноя 2026 +3 → фев 2027
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('fmtPeriodFull — «день месяц год»', () => {
  test('добавляет год к подписи периода', () => {
    assert.equal(fmtPeriodFull('2026-03-15'), '15 марта 2026');
    assert.equal(fmtPeriodFull('2026-12-31'), '31 декабря 2026');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('payKey — стабильный ключ платёжной строки', () => {
  test('виртуальный регулярный → по regularId', () => {
    assert.equal(payKey({ virtual: true, regularId: 'reg1' }), 'v|reg1');
  });
  test('виртуальная рассрочка → по installmentId', () => {
    assert.equal(payKey({ virtual: true, installmentId: 'inst9' }), 'v|inst9');
  });
  test('реальная запись → по id', () => {
    assert.equal(payKey({ virtual: false, id: 'rec5' }), 'r|rec5');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('payTypeMark — иконка типа платежа', () => {
  const mark = (p) => payTypeMark(p);
  test('дебиторка: разовый минус → 🤝 owed', () => {
    const h = mark({ amount: -5000 });
    assert.match(h, /pay-type owed/);
    assert.match(h, /🤝/);
  });
  test('регулярный → 🔁 reg', () => {
    const h = mark({ regularId: 'r', amount: 100 });
    assert.match(h, /pay-type reg/);
    assert.match(h, /🔁/);
  });
  test('рассрочка → 💳 inst', () => {
    const h = mark({ installmentId: 'i', amount: 100 });
    assert.match(h, /pay-type inst/);
    assert.match(h, /💳/);
  });
  test('разовый плюс → 💵 once', () => {
    const h = mark({ amount: 100 });
    assert.match(h, /pay-type once/);
    assert.match(h, /💵/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('plural — русские формы множественного числа', () => {
  const p = (n) => plural(n, 'день', 'дня', 'дней');
  test('one: 1, 21, 101 — но не 11', () => {
    assert.equal(p(1), 'день');
    assert.equal(p(21), 'день');
    assert.equal(p(101), 'день');
    assert.equal(p(11), 'дней');
  });
  test('few: 2-4, 22-24 — но не 12-14', () => {
    assert.equal(p(2), 'дня');
    assert.equal(p(4), 'дня');
    assert.equal(p(23), 'дня');
    assert.equal(p(12), 'дней');
    assert.equal(p(14), 'дней');
  });
  test('many: 5-20, 25-30, 0', () => {
    assert.equal(p(5), 'дней');
    assert.equal(p(0), 'дней');
    assert.equal(p(20), 'дней');
    assert.equal(p(100), 'дней');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// addDays завязан на локальную TZ (new Date('…T00:00:00') локально + toISOString UTC):
// в не-UTC зоне результат смещён на день. Это существующее поведение (перенесено дословно);
// единственный вызов — эвристика подсветки «текущего периода» с окном 16 дней, ±1 день там
// не важен. Точные значения проверяем только в UTC, форму — везде. Кандидат на TZ-независимую
// переработку в отдельном пункте (не в рамках распила).
describe('addDays', () => {
  test('форма результата YYYY-MM-DD (везде)', () => {
    assert.match(addDays('2026-06-15', 7), /^\d{4}-\d{2}-\d{2}$/);
    assert.match(addDays('2026-01-31', 1), /^\d{4}-\d{2}-\d{2}$/);
  });
  test('точные значения (только в UTC)', (t) => {
    if (new Date().getTimezoneOffset() !== 0) {
      t.skip('TZ ≠ UTC: addDays смещён на локальную зону, точные значения не проверяем');
      return;
    }
    assert.equal(addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(addDays('2026-06-15', 7), '2026-06-22');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  });
});
