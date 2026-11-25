# Тесты «Нагрузки»

Сетка безопасности вокруг чистого ядра. Изначально ставилась под распил монолита
`js/app.js` (уже выполнен); теперь пинует расчёты, крипто и локатор синка при любых
правках. Гоняется локально и в CI при push в main, PR и ручном запуске.

## Запуск

Из каталога `app/`:

```sh
npm test          # = node --test
node --test       # то же самое
```

Требуется Node ≥ 20 (встроенный `node:test`). Юнит-тесты зависимостей НЕ требуют
(`npm install` не нужен для `node --test`): `crypto.subtle` — из глобального WebCrypto
Node, Argon2 поднимается из `js/vendor/argon2.umd.min.js` (как в браузере через `<script>`).

`package.json` рядом даёт `"type": "module"` (Node грузит `.js` как ES-модули — так же
их видит браузер) + скрипты. Браузер `package.json` игнорирует, на PWA не влияет.

## Что покрыто (юнит, `node --test`)

| Файл | Слой | Покрытие |
|------|------|----------|
| `engine.test.js` | `js/engine.js` — чистые расчёты | все экспорты: периоды, `buildTimeline` (регулярные, `skipped`, `since`, mid/end, авто-хвост и план рассрочки, `perBank`, `carry`, `instProgress`), `installmentSummaries`, границы `loadZone`, форматтеры чисел/дат |
| `crypto.test.js` | `js/crypto.js` — шифрование | Argon2id-деривация (детерминизм + keyfile как второй фактор), файловый цикл `.nz` (`encrypt`/`decrypt` + неверный пароль), `sealGCM`/`openGCM` + привязка к чанку через AAD, `inspect` |
| `sync.test.js` | `js/sync.js`, `js/db.js` | `deriveChunkId` (кросс-сверка с `node:crypto` — инвариант «id ячейки байт-в-байт как в бэкап-Action»), `isValidSyncId`, base64url, `exportState` |
| `sync-engine.test.js` | `SyncEngine` | офлайн/перезапуск, конфликты, гонки, повтор после ошибки, остановка, смена ключа; сеть подменена, криптография настоящая |
| `format.test.js` | `js/format.js` — чистые помощники | `todayISO`/`horizonEnd` (детерминизм через параметр даты), `fmtPeriodFull`, `payKey`, `payTypeMark`, `plural`; `addDays` — форма всегда, точные значения только под `TZ=UTC` (функция TZ-зависима, перенесена дословно) |
| `dom.test.js` | `js/dom.js` — примитивы UI | `esc`, `uid`, `parseMoney` (в т.ч. `''`/`null`→0), `fmtNumEditor`, `moneyInput` (то, что не требует DOM) |

IndexedDB и интерфейс конфликта дополнительно проверяются браузерным сценарием
`npm run smoke:sync`: изолированные профили, синтетические платежи, подменённый RPC,
настоящие AES-GCM и Argon2. Он входит в CI и не обращается к боевому Supabase.

## Проверки кандидата

Команды, обязательные сценарии и трассы описаны в [регрессе QA](../docs/QA.md),
условия публикации — в [порядке выпуска](../docs/DEPLOY.md).
