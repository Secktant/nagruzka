// Диспетчер перерисовки. Живёт отдельным модулем, чтобы вьюхи могли звать render()
// после мутаций без цикла с точкой входа (цикл render.js↔views безопасен: все
// перекрёстные обращения — вызовы функций в рантайме, не при eval модуля).

import { S, recalc } from './store.js';
import { $, $$ } from './dom.js';
import { renderChart } from './views/chart.js';
import { renderDebts } from './views/debts.js';
import { renderPeriods } from './views/periods.js';

// Вьюхи, ещё не вынесенные из app.js, регистрируются на старте через registerViews
// (app.js — точка входа, к моменту вызова render.js уже полностью инициализирован).
// По мере распила заменяются прямыми импортами и реестр исчезает.
const pending = {};
export function registerViews(map) { Object.assign(pending, map); }

export function render() {
  recalc();
  $('#month-nav').style.visibility = S.view.tab === 'periods' ? 'visible' : 'hidden';
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === S.view.tab));
  $$('.view').forEach(v => v.hidden = v.id !== `view-${S.view.tab}`);
  if (S.view.tab === 'periods') renderPeriods();
  if (S.view.tab === 'debts') renderDebts();
  if (S.view.tab === 'chart') renderChart();
  if (S.view.tab === 'settings') pending.settings?.();
}
