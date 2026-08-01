// Точка входа: старт приложения (замок/сейф/синк), навигация по периодам,
// масштаб, вкладки. Вся логика — в модулях: store (состояние), render
// (диспетчер), views/* (экраны), sync-ui (синк+замок), engine (расчёты).

import { SEED } from './seed.js';
import {
  initStore, loadState,
  saveVault, loadVault, hasVault, clearPlaintextStores,
  getKeyfile, getSyncId, getSyncKey, getLock,
} from './db.js';
import { render } from './render.js';
import { renderPeriods, isForecast } from './views/periods.js';
import { wireRail } from './views/rail.js';
import { createSyncEngine, runLockGate } from './sync-ui.js';
import { isConfigured as syncConfigured } from './sync.js';
import { $, $$, wireMoneyInputs, closeModal } from './dom.js';
import { S } from './store.js';


// ───────────────────────── запуск ─────────────────────────

// Свёрнутое левое меню — класс на <html> (им же управляет CSS и navGutter()).
// Ставим до первой отрисовки; экран закрыт стартовым лоадером, так что мигания нет.
if (localStorage.getItem('navCollapsed')) document.documentElement.classList.add('nav-collapsed');

function shiftMonth(delta) {
  S.view.m += delta;
  if (S.view.m < 1) { S.view.m = 12; S.view.y--; }
  if (S.view.m > 12) { S.view.m = 1; S.view.y++; }
  render();
}
// стрелки в «Периодах»: в режиме прогноза листают ГОД, иначе — месяц
function periodsNav(delta) {
  if (isForecast()) { S.view.y += delta; render(); }
  else shiftMonth(delta);
}


async function main() {
  S.db = await initStore(SEED);
  S.currentKeyfile = await getKeyfile(S.db);
  const lock = await getLock(S.db);

  if (lock) {
    // ЗАМОК (Шаг 5): K открывается биометрией/паролём (overlay блокирует до успеха).
    S.vaultKey = await runLockGate(lock);
    S.vaultSalt = lock.salt;
  } else {
    // Путь 4b: свободно-используемый кэш-ключ «запомнить на устройстве».
    const saved = await getSyncKey(S.db);
    if (saved?.key) { S.vaultKey = saved.key; S.vaultSalt = saved.salt; }
  }

  // Загрузка состояния: есть ключ → зашифрованный сейф; иначе плейнтекст (или seed).
  if (S.vaultKey && await hasVault(S.db)) {
    S.state = await loadVault(S.db, S.vaultKey);
  } else {
    S.state = await loadState(S.db);
    if (S.vaultKey && !lock) {                    // 4b-миграция плейнтекст→сейф (вне замка-гейта)
      await saveVault(S.db, S.vaultKey, S.state);
      if (await loadVault(S.db, S.vaultKey)) await clearPlaintextStores(S.db); // чистим только после успешного чтения
    }
  }

  if (syncConfigured()) {
    S.syncEngine = createSyncEngine();
    const sid = await getSyncId(S.db);
    if (sid && S.vaultKey) {
      await S.syncEngine.prepare(sid);   // вычислить id чанка/меты из Sync ID
      S.syncEngine.key = S.vaultKey;
      S.syncEngine.salt = S.vaultSalt;
      S.syncEngine.version = 0;      // подтянем актуальную версию из сервера ниже
      S.syncStatus = 'synced';
      S.syncEngine.start();
      S.syncEngine.pullAndApply();
    }
  }
  $('#prev-month').addEventListener('click', () => periodsNav(-1));
  $('#next-month').addEventListener('click', () => periodsNav(1));
  // Рельс года: произвольный доступ к месяцу, стрелки в топбаре — шаг вперёд/назад.
  wireRail((y, m) => { S.view.y = y; S.view.m = m; render(); });

  // масштаб контента (только .view — топбар/таббар не трогаем). Хранится в localStorage.
  // Макс 150% — на нём «Периоды» переключаются в режим одного месяца (крупно, без скролла).
  const clampZoom = z => Math.min(1.5, Math.max(0.6, Math.round(z * 10) / 10));
  function applyZoom(z) {
    z = clampZoom(z);
    S.zoomLevel = z;
    // контент и топбар масштабируем через zoom (они в потоке — безопасно). Таббар
    // фиксирован во всю ширину (left/right:0) — zoom ломает привязку, поэтому его
    // содержимое масштабируем переменной --ui-scale (см. .tabbar/.tab в CSS).
    // Единый коэффициент z → весь интерфейс живёт в одном масштабе, «ровно».
    $$('.view').forEach(v => { v.style.zoom = z; });
    const tb = $('.topbar'); if (tb) tb.style.zoom = z;
    document.documentElement.style.setProperty('--ui-scale', String(z));
    const el = $('#zoom-val'); if (el) el.textContent = Math.round(z * 100) + '%';
    localStorage.setItem('zoom', String(z));
    return z;
  }
  // Порог «узко ↔ широко» зависит и от окна, и от ширины меню (см. navGutter), поэтому
  // следим не за медиазапросом, а за самим решением isForecast(). force — когда
  // перерисовать надо в любом случае (масштаб: на пороге 150% меняется раскладка).
  let wasForecast;
  const syncLayout = (force = false) => {
    const f = isForecast();
    const flipped = f !== wasForecast;
    wasForecast = f;
    if ((flipped || force) && S.view.tab === 'periods') renderPeriods();
  };
  const setZoom = z => { zoom = applyZoom(z); syncLayout(true); };
  let zoom = applyZoom(parseFloat(localStorage.getItem('zoom')) || 1);
  wasForecast = isForecast();                 // масштаб уже применён — решение достоверно
  $('#zoom-in').onclick = () => setZoom(zoom + 0.1);
  $('#zoom-out').onclick = () => setZoom(zoom - 0.1);
  // хоткеи Cmd/Ctrl +/−/0 ведём через НАШ масштаб (и глушим браузерный зум,
  // иначе два зума складываются и счётчик не совпадает)
  window.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === '=' || e.key === '+')      { e.preventDefault(); setZoom(zoom + 0.1); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(zoom - 0.1); }
    else if (e.key === '0')                  { e.preventDefault(); setZoom(1); }
  });
  $$('.tab').forEach(t => t.addEventListener('click', () => { S.view.tab = t.dataset.tab; render(); }));
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  $('#modal-close').onclick = closeModal;

  window.addEventListener('resize', () => syncLayout());

  // сворачивание левого меню (в режиме нижней панели кнопка скрыта CSS-ом)
  const navToggle = $('#nav-toggle');
  const labelNavToggle = () => {
    const collapsed = document.documentElement.classList.contains('nav-collapsed');
    const label = collapsed ? 'Развернуть меню' : 'Свернуть меню';
    navToggle.setAttribute('aria-expanded', String(!collapsed));
    navToggle.setAttribute('aria-label', label);
    navToggle.title = label;
  };
  labelNavToggle();                       // состояние могло прийти из localStorage
  navToggle.onclick = () => {
    const collapsed = document.documentElement.classList.toggle('nav-collapsed');
    localStorage.setItem('navCollapsed', collapsed ? '1' : '');
    labelNavToggle();
    syncLayout();   // изменилась доступная ширина — вдруг сменился режим «Периодов»
  };
  wireMoneyInputs(document);
  render();
  showVersion();
}

// Версия = имя активного кэша сервис-воркера (единственный источник — CACHE в sw.js),
// поэтому метка показывает то, что РЕАЛЬНО загружено. До установки SW кэша ещё нет —
// добираем повторно, когда воркер возьмёт управление.
async function showVersion() {
  const el = $('#app-version');
  if (!el || !('caches' in window)) return;
  try {
    const keys = await caches.keys();
    // версии из имён кэшей SW (nagruzka-МАЖОР.МИНОР.ТРИВИАЛ) → показываем наибольшую
    const vers = keys
      .map(k => (k.match(/nagruzka-(\d+\.\d+\.\d+)/) || [])[1])
      .filter(Boolean)
      .sort((a, b) => {
        const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
        return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
      });
    if (vers.length) el.textContent = 'v' + vers[vers.length - 1];
  } catch { /* caches недоступны — метка остаётся пустой */ }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.ready.then(showVersion).catch(() => {});

// прячем стартовый лоадер, когда приложение построено (или упало — не висеть вечно)
main().finally(() => document.getElementById('boot-loader')?.classList.add('is-hidden'));
