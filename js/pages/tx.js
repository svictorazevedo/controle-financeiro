// Diálogo de lançamento (entrada/saída) + comprovante. Usado no botão "Novo lançamento", na lista,
// no calendário e no painel.
import { sb, q } from '../api.js';
import { state, field, input, select, moneyInput, categorySelect, accountOptions, residentsOptions, myResidentId, houseRow, run, reload, isAdmin, canEdit } from '../ctx.js';
import { h, openDialog, segmented, parseMoney, centsToInput, toast, confirmDialog, dateBr, brl } from '../ui.js';
import { icon } from '../icons.js';
import { localToday } from '../finance.js';

const MAX_FILE = 5 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

export const canChangeTx = (t) => canEdit('lancamentos')
  && (isAdmin() || t.created_by === state.user.id || t.createdBy === state.user.id || ((t.resident_id ?? t.residentId) && (t.resident_id ?? t.residentId) === myResidentId()));

/**
 * @param tx linha da tabela transactions (para editar) ou null
 * @param defaults { type, date }
 */
export function openTxDialog(src = null, defaults = {}) {
  // defaults.copy: usa src como modelo de um lançamento NOVO (duplicar)
  const tx = src && !defaults.copy ? src : null;
  const base = src ?? null;
  let type = base?.type ?? defaults.type ?? 'expense';
  const today = localToday();
  const f = {
    amount: moneyInput('amount', { required: true, value: base ? centsToInput(Number(base.amount_cents)) : '' }),
    description: input('description', { required: true, maxlength: 120, placeholder: type === 'income' ? 'Ex.: Salário de novembro' : 'Ex.: Supermercado', value: base?.description ?? '' }),
    date: input('date', { type: 'date', required: true, value: tx?.date ?? defaults.date ?? (today.startsWith(state.month) ? today : `${state.month}-01`) }),
    account: select('account', accountOptions(true), base ? base.account_id ?? '' : (defaults.accountId ?? state.d.accounts.find((a) => !a.archived)?.id ?? '')),
    resident: select('resident', residentsOptions(true), base ? base.resident_id ?? '' : myResidentId()),
    file: input('file', { type: 'file', accept: 'image/jpeg,image/png,image/webp,application/pdf', class: 'file-input' }),
  };
  const catWrap = h('div', { class: 'field-slot' });
  let cat;
  const paintCat = (val = '') => {
    cat = categorySelect('category', type, val);
    catWrap.replaceChildren(field('Categoria', cat));
  };
  paintCat(base?.category_id ?? '');

  const kind = segmented('kind', [
    { value: 'expense', label: 'Saída', icon: 'arrow_out', cls: 'seg-expense' },
    { value: 'income', label: 'Entrada', icon: 'arrow_in', cls: 'seg-income' },
  ], type, (v) => {
    type = v;
    paintCat('');
    f.description.placeholder = type === 'income' ? 'Ex.: Salário de novembro' : 'Ex.: Supermercado';
  });

  let removeAttachment = false;
  const attachInfo = h('div', { class: 'attach-current' });
  if (tx?.attachment_path) {
    attachInfo.append(icon('clip', 16), h('span', {}, 'Comprovante anexado'),
      h('button', { type: 'button', class: 'link', onclick: () => viewAttachment(tx.attachment_path) }, 'ver'),
      h('button', {
        type: 'button', class: 'link danger',
        onclick: () => {
          removeAttachment = true;
          attachInfo.replaceChildren(h('span', { class: 'hint' }, 'O comprovante será removido ao salvar.'));
        },
      }, 'remover'));
  }
  const fileLabel = h('label', { class: 'dropzone', for: f.file.id ||= `f-${Math.random().toString(36).slice(2, 9)}` },
    icon('upload', 20), h('span', { class: 'dz-text' }, tx?.attachment_path ? 'Trocar comprovante' : 'Anexar comprovante (foto ou PDF, até 5 MB)'));
  f.file.addEventListener('change', () => {
    const file = f.file.files[0];
    fileLabel.querySelector('.dz-text').textContent = file ? `${file.name} (${Math.ceil(file.size / 1024)} KB)` : 'Anexar comprovante';
  });

  const save = h('button', { class: 'btn', type: 'submit' }, icon('check', 18), h('span', {}, tx ? 'Salvar alteração' : 'Salvar'));
  const again = tx ? null : h('button', { class: 'btn ghost', type: 'submit', value: 'again' }, 'Salvar e lançar outro');
  const form = h('form', { class: 'form-grid', novalidate: false },
    h('div', { class: 'span-2' }, kind),
    field('Valor', f.amount, { cls: 'big-money' }), field('Data', f.date),
    field('Descrição', f.description, { cls: 'span-2' }),
    catWrap, field('Conta', f.account),
    field('De quem', f.resident, { cls: 'span-2' }),
    h('div', { class: 'span-2 attach' }, attachInfo, fileLabel, f.file),
    h('div', { class: 'dialog-actions span-2' }, again, save));

  const d = openDialog({ title: tx ? 'Editar lançamento' : 'Novo lançamento', body: form });
  f.amount.querySelector('input').focus();

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const keepOpen = ev.submitter?.value === 'again';
    const amount = parseMoney(f.amount.querySelector('input').value);
    if (!amount) return toast('Informe um valor válido, ex.: 125,90', true);
    const file = f.file.files[0];
    if (file && !TYPES[file.type]) return toast('O comprovante precisa ser JPG, PNG, WEBP ou PDF.', true);
    if (file && file.size > MAX_FILE) return toast('O comprovante passa de 5 MB.', true);
    const row = {
      type, description: f.description.value.trim(), amount_cents: amount, date: f.date.value,
      category_id: cat.value || null, account_id: f.account.value || null, resident_id: f.resident.value || null,
    };
    const ok = await run(ev.submitter, async () => {
      let uploaded = null;
      if (file) {
        uploaded = `${state.houseId}/${crypto.randomUUID()}.${TYPES[file.type]}`;
        await q(sb.storage.from('receipts').upload(uploaded, file, { contentType: file.type, upsert: false }));
        row.attachment_path = uploaded;
      } else if (removeAttachment) row.attachment_path = null;
      try {
        if (tx) await q(sb.from('transactions').update(row).eq('id', tx.id).select('id').single());
        else await q(sb.from('transactions').insert(houseRow(row)));
      } catch (e) {
        if (uploaded) await sb.storage.from('receipts').remove([uploaded]);
        throw e;
      }
      if (tx?.attachment_path && (uploaded || removeAttachment)) await sb.storage.from('receipts').remove([tx.attachment_path]);
    }, tx ? 'Lançamento atualizado.' : `${type === 'income' ? 'Entrada' : 'Saída'} de ${brl(amount)} lançada.`);
    if (!ok) return;
    defaults.onSaved?.();
    if (keepOpen) {
      f.amount.querySelector('input').value = '';
      f.description.value = '';
      f.file.value = '';
      fileLabel.querySelector('.dz-text').textContent = 'Anexar comprovante (foto ou PDF, até 5 MB)';
      f.amount.querySelector('input').focus();
      reload();
    } else {
      d.close();
      await reload();
    }
  });
}

export async function deleteTx(tx) {
  const ok = await confirmDialog(`Excluir "${tx.description}" de ${dateBr(tx.date)} (${brl(Number(tx.amount_cents))})?`, {
    title: 'Excluir lançamento', confirmText: 'Excluir', danger: true, detail: tx.attachment_path ? 'O comprovante também será apagado.' : null,
  });
  if (!ok) return;
  const done = await run(null, async () => {
    await q(sb.from('transactions').delete().eq('id', tx.id));
    if (tx.attachment_path) await sb.storage.from('receipts').remove([tx.attachment_path]);
  }, 'Lançamento excluído.');
  if (done) await reload();
}

/** Mostra o comprovante (link temporário de 2 minutos). */
export async function viewAttachment(path) {
  const data = await run(null, () => q(sb.storage.from('receipts').createSignedUrl(path, 120)));
  if (!data?.signedUrl) return;
  const url = data.signedUrl;
  const isPdf = path.endsWith('.pdf');
  openDialog({
    title: 'Comprovante', wide: !isPdf,
    body: h('div', { class: 'stack center' },
      isPdf ? h('div', { class: 'empty' }, h('div', { class: 'empty-ico' }, icon('report', 28)), h('strong', {}, 'Comprovante em PDF'))
        : h('img', { src: url, alt: 'Comprovante', class: 'receipt-img' }),
      h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer' }, icon('eye', 18), h('span', {}, 'Abrir em nova aba'))),
  });
}
