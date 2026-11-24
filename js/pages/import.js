// Importar extrato (OFX/CSV): o banco já tem a lista do que entrou e saiu — o sistema lê o arquivo,
// sugere a categoria pelo seu histórico, separa o que já está lançado e só pede para conferir o resto.
// O arquivo é lido aqui no navegador; nada é enviado para IA nem guardado além dos lançamentos salvos.
import { sb, q } from '../api.js';
import { state, field, select, accountOptions, residentsOptions, myResidentId, categorySelect, houseRow, run, reload, accountName } from '../ctx.js';
import { movements, addDays, accountBalances } from '../finance.js';
import { decodeBytes, parseStatement, reconcile, buildSuggester, tidyDescription, looksLikeTransfer } from '../statement.js';
import { h, openDialog, brl, dateBr, dateShort, toast, segmented } from '../ui.js';
import { icon } from '../icons.js';

const MAX_FILE = 5 * 1024 * 1024;
const remembered = (st) => {
  try {
    return st.acctId ? localStorage.getItem(`stmtAcct:${st.bankId}:${st.acctId}`) : null;
  } catch {
    return null;
  }
};
const remember = (st, accountId) => {
  try {
    if (st.acctId) localStorage.setItem(`stmtAcct:${st.bankId}:${st.acctId}`, accountId);
  } catch { /* ignore */ }
};

export function openImportDialog({ accountId = null } = {}) {
  const d = state.d;
  const body = h('div', { class: 'import' });
  const dlg = openDialog({ title: 'Importar extrato', body, wide: true, cls: 'import-dialog' });
  let bytes = null;
  let fileName = '';
  let parsed = null;
  let rows = [];
  let invert = false;
  let view = 'new';

  // ------------------------------------------------------------ etapa 1: conta + arquivo
  const acc = select('account', accountOptions(false), accountId ?? d.accounts.find((a) => !a.archived)?.id ?? '');
  const who = select('resident', residentsOptions(true), myResidentId());
  const file = h('input', { type: 'file', accept: '.ofx,.qfx,.csv,.txt,application/x-ofx,text/csv', class: 'file-input', id: 'imp-file' });
  const drop = h('label', { class: 'dropzone', for: 'imp-file' }, icon('upload', 22),
    h('span', { class: 'dz-text' }, 'Escolher o arquivo do extrato ou da fatura (OFX ou CSV)'));
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > MAX_FILE) return toast('O arquivo passa de 5 MB. Exporte um período menor.', true);
    bytes = new Uint8Array(await f.arrayBuffer());
    fileName = f.name;
    invert = false;
    analyze(true);
  });

  function paintStart() {
    if (!d.accounts.some((a) => !a.archived)) {
      body.replaceChildren(h('p', {}, 'Cadastre primeiro a conta ou o cartão em ', h('a', { href: '#/contas', onclick: () => dlg.close() }, 'Contas'), '.'));
      return;
    }
    body.replaceChildren(
      h('div', { class: 'form-grid' }, field('Conta ou cartão do extrato', acc), field('De quem são os lançamentos', who)),
      file, drop,
      h('div', { class: 'import-help' },
        h('p', {}, h('strong', {}, 'Como baixar: '), 'no app ou site do banco, procure “Extrato” → “Exportar” / “Salvar como” e escolha ',
          h('strong', {}, 'OFX'), ' (também chamado de “Money”, “Quicken” ou “arquivo para gerenciador financeiro”). Para o cartão, faça o mesmo na fatura. ',
          'Se o banco só oferecer CSV/planilha, também serve.'),
        h('p', { class: 'hint' }, icon('lock', 14), ' O arquivo é lido aqui no seu navegador. Ele não é enviado a ninguém e não passa por IA.')));
  }

  // ------------------------------------------------------------ etapa 2: ler, sugerir, conferir
  function analyze(first = false) {
    try {
      parsed = parseStatement(decodeBytes(bytes), { invert });
    } catch (e) {
      toast(e.message, true);
      return;
    }
    if (!parsed.items.length) {
      toast('Não encontrei lançamentos neste arquivo (o período exportado pode estar vazio).', true);
      return;
    }
    if (first) {
      const known = remembered(parsed);
      if (known && d.accounts.some((a) => a.id === known && !a.archived)) acc.value = known;
      // Fatura em CSV costuma vir com a compra positiva: no cartão, se quase tudo é positivo, inverte.
      const account = d.accounts.find((a) => a.id === acc.value);
      if (parsed.format === 'csv' && account?.kind === 'credit') {
        const pos = parsed.items.filter((x) => x.amount > 0).length;
        if (pos > parsed.items.length * 0.6) {
          invert = true;
          parsed = parseStatement(decodeBytes(bytes), { invert });
        }
      }
    }
    const accountId = acc.value || null;
    const dates = parsed.items.map((x) => x.date).sort();
    const from = addDays(dates[0], -6);
    const to = addDays(dates[dates.length - 1], 6);
    const existing = movements(d, from, to);
    const matches = reconcile(parsed.items, existing, accountId);
    const suggest = buildSuggester(d.transactions, d.categories);
    rows = parsed.items.map((it, i) => {
      const type = it.amount > 0 ? 'income' : 'expense';
      const sug = suggest(it.description, type);
      const transfer = looksLikeTransfer(it.description);
      const match = matches[i];
      return {
        i, date: it.date, type, amount: Math.abs(it.amount), raw: it.description, match, transfer,
        description: sug.description ?? tidyDescription(it.description), categoryId: sug.categoryId, how: sug.how,
        checked: !match && !transfer,
      };
    }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    view = rows.some((r) => r.checked) ? 'new' : 'all';
    paintReview();
  }

  function balanceCheck() {
    if (parsed.format !== 'ofx' || parsed.balance === null || !parsed.balanceDate) return null;
    const account = d.accounts.find((a) => a.id === acc.value);
    if (!account || account.kind === 'credit') return null;     // fatura: o "saldo" do OFX é o valor da fatura
    const extra = rows.filter((r) => r.checked).map((r, k) => ({
      id: `imp-${k}`, type: r.type, amount_cents: r.amount, date: r.date, account_id: account.id, description: r.description,
    }));
    const bal = accountBalances({ ...d, transactions: [...d.transactions, ...extra] }, parsed.balanceDate).accounts.find((x) => x.id === account.id)?.balance ?? 0;
    const diff = parsed.balance - bal;
    return h('div', { class: `import-balance ${diff === 0 ? 'ok' : 'warn'}` },
      icon(diff === 0 ? 'check' : 'alert', 18),
      h('div', {},
        h('strong', {}, diff === 0 ? 'Saldo conferido: bate com o banco.' : `Diferença de ${brl(Math.abs(diff))} com o banco`),
        h('small', {}, `Em ${dateBr(parsed.balanceDate)}: banco ${brl(parsed.balance)} · sistema depois de importar ${brl(bal)}.`,
          diff === 0 ? '' : diff > 0 ? ' Falta lançar entrada (ou sobra saída) — confira o saldo inicial da conta e os itens desmarcados.'
            : ' Há saída a menos (ou entrada a mais) no sistema — confira itens desmarcados, lançamentos fora da conta ou o saldo inicial.')));
  }

  function paintReview() {
    const accountId = acc.value || null;
    const nNew = rows.filter((r) => !r.match && !r.transfer).length;
    const nMatch = rows.filter((r) => r.match).length;
    const nTransfer = rows.filter((r) => r.transfer && !r.match).length;
    const chosen = rows.filter((r) => r.checked);
    const tot = chosen.reduce((s, r) => s + (r.type === 'income' ? r.amount : -r.amount), 0);
    const save = h('button', { type: 'button', class: 'btn', disabled: !chosen.length },
      icon('check', 18), h('span', {}, chosen.length ? `Importar ${chosen.length} lançamento${chosen.length > 1 ? 's' : ''}` : 'Nada marcado'));
    const balanceSlot = h('div', {}, balanceCheck());

    const refreshFooter = () => {
      const c = rows.filter((r) => r.checked);
      save.disabled = !c.length;
      save.querySelector('span').textContent = c.length ? `Importar ${c.length} lançamento${c.length > 1 ? 's' : ''}` : 'Nada marcado';
      balanceSlot.replaceChildren(...[balanceCheck()].filter(Boolean));
    };

    const shown = view === 'new' ? rows.filter((r) => !r.match && !r.transfer) : rows;
    const list = h('ul', { class: 'import-items' }, ...shown.map((r) => {
      const isIn = r.type === 'income';
      const chk = h('input', { type: 'checkbox', checked: r.checked, 'aria-label': `Importar ${r.raw}` });
      const desc = h('input', { value: r.description, maxlength: 120, 'aria-label': 'Descrição' });
      const cat = categorySelect(`cat-${r.i}`, r.type, r.categoryId ?? '');
      cat.setAttribute('aria-label', 'Categoria');
      const li = h('li', { class: `import-item${r.checked ? '' : ' off'}` },
        h('label', { class: 'ii-check' }, chk),
        h('div', { class: 'ii-main' },
          h('div', { class: 'ii-top' },
            h('span', { class: 'ii-date num' }, dateShort(r.date)),
            desc,
            h('strong', { class: `num ${isIn ? 'pos' : 'neg'}` }, `${isIn ? '+' : '−'} ${brl(r.amount)}`)),
          h('div', { class: 'ii-meta' }, cat,
            r.match ? h('span', { class: 'tag ok' }, icon('check', 12), ` Já lançado: ${r.match.description} (${dateShort(r.match.date)}${r.match.source === 'auto' ? ', automático' : ''})`) : null,
            !r.match && r.transfer ? h('span', { class: 'tag warn', title: 'Pagamento de fatura ou transferência entre suas contas aparece nos dois extratos. Importe só se quiser contar como gasto/entrada.' }, icon('alert', 12), ' Parece transferência / pagamento de fatura') : null,
            !r.match && !r.transfer && r.how === 'history' ? h('span', { class: 'tag' }, icon('sparkles', 12), ' categoria pelo seu histórico') : null,
            r.description !== r.raw ? h('small', { class: 'ii-raw', title: 'Texto original do banco' }, r.raw) : null)));
      chk.addEventListener('change', () => {
        r.checked = chk.checked;
        li.classList.toggle('off', !r.checked);
        refreshFooter();
      });
      desc.addEventListener('input', () => {
        r.description = desc.value;
      });
      cat.addEventListener('change', () => {
        r.categoryId = cat.value || null;
        // Mesma descrição do banco no resto do arquivo: aplica a mesma categoria às que ainda não têm.
        for (const o of rows) {
          if (o !== r && o.type === r.type && o.raw === r.raw && !o.userCat) {
            o.categoryId = r.categoryId;
            const sel = list.querySelector(`select[name="cat-${o.i}"]`);
            if (sel) sel.value = o.categoryId ?? '';
          }
        }
        r.userCat = true;
      });
      return li;
    }));

    const filterSeg = segmented('imp-view', [
      { value: 'new', label: `Novos (${nNew})` }, { value: 'all', label: `Todos (${rows.length})` },
    ], view, (v) => {
      view = v;
      paintReview();
    });
    const invertChk = parsed.format === 'csv' ? h('label', { class: 'check' }, h('input', {
      type: 'checkbox', checked: invert,
      onchange: (e) => {
        invert = e.target.checked;
        analyze();
      },
    }), ' Inverter entradas e saídas (fatura em CSV costuma vir com a compra positiva)') : null;
    acc.onchange = () => analyze();

    const back = h('button', { type: 'button', class: 'btn ghost', onclick: () => { file.value = ''; paintStart(); } }, icon('left', 18), h('span', {}, 'Outro arquivo'));
    save.addEventListener('click', async () => {
      const resident = who.value || null;
      const chosenNow = rows.filter((r) => r.checked);
      const out = chosenNow.map((r) => houseRow({
        type: r.type, description: (r.description.trim() || tidyDescription(r.raw)).slice(0, 120), amount_cents: r.amount, date: r.date,
        category_id: r.categoryId || null, account_id: accountId, resident_id: resident,
      }));
      const ok = await run(save, async () => {
        for (let k = 0; k < out.length; k += 200) await q(sb.from('transactions').insert(out.slice(k, k + 200)));
      }, `${out.length} lançamento${out.length > 1 ? 's' : ''} importado${out.length > 1 ? 's' : ''} em ${accountName(accountId)}.`);
      if (ok) {
        remember(parsed, accountId);
        dlg.close();
        await reload();
      }
    });

    const currencyWarn = parsed.currency && d.house.currency && parsed.currency !== d.house.currency
      ? h('p', { class: 'hint warn-text' }, icon('alert', 14), ` O extrato está em ${parsed.currency} e a casa usa ${d.house.currency}. Os valores serão importados como estão.`) : null;

    body.replaceChildren(...[
      h('div', { class: 'import-head' },
        h('div', {}, h('strong', {}, fileName), h('small', {}, `${parsed.format.toUpperCase()}${parsed.card ? ' · fatura de cartão' : ''} · ${rows.length} movimentos · ${dateBr(rows[rows.length - 1].date)} a ${dateBr(rows[0].date)}`)),
        field('Conta', acc)),
      h('div', { class: 'summary-strip compact' },
        h('div', {}, h('span', {}, 'Novos'), h('strong', { class: 'num' }, String(nNew))),
        h('div', {}, h('span', {}, 'Já lançados'), h('strong', { class: 'num' }, String(nMatch))),
        h('div', {}, h('span', {}, 'Transferências'), h('strong', { class: 'num' }, String(nTransfer))),
        h('div', {}, h('span', {}, 'Resultado dos marcados'), h('strong', { class: `num ${tot < 0 ? 'neg' : 'pos'}` }, `${tot < 0 ? '−' : '+'} ${brl(Math.abs(tot))}`))),
      currencyWarn,
      h('div', { class: 'import-tools' }, filterSeg, invertChk),
      shown.length ? list : h('p', { class: 'hint' }, 'Tudo deste arquivo já está lançado. Veja em “Todos”.'),
      balanceSlot,
      h('p', { class: 'hint' }, 'Marque o que quer importar. Os “já lançados” foram achados pelo mesmo valor na mesma conta em até 4 dias de diferença. ',
        'Ao trocar a categoria de um item, os outros com o mesmo texto do banco recebem a mesma.'),
      h('div', { class: 'dialog-actions' }, back, save)].filter(Boolean));
  }

  paintStart();
}
