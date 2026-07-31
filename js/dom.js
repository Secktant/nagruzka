// Примитивы UI: выборка, экранирование, id, денежный ввод, модалка.
// Без общего состояния — чистые/DOM-only помощники, вынесены из app.js.
// (Чипы банков остались в app.js: им нужен state.settings.banks.)

export const $ = sel => document.querySelector(sel);
export const $$ = sel => [...document.querySelectorAll(sel)];

// ── ширина, занятая левым меню ──
// Нужна тем, кто выбирает раскладку по ширине (views/periods.js): медиазапрос
// меряет ОКНО, а контенту достаётся окно минус меню — иначе на 1280px включится
// лента-прогноз, для которой места уже нет. Значения обязаны совпадать с
// --nav-w в style.css (медиазапрос не отдаёт свою ширину в JS).
export const NAV_BREAKPOINT = 1024;   // ниже — меню панелью внизу, ширину не ест
export function navGutter() {
  if (!window.matchMedia(`(min-width: ${NAV_BREAKPOINT}px)`).matches) return 0;
  // --ui-scale выставляется инлайном в app.js (число), поэтому читается как есть
  const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
  return (document.documentElement.classList.contains('nav-collapsed') ? 56 : 184) * scale;
}
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const uid = p => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// ── денежный ввод: type=text с пробелами + свои стрелки ±1 ₽ ──
export const parseMoney = v => {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace('−', '-').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
};

export function fmtNumEditor(n) {
  if (n === '' || n == null || (typeof n === 'number' && isNaN(n))) return '';
  const num = typeof n === 'number' ? n : parseMoney(n);
  if (isNaN(num)) return '';
  const neg = num < 0, abs = Math.abs(num);
  const int = Math.trunc(abs), frac = Math.round((abs - int) * 100);
  let s = String(int);
  if (int >= 10000) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  if (frac) s += ',' + String(frac).padStart(2, '0');
  return (neg ? '-' : '') + s;
}

// name|value|extra-attrs(класс/placeholder/aria) → разметка поля со стрелками
export function moneyInput(name, value, attrs = '') {
  const v = value === '' || value == null ? '' : fmtNumEditor(value);
  return `<span class="num">
    <input type="text" inputmode="decimal" class="num-field" ${name ? `name="${name}"` : ''} value="${v}" ${attrs}>
    <span class="num-steps">
      <button type="button" class="num-step up" tabindex="-1" aria-label="+1 ₽">▲</button>
      <button type="button" class="num-step down" tabindex="-1" aria-label="−1 ₽">▼</button>
    </span>
  </span>`;
}

// Глобальная обвязка для всех money-полей внутри #modal (вешается один раз).
export function wireMoneyInputs(root) {
  root.addEventListener('focusin', e => {
    if (e.target.classList?.contains('num-field')) {
      e.target.value = String(e.target.value).replace(/\s/g, '');
    }
  });
  root.addEventListener('focusout', e => {
    if (e.target.classList?.contains('num-field') && e.target.value !== '') {
      e.target.value = fmtNumEditor(parseMoney(e.target.value));
    }
  });
  root.addEventListener('click', e => {
    const step = e.target.closest('.num-step');
    if (!step) return;
    const field = step.closest('.num').querySelector('.num-field');
    const cur = parseMoney(field.value) || 0;
    field.value = fmtNumEditor(cur + (step.classList.contains('up') ? 1 : -1));
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// ── модалка ──
export function openModal(html) {
  $('#modal-body').innerHTML = html;
  $('#modal').showModal();
}
export function closeModal() { $('#modal').close(); }

// «Занятость» кнопки на время async-операции (Argon2/сеть): спиннер + блок кликов.
// Снимает состояние в finally, даже если fn бросил. Возвращает результат fn.
export async function withBusy(btn, fn) {
  if (!btn) return fn();
  btn.classList.add('busy');
  try { return await fn(); }
  finally { btn.classList.remove('busy'); }
}
