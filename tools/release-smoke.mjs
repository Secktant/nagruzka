// Проверяем файлы двух Git-коммитов на одном origin. Ключ, платёж и RPC синтетические.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { saveSnapshots } from './backup/backup.mjs';
import { launchOptions, traceStart, traceFinish } from './browser-trace.mjs';

const password = 'synthetic-release-fixture';
const keyfile = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const installment = { id: 'upgrade', name: 'Тест', total: 12000, bank: 'Тестовый банк',
  firstPeriod: '2026-10-31', perPeriod: 3000, plan: [
    { period: '2026-10-31', amount: 2000 }, { period: '2026-11-15', amount: 3000 },
    { period: '2026-11-30', amount: 7000 },
  ] };
const firstPayment = { id: 'already-paid', installmentId: installment.id, name: installment.name,
  bank: installment.bank, kind: 'expense', period: '2026-10-31', amount: 2000, paid: true };
const dir = await mkdtemp(join(tmpdir(), 'nagruzka-release-'));

async function revision(ref, label) {
  const sha = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'], { encoding: 'utf8' }).trim();
  const root = join(dir, label);
  await mkdir(root);
  const archive = root + '.tar';
  execFileSync('git', ['archive', '-o', archive, sha]);
  execFileSync('tar', ['-xf', archive, '-C', root]);
  const sw = await readFile(join(root, 'sw.js'), 'utf8');
  const version = sw.match(/^const CACHE = 'nagruzka-(\d+\.\d+\.\d+)';$/m)?.[1];
  assert.ok(version, 'Не найдена версия в ' + sha);
  return { root, sha, version };
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
let root, siteOnline = true, rpcOnline = true, browser;
const rows = new Map(), salts = new Map();
function rpc(fn, p) {
  switch (fn) {
    case 'sync_meta_get': return salts.get(p.p_id) ?? null;
    case 'sync_meta_init':
      if (!salts.has(p.p_id)) salts.set(p.p_id, p.p_salt);
      return salts.get(p.p_id);
    case 'sync_pull': return rows.has(p.p_id) ? [rows.get(p.p_id)] : [];
    case 'sync_push': {
      const old = rows.get(p.p_id);
      if (p.p_base_version !== (old?.version ?? 0)) return [{ ok: false, ...old }];
      const version = p.p_base_version + 1;
      rows.set(p.p_id, { salt: p.p_salt, blob: p.p_blob, version, updated_at: new Date().toISOString() });
      return [{ ok: true, version }];
    }
    default: throw new Error('Unexpected synthetic RPC: ' + fn);
  }
}

const server = createServer(async (req, res) => {
  try {
    if (!siteOnline) return res.destroy();
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.startsWith('/rest/v1/rpc/')) {
      if (!rpcOnline) { res.writeHead(503); return res.end(); }
      const body = [];
      for await (const part of req) body.push(part);
      const result = rpc(path.split('/').pop(), JSON.parse(Buffer.concat(body)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : decodeURIComponent(path)));
    if (!file.startsWith(root + sep)) { res.writeHead(403); return res.end(); }
    const bytes = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store', 'Content-Security-Policy': "connect-src 'self' blob: data:" });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});

async function scenario(label, run) {
  const context = await browser.newContext();
  context.setDefaultTimeout(15000);
  try {
    await traceStart(context);
    // Реальные fetch/POST идут на локальный RPC даже в контексте с service worker.
    // CSP исключает обращения к боевому серверу при изменении протокола.
    await context.addInitScript(() => {
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        if (typeof input === 'string') {
          const url = new URL(input, location.href);
          if (url.pathname.startsWith('/rest/v1/rpc/')) input = url.pathname;
        }
        return originalFetch(input, init);
      };
    });
    await run(context);
    await traceFinish(context, label, false);
  } catch (error) {
    await traceFinish(context, label, true);
    throw error;
  } finally { await context.close(); }
}

async function open(context, origin) {
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date('2026-11-15T12:00:00Z'));
  await page.goto(origin);
  await page.locator('#periods .card').first().waitFor();
  return page;
}

async function settings(page) {
  await page.locator('nav button').filter({ hasText: 'Настройки' }).click();
}

async function loadKeyfile(page) {
  await settings(page);
  await page.locator('#kf-file').setInputFiles({ name: 'synthetic.key',
    mimeType: 'application/octet-stream', buffer: keyfile });
  await page.locator('#kf-download').waitFor();
}

async function verify(page, source, row) {
  return page.evaluate(async ({ source, row }) => {
    const { S } = await import('/js/store.js');
    let data = S.state;
    if (source === 'vault') data = await (await import('/js/db.js')).loadVault(S.db, S.vaultKey);
    if (source === 'rpc') {
      const { b64, openGCM } = await import('/js/crypto.js');
      const { AAD_MAIN } = await import('/js/sync.js');
      data = JSON.parse(await openGCM(S.vaultKey, b64.dec(row.blob), AAD_MAIN));
    }
    const { buildTimeline, installmentSummaries } = await import('/js/engine.js');
    const totals = installmentSummaries(data, buildTimeline(data, '2026-11-30'));
    return { plans: data.installments.map(i => ({ id: i.id, total: i.total, plan: i.plan })),
      payments: data.records.map(r => [r.id, r.installmentId, r.period, r.amount, r.paid]),
      remaining: totals.map(t => t.remaining) };
  }, { source, row });
}

function expected(offlineId) {
  const payments = [['already-paid', 'upgrade', '2026-10-31', 2000, true]];
  if (offlineId) payments.push([offlineId, 'upgrade', '2026-11-15', 3000, true]);
  return { plans: [{ id: 'upgrade', total: 12000, plan: installment.plan }], payments,
    remaining: [offlineId ? 7000 : 10000] };
}

try {
  const baseRef = process.env.BASE_RELEASE_SHA || (await readFile('tools/confirmed-release.txt', 'utf8')).trim();
  const before = await revision(baseRef, 'previous'), after = await revision('HEAD', 'candidate');
  console.log('PWA upgrade:', before.sha, 'v' + before.version, '→', after.sha, 'v' + after.version);
  assert.notEqual(before.version, after.version, 'Кандидату нужен новый номер кэша PWA');
  root = before.root;
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch(launchOptions());
  let chunk, paidId;
  await scenario('pwa-upgrade', async context => {
    let page = await open(context, origin);
    await page.waitForFunction(v => navigator.serviceWorker.controller?.state === 'activated'
      && document.querySelector('#app-version').textContent === 'v' + v, before.version);
    await loadKeyfile(page);
    chunk = await page.evaluate(async ({ installment, firstPayment, password }) => {
      const { S, saveAll } = await import('/js/store.js');
      S.state.installments = [installment]; S.state.records = [firstPayment];
      await saveAll();
      const { generateSyncId } = await import('/js/sync.js');
      const id = generateSyncId();
      await (await import('/js/db.js')).setSyncId(S.db, id);
      await S.syncEngine.unlock(id, password);
      await S.syncEngine.start();
      await S.syncEngine.pullAndApply();
      return S.syncEngine.chunkId;
    }, { installment, firstPayment, password });
    assert.deepEqual(await verify(page, 'rpc', rows.get(chunk)), expected());
    const priorRemote = rows.get(chunk);
    await page.locator('nav button').filter({ hasText: 'Периоды' }).click();
    rpcOnline = siteOnline = false;
    await context.setOffline(true);
    await page.locator('input[data-pay="2026-11-15|v|upgrade"]').check();
    paidId = await page.evaluate(async () => {
      const { S, flushLocalChanges } = await import('/js/store.js');
      await flushLocalChanges(); await S.syncEngine.pushNow();
      return S.state.records.find(r => r.period === '2026-11-15')?.id;
    });
    assert.ok(paidId);
    assert.deepEqual(await verify(page, 'vault'), expected(paidId));
    assert.deepEqual(rows.get(chunk), priorRemote, 'Офлайн-платёж преждевременно отправлен');

    root = after.root; siteOnline = true; // RPC остаётся недоступен при обновлении и перезапуске.
    await context.setOffline(false);
    await page.evaluate(async () => {
      window.previousController = navigator.serviceWorker.controller;
      await (await navigator.serviceWorker.ready).update();
    });
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated'
      && navigator.serviceWorker.controller !== window.previousController);
    const cacheKeys = await page.evaluate(() => caches.keys());
    assert.ok(cacheKeys.includes('nagruzka-' + after.version), 'Кэш кандидата отсутствует');
    assert.ok(!cacheKeys.includes('nagruzka-' + before.version), 'Старый кэш ещё активен');
    await page.close();
    siteOnline = false;
    await context.setOffline(true);
    page = await open(context, origin);
    await page.waitForFunction(v => document.querySelector('#app-version').textContent === 'v' + v, after.version);
    assert.deepEqual(await verify(page), expected(paidId));
    assert.deepEqual(await verify(page, 'vault'), expected(paidId));
    assert.deepEqual(rows.get(chunk), priorRemote);
    siteOnline = rpcOnline = true;
    await context.setOffline(false);
    await page.evaluate(async () => {
      const { S } = await import('/js/store.js');
      await S.syncEngine.pullAndApply();
      if (S.syncStatus !== 'synced') throw new Error(S.syncStatus);
    });
    assert.deepEqual(await verify(page, 'rpc', rows.get(chunk)), expected(paidId));
    assert.deepEqual(await verify(page), expected(paidId));
    console.log('✓ PWA-UPGRADE: 2000 + 3000 оплачены ровно по одному разу локально и на RPC, остаток 7000 из 12000');
  });

  await scenario('backup-restore', async context => {
    const row = rows.get(chunk);
    const backupId = createHash('sha256').update('nagruzka-backup:' + chunk).digest('hex');
    const result = await saveSnapshots({ format: 1, count: 1, snapshots: [
      { ...row, backup_id: backupId, version: String(row.version) },
    ] }, dir);
    assert.deepEqual(result, { count: 1, rejected: 0 });
    const page = await open(context, origin);
    await loadKeyfile(page);
    const importResult = page.waitForEvent('dialog', d => d.type() === 'alert');
    page.on('dialog', async dialog => {
      await dialog.accept(dialog.type() === 'prompt' ? password : undefined);
    });
    await page.locator('#enc-import-file').setInputFiles(join(dir, 'snapshots', backupId + '.nz'));
    assert.match((await importResult).message(), /Импорт выполнен/);
    assert.deepEqual(await verify(page), expected(paidId));
    await page.close();
    const reopened = await open(context, origin);
    assert.deepEqual(await verify(reopened), expected(paidId));
    console.log('✓ BACKUP-RESTORE: рабочий backup.mjs → .nz → импорт с keyfile и паролем → повторный запуск: 2 платежа, даты и остаток 7000 подтверждены');
  });
} finally {
  await browser?.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
