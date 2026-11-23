// Fixos e recorrentes: rendas fixas, descontos automáticos (dízimo, aluguel, parcelas) e distribuição da renda em %.
import { sb, q } from '../api.js';
import { state, page, card, canEdit, isAdmin, myResidentId, field, input, select, moneyInput, categorySelect, accountOptions, residentsOptions,
  houseRow, run, reload, residentName, accountName, categoryChip, emptyState, routeParams } from '../ctx.js';
import { monthSummary, monthIndex } from '../finance.js';
import { h, brl, openDialog, confirmDialog, parseMoney, centsToInput, parsePercent, bpToText, monthLabel, menuButton, toast } from '../ui.js';
import { icon } from '../icons.js';
import { progress } from '../charts.js';

const dayInput = (v) => input('day', { type: 'number', min: 1, max: 31, placeholder: '1', value: v ?? '' });

function incomeDialog(i = null) {
  const f = {
    resident: select('resident', residentsOptions(false), i?.resident_id ?? myResidentId()),
    description: input('description', { required: true, maxlength: 120, placeholder: 'Ex.: Salário', value: i?.description ?? '' }),
    amount: moneyInput('amount', { required: true, value: i ? centsToInput(Number(i.amount_cents)) : '' }),
    kind: select('kind', [{ value: 'recurring', label: 'Todo mês' }, { value: 'once', label: 'Só uma vez' }], i?.kind ?? 'recurring'),
    start: input('start', { type: 'month', required: true, value: i?.start_month ?? state.month }),
    end: input('end', { type: 'month', value: i?.end_month ?? '' }),
    day: dayInput(i?.day),
    account: select('account', accountOptions(true), i ? i.account_id ?? '' : state.d.accounts.find((a) => !a.archived)?.id ?? ''),
    category: categorySelect('category', 'income', i?.category_id ?? state.d.categories.find((c) => c.type === 'income' && c.name === 'Salário')?.id ?? ''),
  };
  const endField = field('Até (opcional)', f.end);
  const sync = () => {
    endField.hidden = f.kind.value !== 'recurring';
  };
  f.kind.addEventListener('change', sync);
  sync();
  const save = h('button', { type: 'submit', class: 'btn' }, icon('check', 18), h('span', {}, 'Salvar'));
  const form = h('form', { class: 'form-grid' },
    field('Morador', f.resident), field('Descrição', f.description), field('Valor', f.amount), field('Frequência', f.kind),
    field('A partir de', f.start), endField, field('Dia do crédito', f.day, { hint: 'Dia do mês em que o valor entra (padrão: 1).' }),
    field('Conta', f.account), field('Categoria', f.category, { cls: 'span-2' }),
    h('p', { class: 'hint span-2' }, 'Renda fixa entra sozinha na conta todo mês, no dia informado. Não lance de novo em Lançamentos.'),
    h('div', { class: 'dialog-actions span-2' }, save));
  const d = openDialog({ title: i ? 'Editar renda fixa' : 'Nova renda fixa', body: form });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const amount = parseMoney(f.amount.querySelector('input').value);
    if (!amount) return toast('Informe um valor válido.', true);
    const row = {
      resident_id: f.resident.value, description: f.description.value.trim(), amount_cents: amount, kind: f.kind.value,
      start_month: f.start.value, end_month: f.kind.value === 'recurring' ? f.end.value || null : null,
      day: f.day.value ? Number(f.day.value) : null, account_id: f.account.value || null, category_id: f.category.value || null,
    };
    const ok = await run(save, () => q(i ? sb.from('incomes').update(row).eq('id', i.id).select('id').single() : sb.from('incomes').insert(houseRow(row))), 'Renda salva.');
    if (ok) {
      d.close();
      await reload();
    }
  });
}

function recurringDialog(r = null, preset = null) {
  const src = r ?? preset ?? {};
  const f = {
    description: input('description', { required: true, maxlength: 120, placeholder: 'Ex.: Aluguel', value: src.description ?? '' }),
    resident: select('resident', residentsOptions(isAdmin()), r ? r.resident_id ?? '' : (src.mine || !isAdmin() ? myResidentId() : '')),
    category: categorySelect('category', 'expense', src.category_id ?? state.d.categories.find((c) => c.type !== 'income' && c.name === src.catName)?.id ?? ''),
    account: select('account', accountOptions(true), r ? r.account_id ?? '' : state.d.accounts.find((a) => !a.archived)?.id ?? ''),
    mode: select('mode', [{ value: 'fixed', label: 'Valor fixo' }, { value: 'percent', label: 'Percentual da renda (%)' }], src.mode ?? 'fixed'),
    amount: moneyInput('amount', { value: src.amount_cents ? centsToInput(Number(src.amount_cents)) : '' }),
    percent: input('percent', { inputmode: 'decimal', placeholder: '10', value: src.percent_bp ? String(src.percent_bp / 100).replace('.', ',') : src.percent ?? '' }),
    start: input('start', { type: 'month', required: true, value: src.start_month ?? state.month }),
    installments: input('installments', { type: 'number', min: 1, max: 600, placeholder: 'sem fim', value: src.installments ?? '' }),
    end: input('end', { type: 'month', value: src.end_month ?? '' }),
    day: dayInput(src.day),
    active: h('input', { type: 'checkbox', checked: r ? !!r.active : true }),
  };
  const amountField = field('Valor', f.amount);
  const percentField = field('Percentual (%)', f.percent);
  const sync = () => {
    amountField.hidden = f.mode.value !== 'fixed';
    percentField.hidden = f.mode.value !== 'percent';
  };
  f.mode.addEventListener('change', sync);
  sync();
  const save = h('button', { type: 'submit', class: 'btn' }, icon('check', 18), h('span', {}, 'Salvar'));
  const form = h('form', { class: 'form-grid' },
    field('Descrição', f.description, { cls: 'span-2' }), field('De quem', f.resident), field('Categoria', f.category),
    field('Tipo', f.mode), amountField, percentField, field('Conta de débito', f.account),
    field('Início', f.start), field('Dia do vencimento', f.day, { hint: 'Padrão: dia 1.' }),
    field('Nº de parcelas', f.installments, { hint: 'Deixe vazio se não tem fim.' }), field('Fim (opcional)', f.end),
    h('label', { class: 'check span-2' }, f.active, ' Ativo (desmarque para pausar)'),
    h('div', { class: 'dialog-actions span-2' }, save));
  const d = openDialog({ title: r ? 'Editar desconto automático' : 'Novo desconto automático', body: form });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const row = {
      description: f.description.value.trim(), resident_id: f.resident.value || null, category_id: f.category.value || null,
      account_id: f.account.value || null, mode: f.mode.value, start_month: f.start.value,
      installments: f.installments.value ? Number(f.installments.value) : null, end_month: f.end.value || null,
      day: f.day.value ? Number(f.day.value) : null, active: f.active.checked, amount_cents: null, percent_bp: null,
    };
    if (row.mode === 'fixed') {
      row.amount_cents = parseMoney(f.amount.querySelector('input').value);
      if (!row.amount_cents) return toast('Informe o valor.', true);
    } else {
      row.percent_bp = parsePercent(f.percent.value);
      if (!row.percent_bp) return toast('Informe o percentual.', true);
    }
    const ok = await run(save, () => q(r ? sb.from('recurring').update(row).eq('id', r.id).select('id').single() : sb.from('recurring').insert(houseRow(row))), 'Desconto salvo.');
    if (ok) {
      d.close();
      await reload();
    }
  });
}

function goalDialog(residentId) {
  const name = input('name', { required: true, maxlength: 80, placeholder: 'Ex.: Reserva de emergência' });
  const percent = input('percent', { required: true, inputmode: 'decimal', placeholder: '10' });
  const res = select('resident', residentsOptions(false), residentId ?? myResidentId());
  const save = h('button', { type: 'submit', class: 'btn' }, 'Salvar');
  const form = h('form', { class: 'form-grid' }, field('Morador', res), field('% da renda', percent), field('Nome', name, { cls: 'span-2' }),
    h('div', { class: 'dialog-actions span-2' }, save));
  const d = openDialog({ title: 'Nova distribuição da renda', body: form });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const bp = parsePercent(percent.value);
    if (!bp) return toast('Informe um percentual entre 0,01 e 100.', true);
    if (await run(save, () => q(sb.from('goals').insert(houseRow({ resident_id: res.value, name: name.value.trim(), percent_bp: bp }))), 'Salvo.')) {
      d.close();
      await reload();
    }
  });
}

const delAction = (label, table, id) => ({
  label: 'Excluir', icon: 'trash', danger: true,
  onclick: async () => {
    if (!await confirmDialog(`Excluir "${label}"?`, { title: 'Excluir', confirmText: 'Excluir', danger: true })) return;
    if (await run(null, () => q(sb.from(table).delete().eq('id', id)), 'Excluído.')) await reload();
  },
});

let tab = 'rendas';

export async function renderRecurring() {
  const p = routeParams().get('aba');
  if (p) tab = p;
  const d = state.d;
  const edit = canEdit('recorrentes');
  const mine = (rid) => isAdmin() || rid === myResidentId();
  const sm = monthSummary(d, state.month);

  const tabs = h('div', { class: 'tabs', role: 'tablist' }, ...[
    ['rendas', 'Rendas fixas', 'arrow_in'], ['descontos', 'Descontos e parcelas', 'repeat'], ['distribuicao', 'Distribuição da renda (%)', 'pie'],
  ].map(([k, label, ic]) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'active' : '',
    onclick: () => {
      tab = k;
      renderRecurring();
    },
  }, icon(ic, 16), label)));

  let body;
  let action = null;
  if (tab === 'rendas') {
    action = edit ? h('button', { type: 'button', class: 'btn', onclick: () => incomeDialog() }, icon('plus', 18), h('span', {}, 'Nova renda fixa')) : null;
    body = d.incomes.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ...['Morador', 'Descrição', 'Categoria', 'Conta', 'Período', 'Dia'].map((x) => h('th', {}, x)), h('th', { class: 'num' }, 'Valor'), h('th', { class: 'act' }))),
      h('tbody', {}, ...d.incomes.map((i) => h('tr', {},
        h('td', {}, residentName(i.resident_id)), h('td', { class: 'cell-title' }, i.description, ' ', h('span', { class: 'tag' }, i.kind === 'recurring' ? 'mensal' : 'uma vez')),
        h('td', {}, categoryChip(i.category_id)), h('td', {}, accountName(i.account_id)),
        h('td', {}, i.kind === 'once' ? monthLabel(i.start_month) : `desde ${monthLabel(i.start_month)}${i.end_month ? ` até ${monthLabel(i.end_month)}` : ''}`),
        h('td', { class: 'num' }, i.day ?? 1),
        h('td', { class: 'num pos' }, brl(Number(i.amount_cents))),
        h('td', { class: 'act' }, edit && mine(i.resident_id) ? menuButton([{ label: 'Editar', icon: 'pencil', onclick: () => incomeDialog(i) }, delAction(i.description, 'incomes', i.id)]) : null))))))
      : emptyState('arrow_in', 'Nenhuma renda fixa', 'Cadastre salários e outras entradas que se repetem.', action);
  } else if (tab === 'descontos') {
    action = edit ? h('button', { type: 'button', class: 'btn', onclick: () => recurringDialog() }, icon('plus', 18), h('span', {}, 'Novo desconto')) : null;
    const status = (r) => {
      if (!r.active) return ['Pausado', 'muted'];
      const idx = monthIndex(state.month) - monthIndex(r.start_month);
      if (idx < 0) return [`Começa em ${monthLabel(r.start_month)}`, 'muted'];
      if (r.end_month && state.month > r.end_month) return ['Encerrado', 'muted'];
      if (r.installments) return idx >= r.installments ? ['Quitado', 'good'] : [`Parcela ${idx + 1}/${r.installments}`, 'info'];
      return ['Ativo', 'good'];
    };
    const presets = edit ? h('div', { class: 'presets' }, h('span', { class: 'hint' }, 'Atalhos:'),
      ...[['Dízimo 10%', { description: 'Dízimo', mode: 'percent', catName: 'Dízimo e ofertas', percent: '10', mine: true }],
        ['Aluguel', { description: 'Aluguel', mode: 'fixed', catName: 'Moradia' }],
        ['Parcelamento', { description: 'Compra parcelada', mode: 'fixed', catName: 'Outros', installments: 10 }],
        ['Conta fixa', { description: 'Internet', mode: 'fixed', catName: 'Contas (água, luz, internet)' }],
        ['Assinatura', { description: 'Streaming', mode: 'fixed', catName: 'Assinaturas' }]]
        .map(([label, pr]) => h('button', { type: 'button', class: 'chip', onclick: () => recurringDialog(null, pr) }, icon('plus', 14), label))) : null;
    body = h('div', {}, presets, d.recurring.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ...['Descrição', 'De', 'Categoria', 'Conta', 'Dia'].map((x) => h('th', {}, x)), h('th', { class: 'num' }, 'Valor'), h('th', {}, `Em ${monthLabel(state.month, true)}`), h('th', { class: 'act' }))),
      h('tbody', {}, ...d.recurring.map((r) => {
        const [st, tone] = status(r);
        return h('tr', {},
          h('td', {}, r.description), h('td', {}, residentName(r.resident_id)), h('td', {}, categoryChip(r.category_id)), h('td', {}, accountName(r.account_id)),
          h('td', { class: 'num' }, r.day ?? 1),
          h('td', { class: 'num neg' }, r.mode === 'fixed' ? brl(Number(r.amount_cents)) : `${bpToText(r.percent_bp)} da renda`),
          h('td', {}, h('span', { class: `status ${tone}` }, st)),
          h('td', { class: 'act' }, edit && (isAdmin() || (r.resident_id && r.resident_id === myResidentId())) ? menuButton([
            { label: 'Editar', icon: 'pencil', onclick: () => recurringDialog(r) },
            {
              label: r.active ? 'Pausar' : 'Reativar', icon: r.active ? 'clock' : 'check',
              onclick: async () => {
                if (await run(null, () => q(sb.from('recurring').update({ active: !r.active }).eq('id', r.id).select('id').single()), r.active ? 'Pausado.' : 'Reativado.')) await reload();
              },
            },
            delAction(r.description, 'recurring', r.id)]) : null));
      }))))
      : emptyState('repeat', 'Nenhum desconto automático', 'Dízimo, aluguel, assinaturas e parcelas entram sozinhos todo mês.', action));
  } else {
    action = edit ? h('button', { type: 'button', class: 'btn', onclick: () => goalDialog() }, icon('plus', 18), h('span', {}, 'Nova distribuição')) : null;
    body = h('div', { class: 'grid cols-3' }, ...sm.residents.map((r) => card(r.name, { sub: `Renda em ${monthLabel(state.month)}: ${brl(r.income)}` },
      progress(r.goalsPercentBp / 10000, r.goalsPercentBp > 10000 ? 'over' : 'ok'),
      h('p', { class: 'hint' }, `Distribuído: ${bpToText(r.goalsPercentBp)} = ${brl(r.goalsTotal)}`),
      r.goals.length ? h('ul', { class: 'plain-list' }, ...r.goals.map((g) => h('li', {},
        h('span', {}, g.name), h('span', { class: 'num muted' }, bpToText(g.percentBp)), h('strong', { class: 'num' }, brl(g.target)),
        edit && mine(r.id) ? menuButton([{
          label: 'Mudar %', icon: 'pencil',
          onclick: () => {
            const pIn = input('p', { inputmode: 'decimal', value: String(g.percentBp / 100).replace('.', ','), required: true });
            const sv = h('button', { type: 'submit', class: 'btn' }, 'Salvar');
            const fm = h('form', { class: 'stack' }, field(`Percentual de "${g.name}"`, pIn), h('div', { class: 'dialog-actions' }, sv));
            const dd = openDialog({ title: 'Alterar percentual', body: fm });
            fm.addEventListener('submit', async (e) => {
              e.preventDefault();
              const bp = parsePercent(pIn.value);
              if (!bp) return toast('Percentual inválido.', true);
              if (await run(sv, () => q(sb.from('goals').update({ percent_bp: bp }).eq('id', g.id).select('id').single()), 'Atualizado.')) {
                dd.close();
                await reload();
              }
            });
          },
        }, delAction(g.name, 'goals', g.id)]) : h('span')))) : h('p', { class: 'muted small' }, 'Nada distribuído.'))));
  }

  const totals = h('div', { class: 'summary-strip' },
    h('div', {}, h('span', {}, `Rendas fixas em ${monthLabel(state.month, true)}`), h('strong', { class: 'num pos' }, brl(sm.incomes.reduce((s, i) => s + i.amount, 0)))),
    h('div', {}, h('span', {}, `Descontos automáticos em ${monthLabel(state.month, true)}`), h('strong', { class: 'num neg' }, brl(sm.totals.automatic))),
    h('div', {}, h('span', {}, 'Comprometido da renda'), h('strong', { class: 'num' }, sm.totals.income ? `${Math.round((sm.totals.automatic / sm.totals.income) * 100)}%` : '—')));

  page('Fixos e recorrentes', {
    subtitle: 'O que entra e sai sozinho todo mês',
    actions: [action],
  }, totals, tabs, card(null, { cls: tab === 'distribuicao' ? 'transparent' : 'flush' }, body),
  tab === 'distribuicao' ? h('p', { class: 'hint' }, 'Ex.: Reserva 10%, Investimentos 15%. O valor em reais é calculado sobre a renda do mês. Para juntar dinheiro com valor e prazo, use Metas.') : null);
}
