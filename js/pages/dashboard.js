// Painel: indicadores do mês e do dia, saldo das contas, tendência, mini calendário,
// orçamento, metas e últimos lançamentos.
import { state, page, card, perm, canEdit, categoryChip, accountName, emptyState, btn } from '../ctx.js';
import { monthSummary, trend, accountBalances, budgetStatus, goalProgress, calendarMonth, movements, localToday, addDays, addMonths, sumBy, dateFor } from '../finance.js';
import { trendChart, donut, progress } from '../charts.js';
import { h, brl, monthLabel, dateShort, dateLong, pctText } from '../ui.js';
import { icon, ACCOUNT_ICONS } from '../icons.js';
import { openTxDialog } from './tx.js';

function kpi(label, value, { iconName, tone = '', sub = null, delta = null, deltaGood = true } = {}) {
  let deltaEl = null;
  if (delta !== null && Number.isFinite(delta)) {
    const up = delta >= 0;
    const good = up === deltaGood;
    deltaEl = h('span', { class: `delta ${good ? 'good' : 'bad'}` }, icon(up ? 'up_trend' : 'down_trend', 14), `${Math.abs(Math.round(delta * 100))}%`);
  }
  return h('section', { class: `card kpi ${tone}` },
    h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon(iconName, 20)), h('span', { class: 'kpi-label' }, label)),
    h('div', { class: 'kpi-value num' }, value),
    h('div', { class: 'kpi-sub' }, deltaEl, sub ? h('span', {}, sub) : null));
}

export function miniCalendar(data, month, { onPick, selected = null } = {}) {
  const days = calendarMonth(data, month);
  const today = localToday();
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const grid = h('div', { class: 'mini-cal', role: 'grid', 'aria-label': `Calendário de ${monthLabel(month)}` },
    ...['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map((d) => h('span', { class: 'mc-dow', 'aria-hidden': 'true' }, d)));
  for (let i = 0; i < first; i++) grid.append(h('span', { class: 'mc-day empty' }));
  for (let d = 1; d <= total; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const info = days.get(date);
    const label = info ? `${d}: entradas ${brl(info.income)}, saídas ${brl(info.expense)}` : String(d);
    grid.append(h('button', {
      type: 'button', class: `mc-day${date === today ? ' today' : ''}${date === selected ? ' sel' : ''}${info ? ' has' : ''}`,
      'aria-label': label, title: label, onclick: () => onPick?.(date),
    }, h('span', {}, d), info ? h('span', { class: 'dots' },
      info.income ? h('i', { class: 'dot in' }) : null, info.expense ? h('i', { class: 'dot out' }) : null) : null));
  }
  return grid;
}

function movementRow(mv) {
  const isIn = mv.type === 'income';
  return h('li', { class: 'mv' },
    h('span', { class: `mv-ico ${isIn ? 'in' : 'out'}` }, icon(isIn ? 'arrow_in' : 'arrow_out', 16)),
    h('div', { class: 'mv-main' },
      h('span', { class: 'mv-desc' }, mv.description, mv.source === 'auto' ? h('span', { class: 'tag' }, 'automático') : null,
        mv.attachment ? h('span', { class: 'clip', title: 'Tem comprovante' }, icon('clip', 14)) : null),
      h('span', { class: 'mv-meta' }, dateShort(mv.date), ' · ', categoryChip(mv.categoryId), ' · ', accountName(mv.accountId))),
    h('span', { class: `mv-val num ${isIn ? 'pos' : 'neg'}` }, `${isIn ? '+' : '−'} ${brl(mv.amount)}`));
}

export async function renderDashboard() {
  const d = state.d;
  const month = state.month;
  const today = localToday();
  const sm = monthSummary(d, month);
  const prev = sumBy(movements(d, `${addMonths(month, -1)}-01`, dateFor(addMonths(month, -1), 31)));
  const t = sm.totals;
  const balances = accountBalances(d, today);
  const endOfMonth = accountBalances(d, dateFor(month, 31));
  const rel = (cur, old) => (old ? (cur - old) / old : null);

  const showFinance = perm('lancamentos') || perm('contas') || perm('painel');
  const kpis = h('div', { class: 'grid kpis' },
    kpi('Saldo em contas', brl(balances.total), {
      iconName: 'bank', tone: balances.total < 0 ? 'neg' : 'accent',
      sub: `Previsto no fim de ${monthLabel(month, true)}: ${brl(endOfMonth.total)}`,
    }),
    kpi('Entradas do mês', brl(t.income), { iconName: 'arrow_in', tone: 'in', delta: rel(t.income, prev.income), sub: 'vs. mês anterior' }),
    kpi('Saídas do mês', brl(t.expenses), { iconName: 'arrow_out', tone: 'out', delta: rel(t.expenses, prev.expense), deltaGood: false, sub: 'vs. mês anterior' }),
    kpi('Resultado do mês', brl(t.balance), {
      iconName: t.balance < 0 ? 'down_trend' : 'up_trend', tone: t.balance < 0 ? 'neg' : 'pos',
      sub: t.income ? `${pctText(Math.max(t.balance, 0) / t.income)} da renda sobrou` : 'Sem entradas no mês',
    }));

  // Hoje
  const todayMv = movements(d, today, today);
  const ts = sumBy(todayMv);
  const next7 = movements(d, addDays(today, 1), addDays(today, 7)).filter((m) => m.type === 'expense');
  const todayCard = card(`Hoje, ${dateLong(today)}`, { cls: 'today-card span-3' },
    h('div', { class: 'today-grid' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Entradas hoje'), h('strong', { class: 'num pos' }, brl(ts.income))),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Saídas hoje'), h('strong', { class: 'num neg' }, brl(ts.expense))),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Lançamentos hoje'), h('strong', { class: 'num' }, String(todayMv.length))),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'A pagar em 7 dias'), h('strong', { class: 'num' }, brl(next7.reduce((s, m) => s + m.amount, 0))),
        h('small', { class: 'muted' }, `${next7.length} conta(s)`))));

  // Tendência + mini calendário
  const trendCard = card('Entradas x saídas', { sub: 'Últimos 6 meses', cls: 'span-2' }, trendChart(trend(d, month, 6), { current: month }));
  const calCard = card(monthLabel(month), {
    sub: 'Dias com movimentação',
    actions: perm('calendario') ? h('a', { class: 'link', href: '#/calendario' }, 'Abrir calendário') : null,
  }, miniCalendar(d, month, { onPick: (date) => { location.hash = `#/calendario?d=${date}`; } }),
  h('div', { class: 'legend small' }, h('span', {}, h('i', { class: 'dot in' }), 'Entrada'), h('span', {}, h('i', { class: 'dot out' }), 'Saída')));

  // Contas
  const accCard = card('Contas', { actions: perm('contas') ? h('a', { class: 'link', href: '#/contas' }, 'Ver todas') : null },
    balances.accounts.length ? h('ul', { class: 'acc-list' }, ...balances.accounts.filter((r) => !r.account?.archived).map((r) => h('li', {},
      h('span', { class: 'acc-ico', style: { '--c': r.account?.color || 'var(--muted-mark)' } }, icon(ACCOUNT_ICONS[r.account?.kind] ?? 'coins', 16)),
      h('span', { class: 'acc-name' }, r.account?.name ?? 'Sem conta'),
      h('span', { class: `num ${r.balance < 0 ? 'neg' : ''}` }, brl(r.balance)))),
    h('li', { class: 'acc-total' }, h('span', {}), h('span', { class: 'acc-name' }, 'Saldo consolidado'), h('strong', { class: 'num' }, brl(balances.total))))
      : emptyState('bank', 'Nenhuma conta', 'Cadastre suas contas em Contas.'));

  // Orçamento
  const bs = budgetStatus(d, month);
  const brows = bs.rows.filter((r) => r.planned).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0)).slice(0, 5);
  const budgetCard = perm('orcamento') || perm('painel') ? card('Orçamento do mês', {
    sub: bs.planned ? `${brl(bs.spent)} de ${brl(bs.planned)} planejados` : null,
    actions: perm('orcamento') ? h('a', { class: 'link', href: '#/orcamento' }, 'Detalhar') : null,
  }, brows.length ? h('ul', { class: 'budget-list' }, ...brows.map((r) => h('li', {},
    h('div', { class: 'bl-top' }, h('span', { class: 'cat-chip' }, h('i', { style: { background: r.category.color } }), r.category.name),
      h('span', { class: 'num' }, `${brl(r.spent)} / ${brl(r.planned)}`)),
    progress(r.ratio, r.status),
    r.status === 'over' ? h('small', { class: 'status-text over' }, icon('alert', 14), `Passou ${brl(-r.remaining)}`) : null)))
    : emptyState('pie', 'Sem orçamento', 'Defina limites de gasto por categoria.', canEdit('orcamento') ? btn('Definir limites', { cls: 'small ghost', onclick: () => { location.hash = '#/orcamento'; } }) : null)) : null;

  // Metas
  const goals = (d.savingsGoals ?? []).filter((g) => !g.archived).map((g) => ({ g, p: goalProgress(g, d.deposits ?? [], today) }))
    .filter((x) => x.p.status !== 'done').slice(0, 4);
  const goalsCard = card('Metas em andamento', { actions: perm('metas') ? h('a', { class: 'link', href: '#/metas' }, 'Ver metas') : null },
    goals.length ? h('ul', { class: 'goal-list' }, ...goals.map(({ g, p }) => h('li', {},
      h('div', { class: 'bl-top' }, h('strong', {}, g.name), h('span', { class: 'num' }, pctText(p.ratio))),
      progress(p.ratio, p.status === 'late' ? 'over' : 'ok', g.color),
      h('small', { class: 'muted' }, `${brl(p.saved)} de ${brl(p.target)}`, p.monthly ? ` · ${brl(p.monthly)}/mês até ${dateShort(g.target_date)}` : '',
        p.status === 'late' ? ' · prazo vencido' : ''))))
      : emptyState('target', 'Nenhuma meta em andamento', 'Crie metas de economia com valor e data.'));

  // Categorias + últimos lançamentos
  const catCard = card('Saídas por categoria', { sub: monthLabel(month) },
    sm.expensesByCategory.length ? donut(sm.expensesByCategory, { total: 'Saídas' }) : emptyState('pie', 'Nenhuma saída no mês', null));
  const launched = movements(d, `${month}-01`, dateFor(month, 31), { automatic: false }).reverse();
  const lastIn = launched.filter((m) => m.type === 'income').slice(0, 5);
  const lastOut = launched.filter((m) => m.type === 'expense').slice(0, 5);
  const lastCard = card('Últimos lançamentos', {
    cls: 'span-2',
    actions: perm('lancamentos') ? h('a', { class: 'link', href: '#/lancamentos' }, 'Ver todos') : null,
  }, h('div', { class: 'two-cols' },
    h('div', {}, h('h3', { class: 'col-title' }, icon('arrow_in', 16), 'Entradas'),
      lastIn.length ? h('ul', { class: 'mv-list' }, ...lastIn.map(movementRow)) : h('p', { class: 'muted small' }, 'Nenhuma entrada lançada no mês.')),
    h('div', {}, h('h3', { class: 'col-title' }, icon('arrow_out', 16), 'Saídas'),
      lastOut.length ? h('ul', { class: 'mv-list' }, ...lastOut.map(movementRow)) : h('p', { class: 'muted small' }, 'Nenhuma saída lançada no mês.'))));

  page('Painel', {
    subtitle: `Visão geral de ${monthLabel(month)}`,
  },
  showFinance ? kpis : null,
  h('div', { class: 'grid dash' },
    todayCard, trendCard, calCard,
    accCard, budgetCard, goalsCard,
    lastCard, catCard));
}
