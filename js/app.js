// Controle Financeiro — front-end estático (GitHub Pages) + Supabase.
// Segurança: todo conteúdo vindo do usuário entra na tela com textContent (nunca innerHTML),
// e quem decide o que cada um pode ler/alterar é o RLS do banco (supabase/schema.sql).
import { sb, q, configured, secretKeyError, friendly } from './api.js';
import { state, loadMe, loadHouse, perm, isAdmin, canEdit, setRerender, field, input, run, applyBranding } from './ctx.js';
import { addMonths, localToday } from './finance.js';
import { h, $, clear, toast, monthLabel, initials, menuButton, openDialog, MOBILE_MQ } from './ui.js';
import { icon } from './icons.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderTransactions } from './pages/transactions.js';
import { renderAccounts } from './pages/accounts.js';
import { renderRecurring } from './pages/recurring.js';
import { renderBudget } from './pages/budget.js';
import { renderGoals } from './pages/goals.js';
import { renderCategories } from './pages/categories.js';
import { renderReports } from './pages/reports.js';
import { renderCalendar } from './pages/calendar.js';
import { renderAI } from './pages/ai.js';
import { renderSettings } from './pages/settings.js';
import { renderAccount, renderMfaChallenge, passwordProblem } from './pages/account.js';
import { openTxDialog } from './pages/tx.js';
import { openVoiceDialog } from './pages/voice.js';

// ---------------------------------------------------------------- tema claro/escuro
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}
try {
  applyTheme(localStorage.getItem('theme'));
} catch { /* ignore */ }
const isDark = () => document.documentElement.dataset.theme === 'dark'
  || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);

// ---------------------------------------------------------------- rotas
// [rota, rótulo, ícone, módulo de permissão (null = sempre), grupo]
const ROUTES = [
  ['painel', 'Painel', 'dashboard', 'painel', 'Visão geral', renderDashboard],
  ['calendario', 'Calendário', 'calendar', 'calendario', 'Visão geral', renderCalendar],
  ['lancamentos', 'Lançamentos', 'receipt', 'lancamentos', 'Movimentação', renderTransactions],
  ['contas', 'Contas', 'bank', 'contas', 'Movimentação', renderAccounts],
  ['recorrentes', 'Fixos e recorrentes', 'repeat', 'recorrentes', 'Movimentação', renderRecurring],
  ['orcamento', 'Orçamento', 'pie', 'orcamento', 'Planejamento', renderBudget],
  ['metas', 'Metas', 'target', 'metas', 'Planejamento', renderGoals],
  ['categorias', 'Categorias', 'tag', 'categorias', 'Planejamento', renderCategories],
  ['relatorios', 'Relatórios', 'report', 'relatorios', 'Análise', renderReports],
  ['ia', 'Assistente IA', 'sparkles', 'ia', 'Análise', renderAI],
  ['configuracoes', 'Configurações', 'settings', 'admin', 'Sistema', renderSettings],
  ['conta', 'Minha conta', 'user', null, 'Sistema', renderAccount],
];
const ALIASES = { gastos: 'lancamentos', ganhos: 'recorrentes', automaticos: 'recorrentes', casa: 'configuracoes' };
const allowed = (mod) => (mod === null ? true : mod === 'admin' ? isAdmin() : perm(mod) >= 1);
const AUTH_ROUTES = ['login', 'cadastro', 'esqueci'];

// ---------------------------------------------------------------- shell
const shell = {};
function buildShell() {
  const layout = $('#layout');
  shell.brand = h('a', { class: 'brand', href: '#/painel' });
  shell.nav = h('nav', { class: 'side-nav', 'aria-label': 'Seções' });
  shell.foot = h('div', { class: 'side-foot' });
  shell.sidebar = h('aside', { class: 'sidebar', id: 'sidebar' }, shell.brand, shell.nav, shell.foot);
  shell.scrim = h('div', { class: 'scrim', onclick: () => document.body.classList.remove('nav-open') });

  shell.month = h('input', { type: 'month', id: 'month-input', 'aria-label': 'Mês de referência' });
  shell.monthLabel = h('span', { class: 'month-label' });
  const stepMonth = (n) => {
    state.month = addMonths(state.month, n);
    render();
  };
  shell.monthBox = h('div', { class: 'month-switch' },
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Mês anterior', onclick: () => stepMonth(-1) }, icon('left', 18)),
    h('label', { class: 'month-pick' }, icon('calendar', 16), shell.monthLabel, shell.month),
    h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Próximo mês', onclick: () => stepMonth(1) }, icon('right', 18)));
  shell.month.addEventListener('change', () => {
    if (/^\d{4}-\d{2}$/.test(shell.month.value)) {
      state.month = shell.month.value;
      render();
    }
  });
  shell.today = h('button', { type: 'button', class: 'btn ghost small hide-sm', onclick: () => { state.month = localToday().slice(0, 7); render(); } }, 'Hoje');
  shell.house = h('select', { id: 'house-select', 'aria-label': 'Casa/empresa' });
  shell.house.addEventListener('change', () => {
    state.houseId = shell.house.value;
    state.d = null;
    state.chat = [];
    render();
  });
  shell.add = h('div', { class: 'split-btn', role: 'group', 'aria-label': 'Novo lançamento' },
    h('button', { type: 'button', class: 'btn', title: 'Novo lançamento (N)', onclick: () => openTxDialog() }, icon('plus', 18), h('span', { class: 'hide-sm' }, 'Novo lançamento')),
    h('button', { type: 'button', class: 'btn voice-btn', title: 'Lançar por voz com IA (V)', 'aria-label': 'Lançar por voz com IA', onclick: () => openVoiceDialog() }, icon('mic', 18)));
  shell.theme = h('button', {
    type: 'button', class: 'icon-btn', 'aria-label': 'Alternar tema claro/escuro',
    onclick: () => {
      const next = isDark() ? 'light' : 'dark';
      applyTheme(next);
      try {
        localStorage.setItem('theme', next);
      } catch { /* ignore */ }
      paintTheme();
    },
  });
  shell.user = h('div', { class: 'user-menu' });
  // Celular: microfone no topo e barra de navegação embaixo (o "+" central abre o lançamento).
  shell.mic = h('button', { type: 'button', class: 'icon-btn phone-only mic-top', 'aria-label': 'Lançar por voz com IA', onclick: () => openVoiceDialog() }, icon('mic', 20));
  shell.topbar = h('header', { class: 'topbar' },
    h('button', { type: 'button', class: 'icon-btn mobile-only tablet-only', 'aria-label': 'Abrir menu', onclick: () => document.body.classList.toggle('nav-open') }, icon('menu', 20)),
    shell.monthBox, shell.today,
    h('div', { class: 'top-right' }, shell.house, shell.add, shell.mic, shell.theme, shell.user));
  shell.tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Navegação principal' });
  layout.append(shell.sidebar, shell.scrim, h('div', { class: 'main-col' }, shell.topbar, $('#app')), shell.tabbar);
}

// ---------------------------------------------------------------- celular: barra inferior + "Mais"
function renderTabbar(route) {
  const can = (key) => {
    const r = ROUTES.find((x) => x[0] === key);
    return r && state.houseId && allowed(r[3]);
  };
  const tab = (key, label, ic) => h('a', { href: `#/${key}`, class: 'tab', 'aria-current': key === route ? 'page' : null }, icon(ic, 22), h('span', {}, label));
  const fourth = ['calendario', 'contas', 'orcamento', 'relatorios'].find(can);
  const fourthDef = fourth ? ROUTES.find((x) => x[0] === fourth) : null;
  const inTabs = ['painel', 'lancamentos', fourth];
  const items = [
    can('painel') ? tab('painel', 'Painel', 'dashboard') : null,
    can('lancamentos') ? tab('lancamentos', 'Lançamentos', 'receipt') : null,
    state.houseId && canEdit('lancamentos')
      ? h('button', { type: 'button', class: 'tab-add', 'aria-label': 'Novo lançamento', onclick: () => openTxDialog() }, icon('plus', 26)) : null,
    fourthDef ? tab(fourth, fourthDef[1] === 'Fixos e recorrentes' ? 'Fixos' : fourthDef[1], fourthDef[2]) : null,
    h('button', {
      type: 'button', class: 'tab', 'aria-current': !inTabs.includes(route) ? 'page' : null, onclick: () => openMoreSheet(route),
    }, icon('menu', 22), h('span', {}, 'Mais')),
  ];
  shell.tabbar.replaceChildren(...items.filter(Boolean));
}

function openMoreSheet(route) {
  let go = null;
  const name = state.user.user_metadata?.name || state.user.email.split('@')[0];
  const link = (key, label, ic) => h('a', {
    href: `#/${key}`, class: 'more-item', 'aria-current': key === route ? 'page' : null,
    onclick: (e) => {
      e.preventDefault();
      go = () => { location.hash = `#/${key}`; };
      d.close();
    },
  }, h('span', { class: 'more-ico' }, icon(ic, 20)), h('span', {}, label));
  const groups = [];
  let cur = null;
  for (const [key, label, ic, mod, grp] of ROUTES) {
    if (key === 'conta' || (state.houseId ? !allowed(mod) : true)) continue;
    if (!cur || cur.name !== grp) groups.push(cur = { name: grp, items: [] });
    cur.items.push(link(key, label, ic));
  }
  const houseSel = state.houses.length > 1 ? h('div', { class: 'more-houses' }, ...state.houses.map((x) => h('button', {
    type: 'button', class: `chip${x.id === state.houseId ? ' on' : ''}`, 'aria-pressed': String(x.id === state.houseId),
    onclick: () => {
      if (x.id === state.houseId) return;
      go = () => {
        state.houseId = x.id;
        state.d = null;
        state.chat = [];
        render();
      };
      d.close();
    },
  }, icon('home', 15), x.name))) : null;
  const d = openDialog({
    title: 'Menu',
    cls: 'sheet-more',
    body: h('div', { class: 'more' },
      h('a', {
        href: '#/conta', class: 'more-user',
        onclick: (e) => {
          e.preventDefault();
          go = () => { location.hash = '#/conta'; };
          d.close();
        },
      }, h('span', { class: 'avatar' }, initials(name)), h('span', { class: 'mu-text' }, h('strong', {}, name), h('small', {}, state.user.email)), icon('right', 18)),
      houseSel ? h('div', {}, h('span', { class: 'nav-title' }, 'Casa/empresa'), houseSel) : null,
      ...groups.map((g) => h('div', {}, h('span', { class: 'nav-title' }, g.name), h('div', { class: 'more-grid' }, ...g.items))),
      h('div', { class: 'more-foot' },
        h('button', {
          type: 'button', class: 'btn ghost',
          onclick: () => {
            const next = isDark() ? 'light' : 'dark';
            applyTheme(next);
            try {
              localStorage.setItem('theme', next);
            } catch { /* ignore */ }
            paintTheme();
            d.close();
          },
        }, icon(isDark() ? 'sun' : 'moon', 18), h('span', {}, isDark() ? 'Tema claro' : 'Tema escuro')),
        h('button', { type: 'button', class: 'btn ghost danger-text', onclick: () => sb.auth.signOut() }, icon('logout', 18), h('span', {}, 'Sair')))),
    onClose: () => go?.(),
  });
}
function paintTheme() {
  shell.theme.replaceChildren(icon(isDark() ? 'sun' : 'moon', 18));
}

function renderShell(route) {
  document.body.classList.remove('auth', 'nav-open');
  const house = state.d?.house;
  shell.brand.replaceChildren(...(house?.logo
    ? [h('img', { src: house.logo, alt: house.name, class: 'brand-logo' })]
    : [h('span', { class: 'brand-mark' }, house?.icon ? h('img', { src: house.icon, alt: '' }) : icon('coins', 20)),
      h('span', { class: 'brand-text' }, h('strong', {}, house?.name ?? 'Controle Financeiro'), h('small', {}, 'Controle financeiro'))]));
  clear(shell.nav);
  let group = null;
  let list = null;
  for (const [key, label, ic, mod, grp] of ROUTES) {
    if (!state.houseId && key !== 'conta') continue;
    if (state.houseId && !allowed(mod)) continue;
    if (grp !== group) {
      group = grp;
      list = h('ul', {});
      shell.nav.append(h('div', { class: 'nav-group' }, h('span', { class: 'nav-title' }, grp), list));
    }
    list.append(h('li', {}, h('a', { href: `#/${key}`, 'aria-current': key === route ? 'page' : null, onclick: () => document.body.classList.remove('nav-open') }, icon(ic, 18), h('span', {}, label))));
  }
  const name = state.user.user_metadata?.name || state.user.email.split('@')[0];
  const role = state.houses.find((x) => x.id === state.houseId)?.role;
  shell.foot.replaceChildren(h('div', { class: 'side-user' }, h('span', { class: 'avatar' }, initials(name)),
    h('div', {}, h('strong', {}, name), h('small', {}, role === 'admin' ? 'Administrador' : role ? 'Colaborador' : ''))));

  clear(shell.house);
  for (const x of state.houses) shell.house.append(h('option', { value: x.id }, x.name));
  shell.house.value = state.houseId ?? '';
  shell.house.hidden = state.houses.length < 2;
  shell.month.value = state.month;
  const ml = monthLabel(state.month);
  shell.monthLabel.textContent = ml.charAt(0).toUpperCase() + ml.slice(1);
  shell.monthBox.hidden = !state.houseId;
  shell.today.hidden = !state.houseId || state.month === localToday().slice(0, 7);
  shell.add.hidden = !state.houseId || !canEdit('lancamentos');
  shell.mic.hidden = shell.add.hidden;
  renderTabbar(route);
  shell.user.replaceChildren(menuButton([
    { label: 'Minha conta', icon: 'user', onclick: () => { location.hash = '#/conta'; } },
    isAdmin() ? { label: 'Configurações', icon: 'settings', onclick: () => { location.hash = '#/configuracoes'; } } : null,
    { label: 'Sair', icon: 'logout', onclick: () => sb.auth.signOut() },
  ], 'Menu do usuário'));
  shell.user.querySelector('.icon-btn').replaceChildren(h('span', { class: 'avatar sm' }, initials(name)));
  paintTheme();
}

// ---------------------------------------------------------------- autenticação
function authFrame(...content) {
  document.body.classList.add('auth');
  const app = $('#app');
  clear(app);
  app.append(h('div', { class: 'auth-wrap' },
    h('aside', { class: 'auth-hero', 'aria-hidden': 'true' },
      h('div', { class: 'brand light' }, h('span', { class: 'brand-mark' }, icon('coins', 20)), h('span', { class: 'brand-text' }, h('strong', {}, 'Controle Financeiro'))),
      h('div', { class: 'hero-copy' },
        h('h2', {}, 'Suas finanças organizadas, num só lugar.'),
        h('ul', { class: 'hero-list' },
          ...[['bank', 'Contas e saldos sempre atualizados'], ['pie', 'Orçamento por categoria, planejado x realizado'], ['target', 'Metas de economia com prazo'], ['report', 'Relatórios em PDF e CSV'], ['shield', 'Verificação em duas etapas']]
            .map(([ic, t]) => h('li', {}, icon(ic, 18), t)))),
      h('div', { class: 'hero-card' },
        h('div', { class: 'hc-row' }, h('span', {}, 'Saldo consolidado'), h('strong', {}, 'R$ 12.480,90')),
        h('div', { class: 'hc-bars' }, ...[38, 52, 44, 70, 58, 80].map((v, i) => h('span', { style: { height: `${v}%`, '--d': `${i * 60}ms` } }))))),
    h('div', { class: 'auth-card' }, ...content)));
}

function renderAuth(mode) {
  const err = h('div', { class: 'error', hidden: true, role: 'alert' });
  const info = h('div', { class: 'alert good', hidden: true });
  const titles = { login: 'Entrar', cadastro: 'Criar conta', esqueci: 'Recuperar senha', 'nova-senha': 'Nova senha' };
  const subs = { login: 'Bem-vindo de volta! Entre para ver suas finanças.', cadastro: 'Comece a organizar as finanças em minutos.', esqueci: 'Enviaremos um link para criar uma nova senha.', 'nova-senha': 'Escolha uma nova senha para sua conta.' };
  const f = {
    name: input('name', { required: true, maxlength: 80, autocomplete: 'name' }),
    email: input('email', { type: 'email', required: true, maxlength: 254, autocomplete: 'email', placeholder: 'voce@email.com' }),
    password: input('password', { type: 'password', required: true, maxlength: 72, autocomplete: mode === 'login' ? 'current-password' : 'new-password' }),
  };
  const btnLabel = { login: 'Entrar', cadastro: 'Criar conta', esqueci: 'Enviar link por e-mail', 'nova-senha': 'Salvar nova senha' }[mode];
  const submit = h('button', { class: 'btn block', type: 'submit' }, btnLabel);
  const form = h('form', { class: 'stack' },
    mode === 'cadastro' && field('Seu nome', f.name),
    mode !== 'nova-senha' && field('E-mail', f.email),
    mode !== 'esqueci' && field(mode === 'nova-senha' ? 'Nova senha' : 'Senha', f.password,
      { hint: mode === 'cadastro' || mode === 'nova-senha' ? 'Mínimo de 10 caracteres, com letras e números.' : null }),
    mode === 'login' && h('div', { class: 'row-between' }, h('span'), h('a', { href: '#/esqueci', class: 'small' }, 'Esqueci minha senha')),
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
    login: [h('span', { class: 'muted' }, 'Ainda não tem conta? '), h('a', { href: '#/cadastro' }, 'Criar conta')],
    cadastro: [h('span', { class: 'muted' }, 'Já tem conta? '), h('a', { href: '#/login' }, 'Entrar')],
    esqueci: [h('a', { href: '#/login' }, icon('left', 14), ' Voltar para o login')],
    'nova-senha': [],
  }[mode];
  authFrame(h('h1', {}, titles[mode]), h('p', { class: 'muted' }, subs[mode]), form, info, h('p', { class: 'center small auth-links' }, ...links));
}

function renderNotConfigured() {
  authFrame(h('h1', {}, 'Configuração pendente'),
    secretKeyError
      ? h('p', { class: 'error' }, 'A chave em js/config.js é SECRETA (service_role / sb_secret). Ela nunca pode ir para o site. Troque pela chave publicável e revogue a secreta no Supabase.')
      : h('p', {}, 'Preencha SUPABASE_URL e SUPABASE_ANON_KEY em js/config.js (veja o README, passo 1).'));
}

// ---------------------------------------------------------------- sem casa
function renderNoHouse() {
  renderShell('conta');
  const myName = state.user.user_metadata?.name || state.user.email.split('@')[0];
  const nameIn = input('name', { required: true, maxlength: 80, placeholder: 'Ex.: Casa da Família Silva, Minha Empresa' });
  const createBtn = h('button', { class: 'btn', type: 'submit' }, 'Criar');
  const create = h('form', { class: 'stack' }, field('Nome', nameIn), createBtn);
  create.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const id = await run(createBtn, () => q(sb.rpc('create_house', { p_name: nameIn.value, p_my_name: myName })), 'Criada! Já deixamos contas e categorias prontas.');
    if (id) await afterHouseChange(id);
  });
  const code = input('code', { required: true, maxlength: 20, placeholder: 'XXXX-XXXX-XXXX', autocomplete: 'off' });
  const joinBtn = h('button', { class: 'btn ghost', type: 'submit' }, 'Entrar');
  const join = h('form', { class: 'stack' }, field('Código de convite', code), joinBtn);
  join.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const id = await run(joinBtn, () => q(sb.rpc('join_house', { p_code: code.value })), 'Você entrou!');
    if (id) await afterHouseChange(id);
  });
  const app = $('#app');
  clear(app);
  app.append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, `Olá, ${myName}!`), h('p', { class: 'page-sub' }, 'Para começar, crie uma casa/empresa ou entre com um convite.'))),
    h('div', { class: 'grid cols-2 onboarding' },
      h('section', { class: 'card' }, h('div', { class: 'empty-ico' }, icon('home', 26)), h('h2', {}, 'Criar casa ou empresa'), h('p', { class: 'muted' }, 'Você será o administrador e poderá convidar outras pessoas.'), create),
      h('section', { class: 'card' }, h('div', { class: 'empty-ico' }, icon('key', 26)), h('h2', {}, 'Fui convidado'), h('p', { class: 'muted' }, 'Use o código que o administrador gerou para você.'), join)));
}

async function afterHouseChange(id) {
  state.houseId = id;
  state.d = null;
  await loadMe();
  location.hash = '#/painel';
  render();
}

// ---------------------------------------------------------------- roteador
let rendering = null;
async function render() {
  let route = (location.hash.replace(/^#\/?/, '') || 'painel').split('?')[0];
  route = ALIASES[route] ?? route;
  try {
    if (!configured) return renderNotConfigured();
    if (state.recovering) return renderAuth('nova-senha');
    if (!state.user) return renderAuth(AUTH_ROUTES.includes(route) ? route : 'login');
    if (state.needMfa) {
      document.body.classList.add('auth');
      return renderMfaChallenge(() => start('#/painel'));
    }
    if (AUTH_ROUTES.includes(route)) {
      location.hash = '#/painel';
      return;
    }
    if (!state.houseId) {
      if (route === 'conta') {
        renderShell('conta');
        return await renderAccount();
      }
      return renderNoHouse();
    }
    if (!state.d || state.d.house.id !== state.houseId) {
      if (!state.d) $('#app').replaceChildren(h('div', { class: 'loading' }, h('span', { class: 'spinner' }), 'Carregando…'));
      await loadHouse();
    }
    let def = ROUTES.find((r) => r[0] === route);
    if (!def || !allowed(def[3])) def = ROUTES.find((r) => allowed(r[3]));
    renderShell(def[0]);
    await def[5]();
    if (rendering !== route) $('#app').focus({ preventScroll: true });
    rendering = route;
  } catch (e) {
    console.error(e);
    $('#app').replaceChildren(h('div', { class: 'page-head' }, h('h1', {}, 'Ops')), h('div', { class: 'error' }, friendly(e).message));
  }
}
setRerender(render);

async function start(hash) {
  await loadMe();
  state.d = null;
  if (hash && location.hash !== hash) location.hash = hash;
  else render();
}

buildShell();
window.addEventListener('hashchange', render);
// Ao girar o celular / mudar a largura entre celular e computador, redesenha (listas x tabelas).
MOBILE_MQ.addEventListener('change', () => {
  if (state.user && state.d && !document.querySelector('dialog[open]')) render();
});
// Tabelas viram cartões no celular: cada célula ganha o nome da coluna (data-label) a partir do cabeçalho.
function labelTables(root) {
  for (const table of root.querySelectorAll('table.data')) {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    for (const tr of table.querySelectorAll('tbody tr, tfoot tr')) {
      [...tr.children].forEach((td, i) => {
        if (heads[i] && !td.hasAttribute('data-label')) td.setAttribute('data-label', heads[i]);
      });
    }
  }
}
new MutationObserver(() => labelTables($('#app'))).observe($('#app'), { childList: true, subtree: true });
document.addEventListener('keydown', (e) => {
  // Atalhos: "n" novo lançamento, "v" lançamento por voz (fora de campos de texto)
  if ((e.key === 'n' || e.key === 'v') && !e.ctrlKey && !e.metaKey && !e.altKey && !/input|textarea|select/i.test(document.activeElement?.tagName ?? '')
    && !document.querySelector('dialog[open]') && state.d && canEdit('lancamentos')) {
    e.preventDefault();
    if (e.key === 'v') openVoiceDialog();
    else openTxDialog();
  }
});
if (configured) {
  sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') {
      state.recovering = true;
      setTimeout(() => start(), 0);
    } else if (event === 'SIGNED_OUT') {
      Object.assign(state, { user: null, houses: [], d: null, chat: [], needMfa: false });
      applyBranding();
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
