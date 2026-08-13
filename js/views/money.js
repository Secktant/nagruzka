// Вкладка «Деньги»: зарплата, регулярные платежи (+форма), банки.
// Выделена из settings.js (п.8 роадмапа): это финансовые ДАННЫЕ, которые правят
// регулярно, а не настройки приложения, которые трогают раз при заводке устройства.
// ИНВАРИАНТ: здесь нет и не должно быть криптографии — ни crypto.js, ни ключевых
// функций db.js, ни sync-ui. Всё это осталось в settings.js.

import { S, putRegular, deleteRegular, putSettings } from '../store.js';
import { render } from '../render.js';
import { $, $$, esc, uid, parseMoney, moneyInput, openModal, closeModal } from '../dom.js';
import { bankChipsHTML, wireBankChips, selectedBank } from '../chips.js';
import { generatePeriods, fmtMoney, loadZone, regularShares } from '../engine.js';
import { todayISO, horizonEnd } from '../format.js';

// Синхронный (в отличие от renderSettings): ничего из IndexedDB ждать не нужно.
export function renderMoney() {
  const regs = S.state.regulars.filter(r => r.kind === 'expense');
  const salary = S.state.regulars.find(r => r.kind === 'income');
  const schedName = { both: 'каждый период', mid: '15-е число', end: 'конец месяца' };

  // Доля в месячном доходе (месяц = 2 периода). База — плановая зарплата из поля
  // выше, а не факт конкретного месяца: месяца на этом экране просто нет.
  const share = regularShares(regs, salary?.amount ?? 0);
  const fmtPct = (p) => p.toFixed(1).replace('.', ',') + '%';
  const shareHTML = (r) => {
    const row = share.rows.get(r.id);
    if (!row || row.pct == null) return '';
    // «каждый период» — показываем и месячную сумму, иначе непонятно, почему
    // 10 000 ₽ в строке дают 14,3%.
    const tail = r.schedule === 'both' ? ` · ${fmtMoney(row.monthly)}/мес` : ' месяца';
    return `<span class="pay-share">${fmtPct(row.pct)}${tail}</span>`;
  };
  const totalHTML = share.sum > 0 ? `
      <div class="reg-total">
        <span class="rt-lbl">Всего регулярных</span>
        <span class="pay-money">
          <span class="pay-amount">${fmtMoney(share.sum)}/мес</span>
          ${share.pct == null ? ''
            : `<span class="pay-share zone-text-${loadZone(share.pct / 100).key}">${fmtPct(share.pct)} дохода</span>`}
        </span>
      </div>` : '';

  $('#view-money').innerHTML = `
    <div class="section-head"><h2>Деньги</h2></div>

    <section class="card">
      <h3>Зарплата</h3>
      <label class="inline-label">Сумма за период, ₽
        ${moneyInput('', salary?.amount ?? 70000, 'id="salary-input"')}
      </label>
      <p class="hint">Подставляется в каждый период (15-е и конец месяца). Факт правится в самом периоде.</p>
    </section>

    <section class="card">
      <div class="section-head"><h3>Регулярные платежи</h3>
        <button class="btn" id="add-regular">+ добавить</button></div>
      ${regs.map(r => `
        <div class="pay ${r.active ? '' : 'paid'} clickable" data-reg="${r.id}">
          <span class="pay-main">
            <span class="pay-name"><span class="pn-text">${esc(r.name)}</span>
              <span class="bank-tag">${schedName[r.schedule]}</span>
              ${r.bank ? `<span class="bank-tag">${esc(r.bank)}</span>` : ''}
              ${r.active ? '' : '<span class="bank-tag">выключен</span>'}</span>
            <span class="pay-money">
              <span class="pay-amount">${fmtMoney(r.amount)}</span>
              ${shareHTML(r)}
            </span>
          </span>
        </div>`).join('') || '<div class="empty small">Пока пусто</div>'}
      ${totalHTML}
      <p class="hint">Изменение суммы влияет только на будущие периоды — история уже записана.</p>
    </section>

    <section class="card">
      <h3>Банки</h3>
      <div class="chips" id="money-banks">
        ${S.state.settings.banks.map(b => `<span class="chip">${esc(b)} <button class="chip-x" data-rm-bank="${esc(b)}">×</button></span>`).join('')}
        <button type="button" class="chip pick add" id="money-add-bank">+ банк</button>
      </div>
    </section>`;

  $('#salary-input').addEventListener('input', async e => {
    const v = parseMoney(e.target.value);
    if (!(v > 0) || !salary) return;
    salary.amount = v;
    await putRegular(S.db, salary); // без render — не теряем фокус при наборе
  });

  $('#add-regular').onclick = () => openRegularForm(null);
  $$('#view-money [data-reg]').forEach(el => {
    el.addEventListener('click', () => openRegularForm(el.dataset.reg));
  });

  $('#money-banks').addEventListener('click', async e => {
    if (e.target.id === 'money-add-bank') {
      const name = prompt('Название банка');
      if (!name || !name.trim()) return;
      if (!S.state.settings.banks.includes(name.trim())) {
        S.state.settings.banks.push(name.trim());
        await putSettings(S.db, S.state.settings);
      }
      render();
    }
    const rm = e.target.dataset.rmBank;
    if (rm && confirm(`Убрать банк «${rm}» из списка? Старые платежи не изменятся.`)) {
      S.state.settings.banks = S.state.settings.banks.filter(b => b !== rm);
      await putSettings(S.db, S.state.settings);
      render();
    }
  });
}

function openRegularForm(regId) {
  const reg = regId ? S.state.regulars.find(r => r.id === regId) : null;
  const isNew = !reg;

  openModal(`
  <form id="reg-form" class="form">
    <h3>${isNew ? 'Новый регулярный платёж' : esc(reg.name)}</h3>
    <label>Название
      <input name="name" required value="${esc(reg?.name || '')}" placeholder="Интернет">
    </label>
    <div class="row2">
      <label>Сумма, ₽
        ${moneyInput('amount', reg?.amount ?? '', '')}
      </label>
      <label>Когда
        <select name="schedule">
          <option value="mid" ${reg?.schedule === 'mid' ? 'selected' : ''}>15-е число</option>
          <option value="end" ${reg?.schedule === 'end' ? 'selected' : ''}>конец месяца</option>
          <option value="both" ${reg?.schedule === 'both' ? 'selected' : ''}>каждый период</option>
        </select>
      </label>
    </div>
    <label class="check-label">
      <input type="checkbox" name="active" ${reg?.active !== false ? 'checked' : ''}> Активен
    </label>
    ${isNew ? '<p class="hint">Новый платёж появится только в будущих периодах — прошлое не трогаем.</p>' : ''}
    <div class="lbl-like">Банк</div>
    ${bankChipsHTML(reg?.bank || null)}
    <div class="form-actions">
      ${!isNew ? `<button type="button" class="btn danger" id="reg-delete">Удалить</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn" id="modal-cancel">Отмена</button>
      <button class="btn primary">Сохранить</button>
    </div>
  </form>`);

  wireBankChips();
  $('#modal-cancel').onclick = closeModal;

  const delBtn = $('#reg-delete');
  if (delBtn) delBtn.onclick = async () => {
    if (!confirm(`Удалить «${reg.name}»? История останется, будущие периоды очистятся.`)) return;
    S.state.regulars = S.state.regulars.filter(r => r.id !== reg.id);
    await deleteRegular(S.db, reg.id);
    closeModal(); render();
  };

  $('#reg-form').onsubmit = async e => {
    e.preventDefault();
    const f = e.target;
    const data = {
      name: f.name.value.trim(),
      amount: parseMoney(f.amount.value),
      schedule: f.schedule.value,
      active: f.active.checked,
      bank: selectedBank(),
    };
    if (!data.name || !Number.isFinite(data.amount)) return;
    if (isNew) {
      // новый регулярный действует только с ближайшего будущего периода
      const since = generatePeriods(todayISO().slice(0, 7) + '-01', horizonEnd())
        .find(p => p >= todayISO());
      const rec = { id: uid('reg'), kind: 'expense', since, ...data };
      S.state.regulars.push(rec);
      await putRegular(S.db, rec);
    } else {
      Object.assign(reg, data);
      await putRegular(S.db, reg);
    }
    closeModal(); render();
  };
}
