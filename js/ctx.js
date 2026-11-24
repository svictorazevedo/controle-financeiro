// Estado do app e utilidades compartilhadas pelas telas.
import { sb, q, friendly } from './api.js';
import { permOf, localToday, topCategory } from './finance.js';
import { h, toast, clear, $, setCurrency } from './ui.js';
import { icon } from './icons.js';

export const state = {
  user: null,
  houses: [],        // [{ id, name, role, residentId }]
  houseId: null,
  d: null,           // dados da casa atual
  month: localToday().slice(0, 7),
  chat: [],
  recovering: false,
  needMfa: false,
};
try {
  state.houseId = localStorage.getItem('houseId') || null;
} catch { /* armazenamento indisponível */ }

// ---------------------------------------------------------------- dados
export async function loadMe() {
  const { data: { session } } = await sb.auth.getSession();
  state.user = session?.user ?? null;
  state.houses = [];
  state.needMfa = false;
  if (!state.user) return;
  // 2FA: com fator verificado e sessão só com senha, pede o código antes de carregar qualquer dado.
  try {
    const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal && aal.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
      state.needMfa = true;
      return;
    }
  } catch { /* sem MFA disponível */ }
  const rows = await q(sb.from('residents').select('id, role, house_id, houses(name)').eq('user_id', state.user.id));
  state.houses = rows.map((r) => ({ id: r.house_id, name: r.houses?.name ?? 'Casa', role: r.role, residentId: r.id }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!state.houses.some((x) => x.id === state.houseId)) state.houseId = state.houses[0]?.id ?? null;
}

/** Busca todas as linhas (o Supabase devolve no máximo 1000 por vez). */
async function all(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = await q(build().range(from, from + 999));
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

export async function loadHouse() {
  const h0 = state.houseId;
  const [house, residents, categories, accounts, incomes, goals, recurring, budgets, savingsGoals, deposits, ai, transactions] = await Promise.all([
    q(sb.from('houses').select('id, name, currency, logo, icon').eq('id', h0).single()),
    q(sb.from('residents').select('id, name, role, user_id, permissions').eq('house_id', h0).order('created_at')),
    q(sb.from('categories').select('id, name, type, parent_id, color, is_default').eq('house_id', h0).order('name')),
    q(sb.from('accounts').select('*').eq('house_id', h0).order('created_at')),
    q(sb.from('incomes').select('*').eq('house_id', h0).order('start_month', { ascending: false })),
    q(sb.from('goals').select('*').eq('house_id', h0).order('created_at')),
    q(sb.from('recurring').select('*').eq('house_id', h0).order('created_at', { ascending: false })),
    q(sb.from('budgets').select('*').eq('house_id', h0)),
    q(sb.from('savings_goals').select('*').eq('house_id', h0).order('created_at')),
    q(sb.from('goal_deposits').select('*').eq('house_id', h0).order('date', { ascending: false })),
    q(sb.from('ai_settings').select('provider, model, base_url, key_hint').eq('house_id', h0).maybeSingle()),
    all(() => sb.from('transactions').select('*').eq('house_id', h0).order('date', { ascending: false }).order('created_at', { ascending: false })),
  ]);
  const meRow = state.houses.find((x) => x.id === h0);
  const invites = meRow?.role === 'admin' ? await q(sb.from('invites').select('resident_id, expires_at').eq('house_id', h0)) : [];
  state.d = { house, residents, categories, accounts, incomes, goals, recurring, budgets, savingsGoals, deposits, ai, invites, transactions };
  setCurrency(house.currency);
  applyBranding();
  try {
    localStorage.setItem('houseId', h0);
  } catch { /* ignore */ }
}

/** Ícone próprio da casa/empresa na aba do navegador. */
export function applyBranding() {
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = state.d?.house?.icon || 'icon.svg?v=2';
  document.title = state.d?.house?.name ? `${state.d.house.name} · Controle Financeiro` : 'Controle Financeiro';
}

// ---------------------------------------------------------------- quem sou eu
export const me = () => state.houses.find((x) => x.id === state.houseId);
export const isAdmin = () => me()?.role === 'admin';
export const myResidentId = () => me()?.residentId;
export const myResident = () => state.d?.residents.find((r) => r.id === myResidentId()) ?? (me() ? { role: me().role } : null);
/** 0 = sem acesso, 1 = ver, 2 = editar */
export const perm = (module) => permOf(myResident(), module);
export const canEdit = (module) => perm(module) === 2;

// ---------------------------------------------------------------- nomes
export const residentName = (id) => (id ? state.d.residents.find((r) => r.id === id)?.name ?? 'Ex-morador' : 'Casa');
export const accountName = (id) => (id ? state.d.accounts.find((a) => a.id === id)?.name ?? 'Conta removida' : 'Sem conta');
export function category(id) {
  return state.d.categories.find((c) => c.id === id) ?? null;
}
export function categoryLabel(id) {
  const c = category(id);
  if (!c) return 'Sem categoria';
  const p = c.parent_id ? category(c.parent_id) : null;
  return p ? `${p.name} › ${c.name}` : c.name;
}
export const categoryColor = (id) => topCategory(state.d.categories, id)?.color ?? category(id)?.color ?? 'var(--muted-mark)';

export function categoryChip(id) {
  return h('span', { class: 'cat-chip' }, h('i', { style: { background: category(id)?.color || categoryColor(id) } }), categoryLabel(id));
}

// ---------------------------------------------------------------- opções de formulário
export const residentsOptions = (withHouse) => [
  ...(withHouse ? [{ value: '', label: 'Casa (compartilhado)' }] : []),
  ...state.d.residents.filter((r) => isAdmin() || r.id === myResidentId()).map((r) => ({ value: r.id, label: r.name })),
];
export const accountOptions = (withNone = false) => [
  ...(withNone ? [{ value: '', label: 'Sem conta' }] : []),
  ...state.d.accounts.filter((a) => !a.archived).map((a) => ({ value: a.id, label: a.name })),
];

/** <select> de categorias do tipo, com subcategorias agrupadas. */
export function categorySelect(name, type, value = '', { allowNone = true, onlyTop = false } = {}) {
  const el = h('select', { name });
  if (allowNone) el.append(h('option', { value: '' }, 'Sem categoria'));
  const mine = state.d.categories.filter((c) => (c.type ?? 'expense') === type);
  const tops = mine.filter((c) => !c.parent_id).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  for (const t of tops) {
    const kids = onlyTop ? [] : mine.filter((c) => c.parent_id === t.id).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    if (kids.length) {
      el.append(h('optgroup', { label: t.name }, h('option', { value: t.id }, `${t.name} (geral)`), ...kids.map((k) => h('option', { value: k.id }, k.name))));
    } else el.append(h('option', { value: t.id }, t.name));
  }
  el.value = value ?? '';
  return el;
}

export const houseRow = (obj) => ({ ...obj, house_id: state.houseId });

// ---------------------------------------------------------------- ações
/** Executa uma ação mostrando erros como aviso, desabilitando o botão durante o envio. */
export async function run(btn, fn, okMsg) {
  if (btn) {
    btn.disabled = true;
    btn.classList.add('busy');
  }
  try {
    const out = await fn();
    if (okMsg) toast(okMsg);
    return out ?? true;
  } catch (e) {
    toast(friendly(e).message, true);
    return undefined;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }
}

/** Recarrega os dados da casa e redesenha a tela atual. */
export let rerender = async () => {};
export function setRerender(fn) {
  rerender = fn;
}
export async function reload() {
  await loadHouse();
  await rerender();
}

// ---------------------------------------------------------------- componentes de formulário
export function field(label, input, { cls = '', hint = null } = {}) {
  input.id ||= `f-${Math.random().toString(36).slice(2, 9)}`;
  return h('div', { class: `field ${cls}` }, h('label', { for: input.id }, label), input, hint ? h('small', { class: 'hint' }, hint) : null);
}
export const input = (name, attrs = {}) => h('input', { name, ...attrs });
export function select(name, options, value = '') {
  const el = h('select', { name }, ...options.map((o) => h('option', { value: o.value }, o.label)));
  el.value = value ?? '';
  return el;
}
export function moneyInput(name, attrs = {}) {
  return h('div', { class: 'money-input' }, h('span', { class: 'prefix' }, currencySymbol()),
    h('input', { name, inputmode: 'decimal', placeholder: '0,00', autocomplete: 'off', ...attrs }));
}
export function currencySymbol() {
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: state.d?.house?.currency || 'BRL' })
      .formatToParts(0).find((p) => p.type === 'currency')?.value ?? 'R$';
  } catch {
    return 'R$';
  }
}

export const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948', '#73726c'];
export function colorPicker(name, value) {
  const wrap = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Cor' });
  for (const c of COLORS) {
    const id = `${name}-${c.slice(1)}-${Math.random().toString(36).slice(2, 6)}`;
    wrap.append(h('input', { type: 'radio', name, id, value: c, checked: c === (value || COLORS[0]) }),
      h('label', { for: id, style: { '--c': c }, title: c }, h('span', { class: 'sr-only' }, c)));
  }
  wrap.value = () => wrap.querySelector('input:checked')?.value ?? COLORS[0];
  return wrap;
}

/** Cabeçalho de página com título, subtítulo e ações à direita. */
export function page(title, { subtitle = null, actions = [] } = {}, ...children) {
  const app = $('#app');
  clear(app);
  app.append(h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), subtitle ? h('p', { class: 'page-sub' }, subtitle) : null),
    actions.filter(Boolean).length ? h('div', { class: 'page-actions' }, ...actions.filter(Boolean)) : null), ...children.filter(Boolean));
}

export function emptyState(iconName, title, text, action = null) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, icon(iconName, 28)), h('strong', {}, title), text ? h('p', {}, text) : null, action);
}

export function btn(label, { iconName = null, cls = '', onclick = null, type = 'button', title = null } = {}) {
  return h('button', { type, class: `btn ${cls}`, onclick, title }, iconName ? icon(iconName, 18) : null, label ? h('span', {}, label) : null);
}

export function card(title, { actions = null, cls = '', sub = null } = {}, ...children) {
  return h('section', { class: `card ${cls}` },
    title ? h('header', { class: 'card-head' }, h('div', {}, h('h2', {}, title), sub ? h('p', { class: 'card-sub' }, sub) : null), actions) : null,
    ...children);
}

/** Lê o parâmetro da rota: #/relatorios?r=extrato&conta=... */
export function routeParams() {
  const qs = location.hash.split('?')[1] ?? '';
  return new URLSearchParams(qs);
}
