// Проверка полноты списка прекэша сервис-воркера (sw.js → ASSETS).
// Ловит два класса ошибок, которые ломают ОФЛАЙН молча:
//   1) новый js-модуль не добавили в ASSETS → офлайн не подхватится, белый экран;
//   2) файл переименовали/удалили, а запись в ASSETS осталась → 404 при установке SW.
// Запуск: node tools/check-assets.mjs (из корня репозитория). Ненулевой код = провал.

import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';

const sw = await readFile('sw.js', 'utf8');
const m = sw.match(/const ASSETS\s*=\s*\[([\s\S]*?)\]/);
if (!m) { console.error('✖ Не нашёл массив ASSETS в sw.js'); process.exit(1); }

const assets = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
const norm = (p) => p.replace(/^\.\//, '');
const assetSet = new Set(assets.map(norm));

// 1) все js/**/*.js должны быть в ASSETS
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const jsFiles = await walk('js');
const missing = jsFiles.filter(f => !assetSet.has(f));

// 2) каждая запись ASSETS (кроме './') должна существовать на диске
const dangling = [];
for (const a of assets) {
  if (a === './' || a === '.') continue;
  try { await access(norm(a)); } catch { dangling.push(a); }
}

let ok = true;
if (missing.length) {
  ok = false;
  console.error('✖ js-файлы НЕ в ASSETS воркера (сломается офлайн):');
  for (const f of missing) console.error('   ' + f);
}
if (dangling.length) {
  ok = false;
  console.error('✖ записи ASSETS без файла на диске (404 при установке SW):');
  for (const a of dangling) console.error('   ' + a);
}

if (!ok) process.exit(1);
console.log(`✓ check-assets: все ${jsFiles.length} js-файлов в ASSETS, ${assets.length} записей existуют`);
