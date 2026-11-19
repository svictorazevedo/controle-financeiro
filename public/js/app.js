// Controle Financeiro — front-end sem dependências.
// Segurança: todo conteúdo vindo do usuário é inserido com textContent (nunca innerHTML).
import { trendChart, categoryBars } from './charts.js';
import { h, $, brl, parseMoney, centsToInput, parsePercent, bpToText, monthLabel, toast, clear } from './ui.js';

const state = {
  user: null,
  csrf: '',
  houses: [],
  houseId: null,
  house: null,
  month: new Date().toISOString().slice(0, 7),
  allowRegistration: true,
  chat: [],
};

try {
  const saved = localStorage.getItem('houseId');
  if (saved) state.houseId = Number(saved);
} catch { /* armazenamento indisponível */ }

// ---------------------------------------------------------------- API
async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (method !== 'GET') {
    opts.headers['content-type'] = 'application/json';
    opts.headers['x-csrf-token'] = state.csrf;
    opts.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch { /* sem corpo */ }
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    state.user = null;
    location.hash = '#/login';
    throw new Error('Sua sessão expirou. Entre novamente.');
  }
  if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);
  return data;
}
const hapi = (method, path, body) => api(method, `/api/houses/${state.houseId}${path}`, body);

/** Executa uma ação mostrando erros como aviso, desabilitando o botão durante o envio. */
async function run(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const out = await fn();
    if (okMsg) toast(okMsg);
    return out;
  } catch (e) {
    toast(e.message, true);
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadMe() {
  const me = await api('GET', '/api/auth/me');
  state.allowRegistration = me.allowRegistration ?? true;
  state.user = me.user;
  state.csrf = me.csrf || '';
  state.houses = me.houses || [];
  if (state.user && !state.houses.some((x) => x.id === state.houseId)) state.houseId = state.houses[0]?.id ?? null;
}

async function loadHouse() {
  state.house = state.houseId ? await hapi('GET', '') : null;
  try {
    localStorage.setItem('houseId', String(state.houseId ?? ''));
  } catch { /* ignore */ }
}

const isAdmin = () => state.house?.me.role === 'admin';
const myResidentId = () => state.house?.me.residentId;
const residentsOptions = (withHouse) => [
  ...(withHouse ? [{ value: '', label: '🏠 Casa (compartilhado)' }] : []),
  ...state.house.residents
    .filter((r) => isAdmin() || r.id === myResidentId() || withHouse === 'all')
    .map((r) => ({ value: String(r.id), label: r.name })),
];
const categoryOptions = () => [{ value: '', label: 'Sem categoria' }, ...state.house.categories.map((c) => ({ value: String(c.id), label: c.name }))];
const residentName = (id) => state.house.residents.find((r) => r.id === id)?.name ?? 'Casa';
const categoryName = (id) => state.house.categories.find((c) => c.id === id)?.name ?? 'Sem categoria';

// ---------------------------------------------------------------- componentes de formulário
function field(label, input, cls = '') {
  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h('div', { class: `field ${cls}` }, h('label', { for: id }, label), input);
}
const input = (name, attrs = {}) => h('input', { name, ...attrs });
function select(name, options, value = '') {
  const el = h('select', { name }, ...options.map((o) => h('option', { value: o.value }, o.label)));
  el.value = value;
  return el;
}
function deleteButton(label, onConfirm) {
  return h('button', {
    type: 'button', class: 'btn small danger',
    onclick: async (ev) => {
      if (!confirm(`Excluir "${label}"?`)) return;
      await run(ev.currentTarget, onConfirm, 'Excluído.');
      render();
    },
  }, 'Excluir');
}

// ---------------------------------------------------------------- autenticação
function renderAuth(mode) {
  const app = $('#app');
  clear(app);
  $('#topbar').hidden = true;
  const isLogin = mode === 'login';
  const err = h('div', { class: 'error', hidden: true });
  const form = h('form', { autocomplete: 'on' },
    !isLogin && field('Seu nome', input('name', { required: true, maxlength: 80, autocomplete: 'name' })),
    field('E-mail', input('email', { type: 'email', required: true, maxlength: 254, autocomplete: 'email' })),
    field('Senha', input('password', { type: 'password', required: true, minlength: isLogin ? 1 : 10, maxlength: 128, autocomplete: isLogin ? 'current-password' : 'new-password' })),
    !isLogin && field(state.allowRegistration ? 'Código de convite (opcional)' : 'Código de convite', input('inviteCode', { maxlength: 20, required: !state.allowRegistration, autocomplete: 'off' })),
    !isLogin && h('p', { class: 'hint' }, 'Senha com pelo menos 10 caracteres, misturando letras e números.'),
    err,
    h('button', { class: 'btn', type: 'submit' }, isLogin ? 'Entrar' : 'Criar conta'),
  );
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    const data = Object.fromEntries(new FormData(form));
    try {
      await api('POST', isLogin ? '/api/auth/login' : '/api/auth/register', data);
      await loadMe();
      location.hash = '#/painel';
      await render();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
  app.append(h('div', { class: 'auth card' },
    h('h1', {}, isLogin ? '💰 Entrar' : '💰 Criar conta'),
    form,
    h('p', { class: 'center hint' }, isLogin
      ? h('a', { href: '#/cadastro' }, 'Não tem conta? Cadastre-se')
      : h('a', { href: '#/login' }, 'Já tem conta? Entrar')),
  ));
}

// ---------------------------------------------------------------- shell / navegação
const ROUTES = [
  ['painel', 'Painel'], ['gastos', 'Gastos'], ['ganhos', 'Ganhos e objetivos'],
  ['automaticos', 'Descontos automáticos'], ['categorias', 'Categorias'], ['ia', 'Assistente IA'], ['casa', 'Casa e conta'],
];

function renderShell(route) {
  $('#topbar').hidden = false;
  const nav = $('#nav');
  clear(nav);
  for (const [key, label] of ROUTES) {
    nav.append(h('a', { href: `#/${key}`, 'aria-current': key === route ? 'page' : null }, label));
  }
  const sel = $('#house-select');
  clear(sel);
  for (const x of state.houses) sel.append(h('option', { value: String(x.id) }, x.name));
  sel.value = String(state.houseId);
  sel.hidden = state.houses.length < 2;
  $('#month-input').value = state.month;
}

$('#house-select').addEventListener('change', async (e) => {
  state.houseId = Number(e.target.value);
  state.chat = [];
  await render();
});
$('#month-input').addEventListener('change', (e) => {
  if (/^\d{4}-\d{2}$/.test(e.target.value)) {
    state.month = e.target.value;
    render();
  }
});
$('#logout-btn').addEventListener('click', async () => {
  await run(null, () => api('POST', '/api/auth/logout'));
  state.user = null;
  state.chat = [];
  location.hash = '#/login';
});

function page(title, ...children) {
  const app = $('#app');
  clear(app);
  app.append(h('h1', {}, title), ...children);
}

// ---------------------------------------------------------------- sem casa
function renderNoHouse() {
  $('#topbar').hidden = false;
  clear($('#nav'));
  const create = h('form', { class: 'inline' },
    field('Nome da casa', input('name', { required: true, maxlength: 80, placeholder: 'Ex.: Casa da Família Silva' })),
    h('button', { class: 'btn', type: 'submit' }, 'Criar casa'));
  create.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await run(create.querySelector('button'), () => api('POST', '/api/houses', Object.fromEntries(new FormData(create))), 'Casa criada!');
    if (ok) {
      state.houseId = ok.id;
      await loadMe();
      render();
    }
  });
  const join = h('form', { class: 'inline' },
    field('Código de convite', input('code', { required: true, maxlength: 20, placeholder: 'XXXX-XXXX-XXXX', autocomplete: 'off' })),
    h('button', { class: 'btn ghost', type: 'submit' }, 'Entrar na casa'));
  join.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await run(join.querySelector('button'), () => api('POST', '/api/houses/join', Object.fromEntries(new FormData(join))), 'Você entrou na casa!');
    if (ok) {
      state.houseId = ok.id;
      await loadMe();
      render();
    }
  });
  page(`Olá, ${state.user.name}!`,
    h('div', { class: 'grid cols-2' },
      h('section', { class: 'card' }, h('h2', {}, 'Cadastrar uma casa'), h('p', { class: 'muted' }, 'Você será o administrador e poderá adicionar os moradores.'), create),
      h('section', { class: 'card' }, h('h2', {}, 'Fui convidado'), h('p', { class: 'muted' }, 'Use o código que o administrador da casa gerou para você.'), join)));
}

// ---------------------------------------------------------------- painel
async function renderDashboard() {
  const d = await hapi('GET', `/dashboard?month=${state.month}`);
  const t = d.totals;
  const negative = t.balance < 0;

  const kpis = h('div', { class: 'grid cols-3' },
    h('section', { class: 'card kpi' },
      h('div', { class: 'label' }, h('span', { class: 'swatch', style: { background: 'var(--series-income)' } }), 'Ganhos do mês'),
      h('div', { class: 'value num' }, brl(t.income)),
      h('div', { class: 'sub' }, `${d.incomes.length} entrada(s) em ${monthLabel(d.month)}`)),
    h('section', { class: 'card kpi' },
      h('div', { class: 'label' }, h('span', { class: 'swatch', style: { background: 'var(--series-expense)' } }), 'Gastos do mês'),
      h('div', { class: 'value num' }, brl(t.expenses)),
      h('div', { class: 'sub' }, `Lançados ${brl(t.expensesLaunched)} + automáticos ${brl(t.automatic)}`)),
    h('section', { class: `card kpi ${negative ? 'negative' : ''}` },
      h('div', { class: 'label' }, 'Saldo do mês'),
      h('div', { class: 'value num' }, `${negative ? '▼ ' : ''}${brl(t.balance)}`),
      h('div', { class: 'sub' }, negative ? 'Atenção: os gastos passaram os ganhos' : `Objetivos planejados: ${brl(t.goals)}`)),
  );

  // Ganhos do mês (lista)
  const incomeTable = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Morador'), h('th', {}, 'Descrição'), h('th', { class: 'num' }, 'Valor'))),
    h('tbody', {},
      ...d.incomes.map((i) => h('tr', {}, h('td', {}, i.resident), h('td', {}, i.description, ' ', h('span', { class: 'tag' }, i.kind === 'recurring' ? 'mensal' : 'único')), h('td', { class: 'num' }, brl(i.amount)))),
      h('tr', { class: 'total' }, h('td', { colspan: 2 }, 'Total de ganhos do mês'), h('td', { class: 'num' }, brl(t.income)))));

  // Gastos do mês (lançados + automáticos)
  const rows = [
    ...d.automatic.map((a) => ({ date: '—', desc: a.description, tag: a.detail, cat: a.category, who: a.resident, amount: a.amount })),
    ...d.expenses.map((e) => ({ date: e.date.split('-').reverse().join('/'), desc: e.description, tag: null, cat: e.category, who: e.resident, amount: e.amount })),
  ];
  const expenseTable = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Data'), h('th', {}, 'Descrição'), h('th', {}, 'Categoria'), h('th', {}, 'De'), h('th', { class: 'num' }, 'Valor'))),
    h('tbody', {},
      ...rows.map((x) => h('tr', {}, h('td', { class: 'num' }, x.date), h('td', {}, x.desc, x.tag ? h('span', { class: 'tag' }, ` ${x.tag}`) : null), h('td', {}, x.cat), h('td', {}, x.who), h('td', { class: 'num' }, brl(x.amount)))),
      h('tr', { class: 'total' }, h('td', { colspan: 4 }, 'Total de gastos do mês'), h('td', { class: 'num' }, brl(t.expenses)))));

  // Por morador + objetivos
  const residentCards = d.residents.map((r) => h('section', { class: 'card' },
    h('h2', {}, r.name, ' ', h('span', { class: 'tag' }, r.role === 'admin' ? 'admin' : 'morador')),
    h('table', {}, h('tbody', {},
      h('tr', {}, h('td', {}, 'Ganhos do mês'), h('td', { class: 'num' }, brl(r.income))),
      h('tr', {}, h('td', {}, 'Gastos individuais do mês'), h('td', { class: 'num' }, brl(r.spent))))),
    r.goals.length
      ? h('div', { class: 'stack' }, h('p', { class: 'hint' }, `Objetivos: ${bpToText(r.goalsPercentBp)} da renda = ${brl(r.goalsTotal)}`),
        ...r.goals.map((g) => h('div', {},
          h('div', { class: 'hbar', style: { gridTemplateColumns: '1fr auto' } }, h('span', {}, `${g.name} (${bpToText(g.percentBp)})`), h('span', { class: 'num' }, brl(g.target))),
          h('div', { class: 'goal-bar' }, h('div', { style: { width: `${g.percentBp / 100}%` } })))))
      : h('p', { class: 'hint' }, 'Sem objetivos cadastrados.')));

  page(`Painel — ${monthLabel(d.month)}`,
    h('div', { class: 'stack' },
      kpis,
      h('div', { class: 'grid cols-2' },
        h('section', { class: 'card' }, h('h2', {}, 'Gastos do mês por categoria'),
          d.expensesByCategory.length ? categoryBars(d.expensesByCategory) : h('p', { class: 'muted' }, 'Nenhum gasto neste mês.')),
        h('section', { class: 'card chart' }, h('h2', {}, 'Ganhos x gastos — últimos 6 meses'), trendChart(d.trend))),
      h('section', { class: 'card' }, h('h2', {}, `Ganhos do mês (${brl(t.income)})`),
        d.incomes.length ? h('div', { class: 'table-wrap' }, incomeTable) : h('p', { class: 'muted' }, 'Nenhum ganho neste mês. Cadastre em “Ganhos e objetivos”.')),
      h('section', { class: 'card' }, h('h2', {}, `Gastos do mês (${brl(t.expenses)})`),
        rows.length ? h('div', { class: 'table-wrap' }, expenseTable) : h('p', { class: 'muted' }, 'Nenhum gasto neste mês.')),
      h('div', { class: 'grid cols-3' }, ...residentCards)));
}

// ---------------------------------------------------------------- gastos
async function renderExpenses() {
  const list = await hapi('GET', `/expenses?month=${state.month}`);
  let editing = null;
  const today = new Date().toISOString().slice(0, 10);
  const defaultDate = today.startsWith(state.month) ? today : `${state.month}-01`;

  const f = {
    description: input('description', { required: true, maxlength: 120, placeholder: 'Ex.: Supermercado' }),
    amount: input('amount', { required: true, inputmode: 'decimal', placeholder: '0,00' }),
    date: input('date', { type: 'date', required: true, value: defaultDate }),
    categoryId: select('categoryId', categoryOptions()),
    residentId: select('residentId', residentsOptions(true), String(myResidentId())),
  };
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Adicionar gasto');
  const cancel = h('button', { class: 'btn ghost', type: 'button', hidden: true, onclick: () => reset() }, 'Cancelar');
  const form = h('form', { class: 'inline' },
    field('Descrição', f.description), field('Valor (R$)', f.amount, 'small'), field('Data', f.date, 'small'),
    field('Categoria', f.categoryId), field('De quem', f.residentId), submit, cancel);

  function reset() {
    editing = null;
    form.reset();
    f.date.value = defaultDate;
    f.residentId.value = String(myResidentId());
    submit.textContent = 'Adicionar gasto';
    cancel.hidden = true;
  }
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const amount = parseMoney(f.amount.value);
    if (!amount) return toast('Informe um valor válido, ex.: 125,90', true);
    const body = {
      description: f.description.value, amount, date: f.date.value,
      categoryId: f.categoryId.value ? Number(f.categoryId.value) : null,
      residentId: f.residentId.value ? Number(f.residentId.value) : null,
    };
    const ok = await run(submit, () => (editing ? hapi('PUT', `/expenses/${editing}`, body) : hapi('POST', '/expenses', body)), editing ? 'Gasto atualizado.' : 'Gasto adicionado.');
    if (ok) render();
  });

  const total = list.reduce((s, e) => s + e.amount, 0);
  const table = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Data'), h('th', {}, 'Descrição'), h('th', {}, 'Categoria'), h('th', {}, 'De'), h('th', { class: 'num' }, 'Valor'), h('th', {}))),
    h('tbody', {}, ...list.map((e) => h('tr', {},
      h('td', { class: 'num' }, e.date.split('-').reverse().join('/')), h('td', {}, e.description), h('td', {}, e.category), h('td', {}, e.resident),
      h('td', { class: 'num' }, brl(e.amount)),
      h('td', {}, h('div', { class: 'actions' },
        h('button', {
          type: 'button', class: 'btn small ghost',
          onclick: () => {
            editing = e.id;
            f.description.value = e.description;
            f.amount.value = centsToInput(e.amount);
            f.date.value = e.date;
            f.categoryId.value = e.categoryId ? String(e.categoryId) : '';
            f.residentId.value = e.residentId ? String(e.residentId) : '';
            submit.textContent = 'Salvar alteração';
            cancel.hidden = false;
            f.description.focus();
          },
        }, 'Editar'),
        deleteButton(e.description, () => hapi('DELETE', `/expenses/${e.id}`)))))),
      h('tr', { class: 'total' }, h('td', { colspan: 4 }, 'Total lançado no mês'), h('td', { class: 'num' }, brl(total)), h('td', {}))));

  page(`Gastos — ${monthLabel(state.month)}`,
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h2', {}, 'Lançar gasto'), form,
        h('p', { class: 'hint' }, 'Gastos que se repetem todo mês (aluguel, dízimo, parcelas) ficam em “Descontos automáticos” e entram sozinhos no painel.')),
      h('section', { class: 'card' }, h('h2', {}, 'Gastos lançados no mês'),
        list.length ? h('div', { class: 'table-wrap' }, table) : h('p', { class: 'muted' }, 'Nenhum gasto lançado neste mês.'))));
}

// ---------------------------------------------------------------- ganhos e objetivos
async function renderIncomes() {
  const [incomes, dash] = await Promise.all([hapi('GET', '/incomes'), hapi('GET', `/dashboard?month=${state.month}`)]);
  let editing = null;
  const mine = residentsOptions(false);

  const f = {
    residentId: select('residentId', mine, String(myResidentId())),
    description: input('description', { required: true, maxlength: 120, placeholder: 'Ex.: Salário' }),
    amount: input('amount', { required: true, inputmode: 'decimal', placeholder: '0,00' }),
    kind: select('kind', [{ value: 'recurring', label: 'Todo mês' }, { value: 'once', label: 'Só uma vez' }], 'recurring'),
    startMonth: input('startMonth', { type: 'month', required: true, value: state.month }),
    endMonth: input('endMonth', { type: 'month' }),
  };
  const endField = field('Até (opcional)', f.endMonth, 'small');
  f.kind.addEventListener('change', () => {
    endField.hidden = f.kind.value !== 'recurring';
  });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Adicionar ganho');
  const cancel = h('button', { class: 'btn ghost', type: 'button', hidden: true, onclick: () => render() }, 'Cancelar');
  const form = h('form', { class: 'inline' },
    field('Morador', f.residentId), field('Descrição', f.description), field('Valor (R$)', f.amount, 'small'),
    field('Frequência', f.kind, 'small'), field('A partir de', f.startMonth, 'small'), endField, submit, cancel);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const amount = parseMoney(f.amount.value);
    if (!amount) return toast('Informe um valor válido.', true);
    const body = {
      residentId: Number(f.residentId.value), description: f.description.value, amount, kind: f.kind.value,
      startMonth: f.startMonth.value, endMonth: f.kind.value === 'recurring' ? f.endMonth.value || null : null,
    };
    const ok = await run(submit, () => (editing ? hapi('PUT', `/incomes/${editing}`, body) : hapi('POST', '/incomes', body)), 'Ganho salvo.');
    if (ok) render();
  });

  const canEdit = (rid) => isAdmin() || rid === myResidentId();
  const incomeTable = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Morador'), h('th', {}, 'Descrição'), h('th', {}, 'Frequência'), h('th', {}, 'Período'), h('th', { class: 'num' }, 'Valor'), h('th', {}))),
    h('tbody', {}, ...incomes.map((i) => h('tr', {},
      h('td', {}, residentName(i.resident_id)), h('td', {}, i.description),
      h('td', {}, i.kind === 'recurring' ? 'Todo mês' : 'Uma vez'),
      h('td', {}, i.kind === 'once' ? monthLabel(i.start_month) : `desde ${monthLabel(i.start_month)}${i.end_month ? ` até ${monthLabel(i.end_month)}` : ''}`),
      h('td', { class: 'num' }, brl(i.amount_cents)),
      h('td', {}, canEdit(i.resident_id) ? h('div', { class: 'actions' },
        h('button', {
          type: 'button', class: 'btn small ghost',
          onclick: () => {
            editing = i.id;
            f.residentId.value = String(i.resident_id);
            f.description.value = i.description;
            f.amount.value = centsToInput(i.amount_cents);
            f.kind.value = i.kind;
            f.startMonth.value = i.start_month;
            f.endMonth.value = i.end_month || '';
            endField.hidden = i.kind !== 'recurring';
            submit.textContent = 'Salvar alteração';
            cancel.hidden = false;
            f.description.focus();
          },
        }, 'Editar'),
        deleteButton(i.description, () => hapi('DELETE', `/incomes/${i.id}`))) : null)))));

  // Objetivos
  const g = {
    residentId: select('residentId', mine, String(myResidentId())),
    name: input('name', { required: true, maxlength: 80, placeholder: 'Ex.: Reserva de emergência' }),
    percent: input('percent', { required: true, inputmode: 'decimal', placeholder: '10' }),
  };
  const gSubmit = h('button', { class: 'btn', type: 'submit' }, 'Adicionar objetivo');
  const goalForm = h('form', { class: 'inline' }, field('Morador', g.residentId), field('Objetivo', g.name), field('% da renda', g.percent, 'small'), gSubmit);
  goalForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const percentBp = parsePercent(g.percent.value);
    if (!percentBp) return toast('Informe um percentual entre 0,01 e 100.', true);
    const ok = await run(gSubmit, () => hapi('POST', '/goals', { residentId: Number(g.residentId.value), name: g.name.value, percentBp }), 'Objetivo salvo.');
    if (ok) render();
  });

  const goalsByResident = dash.residents.map((r) => h('section', { class: 'card' },
    h('h2', {}, r.name),
    h('p', { class: 'hint' }, `Renda em ${monthLabel(state.month)}: ${brl(r.income)} · objetivos somam ${bpToText(r.goalsPercentBp)} (${brl(r.goalsTotal)})`),
    r.goals.length ? h('table', {}, h('tbody', {}, ...r.goals.map((x) => h('tr', {},
      h('td', {}, x.name), h('td', { class: 'num' }, bpToText(x.percentBp)), h('td', { class: 'num' }, brl(x.target)),
      h('td', {}, canEdit(r.id) ? h('div', { class: 'actions' },
        h('button', {
          type: 'button', class: 'btn small ghost',
          onclick: async (ev) => {
            const val = prompt(`Novo percentual para "${x.name}" (ex.: 12,5):`, bpToText(x.percentBp).replace('%', ''));
            if (val === null) return;
            const bp = parsePercent(val);
            if (!bp) return toast('Percentual inválido.', true);
            const ok = await run(ev.currentTarget, () => hapi('PUT', `/goals/${x.id}`, { name: x.name, percentBp: bp }), 'Objetivo atualizado.');
            if (ok) render();
          },
        }, 'Editar %'),
        deleteButton(x.name, () => hapi('DELETE', `/goals/${x.id}`))) : null))))) : h('p', { class: 'muted' }, 'Nenhum objetivo.')));

  page('Ganhos e objetivos',
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h2', {}, 'Quanto cada um ganha'), form,
        h('p', { class: 'hint' }, 'Ganhos “todo mês” entram automaticamente em todos os meses a partir do mês inicial.')),
      h('section', { class: 'card' }, h('h2', {}, 'Ganhos cadastrados'),
        incomes.length ? h('div', { class: 'table-wrap' }, incomeTable) : h('p', { class: 'muted' }, 'Nenhum ganho cadastrado.')),
      h('section', { class: 'card' }, h('h2', {}, 'Objetivos (em % da renda)'), goalForm,
        h('p', { class: 'hint' }, 'Ex.: Reserva 10%, Investimentos 15%, Viagem 5%. O valor em reais é calculado sobre a renda do mês.')),
      h('div', { class: 'grid cols-3' }, ...goalsByResident)));
}

// ---------------------------------------------------------------- descontos automáticos
async function renderRecurring() {
  const list = await hapi('GET', '/recurring');
  let editing = null;
  const f = {
    description: input('description', { required: true, maxlength: 120, placeholder: 'Ex.: Aluguel' }),
    residentId: select('residentId', residentsOptions(isAdmin()), isAdmin() ? '' : String(myResidentId())),
    categoryId: select('categoryId', categoryOptions()),
    mode: select('mode', [{ value: 'fixed', label: 'Valor fixo (R$)' }, { value: 'percent', label: 'Percentual da renda (%)' }], 'fixed'),
    amount: input('amount', { inputmode: 'decimal', placeholder: '0,00' }),
    percent: input('percent', { inputmode: 'decimal', placeholder: '10' }),
    startMonth: input('startMonth', { type: 'month', required: true, value: state.month }),
    installments: input('installments', { type: 'number', min: 1, max: 600, placeholder: 'sem fim' }),
    endMonth: input('endMonth', { type: 'month' }),
    active: h('input', { type: 'checkbox', name: 'active', checked: true }),
  };
  const amountField = field('Valor (R$)', f.amount, 'small');
  const percentField = field('Percentual (%)', f.percent, 'small');
  const syncMode = () => {
    amountField.hidden = f.mode.value !== 'fixed';
    percentField.hidden = f.mode.value !== 'percent';
  };
  f.mode.addEventListener('change', syncMode);
  syncMode();

  const submit = h('button', { class: 'btn', type: 'submit' }, 'Adicionar desconto');
  const cancel = h('button', { class: 'btn ghost', type: 'button', hidden: true, onclick: () => render() }, 'Cancelar');
  const form = h('form', { class: 'inline' },
    field('Descrição', f.description), field('De quem', f.residentId), field('Categoria', f.categoryId),
    field('Tipo', f.mode), amountField, percentField,
    field('Início', f.startMonth, 'small'), field('Nº de parcelas', f.installments, 'small'), field('Fim (opcional)', f.endMonth, 'small'),
    h('div', { class: 'field small' }, h('span', { class: 'lbl' }, 'Ativo'), h('label', {}, f.active, ' sim')),
    submit, cancel);

  const preset = (desc, mode, catName, extra = {}) => () => {
    f.description.value = desc;
    f.mode.value = mode;
    const cat = state.house.categories.find((c) => c.name === catName);
    f.categoryId.value = cat ? String(cat.id) : '';
    if (extra.percent) f.percent.value = extra.percent;
    if (extra.resident) f.residentId.value = String(myResidentId());
    syncMode();
    (mode === 'fixed' ? f.amount : f.percent).focus();
  };
  const presets = h('div', { class: 'actions', style: { justifyContent: 'flex-start', flexWrap: 'wrap', marginBottom: '.75rem' } },
    h('span', { class: 'hint', style: { margin: '0 .25rem 0 0', alignSelf: 'center' } }, 'Atalhos:'),
    h('button', { type: 'button', class: 'btn small ghost', onclick: preset('Dízimo', 'percent', 'Dízimo e ofertas', { percent: '10', resident: true }) }, 'Dízimo 10%'),
    h('button', { type: 'button', class: 'btn small ghost', onclick: preset('Aluguel', 'fixed', 'Moradia') }, 'Aluguel'),
    h('button', { type: 'button', class: 'btn small ghost', onclick: preset('Compra parcelada', 'fixed', 'Outros') }, 'Parcelamento'),
    h('button', { type: 'button', class: 'btn small ghost', onclick: preset('Internet', 'fixed', 'Contas (água, luz, internet)') }, 'Conta fixa'),
    h('button', { type: 'button', class: 'btn small ghost', onclick: preset('Streaming', 'fixed', 'Assinaturas') }, 'Assinatura'));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = {
      description: f.description.value,
      residentId: f.residentId.value ? Number(f.residentId.value) : null,
      categoryId: f.categoryId.value ? Number(f.categoryId.value) : null,
      mode: f.mode.value,
      startMonth: f.startMonth.value,
      installments: f.installments.value ? Number(f.installments.value) : null,
      endMonth: f.endMonth.value || null,
      active: f.active.checked,
    };
    if (body.mode === 'fixed') {
      body.amount = parseMoney(f.amount.value);
      if (!body.amount) return toast('Informe o valor.', true);
    } else {
      body.percentBp = parsePercent(f.percent.value);
      if (!body.percentBp) return toast('Informe o percentual.', true);
    }
    const ok = await run(submit, () => (editing ? hapi('PUT', `/recurring/${editing}`, body) : hapi('POST', '/recurring', body)), 'Desconto salvo.');
    if (ok) render();
  });

  const mIdx = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5)) - 1;
  const status = (r) => {
    if (!r.active) return 'Pausado';
    const idx = mIdx(state.month) - mIdx(r.start_month);
    if (idx < 0) return `Começa em ${monthLabel(r.start_month)}`;
    if (r.end_month && state.month > r.end_month) return 'Encerrado';
    if (r.installments) return idx >= r.installments ? 'Quitado ✔' : `Parcela ${idx + 1}/${r.installments}`;
    return 'Ativo';
  };
  const canEdit = (r) => isAdmin() || (r.resident_id && r.resident_id === myResidentId());
  const table = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Descrição'), h('th', {}, 'De'), h('th', {}, 'Categoria'), h('th', { class: 'num' }, 'Valor'), h('th', {}, `Situação em ${monthLabel(state.month)}`), h('th', {}))),
    h('tbody', {}, ...list.map((r) => h('tr', {},
      h('td', {}, r.description), h('td', {}, r.resident_id ? residentName(r.resident_id) : 'Casa'), h('td', {}, categoryName(r.category_id)),
      h('td', { class: 'num' }, r.mode === 'fixed' ? brl(r.amount_cents) : `${bpToText(r.percent_bp)} da renda`),
      h('td', {}, h('span', { class: 'tag' }, status(r))),
      h('td', {}, canEdit(r) ? h('div', { class: 'actions' },
        h('button', {
          type: 'button', class: 'btn small ghost',
          onclick: () => {
            editing = r.id;
            f.description.value = r.description;
            f.residentId.value = r.resident_id ? String(r.resident_id) : '';
            f.categoryId.value = r.category_id ? String(r.category_id) : '';
            f.mode.value = r.mode;
            f.amount.value = r.amount_cents ? centsToInput(r.amount_cents) : '';
            f.percent.value = r.percent_bp ? String(r.percent_bp / 100).replace('.', ',') : '';
            f.startMonth.value = r.start_month;
            f.installments.value = r.installments ?? '';
            f.endMonth.value = r.end_month ?? '';
            f.active.checked = !!r.active;
            syncMode();
            submit.textContent = 'Salvar alteração';
            cancel.hidden = false;
            f.description.focus();
          },
        }, 'Editar'),
        deleteButton(r.description, () => hapi('DELETE', `/recurring/${r.id}`))) : null)))));

  page('Descontos automáticos',
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h2', {}, 'Novo desconto automático'), presets, form,
        h('p', { class: 'hint' }, 'Entram sozinhos nos gastos de cada mês. Dízimo: use “Percentual da renda”. Parcelas: informe o nº de parcelas — depois da última, o desconto some do painel. Aluguel: deixe sem fim (ou informe o mês final do contrato).')),
      h('section', { class: 'card' }, h('h2', {}, 'Descontos cadastrados'),
        list.length ? h('div', { class: 'table-wrap' }, table) : h('p', { class: 'muted' }, 'Nenhum desconto automático.'))));
}

// ---------------------------------------------------------------- categorias
async function renderCategories() {
  const cats = await hapi('GET', '/categories');
  const nameIn = input('name', { required: true, maxlength: 60, placeholder: 'Ex.: Academia' });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Adicionar categoria');
  const form = h('form', { class: 'inline' }, field('Nova categoria', nameIn), submit);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await run(submit, () => hapi('POST', '/categories', { name: nameIn.value }), 'Categoria criada.');
    if (ok) {
      await loadHouse();
      render();
    }
  });
  const table = h('table', {}, h('tbody', {}, ...cats.map((c) => h('tr', {},
    h('td', {}, c.name, c.is_default ? h('span', { class: 'tag' }, ' padrão') : null),
    h('td', {}, h('div', { class: 'actions' },
      h('button', {
        type: 'button', class: 'btn small ghost',
        onclick: async (ev) => {
          const val = prompt('Novo nome da categoria:', c.name);
          if (!val || val === c.name) return;
          const ok = await run(ev.currentTarget, () => hapi('PATCH', `/categories/${c.id}`, { name: val }), 'Categoria renomeada.');
          if (ok) {
            await loadHouse();
            render();
          }
        },
      }, 'Renomear'),
      isAdmin() ? deleteButton(c.name, async () => {
        await hapi('DELETE', `/categories/${c.id}`);
        await loadHouse();
      }) : null))))));
  page('Categorias',
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, form, h('p', { class: 'hint' }, 'As categorias padrão já vêm prontas — renomeie, exclua ou crie as suas. Ao excluir, os gastos ficam “Sem categoria”.')),
      h('section', { class: 'card' }, h('div', { class: 'table-wrap' }, table))));
}

// ---------------------------------------------------------------- casa e conta
async function renderHouse() {
  await loadHouse();
  const admin = isAdmin();
  const inviteBox = h('div');

  const resTable = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Morador'), h('th', {}, 'Papel'), h('th', {}, 'Login'), h('th', {}))),
    h('tbody', {}, ...state.house.residents.map((r) => {
      const roleSel = select('role', [{ value: 'member', label: 'Morador' }, { value: 'admin', label: 'Administrador' }], r.role);
      roleSel.disabled = !admin;
      roleSel.addEventListener('change', async () => {
        const ok = await run(null, () => hapi('PATCH', `/residents/${r.id}`, { role: roleSel.value }), 'Papel atualizado.');
        if (!ok) roleSel.value = r.role;
      });
      return h('tr', {},
        h('td', {}, r.name, r.id === myResidentId() ? h('span', { class: 'tag' }, ' você') : null),
        h('td', {}, roleSel),
        h('td', {}, r.hasLogin ? '✔ tem login' : r.invitePending ? 'convite pendente' : 'sem login'),
        h('td', {}, admin ? h('div', { class: 'actions' },
          !r.hasLogin ? h('button', {
            type: 'button', class: 'btn small ghost',
            onclick: async (ev) => {
              const out = await run(ev.currentTarget, () => hapi('POST', `/residents/${r.id}/invite`));
              if (!out) return;
              clear(inviteBox);
              inviteBox.append(h('div', { class: 'card' },
                h('p', {}, `Código de convite para ${r.name} (válido por ${out.expiresInHours}h, uso único):`),
                h('div', { class: 'code' }, out.code),
                h('p', { class: 'hint' }, 'Envie esse código por um canal seguro. A pessoa cria a conta e informa o código. Ele não será mostrado de novo.')));
            },
          }, 'Gerar convite') : null,
          r.id !== myResidentId() ? deleteButton(r.name, () => hapi('DELETE', `/residents/${r.id}`)) : null) : null));
    })));

  const newRes = input('name', { required: true, maxlength: 80, placeholder: 'Nome do morador' });
  const addBtn = h('button', { class: 'btn', type: 'submit' }, 'Adicionar morador');
  const addForm = h('form', { class: 'inline' }, field('Novo morador', newRes), addBtn);
  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await run(addBtn, () => hapi('POST', '/residents', { name: newRes.value }), 'Morador adicionado.');
    if (ok) render();
  });

  const houseName = input('name', { required: true, maxlength: 80, value: state.house.name });
  const renameBtn = h('button', { class: 'btn ghost', type: 'submit' }, 'Salvar nome');
  const renameForm = h('form', { class: 'inline' }, field('Nome da casa', houseName), renameBtn);
  renameForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await run(renameBtn, () => hapi('PATCH', '', { name: houseName.value }), 'Nome atualizado.');
    if (ok) {
      await loadMe();
      render();
    }
  });

  // Conta
  const cur = input('currentPassword', { type: 'password', required: true, autocomplete: 'current-password' });
  const nw = input('newPassword', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
  const pwBtn = h('button', { class: 'btn', type: 'submit' }, 'Trocar senha');
  const pwForm = h('form', { class: 'inline' }, field('Senha atual', cur), field('Nova senha', nw), pwBtn);
  pwForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await run(pwBtn, () => api('POST', '/api/auth/password', { currentPassword: cur.value, newPassword: nw.value }), 'Senha alterada. Outras sessões foram encerradas.');
    if (ok) pwForm.reset();
  });

  const extra = h('div', { class: 'grid cols-2' });
  const newHouse = input('name', { required: true, maxlength: 80, placeholder: 'Outra casa' });
  const nhBtn = h('button', { class: 'btn ghost', type: 'submit' }, 'Criar');
  const nhForm = h('form', { class: 'inline' }, field('Criar outra casa', newHouse), nhBtn);
  nhForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await run(nhBtn, () => api('POST', '/api/houses', { name: newHouse.value }), 'Casa criada.');
    if (ok) {
      state.houseId = ok.id;
      await loadMe();
      render();
    }
  });
  const code = input('code', { required: true, maxlength: 20, placeholder: 'XXXX-XXXX-XXXX', autocomplete: 'off' });
  const jBtn = h('button', { class: 'btn ghost', type: 'submit' }, 'Entrar');
  const jForm = h('form', { class: 'inline' }, field('Entrar em outra casa (convite)', code), jBtn);
  jForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await run(jBtn, () => api('POST', '/api/houses/join', { code: code.value }), 'Você entrou na casa.');
    if (ok) {
      state.houseId = ok.id;
      await loadMe();
      render();
    }
  });
  extra.append(h('section', { class: 'card' }, nhForm), h('section', { class: 'card' }, jForm));

  const danger = admin ? h('section', { class: 'card' },
    h('h2', {}, 'Zona de perigo'),
    h('p', { class: 'hint' }, 'Excluir a casa apaga todos os ganhos, gastos, objetivos e descontos dela. Não tem volta.'),
    h('button', {
      type: 'button', class: 'btn danger',
      onclick: async (ev) => {
        const typed = prompt(`Para confirmar, digite o nome da casa: ${state.house.name}`);
        if (typed === null) return;
        const ok = await run(ev.currentTarget, () => hapi('DELETE', '', { confirmName: typed }), 'Casa excluída.');
        if (ok) {
          await loadMe();
          location.hash = '#/painel';
          render();
        }
      },
    }, 'Excluir casa')) : null;

  page('Casa e conta',
    h('div', { class: 'stack' },
      admin ? h('section', { class: 'card' }, renameForm) : null,
      h('section', { class: 'card' }, h('h2', {}, `Moradores de ${state.house.name}`), h('div', { class: 'table-wrap' }, resTable),
        admin ? addForm : h('p', { class: 'hint' }, 'Apenas administradores adicionam moradores.'), inviteBox,
        admin ? h('p', { class: 'hint' }, 'Moradores sem login (ex.: crianças) podem ter ganhos e gastos lançados pelo administrador. Para dar acesso, gere um convite.') : null),
      h('section', { class: 'card' }, h('h2', {}, `Minha conta (${state.user.email})`), pwForm,
        h('p', {}, h('button', {
          type: 'button', class: 'btn small ghost',
          onclick: async (ev) => {
            const ok = await run(ev.currentTarget, () => api('POST', '/api/auth/logout-all'));
            if (ok) location.hash = '#/login';
          },
        }, 'Sair de todos os dispositivos'))),
      extra,
      danger));
}

// ---------------------------------------------------------------- IA
async function renderAI() {
  const { providers, settings } = await hapi('GET', '/ai');
  const admin = isAdmin();

  let config = null;
  if (admin) {
    const prov = select('provider', Object.entries(providers).map(([k, p]) => ({ value: k, label: p.label })), settings?.provider ?? 'anthropic');
    const model = input('model', { maxlength: 100, value: settings?.model ?? providers.anthropic.defaultModel });
    const baseUrl = input('baseUrl', { maxlength: 300, value: settings?.baseUrl ?? providers.openai.defaultBaseUrl });
    const key = input('apiKey', {
      type: 'password', autocomplete: 'off', maxlength: 500,
      placeholder: settings?.hasKey ? `salva (termina em …${settings.keyHint}) — deixe vazio para manter` : 'cole a chave de API',
    });
    const baseField = field('URL base (API compatível com OpenAI)', baseUrl);
    const sync = () => {
      baseField.hidden = prov.value !== 'openai';
      if (!settings || settings.provider !== prov.value) model.value = providers[prov.value].defaultModel;
    };
    prov.addEventListener('change', sync);
    baseField.hidden = prov.value !== 'openai';
    const save = h('button', { class: 'btn', type: 'submit' }, 'Salvar configuração');
    const form = h('form', { class: 'inline', autocomplete: 'off' }, field('Provedor', prov), field('Modelo', model), baseField, field('Chave de API', key), save);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const ok = await run(save, () => hapi('PUT', '/ai', { provider: prov.value, model: model.value, baseUrl: baseUrl.value, apiKey: key.value }), 'Configuração salva.');
      if (ok) render();
    });
    config = h('section', { class: 'card' }, h('h2', {}, 'Conexão com a IA (administrador)'), form,
      h('p', { class: 'hint' }, 'A chave fica criptografada no servidor (AES-256-GCM) e nunca é enviada de volta ao navegador. Claude: crie a chave em console.anthropic.com. Outros: OpenAI, OpenRouter, Groq, DeepSeek, Ollama local (com ALLOW_LOCAL_AI=true) ou Gemini.'),
      settings ? h('p', {}, h('button', {
        type: 'button', class: 'btn small danger',
        onclick: async (ev) => {
          if (!confirm('Remover a configuração e a chave de IA?')) return;
          const ok = await run(ev.currentTarget, () => hapi('DELETE', '/ai'), 'Configuração removida.');
          if (ok) render();
        },
      }, 'Remover configuração')) : null);
  }

  const chatBox = h('div', { class: 'chat', 'aria-live': 'polite' });
  const paint = () => {
    clear(chatBox);
    if (!state.chat.length) chatBox.append(h('p', { class: 'muted' }, 'Pergunte algo como: “Onde estou gastando mais este mês?”, “Consigo bater meus objetivos?” ou “Quanto posso cortar em lazer?”'));
    for (const m of state.chat) chatBox.append(h('div', { class: `msg ${m.role}` }, m.content));
    chatBox.scrollTop = chatBox.scrollHeight;
  };
  paint();
  const q = h('textarea', { name: 'q', maxlength: 4000, required: true, placeholder: 'Escreva sua pergunta…' });
  const send = h('button', { class: 'btn', type: 'submit' }, 'Enviar');
  const reset = h('button', { class: 'btn ghost', type: 'button', onclick: () => { state.chat = []; paint(); } }, 'Nova conversa');
  const chatForm = h('form', { class: 'stack' }, field(`Pergunta sobre ${monthLabel(state.month)}`, q), h('div', { class: 'actions' }, reset, send));
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });
  chatForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = q.value.trim();
    if (!text) return;
    state.chat.push({ role: 'user', content: text });
    if (state.chat.length > 19) state.chat = state.chat.slice(-19);
    while (state.chat[0]?.role !== 'user') state.chat.shift();
    q.value = '';
    paint();
    const thinking = h('div', { class: 'msg assistant muted' }, 'Pensando…');
    chatBox.append(thinking);
    const out = await run(send, () => hapi('POST', '/ai/chat', { month: state.month, messages: state.chat }));
    thinking.remove();
    if (out) state.chat.push({ role: 'assistant', content: out.answer });
    else state.chat.pop();
    paint();
  });

  page('Assistente de IA',
    h('div', { class: 'stack' },
      config,
      h('section', { class: 'card' },
        h('h2', {}, settings ? `Conversar (${providers[settings.provider]?.label ?? settings.provider} · ${settings.model})` : 'Conversar'),
        settings ? h('div', { class: 'stack' }, chatBox, chatForm,
          h('p', { class: 'hint' }, 'Ao perguntar, o resumo financeiro do mês (nomes dos moradores, ganhos, gastos, objetivos) é enviado ao provedor de IA configurado. E-mails e senhas nunca são enviados.'))
          : h('p', { class: 'muted' }, admin ? 'Configure a conexão acima para começar.' : 'Peça ao administrador da casa para configurar a IA.'))));
}

// ---------------------------------------------------------------- roteador
const PAGES = {
  painel: renderDashboard, gastos: renderExpenses, ganhos: renderIncomes, automaticos: renderRecurring,
  categorias: renderCategories, casa: renderHouse, ia: renderAI,
};

async function render() {
  const route = (location.hash.replace(/^#\/?/, '') || 'painel').split('?')[0];
  try {
    if (!state.user) {
      return renderAuth(route === 'cadastro' ? 'register' : 'login');
    }
    if (route === 'login' || route === 'cadastro') {
      location.hash = '#/painel';
      return;
    }
    if (!state.houseId) return renderNoHouse();
    if (!state.house || state.house.id !== state.houseId) await loadHouse();
    renderShell(PAGES[route] ? route : 'painel');
    await (PAGES[route] ?? renderDashboard)();
    $('#app').focus({ preventScroll: true });
  } catch (e) {
    page('Ops', h('div', { class: 'error' }, e.message));
  }
}

window.addEventListener('hashchange', render);
(async () => {
  try {
    await loadMe();
  } catch {
    state.user = null;
  }
  render();
})();
