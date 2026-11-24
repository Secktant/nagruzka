import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest, compare, verify } from '../tools/release-files.mjs';

test('Публикация принимает только тот же сайт или смену CACHE', t => {
  const dir = mkdtempSync(join(tmpdir(), 'release-files-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const write = (file, text) => writeFileSync(join(dir,file),text);
  const sw = "const CACHE = 'nagruzka-1.2.3';\nself.skipWaiting();";
  write('index.html','site'); write('sw.js',sw);
  const candidate = manifest(dir,'candidate','12','1');
  function check(nextSW) {
    write('sw.js',nextSW);
    compare(candidate,manifest(dir,'main','13','1'),sw,nextSW);
  }
  check(sw);
  check(sw.replace('1.2.3','1.2.4'));
  assert.throws(() => check(sw.replace('1.2.3','1.2.2')),/sw.js/);
  assert.throws(() => check(sw+'\n// other code'),/sw.js/);
  write('extra','new'); assert.throws(() => check(sw),/extra/); rmSync(join(dir,'extra'));
  write('index.html','changed'); assert.throws(() => check(sw),/index.html/);
  rmSync(join(dir,'index.html')); assert.throws(() => check(sw),/index.html/);
  assert.throws(() => verify(dir,dir,'12','candidate','1'),/manifest.json/);
  write('manifest.json',JSON.stringify(candidate));
  assert.throws(() => verify(dir,dir,'99','candidate','1'),/запуску/);
});
