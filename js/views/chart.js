// Вкладка «График»: остаток с переносом (линия), нагрузка по месяцам и по годам
// (столбцы). Читает S.timeline/S.view.chartYear, ничего не мутирует кроме chartYear
// (навигация по годам перерисовывает только этот экран).

import { S } from '../store.js';
import { $ } from '../dom.js';
import { monthlyLoads, yearlyLoads, fmtMoney, fmtMonth } from '../engine.js';
import { todayISO, fmtPeriodFull } from '../format.js';

const MON3 = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

export function renderChart() {
  const today = todayISO();
  const all = [...S.timeline.values()];
  const from = all.findIndex(d => d.period >= today);
  const data = all.slice(Math.max(0, from - 2), Math.max(0, from - 2) + 26); // ~год вперёд

  if (!data.length) { $('#view-chart').innerHTML = '<div class="empty">Нет данных</div>'; return; }

  const W = 800, H = 300, PL = 56, PR = 16, PT = 18, PB = 46;
  const xs = i => PL + i * (W - PL - PR) / Math.max(1, data.length - 1);
  const vals = data.map(d => d.carry);
  const lo = Math.min(0, ...vals), hi = Math.max(...vals) * 1.06 || 1;
  const ys = v => PT + (hi - v) * (H - PT - PB) / (hi - lo || 1);

  const pts = data.map((d, i) => `${xs(i).toFixed(1)},${ys(d.carry).toFixed(1)}`).join(' ');
  const area = `${PL},${ys(0)} ${pts} ${xs(data.length - 1)},${ys(0)}`;
  const minIdx = vals.indexOf(Math.min(...vals.slice(2)));
  const k = v => Math.abs(v) >= 1000 ? Math.round(v / 1000) + ' к' : Math.round(v);

  const monthLabels = data.map((d, i) => {
    if (!d.period.endsWith('-15')) return '';
    const [y, m] = d.period.split('-');
    return `<text x="${xs(i)}" y="${H - PB + 18}" class="ch-lbl" text-anchor="middle">${fmtMonth(+y, +m).slice(0, 3).toLowerCase()}</text>`;
  }).join('');

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const v = lo + (hi - lo) * t;
    return `<g><line x1="${PL}" x2="${W - PR}" y1="${ys(v)}" y2="${ys(v)}" class="ch-grid"/>
      <text x="${PL - 8}" y="${ys(v) + 4}" class="ch-lbl" text-anchor="end">${k(v)}</text></g>`;
  }).join('');

  const todayX = data.findIndex(d => d.period >= today);
  const dots = data.map((d, i) => `
    <circle cx="${xs(i)}" cy="${ys(d.carry)}" r="${i === minIdx ? 5 : 3}"
      class="${i === minIdx ? 'ch-dot min' : 'ch-dot'}">
      <title>${fmtPeriodFull(d.period)}: ${fmtMoney(d.carry)} (нагрузка ${d.load == null ? '—' : Math.round(d.load * 100) + '%'})</title>
    </circle>`).join('');

  $('#view-chart').innerHTML = `
    <div class="section-head"><h2>Остаток с переносом · год вперёд</h2></div>
    <div class="card">
      <svg viewBox="0 0 ${W} ${H}" class="chart">
        ${yTicks}
        ${lo < 0 ? `<line x1="${PL}" x2="${W - PR}" y1="${ys(0)}" y2="${ys(0)}" class="ch-zero"/>` : ''}
        ${todayX >= 0 ? `<line x1="${xs(todayX)}" x2="${xs(todayX)}" y1="${PT}" y2="${H - PB}" class="ch-today"/>
          <text x="${xs(todayX)}" y="${PT - 4}" class="ch-lbl accent" text-anchor="middle">сегодня</text>` : ''}
        <polygon points="${area}" class="ch-area"/>
        <polyline points="${pts}" class="ch-line"/>
        ${dots}
        ${monthLabels}
      </svg>
      <p class="hint">Минимум за период: <b>${fmtMoney(vals[minIdx])}</b> — ${fmtPeriodFull(data[minIdx].period)}.
      Перенос копится с января 2026 и учитывает только платежи из календаря.</p>
    </div>
    ${monthlyLoadChart(S.view.chartYear)}
    ${yearlyLoadChart()}`;

  const yp = $('#chart-year-prev'); if (yp) yp.onclick = () => { S.view.chartYear--; renderChart(); };
  const yn = $('#chart-year-next'); if (yn) yn.onclick = () => { S.view.chartYear++; renderChart(); };
}

// 12 месячных слотов года (с пустыми, если данных нет).
function monthsForYear(year) {
  const byM = new Map(monthlyLoads(S.timeline).filter(x => x.y === year).map(x => [x.m, x]));
  const out = [];
  for (let m = 1; m <= 12; m++) {
    out.push(byM.get(m) || { y: year, m, ym: `${year}-${String(m).padStart(2, '0')}`, income: 0, expense: 0, load: null, zone: null });
  }
  return out;
}

// Столбчатый график помесячной нагрузки за выбранный год + стрелки навигации.
function monthlyLoadChart(year) {
  const all = monthlyLoads(S.timeline);
  const dataYears = [...new Set(all.filter(x => x.income > 0 || x.expense > 0).map(x => x.y))];
  const minY = dataYears.length ? Math.min(...dataYears) : year;
  const maxY = dataYears.length ? Math.max(...dataYears) : year;
  const allowedMin = minY - 1, allowedMax = maxY;

  const months = monthsForYear(year);
  const hasData = months.some(m => m.load != null);
  const curYM = todayISO().slice(0, 7);

  const W = 820, H = 280, PL = 40, PR = 16, PT = 24, PB = 40;
  const n = 12, gap = 12;
  const bw = (W - PL - PR - gap * (n - 1)) / n;
  const maxLoad = Math.max(1, ...months.map(m => m.load || 0)) * 1.05;
  const ys = v => PT + (1 - v / maxLoad) * (H - PT - PB);
  const baseY = H - PB;

  const guides = [0.5, 0.75, 1].map(t => `
    <line x1="${PL}" x2="${W - PR}" y1="${ys(t)}" y2="${ys(t)}" class="ch-grid"/>
    <text x="${W - PR}" y="${ys(t) - 3}" class="ch-lbl" text-anchor="end">${Math.round(t * 100)}%</text>`).join('');

  const bars = months.map((m, i) => {
    const x = PL + i * (bw + gap);
    const h = m.load == null ? 0 : Math.max(2, baseY - ys(m.load));
    const z = m.zone ? m.zone.key : 'none';
    const pct = m.load == null ? '' : Math.round(m.load * 100) + '%';
    const isCur = m.ym === curYM;
    return `
      <g>
        <rect x="${x}" y="${baseY - h}" width="${bw}" height="${h}" rx="4" class="ch-bar zone-${z} ${isCur ? 'cur' : ''}">
          <title>${fmtMonth(m.y, m.m)}: нагрузка ${pct || '—'}, списания ${fmtMoney(m.expense)} из ${fmtMoney(m.income)}</title>
        </rect>
        <text x="${x + bw / 2}" y="${baseY - h - 6}" class="ch-lbl" text-anchor="middle">${pct}</text>
        <text x="${x + bw / 2}" y="${H - PB + 16}" class="ch-lbl" text-anchor="middle">${MON3[m.m - 1]}</text>
      </g>`;
  }).join('');

  return `
    <div class="section-head" style="margin-top:18px">
      <h2>Нагрузка по месяцам</h2>
      <div class="year-nav">
        <button id="chart-year-prev" aria-label="Предыдущий год" ${year <= allowedMin ? 'disabled' : ''}>‹</button>
        <span>${year}</span>
        <button id="chart-year-next" aria-label="Следующий год" ${year >= allowedMax ? 'disabled' : ''}>›</button>
      </div>
    </div>
    <div class="card">
      <svg viewBox="0 0 ${W} ${H}" class="chart">
        ${guides}
        <line x1="${PL}" x2="${W - PR}" y1="${baseY}" y2="${baseY}" class="ch-grid"/>
        ${bars}
        ${!hasData ? `<text x="${W / 2}" y="${(PT + baseY) / 2}" class="ch-empty" text-anchor="middle">Нет данных за ${year}</text>` : ''}
      </svg>
      <p class="hint">Сумма всех списаний за месяц делённая на доход. Текущий месяц обведён.
      Зелёный ≤50%, жёлтый ≤75%, красный выше, тёмный — перегруз.</p>
    </div>`;
}

// Столбчатый график нагрузки по годам (26, 27 …).
function yearlyLoadChart() {
  const years = yearlyLoads(S.timeline);
  if (!years.length) return '';

  const W = 800, H = 240, PL = 40, PR = 16, PT = 24, PB = 40;
  const n = years.length, gap = 40;
  const bw = Math.min(120, (W - PL - PR) / n - gap);
  const totalW = n * bw + (n - 1) * gap;
  const startX = PL + ((W - PL - PR) - totalW) / 2;
  const maxLoad = Math.max(1, ...years.map(y => y.load || 0)) * 1.05;
  const ys = v => PT + (1 - v / maxLoad) * (H - PT - PB);
  const baseY = H - PB;

  const guides = [0.5, 0.75, 1].map(t => `
    <line x1="${PL}" x2="${W - PR}" y1="${ys(t)}" y2="${ys(t)}" class="ch-grid"/>
    <text x="${W - PR}" y="${ys(t) - 3}" class="ch-lbl" text-anchor="end">${Math.round(t * 100)}%</text>`).join('');

  const bars = years.map((yr, i) => {
    const x = startX + i * (bw + gap);
    const h = yr.load == null ? 0 : Math.max(2, baseY - ys(yr.load));
    const z = yr.zone ? yr.zone.key : 'none';
    const pct = yr.load == null ? '—' : Math.round(yr.load * 100) + '%';
    return `
      <g>
        <rect x="${x}" y="${baseY - h}" width="${bw}" height="${h}" rx="5" class="ch-bar zone-${z}">
          <title>${yr.year}: нагрузка ${pct}, списания ${fmtMoney(yr.expense)} из ${fmtMoney(yr.income)}</title>
        </rect>
        <text x="${x + bw / 2}" y="${baseY - h - 7}" class="ch-lbl" text-anchor="middle">${pct}</text>
        <text x="${x + bw / 2}" y="${H - PB + 22}" class="ch-yr" text-anchor="middle">${String(yr.year).slice(2)}</text>
      </g>`;
  }).join('');

  return `
    <div class="section-head" style="margin-top:18px"><h2>Нагрузка по годам</h2></div>
    <div class="card">
      <svg viewBox="0 0 ${W} ${H}" class="chart">
        ${guides}
        <line x1="${PL}" x2="${W - PR}" y1="${baseY}" y2="${baseY}" class="ch-grid"/>
        ${bars}
      </svg>
      <p class="hint">Средняя нагрузка за год: все списания делённые на весь доход.
      Год показан двумя цифрами (26 = 2026).</p>
    </div>`;
}
