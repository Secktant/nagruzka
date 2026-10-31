// Локальный технический журнал. Не записывать пользовательские данные, Sync ID,
// ключи, содержимое записей или сетевые тела. Храним только последние 500 событий.
const KEY = 'nagruzka:diagnostic-log';
const LIMIT = 500;

function read() {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

export function logEvent(event, details = {}) {
  try {
    const safe = {};
    for (const key of ['stage', 'status', 'code', 'errorName', 'durationMs', 'version']) {
      const value = details[key];
      if (typeof value === 'string' || typeof value === 'number') safe[key] = String(value).slice(0, 100);
    }
    const rows = read();
    rows.push({
      time: new Date().toISOString(),
      event: String(event).replace(/[^a-z0-9_.-]/gi, '_').slice(0, 64),
      details: safe,
    });
    localStorage.setItem(KEY, JSON.stringify(rows.slice(-LIMIT)));
  } catch { /* журнал не должен мешать работе приложения */ }
}

export function getLogEntries() { return read(); }
export function clearLog() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
export function exportLog() {
  const ua = navigator.userAgent || 'unknown';
  const cacheVersion = [...(document.documentElement.dataset.appVersion ? [document.documentElement.dataset.appVersion] : [])][0] || 'см. в настройках';
  return [
    'НАГРУЗКА — ЖУРНАЛ ДИАГНОСТИКИ',
    'Сформирован: ' + new Date().toISOString(),
    'Версия: ' + cacheVersion,
    'Платформа: ' + ua.slice(0, 240),
    'Онлайн: ' + (navigator.onLine ? 'да' : 'нет'),
    '',
    ...read().map(row => row.time + '  ' + row.event +
      (Object.keys(row.details || {}).length ? '  ' + JSON.stringify(row.details) : '')),
  ].join('\\n');
}
