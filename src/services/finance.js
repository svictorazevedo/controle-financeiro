// Cálculos financeiros do mês. Tudo em centavos (inteiros).

export const monthIndex = (m) => {
  const [y, mm] = m.split('-').map(Number);
  return y * 12 + (mm - 1);
};
export const indexToMonth = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
export const addMonths = (m, n) => indexToMonth(monthIndex(m) + n);
export const currentMonth = () => new Date().toISOString().slice(0, 7);

/** Valor de um percentual (pontos-base) sobre uma base em centavos, arredondado. */
export const applyPercent = (baseCents, bp) => Math.round((baseCents * bp) / 10000);

/**
 * Um desconto automático está ativo no mês?
 * - começa em start_month;
 * - termina em end_month (se houver);
 * - com N parcelas, some do painel depois da última parcela.
 */
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

export function createFinance(db) {
  const q = {
    residents: db.prepare('SELECT id, name, role, user_id FROM residents WHERE house_id = ? ORDER BY id'),
    incomes: db.prepare(`SELECT i.* FROM incomes i JOIN residents r ON r.id = i.resident_id WHERE r.house_id = ?`),
    goals: db.prepare(`SELECT g.* FROM goals g JOIN residents r ON r.id = g.resident_id WHERE r.house_id = ? ORDER BY g.id`),
    recurring: db.prepare('SELECT * FROM recurring WHERE house_id = ?'),
    categories: db.prepare('SELECT id, name FROM categories WHERE house_id = ?'),
    expenses: db.prepare(`SELECT * FROM expenses WHERE house_id = ? AND date >= ? AND date < ? ORDER BY date DESC, id DESC`),
  };

  /** Resumo completo de um mês para uma casa. */
  function monthSummary(houseId, month, preload) {
    const data = preload ?? {
      residents: q.residents.all(houseId),
      incomes: q.incomes.all(houseId),
      goals: q.goals.all(houseId),
      recurring: q.recurring.all(houseId),
      categories: q.categories.all(houseId),
    };
    const catName = new Map(data.categories.map((c) => [c.id, c.name]));
    const resName = new Map(data.residents.map((r) => [r.id, r.name]));

    // ---- GANHOS DO MÊS ----
    const incomes = data.incomes.filter((i) => incomeActive(i, month)).map((i) => ({
      id: i.id, residentId: i.resident_id, resident: resName.get(i.resident_id),
      description: i.description, amount: i.amount_cents, kind: i.kind,
    }));
    const incomeByResident = new Map();
    for (const i of incomes) incomeByResident.set(i.residentId, (incomeByResident.get(i.residentId) ?? 0) + i.amount);
    const totalIncome = incomes.reduce((s, i) => s + i.amount, 0);

    // ---- DESCONTOS AUTOMÁTICOS DO MÊS ----
    const automatic = [];
    for (const r of data.recurring) {
      const occ = recurringOccurrence(r, month);
      if (!occ) continue;
      let amount;
      let detail;
      if (r.mode === 'percent') {
        const base = r.resident_id ? (incomeByResident.get(r.resident_id) ?? 0) : totalIncome;
        amount = applyPercent(base, r.percent_bp);
        detail = `${(r.percent_bp / 100).toLocaleString('pt-BR')}% da renda ${r.resident_id ? 'de ' + resName.get(r.resident_id) : 'da casa'}`;
      } else {
        amount = r.amount_cents;
        detail = occ.installment ? `Parcela ${occ.installment}/${r.installments}` : 'Fixo mensal';
      }
      if (amount <= 0) continue;
      automatic.push({
        id: r.id, description: r.description, amount, detail,
        residentId: r.resident_id, resident: r.resident_id ? resName.get(r.resident_id) : 'Casa',
        categoryId: r.category_id, category: catName.get(r.category_id) ?? 'Sem categoria',
        installment: occ.installment, installments: r.installments,
      });
    }

    // ---- GASTOS LANÇADOS NO MÊS ----
    const expenses = (preload?.expensesFor?.(month) ?? q.expenses.all(houseId, `${month}-01`, `${addMonths(month, 1)}-01`)).map((e) => ({
      id: e.id, description: e.description, amount: e.amount_cents, date: e.date,
      residentId: e.resident_id, resident: e.resident_id ? resName.get(e.resident_id) ?? 'Ex-morador' : 'Casa',
      categoryId: e.category_id, category: catName.get(e.category_id) ?? 'Sem categoria', createdBy: e.created_by,
    }));

    const totalAutomatic = automatic.reduce((s, a) => s + a.amount, 0);
    const totalExpensesLaunched = expenses.reduce((s, e) => s + e.amount, 0);
    const totalExpenses = totalAutomatic + totalExpensesLaunched;

    // Gastos por categoria (lançados + automáticos)
    const byCat = new Map();
    for (const x of [...expenses, ...automatic]) byCat.set(x.category, (byCat.get(x.category) ?? 0) + x.amount);
    const expensesByCategory = [...byCat].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount);

    // Por morador, com objetivos (% da renda do morador)
    const residents = data.residents.map((r) => {
      const income = incomeByResident.get(r.id) ?? 0;
      const spent = [...expenses, ...automatic].filter((x) => x.residentId === r.id).reduce((s, x) => s + x.amount, 0);
      const goals = data.goals.filter((g) => g.resident_id === r.id).map((g) => ({
        id: g.id, name: g.name, percentBp: g.percent_bp, target: applyPercent(income, g.percent_bp),
      }));
      return {
        id: r.id, name: r.name, role: r.role, hasLogin: r.user_id != null, income, spent,
        goals, goalsPercentBp: goals.reduce((s, g) => s + g.percentBp, 0),
        goalsTotal: goals.reduce((s, g) => s + g.target, 0),
      };
    });
    const sharedSpent = [...expenses, ...automatic].filter((x) => !x.residentId).reduce((s, x) => s + x.amount, 0);

    return {
      month,
      totals: {
        income: totalIncome,               // GANHOS DO MÊS
        expenses: totalExpenses,           // GASTOS DO MÊS (lançados + automáticos)
        expensesLaunched: totalExpensesLaunched,
        automatic: totalAutomatic,
        balance: totalIncome - totalExpenses,
        goals: residents.reduce((s, r) => s + r.goalsTotal, 0),
        sharedSpent,
      },
      incomes, automatic, expenses, expensesByCategory, residents,
    };
  }

  /** Ganhos x gastos dos últimos N meses (até o mês informado). */
  function trend(houseId, month, n = 6) {
    const preload = {
      residents: q.residents.all(houseId),
      incomes: q.incomes.all(houseId),
      goals: q.goals.all(houseId),
      recurring: q.recurring.all(houseId),
      categories: q.categories.all(houseId),
    };
    const out = [];
    for (let k = n - 1; k >= 0; k--) {
      const m = addMonths(month, -k);
      const s = monthSummary(houseId, m, preload);
      out.push({ month: m, income: s.totals.income, expenses: s.totals.expenses });
    }
    return out;
  }

  return { monthSummary, trend };
}
