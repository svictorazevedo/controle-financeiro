// Categorias e subcategorias de entrada e de saída, com cor.
import { sb, q } from '../api.js';
import { state, page, card, canEdit, isAdmin, field, input, select, colorPicker, houseRow, run, reload, emptyState } from '../ctx.js';
import { categoryTree } from '../finance.js';
import { h, openDialog, confirmDialog, menuButton, segmented } from '../ui.js';
import { icon } from '../icons.js';

function categoryDialog(c = null, { type = 'expense', parentId = null } = {}) {
  let t = c?.type ?? type;
  const name = input('name', { required: true, maxlength: 60, value: c?.name ?? '', placeholder: 'Ex.: Academia' });
  const parentWrap = h('div', { class: 'field-slot' });
  let parent;
  const paintParent = (val) => {
    const tops = state.d.categories.filter((x) => (x.type ?? 'expense') === t && !x.parent_id && x.id !== c?.id)
      .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    parent = select('parent', [{ value: '', label: '— Nenhuma (categoria principal) —' }, ...tops.map((x) => ({ value: x.id, label: x.name }))], val ?? '');
    const hasKids = c && state.d.categories.some((x) => x.parent_id === c.id);
    parent.disabled = !!hasKids;
    parentWrap.replaceChildren(field('Subcategoria de', parent, { hint: hasKids ? 'Esta categoria tem subcategorias, então continua principal.' : null }));
  };
  paintParent(c?.parent_id ?? parentId);
  const color = colorPicker('color', c?.color);
  const typeSeg = segmented('ctype', [{ value: 'expense', label: 'Saída', cls: 'seg-expense' }, { value: 'income', label: 'Entrada', cls: 'seg-income' }], t, (v) => {
    t = v;
    paintParent('');
  });
  if (c) typeSeg.querySelectorAll('input').forEach((i) => { i.disabled = true; });
  const save = h('button', { type: 'submit', class: 'btn' }, icon('check', 18), h('span', {}, 'Salvar'));
  const form = h('form', { class: 'stack' }, typeSeg, field('Nome', name), parentWrap,
    h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Cor de identificação'), color),
    h('div', { class: 'dialog-actions' }, save));
  const d = openDialog({ title: c ? 'Editar categoria' : 'Nova categoria', body: form });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const row = { name: name.value.trim(), parent_id: parent.value || null, color: color.value() };
    if (!c) row.type = t;
    if (await run(save, () => q(c ? sb.from('categories').update(row).eq('id', c.id).select('id').single() : sb.from('categories').insert(houseRow(row))), 'Categoria salva.')) {
      d.close();
      await reload();
    }
  });
}

function column(type, title, iconName) {
  const tree = categoryTree(state.d.categories, type);
  const edit = canEdit('categorias');
  const actions = (c, isTop) => (edit ? menuButton([
    { label: 'Editar', icon: 'pencil', onclick: () => categoryDialog(c) },
    isTop ? { label: 'Nova subcategoria', icon: 'plus', onclick: () => categoryDialog(null, { type, parentId: c.id }) } : null,
    isAdmin() ? {
      label: 'Excluir', icon: 'trash', danger: true,
      onclick: async () => {
        const kids = state.d.categories.filter((x) => x.parent_id === c.id).length;
        if (!await confirmDialog(`Excluir a categoria "${c.name}"?`, {
          title: 'Excluir categoria', danger: true, confirmText: 'Excluir',
          detail: `${kids ? `As ${kids} subcategoria(s) também serão excluídas. ` : ''}Os lançamentos ficam “Sem categoria” e o limite de orçamento é removido.`,
        })) return;
        if (await run(null, () => q(sb.from('categories').delete().eq('id', c.id)), 'Categoria excluída.')) await reload();
      },
    } : null,
  ]) : null);
  return card(title, {
    sub: `${tree.length} categoria(s), ${tree.reduce((s, c) => s + c.children.length, 0)} subcategoria(s)`,
    actions: edit ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => categoryDialog(null, { type }) }, icon('plus', 16), h('span', {}, 'Nova')) : null,
  }, tree.length ? h('ul', { class: 'cat-tree' }, ...tree.map((c) => h('li', {},
    h('div', { class: 'cat-row' }, h('span', { class: 'cat-dot', style: { background: c.color || 'var(--muted-mark)' } }), h('span', { class: 'cat-name' }, c.name),
      c.is_default ? h('span', { class: 'tag' }, 'padrão') : null, actions(c, true)),
    c.children.length ? h('ul', {}, ...c.children.map((k) => h('li', {}, h('div', { class: 'cat-row sub' },
      h('span', { class: 'cat-dot', style: { background: k.color || c.color || 'var(--muted-mark)' } }), h('span', { class: 'cat-name' }, k.name), actions(k, false))))) : null)))
    : emptyState(iconName, 'Nenhuma categoria', null));
}

export async function renderCategories() {
  page('Categorias', {
    subtitle: 'Organize entradas e saídas; subcategorias somam na categoria principal',
  }, h('div', { class: 'grid cols-2' }, column('expense', 'Saídas', 'arrow_out'), column('income', 'Entradas', 'arrow_in')),
  h('p', { class: 'hint' }, isAdmin() ? 'Ao excluir uma categoria, os lançamentos dela ficam “Sem categoria”.' : 'Apenas administradores excluem categorias.'));
}
