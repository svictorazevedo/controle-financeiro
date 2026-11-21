import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  monthSummary, movements, accountBalances, budgetStatus, goalProgress, calendarMonth, dateFor, permOf, categoryTree, trend,
} from '../js/finance.js';
import { buildReport, REPORTS } from '../js/reports.js';
import { tablePdf, textWidth } from '../js/pdf.js';

const data = {
  residents: [{ id: 'eu', name: 'Ana', role: 'admin', user_id: 'u1' }, { id: 'bia', name: 'Bia', role: 'member', user_id: 'u2', permissions: { contas: 2, ia: 0 } }],
  accounts: [
    { id: 'cc', name: 'Conta corrente', kind: 'checking', opening_cents: 100000 },
    { id: 'cart', name: 'Carteira', kind: 'wallet', opening_cents: 0 },
  ],
  categories: [
    { id: 'mer', name: 'Mercado', type: 'expense', color: '#1baf7a' },
    { id: 'hor', name: 'Hortifruti', type: 'expense', parent_id: 'mer' },
    { id: 'mor', name: 'Moradia', type: 'expense' },
    { id: 'diz', name: 'Dízimo', type: 'expense' },
    { id: 'sal', name: 'Salário', type: 'income' },
    { id: 'fre', name: 'Freela', type: 'income' },
  ],
  incomes: [{ id: 'i1', resident_id: 'eu', account_id: 'cc', category_id: 'sal', description: 'Salário', amount_cents: 500000, kind: 'recurring', start_month: '2026-10', day: 5 }],
  goals: [],
  recurring: [
    { id: 'r1', resident_id: 'eu', account_id: 'cc', category_id: 'diz', description: 'Dízimo', mode: 'percent', percent_bp: 1000, start_month: '2026-10', day: 6, active: true },
    { id: 'r2', resident_id: null, account_id: 'cc', category_id: 'mor', description: 'Aluguel', mode: 'fixed', amount_cents: 150000, start_month: '2026-10', day: 31, active: true },
  ],
  transactions: [
    { id: 't1', type: 'income', resident_id: 'eu', account_id: 'cart', category_id: 'fre', description: 'Freela', amount_cents: 100000, date: '2026-11-10' },
    { id: 't2', type: 'expense', resident_id: null, account_id: 'cart', category_id: 'hor', description: 'Feira', amount_cents: 20000, date: '2026-11-12' },
    { id: 't3', type: 'expense', resident_id: null, account_id: 'cc', category_id: 'mer', description: 'Mercado', amount_cents: 70000, date: '2026-11-20' },
    { id: 't4', type: 'expense', resident_id: null, account_id: null, category_id: null, description: 'Sem conta', amount_cents: 1000, date: '2026-11-21' },
  ],
  budgets: [
    { id: 'b1', category_id: 'mer', month: null, amount_cents: 80000 },
    { id: 'b2', category_id: 'mer', month: '2026-12', amount_cents: 200000 },
    { id: 'b3', category_id: 'mor', month: null, amount_cents: 150000 },
  ],
  savingsGoals: [{ id: 'g1', name: 'Viagem', target_cents: 1200000, target_date: '2027-04-30' }],
  deposits: [{ id: 'd1', goal_id: 'g1', amount_cents: 300000, date: '2026-10-01' }, { id: 'd2', goal_id: 'g1', amount_cents: -50000, date: '2026-11-01' }],
};

test('entrada lançada soma nas entradas do mês e na base do dízimo', () => {
  const s = monthSummary(data, '2026-11');
  assert.equal(s.totals.income, 600000);
  assert.equal(s.totals.incomeLaunched, 100000);
  assert.equal(s.automatic.find((a) => a.description === 'Dízimo').amount, 60000);
  assert.equal(s.totals.expenses, 60000 + 150000 + 20000 + 70000 + 1000);
});

test('automáticos acontecem no dia certo (dia 31 vira o último dia do mês)', () => {
  const nov = movements(data, '2026-11-01', '2026-11-30');
  assert.equal(nov.find((m) => m.description === 'Aluguel').date, '2026-11-30');
  assert.equal(nov.find((m) => m.description === 'Salário').date, '2026-11-05');
  assert.equal(dateFor('2026-02', 31), '2026-02-28');
  assert.deepEqual(nov.map((m) => m.date), [...nov.map((m) => m.date)].sort());
});

test('saldo das contas: inicial + movimentos até a data; "Sem conta" fecha o total', () => {
  const b = accountBalances(data, '2026-11-21');
  const cc = b.accounts.find((r) => r.id === 'cc').balance;
  // out: +5000 -500(dízimo) -1500(aluguel 31/10) | nov: +5000 -600(dízimo sobre 6000) -700 (aluguel 30/11 ainda não)
  assert.equal(cc, 100000 + 500000 - 50000 - 150000 + 500000 - 60000 - 70000);
  assert.equal(b.accounts.find((r) => r.id === 'cart').balance, 100000 - 20000);
  assert.equal(b.accounts.find((r) => r.id === null).balance, -1000);
  assert.equal(b.total, b.accounts.reduce((s, r) => s + r.balance, 0));
  const end = accountBalances(data, '2026-11-30');
  assert.equal(end.accounts.find((r) => r.id === 'cc').balance, cc - 150000);
});

test('orçamento: subcategoria soma na mãe; limite do mês substitui o padrão', () => {
  const nov = budgetStatus(data, '2026-11');
  const mer = nov.rows.find((r) => r.category.id === 'mer');
  assert.equal(mer.spent, 90000);
  assert.equal(mer.planned, 80000);
  assert.equal(mer.status, 'over');
  assert.equal(nov.rows.find((r) => r.category.id === 'mor').status, 'warn');   // 100% do limite
  assert.equal(nov.unbudgeted, 60000 + 1000);                                    // dízimo + sem categoria
  assert.equal(budgetStatus(data, '2026-12').rows.find((r) => r.category.id === 'mer').planned, 200000);
});

test('metas: guardado, falta e quanto por mês até a data', () => {
  const p = goalProgress(data.savingsGoals[0], data.deposits, '2026-11-21');
  assert.equal(p.saved, 250000);
  assert.equal(p.remaining, 950000);
  assert.equal(p.monthsLeft, 6);              // nov, dez, jan, fev, mar, abr
  assert.equal(p.monthly, Math.ceil(950000 / 6));
  assert.equal(p.status, 'active');
  assert.equal(goalProgress(data.savingsGoals[0], data.deposits, '2027-05-01').status, 'late');
  assert.equal(goalProgress({ ...data.savingsGoals[0], target_cents: 200000 }, data.deposits, '2026-11-21').status, 'done');
});

test('calendário: totais por dia', () => {
  const days = calendarMonth(data, '2026-11');
  assert.equal(days.get('2026-11-05').income, 500000);
  assert.equal(days.get('2026-11-12').expense, 20000);
  assert.equal(days.has('2026-11-13'), false);
});

test('permissões: admin tem tudo; padrão e personalizadas para colaborador', () => {
  assert.equal(permOf(data.residents[0], 'ia'), 2);
  assert.equal(permOf(data.residents[1], 'contas'), 2);
  assert.equal(permOf(data.residents[1], 'ia'), 0);
  assert.equal(permOf(data.residents[1], 'orcamento'), 1);
  assert.equal(permOf(null, 'painel'), 0);
});

test('árvore de categorias e tendência', () => {
  const t = categoryTree(data.categories, 'expense');
  assert.deepEqual(t.map((c) => c.name), ['Dízimo', 'Mercado', 'Moradia']);
  assert.deepEqual(t[1].children.map((c) => c.name), ['Hortifruti']);
  assert.equal(trend(data, '2026-11', 3)[2].income, 600000);
});

test('os 8 relatórios montam sem erro', () => {
  assert.equal(REPORTS.length, 8);
  const p = { from: '2026-10-01', to: '2026-11-30', month: '2026-11', ahead: 30, accountId: 'cc', today: '2026-11-21' };
  for (const r of REPORTS) {
    const rep = buildReport(r.id, data, p);
    assert.ok(rep.title && Array.isArray(rep.rows) && rep.columns.length, r.id);
  }
});

test('extrato por conta tem saldo anterior e saldo corrido', () => {
  const rep = buildReport('extrato', data, { from: '2026-11-01', to: '2026-11-30', accountId: 'cc', today: '2026-11-21' });
  assert.equal(rep.rows[0].description, 'Saldo anterior');
  assert.equal(rep.rows[0].balance, 100000 + 500000 - 50000 - 150000);
  const last = rep.rows[rep.rows.length - 1];
  assert.equal(last.balance, accountBalances(data, '2026-11-30').accounts.find((r) => r.id === 'cc').balance);
});

test('próximas saídas e totais de 12 meses', () => {
  const next = buildReport('proximas-saidas', data, { today: '2026-11-21', ahead: 30 });
  assert.deepEqual(next.rows.map((r) => r.date), ['2026-11-21', '2026-11-30', '2026-12-06', '2026-12-21'].filter((d) => next.rows.some((r) => r.date === d)));
  assert.ok(next.rows.some((r) => r.description.startsWith('Aluguel')));
  const t12 = buildReport('totais-12', data, { month: '2026-11' });
  assert.equal(t12.rows.length, 12);
  assert.equal(t12.footer.cumulative, t12.rows[11].cumulative);
});

test('PDF: estrutura válida, acentos em WinAnsi e várias páginas', () => {
  const rows = Array.from({ length: 80 }, (_, i) => ['21/11/2026', `Lançamento ação nº ${i} (teste)`, 'R$ 1.234,56']);
  const bytes = tablePdf({ title: 'Relatório de saídas', subtitle: 'Período', columns: [{ label: 'Data' }, { label: 'Descrição', weight: 3 }, { label: 'Valor', align: 'right' }], rows, footer: ['Total', '', 'R$ 9,99'] });
  const txt = Buffer.from(bytes).toString('latin1');
  assert.ok(txt.startsWith('%PDF-1.4'));
  assert.ok(txt.trimEnd().endsWith('%%EOF'));
  assert.match(txt, /\/Count 2/);
  assert.match(txt, /a\\347\\343o/);          // "ação" em octal WinAnsi
  const xref = Number(txt.match(/startxref\n(\d+)/)[1]);
  assert.equal(txt.slice(xref, xref + 4), 'xref');
  assert.ok(textWidth('1000', 10) === textWidth('9999', 10));
});
