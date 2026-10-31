// Локальный технический журнал. Не записывать пользовательские данные, Sync ID,
// ключи, содержимое записей или сетевые тела. Храним только последние 500 событий.
const KEY = 'nagruzka:diagnostic-log';
const LIMIT = 500;
const QUOTA_LIMIT = 50;
const FLUSH_DELAY = 400;

let cache;
let flushTimer = null;

function readDisk() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value.slice(-LIMIT) : [];
  } catch { return []; }
}

function read() {
  if (!cache) cache = readDisk();
  return cache;
}

function flush() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!cache) return;
  const serialized = JSON.stringify(cache.slice(-LIMIT));
  try {
    localStorage.setItem(KEY, serialized);
    return;
  } catch (err) {
    // При исчерпании квоты освобождаем место за счёт старой диагностики.
    // События остаются в памяти даже если повторная запись не удастся.
    if (err?.name !== 'QuotaExceededError' && err?.name !== 'NS_ERROR_DOM_QUOTA_REACHED') return;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(cache.slice(-QUOTA_LIMIT)));
  } catch { /* журнал не должен мешать работе приложения */ }
}

function scheduleFlush() {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FLUSH_DELAY);
}

export function logEvent(event, details = {}) {
  try {
    const safe = {};
    for (const key of ['stage', 'status', 'code', 'errorName', 'durationMs', 'version']) {
      const value = details[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        safe[key] = String(value).slice(0, 100);
      }
    }
    const rows = read();
    rows.push({
      time: new Date().toISOString(),
      event: String(event).replace(/[^a-z0-9_.-]/gi, '_').slice(0, 64),
      details: safe,
    });
    if (rows.length > LIMIT) rows.splice(0, rows.length - LIMIT);
    scheduleFlush();
  } catch { /* журнал не должен мешать работе приложения */ }
}

export function getLogEntries() { return read().slice(); }

export function clearLog() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  cache = [];
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function exportLog() {
  const ua = navigator.userAgent || 'unknown';
  const cacheVersion = document.querySelector('#app-version')?.textContent || 'см. в настройках';
  const header = [
    'НАГРУЗКА — ЖУРНАЛ ДИАГНОСТИКИ',
    'Сформирован: ' + new Date().toISOString(),
    'Версия: ' + cacheVersion,
    'Платформа: ' + ua.slice(0, 240),
    'Онлайн: ' + (navigator.onLine ? 'да' : 'нет'),
    '',
  ];
  const lines = read().map(row => row.time + '  ' + row.event +
    (Object.keys(row.details || {}).length ? '  ' + JSON.stringify(row.details) : ''));
  return header.concat(lines).join('\\n');
}

// pagehide — последняя страховка для PWA/Safari при уходе со страницы.
// localStorage синхронный, поэтому здесь flush может завершиться до закрытия.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flush);
}
