// Демо-данные для чистой установки. НИКАКИХ персональных данных —
// этот файл публичный. Реальные данные пользователя живут только в IndexedDB
// на его устройстве (и в зашифрованной синхронизации, этап 4).
// Грузится один раз при пустой базе. Свой бэкап — Настройки → Импорт.
export const SEED = {
  settings: {
    salary: 50000,
    banks: ['Альфа', 'Озон', 'Тбанк', 'Яндекс', 'ВТБ'],
    startPeriod: '2026-01-15',
  },
  regulars: [
    { id: 'reg-salary',   name: 'Зарплата',   kind: 'income',  amount: 50000, schedule: 'both', bank: null, active: true },
    { id: 'reg-rent',     name: 'Аренда',     kind: 'expense', amount: 30000, schedule: 'mid',  bank: null, active: true },
    { id: 'reg-utility',  name: 'Коммуналка', kind: 'expense', amount: 5000,  schedule: 'mid',  bank: null, active: true },
    { id: 'reg-internet', name: 'Интернет',   kind: 'expense', amount: 700,   schedule: 'mid',  bank: 'Тбанк', active: true },
  ],
  installments: [
    { id: 'demo-laptop', name: 'Ноутбук', total: 60000, perPeriod: 10000, bank: 'Тбанк', firstPeriod: '2026-03-15' },
  ],
  records: [],
};
