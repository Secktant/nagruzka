// Диспетчер перерисовки. Живёт отдельным модулем, чтобы вьюхи могли звать render()
// после мутаций без цикла с точкой входа (цикл render.js↔views безопасен: все
// перекрёстные обращения — вызовы функций в рантайме, не при eval модуля).

import { S, recalc } from './store.js';
import { $, $$ } from './dom.js';
import { renderChart } from './views/chart.js';
import { renderDebts } from './views/debts.js';
import { renderPeriods } from './views/periods.js';
import { renderMoney } from './views/money.js';
import { renderHistory } from './views/history.js';
import { renderSettings } from './views/settings.js';

export function render() {
  recalc();
  $('#month-nav').style.visibility = S.view.tab === 'periods' ? 'visible' : 'hidden';
  // На узком экране вкладка «График» из панели убрана, вход — из «Денег». Тогда на
  // экране графика в панели не горело бы ничего: подсвечиваем родителя. Признак —
  // сама скрытость кнопки (offsetParent), чтобы не дублировать брейкпоинт в JS.
  const chartInMoney = S.view.tab === 'chart' && !$('.tab[data-tab="chart"]').offsetParent;
  $$('.tab').forEach(t => t.classList.toggle('active',
    t.dataset.tab === S.view.tab || (chartInMoney && t.dataset.tab === 'money')));
  $$('.view').forEach(v => v.hidden = v.id !== `view-${S.view.tab}`);
  if (S.view.tab === 'periods') renderPeriods();
  if (S.view.tab === 'debts') renderDebts();
  if (S.view.tab === 'chart') renderChart();
  if (S.view.tab === 'money') renderMoney();
  if (S.view.tab === 'history') renderHistory();
  if (S.view.tab === 'settings') renderSettings();
}
