// Lançamentos: lista com filtros por tipo, período, conta, categoria e busca.
import { state, page, card, canEdit, categoryChip, categoryLabel, categoryColor, accountName, residentName, emptyState, routeParams, select, field, input, accountOptions, categorySelect } from '../ctx.js';
import { movements, sumBy, localToday, addMonths, dateFor, addDays, topCategory } from '../finance.js';
import { h, brl, dateBr, menuButton, segmented, monthLabel, download, isMobile, actionSheet, dayLabel } from '../ui.js';
import { icon } from '../icons.js';
import { openTxDialog, deleteTx, viewAttachment, canChangeTx } from './tx.js';
import { openVoiceDialog } from './voice.js';

// Filtros ficam guardados enquanto o app está aberto.
const filters = { type: 'all', preset: 'month', from: null, to: null, account: '', category: '', q: '', auto: true, open: false };

function presetRange(p) {
  const today = localToday();
  const m = state.month;
  switch (p) {
    case 'month': return [`${m}-01`, dateFor(m, 31)];
    case 'prev': return [`${addMonths(m, -1)}-01`, dateFor(addMonths(m, -1), 31)];
    case '30d': return [addDays(today, -29), today];
    case 'year': return [`${m.slice(0, 4)}-01-01`, `${m.slice(0, 4)}-12-31`];
    default: return [filters.from ?? `${m}-01`, filters.to ?? dateFor(m, 31)];
  }
}

export async function renderTransactions() {
  const params = routeParams();
  if (params.get('tipo')) filters.type = params.get('tipo');
  const d = state.d;
  const [from, to] = presetRange(filters.preset);
  filters.from = from;
  filters.to = to;

  const list = movements(d, from, to, { automatic: filters.auto }).filter((m) => {
    if (filters.type !== 'all' && m.type !== filters.type) return false;
    if (filters.account && (m.accountId ?? '') !== (filters.account === 'none' ? '' : filters.account)) return false;
    if (filters.category) {
      const top = topCategory(d.categories, m.categoryId);
      if (m.categoryId !== filters.category && top?.id !== filters.category) return false;
    }
    if (filters.q && !m.description.toLowerCase().includes(filters.q.toLowerCase())) return false;
    return true;
  }).reverse();
  const tot = sumBy(list);

  const rerun = () => renderTransactions();
  const typeSeg = segmented('ftype', [
    { value: 'all', label: 'Todos' }, { value: 'income', label: 'Entradas', cls: 'seg-income' }, { value: 'expense', label: 'Saídas', cls: 'seg-expense' },
  ], filters.type, (v) => {
    filters.type = v;
    rerun();
  });
  const preset = select('preset', [
    { value: 'month', label: `Mês selecionado (${monthLabel(state.month)})` }, { value: 'prev', label: 'Mês anterior' },
    { value: '30d', label: 'Últimos 30 dias' }, { value: 'year', label: `Ano de ${state.month.slice(0, 4)}` }, { value: 'custom', label: 'Personalizado…' },
  ], filters.preset);
  const fromIn = input('from', { type: 'date', value: from });
  const toIn = input('to', { type: 'date', value: to });
  const custom = h('div', { class: 'filter-dates', hidden: filters.preset !== 'custom' }, field('De', fromIn), field('Até', toIn));
  preset.addEventListener('change', () => {
    filters.preset = preset.value;
    rerun();
  });
  for (const el of [fromIn, toIn]) {
    el.addEventListener('change', () => {
      if (fromIn.value && toIn.value && fromIn.value <= toIn.value) {
        filters.from = fromIn.value;
        filters.to = toIn.value;
        rerun();
      }
    });
  }
  const acc = select('account', [{ value: '', label: 'Todas as contas' }, ...accountOptions(), { value: 'none', label: 'Sem conta' }], filters.account);
  acc.addEventListener('change', () => {
    filters.account = acc.value;
    rerun();
  });
  const cat = categorySelect('category', filters.type === 'income' ? 'income' : 'expense', filters.category, { allowNone: false });
  cat.prepend(h('option', { value: '' }, 'Todas as categorias'));
  if (filters.type === 'all') {
    const inc = categorySelect('x', 'income', '', { allowNone: false });
    cat.append(h('optgroup', { label: '— Entradas —' }, ...[...inc.querySelectorAll('option')].map((o) => o.cloneNode(true))));
  }
  cat.value = filters.category;
  cat.addEventListener('change', () => {
    filters.category = cat.value;
    rerun();
  });
  const search = input('q', { type: 'search', placeholder: 'Buscar descrição…', value: filters.q, 'aria-label': 'Buscar' });
  let timer;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      filters.q = search.value;
      rerun().then(() => {
        const s = document.querySelector('input[name=q]');
        s?.focus();
        s?.setSelectionRange(s.value.length, s.value.length);
      });
    }, 250);
  });
  const autoChk = h('input', { type: 'checkbox', checked: filters.auto });
  autoChk.addEventListener('change', () => {
    filters.auto = autoChk.checked;
    rerun();
  });

  const mobile = isMobile();
  const active = (filters.preset !== 'month') + !!filters.account + !!filters.category + !filters.auto;
  const extra = h('div', { class: 'toolbar-extra', hidden: mobile && !filters.open },
    h('div', { class: 'toolbar-fields' },
      h('label', { class: 'sr-only', for: preset.id = 'f-preset' }, 'Período'), preset, custom,
      h('label', { class: 'sr-only', for: acc.id = 'f-acc' }, 'Conta'), acc,
      h('label', { class: 'sr-only', for: cat.id = 'f-cat' }, 'Categoria'), cat,
      mobile ? null : h('div', { class: 'search' }, icon('search', 16), search)),
    h('label', { class: 'check' }, autoChk, ' Incluir automáticos (rendas fixas, descontos e parcelas)'));
  const filterBtn = h('button', {
    type: 'button', class: `btn ghost filter-btn${active ? ' on' : ''}`, 'aria-expanded': String(!!filters.open),
    onclick: () => {
      filters.open = !filters.open;
      extra.hidden = !filters.open;
      filterBtn.setAttribute('aria-expanded', String(filters.open));
    },
  }, icon('filter', 18), h('span', {}, 'Filtros'), active ? h('span', { class: 'badge' }, String(active)) : null);
  const toolbar = mobile
    ? h('div', { class: 'toolbar card' }, typeSeg, h('div', { class: 'toolbar-row' }, h('div', { class: 'search' }, icon('search', 16), search), filterBtn), extra)
    : h('div', { class: 'toolbar card' }, typeSeg, extra);

  const summary = h('div', { class: 'summary-strip' },
    h('div', {}, h('span', {}, 'Entradas'), h('strong', { class: 'num pos' }, brl(tot.income))),
    h('div', {}, h('span', {}, 'Saídas'), h('strong', { class: 'num neg' }, brl(tot.expense))),
    h('div', {}, h('span', {}, 'Saldo do período'), h('strong', { class: `num ${tot.balance < 0 ? 'neg' : ''}` }, brl(tot.balance))),
    h('div', {}, h('span', {}, 'Lançamentos'), h('strong', { class: 'num' }, String(list.length))));

  const txById = new Map(d.transactions.map((t) => [t.id, t]));
  const table = h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Data'), h('th', {}, 'Descrição'), h('th', {}, 'Categoria'), h('th', {}, 'Conta'), h('th', {}, 'De'),
      h('th', { class: 'num' }, 'Valor'), h('th', { class: 'act' }, h('span', { class: 'sr-only' }, 'Ações')))),
    h('tbody', {}, ...list.map((m) => {
      const tx = m.source === 'tx' ? txById.get(m.id) : null;
      const isIn = m.type === 'income';
      return h('tr', { class: m.source === 'auto' ? 'auto' : '' },
        h('td', { class: 'num nowrap' }, dateBr(m.date)),
        h('td', {}, h('div', { class: 'desc-cell' },
          h('span', { class: `mv-ico sm ${isIn ? 'in' : 'out'}` }, icon(isIn ? 'arrow_in' : 'arrow_out', 14)),
          h('span', {}, m.description),
          m.source === 'auto' ? h('span', { class: 'tag', title: 'Lançado automaticamente (Fixos e recorrentes)' }, m.detail) : null,
          m.attachment ? h('button', { type: 'button', class: 'icon-btn sm', title: 'Ver comprovante', 'aria-label': 'Ver comprovante', onclick: () => viewAttachment(m.attachment) }, icon('clip', 15)) : null)),
        h('td', {}, categoryChip(m.categoryId)),
        h('td', {}, accountName(m.accountId)),
        h('td', {}, residentName(m.residentId)),
        h('td', { class: `num ${isIn ? 'pos' : 'neg'}` }, `${isIn ? '+' : '−'} ${brl(m.amount)}`),
        h('td', { class: 'act' }, tx && canChangeTx(tx) ? menuButton([
          { label: 'Editar', icon: 'pencil', onclick: () => openTxDialog(tx) },
          tx.attachment_path ? { label: 'Ver comprovante', icon: 'clip', onclick: () => viewAttachment(tx.attachment_path) } : null,
          { label: 'Duplicar', icon: 'layers', onclick: () => openTxDialog(tx, { copy: true, date: localToday() }) },
          { label: 'Excluir', icon: 'trash', danger: true, onclick: () => deleteTx(tx) },
        ]) : m.source === 'auto' && canEdit('recorrentes') ? h('a', { class: 'icon-btn sm', href: '#/recorrentes', title: 'Editar em Fixos e recorrentes', 'aria-label': 'Editar em Fixos e recorrentes' }, icon('repeat', 15)) : null));
    })));

  const exportCsv = () => {
    const rows = [['Data', 'Tipo', 'Descrição', 'Categoria', 'Conta', 'De', 'Valor']];
    for (const m of list) {
      rows.push([dateBr(m.date), m.type === 'income' ? 'Entrada' : 'Saída', m.description, categoryChip(m.categoryId).textContent, accountName(m.accountId),
        residentName(m.residentId), ((m.type === 'income' ? 1 : -1) * m.amount / 100).toFixed(2).replace('.', ',')]);
    }
    const esc = (v) => {
      let s = String(v);
      if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d/.test(s))) s = `'${s}`;
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    download(`lancamentos_${from}_${to}.csv`, `﻿${rows.map((r) => r.map(esc).join(';')).join('\r\n')}`, 'text/csv;charset=utf-8');
  };

  // Celular: lista agrupada por dia; tocar no item abre a edição (ou as opções).
  const rowActions = (m, tx) => {
    if (tx && canChangeTx(tx)) {
      return actionSheet(m.description, [
        { label: 'Editar', icon: 'pencil', onclick: () => openTxDialog(tx) },
        tx.attachment_path ? { label: 'Ver comprovante', icon: 'clip', onclick: () => viewAttachment(tx.attachment_path) } : null,
        { label: 'Duplicar para hoje', icon: 'layers', onclick: () => openTxDialog(tx, { copy: true, date: localToday() }) },
        { label: 'Excluir', icon: 'trash', danger: true, onclick: () => deleteTx(tx) },
      ]);
    }
    if (m.attachment) return viewAttachment(m.attachment);
    if (m.source === 'auto' && canEdit('recorrentes')) location.hash = '#/recorrentes';
    return null;
  };
  const mobileList = () => {
    const groups = new Map();
    for (const m of list) {
      if (!groups.has(m.date)) groups.set(m.date, []);
      groups.get(m.date).push(m);
    }
    return h('div', { class: 'day-groups' }, ...[...groups].map(([date, items]) => {
      const t = sumBy(items);
      return h('section', { class: 'day-group' },
        h('header', { class: 'day-head' }, h('span', {}, dayLabel(date)),
          h('span', { class: `num ${t.balance < 0 ? 'neg' : 'pos'}` }, `${t.balance < 0 ? '−' : '+'} ${brl(Math.abs(t.balance))}`)),
        h('ul', { class: 'mv-list card' }, ...items.map((m) => {
          const tx = m.source === 'tx' ? txById.get(m.id) : null;
          const isIn = m.type === 'income';
          return h('li', {}, h('button', { type: 'button', class: 'mv tap', onclick: () => rowActions(m, tx) },
            h('span', { class: 'mv-ico', style: { '--c': categoryColor(m.categoryId) } }, icon(isIn ? 'arrow_in' : 'arrow_out', 16)),
            h('span', { class: 'mv-main' },
              h('span', { class: 'mv-desc' }, h('span', { class: 'ell' }, m.description),
                m.source === 'auto' ? h('span', { class: 'tag', title: 'Lançado automaticamente (Fixos e recorrentes)' }, m.detail || 'automático') : null,
                m.attachment ? h('span', { class: 'clip', title: 'Tem comprovante' }, icon('clip', 14)) : null),
              h('span', { class: 'mv-meta' }, categoryLabel(m.categoryId), ' · ', accountName(m.accountId))),
            h('span', { class: `mv-val num ${isIn ? 'pos' : ''}` }, `${isIn ? '+' : '−'} ${brl(m.amount)}`)));
        })));
    }));
  };

  page('Lançamentos', {
    subtitle: `${dateBr(from)} a ${dateBr(to)}`,
    actions: [
      h('button', { type: 'button', class: 'btn ghost compact', onclick: exportCsv, title: 'Exportar CSV' }, icon('download', 18), h('span', {}, 'CSV')),
      canEdit('lancamentos') && !mobile ? h('button', { type: 'button', class: 'btn ghost', onclick: () => openVoiceDialog() }, icon('mic', 18), h('span', {}, 'Por voz')) : null,
      canEdit('lancamentos') && !mobile ? h('button', { type: 'button', class: 'btn income', onclick: () => openTxDialog(null, { type: 'income' }) }, icon('arrow_in', 18), h('span', {}, 'Entrada')) : null,
      canEdit('lancamentos') && !mobile ? h('button', { type: 'button', class: 'btn expense', onclick: () => openTxDialog(null, { type: 'expense' }) }, icon('arrow_out', 18), h('span', {}, 'Saída')) : null,
    ],
  },
  toolbar, summary,
  list.length ? (mobile ? mobileList() : card(null, { cls: 'flush' }, h('div', { class: 'table-wrap' }, table)))
    : card(null, { cls: 'flush' }, emptyState('receipt', 'Nenhum lançamento encontrado', 'Mude os filtros ou lance uma entrada/saída.')));
}
