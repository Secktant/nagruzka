// Тесты чистых UI-примитивов (app/js/dom.js), вынесенных из app.js при распиле.
// Проверяем то, что не требует DOM: экранирование, id, денежный парсер/форматтер,
// разметку money-поля. ($, $$, openModal/closeModal, wireMoneyInputs — DOM-only, не здесь.)
// Запуск: из app/ — `node --test`.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { esc, uid, parseMoney, fmtNumEditor, moneyInput } from '../js/dom.js';

// ─────────────────────────────────────────────────────────────────────────────
describe('esc — экранирование HTML', () => {
  test('спецсимволы & < > "', () => {
    assert.equal(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
  });
  test('обычный текст без изменений', () => {
    assert.equal(esc('Альфа-Банк 2026'), 'Альфа-Банк 2026');
  });
  test('нестроки приводятся к строке', () => {
    assert.equal(esc(5000), '5000');
    assert.equal(esc(null), 'null');
  });
  test("апостроф не трогаем (значения только в двойных кавычках)", () => {
    assert.equal(esc("it's"), "it's");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('uid — генератор id', () => {
  test('форма prefix-xxx-yyy', () => {
    assert.match(uid('rec'), /^rec-[a-z0-9]+-[a-z0-9]+$/);
    assert.match(uid('inst'), /^inst-[a-z0-9]+-[a-z0-9]+$/);
  });
  test('два вызова различаются', () => {
    assert.notEqual(uid('x'), uid('x'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('parseMoney — строка поля → число', () => {
  test('убирает пробелы-разделители тысяч', () => {
    assert.equal(parseMoney('1 000'), 1000);
    assert.equal(parseMoney('1 234 567'), 1234567);
  });
  test('типографский минус и запятая-разделитель', () => {
    assert.equal(parseMoney('−5'), -5);
    assert.equal(parseMoney('1,5'), 1.5);
    assert.equal(parseMoney('-3'), -3);
  });
  test('целое число как есть', () => {
    assert.equal(parseMoney(42), 42);
  });
  test('пусто/null/undefined → 0 (пустое поле = ноль)', () => {
    assert.equal(parseMoney(''), 0);
    assert.equal(parseMoney(null), 0);
    assert.equal(parseMoney(undefined), 0);
  });
  test('нечисловой мусор → NaN', () => {
    assert.ok(Number.isNaN(parseMoney('abc')));
    assert.ok(Number.isNaN(parseMoney('12x')));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('fmtNumEditor — число → строка поля (обычный пробел, шаг до копейки)', () => {
  test('меньше 10 000 — без разделителей', () => {
    assert.equal(fmtNumEditor(0), '0');
    assert.equal(fmtNumEditor(1000), '1000');
    assert.equal(fmtNumEditor(9999), '9999');
  });
  test('от 10 000 — группировка обычным пробелом', () => {
    assert.equal(fmtNumEditor(10000), '10 000');
    assert.equal(fmtNumEditor(1234567), '1 234 567');
  });
  test('отрицательные — ASCII-минус', () => {
    assert.equal(fmtNumEditor(-50000), '-50 000');
  });
  test('дробная часть до двух знаков', () => {
    assert.equal(fmtNumEditor(1234.5), '1234,50');
    assert.equal(fmtNumEditor(12345.6), '12 345,60');
  });
  test('пусто/null/NaN → пустая строка', () => {
    assert.equal(fmtNumEditor(''), '');
    assert.equal(fmtNumEditor(null), '');
    assert.equal(fmtNumEditor(NaN), '');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('moneyInput — разметка поля со стрелками', () => {
  test('вставляет name и форматированное value', () => {
    const h = moneyInput('amount', 5000);
    assert.match(h, /class="num-field"/);
    assert.match(h, /name="amount"/);
    assert.match(h, /value="5000"/);
  });
  test('пустое значение → value=""', () => {
    assert.match(moneyInput('x', ''), /value=""/);
    assert.match(moneyInput('x', null), /value=""/);
  });
  test('большое значение форматируется в value', () => {
    assert.match(moneyInput('x', 1234567), /value="1 234 567"/);
  });
});
