import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length > 2_000_000) {
    throw new Error('Некорректный размер шифроснимка');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Некорректный base64');
  return bytes;
}

export function prepareSnapshots(data) {
  if (data?.format !== 1 || !Array.isArray(data.snapshots)
      || data.count !== data.snapshots.length || data.count === 0) {
    throw new Error('Пустая или неполная выгрузка: бэкап остановлен');
  }
  const ids = new Set();
  return data.snapshots.map(row => {
    if (!row || typeof row.backup_id !== 'string' || !/^[a-f0-9]{64}$/.test(row.backup_id) || ids.has(row.backup_id)) {
      throw new Error('Некорректный или повторный идентификатор бэкапа');
    }
    ids.add(row.backup_id);
    if (typeof row.version !== 'string' || !/^[1-9][0-9]*$/.test(row.version)
        || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) {
      throw new Error('Некорректная версия или дата снимка');
    }
    if (typeof row.salt !== 'string' || typeof row.blob !== 'string') {
      throw new Error('Некорректная структура шифроснимка');
    }
    let nz = null;
    try {
      const salt = decodeBase64(row.salt), blob = decodeBase64(row.blob);
      if (salt.length === 16 && blob.length >= 28) {
        // Как в прежнем workflow: flags=1 — подсказка для импорта с keyfile.
        nz = Buffer.concat([Buffer.from('NZENC1'), Buffer.from([1]), salt, blob]);
      }
    } catch {
      // Старые тестовые строки тоже архивируем, сохраняя последние пригодные .nz.
    }
    const metadata = {
      backup_id: row.backup_id,
      version: row.version,
      updated_at: new Date(row.updated_at).toISOString(),
      restorable: nz !== null,
    };
    return {
      metadata,
      json: JSON.stringify({ ...metadata, salt: row.salt, blob: row.blob }, null, 2) + '\n',
      nz,
    };
  }).sort((a, b) => a.metadata.backup_id.localeCompare(b.metadata.backup_id));
}

export async function saveSnapshots(data, directory) {
  // Проверить ВСЮ выгрузку до первого изменения файлов.
  const snapshots = prepareSnapshots(data);
  await mkdir(directory, { recursive: true });
  async function replaceFile(file, content) {
    const temporary = file + '.tmp';
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, file);
  }
  for (const snapshot of snapshots) {
    const target = join(directory, snapshot.nz ? 'snapshots' : 'rejected');
    await mkdir(target, { recursive: true });
    const name = join(target, snapshot.metadata.backup_id);
    await replaceFile(name + '.json', snapshot.json);
    if (snapshot.nz) await replaceFile(name + '.nz', snapshot.nz);
  }
  // Индекс описывает текущую БД. Прежние файлы сохраняются, даже если строка удалена.
  await replaceFile(join(directory, 'index.json'), JSON.stringify({
    format: 1, snapshots: snapshots.map(snapshot => snapshot.metadata),
  }, null, 2) + '\n');
  return { count: snapshots.length, rejected: snapshots.filter(snapshot => !snapshot.nz).length };
}

export async function fetchSnapshots({ url, anon, token }, request = fetch) {
  if (!url || !anon || !/^[a-f0-9]{64}$/.test(token || '')) {
    throw new Error('Не заданы SUPABASE_URL, SUPABASE_ANON или BACKUP_TOKEN');
  }
  const endpoint = new URL('/rest/v1/rpc/backup_export', url);
  if (endpoint.protocol !== 'https:') throw new Error('Для бэкапа требуется HTTPS');
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await request(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_token: token }),
      });
      if (response.ok) {
        const data = await response.json();
        prepareSnapshots(data);
        return data;
      }
      if (response.status < 500 && response.status !== 429) break;
      await response.body?.cancel();
    } catch {
      // Ответ и исходную ошибку не печатаем: они могут содержать секреты/снимки.
    }
    if (attempt < 2) await delay(5000);
  }
  throw new Error('Выгрузка Supabase не получена или не прошла проверку');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const data = await fetchSnapshots({
      url: process.env.SUPABASE_URL, anon: process.env.SUPABASE_ANON, token: process.env.BACKUP_TOKEN,
    });
    const result = await saveSnapshots(data, resolve('backups'));
    console.log(`Заархивировано строк: ${result.count}`);
    if (result.rejected) {
      console.warn(`::warning::Строк с некорректным форматом: ${result.rejected}. Сохранены отдельно в rejected; проверь index.json.`);
    }
  } catch {
    console.error('Бэкап остановлен. Проверь доступ, наличие снимков и их формат.');
    process.exitCode = 1;
  }
}
