// Compras: foto/XML do cupom fiscal -> preço de cada produto. Com o tempo: mais comprados, preço médio,
// onde e quando é mais barato, lista do mês (o que se repete) e pesquisa de preços atual na web (IA).
import { sb, q, callAi } from '../api.js';
import { state, page, card, canEdit, isAdmin, field, input, select, moneyInput, categorySelect, accountOptions, residentsOptions, myResidentId, run, reload, emptyState, routeParams } from '../ctx.js';
import { h, brl, openDialog, confirmDialog, toast, parseMoney, centsToInput, dateBr, monthLabel, download, menuButton } from '../ui.js';
import { icon } from '../icons.js';
import { localToday, addDays, addMonths } from '../finance.js';
import * as S from '../shopping.js';
import { progress } from '../charts.js';

const MAX_PARTS = 8;          // partes de imagem por cupom (cupom comprido é fatiado)
const PRICE_BATCH = 10;       // produtos por pesquisa na web (limite de tempo da função)
let tab = 'resumo';
let period = 6;               // meses (0 = tudo)
let productFilter = '';
let researchSel = null;       // Set de produtos marcados para pesquisar

// ---------------------------------------------------------------- dados
async function all(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const pageRows = await q(build().range(from, from + 999));
    out.push(...pageRows);
    if (pageRows.length < 1000) return out;
  }
}

async function loadShop() {
  const h0 = state.houseId;
  const [stores, products, receipts, items, quotes, aliases, house] = await Promise.all([
    q(sb.from('stores').select('*').eq('house_id', h0).order('name')),
    all(() => sb.from('products').select('*').eq('house_id', h0).order('name')),
    all(() => sb.from('shop_receipts').select('*').eq('house_id', h0).order('purchased_at', { ascending: false })),
    all(() => sb.from('shop_items').select('id, receipt_id, product_id, position, raw_name, code, quantity_milli, unit_price_cents, discount_cents, total_cents').eq('house_id', h0)),
    all(() => sb.from('price_quotes').select('*').eq('house_id', h0).gte('observed_on', addDays(localToday(), -400)).order('observed_on', { ascending: false })),
    all(() => sb.from('product_aliases').select('alias, product_id').eq('house_id', h0)),
    q(sb.from('houses').select('region').eq('id', h0).single()),
  ]);
  state.shop = { houseId: h0, stores, products, receipts, items, quotes, aliases, region: house.region ?? '' };
}
async function getShop() {
  if (!state.shop || state.shop.houseId !== state.houseId) await loadShop();
  return state.shop;
}
/** Depois de gravar: recarrega Compras e (se mexeu em lançamentos) a casa. */
async function refresh(alsoHouse = false) {
  state.shop = null;
  if (alsoHouse) await reload();
  else await renderShopping();
}

const storeName = (id) => state.shop.stores.find((s) => s.id === id)?.name ?? 'Mercado';
const productById = (id) => state.shop.products.find((p) => p.id === id);
const fmtQty = (milli, unit = 'un') => `${(milli / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 })} ${unit}`;
const perUnit = (cents, unit = 'un') => `${brl(cents)}${unit === 'un' ? '' : `/${unit}`}`;
function parseQty(str) {
  const n = Number(String(str ?? '').trim().replace(/\./g, (m, i, s) => (s.includes(',') ? '' : m)).replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
}
const csvCell = (v) => {
  const s = String(v ?? '');
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[;"\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
function periodRange() {
  const end = `${state.month}-31`;
  if (!period) return { from: null, to: end };
  return { from: `${addMonths(state.month, -(period - 1))}-01`, to: end };
}
const pctDiff = (index) => {
  const p = Math.round((index - 1) * 100);
  return p === 0 ? 'na média' : p < 0 ? `${-p}% mais barato` : `${p}% mais caro`;
};
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

// ---------------------------------------------------------------- página
/** Troca de aba (tira o ?aba= do endereço, senão ele venceria o clique). */
function goTab(k) {
  tab = k;
  if (routeParams().get('aba')) history.replaceState(null, '', '#/compras');
  renderShopping();
}

export async function renderShopping() {
  const p = routeParams().get('aba');
  if (p) tab = p;
  let shop;
  try {
    shop = await getShop();
  } catch (e) {
    page('Compras', {}, h('div', { class: 'error' }, /relation|does not exist|schema cache/i.test(String(e.message))
      ? 'O banco ainda não tem as tabelas de Compras. Rode supabase/migrations/003_compras.sql no Supabase (veja o README).'
      : e.message));
    return;
  }
  const edit = canEdit('compras');
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, ...[
    ['resumo', 'Resumo', 'dashboard'], ['cupons', 'Cupons', 'receipt'], ['produtos', 'Produtos', 'tag'],
    ['lista', 'Lista do mês', 'list'], ['pesquisa', 'Pesquisa de preços', 'globe'],
  ].map(([k, label, ic]) => h('button', {
    type: 'button', role: 'tab', 'aria-selected': String(tab === k), class: tab === k ? 'active' : '',
    onclick: () => goTab(k),
  }, icon(ic, 16), label)));

  const addMenu = edit ? h('div', { class: 'shop-add', role: 'group', 'aria-label': 'Novo cupom' },
    h('button', { type: 'button', class: 'btn', onclick: () => captureReceipt('photo') }, icon('camera', 18), h('span', {}, 'Fotografar cupom')),
    menuButton([
      { label: 'Importar XML da nota', icon: 'upload', onclick: () => captureReceipt('xml') },
      { label: 'Digitar cupom', icon: 'pencil', onclick: () => captureReceipt('manual') },
    ], 'Outras formas de lançar')) : null;

  const periodChips = h('div', { class: 'chips' }, h('span', { class: 'hint' }, 'Período:'), ...[[3, '3 meses'], [6, '6 meses'], [12, '12 meses'], [0, 'Tudo']]
    .map(([v, l]) => h('button', { type: 'button', class: `chip${period === v ? ' on' : ''}`, onclick: () => { period = v; renderShopping(); } }, l)));

  let body;
  if (!shop.receipts.length && tab !== 'pesquisa') body = onboarding(edit);
  else if (tab === 'resumo') body = h('div', { class: 'stack' }, periodChips, summaryTab(shop));
  else if (tab === 'cupons') body = receiptsTab(shop, edit);
  else if (tab === 'produtos') body = h('div', { class: 'stack' }, periodChips, productsTab(shop, edit));
  else if (tab === 'lista') body = listTab(shop);
  else body = researchTab(shop, edit);

  page('Compras', { subtitle: 'Cupons fiscais, preço de cada produto e onde comprar mais barato', actions: [addMenu] }, tabs, body);
}

function onboarding(edit) {
  return card(null, { cls: 'shop-onboard' },
    emptyState('cart', 'Comece pelo cupom fiscal', 'Fotografe o cupom das suas compras (ou importe o XML da nota). Cada produto e preço fica salvo com o mercado e a data. Depois de alguns meses você vê os mais comprados, o preço médio, o mercado mais barato e a melhor época para comprar.',
      edit ? h('div', { class: 'chips center-chips' },
        h('button', { type: 'button', class: 'btn', onclick: () => captureReceipt('photo') }, icon('camera', 18), h('span', {}, 'Fotografar cupom')),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => captureReceipt('xml') }, icon('upload', 18), h('span', {}, 'Importar XML')),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => captureReceipt('manual') }, icon('pencil', 18), h('span', {}, 'Digitar'))) : null),
    h('p', { class: 'hint center' }, icon('lock', 14), ' A foto vai para o seu armazenamento privado no Supabase; a leitura é feita pela IA configurada em Assistente IA. O XML é lido no próprio navegador, sem IA.'));
}

// ---------------------------------------------------------------- resumo
function summaryTab(shop) {
  const range = periodRange();
  const sum = S.shopSummary(shop, range);
  const stats = S.productStats(shop, range);
  const allStats = S.productStats(shop);           // sazonalidade precisa do histórico inteiro
  const rank = S.storeIndex(stats);
  const season = S.seasonIndex(allStats);
  const kpi = (label, value, sub, ic, cls = '') => h('section', { class: `card kpi ${cls}` },
    h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon(ic, 18)), h('span', { class: 'kpi-label' }, label)),
    h('div', { class: 'kpi-value num' }, value), sub ? h('div', { class: 'kpi-sub' }, sub) : null);

  const seasonVals = season.filter((s) => s.index != null);
  const cheapestMonth = seasonVals.length >= 2 ? seasonVals.reduce((a, b) => (b.index < a.index ? b : a)) : null;
  const priciestMonth = seasonVals.length >= 2 ? seasonVals.reduce((a, b) => (b.index > a.index ? b : a)) : null;
  const maxDev = Math.max(0.05, ...seasonVals.map((s) => Math.abs(s.index - 1)));
  const seasonCard = card('Melhor época para comprar', { sub: 'Preço médio de cada mês comparado com a média do produto (todo o histórico)' },
    seasonVals.length >= 2 ? h('div', { class: 'stack' },
      h('div', { class: 'month-bars', role: 'img', 'aria-label': 'Índice de preço por mês' }, ...season.map((s) => h('div', {
        class: `mb${s.index == null ? ' empty' : s.index < 1 ? ' low' : s.index > 1 ? ' high' : ''}${s === cheapestMonth ? ' best' : ''}`,
        title: s.index == null ? `${MONTHS[s.month - 1]}: sem dados` : `${MONTHS[s.month - 1]}: ${pctDiff(s.index)} (${s.products} produtos)`,
      }, h('span', { class: 'mb-bar', style: { '--v': s.index == null ? 0 : Math.abs(s.index - 1) / maxDev, '--dir': s.index != null && s.index < 1 ? -1 : 1 } }),
      h('span', { class: 'mb-label' }, MONTHS[s.month - 1])))),
      h('p', {}, h('strong', {}, monthLabel(`2000-${String(cheapestMonth.month).padStart(2, '0')}`).replace(/ de 2000$/, '')), ` foi o mês mais barato (${pctDiff(cheapestMonth.index)}); `,
        h('strong', {}, monthLabel(`2000-${String(priciestMonth.month).padStart(2, '0')}`).replace(/ de 2000$/, '')), ` o mais caro (${pctDiff(priciestMonth.index)}).`),
      h('p', { class: 'hint' }, 'Fica mais confiável com mais de um ano de cupons. Abaixo da linha = mais barato que a média.'))
      : h('p', { class: 'muted' }, 'Ainda não dá para comparar: é preciso ter comprado os mesmos produtos em pelo menos 2 meses diferentes.'));

  const rankCard = card('Onde está mais barato', { sub: 'Comparando os mesmos produtos entre mercados' },
    rank.length ? h('ul', { class: 'rank-list' }, ...rank.map((r, i) => h('li', {},
      h('span', { class: `rank-pos${i === 0 ? ' first' : ''}` }, String(i + 1)),
      h('div', { class: 'rank-main' }, h('strong', {}, storeName(r.store_id)), h('small', { class: 'muted' }, `${r.products} produtos em comum · mais barato em ${r.cheapest}`)),
      h('span', { class: `status ${r.index < 0.995 ? 'good' : r.index > 1.005 ? 'bad' : ''}` }, pctDiff(r.index)))))
      : h('p', { class: 'muted' }, 'Compre o mesmo produto em 2 ou mais mercados para ver a comparação. A Pesquisa de preços ajuda a comparar sem precisar comprar.'));

  const maxStore = sum.byStore[0]?.amount ?? 1;
  const storeCard = card('Gasto por mercado', { sub: 'Total dos cupons no período' },
    sum.byStore.length ? h('ul', { class: 'bar-list' }, ...sum.byStore.map((s) => h('li', {},
      h('div', { class: 'row-between' }, h('span', {}, storeName(s.store_id)), h('strong', { class: 'num' }, brl(s.amount))),
      progress(s.amount / maxStore)))) : h('p', { class: 'muted' }, 'Sem cupons no período.'));

  return h('div', { class: 'stack' },
    h('div', { class: 'grid kpis' },
      kpi('Gasto em cupons', brl(sum.total), `${sum.receipts} compras`, 'cart', 'out'),
      kpi('Ticket médio', brl(sum.ticket), 'por compra', 'receipt'),
      kpi('Produtos diferentes', String(stats.length), `${stats.filter((s) => s.months >= 2).length} se repetem`, 'tag'),
      kpi('Mercados', String(new Set(sum.byStore.map((s) => s.store_id)).size), 'no período', 'store')),
    h('div', { class: 'grid cols-2' }, topCard(stats.slice(0, 12)), h('div', { class: 'stack' }, rankCard, seasonCard, storeCard)));
}

function topCard(stats) {
  return card('Mais comprados', { sub: 'Ordenado pelos meses em que aparece; clique para ver o histórico', cls: 'flush-body' },
    stats.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Produto'), h('th', {}, 'Meses'), h('th', { class: 'num' }, 'Preço médio'), h('th', { class: 'num' }, 'Menor preço'))),
      h('tbody', {}, ...stats.map((s) => h('tr', { class: 'clickable', onclick: () => productDialog(s.product.id) },
        h('td', {}, h('strong', {}, s.product.name)),
        h('td', {}, `${s.months} meses`, h('small', { class: 'muted block' }, `${s.purchases} compras`)),
        h('td', { class: 'num' }, perUnit(s.avg, s.product.unit)),
        h('td', { class: 'num' }, perUnit(s.min.price, s.product.unit), h('small', { class: 'muted block' }, storeName(s.min.store_id)))))))) : h('p', { class: 'muted pad' }, 'Sem compras no período.'));
}

// ---------------------------------------------------------------- cupons
function receiptsTab(shop, edit) {
  const counts = new Map();
  for (const it of shop.items) counts.set(it.receipt_id, (counts.get(it.receipt_id) ?? 0) + 1);
  const SRC = { photo: ['camera', 'Foto'], xml: ['upload', 'XML'], manual: ['pencil', 'Digitado'] };
  return card(null, { cls: 'flush-body' }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Data'), h('th', {}, 'Mercado'), h('th', {}, 'Itens'), h('th', {}, 'Origem'), h('th', { class: 'num' }, 'Total'), h('th', {}, ''))),
    h('tbody', {}, ...shop.receipts.map((r) => h('tr', { class: 'clickable', onclick: (e) => { if (!e.target.closest('.menu')) receiptDialog(r); } },
      h('td', {}, dateBr(r.purchased_at)),
      h('td', {}, h('strong', {}, storeName(r.store_id)), r.transaction_id ? h('small', { class: 'muted block' }, icon('check', 12), ' lançado como saída') : null),
      h('td', {}, String(counts.get(r.id) ?? 0)),
      h('td', {}, h('span', { class: 'tag' }, icon(SRC[r.source]?.[0] ?? 'receipt', 12), ' ', SRC[r.source]?.[1] ?? r.source)),
      h('td', { class: 'num' }, h('strong', {}, brl(Number(r.total_cents)))),
      h('td', { class: 'actions' }, edit && (isAdmin() || r.created_by === state.user.id) ? menuButton([
        { label: 'Ver itens', icon: 'eye', onclick: () => receiptDialog(r) },
        r.image_paths?.length ? { label: 'Ver foto', icon: 'image', onclick: () => viewImages(r.image_paths) } : null,
        { label: 'Excluir cupom', icon: 'trash', danger: true, onclick: () => deleteReceipt(r) },
      ]) : null)))))));
}

function receiptDialog(r) {
  const items = state.shop.items.filter((i) => i.receipt_id === r.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const edit = canEdit('compras') && (isAdmin() || r.created_by === state.user.id);
  const sum = items.reduce((s, i) => s + Number(i.total_cents), 0);
  const d = openDialog({
    title: `${storeName(r.store_id)} · ${dateBr(r.purchased_at)}`, wide: true,
    body: h('div', { class: 'stack' },
      h('div', { class: 'chips' },
        h('span', { class: 'tag' }, `${items.length} itens`), h('span', { class: 'tag' }, `Total ${brl(Number(r.total_cents))}`),
        Number(r.discount_cents) ? h('span', { class: 'tag' }, `Descontos ${brl(Number(r.discount_cents))}`) : null,
        r.access_key ? h('span', { class: 'tag', title: r.access_key }, 'Chave de acesso salva') : null,
        r.image_paths?.length ? h('button', { type: 'button', class: 'chip', onclick: () => viewImages(r.image_paths) }, icon('image', 14), ' Ver foto') : null),
      sum !== Number(r.total_cents) ? h('p', { class: 'hint' }, icon('alert', 14), ` A soma dos itens (${brl(sum)}) difere do total do cupom.`) : null,
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Produto'), h('th', {}, 'Qtd.'), h('th', { class: 'num' }, 'Unitário'), h('th', { class: 'num' }, 'Total'), h('th', {}, ''))),
        h('tbody', {}, ...items.map((i) => {
          const p = productById(i.product_id);
          return h('tr', {},
            h('td', {}, h('strong', {}, p?.name ?? '—'), h('small', { class: 'muted block' }, i.raw_name)),
            h('td', {}, fmtQty(i.quantity_milli, p?.unit)),
            h('td', { class: 'num' }, brl(Number(i.unit_price_cents))),
            h('td', { class: 'num' }, brl(Number(i.total_cents)), Number(i.discount_cents) ? h('small', { class: 'muted block' }, `−${brl(Number(i.discount_cents))}`) : null),
            h('td', { class: 'actions' }, edit ? h('button', {
              type: 'button', class: 'icon-btn sm', title: 'Trocar o produto deste item', 'aria-label': `Trocar produto de ${i.raw_name}`,
              onclick: () => { d.close(); reassignItem(i, r); },
            }, icon('pencil', 15)) : null));
        })))),
      edit ? h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn ghost danger-text', onclick: () => { d.close(); deleteReceipt(r); } }, icon('trash', 16), h('span', {}, 'Excluir cupom'))) : null),
  });
}

/** Item ligado ao produto errado: escolhe outro (ou cria) e lembra para os próximos cupons. */
function reassignItem(item, r) {
  const current = productById(item.product_id);
  const name = productNameInput(current?.name ?? '');
  const save = h('button', { type: 'submit', class: 'btn' }, icon('check', 18), h('span', {}, 'Salvar'));
  const form = h('form', { class: 'stack' }, h('p', { class: 'muted' }, 'No cupom: ', h('strong', {}, item.raw_name)), field('Produto', name.el, { hint: 'Escolha um produto existente ou digite um nome novo.' }), name.list,
    h('div', { class: 'dialog-actions' }, save));
  const d = openDialog({ title: 'Trocar produto', body: form });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const typed = name.el.value.trim();
    if (!typed) return toast('Informe o produto.', true);
    const ok = await run(save, async () => {
      let pid = name.match();
      if (!pid) pid = (await q(sb.from('products').insert({ house_id: state.houseId, name: typed, unit: current?.unit ?? 'un' }).select('id').single())).id;
      await q(sb.from('shop_items').update({ product_id: pid }).eq('id', item.id).select('id').single());
      await q(sb.from('product_aliases').upsert({ house_id: state.houseId, alias: S.normName(item.raw_name), product_id: pid }));
    }, 'Item atualizado.');
    if (ok) {
      d.close();
      await refresh();
      receiptDialog(r);
    }
  });
}

async function deleteReceipt(r) {
  const ok = await confirmDialog(`Excluir o cupom de ${storeName(r.store_id)} (${dateBr(r.purchased_at)}, ${brl(Number(r.total_cents))})?`, {
    title: 'Excluir cupom', confirmText: 'Excluir', danger: true,
    detail: r.transaction_id ? 'Os itens e preços somem do histórico. O lançamento de saída em Lançamentos continua (exclua lá se quiser).' : 'Os itens e preços somem do histórico.',
  });
  if (!ok) return;
  const done = await run(null, async () => {
    await q(sb.from('shop_receipts').delete().eq('id', r.id));
    const tx = r.transaction_id ? state.d.transactions.find((t) => t.id === r.transaction_id) : null;
    const keep = new Set(tx?.attachment_path ? [tx.attachment_path] : []);
    const remove = (r.image_paths ?? []).filter((p) => !keep.has(p));
    if (remove.length) await sb.storage.from('receipts').remove(remove);
  }, 'Cupom excluído.');
  if (done) await refresh();
}

async function viewImages(paths) {
  const urls = await run(null, async () => Promise.all(paths.map(async (p) => (await q(sb.storage.from('receipts').createSignedUrl(p, 120))).signedUrl)));
  if (!urls) return;
  openDialog({ title: 'Foto do cupom', wide: true, body: h('div', { class: 'receipt-strip' }, ...urls.map((u) => h('img', { src: u, alt: 'Parte do cupom', class: 'receipt-img' }))) });
}

// ---------------------------------------------------------------- produtos
function productsTab(shop, edit) {
  const stats = S.productStats(shop, periodRange());
  const statOf = new Map(stats.map((s) => [s.product.id, s]));
  const search = h('input', { type: 'search', placeholder: 'Buscar produto…', value: productFilter, 'aria-label': 'Buscar produto' });
  const tbody = h('tbody');
  const paint = () => {
    const f = S.normName(search.value);
    const rows = [...stats, ...shop.products.filter((p) => !statOf.has(p.id)).map((p) => ({ product: p }))]
      .filter((s) => !f || S.normName(s.product.name).includes(f));
    tbody.replaceChildren(...rows.map((s) => h('tr', { class: 'clickable', onclick: () => productDialog(s.product.id) },
      h('td', {}, h('strong', {}, s.product.name), s.product.list_mode !== 'auto' ? h('span', { class: 'tag' }, s.product.list_mode === 'always' ? 'sempre na lista' : 'fora da lista') : null),
      h('td', {}, s.months ? h('span', {}, `${s.months} meses`, h('small', { class: 'muted block' }, `${s.purchases} compras`)) : h('span', { class: 'muted' }, 'sem compras no período')),
      h('td', { class: 'num' }, s.avg ? perUnit(s.avg, s.product.unit) : '—'),
      h('td', { class: 'num' }, s.min ? h('span', {}, perUnit(s.min.price, s.product.unit), h('small', { class: 'muted block' }, storeName(s.min.store_id))) : '—'),
      h('td', { class: 'num' }, s.last ? h('span', {}, perUnit(s.last.price, s.product.unit), h('small', { class: 'muted block' }, dateBr(s.last.date))) : '—'),
      h('td', { class: 'num' }, s.spent ? brl(s.spent) : '—'))));
  };
  search.addEventListener('input', () => {
    productFilter = search.value;
    paint();
  });
  paint();
  const exportCsv = () => {
    const lines = [['Produto', 'Unidade', 'Meses', 'Compras', 'Quantidade', 'Gasto', 'Preço médio', 'Menor preço', 'Mercado do menor', 'Último preço', 'Data do último'].join(';'),
      ...stats.map((s) => [s.product.name, s.product.unit, s.months, s.purchases, (s.qty / 1000).toString().replace('.', ','), centsToInput(s.spent), centsToInput(s.avg), centsToInput(s.min.price), storeName(s.min.store_id), centsToInput(s.last.price), s.last.date].map(csvCell).join(';'))];
    download(`produtos-${localToday()}.csv`, `﻿${lines.join('\n')}`, 'text/csv;charset=utf-8');
  };
  return card(null, { cls: 'flush-body', actions: null },
    h('div', { class: 'toolbar pad' }, search, h('button', { type: 'button', class: 'btn ghost small', onclick: exportCsv }, icon('download', 16), h('span', {}, 'CSV')),
      edit ? h('button', { type: 'button', class: 'btn ghost small', onclick: () => productEditDialog(null) }, icon('plus', 16), h('span', {}, 'Produto')) : null),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Produto'), h('th', {}, 'Frequência'), h('th', { class: 'num' }, 'Preço médio'), h('th', { class: 'num' }, 'Menor'), h('th', { class: 'num' }, 'Último'), h('th', { class: 'num' }, 'Gasto'))),
      tbody)));
}

function productDialog(pid) {
  const p = productById(pid);
  if (!p) return;
  const s = S.productStats(state.shop).find((x) => x.product.id === pid);
  const quotes = state.shop.quotes.filter((x) => x.product_id === pid).slice(0, 12);
  const edit = canEdit('compras');
  const maxM = Math.max(1, ...(s?.byMonthOfYear ?? []).filter(Boolean));
  const minM = Math.min(...(s?.byMonthOfYear ?? []).filter(Boolean));
  let d;
  const body = h('div', { class: 'stack' },
    s ? h('div', { class: 'stats-row' },
      ...[['Preço médio', perUnit(s.avg, p.unit)], ['Menor', `${perUnit(s.min.price, p.unit)} · ${storeName(s.min.store_id)}`], ['Maior', perUnit(s.max.price, p.unit)],
        ['Último', `${perUnit(s.last.price, p.unit)} · ${dateBr(s.last.date)}`], ['Comprado', `${s.purchases}× em ${s.months} meses (${fmtQty(s.qty, p.unit)})`], ['Gasto total', brl(s.spent)]]
        .map(([l, v]) => h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, l), h('strong', {}, v))))
      : h('p', { class: 'muted' }, 'Ainda sem compras deste produto.'),
    s?.byStore.length ? h('div', {}, h('h3', {}, 'Por mercado'), h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Mercado'), h('th', {}, 'Compras'), h('th', { class: 'num' }, 'Preço médio'), h('th', { class: 'num' }, 'Último'))),
      h('tbody', {}, ...s.byStore.map((b, i) => h('tr', {},
        h('td', {}, storeName(b.store_id), i === 0 && s.byStore.length > 1 ? h('span', { class: 'status good' }, 'mais barato') : null),
        h('td', {}, String(b.count)), h('td', { class: 'num' }, perUnit(b.avg, p.unit)),
        h('td', { class: 'num' }, perUnit(b.last.price, p.unit), h('small', { class: 'muted block' }, dateBr(b.last.date)))))))) : null,
    s && s.byMonthOfYear.filter(Boolean).length >= 2 ? h('div', {}, h('h3', {}, 'Preço médio por mês do ano'),
      h('div', { class: 'month-cols' }, ...s.byMonthOfYear.map((v, i) => h('div', { class: `mc${v == null ? ' empty' : v === minM ? ' best' : ''}`, title: v == null ? 'sem compras' : perUnit(v, p.unit) },
        h('span', { class: 'mc-bar', style: { '--v': v == null ? 0 : v / maxM } }), h('span', { class: 'mc-label' }, MONTHS[i])))))
      : null,
    quotes.length ? h('div', {}, h('h3', {}, 'Cotações (pesquisa/encarte)'), quoteTable(quotes, p)) : null,
    s ? h('details', {}, h('summary', {}, `Histórico (${s.history.length})`), h('ul', { class: 'hist-list' }, ...[...s.history].reverse().map((x) => h('li', {}, `${dateBr(x.date)} · ${storeName(x.store_id)} · ${perUnit(x.price, p.unit)}`)))) : null,
    edit ? h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { d.close(); quoteDialog(p); } }, icon('plus', 16), h('span', {}, 'Preço de encarte')),
      h('button', { type: 'button', class: 'btn ghost', onclick: () => { d.close(); mergeDialog(p); } }, icon('merge', 16), h('span', {}, 'Mesclar')),
      h('button', { type: 'button', class: 'btn', onclick: () => { d.close(); productEditDialog(p); } }, icon('pencil', 16), h('span', {}, 'Editar'))) : null);
  d = openDialog({ title: p.name, body, wide: true });
}

function quoteTable(quotes, p) {
  const SRC = { web: 'web', manual: 'digitado', flyer: 'encarte' };
  return h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Mercado'), h('th', { class: 'num' }, 'Preço'), h('th', {}, 'Data'), h('th', {}, 'Fonte'))),
    h('tbody', {}, ...quotes.map((x) => h('tr', {},
      h('td', {}, x.store_name, x.note ? h('small', { class: 'muted block' }, x.note) : null),
      h('td', { class: 'num' }, perUnit(Number(x.price_cents), p?.unit)),
      h('td', {}, dateBr(x.observed_on)),
      h('td', {}, x.url ? h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer nofollow' }, SRC[x.source] ?? x.source, ' ', icon('right', 12)) : SRC[x.source] ?? x.source)))));
}

function productEditDialog(p) {
  const name = input('name', { required: true, maxlength: 80, value: p?.name ?? '' });
  const unit = select('unit', S.UNITS.map((u) => ({ value: u, label: u })), p?.unit ?? 'un');
  const ean = input('ean', { maxlength: 14, inputmode: 'numeric', pattern: '\\d{8,14}', value: p?.ean ?? '', placeholder: 'opcional' });
  const mode = select('list_mode', [{ value: 'auto', label: 'Automático (entra se se repetir)' }, { value: 'always', label: 'Sempre na lista do mês' }, { value: 'never', label: 'Nunca na lista do mês' }], p?.list_mode ?? 'auto');
  const save = h('button', { type: 'submit', class: 'btn' }, icon('check', 18), h('span', {}, 'Salvar'));
  const del = p && isAdmin() ? h('button', { type: 'button', class: 'btn ghost danger-text' }, 'Excluir') : null;
  const form = h('form', { class: 'form-grid' }, field('Nome', name, { cls: 'span-2', hint: 'Inclua marca e tamanho (ex.: Café Pilão 500g) para comparar certo.' }), field('Unidade', unit), field('Código de barras', ean),
    field('Lista do mês', mode, { cls: 'span-2' }), h('div', { class: 'dialog-actions span-2' }, del, save));
  const d = openDialog({ title: p ? 'Editar produto' : 'Novo produto', body: form });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const row = { name: name.value.trim(), unit: unit.value, ean: ean.value.trim() || null, list_mode: mode.value };
    const ok = await run(save, () => q(p ? sb.from('products').update(row).eq('id', p.id).select('id').single()
      : sb.from('products').insert({ ...row, house_id: state.houseId })), 'Produto salvo.');
    if (ok) {
      d.close();
      await refresh();
    }
  });
  del?.addEventListener('click', async () => {
    d.close();
    if (!await confirmDialog(`Excluir "${p.name}"? O histórico de preços dele também some.`, { danger: true, confirmText: 'Excluir' })) return;
    if (await run(null, () => q(sb.from('products').delete().eq('id', p.id)), 'Produto excluído.')) await refresh();
  });
}

function mergeDialog(p) {
  const target = productNameInput('', p.id);
  const save = h('button', { type: 'submit', class: 'btn' }, icon('merge', 18), h('span', {}, 'Mesclar'));
  const form = h('form', { class: 'stack' },
    h('p', {}, 'Junta ', h('strong', {}, p.name), ' com outro produto (ex.: o mesmo arroz escrito de dois jeitos). Histórico, cotações e apelidos vão para o produto escolhido e este é apagado.'),
    field('Mesclar com', target.el), target.list, h('div', { class: 'dialog-actions' }, save));
  const d = openDialog({ title: 'Mesclar produto', body: form });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const into = target.match();
    if (!into) return toast('Escolha um produto da lista.', true);
    if (await run(save, () => q(sb.rpc('merge_products', { p_from: p.id, p_into: into })), 'Produtos mesclados.')) {
      d.close();
      await refresh();
    }
  });
}

function quoteDialog(p) {
  const storeIn = input('store', { required: true, maxlength: 80, list: 'dl-stores', placeholder: 'Nome do mercado' });
  const stores = h('datalist', { id: 'dl-stores' }, ...state.shop.stores.map((s) => h('option', { value: s.name })));
  const price = moneyInput('price', { required: true });
  const date = input('date', { type: 'date', required: true, value: localToday() });
  const note = input('note', { maxlength: 200, placeholder: 'ex.: oferta até sexta' });
  const save = h('button', { type: 'submit', class: 'btn' }, icon('check', 18), h('span', {}, 'Salvar preço'));
  const form = h('form', { class: 'form-grid' }, field('Mercado', storeIn, { cls: 'span-2' }), stores, field(`Preço${p.unit === 'un' ? '' : ` por ${p.unit}`}`, price), field('Data', date),
    field('Observação', note, { cls: 'span-2' }), h('div', { class: 'dialog-actions span-2' }, save));
  const d = openDialog({ title: `Preço de ${p.name}`, body: form });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cents = parseMoney(price.querySelector('input').value);
    if (!cents) return toast('Informe o preço.', true);
    const name = storeIn.value.trim();
    const ok = await run(save, () => q(sb.from('price_quotes').insert({
      house_id: state.houseId, product_id: p.id, store_id: matchStore(name), store_name: name, price_cents: cents, source: 'flyer', note: note.value.trim() || null, observed_on: date.value,
    })), 'Preço salvo.');
    if (ok) {
      d.close();
      await refresh();
    }
  });
}

/** Campo de produto com sugestões: match() devolve o id se o texto for um produto existente. */
function productNameInput(value, excludeId = null) {
  const id = `dl-p-${Math.random().toString(36).slice(2, 8)}`;
  const el = input('product', { required: true, maxlength: 80, value, list: id, autocomplete: 'off' });
  const opts = state.shop.products.filter((p) => p.id !== excludeId);
  const list = h('datalist', { id }, ...opts.map((p) => h('option', { value: p.name })));
  const byName = new Map(opts.map((p) => [S.normName(p.name), p.id]));
  return { el, list, match: () => byName.get(S.normName(el.value)) ?? null };
}

/** Acha o mercado cadastrado pelo nome (igual, ou um contém o outro). */
function matchStore(name) {
  const n = S.normName(name);
  if (!n) return null;
  const hit = state.shop.stores.find((s) => S.normName(s.name) === n)
    ?? state.shop.stores.find((s) => {
      const m = S.normName(s.name);
      return m.length >= 5 && n.length >= 5 && (n.includes(m) || m.includes(n));
    });
  return hit?.id ?? null;
}

// ---------------------------------------------------------------- lista do mês
function listTab(shop) {
  const rec = S.recurringList(shop, { month: state.month, months: 6 });
  const stats = S.productStats(shop);
  const prices = S.latestPrices(shop, { today: localToday(), maxAgeDays: 90 });
  const list = rec.items.map((i) => ({ product: i.product, qty: i.qty }));
  const cmp = S.basketCompare(list, prices, stats);
  const bestSingle = cmp.stores.find((s) => s.covered === list.length) ?? cmp.stores[0];

  if (!rec.items.length) {
    return card(null, {}, emptyState('list', 'A lista do mês aparece sozinha', 'Entram os produtos comprados em pelo menos metade dos meses (dos últimos 6). Lance cupons de 2 ou mais meses, ou marque produtos como "sempre na lista" em Produtos.'));
  }
  const copy = async () => {
    const lines = cmp.best.items.map((i) => `- ${i.product.name} (${fmtQty(i.qty, i.product.unit)}) — ${i.name} ${perUnit(i.price, i.product.unit)}`)
      .concat(cmp.best.missing.map((p) => `- ${p.name} (sem preço recente)`));
    const text = `Lista de compras — ${monthLabel(state.month)}\n${lines.join('\n')}\nTotal estimado: ${brl(cmp.best.total)}`;
    try {
      if (navigator.share && /Mobi/i.test(navigator.userAgent)) await navigator.share({ title: 'Lista de compras', text });
      else {
        await navigator.clipboard.writeText(text);
        toast('Lista copiada.');
      }
    } catch { /* cancelado */ }
  };
  const savingVsUsual = cmp.usual - cmp.best.total;
  return h('div', { class: 'stack' },
    h('div', { class: 'grid kpis three' },
      h('section', { class: 'card kpi' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon('list', 18)), h('span', { class: 'kpi-label' }, 'Itens que se repetem')),
        h('div', { class: 'kpi-value' }, String(rec.items.length)), h('div', { class: 'kpi-sub' }, `em ${rec.activeMonths} meses com compras`)),
      h('section', { class: 'card kpi pos' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon('piggy', 18)), h('span', { class: 'kpi-label' }, 'Melhor combinação')),
        h('div', { class: 'kpi-value num' }, brl(cmp.best.total)), h('div', { class: 'kpi-sub' }, `em ${cmp.best.storeCount} mercado(s)${cmp.best.missing.length ? ` · ${cmp.best.missing.length} sem preço` : ''}`)),
      h('section', { class: 'card kpi' }, h('div', { class: 'kpi-top' }, h('span', { class: 'kpi-ico' }, icon('down_trend', 18)), h('span', { class: 'kpi-label' }, 'Economia estimada')),
        h('div', { class: 'kpi-value num' }, savingVsUsual > 0 ? brl(savingVsUsual) : '—'), h('div', { class: 'kpi-sub' }, `contra o seu preço médio (${brl(cmp.usual)})`))),
    h('div', { class: 'grid cols-2' },
      card('Onde comprar cada item', {
        sub: 'Preço mais recente conhecido (cupons e cotações dos últimos 90 dias)', cls: 'flush-body',
        actions: h('div', { class: 'chips' },
          h('button', { type: 'button', class: 'btn ghost small', onclick: copy }, icon('layers', 16), h('span', {}, 'Copiar')),
          h('button', { type: 'button', class: 'btn ghost small', onclick: () => { researchSel = new Set(list.map((i) => i.product.id)); goTab('pesquisa'); } }, icon('globe', 16), h('span', {}, 'Atualizar preços'))),
      }, h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Produto'), h('th', {}, 'Qtd./mês'), h('th', {}, 'Onde'), h('th', { class: 'num' }, 'Preço'))),
        h('tbody', {}, ...rec.items.map((r) => {
          const b = cmp.best.items.find((x) => x.product.id === r.product.id);
          return h('tr', { class: 'clickable', onclick: () => productDialog(r.product.id) },
            h('td', {}, h('strong', {}, r.product.name), h('small', { class: 'muted block' }, r.always ? 'sempre na lista' : `${r.months} de ${rec.activeMonths} meses`)),
            h('td', {}, fmtQty(r.qty, r.product.unit)),
            h('td', {}, b ? h('span', {}, b.name, h('small', { class: 'muted block' }, `${b.source === 'cupom' ? 'cupom' : 'cotação'} de ${dateBr(b.date)}`)) : h('span', { class: 'muted' }, 'sem preço recente')),
            h('td', { class: 'num' }, b ? perUnit(b.price, r.product.unit) : '—'));
        }))))),
      card('Cesta inteira por mercado', { sub: 'Quanto a lista custaria comprando tudo num lugar só' },
        cmp.stores.length ? h('ul', { class: 'rank-list' }, ...cmp.stores.slice(0, 10).map((s) => h('li', {},
          h('div', { class: 'rank-main' }, h('strong', {}, s.name), h('small', { class: 'muted' }, `${s.covered} de ${list.length} itens com preço${s.missing.length ? ` · falta: ${s.missing.slice(0, 3).map((p) => p.name).join(', ')}${s.missing.length > 3 ? '…' : ''}` : ''}`)),
          h('span', { class: `num${s === bestSingle ? ' pos' : ''}` }, h('strong', {}, brl(s.total))))))
          : h('p', { class: 'muted' }, 'Sem preços recentes. Lance cupons ou use a Pesquisa de preços.'),
        h('p', { class: 'hint' }, 'Mercados com menos itens cotados parecem mais baratos só porque faltam produtos: compare quem tem a cesta completa.'))));
}

// ---------------------------------------------------------------- pesquisa de preços (IA + web)
function researchTab(shop, edit) {
  const ai = state.d.ai;
  const region = input('region', { maxlength: 120, value: state.shop.region, placeholder: 'Ex.: Cuiabá - MT, bairro Boa Esperança' });
  const saveRegion = isAdmin() ? h('button', {
    type: 'button', class: 'btn ghost small',
    onclick: async (ev) => {
      if (await run(ev.currentTarget, () => q(sb.from('houses').update({ region: region.value.trim() || null }).eq('id', state.houseId).select('id').single()), 'Região salva.')) state.shop.region = region.value.trim();
    },
  }, 'Salvar região') : null;

  const rec = S.recurringList(shop, { month: state.month, months: 6 }).items.map((i) => i.product);
  const stats = S.productStats(shop);
  const candidates = [...rec, ...stats.map((s) => s.product).filter((p) => !rec.includes(p)), ...shop.products.filter((p) => !rec.includes(p) && !stats.some((s) => s.product === p))];
  researchSel ??= new Set(rec.slice(0, PRICE_BATCH).map((p) => p.id));
  const counter = h('span', { class: 'hint' });
  const paintCounter = () => { counter.textContent = `${researchSel.size} selecionados${researchSel.size > PRICE_BATCH ? ` (pesquisa em ${Math.ceil(researchSel.size / PRICE_BATCH)} rodadas)` : ''}`; };
  paintCounter();
  const checks = h('div', { class: 'check-grid' }, ...candidates.map((p) => {
    const cb = h('input', { type: 'checkbox', checked: researchSel.has(p.id) });
    cb.addEventListener('change', () => {
      if (cb.checked) researchSel.add(p.id);
      else researchSel.delete(p.id);
      paintCounter();
    });
    return h('label', { class: 'check' }, cb, h('span', {}, p.name));
  }));
  const go = h('button', { type: 'button', class: 'btn', disabled: !edit || !ai || ai.provider === 'openai' }, icon('sparkles', 18), h('span', {}, 'Pesquisar preços atuais'));
  const status = h('div', { class: 'stack', 'aria-live': 'polite' });
  go.addEventListener('click', () => research(go, status, region.value.trim()));

  const recent = shop.quotes.filter((x) => x.observed_on >= addDays(localToday(), -30));
  const byProduct = new Map();
  for (const x of recent) {
    if (!byProduct.has(x.product_id)) byProduct.set(x.product_id, []);
    byProduct.get(x.product_id).push(x);
  }
  const results = byProduct.size ? h('div', { class: 'grid cols-2' }, ...[...byProduct].map(([pid, list]) => {
    const p = productById(pid);
    const sorted = [...list].sort((a, b) => Number(a.price_cents) - Number(b.price_cents));
    const mine = stats.find((s) => s.product.id === pid);
    return card(p?.name ?? 'Produto', { sub: mine ? `Você paga em média ${perUnit(mine.avg, p.unit)}` : null }, quoteTable(sorted.slice(0, 8), p));
  })) : h('p', { class: 'muted' }, 'Nenhuma cotação nos últimos 30 dias.');

  return h('div', { class: 'stack' },
    card('Pesquisar preços na região', { sub: 'A IA procura na web (encartes, sites e apps de mercados) o preço de hoje dos produtos escolhidos' },
      h('div', { class: 'stack' },
        !ai ? h('div', { class: 'alert' }, icon('alert', 16), ' Configure a IA em Assistente IA (Claude ou Gemini) para pesquisar.')
          : ai.provider === 'openai' ? h('div', { class: 'alert' }, icon('alert', 16), ' O provedor atual (compatível com OpenAI) não pesquisa na web. Use Claude ou Gemini.') : null,
        h('div', { class: 'toolbar' }, field('Cidade / bairro', region, { cls: 'grow' }), saveRegion),
        h('div', { class: 'row-between' }, h('strong', {}, 'Produtos'), h('div', { class: 'chips' }, counter,
          h('button', { type: 'button', class: 'chip', onclick: () => { researchSel = new Set(rec.map((p) => p.id)); renderShopping(); } }, 'Lista do mês'),
          h('button', { type: 'button', class: 'chip', onclick: () => { researchSel = new Set(); renderShopping(); } }, 'Limpar'))),
        candidates.length ? checks : h('p', { class: 'muted' }, 'Cadastre produtos lançando um cupom ou em Produtos.'),
        h('div', { class: 'dialog-actions' }, go), status,
        h('p', { class: 'hint' }, icon('lock', 14), ' Vão para a IA só os nomes dos produtos, a região e os nomes dos mercados onde você compra. Cada rodada conta no limite de pedidos por hora. Preços da web podem estar desatualizados: confira o link antes de sair de casa.'))),
    card('Cotações dos últimos 30 dias', { sub: 'Do mais barato para o mais caro. "fonte não conferida" = o link citado não veio da busca: confira antes de ir' }, results));
}

async function research(btnEl, status, region) {
  if (region.length < 3) return toast('Informe a cidade (e, se quiser, o bairro).', true);
  const ids = [...researchSel].filter((id) => productById(id));
  if (!ids.length) return toast('Marque pelo menos um produto.', true);
  const today = localToday();
  const stores = [...new Set(state.shop.stores.map((s) => s.name))].slice(0, 20);
  const rounds = [];
  for (let i = 0; i < ids.length; i += PRICE_BATCH) rounds.push(ids.slice(i, i + PRICE_BATCH));
  let saved = 0;
  const notes = [];
  btnEl.disabled = true;
  try {
    for (const [n, chunk] of rounds.entries()) {
      status.replaceChildren(h('p', { class: 'voice-status' }, h('span', { class: 'spinner' }), ` Pesquisando ${n + 1} de ${rounds.length}… (pode levar 1 a 2 minutos)`));
      const out = await callAi({ action: 'prices', houseId: state.houseId, region, productIds: chunk, stores, today });
      if (out.note) notes.push(out.note);
      const rows = (out.quotes ?? []).map((x) => ({
        house_id: state.houseId, product_id: x.product_id, store_id: matchStore(x.store_name), store_name: x.store_name, price_cents: x.price_cents,
        source: 'web', url: x.url, observed_on: x.observed_on,
        note: [x.checked === false ? 'fonte não conferida' : null, x.note].filter(Boolean).join(' · ').slice(0, 200) || null,
      }));
      if (rows.length) await q(sb.from('price_quotes').insert(rows));
      saved += rows.length;
    }
    toast(saved ? `${saved} preços encontrados e salvos.` : 'A pesquisa não encontrou preços para esses produtos.', !saved);
    state.shop = null;
    await renderShopping();
    if (notes.length) toast(notes.join(' '));
  } catch (e) {
    status.replaceChildren(h('div', { class: 'error' }, e.message));
    if (saved) state.shop = null;
  } finally {
    btnEl.disabled = false;
  }
}

// ---------------------------------------------------------------- captura do cupom
/** Reduz e fatia a foto: cupom comprido vira partes de ~1000×1500 (com sobreposição) para a IA ler as letras pequenas. */
async function slicePhoto(file) {
  const bmp = await createImageBitmap(file);
  const W = Math.min(1100, bmp.width);
  const k = W / bmp.width;
  const fullH = Math.round(bmp.height * k);
  const sliceH = Math.round(W * 1.5);
  const overlap = Math.round(sliceH * 0.08);
  const blobs = [];
  for (let y = 0; y < fullH; y += sliceH - overlap) {
    const hgt = Math.min(sliceH, fullH - y);
    if (blobs.length && hgt < overlap * 1.5) break;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = hgt;
    c.getContext('2d').drawImage(bmp, 0, y / k, bmp.width, hgt / k, 0, 0, W, hgt);
    blobs.push(await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85)));
    if (y + hgt >= fullH) break;
  }
  return { blobs, bmp };
}

/** Lê o QR Code (chave de acesso) quando o navegador tem BarcodeDetector (Chrome no Android, Safari recente). */
async function readQr(bmp) {
  try {
    if (!('BarcodeDetector' in window)) return null;
    const codes = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(bmp);
    for (const c of codes) {
      const key = S.findAccessKey(c.rawValue);
      if (key) return key;
    }
  } catch { /* sem suporte */ }
  return null;
}

function captureReceipt(mode) {
  if (mode === 'manual') return reviewReceipt({ store: { name: '' }, date: localToday(), total_cents: 0, items: [], source: 'manual' });
  const fileIn = h('input', {
    type: 'file', class: 'file-input', multiple: mode === 'photo',
    accept: mode === 'xml' ? '.xml,text/xml,application/xml' : 'image/*', ...(mode === 'photo' ? { capture: 'environment' } : {}),
  });
  fileIn.id = `f-${Math.random().toString(36).slice(2, 9)}`;
  const files = [];
  const thumbs = h('div', { class: 'thumbs' });
  const readBtn = h('button', { type: 'button', class: 'btn', disabled: true }, icon('sparkles', 18), h('span', {}, 'Ler cupom'));
  const addLabel = h('label', { class: 'dropzone', for: fileIn.id }, icon(mode === 'xml' ? 'upload' : 'camera', 22),
    h('span', { class: 'dz-text' }, mode === 'xml' ? 'Escolher o arquivo XML da nota' : 'Tirar foto ou escolher da galeria'));
  const status = h('p', { class: 'voice-status', 'aria-live': 'polite' });
  const body = h('div', { class: 'stack' },
    mode === 'photo' ? h('p', { class: 'hint' }, 'Dica: cupom em cima de uma superfície escura, bem iluminado, sem dobras. Cupom muito comprido? Tire 2 ou 3 fotos em sequência (de cima para baixo) e adicione todas.') : h('p', { class: 'hint' }, 'O XML vem no e-mail do mercado ou no portal da SEFAZ (consulta da NFC-e pela chave de acesso). É a forma mais precisa: não precisa de IA.'),
    addLabel, fileIn, thumbs, status, mode === 'photo' ? h('div', { class: 'dialog-actions' }, readBtn) : null);
  const d = openDialog({ title: mode === 'xml' ? 'Importar XML da nota' : 'Fotografar cupom', body, wide: true });

  fileIn.addEventListener('change', async () => {
    const chosen = [...fileIn.files];
    fileIn.value = '';
    if (mode === 'xml') {
      const f = chosen[0];
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) return toast('Arquivo grande demais para uma nota.', true);
      try {
        const nota = S.parseNfeXml(await f.text());
        d.close();
        reviewReceipt({ ...nota, source: 'xml' });
      } catch (e) {
        toast(e.message, true);
      }
      return;
    }
    for (const f of chosen) {
      if (!/^image\//.test(f.type)) {
        toast('Escolha uma imagem.', true);
        continue;
      }
      files.push(f);
      const url = URL.createObjectURL(f);
      thumbs.append(h('img', { src: url, alt: `Parte ${files.length}`, class: 'thumb', onload: () => URL.revokeObjectURL(url) }));
    }
    readBtn.disabled = !files.length;
    addLabel.querySelector('.dz-text').textContent = files.length ? 'Adicionar outra parte do cupom' : 'Tirar foto ou escolher da galeria';
  });

  readBtn.addEventListener('click', async () => {
    readBtn.disabled = true;
    const uploaded = [];
    try {
      status.textContent = 'Preparando a foto…';
      let accessKey = null;
      const blobs = [];
      for (const f of files) {
        const out = await slicePhoto(f);
        accessKey ??= await readQr(out.bmp);
        blobs.push(...out.blobs);
      }
      if (blobs.length > MAX_PARTS) throw new Error(`Foto(s) grandes demais: deu ${blobs.length} partes, o máximo é ${MAX_PARTS}. Tire menos fotos ou mais de perto.`);
      status.textContent = 'Enviando…';
      for (const b of blobs) {
        const path = `${state.houseId}/cupons/${crypto.randomUUID()}.jpg`;
        await q(sb.storage.from('receipts').upload(path, b, { contentType: 'image/jpeg', upsert: false }));
        uploaded.push(path);
      }
      let data = { store: { name: '' }, date: localToday(), total_cents: 0, items: [] };
      if (state.d.ai) {
        status.replaceChildren(h('span', { class: 'spinner' }), ' A IA está lendo o cupom… (até 1 minuto)');
        try {
          data = await callAi({ action: 'receipt', houseId: state.houseId, paths: uploaded, today: localToday() });
        } catch (e) {
          toast(`${e.message} Preencha os itens à mão.`, true);
        }
      } else toast(isAdmin() ? 'A IA não está configurada (Assistente IA): preencha os itens à mão.' : 'A IA não está configurada nesta casa: preencha os itens à mão.', true);
      d.close();
      reviewReceipt({ ...data, access_key: data.access_key ?? accessKey, image_paths: uploaded, source: 'photo' });
    } catch (e) {
      if (uploaded.length) await sb.storage.from('receipts').remove(uploaded);
      status.textContent = '';
      toast(e.message, true);
      readBtn.disabled = false;
    }
  });
  if (mode === 'xml') setTimeout(() => fileIn.click(), 50);
}

// ---------------------------------------------------------------- revisão antes de salvar
function reviewReceipt(data) {
  const shop = state.shop;
  let saved = false;
  const images = data.image_paths ?? [];
  // produto sugerido: id vindo da IA/apelido, depois apelido local, EAN, nome
  const byAlias = new Map(shop.aliases.map((a) => [a.alias, a.product_id]));
  const byEan = new Map(shop.products.filter((p) => p.ean).map((p) => [p.ean, p.id]));
  const byName = new Map(shop.products.map((p) => [S.normName(p.name), p.id]));
  const rows = (data.items ?? []).map((it) => {
    const pid = (it.product_id && productById(it.product_id) ? it.product_id : null)
      ?? byAlias.get(S.normName(it.raw_name)) ?? (it.ean ? byEan.get(it.ean) : null) ?? byName.get(S.normName(it.name ?? it.raw_name)) ?? null;
    const p = pid ? productById(pid) : null;
    return { ...it, name: p?.name ?? it.name ?? titleCase(it.raw_name), unit: p?.unit ?? it.unit ?? 'un', known: !!p };
  });
  if (!rows.length) rows.push({ raw_name: '', name: '', unit: 'un', quantity_milli: 1000, unit_price_cents: 0, total_cents: 0, discount_cents: 0 });

  // mercado
  const stores = shop.stores;
  const hitStore = (data.store?.cnpj && stores.find((s) => s.cnpj === data.store.cnpj))
    ?? stores.find((s) => S.normName(s.name) === S.normName(data.store?.name)) ?? null;
  const storeSel = select('store', [...stores.map((s) => ({ value: s.id, label: s.address ? `${s.name} — ${s.address}` : s.name })), { value: '', label: '+ Novo mercado' }], hitStore?.id ?? (stores.length && !data.store?.name ? stores[0].id : ''));
  const storeNameIn = input('store_name', { maxlength: 80, value: hitStore ? '' : data.store?.name ?? '', placeholder: 'Nome do mercado' });
  const storeCnpj = input('cnpj', { maxlength: 18, inputmode: 'numeric', value: hitStore ? '' : data.store?.cnpj ?? '', placeholder: 'CNPJ (opcional)' });
  const storeAddr = input('address', { maxlength: 200, value: hitStore ? '' : data.store?.address ?? '', placeholder: 'Endereço/bairro (opcional)' });
  const newStore = h('div', { class: 'form-grid span-2 new-store' }, field('Nome do mercado', storeNameIn, { cls: 'span-2' }), field('CNPJ', storeCnpj), field('Endereço', storeAddr));
  const syncStore = () => { newStore.hidden = !!storeSel.value; };
  storeSel.addEventListener('change', syncStore);
  syncStore();

  const date = input('date', { type: 'date', required: true, value: data.date ?? localToday(), max: localToday() });
  const total = moneyInput('total', { value: data.total_cents ? centsToInput(data.total_cents) : '' });
  const dup = data.access_key && shop.receipts.some((r) => r.access_key === data.access_key);

  // itens
  const listId = `dl-prod-${Math.random().toString(36).slice(2, 8)}`;
  const datalist = h('datalist', { id: listId }, ...shop.products.map((p) => h('option', { value: p.name })));
  const itemsBox = h('div', { class: 'rcpt-items' });
  const sumInfo = h('p', { class: 'hint' });
  const recalc = () => {
    const sum = [...itemsBox.querySelectorAll('.ri')].reduce((s, el) => s + (parseMoney(el.querySelector('[name=total]').value) ?? 0), 0);
    const tot = parseMoney(total.querySelector('input').value) ?? 0;
    const diff = tot - sum;
    sumInfo.replaceChildren(`Soma dos itens: ${brl(sum)}`, tot && diff ? h('strong', { class: Math.abs(diff) > 1 ? 'neg' : '' }, ` · diferença de ${brl(Math.abs(diff))} para o total`) : '');
    if (!tot && sum) total.querySelector('input').placeholder = centsToInput(sum);
  };
  const addRow = (it) => {
    const name = input('name', { maxlength: 80, value: it.name ?? '', list: listId, autocomplete: 'off', placeholder: 'Produto', 'aria-label': 'Produto' });
    const unit = select('unit', S.UNITS.map((u) => ({ value: u, label: u })), it.unit ?? 'un');
    const qty = input('qty', { inputmode: 'decimal', value: it.quantity_milli ? String(it.quantity_milli / 1000).replace('.', ',') : '1', 'aria-label': 'Quantidade' });
    const unitPrice = input('unit_price', { inputmode: 'decimal', value: it.unit_price_cents ? centsToInput(it.unit_price_cents) : '', placeholder: '0,00', 'aria-label': 'Preço unitário' });
    const tot = input('total', { inputmode: 'decimal', value: it.total_cents ? centsToInput(it.total_cents) : '', placeholder: '0,00', 'aria-label': 'Total do item' });
    const badge = h('span', { class: 'ri-badge' });
    const paintBadge = () => {
      const known = byName.has(S.normName(name.value));
      badge.className = `ri-badge ${known ? 'known' : 'new'}`;
      badge.textContent = name.value.trim() ? (known ? 'conhecido' : 'novo') : '';
    };
    name.addEventListener('input', paintBadge);
    name.addEventListener('change', () => {
      const p = productById(byName.get(S.normName(name.value)));
      if (p) unit.value = p.unit;
    });
    const autoTotal = () => {
      const q1 = parseQty(qty.value);
      const u = parseMoney(unitPrice.value);
      if (q1 && u) tot.value = centsToInput(Math.round((u * q1) / 1000) - (it.discount_cents ?? 0));
      recalc();
    };
    qty.addEventListener('input', autoTotal);
    unitPrice.addEventListener('input', autoTotal);
    tot.addEventListener('input', recalc);
    const row = h('div', { class: 'ri' },
      h('div', { class: 'ri-name' }, name, it.raw_name ? h('small', { class: 'muted', title: it.raw_name }, it.raw_name) : null, badge),
      h('label', { class: 'ri-f' }, h('span', {}, 'Qtd.'), qty), h('label', { class: 'ri-f' }, h('span', {}, 'Un.'), unit),
      h('label', { class: 'ri-f' }, h('span', {}, 'Unitário'), unitPrice), h('label', { class: 'ri-f' }, h('span', {}, 'Total'), tot),
      h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Remover item', onclick: () => { row.remove(); recalc(); } }, icon('x', 15)));
    row.data = it;
    paintBadge();
    itemsBox.append(row);
  };
  rows.forEach(addRow);
  total.querySelector('input').addEventListener('input', recalc);
  recalc();

  // lançamento de saída junto
  const canTx = canEdit('lancamentos');
  const mercadoCat = state.d.categories.find((c) => c.type === 'expense' && !c.parent_id && S.normName(c.name) === 'mercado');
  const launch = h('input', { type: 'checkbox', checked: canTx });
  const acc = select('account', accountOptions(true), state.d.accounts.find((a) => !a.archived)?.id ?? '');
  const cat = categorySelect('category', 'expense', mercadoCat?.id ?? '');
  const who = select('resident', residentsOptions(true), isAdmin() ? '' : myResidentId());
  const txBox = h('div', { class: 'form-grid tx-sub' }, field('Conta', acc), field('Categoria', cat), field('De quem', who, { cls: 'span-2' }));
  const syncTx = () => { txBox.hidden = !launch.checked; };
  launch.addEventListener('change', syncTx);
  syncTx();

  const save = h('button', { type: 'button', class: 'btn' }, icon('check', 18), h('span', {}, 'Salvar cupom'));
  const body = h('div', { class: 'stack rcpt-review' },
    data.note ? h('p', { class: 'hint' }, icon('sparkles', 14), ' ', data.note) : null,
    dup ? h('div', { class: 'alert' }, icon('alert', 16), ' Este cupom (mesma chave de acesso) já foi lançado.') : null,
    images.length ? h('button', { type: 'button', class: 'chip', onclick: () => viewImages(images) }, icon('image', 14), ` Ver foto (${images.length} parte${images.length > 1 ? 's' : ''})`) : null,
    h('div', { class: 'form-grid' }, field('Mercado', storeSel, { cls: 'span-2' }), newStore, field('Data da compra', date), field('Total pago', total)),
    h('div', { class: 'row-between' }, h('h3', {}, 'Itens'), h('button', { type: 'button', class: 'btn ghost small', onclick: () => { addRow({ unit: 'un', quantity_milli: 1000 }); recalc(); } }, icon('plus', 16), h('span', {}, 'Item'))),
    h('p', { class: 'hint' }, 'Confira o nome de cada produto: use o mesmo nome (marca e tamanho) sempre, para o histórico de preço juntar certo. "novo" = vai criar um produto.'),
    itemsBox, datalist, sumInfo,
    canTx ? h('label', { class: 'check' }, launch, h('span', {}, 'Lançar também como saída em Lançamentos')) : null,
    canTx ? txBox : null,
    h('div', { class: 'dialog-actions' }, save));
  const dlg = openDialog({
    title: 'Conferir cupom', body, wide: true, cls: 'rcpt-dialog',
    onClose: () => {
      // Desistiu: apaga as fotos enviadas (o cupom não foi salvo).
      if (!saved && images.length) sb.storage.from('receipts').remove(images);
    },
  });

  save.addEventListener('click', async () => {
    const items = [];
    for (const [i, el] of [...itemsBox.querySelectorAll('.ri')].entries()) {
      const it = el.data;
      const nm = el.querySelector('[name=name]').value.trim();
      const qty = parseQty(el.querySelector('[name=qty]').value);
      const unitPrice = parseMoney(el.querySelector('[name=unit_price]').value);
      const tot = parseMoney(el.querySelector('[name=total]').value) ?? (qty && unitPrice ? Math.round((unitPrice * qty) / 1000) : null);
      if (!nm && !unitPrice && !tot) continue;   // linha vazia
      if (!nm || !qty || !unitPrice || !tot) return toast(`Item ${i + 1}: preencha produto, quantidade, preço unitário e total.`, true);
      const pid = byName.get(S.normName(nm));
      items.push({
        ...(pid ? { product_id: pid } : { product: { name: nm, unit: el.querySelector('[name=unit]').value, ean: it.ean ?? null } }),
        raw_name: (it.raw_name || nm).slice(0, 120), alias: S.normName(it.raw_name || nm), code: it.code ?? null, position: i + 1,
        quantity_milli: qty, unit_price_cents: unitPrice, discount_cents: it.discount_cents ?? 0, total_cents: tot,
      });
    }
    if (!items.length) return toast('Inclua pelo menos um item.', true);
    const totalCents = parseMoney(total.querySelector('input').value) ?? items.reduce((s, x) => s + x.total_cents, 0);
    const store = storeSel.value ? { id: storeSel.value } : { name: storeNameIn.value.trim(), cnpj: storeCnpj.value.replace(/\D/g, '') || null, address: storeAddr.value.trim() || null };
    if (!store.id && !store.name) return toast('Informe o mercado.', true);
    if (store.cnpj && store.cnpj.length !== 14) return toast('CNPJ precisa ter 14 números (ou deixe vazio).', true);
    const storeLabel = store.id ? stores.find((s) => s.id === store.id)?.name : store.name;
    const payload = {
      store, purchased_at: date.value, total_cents: totalCents, discount_cents: data.discount_cents ?? 0,
      access_key: data.access_key ?? null, image_paths: images, source: data.source ?? 'photo', items,
      transaction: canTx && launch.checked ? { account_id: acc.value || null, category_id: cat.value || null, resident_id: who.value || null, description: `Mercado · ${storeLabel}`.slice(0, 120) } : null,
    };
    const ok = await run(save, () => q(sb.rpc('save_shop_receipt', { p_house: state.houseId, p: payload })), `Cupom salvo: ${items.length} itens, ${brl(totalCents)}.`);
    if (ok) {
      saved = true;
      dlg.close();
      await refresh(!!payload.transaction);
    }
  });
}

const titleCase = (s) => String(s ?? '').toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()).slice(0, 80);
