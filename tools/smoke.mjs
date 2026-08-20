// Headless boot-smoke: грузит приложение в реальном Chromium и проверяет, что оно
// СТАРТУЕТ и все вкладки рендерятся без ошибок консоли. Ловит класс, который
// node --test и node --check НЕ видят: несовпадение export/import между модулями
// (ESM-линковка) — «белый экран». Сам сервит статику мини-сервером, чтобы не тянуть
// внешних зависимостей. Запуск: node tools/smoke.mjs (из корня). Ненулевой код = провал.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = process.cwd();
const PORT = 8137;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = join(ROOT, normalize(p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(PORT, r));

const fail = (msg) => { console.error('✖ SMOKE FAIL: ' + msg); };
const errors = [];
let exitCode = 0;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

  // 1) приложение загрузилось: вкладка «Периоды» отрисовала карточки периодов
  //    (если модуль не слинковался — здесь таймаут, что и есть детектор «белого
  //    экрана»). Считаем именно карточки, а не длину текста: с 1.3.0 во вьюхе
  //    есть ещё рельс года, и его названий месяцев хватило бы на любой порог длины.
  await page.waitForFunction(
    () => document.querySelectorAll('#periods .card').length >= 1,
    { timeout: 15000 },
  ).catch(() => { throw new Error('«Периоды» не отрисовались за 15с — приложение не стартовало'); });

  // 1b) рельс года: ровно 12 строк-месяцев независимо от данных. Рисуется из
  //     renderPeriods(), поэтому пустой рельс = вьюха отработала наполовину.
  const railRows = await page.$$eval('#year-rail .rail-row', (els) => els.length).catch(() => 0);
  if (railRows !== 12) throw new Error(`рельс года: ${railRows} месяцев вместо 12`);

  // 2) каждая вкладка рендерится
  const checks = [
    ['Долги', '#view-debts', (t) => t.includes('Долги') || t.includes('рассроч')],
    // «Деньги» — зарплата, регулярные, банки (3 карточки). «Настройки» после распила
    // содержат бэкап + синк; замок рисуется только при заведённом ключе, поэтому >= 2.
    ['Деньги', '#view-money', null, async () => (await page.$$('#view-money h3')).length >= 3],
    ['Настройки', '#view-settings', null, async () => (await page.$$('#view-settings h3')).length >= 2],
    ['Периоды', '#view-periods', null, async () => (await page.$$('#periods .card')).length >= 1],
  ];
  for (const [label, sel, textCheck, elCheck] of checks) {
    await page.evaluate((l) => {
      const b = [...document.querySelectorAll('nav button')].find((x) => x.textContent.includes(l));
      b?.click();
    }, label);
    await page.waitForTimeout(400);
    if (elCheck) {
      if (!(await elCheck())) throw new Error(`вкладка «${label}» не отрисовалась`);
    } else {
      const txt = await page.$eval(sel, (e) => e.textContent).catch(() => '');
      if (!textCheck(txt)) throw new Error(`вкладка «${label}» пуста/неверна`);
    }
  }

  if (errors.length) { exitCode = 1; fail('ошибки в консоли:\n   ' + errors.join('\n   ')); }
  else console.log('✓ smoke: приложение стартует, все 4 вкладки рендерятся, ошибок консоли нет');
} catch (e) {
  exitCode = 1;
  fail(e.message);
  if (errors.length) console.error('   консоль:\n   ' + errors.join('\n   '));
} finally {
  await browser.close();
  server.close();
}
process.exit(exitCode);
