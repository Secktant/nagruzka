// Браузерная регрессия синка: настоящие IndexedDB/AES-GCM/Argon2, синтетический RPC.
// Запуск из корня: node tools/sync-smoke.mjs (нужны Playwright и Chromium).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';

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
const rows = new Map(), metas = new Map(), devices = [];
const SYNC_ID = 'c3ludGhldGljLXFhLW9ubHktbm8tcmVhbC1hY2NvdW4';
const PASSWORD = 'synthetic-browser-test-password';
const state = id => ({
  settings: { salary: 100000, banks: ['Тестовый банк'], startPeriod: '2026-01-15' },
  regulars: [], installments: [], history: [],
  records: [{ id, name: id, period: '2026-11-15', amount: 100, paid: false, bank: 'Тестовый банк' }],
});
let browser;
const pageErrors = [];

async function attach(page) {
  await page.waitForFunction(() => document.querySelector('#periods .card'));
  await page.evaluate(async () => {
    const store = await import('/js/store.js');
    window.qa = { ...store, db: await import('/js/db.js'), crypto: await import('/js/crypto.js'),
      sync: await import('/js/sync.js'), ui: await import('/js/sync-ui.js') };
  });
}
async function device(id = 'base') {
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  const d = { context, offline: false, calls: [] }; devices.push(d);
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) { await route.continue(); return; }
    // Любая внешняя сеть заблокирована; RPC исполняется только этим mock.
    if (!url.pathname.startsWith('/rest/v1/rpc/')) { await route.abort(); return; }
    const fn = url.pathname.split('/').pop(), body = request.postDataJSON();
    d.calls.push(fn);
    if (d.offline) { await route.abort('internetdisconnected'); return; }
    let result;
    if (fn === 'sync_meta_get') result = metas.get(body.p_id) || null;
    else if (fn === 'sync_meta_init') {
      if (!metas.has(body.p_id)) metas.set(body.p_id, body.p_salt);
      result = metas.get(body.p_id);
    } else if (fn === 'sync_pull') result = rows.has(body.p_id) ? [rows.get(body.p_id)] : [];
    else if (fn === 'sync_push') {
      const prior = rows.get(body.p_id), version = prior?.version || 0;
      if (body.p_base_version !== version) result = [{ ok: false, ...prior }];
      else {
        const row = { salt: body.p_salt, blob: body.p_blob, version: version + 1,
          updated_at: new Date().toISOString() };
        rows.set(body.p_id, row); result = [{ ok: true, version: row.version }];
      }
    } else throw new Error('Unexpected RPC: ' + fn);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  d.page = await context.newPage();
  d.page.on('pageerror', error => pageErrors.push(error.message));
  await d.page.goto(origin); await attach(d.page);
  await d.page.evaluate(async ({ initial, syncId, pass }) => {
    const { S, db, saveAll } = qa;
    S.state = initial; await saveAll();
    await db.setSyncId(S.db, syncId);
    await S.syncEngine.unlock(syncId, pass);
    await S.syncEngine.start();
    await S.syncEngine.pullAndApply();
  }, { initial: state(id), syncId: SYNC_ID, pass: PASSWORD });
  assert.equal(await status(d), 'synced');
  return d;
}
const status = d => d.page.evaluate(() => qa.S.syncStatus);
const localId = d => d.page.evaluate(() => qa.S.state.records[0]?.id);
const sync = d => d.page.evaluate(() => qa.S.syncEngine.pullAndApply());
const push = d => d.page.evaluate(() => qa.S.syncEngine.pushNow());
const edit = (d, id) => d.page.evaluate(async value => {
  qa.S.state.records[0].id = value; qa.S.state.records[0].name = value;
  await qa.saveAll();
}, id);
async function reload(d) { await d.page.reload(); await attach(d.page); }
async function diskId(d) {
  return d.page.evaluate(async () => (await qa.db.loadVault(qa.S.db, qa.S.vaultKey)).records[0]?.id);
}
async function remoteId(d) {
  const chunk = await d.page.evaluate(() => qa.S.syncEngine.chunkId);
  return d.page.evaluate(async row => JSON.parse(await qa.crypto.openGCM(
    qa.S.syncEngine.key, qa.crypto.b64.dec(row.blob), qa.sync.AAD_MAIN)).records[0]?.id, rows.get(chunk));
}
async function settingsUI(d) {
  await d.page.evaluate(async () => {
    qa.S.view.tab = 'settings';
    (await import('/js/render.js')).render();
    await (await import('/js/views/settings.js')).renderSettings();
  });
}
async function assertConflictButtonHidden(d) {
  await settingsUI(d);
  const button = d.page.locator('#sync-conflict');
  const css = await button.evaluate(el => ({ hidden: el.hidden, display: getComputedStyle(el).display }));
  assert.equal(await button.isVisible(), false, `No conflict: button must be invisible; ${JSON.stringify(css)}`);
}
async function conflictUI(d) {
  await settingsUI(d);
  await d.page.locator('#sync-conflict').click();
  await d.page.locator('#conflict-local').waitFor();
}
async function downloadCopy(d, side) {
  const downloading = d.page.waitForEvent('download');
  await d.page.locator('#conflict-download-' + side).click();
  const download = await downloading;
  assert.equal(download.suggestedFilename(), `nagruzka-conflict-${side}.nz`);
  const bytes = [...await readFile(await download.path())];
  return d.page.evaluate(async ({ bytes, password }) => JSON.parse(await qa.crypto.decryptToText(
    new Uint8Array(bytes), password, null)).records[0]?.id, { bytes, password: PASSWORD });
}

try {
  browser = await chromium.launch();
  const a = await device();
  await assertConflictButtonHidden(a);
  a.offline = true; await edit(a, 'offline-edit'); await push(a);
  assert.equal(await status(a), 'offline'); assert.equal(await diskId(a), 'offline-edit');
  await reload(a); assert.equal(await localId(a), 'offline-edit');
  a.offline = false; await sync(a);
  assert.equal(await localId(a), 'offline-edit'); assert.equal(await remoteId(a), 'offline-edit');
  assert.equal(await status(a), 'synced');
  console.log('✓ offline edit → IndexedDB → reload → old server: local edit survives and is uploaded');

  const b = await device('offline-edit');
  a.offline = true; await edit(a, 'device-a'); await push(a);
  await edit(b, 'device-b'); await push(b);
  a.offline = false; await sync(a);
  assert.equal(await status(a), 'conflict'); assert.equal(await localId(a), 'device-a');
  await reload(a);
  const copies = await a.page.evaluate(async () => {
    const copies = await qa.S.syncEngine.getConflictCopies();
    return { local: JSON.parse(copies.local).records[0].id, remote: JSON.parse(copies.remote).records[0].id };
  });
  assert.deepEqual(copies, { local: 'device-a', remote: 'device-b' });
  assert.equal(await status(a), 'conflict');
  await conflictUI(a);
  assert.equal(await downloadCopy(a, 'local'), 'device-a');
  assert.equal(await downloadCopy(a, 'remote'), 'device-b');
  await a.page.locator('#conflict-remote').click();
  await a.page.waitForFunction(() => qa.S.syncStatus === 'synced');
  assert.equal(await localId(a), 'device-b'); assert.equal(await diskId(a), 'device-b');
  await assertConflictButtonHidden(a);
  console.log('✓ two devices → conflict → reload: both copies survive, .nz downloads decrypt, explicit remote choice succeeds');

  a.offline = true; await edit(a, 'keep-local'); await push(a);
  await edit(b, 'second-remote'); await push(b); a.offline = false; await sync(a);
  await conflictUI(a);
  await edit(b, 'third-remote'); await push(b);
  await a.page.locator('#conflict-local').click();
  await a.page.waitForFunction(() => qa.S.syncEngine.conflict && !document.querySelector('#conflict-local')?.disabled);
  assert.equal(await downloadCopy(a, 'remote'), 'third-remote', 'a newer conflict must refresh the visible/downloadable copy before another choice');
  assert.equal(await remoteId(a), 'third-remote');
  await a.page.locator('#conflict-local').click();
  await a.page.waitForFunction(() => qa.S.syncStatus === 'synced');
  assert.equal(await remoteId(a), 'keep-local');
  await assertConflictButtonHidden(a);
  console.log('✓ stale conflict dialog refreshes the new remote .nz; a repeated explicit local choice succeeds');

  // Отключение проверяется кнопкой, затем полным reload с восстановлением ключа.
  await a.page.evaluate(async () => {
    qa.S.view.tab = 'settings'; (await import('/js/render.js')).render();
    await (await import('/js/views/settings.js')).renderSettings();
  });
  await a.page.locator('#sync-off').click();
  await a.page.waitForFunction(() => qa.S.syncStatus === 'off');
  await edit(a, 'disabled-edit');
  const before = a.calls.length; await reload(a);
  await a.page.evaluate(async () => {
    await qa.S.syncEngine.pushNow(); await qa.S.syncEngine.pullAndApply();
    window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online'));
  });
  await a.page.waitForTimeout(1700);
  assert.equal(a.calls.length, before); assert.equal(await localId(a), 'disabled-edit');
  assert.equal(await diskId(a), 'disabled-edit');
  assert.equal(await a.page.evaluate(() => qa.db.hasVault(qa.S.db)), true);
  console.log('✓ off → edit → reload: no RPC, encrypted local edit preserved');

  // Ошибочная разблокировка не должна заменить ключ или включить отправку.
  const wrong = await a.page.evaluate(async ({ id, password }) => {
    const key = qa.S.vaultKey;
    try { await qa.S.syncEngine.unlock(id, password); return { rejected: false }; }
    catch { return { rejected: true, sameKey: qa.S.vaultKey === key, enabled: qa.S.syncEngine.enabled }; }
  }, { id: SYNC_ID, password: 'deliberately-wrong-synthetic-password' });
  assert.deepEqual(wrong, { rejected: true, sameKey: true, enabled: false });
  assert.equal(await diskId(a), 'disabled-edit');
  await a.page.evaluate(async ({ id, password }) => {
    await qa.S.syncEngine.unlock(id, password); await qa.S.syncEngine.start(); await qa.S.syncEngine.pullAndApply();
  }, { id: SYNC_ID, password: PASSWORD });
  assert.equal(await status(a), 'synced');
  console.log('✓ wrong password leaves working local key and vault unchanged; correct password reconnects');

  // Реальный отказ IDB.put во время применения удалённой версии.
  await sync(b); await edit(b, 'after-disk-recovery'); await push(b);
  const beforeFailure = await a.page.evaluate(() => qa.S.syncEngine.version);
  const failed = await a.page.evaluate(async () => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.name === 'kv' && key === 'vault') throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
      return put.apply(this, arguments);
    };
    try { await qa.S.syncEngine.pullAndApply(); }
    finally { IDBObjectStore.prototype.put = put; }
    return { version: qa.S.syncEngine.version, status: qa.S.syncStatus, id: qa.S.state.records[0].id };
  });
  assert.equal(failed.version, beforeFailure); assert.equal(failed.status, 'storage-error');
  assert.equal(failed.id, 'disabled-edit'); assert.equal(await diskId(a), 'disabled-edit');
  await sync(a);
  assert.equal(await status(a), 'synced', 'recoverable IDB failure must allow a later pull to retry');
  assert.equal(await localId(a), 'after-disk-recovery');
  assert.equal(await diskId(a), 'after-disk-recovery');
  console.log('✓ IDB failure leaves version and both local copies intact; retry after recovery succeeds');

  // Импорт шифруется асинхронно: правка, сделанная за это время, должна оставаться
  // и в памяти, и на диске. Иначе следующий push отправит устаревшую память.
  const racingImport = await a.page.evaluate(async () => {
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const began = new Promise(resolve => { entered = resolve; });
    let first = true;
    crypto.subtle.encrypt = async (...args) => {
      if (first) { first = false; entered(); await gate; }
      return encrypt(...args);
    };
    try {
      const candidate = structuredClone(qa.S.state); candidate.records[0].id = 'import-candidate';
      const importing = qa.adoptStateJSON(qa.db.exportState(candidate)).then(() => false, () => true);
      await began;
      qa.S.state.records[0].id = 'edited-during-import';
      const saving = qa.saveAll();
      release(); const [cancelled] = await Promise.all([importing, saving]);
      return { cancelled, memory: qa.S.state.records[0].id,
        disk: (await qa.db.loadVault(qa.S.db, qa.S.vaultKey)).records[0].id };
    } finally { release(); crypto.subtle.encrypt = encrypt; }
  });
  assert.deepEqual(racingImport, { cancelled: true, memory: 'edited-during-import', disk: 'edited-during-import' });
  await sync(a); assert.equal(await remoteId(a), 'edited-during-import');
  console.log('✓ local edit during import encryption stays consistent in memory, IndexedDB and server');

  await a.page.evaluate(() => qa.S.syncEngine.changePassword('synthetic-new-password'));
  await reload(a); await sync(a);
  assert.equal(await status(a), 'synced'); assert.equal(await remoteId(a), 'edited-during-import');
  console.log('✓ password change persists vault/key atomically and survives reload');
  assert.deepEqual(pageErrors, [], 'uncaught page errors');
} finally {
  for (const d of devices) await d.context.close().catch(() => {});
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
