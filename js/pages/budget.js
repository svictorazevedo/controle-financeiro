// Orçamento: limite de gasto por categoria (padrão mensal ou só de um mês) e planejado x realizado.
import { sb, q } from '../api.js';
import { state, page, card, canEdit, field, moneyInput, houseRow, run, reload, emptyState } from '../ctx.js';
import { budgetStatus, budgetFor, addMonths } from '../finance.js';
import { h, brl, openDialog, parseMoney, centsToInput, monthLabel, segmented, toast, pctText } from '../ui.js';
import { icon } from '../icons.js';
import { progress } from '../charts.js';

function limitDialog(category) {
  const month = state.month;
  const specific = (state.d.budgets ?? []).find((b) => b.category_id === category.id && b.month === month);
  const def = (state.d.budgets ?? []).find((b) => b.category_id === category.id && !b.month);
  let scope = specific ? 'month' : 'default';
  const amount = moneyInput('amount', { value: (specific ?? def) ? centsToInput(Number((specific ?? def).amount_cents)) : '' });
  const seg = segmented('scope', [{ value: 'default', label: 'Todo mês' }, { value: 'month', label: `Só em ${monthLabel(month)}` }], scope, (v) => {
    scope = v;
    const b = v === 'month' ? specific ?? def : def;
    amount.querySelector('input').value = b ? centsToInput(Number(b.amount_cents)) : '';
  });
  const save = h('button', { type: 'submit', class: 'btn' }, icon('check', 18), h('span', {}, 'Salvar limite'));
  const remove = h('button', { type: 'button', class: 'btn ghost danger-text' }, 'Remover limite');
  const form = h('form', { class: 'stack' },
    h('p', { class: 'cat-chip lg' }, h('i', { style: { background: category.color } }), category.name),
    seg, field('Limite de gasto', amount, { hint: 'Inclui subcategorias, lançamentos e descontos automáticos.' }),
    h('div', { class: 'dialog-actions' }, (specific || def) ? remove : null, save));
  const d = openDialog({ title: 'Limite da categoria', body: form });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cents = parseMoney(amount.querySelector('input').value);
    if (!cents) return toast('Informe um valor.', true);
    const existing = scope === 'month' ? specific : def;
    const ok = await run(save, () => q(existing
      ? sb.from('budgets').update({ amount_cents: cents }).eq('id', existing.id).select('id').single()
      : sb.from('budgets').insert(houseRow({ category_id: category.id, month: scope === 'month' ? month : null, amount_cents: cents }))), 'Limite salvo.');
    if (ok) {
      d.close();
      await reload();
    }
  });
  remove.addEventListener('click', async () => {
    const target = scope === 'month' ? specific : def;
    if (!target) return toast('Não há limite nesse escopo.', true);
    if (await run(remove, () => q(sb.from('budgets').delete().eq('id', target.id)), 'Limite removido.')) {
      d.close();
      await reload();
    }
  });
}

export async function renderBudget() {
  const d = state.d;
  const bs = budgetStatus(d, state.month);
  const prev = budgetStatus(d, addMonths(state.month, -1));
  const edit = canEdit('orcamento');
  const rows = [...bs.rows].sort((a, b) => (b.planned ? 1 : 0) - (a.planned ? 1 : 0) || b.spent - a.spent);
  const available = bs.planned - bs.spent;

  const copyPrev = async () => {
    const toCopy = (d.budgets ?? []).filter((b) => b.month === addMonths(state.month, -1));
    if (!toCopy.length) return toast('O mês anterior não tem limites específicos para copiar.', true);
    const ok = await run(null, async () => {
      for (const b of toCopy) {
        if (budgetFor(d.budgets.filter((x) => x.month === state.month), b.category_id, state.month)) continue;
        await q(sb.from('budgets').insert(houseRow({ category_id: b.category_id, month: state.month, amount_cents: b.amount_cents })));
      }
    }, 'Limites copiados.');
    if (ok) await reload();
  };

  const table = h('table', { class: 'data budget' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Categoria'), h('th', { class: 'num' }, 'Planejado'), h('th', { class: 'num' }, 'Realizado'),
      h('th', { class: 'bar-col' }, 'Uso'), h('th', { class: 'num' }, 'Disponível'), h('th', { class: 'num' }, 'Mês anterior'), h('th', { class: 'act' }))),
    h('tbody', {}, ...rows.map((r) => {
      const pr = prev.rows.find((x) => x.category.id === r.category.id);
      return h('tr', { class: r.planned ? '' : 'dim' },
        h('td', {}, h('span', { class: 'cat-chip' }, h('i', { style: { background: r.category.color } }), r.category.name),
          r.specific ? h('span', { class: 'tag' }, 'só este mês') : null),
        h('td', { class: 'num' }, r.planned ? brl(r.planned) : '—'),
        h('td', { class: 'num' }, brl(r.spent)),
        h('td', { class: 'bar-col' }, r.planned ? h('div', { class: 'bar-cell' }, progress(r.ratio, r.status), h('span', { class: `num status-text ${r.status}` },
          r.status === 'over' ? icon('alert', 14) : null, pctText(r.ratio))) : h('span', { class: 'muted small' }, 'sem limite')),
        h('td', { class: `num ${r.planned && r.remaining < 0 ? 'neg' : ''}` }, r.planned ? brl(r.remaining) : '—'),
        h('td', { class: 'num muted' }, brl(pr?.spent ?? 0)),
        h('td', { class: 'act' }, edit ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => limitDialog(r.category) }, r.planned ? 'Alterar' : 'Definir') : null));
    })));

  const over = bs.rows.filter((r) => r.status === 'over');
  page('Orçamento', {
    subtitle: `Planejado x realizado em ${monthLabel(state.month)}`,
    actions: [edit ? h('button', { type: 'button', class: 'btn ghost', onclick: copyPrev }, icon('layers', 18), h('span', {}, 'Copiar do mês anterior')) : null],
  },
  h('div', { class: 'grid kpis' },
    h('section', { class: 'card kpi' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon('pie', 20)), h('span', { class: 'kpi-label' }, 'Planejado')), h('div', { class: 'kpi-value num' }, brl(bs.planned)), h('div', { class: 'kpi-sub' }, `${bs.rows.filter((r) => r.planned).length} categoria(s) com limite`)),
    h('section', { class: 'card kpi out' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon('arrow_out', 20)), h('span', { class: 'kpi-label' }, 'Realizado')), h('div', { class: 'kpi-value num' }, brl(bs.spent)), h('div', { class: 'kpi-sub' }, bs.planned ? `${pctText(bs.spent / bs.planned)} do planejado` : '—')),
    h('section', { class: `card kpi ${available < 0 ? 'neg' : 'pos'}` }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon('wallet', 20)), h('span', { class: 'kpi-label' }, 'Disponível')), h('div', { class: 'kpi-value num' }, brl(available)), h('div', { class: 'kpi-sub' }, available < 0 ? 'Orçamento estourado' : 'Ainda pode gastar')),
    h('section', { class: 'card kpi' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon('alert', 20)), h('span', { class: 'kpi-label' }, 'Fora do orçamento')), h('div', { class: 'kpi-value num' }, brl(bs.unbudgeted)), h('div', { class: 'kpi-sub' }, 'Gastos em categorias sem limite'))),
  over.length ? h('div', { class: 'alert warn' }, icon('alert', 18), h('span', {}, `Acima do limite: ${over.map((r) => `${r.category.name} (+${brl(-r.remaining)})`).join(', ')}.`)) : null,
  card(null, { cls: 'flush' }, rows.length ? h('div', { class: 'table-wrap' }, table) : emptyState('tag', 'Nenhuma categoria de saída', 'Crie categorias em Categorias.')),
  h('p', { class: 'hint' }, '“Todo mês” vale para todos os meses; “Só neste mês” substitui o padrão apenas no mês escolhido. Subcategorias somam na categoria-mãe.'));
}
