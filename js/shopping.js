// Compras de mercado (puro, testado): cupom fiscal (NFC-e), estatísticas de preço por produto,
// lista do mês (o que se repete), sazonalidade, ranking de mercados e comparação da cesta.
// Dinheiro em centavos; quantidade em milésimos (1,5 kg = 1500).

export const UNITS = ['un', 'kg', 'g', 'l', 'ml', 'pct', 'cx', 'dz'];
const UNIT_MAP = { UN: 'un', UND: 'un', UNID: 'un', PC: 'un', PECA: 'un', KG: 'kg', G: 'g', GR: 'g', L: 'l', LT: 'l', ML: 'ml', PCT: 'pct', PT: 'pct', PAC: 'pct', CX: 'cx', DZ: 'dz' };
export const unitOf = (u) => UNIT_MAP[String(u ?? '').toUpperCase().replace(/[^A-Z]/g, '')] ?? (UNITS.includes(String(u).toLowerCase()) ? String(u).toLowerCase() : 'un');

/** Nome normalizado para comparar ("Açúcar  UNIÃO 1kg" -> "acucar uniao 1kg"). Igual ao da Edge Function. */
export const normName = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------- chave de acesso (44 dígitos)
/** Confere o dígito verificador (módulo 11) da chave da NF-e/NFC-e. */
export function accessKeyValid(key) {
  if (!/^\d{44}$/.test(key ?? '')) return false;
  let sum = 0;
  let w = 2;
  for (let i = 42; i >= 0; i--) {
    sum += Number(key[i]) * w;
    w = w === 9 ? 2 : w + 1;
  }
  const r = sum % 11;
  const dv = r < 2 ? 0 : 11 - r;
  return dv === Number(key[43]);
}

/** Acha a chave num texto (URL do QR Code, texto impresso com espaços...). */
export function findAccessKey(text) {
  const digits = String(text ?? '').replace(/(\d)[\s.]+(?=\d)/g, '$1');
  for (const m of digits.matchAll(/\d{44}/g)) if (accessKeyValid(m[0])) return m[0];
  return null;
}

/** Partes da chave: UF, ano/mês de emissão, CNPJ do emitente, modelo (65 = NFC-e, 55 = NF-e). */
export function accessKeyParts(key) {
  if (!accessKeyValid(key)) return null;
  return { uf: key.slice(0, 2), month: `20${key.slice(2, 4)}-${key.slice(4, 6)}`, cnpj: key.slice(6, 20), model: key.slice(20, 22) };
}

// ---------------------------------------------------------------- XML da NFC-e / NF-e
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
  : ENT[e] ?? m));
const blocks = (xml, tag) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'g'))].map((m) => m[1]);
const tagText = (xml, tag) => {
  const b = blocks(xml ?? '', tag)[0];
  return b === undefined ? null : decode(b.trim());
};
/** "SUPERMERCADO X LTDA - EPP" -> "SUPERMERCADO X" (razão social sem o tipo de empresa). */
export const cleanCompany = (s) => String(s ?? '').replace(/[\s,.-]+(LTDA|ME|EPP|EIRELI|S\/?A|MEI)\.?(?=[\s,.-]|$)/gi, '').replace(/[\s,.-]+$/, '').trim();
const cents = (v) =>(v == null || v === '' ? 0 : Math.round(Number(v) * 100));
const milli = (v) => Math.round(Number(v) * 1000);

/**
 * Lê o XML da nota (o arquivo que a SEFAZ ou o e-mail do mercado fornecem).
 * Devolve { store, date, total_cents, discount_cents, access_key, items[] } ou lança erro.
 */
export function parseNfeXml(xml) {
  const text = String(xml ?? '');
  const inf = /<(?:\w+:)?infNFe\b[^>]*\bId="(?:NFe)?(\d{44})"/.exec(text);
  const emit = blocks(text, 'emit')[0];
  const dets = [...text.matchAll(/<(?:\w+:)?det\b[^>]*>([\s\S]*?)<\/(?:\w+:)?det>/g)].map((m) => m[1]);
  if (!emit || !dets.length) throw new Error('Não parece o XML de uma nota fiscal (NFC-e/NF-e).');
  const ender = blocks(emit, 'enderEmit')[0] ?? '';
  const address = [tagText(ender, 'xLgr'), tagText(ender, 'nro'), tagText(ender, 'xBairro'), [tagText(ender, 'xMun'), tagText(ender, 'UF')].filter(Boolean).join('/')]
    .filter(Boolean).join(', ');
  const ide = blocks(text, 'ide')[0] ?? '';
  const date = (tagText(ide, 'dhEmi') ?? tagText(ide, 'dEmi') ?? '').slice(0, 10);
  const items = dets.map((d, i) => {
    const prod = blocks(d, 'prod')[0] ?? d;
    const ean = tagText(prod, 'cEAN');
    const gross = cents(tagText(prod, 'vProd'));
    const discount = cents(tagText(prod, 'vDesc'));
    return {
      position: i + 1,
      raw_name: (tagText(prod, 'xProd') ?? 'Item').slice(0, 120),
      code: /^\d{8,14}$/.test(ean ?? '') ? ean : (tagText(prod, 'cProd') ?? '').slice(0, 20) || null,
      ean: /^\d{8,14}$/.test(ean ?? '') ? ean : null,
      unit: unitOf(tagText(prod, 'uCom')),
      quantity_milli: milli(tagText(prod, 'qCom') ?? 1),
      unit_price_cents: cents(tagText(prod, 'vUnCom')),
      discount_cents: discount,
      total_cents: gross - discount,
    };
  }).filter((it) => it.quantity_milli > 0 && it.unit_price_cents > 0 && it.total_cents > 0);
  const tot = blocks(text, 'ICMSTot')[0] ?? '';
  const cnpj = tagText(emit, 'CNPJ');
  return {
    store: { name: (tagText(emit, 'xFant') || cleanCompany(tagText(emit, 'xNome')) || 'Mercado').slice(0, 80), cnpj: /^\d{14}$/.test(cnpj ?? '') ? cnpj : null, address: address.slice(0, 200) || null },
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    total_cents: cents(tagText(tot, 'vNF')) || items.reduce((s, it) => s + it.total_cents, 0),
    discount_cents: cents(tagText(tot, 'vDesc')),
    access_key: inf && accessKeyValid(inf[1]) ? inf[1] : null,
    items,
  };
}

// ---------------------------------------------------------------- estatísticas
const monthOf = (d) => String(d).slice(0, 7);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const addMonth = (m, n) => {
  const [y, mo] = m.split('-').map(Number);
  const i = y * 12 + mo - 1 + n;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};

/** Junta itens com data e mercado do cupom. */
export function purchaseRows(shop) {
  const rec = new Map(shop.receipts.map((r) => [r.id, r]));
  return shop.items.flatMap((it) => {
    const r = rec.get(it.receipt_id);
    if (!r) return [];
    return [{ ...it, date: r.purchased_at, month: monthOf(r.purchased_at), store_id: r.store_id, qty: Number(it.quantity_milli), unit: Number(it.unit_price_cents), total: Number(it.total_cents) }];
  });
}

/** Média de preço unitário ponderada pela quantidade. */
const wavg = (rows) => {
  const q = rows.reduce((s, r) => s + r.qty, 0);
  return q ? Math.round(rows.reduce((s, r) => s + r.unit * r.qty, 0) / q) : null;
};

/**
 * Uma linha por produto: quantas vezes/meses comprou, total gasto, preço médio, mínimo, máximo, último,
 * média por mercado e por mês do ano. Ordenado do mais comprado para o menos.
 */
export function productStats(shop, { from = null, to = null } = {}) {
  const rows = purchaseRows(shop).filter((r) => (!from || r.date >= from) && (!to || r.date <= to));
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.product_id)) by.set(r.product_id, []);
    by.get(r.product_id).push(r);
  }
  const products = new Map(shop.products.map((p) => [p.id, p]));
  const out = [];
  for (const [pid, list] of by) {
    const p = products.get(pid);
    if (!p) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const pick = (r) => ({ price: r.unit, date: r.date, store_id: r.store_id });
    const min = list.reduce((m, r) => (r.unit < m.unit ? r : m));
    const max = list.reduce((m, r) => (r.unit > m.unit ? r : m));
    const stores = new Map();
    for (const r of list) {
      if (!stores.has(r.store_id)) stores.set(r.store_id, []);
      stores.get(r.store_id).push(r);
    }
    const byStore = [...stores].map(([store_id, l]) => ({ store_id, avg: wavg(l), count: l.length, last: pick(l[l.length - 1]) }))
      .sort((a, b) => a.avg - b.avg);
    const byMonthOfYear = Array.from({ length: 12 }, (_, i) => {
      const l = list.filter((r) => Number(r.date.slice(5, 7)) === i + 1);
      return l.length ? wavg(l) : null;
    });
    // Mesmo índice, mas tirando o efeito do mercado: cada preço é comparado com a média do produto NAQUELE
    // mercado. Assim, um mês em que você comprou no mercado caro não parece "época cara".
    const storeAvg = new Map(byStore.map((b) => [b.store_id, b.avg]));
    const monthRatio = Array.from({ length: 12 }, (_, i) => {
      const l = list.filter((r) => Number(r.date.slice(5, 7)) === i + 1);
      const q = l.reduce((s, r) => s + r.qty, 0);
      return q ? l.reduce((s, r) => s + (r.unit / storeAvg.get(r.store_id)) * r.qty, 0) / q : null;
    });
    const months = new Set(list.map((r) => r.month));
    out.push({
      product: p, purchases: list.length, receipts: new Set(list.map((r) => r.receipt_id)).size, months: months.size,
      qty: list.reduce((s, r) => s + r.qty, 0), spent: list.reduce((s, r) => s + r.total, 0),
      avg: wavg(list), min: pick(min), max: pick(max), last: pick(list[list.length - 1]), first: list[0].date,
      byStore, byMonthOfYear, monthRatio, history: list.map(pick),
    });
  }
  return out.sort((a, b) => b.months - a.months || b.purchases - a.purchases || b.spent - a.spent || a.product.name.localeCompare(b.product.name, 'pt-BR'));
}

/**
 * Índice de preço por mês do ano (1 = na média). Para cada produto, compara o preço daquele mês com a média
 * do produto no mesmo mercado (tira o efeito de onde você comprou); depois tira a média entre produtos.
 * Só conta produtos comprados em 2+ meses do ano diferentes.
 */
export function seasonIndex(stats) {
  const acc = Array.from({ length: 12 }, () => ({ sum: 0, n: 0 }));
  for (const s of stats) {
    const ratios = s.monthRatio ?? s.byMonthOfYear.map((v) => (v == null || !s.avg ? null : v / s.avg));
    if (ratios.filter((v) => v != null).length < 2) continue;
    ratios.forEach((v, i) => {
      if (v == null) return;
      acc[i].sum += v;
      acc[i].n++;
    });
  }
  return acc.map((a, i) => ({ month: i + 1, index: a.n ? a.sum / a.n : null, products: a.n }));
}

/**
 * Ranking de mercados: em média, quanto o preço de cada mercado fica acima/abaixo da média de cada produto
 * (só produtos comprados em 2+ mercados). index < 1 = mais barato.
 */
export function storeIndex(stats) {
  const acc = new Map();
  for (const s of stats) {
    if (s.byStore.length < 2 || !s.avg) continue;
    for (const b of s.byStore) {
      const a = acc.get(b.store_id) ?? { store_id: b.store_id, sum: 0, n: 0, cheapest: 0 };
      a.sum += b.avg / s.avg;
      a.n++;
      if (b === s.byStore[0]) a.cheapest++;
      acc.set(b.store_id, a);
    }
  }
  return [...acc.values()].map((a) => ({ store_id: a.store_id, index: a.sum / a.n, products: a.n, cheapest: a.cheapest }))
    .sort((a, b) => a.index - b.index);
}

/**
 * Lista do mês: produtos que se repetem. Olha os últimos `months` meses até `month` (inclusive) e
 * entra quem foi comprado em pelo menos `minShare` dos meses em que houve compra (e em 2+ meses).
 * list_mode do produto: 'always' entra sempre, 'never' nunca. Quantidade sugerida = média por mês com compra.
 */
export function recurringList(shop, { month, months = 6, minShare = 0.5 } = {}) {
  const start = addMonth(month, -(months - 1));
  const rows = purchaseRows(shop).filter((r) => r.month >= start && r.month <= month);
  const activeMonths = new Set(rows.map((r) => r.month)).size;
  const by = new Map();
  for (const r of rows) {
    const e = by.get(r.product_id) ?? { months: new Set(), qty: 0, spent: 0 };
    e.months.add(r.month);
    e.qty += r.qty;
    e.spent += r.total;
    by.set(r.product_id, e);
  }
  const out = [];
  for (const p of shop.products) {
    const e = by.get(p.id);
    const mode = p.list_mode ?? 'auto';
    if (mode === 'never') continue;
    const n = e?.months.size ?? 0;
    const share = activeMonths ? n / activeMonths : 0;
    const auto = n >= 2 && share >= minShare;
    if (mode !== 'always' && !auto) continue;
    out.push({
      product: p, months: n, share, always: mode === 'always',
      qty: e && n ? Math.max(1, Math.round(e.qty / n)) : 1000,
      spentPerMonth: e && n ? Math.round(e.spent / n) : 0,
    });
  }
  return { activeMonths, items: out.sort((a, b) => b.share - a.share || a.product.name.localeCompare(b.product.name, 'pt-BR')) };
}

/** Chave de mercado: id cadastrado ou o nome normalizado (cotações de mercados que você nunca comprou). */
export const storeKey = (storeId, name) => (storeId ? `s:${storeId}` : `n:${normName(name)}`);

/**
 * Preço mais recente conhecido de cada produto em cada mercado, juntando o que você pagou (cupons)
 * e as cotações (pesquisa na web ou digitadas). Ignora o que for mais velho que maxAgeDays.
 * Devolve Map(productId -> Map(storeKey -> { price, date, source, url, name, store_id })).
 */
export function latestPrices(shop, { today, maxAgeDays = 90 } = {}) {
  const out = new Map();
  const storeName = new Map(shop.stores.map((s) => [s.id, s.name]));
  const put = (pid, key, v) => {
    if (today && daysBetween(v.date, today) > maxAgeDays) return;
    if (!out.has(pid)) out.set(pid, new Map());
    const m = out.get(pid);
    const cur = m.get(key);
    if (!cur || v.date > cur.date || (v.date === cur.date && v.source === 'cupom')) m.set(key, v);
  };
  for (const r of purchaseRows(shop)) {
    put(r.product_id, storeKey(r.store_id), { price: r.unit, date: r.date, source: 'cupom', url: null, name: storeName.get(r.store_id) ?? 'Mercado', store_id: r.store_id });
  }
  for (const q of shop.quotes ?? []) {
    put(q.product_id, storeKey(q.store_id, q.store_name), { price: Number(q.price_cents), date: q.observed_on, source: q.source, url: q.url, name: q.store_id ? storeName.get(q.store_id) ?? q.store_name : q.store_name, store_id: q.store_id });
  }
  return out;
}

/**
 * Compara a cesta (lista do mês) entre mercados com os preços mais recentes.
 * list: [{ product, qty }] (qty em milésimos). Devolve:
 *  stores: [{ key, name, total, covered, missing[] }] do mais completo/barato para o pior;
 *  best:   melhor combinação (cada produto onde está mais barato) com total e onde comprar;
 *  usual:  quanto a cesta custaria pelo seu preço médio pago.
 */
export function basketCompare(list, prices, stats = []) {
  const avg = new Map(stats.map((s) => [s.product.id, s.avg]));
  const cost = (price, qty) => Math.round((price * qty) / 1000);
  const stores = new Map();
  const best = { total: 0, items: [], missing: [] };
  let usual = 0;
  for (const it of list) {
    const pm = prices.get(it.product.id);
    if (avg.get(it.product.id)) usual += cost(avg.get(it.product.id), it.qty);
    if (!pm?.size) {
      best.missing.push(it.product);
      continue;
    }
    let cheapest = null;
    for (const [key, v] of pm) {
      const s = stores.get(key) ?? { key, name: v.name, store_id: v.store_id, total: 0, covered: 0, items: [] };
      s.total += cost(v.price, it.qty);
      s.covered++;
      s.items.push({ product: it.product, price: v.price, date: v.date, source: v.source });
      stores.set(key, s);
      if (!cheapest || v.price < cheapest.price) cheapest = { ...v, key };
    }
    best.total += cost(cheapest.price, it.qty);
    best.items.push({ product: it.product, qty: it.qty, ...cheapest, cost: cost(cheapest.price, it.qty) });
  }
  const all = [...stores.values()].map((s) => ({ ...s, missing: list.filter((it) => !s.items.some((x) => x.product.id === it.product.id)).map((it) => it.product) }))
    .sort((a, b) => b.covered - a.covered || a.total - b.total);
  const bestStores = new Set(best.items.map((i) => i.key));
  return { stores: all, best: { ...best, storeCount: bestStores.size }, usual };
}

/** Resumo do período: total em cupons, nº de compras, ticket médio, gasto por mercado. */
export function shopSummary(shop, { from = null, to = null } = {}) {
  const recs = shop.receipts.filter((r) => (!from || r.purchased_at >= from) && (!to || r.purchased_at <= to));
  const total = recs.reduce((s, r) => s + Number(r.total_cents), 0);
  const byStore = new Map();
  for (const r of recs) byStore.set(r.store_id, (byStore.get(r.store_id) ?? 0) + Number(r.total_cents));
  return {
    receipts: recs.length, total, ticket: recs.length ? Math.round(total / recs.length) : 0,
    byStore: [...byStore].map(([store_id, amount]) => ({ store_id, amount })).sort((a, b) => b.amount - a.amount),
  };
}
