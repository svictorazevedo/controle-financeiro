// Cálculos financeiros do mês (funções puras, testadas em tests/finance.test.mjs).
// Tudo em centavos (inteiros); percentuais em pontos-base (1000 = 10%).

export const monthIndex = (m) => {
  const [y, mm] = m.split('-').map(Number);
  return y * 12 + (mm - 1);
};
export const indexToMonth = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
export const addMonths = (m, n) => indexToMonth(monthIndex(m) + n);
export const applyPercent = (baseCents, bp) => Math.round((baseCents * bp) / 10000);
const pct = (bp) => `${(bp / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

/** Um desconto automático vale no mês? Parcelas somem depois da última. */
export function recurringOccurrence(rule, month) {
  if (!rule.active) return null;
  const idx = monthIndex(month) - monthIndex(rule.start_month);
  if (idx < 0) return null;
  if (rule.end_month && monthIndex(month) > monthIndex(rule.end_month)) return null;
  if (rule.installments && idx >= rule.installments) return null;
  return { installment: rule.installments ? idx + 1 : null };
}

export function incomeActive(inc, month) {
  if (inc.kind === 'once') return inc.start_month === month;
  if (monthIndex(month) < monthIndex(inc.start_month)) return false;
  return !inc.end_month || monthIndex(month) <= monthIndex(inc.end_month);
}

/**
 * Resumo do mês.
 * @param data { residents, incomes, goals, recurring, categories, expenses } — linhas do banco
 */
export function monthSummary(data, month) {
  const catName = new Map(data.categories.map((c) => [c.id, c.name]));
  const resName = new Map(data.residents.map((r) => [r.id, r.name]));

  // GANHOS DO MÊS
  const incomes = data.incomes.filter((i) => incomeActive(i, month)).map((i) => ({
    id: i.id, residentId: i.resident_id, resident: resName.get(i.resident_id) ?? '—',
    description: i.description, amount: Number(i.amount_cents), kind: i.kind,
  }));
  const incomeByResident = new Map();
  for (const i of incomes) incomeByResident.set(i.residentId, (incomeByResident.get(i.residentId) ?? 0) + i.amount);
  const totalIncome = incomes.reduce((s, i) => s + i.amount, 0);

  // DESCONTOS AUTOMÁTICOS DO MÊS
  const automatic = [];
  for (const r of data.recurring) {
    const occ = recurringOccurrence(r, month);
    if (!occ) continue;
    let amount;
    let detail;
    if (r.mode === 'percent') {
      const base = r.resident_id ? (incomeByResident.get(r.resident_id) ?? 0) : totalIncome;
      amount = applyPercent(base, r.percent_bp);
      detail = `${pct(r.percent_bp)} da renda ${r.resident_id ? `de ${resName.get(r.resident_id)}` : 'da casa'}`;
    } else {
      amount = Number(r.amount_cents);
      detail = occ.installment ? `Parcela ${occ.installment}/${r.installments}` : 'Fixo mensal';
    }
    if (amount <= 0) continue;
    automatic.push({
      id: r.id, description: r.description, amount, detail,
      residentId: r.resident_id, resident: r.resident_id ? resName.get(r.resident_id) : 'Casa',
      categoryId: r.category_id, category: catName.get(r.category_id) ?? 'Sem categoria',
    });
  }

  // GASTOS LANÇADOS NO MÊS
  const expenses = data.expenses.filter((e) => e.date.startsWith(month)).map((e) => ({
    id: e.id, description: e.description, amount: Number(e.amount_cents), date: e.date,
    residentId: e.resident_id, resident: e.resident_id ? resName.get(e.resident_id) ?? 'Ex-morador' : 'Casa',
    categoryId: e.category_id, category: catName.get(e.category_id) ?? 'Sem categoria', createdBy: e.created_by,
  })).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const totalAutomatic = automatic.reduce((s, a) => s + a.amount, 0);
  const totalLaunched = expenses.reduce((s, e) => s + e.amount, 0);
  const totalExpenses = totalAutomatic + totalLaunched;
  const all = [...expenses, ...automatic];

  const byCat = new Map();
  for (const x of all) byCat.set(x.category, (byCat.get(x.category) ?? 0) + x.amount);
  const expensesByCategory = [...byCat].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);

  const residents = data.residents.map((r) => {
    const income = incomeByResident.get(r.id) ?? 0;
    const goals = data.goals.filter((g) => g.resident_id === r.id).map((g) => ({
      id: g.id, name: g.name, percentBp: g.percent_bp, target: applyPercent(income, g.percent_bp),
    }));
    return {
      id: r.id, name: r.name, role: r.role, hasLogin: r.user_id != null, income,
      spent: all.filter((x) => x.residentId === r.id).reduce((s, x) => s + x.amount, 0),
      goals, goalsPercentBp: goals.reduce((s, g) => s + g.percentBp, 0), goalsTotal: goals.reduce((s, g) => s + g.target, 0),
    };
  });

  return {
    month,
    totals: {
      income: totalIncome,            // GANHOS DO MÊS
      expenses: totalExpenses,        // GASTOS DO MÊS (lançados + automáticos)
      expensesLaunched: totalLaunched,
      automatic: totalAutomatic,
      balance: totalIncome - totalExpenses,
      goals: residents.reduce((s, r) => s + r.goalsTotal, 0),
    },
    incomes, automatic, expenses, expensesByCategory, residents,
  };
}

/** Ganhos x gastos dos últimos n meses (até o mês informado). */
export function trend(data, month, n = 6) {
  const out = [];
  for (let k = n - 1; k >= 0; k--) {
    const m = addMonths(month, -k);
    const s = monthSummary(data, m);
    out.push({ month: m, income: s.totals.income, expenses: s.totals.expenses });
  }
  return out;
}

const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Resumo em texto enviado à IA (sem e-mails ou dados de login). */
export function buildContext(houseName, s) {
  const L = [];
  L.push(`Casa: ${houseName} | Mês: ${s.month}`);
  L.push(`GANHOS DO MÊS: ${brl(s.totals.income)}`);
  L.push(`GASTOS DO MÊS: ${brl(s.totals.expenses)} (lançados ${brl(s.totals.expensesLaunched)} + automáticos ${brl(s.totals.automatic)})`);
  L.push(`SALDO: ${brl(s.totals.balance)}`, '', 'Moradores:');
  for (const r of s.residents) {
    L.push(`- ${r.name}: ganhos ${brl(r.income)}, gastos individuais ${brl(r.spent)}`);
    for (const g of r.goals) L.push(`    objetivo "${g.name}": ${pct(g.percentBp)} = ${brl(g.target)}`);
  }
  L.push('', 'Gastos por categoria:');
  for (const c of s.expensesByCategory) L.push(`- ${c.category}: ${brl(c.amount)}`);
  L.push('', 'Descontos automáticos:');
  for (const a of s.automatic) L.push(`- ${a.description} (${a.category}, ${a.resident}): ${brl(a.amount)} — ${a.detail}`);
  L.push('', 'Gastos lançados (até 150 mais recentes):');
  for (const e of s.expenses.slice(0, 150)) L.push(`- ${e.date} ${e.description} (${e.category}, ${e.resident}): ${brl(e.amount)}`);
  return L.join('\n');
}
