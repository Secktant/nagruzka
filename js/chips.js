// Чипы выбора банка в формах (платёж / рассрочка / регулярный).
// Знают про S.state.settings.banks и умеют добавлять банк на лету.

import { S, putSettings } from './store.js';
import { $, $$, esc } from './dom.js';

export function bankChipsHTML(selected) {
  const chips = S.state.settings.banks.map(b => `
    <button type="button" class="chip pick ${b === selected ? 'sel' : ''}" data-bank="${esc(b)}">${esc(b)}</button>`).join('');
  return `
  <div class="chips" id="bank-chips">
    <button type="button" class="chip pick ${!selected ? 'sel' : ''}" data-bank="">без банка</button>
    ${chips}
    <button type="button" class="chip pick add" id="add-bank">+ банк</button>
  </div>`;
}

export function wireBankChips(onChange) {
  $('#bank-chips').addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'add-bank') {
      const name = prompt('Название банка');
      if (!name || !name.trim()) return;
      const bank = name.trim();
      if (!S.state.settings.banks.includes(bank)) {
        S.state.settings.banks.push(bank);
        await putSettings(S.db, S.state.settings);
      }
      btn.insertAdjacentHTML('beforebegin',
        `<button type="button" class="chip pick" data-bank="${esc(bank)}">${esc(bank)}</button>`);
      btn.previousElementSibling.click();
      return;
    }
    $$('#bank-chips .pick').forEach(c => c.classList.remove('sel'));
    btn.classList.add('sel');
    onChange?.(btn.dataset.bank || null);
  });
}

export const selectedBank = () => $('#bank-chips .pick.sel')?.dataset.bank || null;
