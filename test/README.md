# Тесты «Нагрузки»

Сетка безопасности под разрезку монолита `js/app.js`. Пока зелёные — поведение
ядра (расчёты, крипто, локатор синка) не поехало при рефакторинге.

## Запуск

Из каталога `app/`:

```sh
npm test          # = node --test
node --test       # то же самое
```

Требуется только Node ≥ 20 (используется встроенный `node:test`). Зависимостей нет,
`npm install` не нужен. `crypto.subtle` берётся из глобального WebCrypto Node,
Argon2 поднимается из `js/vendor/argon2.umd.min.js` (как в браузере через `<script>`).

`package.json` рядом нужен только для `"type": "module"` (чтобы Node грузил `.js`
как ES-модули — ровно так же их видит браузер). Браузер `package.json` игнорирует,
на PWA он не влияет.

## Что покрыто

| Файл | Слой | Покрытие |
|------|------|----------|
| `engine.test.js` | `js/engine.js` — чистые расчёты | все экспорты: периоды, `buildTimeline` (регулярные, `skipped`, `since`, mid/end, авто-хвост и план рассрочки, `perBank`, `carry`, `instProgress`), `installmentSummaries`, границы `loadZone`, форматтеры чисел/дат |
| `crypto.test.js` | `js/crypto.js` — шифрование | Argon2id-деривация (детерминизм + keyfile как второй фактор), файловый цикл `.nz` (`encrypt`/`decrypt` + неверный пароль), `sealGCM`/`openGCM` + привязка к чанку через AAD, `inspect` |
| `sync.test.js` | `js/sync.js`, `js/db.js` | `deriveChunkId` (кросс-сверка с `node:crypto` — инвариант «id ячейки байт-в-байт как в бэкап-Action»), `isValidSyncId`, base64url, `exportState` |

## Что НЕ покрыто (и почему)

Слои с IndexedDB / DOM / WebAuthn чистым Node не берутся. Тестировать их лучше
**Playwright поверх preview** (реальный браузер, реальная крипта/WebAuthn) либо
`fake-indexeddb` + `jsdom` — но крипту при этом **не мокать**.

- `js/db.js` — операции IndexedDB, `importState`, `saveVault`/`loadVault`
- `js/sync.js` — `SyncEngine` (сеть + разрешение конфликта версий)
- `js/lock.js` — замок Face/Touch ID (WebAuthn PRF)
- `js/app.js` — рендер и обработчики
