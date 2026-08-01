// Рельс года: индекс всех периодов выбранного года слева от «Периодов»
// (на узком экране — полосой сверху, см. #year-rail в style.css). Строка =
// месяц, столбик = период; клик по строке открывает месяц справа.
//
// Почему столбики строятся из S.timeline, а не из monthlyLoads(): monthlyLoads
// схлопывает месяц в одно число, а рельсу нужны отдельные периоды. Столбиков
// рисуется СТОЛЬКО, СКОЛЬКО периодов в месяце, — допущение «15-е + конец
// месяца» сюда не зашито (пункт 9 роадмапа его меняет).

import { S } from '../store.js';
import { $ } from '../dom.js';
import { icon } from '../icons.js';
import { fmtPeriod } from '../engine.js';

const MONTHS_SHORT = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн',
  'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

// Высота столбика: доля от 100% нагрузки. Перегруз обрезаем — столбик и так
// уже во всю высоту, а «насколько именно» говорит цвет и сама карточка.
const barPct = load => (load == null ? 0 : Math.min(1, load) * 100);

// [{ m, days: [dayEntry…] }] за выбранный год, все 12 месяцев (пустые тоже:
// рельс — календарь, в нём не должно быть дыр там, где просто нет платежей).
function monthsOfYear(year) {
  const out = Array.from({ length: 12 }, (_, i) => ({ m: i + 1, days: [] }));
  for (const d of S.timeline.values()) {
    if (Number(d.period.slice(0, 4)) !== year) continue;
    out[Number(d.period.slice(5, 7)) - 1].days.push(d);
  }
  return out;
}

export function renderRail() {
  const el = $('#year-rail');
  if (!el) return;
  const year = S.view.y;
  const rows = monthsOfYear(year).map(({ m, days }) => {
    const on = m === S.view.m;
    const bars = days.map(d => {
      const z = d.zone?.key || 'none';
      return `<span class="rb zone-${z}" style="height:${barPct(d.load)}%" title="${fmtPeriod(d.period)}"></span>`;
    }).join('') || '<span class="rb zone-none" style="height:0"></span>';
    return `<button type="button" class="rail-row${on ? ' on' : ''}" data-rail-month="${m}"
      aria-current="${on ? 'true' : 'false'}">
      <span class="rr-name">${MONTHS_SHORT[m - 1]}</span>
      <span class="rr-bars">${bars}</span>
    </button>`;
  }).join('');

  el.innerHTML = `
    <div class="rail-head">
      <button type="button" class="rail-arrow" data-rail-year="-1" aria-label="Предыдущий год">${icon('chevronLeft')}</button>
      <span class="rail-year">${year}</span>
      <button type="button" class="rail-arrow" data-rail-year="1" aria-label="Следующий год">${icon('chevronRight')}</button>
    </div>
    <div class="rail-rows">${rows}</div>`;
}

// Обработчики вешаются один раз на контейнер: рельс перерисовывается на каждый
// render(), и переподписка на каждую строку была бы лишней работой.
export function wireRail(onPick) {
  const el = $('#year-rail');
  if (!el) return;
  el.addEventListener('click', e => {
    const row = e.target.closest('[data-rail-month]');
    if (row) return onPick(S.view.y, Number(row.dataset.railMonth));
    const arrow = e.target.closest('[data-rail-year]');
    if (arrow) onPick(S.view.y + Number(arrow.dataset.railYear), S.view.m);
  });
}
