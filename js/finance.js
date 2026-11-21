// Cálculos financeiros (funções puras, testadas em tests/finance.test.mjs).
// Tudo em centavos (inteiros); percentuais em pontos-base (1000 = 10%); datas 'AAAA-MM-DD'; meses 'AAAA-MM'.
//
// Dois tipos de movimento:
//  - lançamentos (tabela transactions): entradas e saídas com data, conta e categoria;
//  - automáticos: rendas fixas (incomes) e descontos automáticos (recurring), que "acontecem"
//    sozinhos todo mês no dia informado (dia 1 se não houver).

export const monthIndex = (m) => {
  const [y, mm] = m.split('-').map(Number);
  return y * 12 + (mm - 1);
};
export const indexToMonth = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
export const addMonths = (m, n) => indexToMonth(monthIndex(m) + n);
export const applyPercent = (baseCents, bp) => Math.round((baseCents * bp) / 10000);
export const daysInMonth = (m) => {
  const [y, mm] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mm, 0)).getUTCDate();
};
export const dateFor = (m, day) => `${m}-${String(Math.min(Math.max(day || 1, 1), daysInMonth(m))).padStart(2, '0')}`;
export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
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

// Índice dos lançamentos por mês (calculado uma vez por lista).
const txIndexCache = new WeakMap();
function txByMonth(data) {
  const list = data.transactions ?? [];
  let idx = txIndexCache.get(list);
  if (!idx) {
    idx = new Map();
    for (const t of list) {
      const m = t.date.slice(0, 7);
      if (!idx.has(m)) idx.set(m, []);
      idx.get(m).push(t);
    }
    txIndexCache.set(list, idx);
  }
  return idx;
}

const txMovement = (t) => ({
  id: t.id, source: 'tx', type: t.type ?? 'expense', date: t.date, description: t.description,
  amount: Number(t.amount_cents), residentId: t.resident_id ?? null, accountId: t.account_id ?? null,
  categoryId: t.category_id ?? null, attachment: t.attachment_path ?? null, createdBy: t.created_by ?? null,
});

/** Renda do mês por morador (fixas + entradas lançadas) — base do dízimo e dos objetivos em %. */
export function incomeBase(data, month) {
  const byResident = new Map();
  let total = 0;
  const add = (rid, v) => {
    total += v;
    if (rid) byResident.set(rid, (byResident.get(rid) ?? 0) + v);
  };
  for (const i of data.incomes) if (incomeActive(i, month)) add(i.resident_id, Number(i.amount_cents));
  for (const t of txByMonth(data).get(month) ?? []) if (t.type === 'income') add(t.resident_id, Number(t.amount_cents));
  return { byResident, total };
}

/** Movimentos automáticos do mês (rendas fixas e descontos), cada um com a data em que acontece. */
export function automaticFor(data, month) {
  const out = [];
  for (const i of data.incomes) {
    if (!incomeActive(i, month)) continue;
    out.push({
      id: `auto:i:${i.id}:${month}`, source: 'auto', origin: 'income', refId: i.id, type: 'income',
      date: dateFor(month, i.day), description: i.description, amount: Number(i.amount_cents),
      detail: i.kind === 'recurring' ? 'Renda fixa' : 'Renda prevista',
      residentId: i.resident_id, accountId: i.account_id ?? null, categoryId: i.category_id ?? null,
    });
  }
  let base = null;
  for (const r of data.recurring) {
    const occ = recurringOccurrence(r, month);
    if (!occ) continue;
    let amount;
    let detail;
    if (r.mode === 'percent') {
      base ??= incomeBase(data, month);
      amount = applyPercent(r.resident_id ? (base.byResident.get(r.resident_id) ?? 0) : base.total, r.percent_bp);
      detail = `${pct(r.percent_bp)} da renda`;
    } else {
      amount = Number(r.amount_cents);
      detail = occ.installment ? `Parcela ${occ.installment}/${r.installments}` : 'Fixo mensal';
    }
    if (amount <= 0) continue;
    out.push({
      id: `auto:r:${r.id}:${month}`, source: 'auto', origin: 'recurring', refId: r.id, type: 'expense',
      date: dateFor(month, r.day), description: r.description, amount, detail,
      residentId: r.resident_id ?? null, accountId: r.account_id ?? null, categoryId: r.category_id ?? null,
    });
  }
  return out;
}

/** Todos os movimentos (lançados + automáticos) entre duas datas, inclusive, em ordem de data. */
export function movements(data, from, to, { automatic = true } = {}) {
  const out = [];
  const idx = txByMonth(data);
  for (let i = monthIndex(from.slice(0, 7)); i <= monthIndex(to.slice(0, 7)); i++) {
    const m = indexToMonth(i);
    for (const t of idx.get(m) ?? []) if (t.date >= from && t.date <= to) out.push(txMovement(t));
    if (automatic) for (const a of automaticFor(data, m)) if (a.date >= from && a.date <= to) out.push(a);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
export const signed = (mv) => (mv.type === 'income' ? mv.amount : -mv.amount);
export function sumBy(list) {
  let income = 0;
  let expense = 0;
  for (const m of list) {
    if (m.type === 'income') income += m.amount;
    else expense += m.amount;
  }
  return { income, expense, balance: income - expense };
}

/** Categoria "raiz" (a mãe, se for subcategoria). */
export function topCategory(categories, id) {
  const c = categories.find((x) => x.id === id);
  if (!c) return null;
  return c.parent_id ? categories.find((x) => x.id === c.parent_id) ?? c : c;
}

/**
 * Resumo do mês.
 * @param data { residents, incomes, goals, recurring, categories, transactions } — linhas do banco
 */
export function monthSummary(data, month) {
  const resName = new Map(data.residents.map((r) => [r.id, r.name]));
  const catLabel = (id) => topCategory(data.categories, id)?.name ?? 'Sem categoria';

  const all = movements(data, `${month}-01`, dateFor(month, 31));
  const automatic = all.filter((x) => x.source === 'auto' && x.type === 'expense').map((a) => ({
    ...a, resident: a.residentId ? resName.get(a.residentId) : 'Casa', category: catLabel(a.categoryId),
  }));
  const incomes = all.filter((x) => x.source === 'auto' && x.type === 'income').map((i) => ({
    ...i, resident: resName.get(i.residentId) ?? '—', kind: data.incomes.find((x) => x.id === i.refId)?.kind,
  }));
  const incomeTx = all.filter((x) => x.source === 'tx' && x.type === 'income').map((t) => ({
    ...t, resident: t.residentId ? resName.get(t.residentId) ?? 'Ex-morador' : 'Casa', category: catLabel(t.categoryId),
  })).reverse();
  const expenses = all.filter((x) => x.source === 'tx' && x.type === 'expense').map((e) => ({
    ...e, resident: e.residentId ? resName.get(e.residentId) ?? 'Ex-morador' : 'Casa', category: catLabel(e.categoryId),
  })).reverse();

  const base = incomeBase(data, month);
  const totalIncome = base.total;
  const totalAutomatic = automatic.reduce((s, a) => s + a.amount, 0);
  const totalLaunched = expenses.reduce((s, e) => s + e.amount, 0);
  const totalExpenses = totalAutomatic + totalLaunched;
  const outflows = [...expenses, ...automatic];

  const byCat = new Map();
  for (const x of outflows) byCat.set(x.category, (byCat.get(x.category) ?? 0) + x.amount);
  const expensesByCategory = [...byCat].map(([category, amount]) => ({
    category, amount, color: data.categories.find((c) => c.name === category && !c.parent_id && (c.type ?? 'expense') === 'expense')?.color ?? null,
  })).sort((a, b) => b.amount - a.amount);

  const residents = data.residents.map((r) => {
    const income = base.byResident.get(r.id) ?? 0;
    const goals = data.goals.filter((g) => g.resident_id === r.id).map((g) => ({
      id: g.id, name: g.name, percentBp: g.percent_bp, target: applyPercent(income, g.percent_bp),
    }));
    return {
      id: r.id, name: r.name, role: r.role, hasLogin: r.user_id != null, income,
      spent: outflows.filter((x) => x.residentId === r.id).reduce((s, x) => s + x.amount, 0),
      goals, goalsPercentBp: goals.reduce((s, g) => s + g.percentBp, 0), goalsTotal: goals.reduce((s, g) => s + g.target, 0),
    };
  });

  return {
    month,
    totals: {
      income: totalIncome,             // ENTRADAS DO MÊS (fixas + lançadas)
      incomeLaunched: incomeTx.reduce((s, i) => s + i.amount, 0),
      expenses: totalExpenses,         // SAÍDAS DO MÊS (lançadas + automáticas)
      expensesLaunched: totalLaunched,
      automatic: totalAutomatic,
      balance: totalIncome - totalExpenses,
      goals: residents.reduce((s, r) => s + r.goalsTotal, 0),
    },
    incomes, incomeTx, automatic, expenses, expensesByCategory, residents, movements: all,
  };
}

/** Entradas x saídas dos últimos n meses (até o mês informado). */
export function trend(data, month, n = 6) {
  const out = [];
  for (let k = n - 1; k >= 0; k--) {
    const m = addMonths(month, -k);
    const s = sumBy(movements(data, `${m}-01`, dateFor(m, 31)));
    out.push({ month: m, income: s.income, expenses: s.expense });
  }
  return out;
}

/** Primeiro mês com algum movimento (para calcular saldos desde o começo). */
function firstMonth(data) {
  let first = null;
  const see = (m) => {
    if (m && (!first || m < first)) first = m;
  };
  for (const t of data.transactions ?? []) see(t.date.slice(0, 7));
  for (const i of data.incomes) see(i.start_month);
  for (const r of data.recurring) see(r.start_month);
  return first;
}

/**
 * Saldo de cada conta numa data: saldo inicial + entradas − saídas (lançadas e automáticas) até a data.
 * Movimentos sem conta aparecem numa linha "Sem conta" (id null), para o total bater.
 */
export function accountBalances(data, date) {
  const rows = new Map(data.accounts.map((a) => [a.id, { account: a, id: a.id, balance: Number(a.opening_cents ?? 0), income: 0, expense: 0 }]));
  const none = { account: null, id: null, balance: 0, income: 0, expense: 0 };
  const from = firstMonth(data);
  if (from && from <= date.slice(0, 7)) {
    for (const mv of movements(data, `${from}-01`, date)) {
      const row = rows.get(mv.accountId) ?? none;
      row.balance += signed(mv);
      if (mv.type === 'income') row.income += mv.amount;
      else row.expense += mv.amount;
    }
  }
  const list = [...rows.values()];
  if (none.income || none.expense) list.push(none);
  return { accounts: list, total: list.reduce((s, r) => s + r.balance, 0) };
}

/** Limite de uma categoria no mês: o do mês, senão o padrão (month = null). */
export function budgetFor(budgets, categoryId, month) {
  return budgets.find((b) => b.category_id === categoryId && b.month === month)
    ?? budgets.find((b) => b.category_id === categoryId && !b.month) ?? null;
}

/** Planejado x realizado por categoria de saída (a mãe soma as subcategorias). */
export function budgetStatus(data, month) {
  const realized = new Map();
  for (const mv of movements(data, `${month}-01`, dateFor(month, 31))) {
    if (mv.type !== 'expense') continue;
    const top = topCategory(data.categories, mv.categoryId);
    const key = top?.id ?? null;
    realized.set(key, (realized.get(key) ?? 0) + mv.amount);
  }
  const rows = data.categories.filter((c) => (c.type ?? 'expense') === 'expense' && !c.parent_id).map((c) => {
    const b = budgetFor(data.budgets ?? [], c.id, month);
    const planned = b ? Number(b.amount_cents) : 0;
    const spent = realized.get(c.id) ?? 0;
    const ratio = planned ? spent / planned : null;
    return {
      category: c, planned, spent, remaining: planned - spent, ratio,
      budget: b, specific: !!b?.month,
      status: !planned ? 'none' : ratio > 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok',
    };
  });
  const withBudget = rows.filter((r) => r.planned);
  return {
    rows,
    planned: withBudget.reduce((s, r) => s + r.planned, 0),
    spent: withBudget.reduce((s, r) => s + r.spent, 0),
    unbudgeted: rows.filter((r) => !r.planned).reduce((s, r) => s + r.spent, 0) + (realized.get(null) ?? 0),
  };
}

const monthsBetween = (fromDate, toDate) => {
  const a = new Date(`${fromDate}T12:00:00Z`);
  const b = new Date(`${toDate}T12:00:00Z`);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + (b.getUTCDate() >= a.getUTCDate() ? 0 : -1);
};

/** Progresso de uma meta de economia. */
export function goalProgress(goal, deposits, today) {
  const mine = deposits.filter((d) => d.goal_id === goal.id);
  const saved = mine.reduce((s, d) => s + Number(d.amount_cents), 0);
  const target = Number(goal.target_cents);
  const remaining = Math.max(target - saved, 0);
  const ratio = target ? Math.min(Math.max(saved / target, 0), 1) : 0;
  let monthsLeft = null;
  let monthly = null;
  let status = saved >= target ? 'done' : 'active';
  if (goal.target_date && status !== 'done') {
    if (goal.target_date < today) status = 'late';
    else {
      monthsLeft = Math.max(monthsBetween(today, goal.target_date), 0) + 1;
      monthly = Math.ceil(remaining / monthsLeft);
    }
  }
  return { saved, target, remaining, ratio, monthsLeft, monthly, status, deposits: mine.sort((a, b) => (a.date < b.date ? 1 : -1)) };
}

/** Totais por dia do mês (para o calendário). */
export function calendarMonth(data, month) {
  const days = new Map();
  for (const mv of movements(data, `${month}-01`, dateFor(month, 31))) {
    if (!days.has(mv.date)) days.set(mv.date, { date: mv.date, income: 0, expense: 0, items: [] });
    const d = days.get(mv.date);
    d.items.push(mv);
    if (mv.type === 'income') d.income += mv.amount;
    else d.expense += mv.amount;
  }
  return days;
}

/** Categorias organizadas: mães em ordem alfabética, cada uma com as filhas. */
export function categoryTree(categories, type) {
  const mine = categories.filter((c) => (c.type ?? 'expense') === type);
  const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR');
  return mine.filter((c) => !c.parent_id).sort(byName).map((c) => ({ ...c, children: mine.filter((x) => x.parent_id === c.id).sort(byName) }));
}

/** Nível de permissão (0, 1, 2) de um morador num módulo — espelha public.perm() do banco. */
export const PERM_DEFAULTS = {
  painel: 1, lancamentos: 2, contas: 1, recorrentes: 2, categorias: 2, orcamento: 1, metas: 2, relatorios: 1, calendario: 1, ia: 1,
};
export function permOf(resident, module) {
  if (!resident) return 0;
  if (resident.role === 'admin') return 2;
  const v = resident.permissions?.[module];
  return v === 0 || v === 1 || v === 2 ? v : PERM_DEFAULTS[module] ?? 0;
}

const money = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Resumo em texto enviado à IA (sem e-mails ou dados de login). */
export function buildContext(houseName, s, fmt = money) {
  const L = [];
  L.push(`Casa: ${houseName} | Mês: ${s.month}`);
  L.push(`ENTRADAS DO MÊS: ${fmt(s.totals.income)} (fixas ${fmt(s.totals.income - s.totals.incomeLaunched)} + lançadas ${fmt(s.totals.incomeLaunched)})`);
  L.push(`SAÍDAS DO MÊS: ${fmt(s.totals.expenses)} (lançadas ${fmt(s.totals.expensesLaunched)} + automáticas ${fmt(s.totals.automatic)})`);
  L.push(`SALDO DO MÊS: ${fmt(s.totals.balance)}`, '', 'Moradores:');
  for (const r of s.residents) {
    L.push(`- ${r.name}: renda ${fmt(r.income)}, gastos individuais ${fmt(r.spent)}`);
    for (const g of r.goals) L.push(`    objetivo "${g.name}": ${pct(g.percentBp)} = ${fmt(g.target)}`);
  }
  L.push('', 'Saídas por categoria:');
  for (const c of s.expensesByCategory) L.push(`- ${c.category}: ${fmt(c.amount)}`);
  L.push('', 'Descontos automáticos:');
  for (const a of s.automatic) L.push(`- ${a.description} (${a.category}, ${a.resident}): ${fmt(a.amount)} — ${a.detail}`);
  L.push('', 'Entradas lançadas:');
  for (const e of s.incomeTx.slice(0, 50)) L.push(`- ${e.date} ${e.description} (${e.category}, ${e.resident}): ${fmt(e.amount)}`);
  L.push('', 'Saídas lançadas (até 150 mais recentes):');
  for (const e of s.expenses.slice(0, 150)) L.push(`- ${e.date} ${e.description} (${e.category}, ${e.resident}): ${fmt(e.amount)}`);
  return L.join('\n');
}
