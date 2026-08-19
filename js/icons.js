// Единый источник инлайн-SVG (stroke-стиль, ~Hugeicons). Ноль зависимостей,
// ноль сетевых запросов. Цвет = currentColor, размер = 1.1em от шрифта контекста
// (см. svg.ic в style.css) → иконки красятся акцентом и масштабируются зумом сами.
// Статичный хром (таббар/навигация/крестик) инлайнит те же пути прямо в index.html.

const PATHS = {
  // хром / навигация (пути статичного хрома живут инлайном в index.html)
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  // безопасность / данные (настройки)
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.7"/>',
  download: '<path d="M12 4v11M7 11l5 4 5-4M5 20h14"/>',
  upload: '<path d="M12 15V4M7 8l5-4 5 4M5 20h14"/>',
  // типы платежей (постоянный / рассрочка / разовый / мне-должны)
  reg: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
  inst: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M2.5 10h19"/>',
  once: '<rect x="2.5" y="6.5" width="19" height="11" rx="2"/><circle cx="12" cy="12" r="2.4"/>',
  owed: '<path d="M20 5.5A9 9 0 1 0 21 12"/><path d="M20 3v3h-3"/><path d="M10 16.5V7.5h2.7a2 2 0 0 1 0 4H9.5"/>',
  // сортировка / фильтр
  funnel: '<path d="M3 5h18l-7 8v5l-4 2v-7z"/>',
  status: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
  typeList: '<path d="M4 6h16M4 12h10M4 18h6"/>',
  caretUp: '<path d="M6 14l6-6 6 6"/>',
  caretDown: '<path d="M6 10l6 6 6-6"/>',
  pencil: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17z"/>',
};

// icon('reg')            → <svg class="ic" …>
// icon('reg','pay-ico')  → добавить класс контексту
export function icon(name, cls = '') {
  const paths = PATHS[name] || '';
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
}
