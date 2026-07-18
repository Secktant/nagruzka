# Тесты «Нагрузки»

Сетка безопасности вокруг чистого ядра. Изначально ставилась под распил монолита
`js/app.js` (уже выполнен); теперь пинует расчёты, крипто и локатор синка при любых
правках. Гоняется локально и в CI на каждый пуш/PR.

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
| `format.test.js` | `js/format.js` — чистые помощники | `todayISO`/`horizonEnd` (детерминизм через параметр даты), `fmtPeriodFull`, `payKey`, `payTypeMark`, `plural`; `addDays` — форма всегда, точные значения только под `TZ=UTC` (функция TZ-зависима, перенесена дословно) |
| `dom.test.js` | `js/dom.js` — примитивы UI | `esc`, `uid`, `parseMoney` (в т.ч. `''`/`null`→0), `fmtNumEditor`, `moneyInput` (то, что не требует DOM) |

Итого ~114 тестов. `$`/`$$`, модалка, `wireMoneyInputs`, IndexedDB, `SyncEngine`,
WebAuthn — DOM/браузерные, юнит-тестами не берутся (см. ниже).

## CI (`.github/workflows/ci.yml`)

На каждый пуш/PR job `ci` гоняет три проверки; деплой на Pages идёт `needs: ci`
(только push в `main`) — красный CI = деплоя нет.

1. **`node --test`** — юниты выше.
2. **`tools/check-assets.mjs`** — полнота `sw.js` ASSETS в обе стороны: каждый
   `js/**/*.js` есть в прекэше воркера, и нет висячих записей на несуществующий файл
   (иначе ломается офлайн).
3. **`tools/smoke.mjs`** — Playwright грузит приложение в headless Chromium, кликает
   4 вкладки, проверяет рендер и ноль ошибок консоли. Ловит класс, невидимый для
   `node --check` и юнитов: **рассинхрон `export`/`import` между модулями («белый
   экран»)**. Playwright — devDependency (`node_modules` в `.gitignore`), в прод-PWA
   не попадает.

Локально `npm run smoke` требует `npm install` (Playwright). `node --test` и
`check:assets` — без установки.

## Что НЕ покрыто (и почему)

Слои с IndexedDB / DOM / WebAuthn чистым Node не берутся. Поведение приложения
(рендер, формы, персистентность) проверяется **Playwright-смоуком в CI** и живой
проверкой в preview; при желании глубже — `fake-indexeddb` + `jsdom`, но крипту
**не мокать**.

- `js/db.js` — операции IndexedDB, `saveVault`/`loadVault`
- `js/sync.js` — `SyncEngine` (сеть + разрешение конфликта версий)
- `js/lock.js` — замок Face/Touch ID (WebAuthn PRF)
- `js/app.js` + `js/views/*` — рендер, обработчики, формы (частично покрыты boot-смоуком)
