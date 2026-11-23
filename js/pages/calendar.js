// Calendário: visão mensal com total de entradas e saídas por dia + resumo do mês.
import { state, page, card, canEdit, categoryChip, accountName, routeParams, emptyState } from '../ctx.js';
import { calendarMonth, localToday, sumBy, movements, dateFor } from '../finance.js';
import { h, brl, brlCompact, monthLabel, dateLong, $, isMobile } from '../ui.js';
import { icon } from '../icons.js';
import { openTxDialog } from './tx.js';

let selected = null;

export async function renderCalendar() {
  const qd = routeParams().get('d');
  if (qd && /^\d{4}-\d{2}-\d{2}$/.test(qd)) {
    selected = qd;
    state.month = qd.slice(0, 7);
    $('#month-input').value = state.month;
  }
  const d = state.d;
  const month = state.month;
  if (!selected || !selected.startsWith(month)) selected = localToday().startsWith(month) ? localToday() : `${month}-01`;
  const days = calendarMonth(d, month);
  const today = localToday();
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const tot = sumBy(movements(d, `${month}-01`, dateFor(month, 31)));
  const busiest = [...days.values()].sort((a, b) => b.expense - a.expense)[0];

  const side = h('div', { class: 'day-panel' });
  const paintSide = () => {
    const info = days.get(selected);
    side.replaceChildren(card(dateLong(selected), {
      actions: canEdit('lancamentos') ? h('button', { type: 'button', class: 'btn small', onclick: () => openTxDialog(null, { date: selected }) }, icon('plus', 16), h('span', {}, 'Lançar')) : null,
    }, info ? h('div', { class: 'stack' },
      h('div', { class: 'summary-strip compact' },
        h('div', {}, h('span', {}, 'Entradas'), h('strong', { class: 'num pos' }, brl(info.income))),
        h('div', {}, h('span', {}, 'Saídas'), h('strong', { class: 'num neg' }, brl(info.expense)))),
      h('ul', { class: 'mv-list' }, ...info.items.map((mv) => h('li', { class: 'mv' },
        h('span', { class: `mv-ico ${mv.type === 'income' ? 'in' : 'out'}` }, icon(mv.type === 'income' ? 'arrow_in' : 'arrow_out', 16)),
        h('div', { class: 'mv-main' }, h('span', { class: 'mv-desc' }, mv.description, mv.source === 'auto' ? h('span', { class: 'tag' }, mv.detail) : null),
          h('span', { class: 'mv-meta' }, categoryChip(mv.categoryId), ' · ', accountName(mv.accountId))),
        h('span', { class: `mv-val num ${mv.type === 'income' ? 'pos' : 'neg'}` }, `${mv.type === 'income' ? '+' : '−'} ${brl(mv.amount)}`)))))
      : emptyState('calendar', 'Nenhuma movimentação neste dia', null)));
  };

  const grid = h('div', { class: 'cal-grid', role: 'grid', 'aria-label': `Calendário de ${monthLabel(month)}` },
    ...['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((x) => h('div', { class: 'cal-dow', role: 'columnheader' }, x)));
  for (let i = 0; i < first; i++) grid.append(h('div', { class: 'cal-cell empty' }));
  for (let dd = 1; dd <= total; dd++) {
    const date = `${month}-${String(dd).padStart(2, '0')}`;
    const info = days.get(date);
    const cell = h('button', {
      type: 'button', class: `cal-cell${date === today ? ' today' : ''}${date === selected ? ' sel' : ''}${date > today ? ' future' : ''}`,
      'aria-label': `${dd} de ${monthLabel(month)}${info ? `: entradas ${brl(info.income)}, saídas ${brl(info.expense)}` : ''}`,
      'aria-pressed': String(date === selected),
      onclick: () => {
        selected = date;
        grid.querySelectorAll('.cal-cell.sel').forEach((c) => {
          c.classList.remove('sel');
          c.setAttribute('aria-pressed', 'false');
        });
        cell.classList.add('sel');
        cell.setAttribute('aria-pressed', 'true');
        paintSide();
        if (isMobile()) side.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }, h('span', { class: 'cal-n' }, dd),
    info ? h('span', { class: 'cal-vals' },
      info.income ? h('span', { class: 'cal-in num' }, `+${brlCompact(info.income)}`) : null,
      info.expense ? h('span', { class: 'cal-out num' }, `−${brlCompact(info.expense)}`) : null,
      h('span', { class: 'cal-count' }, `${info.items.length} mov.`)) : null,
    info ? h('span', { class: 'dots cal-dots', 'aria-hidden': 'true' },
      info.income ? h('i', { class: 'dot in' }) : null, info.expense ? h('i', { class: 'dot out' }) : null) : null);
    grid.append(cell);
  }
  paintSide();

  page('Calendário', { subtitle: monthLabel(month) },
    h('div', { class: 'summary-strip' },
      h('div', {}, h('span', {}, 'Entradas do mês'), h('strong', { class: 'num pos' }, brl(tot.income))),
      h('div', {}, h('span', {}, 'Saídas do mês'), h('strong', { class: 'num neg' }, brl(tot.expense))),
      h('div', {}, h('span', {}, 'Resultado'), h('strong', { class: `num ${tot.balance < 0 ? 'neg' : ''}` }, brl(tot.balance))),
      h('div', {}, h('span', {}, 'Dia com mais saídas'), h('strong', { class: 'num' }, busiest?.expense ? `${busiest.date.slice(8)} · ${brl(busiest.expense)}` : '—'))),
    h('div', { class: 'cal-layout' }, card(null, { cls: 'cal-card' }, grid), side));
}
