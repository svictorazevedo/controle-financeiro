// Controle Financeiro — front-end estático (GitHub Pages) + Supabase.
// Segurança: todo conteúdo vindo do usuário entra na tela com textContent (nunca innerHTML),
// e quem decide o que cada um pode ler/alterar é o RLS do banco (supabase/schema.sql).
import { sb, q, configured, secretKeyError, callAi, friendly } from './api.js';
import { monthSummary, trend, addMonths, buildContext, monthIndex } from './finance.js';
import { trendChart, categoryBars } from './charts.js';
import { h, $, brl, parseMoney, centsToInput, parsePercent, bpToText, monthLabel, toast, clear } from './ui.js';

const state = {
  user: null,
  houses: [],        // [{ id, name, role, residentId }]
  houseId: null,
  d: null,           // dados da casa atual
  month: new Date().toISOString().slice(0, 7),
  chat: [],
  recovering: false,
};
try {
  state.houseId = localStorage.getItem('houseId') || null;
} catch { /* armazenamento indisponível */ }

const PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', defaultModel: 'claude-opus-5-5' },
  openai: { label: 'Compatível com OpenAI (OpenAI, OpenRouter, Groq, DeepSeek...)', defaultModel: 'gpt-4o-mini', defaultBaseUrl: 'https://api.openai.com/v1' },
  gemini: { label: 'Google Gemini', defaultModel: 'gemini-2.5-flash' },
};

// ---------------------------------------------------------------- dados
async function loadMe() {
  const { data: { session } } = await sb.auth.getSession();
  state.user = session?.user ?? null;
  state.houses = [];
  if (!state.user) return;
  const rows = await q(sb.from('residents').select('id, role, house_id, houses(name)').eq('user_id', state.user.id));
  state.houses = rows.map((r) => ({ id: r.house_id, name: r.houses?.name ?? 'Casa', role: r.role, residentId: r.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!state.houses.some((x) => x.id === state.houseId)) state.houseId = state.houses[0]?.id ?? null;
}

async function loadHouse() {
  const h0 = state.houseId;
  const [house, residents, categories, incomes, goals, recurring, ai] = await Promise.all([
    q(sb.from('houses').select('id, name').eq('id', h0).single()),
    q(sb.from('residents').select('id, name, role, user_id').eq('house_id', h0).order('created_at')),
    q(sb.from('categories').select('id, name, is_default').eq('house_id', h0).order('name')),
    q(sb.from('incomes').select('*').eq('house_id', h0).order('start_month', { ascending: false })),
    q(sb.from('goals').select('*').eq('house_id', h0).order('created_at')),
    q(sb.from('recurring').select('*').eq('house_id', h0).order('created_at', { ascending: false })),
    q(sb.from('ai_settings').select('provider, model, base_url, key_hint').eq('house_id', h0).maybeSingle()),
  ]);
  const me = state.houses.find((x) => x.id === h0);
  const invites = me?.role === 'admin' ? await q(sb.from('invites').select('resident_id, expires_at').eq('house_id', h0)) : [];
  state.d = { house, residents, categories, incomes, goals, recurring, ai, invites, expenses: [] };
  try {
    localStorage.setItem('houseId', h0);
  } catch { /* ignore */ }
}

/** Carrega os gastos lançados de [fromMonth, toMonth]. */
async function loadExpenses(fromMonth, toMonth) {
  state.d.expenses = await q(sb.from('expenses').select('*').eq('house_id', state.houseId)
    .gte('date', `${fromMonth}-01`).lt('date', `${addMonths(toMonth, 1)}-01`).order('date', { ascending: false }).limit(5000));
}

const me = () => state.houses.find((x) => x.id === state.houseId);
const isAdmin = () => me()?.role === 'admin';
const myResidentId = () => me()?.residentId;
const residentName = (id) => state.d.residents.find((r) => r.id === id)?.name ?? 'Casa';
const categoryName = (id) => state.d.categories.find((c) => c.id === id)?.name ?? 'Sem categoria';
const residentsOptions = (withHouse) => [
  ...(withHouse ? [{ value: '', label: '🏠 Casa (compartilhado)' }] : []),
  ...state.d.residents.filter((r) => isAdmin() || r.id === myResidentId()).map((r) => ({ value: r.id, label: r.name })),
];
const categoryOptions = () => [{ value: '', label: 'Sem categoria' }, ...state.d.categories.map((c) => ({ value: c.id, label: c.name }))];
const houseRow = (obj) => ({ ...obj, house_id: state.houseId });

/** Executa uma ação mostrando erros como aviso, desabilitando o botão durante o envio. */
async function run(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const out = await fn();
    if (okMsg) toast(okMsg);
    return out ?? true;
  } catch (e) {
    toast(friendly(e).message, true);
    return undefined;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------------------------------------------------------------- componentes
function field(label, input, cls = '') {
  input.id = `f-${Math.random().toString(36).slice(2, 9)}`;
  return h('div', { class: `field ${cls}` }, h('label', { for: input.id }, label), input);
}
const input = (name, attrs = {}) => h('input', { name, ...attrs });
function select(name, options, value = '') {
  const el = h('select', { name }, ...options.map((o) => h('option', { value: o.value }, o.label)));
  el.value = value ?? '';
  return el;
}
function deleteButton(label, onConfirm, after) {
  return h('button', {
    type: 'button', class: 'btn small danger',
    onclick: async (ev) => {
      if (!confirm(`Excluir "${label}"?`)) return;
      if (await run(ev.currentTarget, onConfirm, 'Excluído.')) {
        if (after) await after();
        render();
      }
    },
  }, 'Excluir');
}
const editButton = (onclick) => h('button', { type: 'button', class: 'btn small ghost', onclick }, 'Editar');

function page(title, ...children) {
  const app = $('#app');
  clear(app);
  app.append(h('h1', {}, title), ...children);
}

function passwordProblem(pw, email = '') {
  if (pw.length < 10) return 'A senha deve ter pelo menos 10 caracteres.';
  if (pw.length > 72) return 'A senha deve ter no máximo 72 caracteres.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letras e números na senha.';
  const local = email.split('@')[0].toLowerCase();
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return 'A senha não deve conter o seu e-mail.';
  return null;
}

// ---------------------------------------------------------------- autenticação
function renderAuth(mode) {
  const app = $('#app');
  clear(app);
  $('#topbar').hidden = true;
  const err = h('div', { class: 'error', hidden: true });
  const info = h('div', { class: 'card', hidden: true });
  const titles = { login: '💰 Entrar', cadastro: '💰 Criar conta', esqueci: '🔑 Recuperar senha', 'nova-senha': '🔑 Nova senha' };
  const f = {
    name: input('name', { required: true, maxlength: 80, autocomplete: 'name' }),
    email: input('email', { type: 'email', required: true, maxlength: 254, autocomplete: 'email' }),
    password: input('password', {
      type: 'password', required: true, maxlength: 72,
      autocomplete: mode === 'login' ? 'current-password' : 'new-password',
    }),
  };
  const btnLabel = { login: 'Entrar', cadastro: 'Criar conta', esqueci: 'Enviar link por e-mail', 'nova-senha': 'Salvar nova senha' }[mode];
  const submit = h('button', { class: 'btn', type: 'submit' }, btnLabel);
  const form = h('form', {},
    mode === 'cadastro' && field('Seu nome', f.name),
    mode !== 'nova-senha' && field('E-mail', f.email),
    mode !== 'esqueci' && field(mode === 'nova-senha' ? 'Nova senha' : 'Senha', f.password),
    (mode === 'cadastro' || mode === 'nova-senha') && h('p', { class: 'hint' }, 'Mínimo de 10 caracteres, com letras e números.'),
    err, submit);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    submit.disabled = true;
    try {
      const email = f.email.value.trim().toLowerCase();
      if (mode === 'login') {
        await q(sb.auth.signInWithPassword({ email, password: f.password.value }));
        await start('#/painel');
      } else if (mode === 'cadastro') {
        const problem = passwordProblem(f.password.value, email);
        if (problem) throw new Error(problem);
        const data = await q(sb.auth.signUp({
          email, password: f.password.value,
          options: { data: { name: f.name.value.trim() }, emailRedirectTo: location.origin + location.pathname },
        }));
        if (data.session) await start('#/painel');
        else {
          form.hidden = true;
          info.hidden = false;
          info.textContent = 'Conta criada! Enviamos um link de confirmação para o seu e-mail. Abra o link e depois entre com sua senha.';
        }
      } else if (mode === 'esqueci') {
        await q(sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
        form.hidden = true;
        info.hidden = false;
        info.textContent = 'Se esse e-mail tiver cadastro, você vai receber um link para criar uma nova senha.';
      } else {
        const problem = passwordProblem(f.password.value, state.user?.email ?? '');
        if (problem) throw new Error(problem);
        await q(sb.auth.updateUser({ password: f.password.value }));
        state.recovering = false;
        toast('Senha alterada.');
        await start('#/painel');
      }
    } catch (e) {
      err.textContent = friendly(e).message;
      err.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });

  const links = {
    login: [h('a', { href: '#/cadastro' }, 'Criar conta'), ' · ', h('a', { href: '#/esqueci' }, 'Esqueci minha senha')],
    cadastro: [h('a', { href: '#/login' }, 'Já tenho conta')],
    esqueci: [h('a', { href: '#/login' }, 'Voltar para o login')],
    'nova-senha': [],
  }[mode];
  app.append(h('div', { class: 'auth card' }, h('h1', {}, titles[mode]), form, info, h('p', { class: 'center hint' }, ...links)));
}

function renderNotConfigured() {
  $('#topbar').hidden = true;
  page('Configuração pendente',
    h('div', { class: 'card stack' },
      secretKeyError
        ? h('p', { class: 'error' }, 'A chave em js/config.js é SECRETA (service_role / sb_secret). Ela nunca pode ir para o site. Troque pela chave publicável e revogue a secreta no Supabase.')
        : h('p', {}, 'Preencha SUPABASE_URL e SUPABASE_ANON_KEY em js/config.js (veja o README, passo 1).')));
}

// ---------------------------------------------------------------- shell
const ROUTES = [
  ['painel', 'Painel'], ['gastos', 'Gastos'], ['ganhos', 'Ganhos e objetivos'],
  ['automaticos', 'Descontos automáticos'], ['categorias', 'Categorias'], ['ia', 'Assistente IA'], ['casa', 'Casa e conta'],
];

function renderShell(route) {
  $('#topbar').hidden = false;
  const nav = $('#nav');
  clear(nav);
  for (const [key, label] of ROUTES) nav.append(h('a', { href: `#/${key}`, 'aria-current': key === route ? 'page' : null }, label));
  const sel = $('#house-select');
  clear(sel);
  for (const x of state.houses) sel.append(h('option', { value: x.id }, x.name));
  sel.value = state.houseId;
  sel.hidden = state.houses.length < 2;
  $('#month-input').value = state.month;
  $('#month-input').hidden = false;
}

$('#house-select').addEventListener('change', (e) => {
  state.houseId = e.target.value;
  state.d = null;
  state.chat = [];
  render();
});
$('#month-input').addEventListener('change', (e) => {
  if (/^\d{4}-\d{2}$/.test(e.target.value)) {
    state.month = e.target.value;
    render();
  }
});
$('#logout-btn').addEventListener('click', async () => {
  await sb.auth.signOut();
});

// ---------------------------------------------------------------- sem casa
function renderNoHouse() {
  $('#topbar').hidden = false;
  clear($('#nav'));
  $('#house-select').hidden = true;
  $('#month-input').hidden = true;
  const myName = state.user.user_metadata?.name || state.user.email.split('@')[0];
  const nameIn = input('name', { required: true, maxlength: 80, placeholder: 'Ex.: Casa da Família Silva' });
  const createBtn = h('button', { class: 'btn', type: 'submit' }, 'Criar casa');
  const create = h('form', { class: 'inline' }, field('Nome da casa', nameIn), createBtn);
  create.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const id = await run(createBtn, () => q(sb.rpc('create_house', { p_name: nameIn.value, p_my_name: myName })), 'Casa criada!');
    if (id) await afterHouseChange(id);
  });
  page(`Olá, ${myName}!`,
    h('div', { class: 'grid cols-2' },
      h('section', { class: 'card' }, h('h2', {}, 'Cadastrar uma casa'), h('p', { class: 'muted' }, 'Você será o administrador e poderá adicionar os moradores.'), create),
      h('section', { class: 'card' }, h('h2', {}, 'Fui convidado'), h('p', { class: 'muted' }, 'Use o código que o administrador da casa gerou para você.'), joinForm())));
}

function joinForm(label = 'Código de convite') {
  const code = input('code', { required: true, maxlength: 20, placeholder: 'XXXX-XXXX-XXXX', autocomplete: 'off' });
  const btn = h('button', { class: 'btn ghost', type: 'submit' }, 'Entrar na casa');
  const form = h('form', { class: 'inline' }, field(label, code), btn);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const id = await run(btn, () => q(sb.rpc('join_house', { p_code: code.value })), 'Você entrou na casa!');
    if (id) await afterHouseChange(id);
  });
  return form;
}

async function afterHouseChange(id) {
  state.houseId = id;
  state.d = null;
  await loadMe();
  location.hash = '#/painel';
  render();
}

// ---------------------------------------------------------------- painel
async function renderDashboard() {
  await loadExpenses(addMonths(state.month, -5), state.month);
  const d = monthSummary(state.d, state.month);
  const tr = trend(state.d, state.month, 6);
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
      h('div', { class: 'sub' }, negative ? 'Atenção: os gastos passaram os ganhos' : `Objetivos planejados: ${brl(t.goals)}`)));

  const incomeTable = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Morador'), h('th', {}, 'Descrição'), h('th', { class: 'num' }, 'Valor'))),
    h('tbody', {},
      ...d.incomes.map((i) => h('tr', {}, h('td', {}, i.resident), h('td', {}, i.description, ' ', h('span', { class: 'tag' }, i.kind === 'recurring' ? 'mensal' : 'único')), h('td', { class: 'num' }, brl(i.amount)))),
      h('tr', { class: 'total' }, h('td', { colspan: 2 }, 'Total de ganhos do mês'), h('td', { class: 'num' }, brl(t.income)))));

  const rows = [
    ...d.automatic.map((a) => ({ date: '—', desc: a.description, tag: a.detail, cat: a.category, who: a.resident, amount: a.amount })),
    ...d.expenses.map((e) => ({ date: e.date.split('-').reverse().join('/'), desc: e.description, tag: null, cat: e.category, who: e.resident, amount: e.amount })),
  ];
  const expenseTable = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Data'), h('th', {}, 'Descrição'), h('th', {}, 'Categoria'), h('th', {}, 'De'), h('th', { class: 'num' }, 'Valor'))),
    h('tbody', {},
      ...rows.map((x) => h('tr', {}, h('td', { class: 'num' }, x.date), h('td', {}, x.desc, x.tag ? h('span', { class: 'tag' }, ` ${x.tag}`) : null), h('td', {}, x.cat), h('td', {}, x.who), h('td', { class: 'num' }, brl(x.amount)))),
      h('tr', { class: 'total' }, h('td', { colspan: 4 }, 'Total de gastos do mês'), h('td', { class: 'num' }, brl(t.expenses)))));

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
        h('section', { class: 'card chart' }, h('h2', {}, 'Ganhos x gastos — últimos 6 meses'), trendChart(tr))),
      h('section', { class: 'card' }, h('h2', {}, `Ganhos do mês (${brl(t.income)})`),
        d.incomes.length ? h('div', { class: 'table-wrap' }, incomeTable) : h('p', { class: 'muted' }, 'Nenhum ganho neste mês. Cadastre em “Ganhos e objetivos”.')),
      h('section', { class: 'card' }, h('h2', {}, `Gastos do mês (${brl(t.expenses)})`),
        rows.length ? h('div', { class: 'table-wrap' }, expenseTable) : h('p', { class: 'muted' }, 'Nenhum gasto neste mês.')),
      h('div', { class: 'grid cols-3' }, ...residentCards)));
}

// ---------------------------------------------------------------- gastos
async function renderExpenses() {
  await loadExpenses(state.month, state.month);
  const list = monthSummary(state.d, state.month).expenses;
  let editing = null;
  const today = new Date().toISOString().slice(0, 10);
  const defaultDate = today.startsWith(state.month) ? today : `${state.month}-01`;

  const f = {
    description: input('description', { required: true, maxlength: 120, placeholder: 'Ex.: Supermercado' }),
    amount: input('amount', { required: true, inputmode: 'decimal', placeholder: '0,00' }),
    date: input('date', { type: 'date', required: true, value: defaultDate }),
    categoryId: select('categoryId', categoryOptions()),
    residentId: select('residentId', residentsOptions(true), myResidentId()),
  };
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Adicionar gasto');
  const cancel = h('button', { class: 'btn ghost', type: 'button', hidden: true, onclick: () => render() }, 'Cancelar');
  const form = h('form', { class: 'inline' },
    field('Descrição', f.description), field('Valor (R$)', f.amount, 'small'), field('Data', f.date, 'small'),
    field('Categoria', f.categoryId), field('De quem', f.residentId), submit, cancel);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const amount = parseMoney(f.amount.value);
    if (!amount) return toast('Informe um valor válido, ex.: 125,90', true);
    const row = {
      description: f.description.value.trim(), amount_cents: amount, date: f.date.value,
      category_id: f.categoryId.value || null, resident_id: f.residentId.value || null,
    };
    const ok = await run(submit, () => q(editing
      ? sb.from('expenses').update(row).eq('id', editing).select('id').single()
      : sb.from('expenses').insert(houseRow(row))), editing ? 'Gasto atualizado.' : 'Gasto adicionado.');
    if (ok) render();
  });

  const canEdit = (e) => isAdmin() || e.createdBy === state.user.id || (e.residentId && e.residentId === myResidentId());
  const total = list.reduce((s, e) => s + e.amount, 0);
  const table = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Data'), h('th', {}, 'Descrição'), h('th', {}, 'Categoria'), h('th', {}, 'De'), h('th', { class: 'num' }, 'Valor'), h('th', {}))),
    h('tbody', {}, ...list.map((e) => h('tr', {},
      h('td', { class: 'num' }, e.date.split('-').reverse().join('/')), h('td', {}, e.description), h('td', {}, e.category), h('td', {}, e.resident),
      h('td', { class: 'num' }, brl(e.amount)),
      h('td', {}, canEdit(e) ? h('div', { class: 'actions' },
        editButton(() => {
          editing = e.id;
          f.description.value = e.description;
          f.amount.value = centsToInput(e.amount);
          f.date.value = e.date;
          f.categoryId.value = e.categoryId ?? '';
          f.residentId.value = e.residentId ?? '';
          submit.textContent = 'Salvar alteração';
          cancel.hidden = false;
          f.description.focus();
        }),
        deleteButton(e.description, () => q(sb.from('expenses').delete().eq('id', e.id)))) : null))),
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
  state.d.expenses = [];
  const dash = monthSummary(state.d, state.month);
  const incomes = state.d.incomes;
  let editing = null;
  const mine = residentsOptions(false);
  const canEdit = (rid) => isAdmin() || rid === myResidentId();

  const f = {
    residentId: select('residentId', mine, myResidentId()),
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
    const row = {
      resident_id: f.residentId.value, description: f.description.value.trim(), amount_cents: amount, kind: f.kind.value,
      start_month: f.startMonth.value, end_month: f.kind.value === 'recurring' ? f.endMonth.value || null : null,
    };
    const ok = await run(submit, () => q(editing
      ? sb.from('incomes').update(row).eq('id', editing).select('id').single()
      : sb.from('incomes').insert(houseRow(row))), 'Ganho salvo.');
    if (ok) {
      await loadHouse();
      render();
    }
  });

  const incomeTable = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Morador'), h('th', {}, 'Descrição'), h('th', {}, 'Frequência'), h('th', {}, 'Período'), h('th', { class: 'num' }, 'Valor'), h('th', {}))),
    h('tbody', {}, ...incomes.map((i) => h('tr', {},
      h('td', {}, residentName(i.resident_id)), h('td', {}, i.description),
      h('td', {}, i.kind === 'recurring' ? 'Todo mês' : 'Uma vez'),
      h('td', {}, i.kind === 'once' ? monthLabel(i.start_month) : `desde ${monthLabel(i.start_month)}${i.end_month ? ` até ${monthLabel(i.end_month)}` : ''}`),
      h('td', { class: 'num' }, brl(Number(i.amount_cents))),
      h('td', {}, canEdit(i.resident_id) ? h('div', { class: 'actions' },
        editButton(() => {
          editing = i.id;
          f.residentId.value = i.resident_id;
          f.description.value = i.description;
          f.amount.value = centsToInput(Number(i.amount_cents));
          f.kind.value = i.kind;
          f.startMonth.value = i.start_month;
          f.endMonth.value = i.end_month || '';
          endField.hidden = i.kind !== 'recurring';
          submit.textContent = 'Salvar alteração';
          cancel.hidden = false;
          f.description.focus();
        }),
        deleteButton(i.description, () => q(sb.from('incomes').delete().eq('id', i.id)), loadHouse)) : null)))));

  // Objetivos
  const g = {
    residentId: select('residentId', mine, myResidentId()),
    name: input('name', { required: true, maxlength: 80, placeholder: 'Ex.: Reserva de emergência' }),
    percent: input('percent', { required: true, inputmode: 'decimal', placeholder: '10' }),
  };
  const gSubmit = h('button', { class: 'btn', type: 'submit' }, 'Adicionar objetivo');
  const goalForm = h('form', { class: 'inline' }, field('Morador', g.residentId), field('Objetivo', g.name), field('% da renda', g.percent, 'small'), gSubmit);
  goalForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const bp = parsePercent(g.percent.value);
    if (!bp) return toast('Informe um percentual entre 0,01 e 100.', true);
    const ok = await run(gSubmit, () => q(sb.from('goals').insert(houseRow({ resident_id: g.residentId.value, name: g.name.value.trim(), percent_bp: bp }))), 'Objetivo salvo.');
    if (ok) {
      await loadHouse();
      render();
    }
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
            const ok = await run(ev.currentTarget, () => q(sb.from('goals').update({ percent_bp: bp }).eq('id', x.id).select('id').single()), 'Objetivo atualizado.');
            if (ok) {
              await loadHouse();
              render();
            }
          },
        }, 'Editar %'),
        deleteButton(x.name, () => q(sb.from('goals').delete().eq('id', x.id)), loadHouse)) : null))))) : h('p', { class: 'muted' }, 'Nenhum objetivo.')));

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
  const list = state.d.recurring;
  let editing = null;
  const f = {
    description: input('description', { required: true, maxlength: 120, placeholder: 'Ex.: Aluguel' }),
    residentId: select('residentId', residentsOptions(isAdmin()), isAdmin() ? '' : myResidentId()),
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
    const cat = state.d.categories.find((c) => c.name === catName);
    f.categoryId.value = cat ? cat.id : '';
    if (extra.percent) f.percent.value = extra.percent;
    if (extra.resident) f.residentId.value = myResidentId();
    syncMode();
    (mode === 'fixed' ? f.amount : f.percent).focus();
  };
  const presets = h('div', { class: 'actions presets' },
    h('span', { class: 'hint' }, 'Atalhos:'),
    h('button', { type: 'button', class: 'btn small ghost', onclick: preset('Dízimo', 'percent', 'Dízimo e ofertas', { percent: '10', resident: true }) }, 'Dízimo 10%'),
    h('button', { type: 'button', class: 'btn small ghost', onclick: preset('Aluguel', 'fixed', 'Moradia') }, 'Aluguel'),
    h('button', { type: 'button', class: 'btn small ghost', onclick: preset('Compra parcelada', 'fixed', 'Outros') }, 'Parcelamento'),
    h('button', { type: 'button', class: 'btn small ghost', onclick: preset('Internet', 'fixed', 'Contas (água, luz, internet)') }, 'Conta fixa'),
    h('button', { type: 'button', class: 'btn small ghost', onclick: preset('Streaming', 'fixed', 'Assinaturas') }, 'Assinatura'));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const row = {
      description: f.description.value.trim(),
      resident_id: f.residentId.value || null,
      category_id: f.categoryId.value || null,
      mode: f.mode.value,
      start_month: f.startMonth.value,
      installments: f.installments.value ? Number(f.installments.value) : null,
      end_month: f.endMonth.value || null,
      active: f.active.checked,
      amount_cents: null,
      percent_bp: null,
    };
    if (row.mode === 'fixed') {
      row.amount_cents = parseMoney(f.amount.value);
      if (!row.amount_cents) return toast('Informe o valor.', true);
    } else {
      row.percent_bp = parsePercent(f.percent.value);
      if (!row.percent_bp) return toast('Informe o percentual.', true);
    }
    const ok = await run(submit, () => q(editing
      ? sb.from('recurring').update(row).eq('id', editing).select('id').single()
      : sb.from('recurring').insert(houseRow(row))), 'Desconto salvo.');
    if (ok) {
      await loadHouse();
      render();
    }
  });

  const status = (r) => {
    if (!r.active) return 'Pausado';
    const idx = monthIndex(state.month) - monthIndex(r.start_month);
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
      h('td', { class: 'num' }, r.mode === 'fixed' ? brl(Number(r.amount_cents)) : `${bpToText(r.percent_bp)} da renda`),
      h('td', {}, h('span', { class: 'tag' }, status(r))),
      h('td', {}, canEdit(r) ? h('div', { class: 'actions' },
        editButton(() => {
          editing = r.id;
          f.description.value = r.description;
          f.residentId.value = r.resident_id ?? '';
          f.categoryId.value = r.category_id ?? '';
          f.mode.value = r.mode;
          f.amount.value = r.amount_cents ? centsToInput(Number(r.amount_cents)) : '';
          f.percent.value = r.percent_bp ? String(r.percent_bp / 100).replace('.', ',') : '';
          f.startMonth.value = r.start_month;
          f.installments.value = r.installments ?? '';
          f.endMonth.value = r.end_month ?? '';
          f.active.checked = !!r.active;
          syncMode();
          submit.textContent = 'Salvar alteração';
          cancel.hidden = false;
          f.description.focus();
        }),
        deleteButton(r.description, () => q(sb.from('recurring').delete().eq('id', r.id)), loadHouse)) : null)))));

  page('Descontos automáticos',
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h2', {}, 'Novo desconto automático'), presets, form,
        h('p', { class: 'hint' }, 'Entram sozinhos nos gastos de cada mês. Dízimo: use “Percentual da renda”. Parcelas: informe o nº de parcelas — depois da última, o desconto some do painel. Aluguel: deixe sem fim (ou informe o mês final do contrato).')),
      h('section', { class: 'card' }, h('h2', {}, 'Descontos cadastrados'),
        list.length ? h('div', { class: 'table-wrap' }, table) : h('p', { class: 'muted' }, 'Nenhum desconto automático.'))));
}

// ---------------------------------------------------------------- categorias
async function renderCategories() {
  const nameIn = input('name', { required: true, maxlength: 60, placeholder: 'Ex.: Academia' });
  const submit = h('button', { class: 'btn', type: 'submit' }, 'Adicionar categoria');
  const form = h('form', { class: 'inline' }, field('Nova categoria', nameIn), submit);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await run(submit, () => q(sb.from('categories').insert(houseRow({ name: nameIn.value.trim() }))), 'Categoria criada.');
    if (ok) {
      await loadHouse();
      render();
    }
  });
  const table = h('table', {}, h('tbody', {}, ...state.d.categories.map((c) => h('tr', {},
    h('td', {}, c.name, c.is_default ? h('span', { class: 'tag' }, ' padrão') : null),
    h('td', {}, h('div', { class: 'actions' },
      h('button', {
        type: 'button', class: 'btn small ghost',
        onclick: async (ev) => {
          const val = prompt('Novo nome da categoria:', c.name);
          if (!val || val.trim() === c.name) return;
          const ok = await run(ev.currentTarget, () => q(sb.from('categories').update({ name: val.trim() }).eq('id', c.id).select('id').single()), 'Categoria renomeada.');
          if (ok) {
            await loadHouse();
            render();
          }
        },
      }, 'Renomear'),
      isAdmin() ? deleteButton(c.name, () => q(sb.from('categories').delete().eq('id', c.id)), loadHouse) : null))))));
  page('Categorias',
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, form, h('p', { class: 'hint' }, 'As categorias padrão já vêm prontas — renomeie, exclua ou crie as suas. Ao excluir, os gastos ficam “Sem categoria”.')),
      h('section', { class: 'card' }, h('div', { class: 'table-wrap' }, table))));
}

// ---------------------------------------------------------------- casa e conta
async function renderHouse() {
  const admin = isAdmin();
  const inviteBox = h('div');
  const pending = new Map(state.d.invites.map((i) => [i.resident_id, new Date(i.expires_at) > new Date()]));

  const resTable = h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Morador'), h('th', {}, 'Papel'), h('th', {}, 'Login'), h('th', {}))),
    h('tbody', {}, ...state.d.residents.map((r) => {
      const roleSel = select('role', [{ value: 'member', label: 'Morador' }, { value: 'admin', label: 'Administrador' }], r.role);
      roleSel.disabled = !admin;
      roleSel.addEventListener('change', async () => {
        const ok = await run(null, () => q(sb.from('residents').update({ role: roleSel.value }).eq('id', r.id).select('id').single()), 'Papel atualizado.');
        if (!ok) roleSel.value = r.role;
        else {
          await loadMe();
          await loadHouse();
          render();
        }
      });
      return h('tr', {},
        h('td', {}, r.name, r.id === myResidentId() ? h('span', { class: 'tag' }, ' você') : null),
        h('td', {}, roleSel),
        h('td', {}, r.user_id ? '✔ tem login' : pending.get(r.id) ? 'convite pendente' : 'sem login'),
        h('td', {}, admin ? h('div', { class: 'actions' },
          !r.user_id ? h('button', {
            type: 'button', class: 'btn small ghost',
            onclick: async (ev) => {
              const code = await run(ev.currentTarget, () => q(sb.rpc('create_invite', { p_resident: r.id })));
              if (!code) return;
              clear(inviteBox);
              inviteBox.append(h('div', { class: 'card' },
                h('p', {}, `Código de convite para ${r.name} (válido por 72h, uso único):`),
                h('div', { class: 'code' }, code),
                h('p', { class: 'hint' }, `Envie esse código por um canal seguro. A pessoa cria a conta em ${location.origin + location.pathname} e informa o código. Ele não será mostrado de novo.`)));
            },
          }, 'Gerar convite') : null,
          r.id !== myResidentId() ? deleteButton(r.name, () => q(sb.from('residents').delete().eq('id', r.id)), loadHouse) : null) : null));
    })));

  const newRes = input('name', { required: true, maxlength: 80, placeholder: 'Nome do morador' });
  const addBtn = h('button', { class: 'btn', type: 'submit' }, 'Adicionar morador');
  const addForm = h('form', { class: 'inline' }, field('Novo morador', newRes), addBtn);
  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await run(addBtn, () => q(sb.from('residents').insert(houseRow({ name: newRes.value.trim() }))), 'Morador adicionado.');
    if (ok) {
      await loadHouse();
      render();
    }
  });

  const houseName = input('name', { required: true, maxlength: 80, value: state.d.house.name });
  const renameBtn = h('button', { class: 'btn ghost', type: 'submit' }, 'Salvar nome');
  const renameForm = h('form', { class: 'inline' }, field('Nome da casa', houseName), renameBtn);
  renameForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const ok = await run(renameBtn, () => q(sb.from('houses').update({ name: houseName.value.trim() }).eq('id', state.houseId).select('id').single()), 'Nome atualizado.');
    if (ok) {
      await loadMe();
      await loadHouse();
      render();
    }
  });

  // Conta
  const nw = input('newPassword', { type: 'password', required: true, minlength: 10, maxlength: 72, autocomplete: 'new-password' });
  const pwBtn = h('button', { class: 'btn', type: 'submit' }, 'Trocar senha');
  const pwForm = h('form', { class: 'inline' }, field('Nova senha', nw), pwBtn);
  pwForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const problem = passwordProblem(nw.value, state.user.email);
    if (problem) return toast(problem, true);
    const ok = await run(pwBtn, () => q(sb.auth.updateUser({ password: nw.value })), 'Senha alterada.');
    if (ok) pwForm.reset();
  });

  const newHouse = input('name', { required: true, maxlength: 80, placeholder: 'Outra casa' });
  const nhBtn = h('button', { class: 'btn ghost', type: 'submit' }, 'Criar');
  const nhForm = h('form', { class: 'inline' }, field('Criar outra casa', newHouse), nhBtn);
  nhForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const myName = state.user.user_metadata?.name || state.user.email.split('@')[0];
    const id = await run(nhBtn, () => q(sb.rpc('create_house', { p_name: newHouse.value, p_my_name: myName })), 'Casa criada.');
    if (id) await afterHouseChange(id);
  });

  const danger = admin ? h('section', { class: 'card' },
    h('h2', {}, 'Zona de perigo'),
    h('p', { class: 'hint' }, 'Excluir a casa apaga todos os ganhos, gastos, objetivos e descontos dela. Não tem volta.'),
    h('button', {
      type: 'button', class: 'btn danger',
      onclick: async (ev) => {
        const typed = prompt(`Para confirmar, digite o nome da casa: ${state.d.house.name}`);
        if (typed === null) return;
        if (typed !== state.d.house.name) return toast('O nome digitado não confere.', true);
        const ok = await run(ev.currentTarget, () => q(sb.from('houses').delete().eq('id', state.houseId)), 'Casa excluída.');
        if (ok) await afterHouseChange(null);
      },
    }, 'Excluir casa')) : null;

  page('Casa e conta',
    h('div', { class: 'stack' },
      admin ? h('section', { class: 'card' }, renameForm) : null,
      h('section', { class: 'card' }, h('h2', {}, `Moradores de ${state.d.house.name}`), h('div', { class: 'table-wrap' }, resTable),
        admin ? addForm : h('p', { class: 'hint' }, 'Apenas administradores adicionam moradores.'), inviteBox,
        admin ? h('p', { class: 'hint' }, 'Moradores sem login (ex.: crianças) podem ter ganhos e gastos lançados pelo administrador. Para dar acesso, gere um convite.') : null),
      h('section', { class: 'card' }, h('h2', {}, `Minha conta (${state.user.email})`), pwForm,
        h('p', {}, h('button', {
          type: 'button', class: 'btn small ghost',
          onclick: async () => {
            await sb.auth.signOut({ scope: 'global' });
          },
        }, 'Sair de todos os dispositivos'))),
      h('div', { class: 'grid cols-2' }, h('section', { class: 'card' }, nhForm), h('section', { class: 'card' }, joinForm('Entrar em outra casa (convite)'))),
      danger));
}

// ---------------------------------------------------------------- IA
async function renderAI() {
  const settings = state.d.ai;
  const admin = isAdmin();

  let config = null;
  if (admin) {
    const prov = select('provider', Object.entries(PROVIDERS).map(([k, p]) => ({ value: k, label: p.label })), settings?.provider ?? 'anthropic');
    const model = input('model', { maxlength: 100, value: settings?.model ?? PROVIDERS.anthropic.defaultModel });
    const baseUrl = input('baseUrl', { maxlength: 300, value: settings?.base_url ?? PROVIDERS.openai.defaultBaseUrl });
    const key = input('apiKey', {
      type: 'password', autocomplete: 'off', maxlength: 500,
      placeholder: settings?.key_hint ? `salva (termina em …${settings.key_hint}) — deixe vazio para manter` : 'cole a chave de API',
    });
    const baseField = field('URL base (API compatível com OpenAI)', baseUrl);
    prov.addEventListener('change', () => {
      baseField.hidden = prov.value !== 'openai';
      model.value = settings?.provider === prov.value ? settings.model : PROVIDERS[prov.value].defaultModel;
    });
    baseField.hidden = prov.value !== 'openai';
    const save = h('button', { class: 'btn', type: 'submit' }, 'Salvar configuração');
    const form = h('form', { class: 'inline', autocomplete: 'off' }, field('Provedor', prov), field('Modelo', model), baseField, field('Chave de API', key), save);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const ok = await run(save, () => callAi({ action: 'save', houseId: state.houseId, provider: prov.value, model: model.value, baseUrl: baseUrl.value, apiKey: key.value }), 'Configuração salva.');
      if (ok) {
        await loadHouse();
        render();
      }
    });
    config = h('section', { class: 'card' }, h('h2', {}, 'Conexão com a IA (administrador)'), form,
      h('p', { class: 'hint' }, 'A chave vai direto para a função segura do Supabase, é criptografada (AES-256-GCM) e nunca volta para o navegador. Claude: crie a chave em console.anthropic.com. Também funciona com OpenAI, OpenRouter, Groq, DeepSeek e Gemini.'),
      settings ? h('p', {}, h('button', {
        type: 'button', class: 'btn small danger',
        onclick: async (ev) => {
          if (!confirm('Remover a configuração e a chave de IA?')) return;
          const ok = await run(ev.currentTarget, () => callAi({ action: 'delete', houseId: state.houseId }), 'Configuração removida.');
          if (ok) {
            await loadHouse();
            render();
          }
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
  const qText = h('textarea', { name: 'q', maxlength: 4000, required: true, placeholder: 'Escreva sua pergunta…' });
  const send = h('button', { class: 'btn', type: 'submit' }, 'Enviar');
  const reset = h('button', { class: 'btn ghost', type: 'button', onclick: () => { state.chat = []; paint(); } }, 'Nova conversa');
  const chatForm = h('form', { class: 'stack' }, field(`Pergunta sobre ${monthLabel(state.month)}`, qText), h('div', { class: 'actions' }, reset, send));
  qText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });
  chatForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = qText.value.trim();
    if (!text) return;
    state.chat.push({ role: 'user', content: text });
    if (state.chat.length > 19) state.chat = state.chat.slice(-19);
    while (state.chat[0]?.role !== 'user') state.chat.shift();
    qText.value = '';
    paint();
    const thinking = h('div', { class: 'msg assistant muted' }, 'Pensando…');
    chatBox.append(thinking);
    const out = await run(send, async () => {
      await loadExpenses(state.month, state.month);
      const context = buildContext(state.d.house.name, monthSummary(state.d, state.month));
      return callAi({ action: 'chat', houseId: state.houseId, context, messages: state.chat });
    });
    thinking.remove();
    if (out?.answer) state.chat.push({ role: 'assistant', content: out.answer });
    else state.chat.pop();
    paint();
  });

  page('Assistente de IA',
    h('div', { class: 'stack' },
      config,
      h('section', { class: 'card' },
        h('h2', {}, settings ? `Conversar (${PROVIDERS[settings.provider]?.label ?? settings.provider} · ${settings.model})` : 'Conversar'),
        settings ? h('div', { class: 'stack' }, chatBox, chatForm,
          h('p', { class: 'hint' }, 'Ao perguntar, o resumo financeiro do mês (nomes dos moradores, ganhos, gastos, objetivos) é enviado ao provedor de IA configurado. E-mails e senhas nunca são enviados.'))
          : h('p', { class: 'muted' }, admin ? 'Configure a conexão acima para começar.' : 'Peça ao administrador da casa para configurar a IA.'))));
}

// ---------------------------------------------------------------- roteador
const PAGES = {
  painel: renderDashboard, gastos: renderExpenses, ganhos: renderIncomes, automaticos: renderRecurring,
  categorias: renderCategories, casa: renderHouse, ia: renderAI,
};
const AUTH_ROUTES = ['login', 'cadastro', 'esqueci'];

async function render() {
  const route = (location.hash.replace(/^#\/?/, '') || 'painel').split('?')[0];
  try {
    if (!configured) return renderNotConfigured();
    if (state.recovering) return renderAuth('nova-senha');
    if (!state.user) return renderAuth(AUTH_ROUTES.includes(route) ? route : 'login');
    if (AUTH_ROUTES.includes(route)) {
      location.hash = '#/painel';
      return;
    }
    if (!state.houseId) return renderNoHouse();
    if (!state.d || state.d.house.id !== state.houseId) await loadHouse();
    renderShell(PAGES[route] ? route : 'painel');
    await (PAGES[route] ?? renderDashboard)();
    $('#app').focus({ preventScroll: true });
  } catch (e) {
    page('Ops', h('div', { class: 'error' }, friendly(e).message));
  }
}

async function start(hash) {
  await loadMe();
  state.d = null;
  if (hash) location.hash = hash;
  render();
}

window.addEventListener('hashchange', render);
if (configured) {
  sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      state.recovering = true;
      setTimeout(() => start(), 0);
    } else if (event === 'SIGNED_OUT') {
      Object.assign(state, { user: null, houses: [], d: null, chat: [] });
      location.hash = '#/login';
      render();
    }
  });
}
(async () => {
  try {
    if (configured) await loadMe();
  } catch {
    state.user = null;
  }
  render();
})();
