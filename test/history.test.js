// Тесты лога изменений (app/js/store.js, пункт 4 роадмапа).
// Модуль держит состояние в S, поэтому кейсы подставляют S.state руками —
// IndexedDB здесь не нужна: logChange только пишет в память, персист делает saveAll.
//
// Классы эквивалентности: форма записи, настенное время (НЕ TODAY), потолок
// кольцевого буфера, снимок без лога (миграция), diffFields.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { S, logChange, diffFields, HISTORY_LIMIT } from '../js/store.js';

const fresh = () => { S.state = { settings: {}, regulars: [], installments: [], records: [], history: [] }; };

describe('logChange — форма записи', () => {
  test('пишет тип, действие, id, имя и период платежа', () => {
    fresh();
    logChange('record', 'paid', { id: 'r1', name: 'Интернет', period: '2026-08-15' });
    assert.equal(S.state.history.length, 1);
    const it = S.state.history[0];
    assert.equal(it.e, 'record');
    assert.equal(it.act, 'paid');
    assert.equal(it.id, 'r1');
    assert.equal(it.name, 'Интернет');
    assert.equal(it.period, '2026-08-15');
  });

  test('время — настенные часы устройства, а не TODAY приложения', () => {
    fresh();
    const before = Date.now();
    logChange('regular', 'on', { id: 'reg1', name: 'Каршеринг' });
    const t = S.state.history[0].t;
    assert.ok(t >= before && t <= Date.now(), `t=${t} вне окна вызова`);
  });

  test('period не выдумывается там, где его нет', () => {
    fresh();
    logChange('settings', 'edit', { id: 'salary', name: 'Зарплата' }, { was: { amount: 70000 }, now: { amount: 80000 } });
    const it = S.state.history[0];
    assert.equal('period' in it, false);
    assert.deepEqual(it.was, { amount: 70000 });
    assert.deepEqual(it.now, { amount: 80000 });
  });

  test('без состояния не падает (лог до загрузки снимка)', () => {
    S.state = null;
    assert.doesNotThrow(() => logChange('record', 'create', { id: 'x', name: 'y' }));
  });
});

describe('logChange — кольцевой буфер', () => {
  test(`держит потолок в ${HISTORY_LIMIT} записей, подрезая самое старое`, () => {
    fresh();
    for (let i = 0; i < HISTORY_LIMIT + 25; i++) {
      logChange('record', 'create', { id: `r${i}`, name: `Платёж ${i}` });
    }
    assert.equal(S.state.history.length, HISTORY_LIMIT);
    assert.equal(S.state.history[0].id, 'r25', 'подрезаны именно первые 25');
    assert.equal(S.state.history[HISTORY_LIMIT - 1].id, `r${HISTORY_LIMIT + 24}`, 'последнее событие на месте');
  });

  test('снимок без лога (до 1.8.0) не ломает запись — массив заводится сам', () => {
    S.state = { settings: {}, regulars: [], installments: [], records: [] };
    logChange('record', 'delete', { id: 'r1', name: 'Подписка' });
    assert.equal(S.state.history.length, 1);
  });
});

describe('diffFields', () => {
  test('возвращает только изменённые поля парой', () => {
    const d = diffFields(
      { amount: 42000, name: 'Ипотека', bank: 'Альфа' },
      { amount: 43500, name: 'Ипотека', bank: 'Тбанк' },
      ['amount', 'name', 'bank'],
    );
    assert.deepEqual(d.was, { amount: 42000, bank: 'Альфа' });
    assert.deepEqual(d.now, { amount: 43500, bank: 'Тбанк' });
  });

  test('без изменений — null, чтобы вьюха не писала пустое событие', () => {
    assert.equal(diffFields({ amount: 100 }, { amount: 100 }, ['amount']), null);
  });

  test('появившееся и исчезнувшее поле пишутся как null', () => {
    const d = diffFields({ bank: null }, { bank: 'Озон' }, ['bank']);
    assert.deepEqual(d.was, { bank: null });
    assert.deepEqual(d.now, { bank: 'Озон' });
  });
});
