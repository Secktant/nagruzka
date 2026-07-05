// Чистые помощники форматирования и ключей — без DOM и без общего состояния.
// Вынесены из app.js для тестируемости (см. test/format.test.js) и переиспользования.

import { fmtPeriod } from './engine.js';

// Горизонт ленты: на сколько месяцев вперёд строим периоды.
export const HORIZON_MONTHS = 18;

// Единый источник «сегодня»: снимок на момент запуска приложения. Всё, что
// показывает/считает «текущее» (подсветка периода, горизонт, S.view), живёт этой
// датой до перезагрузки — иначе через полночь части UI разъезжаются между собой.
export const TODAY = new Date();

// Дата → 'YYYY-MM-DD' по ЛОКАЛЬНОМУ времени (периоды живут в локальной зоне пользователя).
const isoLocal = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function todayISO(today = TODAY) {
  return isoLocal(today);
}

// Последний день месяца через HORIZON_MONTHS — чтобы последний месяц был ПОЛНЫМ
// (иначе обрывались на 28-м и терялся период конца месяца, 31-е → месяц неполный в графике).
export function horizonEnd(today = TODAY, months = HORIZON_MONTHS) {
  const d = new Date(today.getFullYear(), today.getMonth() + months + 1, 0);
  return isoLocal(d);
}

// '2026-03-15' → '15 марта 2026'
export function fmtPeriodFull(p) {
  return `${fmtPeriod(p)} ${p.slice(0, 4)}`;
}

// Сдвиг ISO-даты на N дней. Через UTC-полночь, чтобы не поймать DST-сдвиг.
export function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Стабильный ключ платёжной строки: виртуальные — по источнику, реальные — по id записи.
export function payKey(p) {
  return p.virtual ? `v|${p.regularId || p.installmentId}` : `r|${p.id}`;
}

// Тип платежа → иконка-маркер (постоянный / из рассрочки / разовый / «мне должны»).
export function payTypeMark(p) {
  const owed = !p.regularId && !p.installmentId && p.amount < 0;  // дебиторка: разовый минус
  const m = owed ? ['owed', '🤝', 'Вам должны (вернётся)']
    : p.regularId ? ['reg', '🔁', 'Постоянный платёж']
    : p.installmentId ? ['inst', '💳', 'Платёж по рассрочке']
    : ['once', '💵', 'Разовый платёж'];
  return `<span class="pay-type ${m[0]}" title="${m[2]}" aria-label="${m[2]}">${m[1]}</span>`;
}

// Русская форма множественного числа: plural(n, 'день','дня','дней').
export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
