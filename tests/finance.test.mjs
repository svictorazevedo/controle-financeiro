import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthSummary, trend, recurringOccurrence, incomeActive, addMonths, applyPercent, buildContext } from '../js/finance.js';

const data = {
  residents: [{ id: 'eu', name: 'Ana', role: 'admin', user_id: 'u1' }, { id: 'ze', name: 'Zé', role: 'member', user_id: null }],
  categories: [{ id: 'mor', name: 'Moradia' }, { id: 'diz', name: 'Dízimo e ofertas' }, { id: 'mer', name: 'Mercado' }],
  incomes: [
    { id: 1, resident_id: 'eu', description: 'Salário', amount_cents: 500000, kind: 'recurring', start_month: '2026-01', end_month: null },
    { id: 2, resident_id: 'eu', description: 'Freela', amount_cents: 100000, kind: 'once', start_month: '2026-03', end_month: null },
    { id: 3, resident_id: 'ze', description: 'Bico', amount_cents: 200000, kind: 'recurring', start_month: '2026-02', end_month: '2026-03' },
  ],
  goals: [{ id: 1, resident_id: 'eu', name: 'Reserva', percent_bp: 1500 }],
  recurring: [
    { id: 1, resident_id: 'eu', category_id: 'diz', description: 'Dízimo', mode: 'percent', percent_bp: 1000, start_month: '2026-01', active: true },
    { id: 2, resident_id: null, category_id: 'mor', description: 'Aluguel', mode: 'fixed', amount_cents: 150000, start_month: '2026-01', active: true },
    { id: 3, resident_id: 'eu', category_id: null, description: 'Geladeira', mode: 'fixed', amount_cents: 30000, start_month: '2026-02', installments: 3, active: true },
    { id: 4, resident_id: null, category_id: 'mor', description: 'Pausado', mode: 'fixed', amount_cents: 999, start_month: '2026-01', active: false },
  ],
  transactions: [
    { id: 1, type: 'expense', resident_id: 'eu', category_id: 'mer', description: 'Mercado', amount_cents: 80000, date: '2026-03-10', created_by: 'u1' },
    { id: 2, type: 'expense', resident_id: null, category_id: 'mer', description: 'Feira', amount_cents: 5000, date: '2026-04-02', created_by: 'u1' },
  ],
  accounts: [], budgets: [],
};

test('ganhos do mês: mensais, únicos e com fim', () => {
  assert.equal(monthSummary(data, '2026-01').totals.income, 500000);
  assert.equal(monthSummary(data, '2026-03').totals.income, 800000);   // 5000 + 1000 + 2000
  assert.equal(monthSummary(data, '2026-04').totals.income, 500000);   // bico acabou em março
});

test('dízimo = 10% da renda do morador', () => {
  const m3 = monthSummary(data, '2026-03');
  assert.equal(m3.automatic.find((a) => a.description === 'Dízimo').amount, 60000);
});

test('parcelas mostram n/N e somem depois da última', () => {
  assert.equal(monthSummary(data, '2026-03').automatic.find((a) => a.description === 'Geladeira').detail, 'Parcela 2/3');
  assert.equal(monthSummary(data, '2026-05').automatic.find((a) => a.description === 'Geladeira'), undefined);
  assert.equal(recurringOccurrence(data.recurring[2], '2026-01'), null, 'antes do início');
});

test('desconto pausado não entra', () => {
  assert.equal(monthSummary(data, '2026-03').automatic.some((a) => a.description === 'Pausado'), false);
});

test('gastos do mês = lançados + automáticos; saldo', () => {
  const t = monthSummary(data, '2026-03').totals;
  assert.equal(t.expensesLaunched, 80000);
  assert.equal(t.automatic, 60000 + 150000 + 30000);
  assert.equal(t.expenses, 320000);
  assert.equal(t.balance, 800000 - 320000);
});

test('objetivo em % vira valor sobre a renda do morador', () => {
  const ana = monthSummary(data, '2026-03').residents.find((r) => r.id === 'eu');
  assert.equal(ana.goals[0].target, 90000);   // 15% de 6000
  assert.equal(ana.goalsPercentBp, 1500);
});

test('gastos por categoria ordenados e "Sem categoria"', () => {
  const cats = monthSummary(data, '2026-03').expensesByCategory;
  assert.deepEqual(cats.map((c) => c.category), ['Moradia', 'Mercado', 'Dízimo e ofertas', 'Sem categoria']);
});

test('tendência de 6 meses e utilidades', () => {
  const tr = trend(data, '2026-04', 6);
  assert.equal(tr.length, 6);
  assert.equal(tr[0].month, '2025-11');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(applyPercent(333, 1000), 33);
  assert.equal(incomeActive(data.incomes[1], '2026-04'), false);
});

test('contexto da IA tem os totais e não tem e-mails', () => {
  const ctx = buildContext('Casa', monthSummary(data, '2026-03'));
  assert.match(ctx, /ENTRADAS DO MÊS: R\$\s?8\.000,00/);
  assert.match(ctx, /SAÍDAS DO MÊS: R\$\s?3\.200,00/);
  assert.doesNotMatch(ctx, /@/);
});
