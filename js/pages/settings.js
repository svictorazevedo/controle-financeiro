// Configurações (admin): identidade (nome, moeda, logo, ícone), usuários e permissões por tela, exclusão.
import { sb, q } from '../api.js';
import { state, page, card, isAdmin, myResidentId, field, input, select, houseRow, run, reload, loadMe, routeParams } from '../ctx.js';
import { PERM_DEFAULTS, permOf } from '../finance.js';
import { h, openDialog, confirmDialog, menuButton, segmented, CURRENCIES, imageToDataUrl, toast, initials, brl, setCurrency } from '../ui.js';
import { icon } from '../icons.js';

export const MODULES = [
  ['painel', 'Painel', 'dashboard'], ['lancamentos', 'Lançamentos', 'receipt'], ['contas', 'Contas', 'bank'],
  ['recorrentes', 'Fixos e recorrentes', 'repeat'], ['categorias', 'Categorias', 'tag'], ['orcamento', 'Orçamento', 'pie'],
  ['metas', 'Metas', 'target'], ['relatorios', 'Relatórios', 'report'], ['calendario', 'Calendário', 'calendar'], ['ia', 'Assistente IA', 'sparkles'], ['compras', 'Compras', 'cart'],
];
const LEVELS = [{ value: '0', label: 'Sem acesso' }, { value: '1', label: 'Ver' }, { value: '2', label: 'Editar' }];

function permissionsDialog(r) {
  const current = { ...PERM_DEFAULTS, ...(r.permissions ?? {}) };
  const segs = {};
  const rows = MODULES.map(([k, label, ic]) => {
    const onlyView = k === 'relatorios' || k === 'calendario' || k === 'painel' || k === 'ia';
    segs[k] = segmented(`p-${k}`, onlyView ? LEVELS.slice(0, 2) : LEVELS, String(Math.min(current[k], onlyView ? 1 : 2)));
    return h('div', { class: 'perm-row' }, h('span', { class: 'perm-name' }, icon(ic, 16), label), segs[k]);
  });
  const presets = h('div', { class: 'chips' }, h('span', { class: 'hint' }, 'Modelos:'),
    ...[['Padrão', PERM_DEFAULTS], ['Só consulta', Object.fromEntries(MODULES.map(([k]) => [k, 1]))],
      ['Só lança gastos', { painel: 1, lancamentos: 2, contas: 0, recorrentes: 0, categorias: 1, orcamento: 0, metas: 0, relatorios: 0, calendario: 1, ia: 0, compras: 2 }]]
      .map(([label, p]) => h('button', {
        type: 'button', class: 'chip',
        onclick: () => {
          for (const [k] of MODULES) {
            const inp = segs[k].querySelector(`input[value="${p[k]}"]`) ?? segs[k].querySelector('input[value="1"]');
            inp.checked = true;
          }
        },
      }, label)));
  const save = h('button', { type: 'submit', class: 'btn' }, icon('check', 18), h('span', {}, 'Salvar permissões'));
  const form = h('form', { class: 'stack' }, presets, h('div', { class: 'perm-grid' }, ...rows),
    h('p', { class: 'hint' }, icon('shield', 14), ' As permissões valem no banco de dados (RLS), não só nas telas. “Ver” lançamentos também vale para Contas, Calendário, Relatórios e Painel, que dependem desses dados.'),
    h('div', { class: 'dialog-actions' }, save));
  const d = openDialog({ title: `Permissões de ${r.name}`, body: form, wide: true });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const permissions = Object.fromEntries(MODULES.map(([k]) => [k, Number(segs[k].value())]));
    if (await run(save, () => q(sb.from('residents').update({ permissions }).eq('id', r.id).select('id').single()), 'Permissões salvas.')) {
      d.close();
      await reload();
    }
  });
}

function permSummary(r) {
  if (r.role === 'admin') return h('span', { class: 'status good' }, 'Acesso total');
  const p = MODULES.map(([k]) => permOf(r, k));
  const edit = p.filter((x) => x === 2).length;
  const view = p.filter((x) => x === 1).length;
  const none = p.filter((x) => x === 0).length;
  return h('span', { class: 'muted small' }, `${edit} editar · ${view} ver · ${none} sem acesso`);
}

async function imageField(label, key, maxW, maxH, preview) {
  const fileIn = input(key, { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'file-input' });
  const img = h('div', { class: `brand-preview ${key}` }, preview ? h('img', { src: preview, alt: '' }) : icon('image', 24));
  const save = async (val) => {
    if (await run(null, () => q(sb.from('houses').update({ [key]: val }).eq('id', state.houseId).select('id').single()), val ? 'Imagem salva.' : 'Imagem removida.')) await reload();
  };
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    if (!f) return;
    try {
      let url = await imageToDataUrl(f, maxW, maxH, 'image/png');
      if (url.length > (key === 'logo' ? 290000 : 95000)) url = await imageToDataUrl(f, maxW, maxH, 'image/jpeg');
      if (url.length > (key === 'logo' ? 290000 : 95000)) return toast('Imagem grande demais. Use uma menor.', true);
      await save(url);
    } catch (e) {
      toast(e.message, true);
    }
  });
  fileIn.id = `f-${key}`;
  return h('div', { class: 'brand-field' }, img, h('div', {},
    h('strong', {}, label), h('p', { class: 'hint' }, key === 'logo' ? 'Aparece no menu e nos relatórios impressos. Ideal: horizontal, fundo transparente.' : 'Aparece na aba do navegador. Ideal: quadrado.'),
    h('div', { class: 'row-actions' }, h('label', { class: 'btn small ghost', for: fileIn.id }, icon('upload', 16), h('span', {}, 'Enviar imagem')), fileIn,
      preview ? h('button', { type: 'button', class: 'btn small ghost danger-text', onclick: () => save(null) }, 'Remover') : null)));
}

let tab = 'geral';

export async function renderSettings() {
  if (!isAdmin()) {
    location.hash = '#/conta';
    return;
  }
  const t = routeParams().get('aba');
  if (t) tab = t;
  const d = state.d;
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, ...[['geral', 'Identidade', 'home'], ['usuarios', 'Usuários e permissões', 'users'], ['perigo', 'Zona de perigo', 'alert']]
    .map(([k, label, ic]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'active' : '', onclick: () => { tab = k; renderSettings(); } }, icon(ic, 16), label)));

  let body;
  if (tab === 'geral') {
    const name = input('name', { required: true, maxlength: 80, value: d.house.name });
    const cur = select('currency', CURRENCIES.map(([v, l]) => ({ value: v, label: `${v} — ${l}` })), d.house.currency);
    const example = h('span', { class: 'hint' });
    const paintEx = () => {
      setCurrency(cur.value);
      example.textContent = `Exemplo: ${brl(123456)}`;
      setCurrency(d.house.currency);
    };
    cur.addEventListener('change', paintEx);
    paintEx();
    const save = h('button', { type: 'submit', class: 'btn' }, icon('check', 18), h('span', {}, 'Salvar'));
    const form = h('form', { class: 'form-grid' }, field('Nome da casa / empresa', name), h('div', { class: 'field' }, h('label', { for: cur.id = 'f-cur' }, 'Moeda'), cur, example),
      h('div', { class: 'dialog-actions span-2' }, save));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (await run(save, () => q(sb.from('houses').update({ name: name.value.trim(), currency: cur.value }).eq('id', state.houseId).select('id').single()), 'Configuração salva.')) {
        await loadMe();
        await reload();
      }
    });
    body = h('div', { class: 'grid cols-2' },
      card('Dados gerais', {}, form),
      card('Logo e ícone', {}, await imageField('Logo', 'logo', 480, 160, d.house.logo), await imageField('Ícone', 'icon', 128, 128, d.house.icon)));
  } else if (tab === 'usuarios') {
    const pending = new Map(d.invites.map((i) => [i.resident_id, new Date(i.expires_at) > new Date()]));
    const inviteBox = h('div');
    const rows = d.residents.map((r) => h('tr', {},
      h('td', {}, h('div', { class: 'user-cell' }, h('span', { class: 'avatar' }, initials(r.name)), h('div', {}, h('strong', {}, r.name),
        r.id === myResidentId() ? h('span', { class: 'tag' }, 'você') : null))),
      h('td', {}, h('span', { class: `status ${r.role === 'admin' ? 'info' : ''}` }, r.role === 'admin' ? 'Administrador' : 'Colaborador')),
      h('td', {}, r.user_id ? h('span', { class: 'status good' }, icon('check', 13), 'Com login') : pending.get(r.id) ? h('span', { class: 'status warn' }, 'Convite pendente') : h('span', { class: 'muted small' }, 'Sem login')),
      h('td', {}, permSummary(r)),
      h('td', { class: 'act' }, menuButton([
        r.role !== 'admin' ? { label: 'Permissões por tela', icon: 'shield', onclick: () => permissionsDialog(r) } : null,
        {
          label: r.role === 'admin' ? 'Tornar colaborador' : 'Tornar administrador', icon: 'users',
          onclick: async () => {
            if (!await confirmDialog(r.role === 'admin' ? `${r.name} deixa de ser administrador.` : `${r.name} terá acesso total, inclusive a usuários e configurações.`, { confirmText: 'Confirmar' })) return;
            if (await run(null, () => q(sb.from('residents').update({ role: r.role === 'admin' ? 'member' : 'admin' }).eq('id', r.id).select('id').single()), 'Papel atualizado.')) {
              await loadMe();
              await reload();
            }
          },
        },
        !r.user_id ? {
          label: 'Gerar convite', icon: 'key',
          onclick: async () => {
            const code = await run(null, () => q(sb.rpc('create_invite', { p_resident: r.id })));
            if (!code) return;
            inviteBox.replaceChildren(h('div', { class: 'alert info' }, icon('key', 18), h('div', {},
              h('p', {}, `Código de convite para ${r.name} (válido por 72h, uso único):`),
              h('div', { class: 'code' }, code),
              h('p', { class: 'hint' }, `Envie por um canal seguro. A pessoa cria a conta em ${location.origin + location.pathname} e informa o código. Ele não será mostrado de novo.`))));
          },
        } : null,
        {
          label: 'Renomear', icon: 'pencil',
          onclick: () => {
            const n = input('n', { required: true, maxlength: 80, value: r.name });
            const sv = h('button', { type: 'submit', class: 'btn' }, 'Salvar');
            const fm = h('form', { class: 'stack' }, field('Nome', n), h('div', { class: 'dialog-actions' }, sv));
            const dd = openDialog({ title: 'Renomear usuário', body: fm });
            fm.addEventListener('submit', async (e) => {
              e.preventDefault();
              if (await run(sv, () => q(sb.from('residents').update({ name: n.value.trim() }).eq('id', r.id).select('id').single()), 'Nome atualizado.')) {
                dd.close();
                await reload();
              }
            });
          },
        },
        r.id !== myResidentId() ? {
          label: 'Remover', icon: 'trash', danger: true,
          onclick: async () => {
            if (!await confirmDialog(`Remover ${r.name}?`, { danger: true, confirmText: 'Remover', detail: 'As rendas e descontos pessoais dele são apagados; os lançamentos ficam como “da casa”.' })) return;
            if (await run(null, () => q(sb.from('residents').delete().eq('id', r.id)), 'Usuário removido.')) await reload();
          },
        } : null,
      ]))));
    const newName = input('name', { required: true, maxlength: 80, placeholder: 'Nome do usuário / morador' });
    const add = h('button', { type: 'submit', class: 'btn' }, icon('plus', 18), h('span', {}, 'Adicionar'));
    const addForm = h('form', { class: 'inline' }, field('Novo usuário', newName), add);
    addForm.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (await run(add, () => q(sb.from('residents').insert(houseRow({ name: newName.value.trim() }))), 'Usuário adicionado. Gere um convite para dar acesso.')) await reload();
    });
    body = h('div', { class: 'stack' },
      card(`Usuários de ${d.house.name}`, { sub: 'Administradores têm acesso total. Colaboradores seguem as permissões por tela.', cls: 'flush-body' },
        h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Usuário'), h('th', {}, 'Papel'), h('th', {}, 'Acesso'), h('th', {}, 'Permissões'), h('th', { class: 'act' }))),
          h('tbody', {}, ...rows))), inviteBox),
      card('Adicionar usuário', { sub: 'Pessoas sem login (ex.: crianças) também podem ter rendas e lançamentos.' }, addForm));
  } else {
    body = card('Excluir esta casa/empresa', { cls: 'danger-card' },
      h('p', {}, 'Apaga todas as contas, lançamentos, comprovantes, orçamentos, metas e usuários dela. Não tem volta.'),
      h('button', {
        type: 'button', class: 'btn danger solid',
        onclick: async () => {
          const typed = input('confirm', { required: true, autocomplete: 'off', placeholder: d.house.name });
          const go = h('button', { type: 'submit', class: 'btn danger solid' }, 'Excluir definitivamente');
          const fm = h('form', { class: 'stack' }, h('p', {}, 'Para confirmar, digite o nome: ', h('strong', {}, d.house.name)), typed, h('div', { class: 'dialog-actions' }, go));
          const dd = openDialog({ title: 'Excluir casa/empresa', body: fm });
          fm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (typed.value !== d.house.name) return toast('O nome digitado não confere.', true);
            const paths = d.transactions.map((x) => x.attachment_path).filter(Boolean);
            const ok = await run(go, async () => {
              for (let i = 0; i < paths.length; i += 100) await sb.storage.from('receipts').remove(paths.slice(i, i + 100));
              await q(sb.from('houses').delete().eq('id', state.houseId));
            }, 'Excluído.');
            if (ok) {
              dd.close();
              state.houseId = null;
              state.d = null;
              await loadMe();
              location.hash = '#/painel';
            }
          });
        },
      }, icon('trash', 18), h('span', {}, 'Excluir casa/empresa')));
  }
  page('Configurações', { subtitle: d.house.name }, tabs, body);
}
