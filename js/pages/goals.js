// Metas de economia: valor-alvo, data-alvo, aportes/retiradas e progresso automático.
import { sb, q } from '../api.js';
import { state, page, card, canEdit, field, input, moneyInput, colorPicker, houseRow, run, reload, emptyState } from '../ctx.js';
import { goalProgress, localToday } from '../finance.js';
import { h, brl, openDialog, confirmDialog, parseMoney, centsToInput, dateBr, menuButton, toast, pctText, segmented } from '../ui.js';
import { icon } from '../icons.js';
import { ring, progress } from '../charts.js';

function goalDialog(g = null) {
  const f = {
    name: input('name', { required: true, maxlength: 80, value: g?.name ?? '', placeholder: 'Ex.: Viagem de férias' }),
    target: moneyInput('target', { required: true, value: g ? centsToInput(Number(g.target_cents)) : '' }),
    date: input('date', { type: 'date', value: g?.target_date ?? '' }),
    color: colorPicker('color', g?.color),
    archived: h('input', { type: 'checkbox', checked: !!g?.archived }),
  };
  const save = h('button', { type: 'submit', class: 'btn' }, icon('check', 18), h('span', {}, 'Salvar meta'));
  const form = h('form', { class: 'form-grid' },
    field('Nome da meta', f.name, { cls: 'span-2' }), field('Valor da meta', f.target), field('Data-alvo (opcional)', f.date),
    h('div', { class: 'field span-2' }, h('span', { class: 'lbl' }, 'Cor'), f.color),
    g ? h('label', { class: 'check span-2' }, f.archived, ' Arquivar meta') : null,
    h('div', { class: 'dialog-actions span-2' }, save));
  const d = openDialog({ title: g ? 'Editar meta' : 'Nova meta de economia', body: form });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const target = parseMoney(f.target.querySelector('input').value);
    if (!target) return toast('Informe o valor da meta.', true);
    const row = { name: f.name.value.trim(), target_cents: target, target_date: f.date.value || null, color: f.color.value(), archived: f.archived.checked };
    if (await run(save, () => q(g ? sb.from('savings_goals').update(row).eq('id', g.id).select('id').single() : sb.from('savings_goals').insert(houseRow(row))), 'Meta salva.')) {
      d.close();
      await reload();
    }
  });
}

function depositDialog(g, kind = 'in') {
  let k = kind;
  const amount = moneyInput('amount', { required: true });
  const date = input('date', { type: 'date', required: true, value: localToday() });
  const note = input('note', { maxlength: 120, placeholder: 'Opcional' });
  const seg = segmented('dk', [{ value: 'in', label: 'Aporte', icon: 'plus', cls: 'seg-income' }, { value: 'out', label: 'Retirada', icon: 'minus', cls: 'seg-expense' }], k, (v) => { k = v; });
  const save = h('button', { type: 'submit', class: 'btn' }, icon('check', 18), h('span', {}, 'Registrar'));
  const form = h('form', { class: 'form-grid' }, h('div', { class: 'span-2' }, seg), field('Valor', amount, { cls: 'big-money' }), field('Data', date),
    field('Observação', note, { cls: 'span-2' }), h('div', { class: 'dialog-actions span-2' }, save));
  const d = openDialog({ title: `Movimentar “${g.name}”`, body: form });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cents = parseMoney(amount.querySelector('input').value);
    if (!cents) return toast('Informe um valor.', true);
    const row = { goal_id: g.id, amount_cents: k === 'in' ? cents : -cents, date: date.value, note: note.value.trim() || null };
    if (await run(save, () => q(sb.from('goal_deposits').insert(houseRow(row))), k === 'in' ? 'Aporte registrado.' : 'Retirada registrada.')) {
      d.close();
      await reload();
    }
  });
}

function historyDialog(g, p) {
  const edit = canEdit('metas');
  openDialog({
    title: `Histórico — ${g.name}`, wide: true,
    body: p.deposits.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Data'), h('th', {}, 'Observação'), h('th', { class: 'num' }, 'Valor'), h('th', { class: 'act' }))),
      h('tbody', {}, ...p.deposits.map((dp) => h('tr', {},
        h('td', { class: 'num' }, dateBr(dp.date)), h('td', {}, dp.note ?? ''),
        h('td', { class: `num ${dp.amount_cents < 0 ? 'neg' : 'pos'}` }, `${dp.amount_cents < 0 ? '−' : '+'} ${brl(Math.abs(Number(dp.amount_cents)))}`),
        h('td', { class: 'act' }, edit ? h('button', {
          type: 'button', class: 'icon-btn sm', 'aria-label': 'Excluir movimento',
          onclick: async (e) => {
            if (!await confirmDialog('Excluir este movimento da meta?', { danger: true, confirmText: 'Excluir' })) return;
            if (await run(e.currentTarget, () => q(sb.from('goal_deposits').delete().eq('id', dp.id)), 'Excluído.')) {
              document.querySelector('dialog[open]')?.close();
              await reload();
            }
          },
        }, icon('trash', 15)) : null))))))
      : emptyState('piggy', 'Sem movimentos', 'Registre o primeiro aporte.'),
  });
}

let showArchived = false;

export async function renderGoals() {
  const d = state.d;
  const today = localToday();
  const edit = canEdit('metas');
  const goals = (d.savingsGoals ?? []).filter((g) => showArchived || !g.archived).map((g) => ({ g, p: goalProgress(g, d.deposits ?? [], today) }));
  const active = goals.filter((x) => !x.g.archived);
  const saved = active.reduce((s, x) => s + x.p.saved, 0);
  const target = active.reduce((s, x) => s + x.p.target, 0);
  const monthly = active.reduce((s, x) => s + (x.p.monthly ?? 0), 0);
  const STATUS = { done: ['Concluída', 'good', 'check'], late: ['Prazo vencido', 'bad', 'alert'], active: ['Em andamento', 'info', 'clock'] };

  const cards = goals.map(({ g, p }) => {
    const [label, tone, ic] = STATUS[p.status];
    return h('section', { class: `card goal-card${g.archived ? ' archived' : ''}`, style: { '--c': g.color || 'var(--accent)' } },
      h('header', { class: 'goal-head' }, ring(p.ratio, g.color || 'var(--accent)'),
        h('div', { class: 'goal-title' }, h('strong', {}, g.name), h('span', { class: `status ${tone}` }, icon(ic, 13), label)),
        edit ? menuButton([
          { label: 'Editar', icon: 'pencil', onclick: () => goalDialog(g) },
          { label: 'Histórico', icon: 'clock', onclick: () => historyDialog(g, p) },
          {
            label: 'Excluir', icon: 'trash', danger: true,
            onclick: async () => {
              if (!await confirmDialog(`Excluir a meta "${g.name}" e todo o histórico de aportes?`, { title: 'Excluir meta', danger: true, confirmText: 'Excluir' })) return;
              if (await run(null, () => q(sb.from('savings_goals').delete().eq('id', g.id)), 'Meta excluída.')) await reload();
            },
          },
        ]) : null),
      h('div', { class: 'goal-amounts' }, h('strong', { class: 'num' }, brl(p.saved)), h('span', { class: 'muted' }, ` de ${brl(p.target)}`)),
      progress(p.ratio, p.status === 'late' ? 'over' : p.status === 'done' ? 'done' : 'ok', g.color),
      h('dl', { class: 'acc-stats' },
        h('div', {}, h('dt', {}, 'Falta'), h('dd', { class: 'num' }, brl(p.remaining))),
        h('div', {}, h('dt', {}, 'Data-alvo'), h('dd', {}, g.target_date ? dateBr(g.target_date) : '—')),
        h('div', {}, h('dt', {}, 'Guardar por mês'), h('dd', { class: 'num' }, p.monthly ? brl(p.monthly) : '—'))),
      edit && !g.archived ? h('div', { class: 'goal-actions' },
        h('button', { type: 'button', class: 'btn small', onclick: () => depositDialog(g, 'in') }, icon('plus', 16), h('span', {}, 'Aportar')),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => depositDialog(g, 'out') }, icon('minus', 16), h('span', {}, 'Retirar')),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => historyDialog(g, p) }, 'Histórico')) : null);
  });

  const arch = h('input', { type: 'checkbox', checked: showArchived });
  arch.addEventListener('change', () => {
    showArchived = arch.checked;
    renderGoals();
  });

  page('Metas de economia', {
    subtitle: 'Junte dinheiro com valor e prazo definidos',
    actions: [edit ? h('button', { type: 'button', class: 'btn', onclick: () => goalDialog() }, icon('plus', 18), h('span', {}, 'Nova meta')) : null],
  },
  h('div', { class: 'grid kpis three' },
    h('section', { class: 'card kpi accent' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon('piggy', 20)), h('span', { class: 'kpi-label' }, 'Guardado nas metas')), h('div', { class: 'kpi-value num' }, brl(saved)),
      h('div', { class: 'kpi-sub' }, target ? `${pctText(Math.min(saved / target, 1))} do total de ${brl(target)}` : 'Nenhuma meta')),
    h('section', { class: 'card kpi' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon('target', 20)), h('span', { class: 'kpi-label' }, 'Metas em andamento')), h('div', { class: 'kpi-value num' }, String(active.filter((x) => x.p.status !== 'done').length)),
      h('div', { class: 'kpi-sub' }, `${active.filter((x) => x.p.status === 'done').length} concluída(s)`)),
    h('section', { class: 'card kpi' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon('calendar', 20)), h('span', { class: 'kpi-label' }, 'Para cumprir os prazos')), h('div', { class: 'kpi-value num' }, brl(monthly)),
      h('div', { class: 'kpi-sub' }, 'por mês, somando todas as metas'))),
  cards.length ? h('div', { class: 'grid accounts' }, ...cards)
    : card(null, {}, emptyState('target', 'Nenhuma meta ainda', 'Crie uma meta (ex.: Reserva de emergência, Viagem) e registre os aportes.',
      edit ? h('button', { type: 'button', class: 'btn', onclick: () => goalDialog() }, icon('plus', 18), h('span', {}, 'Criar meta')) : null)),
  (d.savingsGoals ?? []).some((g) => g.archived) ? h('label', { class: 'check' }, arch, ' Mostrar metas arquivadas') : null,
  h('p', { class: 'hint' }, 'Os aportes são o controle do quanto você separou para a meta; eles não mexem no saldo das contas. Se o dinheiro sair de uma conta, lance também uma saída nela (ou guarde numa conta Poupança).'));
}
