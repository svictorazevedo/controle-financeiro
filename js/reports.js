// Os 8 relatórios prontos (funções puras). Cada um devolve colunas + linhas com valores crus
// (centavos, datas 'AAAA-MM-DD', meses 'AAAA-MM'); quem formata é a tela, o CSV ou o PDF.
import { movements, sumBy, addMonths, dateFor, addDays, accountBalances, signed, topCategory } from './finance.js';

export function labels(data) {
  const cat = new Map(data.categories.map((c) => [c.id, c]));
  const acc = new Map(data.accounts.map((a) => [a.id, a.name]));
  const res = new Map(data.residents.map((r) => [r.id, r.name]));
  return {
    category: (id) => {
      const c = cat.get(id);
      if (!c) return 'Sem categoria';
      const p = c.parent_id ? cat.get(c.parent_id) : null;
      return p ? `${p.name} › ${c.name}` : c.name;
    },
    account: (id) => (id ? acc.get(id) ?? 'Conta removida' : 'Sem conta'),
    resident: (id) => (id ? res.get(id) ?? 'Ex-morador' : 'Casa'),
  };
}

export const REPORTS = [
  { id: 'entradas', title: 'Entradas', desc: 'Todas as entradas do período, lançadas e fixas.', params: ['period'] },
  { id: 'saidas', title: 'Saídas', desc: 'Todas as saídas do período, lançadas e automáticas.', params: ['period'] },
  { id: 'mensal', title: 'Entradas x saídas mensal', desc: 'Comparação mês a mês no período.', params: ['period'] },
  { id: 'proximas-entradas', title: 'Próximas entradas', desc: 'O que vai entrar nos próximos dias.', params: ['ahead'] },
  { id: 'proximas-saidas', title: 'Próximas saídas', desc: 'Contas e parcelas a pagar nos próximos dias.', params: ['ahead'] },
  { id: 'totais-12', title: 'Totais mensais (12 meses)', desc: 'Entradas, saídas, resultado e acumulado.', params: ['month'] },
  { id: 'extrato', title: 'Extrato por conta', desc: 'Movimentos de uma conta com saldo dia a dia.', params: ['account', 'period'] },
  { id: 'categorias', title: 'Saídas por categoria', desc: 'Para onde foi o dinheiro no período.', params: ['period'] },
];

const listColumns = [
  { key: 'date', label: 'Data', type: 'date' },
  { key: 'description', label: 'Descrição', type: 'text' },
  { key: 'category', label: 'Categoria', type: 'text' },
  { key: 'account', label: 'Conta', type: 'text' },
  { key: 'resident', label: 'De', type: 'text' },
  { key: 'amount', label: 'Valor', type: 'money', align: 'right' },
];

function listRows(data, mvs, L) {
  return mvs.map((m) => ({
    date: m.date, description: m.source === 'auto' ? `${m.description} (${m.detail})` : m.description,
    category: L.category(m.categoryId), account: L.account(m.accountId), resident: L.resident(m.residentId), amount: m.amount,
  }));
}

/**
 * @param p { from, to, month, ahead, accountId, today }
 */
export function buildReport(id, data, p) {
  const L = labels(data);
  const period = `${p.from} a ${p.to}`;
  switch (id) {
    case 'entradas':
    case 'saidas': {
      const type = id === 'entradas' ? 'income' : 'expense';
      const mvs = movements(data, p.from, p.to).filter((m) => m.type === type);
      return {
        title: id === 'entradas' ? 'Entradas' : 'Saídas', subtitle: period, columns: listColumns, rows: listRows(data, mvs, L),
        footer: { description: `${mvs.length} lançamento(s)`, amount: mvs.reduce((s, m) => s + m.amount, 0) },
      };
    }
    case 'mensal':
    case 'totais-12': {
      const from = id === 'mensal' ? p.from.slice(0, 7) : addMonths(p.month, -11);
      const to = id === 'mensal' ? p.to.slice(0, 7) : p.month;
      const rows = [];
      let acc = 0;
      for (let m = from; m <= to; m = addMonths(m, 1)) {
        const s = sumBy(movements(data, `${m}-01`, dateFor(m, 31)));
        acc += s.balance;
        rows.push({ month: m, income: s.income, expense: s.expense, balance: s.balance, cumulative: acc });
      }
      const t = rows.reduce((a, r) => ({ income: a.income + r.income, expense: a.expense + r.expense }), { income: 0, expense: 0 });
      const columns = [
        { key: 'month', label: 'Mês', type: 'month' },
        { key: 'income', label: 'Entradas', type: 'money', align: 'right' },
        { key: 'expense', label: 'Saídas', type: 'money', align: 'right' },
        { key: 'balance', label: 'Resultado', type: 'money', align: 'right', signed: true },
      ];
      if (id === 'totais-12') columns.push({ key: 'cumulative', label: 'Acumulado', type: 'money', align: 'right', signed: true });
      return {
        title: id === 'mensal' ? 'Entradas x saídas mensal' : 'Totais mensais — 12 meses',
        subtitle: id === 'mensal' ? period : `${from} a ${to}`, columns, rows, chart: true,
        footer: { month: 'Total', income: t.income, expense: t.expense, balance: t.income - t.expense, cumulative: acc },
      };
    }
    case 'proximas-entradas':
    case 'proximas-saidas': {
      const type = id === 'proximas-entradas' ? 'income' : 'expense';
      const end = addDays(p.today, p.ahead);
      const mvs = movements(data, p.today, end).filter((m) => m.type === type);
      return {
        title: id === 'proximas-entradas' ? 'Próximas entradas' : 'Próximas saídas',
        subtitle: `De ${p.today} a ${end} (${p.ahead} dias)`,
        columns: [...listColumns.slice(0, 4), { key: 'origin', label: 'Origem', type: 'text' }, listColumns[5]],
        rows: mvs.map((m) => ({ ...listRows(data, [m], L)[0], origin: m.source === 'auto' ? 'Automático' : 'Lançado' })),
        footer: { description: `${mvs.length} previsto(s)`, amount: mvs.reduce((s, m) => s + m.amount, 0) },
      };
    }
    case 'extrato': {
      const account = data.accounts.find((a) => a.id === p.accountId) ?? data.accounts[0];
      if (!account) return { title: 'Extrato por conta', subtitle: 'Nenhuma conta cadastrada', columns: [], rows: [], footer: null };
      const before = accountBalances(data, addDays(p.from, -1)).accounts.find((r) => r.id === account.id)?.balance ?? Number(account.opening_cents);
      let bal = before;
      const mvs = movements(data, p.from, p.to).filter((m) => m.accountId === account.id);
      const rows = [{ date: p.from, description: 'Saldo anterior', category: '', amount: null, balance: before, muted: true }];
      for (const m of mvs) {
        bal += signed(m);
        rows.push({
          date: m.date, description: m.source === 'auto' ? `${m.description} (${m.detail})` : m.description,
          category: L.category(m.categoryId), amount: signed(m), balance: bal,
        });
      }
      const s = sumBy(mvs);
      return {
        title: `Extrato — ${account.name}`, subtitle: period, accountId: account.id,
        columns: [
          { key: 'date', label: 'Data', type: 'date' },
          { key: 'description', label: 'Descrição', type: 'text' },
          { key: 'category', label: 'Categoria', type: 'text' },
          { key: 'amount', label: 'Valor', type: 'money', align: 'right', signed: true },
          { key: 'balance', label: 'Saldo', type: 'money', align: 'right', signed: true },
        ],
        rows,
        footer: { description: 'Resultado do período / saldo final', amount: s.balance, balance: bal },
        summary: s,
      };
    }
    case 'categorias': {
      const mvs = movements(data, p.from, p.to).filter((m) => m.type === 'expense');
      const map = new Map();
      for (const m of mvs) {
        const top = topCategory(data.categories, m.categoryId);
        const key = top?.id ?? '';
        if (!map.has(key)) map.set(key, { category: top?.name ?? 'Sem categoria', color: top?.color ?? null, amount: 0, count: 0 });
        const r = map.get(key);
        r.amount += m.amount;
        r.count += 1;
      }
      const total = mvs.reduce((s, m) => s + m.amount, 0);
      const rows = [...map.values()].sort((a, b) => b.amount - a.amount).map((r) => ({ ...r, share: total ? r.amount / total : 0 }));
      return {
        title: 'Saídas por categoria', subtitle: period,
        columns: [
          { key: 'category', label: 'Categoria', type: 'text', swatch: 'color' },
          { key: 'count', label: 'Lançamentos', type: 'int', align: 'right' },
          { key: 'share', label: '% do total', type: 'percent', align: 'right' },
          { key: 'amount', label: 'Valor', type: 'money', align: 'right' },
        ],
        rows, footer: { category: 'Total', count: mvs.length, share: total ? 1 : 0, amount: total },
      };
    }
    default:
      throw new Error('Relatório desconhecido.');
  }
}
