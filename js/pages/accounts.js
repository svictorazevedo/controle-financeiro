// Contas: bancárias, carteira, poupança, cartão, investimento — saldo calculado automaticamente.
import { sb, q } from '../api.js';
import { state, page, card, canEdit, field, input, select, moneyInput, colorPicker, houseRow, run, reload, emptyState } from '../ctx.js';
import { accountBalances, localToday, dateFor, movements, sumBy } from '../finance.js';
import { h, toast, brl, openDialog, confirmDialog, parseMoney, centsToInput, menuButton, monthLabel } from '../ui.js';
import { icon, ACCOUNT_ICONS } from '../icons.js';
import { openImportDialog } from './import.js';

export const ACCOUNT_KINDS = [
  { value: 'checking', label: 'Conta corrente' }, { value: 'savings', label: 'Poupança' }, { value: 'wallet', label: 'Carteira (dinheiro)' },
  { value: 'credit', label: 'Cartão de crédito' }, { value: 'investment', label: 'Investimento' }, { value: 'other', label: 'Outra' },
];
const kindLabel = (k) => ACCOUNT_KINDS.find((x) => x.value === k)?.label ?? 'Conta';

function accountDialog(acc = null) {
  const f = {
    name: input('name', { required: true, maxlength: 60, value: acc?.name ?? '', placeholder: 'Ex.: Nubank, Itaú, Carteira' }),
    kind: select('kind', ACCOUNT_KINDS, acc?.kind ?? 'checking'),
    opening: moneyInput('opening', { value: acc ? centsToInput(Number(acc.opening_cents)) : '0,00' }),
    color: colorPicker('color', acc?.color),
    archived: h('input', { type: 'checkbox', name: 'archived', checked: !!acc?.archived }),
  };
  const save = h('button', { type: 'submit', class: 'btn' }, icon('check', 18), h('span', {}, 'Salvar'));
  const form = h('form', { class: 'form-grid' },
    field('Nome da conta', f.name, { cls: 'span-2' }), field('Tipo', f.kind),
    field('Saldo inicial', f.opening, { hint: 'Saldo antes do primeiro lançamento no sistema. Use “-” para saldo negativo.' }),
    h('div', { class: 'field span-2' }, h('span', { class: 'lbl' }, 'Cor'), f.color),
    acc ? h('label', { class: 'check span-2' }, f.archived, ' Arquivar (some dos formulários, mas continua no histórico)') : null,
    h('div', { class: 'dialog-actions span-2' }, save));
  const d = openDialog({ title: acc ? 'Editar conta' : 'Nova conta', body: form });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const opening = parseMoney(f.opening.querySelector('input').value, { allowNegative: true, allowZero: true });
    if (opening === null) return toast('Saldo inicial inválido. Ex.: 1.500,00 ou -200,00', true);
    const row = { name: f.name.value.trim(), kind: f.kind.value, opening_cents: opening, color: f.color.value(), archived: f.archived.checked };
    const ok = await run(save, () => q(acc ? sb.from('accounts').update(row).eq('id', acc.id).select('id').single() : sb.from('accounts').insert(houseRow(row))), 'Conta salva.');
    if (ok) {
      d.close();
      await reload();
    }
  });
}

export async function renderAccounts() {
  const d = state.d;
  const today = localToday();
  const now = accountBalances(d, today);
  const end = accountBalances(d, dateFor(state.month, 31));
  const edit = canEdit('contas');
  const monthFlows = (id) => sumBy(movements(d, `${state.month}-01`, dateFor(state.month, 31)).filter((m) => (m.accountId ?? null) === id));

  const cards = now.accounts.map((r) => {
    const a = r.account;
    const proj = end.accounts.find((x) => x.id === r.id)?.balance ?? r.balance;
    const fl = monthFlows(r.id);
    return h('section', { class: `card account-card${a?.archived ? ' archived' : ''}`, style: { '--c': a?.color || 'var(--muted-mark)' } },
      h('header', { class: 'acc-head' },
        h('span', { class: 'acc-ico lg' }, icon(ACCOUNT_ICONS[a?.kind] ?? 'coins', 22)),
        h('div', { class: 'acc-title' }, h('strong', {}, a?.name ?? 'Sem conta'), h('small', {}, a ? kindLabel(a.kind) : 'Movimentos sem conta definida'),
          a?.archived ? h('span', { class: 'tag' }, 'arquivada') : null),
        a && edit ? menuButton([
          { label: 'Editar', icon: 'pencil', onclick: () => accountDialog(a) },
          !a.archived && canEdit('lancamentos') ? { label: a.kind === 'credit' ? 'Importar fatura' : 'Importar extrato', icon: 'upload', onclick: () => openImportDialog({ accountId: a.id }) } : null,
          {
            label: 'Excluir', icon: 'trash', danger: true,
            onclick: async () => {
              if (!await confirmDialog(`Excluir a conta "${a.name}"?`, { title: 'Excluir conta', confirmText: 'Excluir', danger: true, detail: 'Só é possível excluir contas sem lançamentos. Se ela já tem histórico, prefira arquivar.' })) return;
              if (await run(null, () => q(sb.from('accounts').delete().eq('id', a.id)), 'Conta excluída.')) await reload();
            },
          },
        ]) : null),
      h('div', { class: 'acc-balance' }, h('span', {}, 'Saldo atual'), h('strong', { class: `num ${r.balance < 0 ? 'neg' : ''}` }, brl(r.balance))),
      h('dl', { class: 'acc-stats' },
        h('div', {}, h('dt', {}, `Entradas em ${monthLabel(state.month, true)}`), h('dd', { class: 'num pos' }, brl(fl.income))),
        h('div', {}, h('dt', {}, `Saídas em ${monthLabel(state.month, true)}`), h('dd', { class: 'num neg' }, brl(fl.expense))),
        h('div', {}, h('dt', {}, 'Previsto no fim do mês'), h('dd', { class: 'num' }, brl(proj)))),
      a ? h('a', { class: 'link', href: `#/relatorios?r=extrato&conta=${a.id}` }, icon('report', 16), 'Ver extrato') : null);
  });

  page('Contas', {
    subtitle: 'Saldos calculados a partir do saldo inicial e de todos os lançamentos',
    actions: [edit ? h('button', { type: 'button', class: 'btn', onclick: () => accountDialog() }, icon('plus', 18), h('span', {}, 'Nova conta')) : null],
  },
  h('div', { class: 'grid kpis three' },
    h('section', { class: 'card kpi accent' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon('bank', 20)), h('span', { class: 'kpi-label' }, 'Saldo consolidado')),
      h('div', { class: 'kpi-value num' }, brl(now.total)), h('div', { class: 'kpi-sub' }, `${d.accounts.filter((a) => !a.archived).length} conta(s) ativa(s)`)),
    h('section', { class: 'card kpi' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon('clock', 20)), h('span', { class: 'kpi-label' }, `Previsto em ${dateFor(state.month, 31).split('-').reverse().join('/')}`)),
      h('div', { class: 'kpi-value num' }, brl(end.total)), h('div', { class: 'kpi-sub' }, 'Inclui automáticos e lançamentos futuros')),
    h('section', { class: 'card kpi' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon('card', 20)), h('span', { class: 'kpi-label' }, 'Contas com saldo negativo')),
      h('div', { class: 'kpi-value num' }, String(now.accounts.filter((r) => r.balance < 0).length)), h('div', { class: 'kpi-sub' }, 'Cartões de crédito ficam negativos com as compras'))),
  cards.length ? h('div', { class: 'grid accounts' }, ...cards) : card(null, {}, emptyState('bank', 'Nenhuma conta', 'Cadastre suas contas bancárias, carteira e cartões.')));
}
