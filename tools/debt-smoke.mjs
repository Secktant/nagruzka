// Browser regressions for installment editing and the month an obligation appeared.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { launchOptions, traceStart, traceFinish } from './browser-trace.mjs';

const ROOT = process.cwd();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    const file = resolve(ROOT, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(ROOT + '/')) { res.writeHead(403); res.end(); return; }
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sameDay = () => ({
  settings: { startPeriod: '2026-01-15', banks: ['Альфа', 'Озон'] }, regulars: [], history: [],
  installments: [{ id: 'i', name: 'Рассрочка QA', total: 9000, bank: 'Альфа',
    perPeriod: 3000, firstPeriod: '2026-07-15', createdMonth: '2026-06',
    plan: [{ period: '2026-08-15', amount: 4000 }] }],
  records: [
    { id: 'paid', installmentId: 'i', kind: 'expense', name: 'Рассрочка QA',
      period: '2026-07-15', amount: 2000, bank: 'Альфа', paid: true },
    { id: 'unpaid', installmentId: 'i', kind: 'expense', name: 'Рассрочка QA',
      period: '2026-07-15', amount: 3000, bank: 'Альфа', paid: false },
  ],
});
let browser, context, page, failed = true;
const errors = [];
async function attach() {
  await page.waitForSelector('#periods .card');
  await page.evaluate(async () => {
    window.qa = { ...await import('/js/store.js'), engine: await import('/js/engine.js'),
      render: (await import('/js/render.js')).render, db: await import('/js/db.js'),
      crypto: await import('/js/crypto.js') };
  });
}
async function seed(state) {
  await page.evaluate(async state => {
    qa.S.state = state; qa.S.view = { y: 2026, m: 7, tab: 'debts' };
    await qa.saveAll(); qa.render();
  }, state);
}
async function openDebt() { await page.locator('[data-debt="i"]').click(); }
async function saveDebt() {
  await page.locator('#debt-form button.primary').click();
  await page.waitForSelector('#debt-form', { state: 'hidden' });
  await page.evaluate(() => qa.flushLocalChanges());
}
async function financial() {
  return page.evaluate(() => {
    qa.recalc();
    const summary = qa.engine.installmentSummaries(qa.S.state, qa.S.timeline)[0];
    const july = qa.S.timeline.get('2026-07-15').payments.filter(p => p.installmentId === 'i');
    const ids = qa.S.state.records.map(r => r.id);
    return { unpaidJuly: july.filter(p => !p.paid).reduce((sum, p) => sum + p.amount, 0),
      paidJuly: july.filter(p => p.paid).reduce((sum, p) => sum + p.amount, 0),
      remaining: summary.remaining, scheduled: summary.scheduledSum,
      aheadJuly: qa.engine.outstanding(qa.S.state, qa.S.timeline, '2026-07-15', '2026-07-31', '2026-06-10').ahead.sum,
      uniqueIds: new Set(ids).size === ids.length };
  });
}
async function reload() { await page.reload(); await attach(); }
async function viewMonth(month) {
  await page.evaluate(month => { qa.S.view = { y: 2026, m: month, tab: 'periods' }; qa.render(); }, month);
  return page.locator('#month-band .mb-ahead').innerText();
}
async function stateJSON() { return page.evaluate(() => JSON.stringify(qa.S.state)); }
async function snapshotRoundtrip() {
  const result = await page.evaluate(async () => {
    const json = qa.db.exportState(qa.S.state);
    const bytes = await qa.crypto.encryptText(json, 'synthetic-debt-password', null);
    const restored = await qa.crypto.decryptToText(bytes, 'synthetic-debt-password', null);
    const before = structuredClone(qa.S.state);
    await qa.adoptStateJSON(restored);
    return { before, after: qa.S.state };
  });
  assert.deepEqual(result.after, result.before, '.nz roundtrip preserves complete synthetic state');
}
try {
  browser = await chromium.launch(launchOptions());
  context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 800, height: 1000 }, timezoneId: 'Europe/Samara' });
  await traceStart(context);
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.clock.setFixedTime(new Date('2026-06-10T10:00:00+04:00'));
  await page.goto(origin); await attach(); await seed(sameDay());
  const expected = { unpaidJuly: 3000, paidJuly: 2000, remaining: 7000, scheduled: 9000, aheadJuly: 4000, uniqueIds: true };
  assert.deepEqual(await financial(), expected, 'debt-calendar baseline');
  const historyBeforeSave = await page.evaluate(() => qa.S.state.history.length);
  await openDebt(); await saveDebt();
  assert.deepEqual(await financial(), expected, 'debt-calendar no-op save must preserve the unpaid slot beside a paid slot');
  await openDebt(); await saveDebt();
  assert.deepEqual(await financial(), expected, 'repeated no-op save');
  assert.equal(await page.evaluate(() => qa.S.state.history.length), historyBeforeSave,
    'no-op saves do not append false history changes: ' + await page.evaluate(() => JSON.stringify(qa.S.state.history)));
  assert.deepEqual(await page.evaluate(() => qa.S.state.records.map(r => r.id).sort()), ['paid', 'unpaid'], 'no-op retains real record IDs');
  await reload();
  assert.deepEqual(await financial(), expected, 'same-date slots survive reload');
  await page.getByRole('button', { name: 'Долги', exact: true }).click();
  const beforeCancel = await stateJSON();
  await openDebt();
  await page.locator('#debt-form [name=name]').fill('Отменённая правка');
  await page.locator('[data-row-amount]:not([disabled])').first().fill('3500');
  await page.locator('[data-row-period]').first().selectOption('2026-08-15');
  await page.locator('#modal-cancel').click();
  assert.equal(await stateJSON(), beforeCancel, 'cancel rolls back name, amount and date');
  await openDebt();
  await page.locator('#debt-form [name=total]').fill('9500');
  await page.locator('[data-row-amount]:not([disabled])').first().fill('3500');
  await saveDebt();
  assert.deepEqual(await financial(), { ...expected, unpaidJuly: 3500, remaining: 7500, scheduled: 9500 }, 'edit a slot sharing the paid date');
  await openDebt();
  await page.locator('[data-row-period]').first().selectOption('2026-08-15');
  await saveDebt();
  const moved = { ...expected, unpaidJuly: 0, remaining: 7500, scheduled: 9500, aheadJuly: 7500 };
  assert.deepEqual(await financial(), moved, 'move unpaid slot onto another occupied date');
  await openDebt(); await saveDebt();
  assert.deepEqual(await financial(), moved, 'repeat save after merging same-date slots');
  await reload();
  assert.deepEqual(await financial(), moved, 'moved slots survive reload without duplicate IDs');
  await seed(sameDay()); await openDebt();
  await page.locator('[data-row-del]').first().click(); await saveDebt();
  assert.deepEqual(await financial(), { ...expected, unpaidJuly: 0, scheduled: 6000, aheadJuly: 7000 }, 'explicit deletion removes only the requested unpaid slot');
  console.log('✓ debt-calendar: no-op/repeated save, stable IDs, edit/move/delete/cancel and reload');

  const blank = { settings: { startPeriod: '2026-01-15', banks: ['Альфа', 'Озон'] }, regulars: [], installments: [], records: [], history: [] };
  await seed(blank);
  await page.locator('#add-debt').click();
  await page.locator('#debt-form [name=name]').fill('Новая рассрочка');
  await page.locator('#debt-form [name=total]').fill('60000');
  await page.locator('#debt-form [name=perPeriod]').fill('10000');
  await page.locator('#debt-form [name=firstPeriod]').selectOption('2026-07-15');
  await saveDebt();
  await viewMonth(7);
  await page.locator('[data-add-pay="2026-07-15"]').click();
  await page.locator('#pay-form [name=name]').fill('Новый разовый');
  await page.locator('#pay-form [name=amount]').fill('5000');
  await page.locator('#pay-form button.primary').click();
  await page.waitForSelector('#pay-form', { state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => [qa.S.state.installments[0].createdMonth, qa.S.state.records[0].createdMonth]), ['2026-06', '2026-06']);
  assert.match(await viewMonth(5), /На этот месяц долгов впереди нет\./);
  assert.equal(await page.locator('#month-band .mb-ahead .chip').count(), 0);
  assert.match((await viewMonth(6)).replace(/\s/g, ''), /65000/);
  await page.evaluate(() => qa.flushLocalChanges()); await reload();
  assert.match((await viewMonth(6)).replace(/\s/g, ''), /65000/);
  console.log('✓ debt-created-new: both actual forms stamp June; May 0, June 65000, reload stable');

  const legacy = sameDay();
  legacy.installments = [{ id: 'i', name: 'Старая рассрочка', total: 60000, bank: 'Альфа', firstPeriod: '2026-07-15', perPeriod: 10000 }];
  legacy.records = [{ id: 'r', name: 'Старый разовый', kind: 'expense', amount: 5000, period: '2026-07-15', bank: 'Озон', paid: false }];
  legacy.history = ['record', 'installment'].map((e, index) => ({ e, id: index ? 'i' : 'r', act: 'create', t: Date.parse('2026-05-31T21:00:00Z') }));
  await page.evaluate(state => { qa.S.state = state; qa.render(); }, legacy);
  assert.match(await viewMonth(5), /На этот месяц долгов впереди нет\./);
  assert.match((await viewMonth(6)).replace(/\s/g, ''), /65000/, 'history uses local June at the UTC May boundary');
  await page.evaluate(() => {
    while (qa.S.state.history.length < qa.HISTORY_LIMIT) qa.S.state.history.push({ e: 'settings', id: 'noise', act: 'edit', t: Date.now() });
    qa.logChange('settings', 'edit', { id: 'trim-1' }); qa.logChange('settings', 'edit', { id: 'trim-2' });
  });
  assert.deepEqual(await page.evaluate(() => ({ created: qa.S.state.history.some(h => h.act === 'create'),
    months: [qa.S.state.installments[0].createdMonth, qa.S.state.records[0].createdMonth] })), { created: false, months: ['2026-06', '2026-06'] });
  await page.evaluate(() => qa.saveAll()); await reload();
  assert.match((await viewMonth(6)).replace(/\s/g, ''), /65000/);
  await snapshotRoundtrip();
  assert.match((await viewMonth(6)).replace(/\s/g, ''), /65000/);
  console.log('✓ debt-created-legacy: local history boundary, history trim, save/reload and real .nz roundtrip');

  // Independent finance example: includes under-scheduled debt, legacy auto-tail,
  // two banks, an unbanked one-off and an obligation first created in August.
  const finance = {
    ...blank,
    installments: [
      { id: 'a', name: 'A', bank: 'Альфа', total: 96000, firstPeriod: '2026-07-15',
        plan: [{ period: '2026-08-15', amount: 18000 }, { period: '2026-08-31', amount: 10000 }] },
      { id: 'b', name: 'B', bank: 'Озон', total: 30000, perPeriod: 10000, firstPeriod: '2026-06-15' },
    ],
    records: [
      { id: 'ap', installmentId: 'a', kind: 'expense', period: '2026-07-15', amount: 12000, bank: 'Альфа', paid: true },
      { id: 'au', installmentId: 'a', kind: 'expense', period: '2026-07-31', amount: 16000, bank: 'Альфа', paid: false },
      { id: 'r1', kind: 'expense', period: '2026-08-31', amount: 7500, bank: 'Озон', paid: false },
      { id: 'r2', kind: 'expense', period: '2026-07-31', amount: 2500, bank: null, paid: false },
      { id: 'r3', kind: 'expense', period: '2026-09-15', amount: 9000, bank: 'Озон', paid: false },
    ],
    history: [['installment', 'a', '2026-06-10'], ['record', 'r1', '2026-06-10'], ['record', 'r2', '2026-06-10'], ['record', 'r3', '2026-08-10']]
      .map(([e, id, date]) => ({ e, id, act: 'create', t: Date.parse(date + 'T10:00:00+04:00') })),
  };
  await seed(finance);
  const financeRows = await page.evaluate(() => {
    qa.recalc();
    const a = qa.engine.installmentSummaries(qa.S.state, qa.S.timeline).find(s => s.inst.id === 'a');
    return { a: { remaining: a.remaining, scheduled: a.scheduledSum, shortfall: a.shortfall },
      rows: [5, 6, 7, 8].map(m => {
        const mm = String(m).padStart(2, '0');
        const out = qa.engine.outstanding(qa.S.state, qa.S.timeline, `2026-${mm}-15`, `2026-${mm}-${qa.engine.eom(2026, m)}`, '2026-09-10');
        return { overdue: out.overdue.sum, ahead: out.ahead.sum, banks: out.ahead.perBank };
      }) };
  });
  assert.deepEqual(financeRows, { a: { remaining: 84000, scheduled: 56000, shortfall: 40000 }, rows: [
    { overdue: 0, ahead: 0, banks: {} },
    { overdue: 0, ahead: 104000, banks: { 'Альфа': 84000, 'Озон': 17500, '': 2500 } },
    { overdue: 20000, ahead: 75500, banks: { 'Альфа': 68000, 'Озон': 7500 } },
    { overdue: 48500, ahead: 49000, banks: { 'Альфа': 40000, 'Озон': 9000 } },
  ] });
  console.log('✓ debt-finance-example: independent May–August overdue, ahead, bank and shortfall totals');
  assert.deepEqual(errors, [], 'uncaught page errors');
  failed = false;
} finally {
  if (context) { await traceFinish(context, 'debt-smoke', failed); await context.close(); }
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
