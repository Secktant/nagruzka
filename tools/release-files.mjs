import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cacheLine = /^const CACHE = 'nagruzka-(\d+\.\d+\.\d+)';$/gm;
function cacheInfo(sw) {
  const matches = [...sw.matchAll(cacheLine)];
  if (matches.length !== 1) throw new Error('Ожидается одно объявление CACHE');
  return { version: matches[0][1], normalized: sw.replace(cacheLine, 'const CACHE = VERSION;') };
}
function newer(version, previous) {
  const before = previous.split('.').map(BigInt);
  const after = version.split('.').map(BigInt);
  const i = after.findIndex((part, index) => part !== before[index]);
  return i >= 0 && after[i] > before[i];
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function files(dir, prefix = '') {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix + entry.name;
    if (entry.name.startsWith('.')) throw new Error('Скрытый файл в каталоге публикации: ' + path);
    if (entry.isDirectory()) return files(dir, path + '/');
    if (!entry.isFile()) throw new Error('Недопустимый тип файла ' + path);
    return [[path, digest(readFileSync(join(dir, path)))]];
  });
}
export function manifest(dir, sha, run, attempt) {
  const sw = readFileSync(join(dir, 'sw.js'), 'utf8');
  return { sha, run, attempt, version: cacheInfo(sw).version, files: Object.fromEntries(files(dir)) };
}
export function compare(candidate, release, oldSW, newSW) {
  for (const [record, sw] of [[candidate, oldSW], [release, newSW]]) {
    if (digest(sw) !== record.files['sw.js'] || cacheInfo(sw).version !== record.version)
      throw new Error('Исходный sw.js не соответствует манифесту');
  }
  for (const path of new Set([...Object.keys(candidate.files), ...Object.keys(release.files)])) {
    if (candidate.files[path] === release.files[path]) continue;
    if (path === 'sw.js' && cacheInfo(oldSW).normalized === cacheInfo(newSW).normalized
      && newer(release.version, candidate.version)) continue;
    throw new Error('Изменился файл или состав публикации: ' + path);
  }
}
export function verify(dir, proof, run, expectedSHA, attempt) {
  const candidate = JSON.parse(readFileSync(join(proof, 'manifest.json'), 'utf8'));
  if (!run || !expectedSHA || !attempt || candidate.run !== run || candidate.sha !== expectedSHA || candidate.attempt !== attempt)
    throw new Error('Манифест не принадлежит одобренному запуску');
  const release = manifest(dir, process.env.GITHUB_SHA, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT);
  compare(candidate, release, readFileSync(join(proof,'sw.js'),'utf8'), readFileSync(join(dir,'sw.js'),'utf8'));
  console.log('Совпадают файлы кандидата и релиза:', candidate.sha, release.sha, candidate.version, release.version);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, dir, proof, run, sha, attempt] = process.argv.slice(2);
  if (command === 'prepare') {
    mkdirSync(dir); mkdirSync(proof);
    for (const file of ['index.html','style.css','manifest.webmanifest','sw.js','js','icons']) {
      cpSync(file, join(dir,file), {recursive:true});
    }
    const record = manifest(dir, process.env.GITHUB_SHA, process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT);
    writeFileSync(join(proof,'manifest.json'), JSON.stringify(record,null,2));
    cpSync(join(dir,'sw.js'),join(proof,'sw.js'));
    console.log('Pages:', record.sha, record.version, record.run, record.attempt);
  } else if (command === 'verify') verify(dir, proof, run, sha, attempt);
  else throw new Error('Ожидается prepare или verify');
}
