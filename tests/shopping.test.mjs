import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normName, unitOf, accessKeyValid, findAccessKey, accessKeyParts, parseNfeXml,
  productStats, seasonIndex, storeIndex, recurringList, latestPrices, basketCompare, shopSummary,
} from '../js/shopping.js';

/** Monta uma chave válida a partir de 43 dígitos (calcula o DV módulo 11). */
function withDv(k43) {
  let sum = 0;
  let w = 2;
  for (let i = 42; i >= 0; i--) {
    sum += Number(k43[i]) * w;
    w = w === 9 ? 2 : w + 1;
  }
  const r = sum % 11;
  return k43 + (r < 2 ? 0 : 11 - r);
}
// UF 51 (MT), 2611, CNPJ 12345678000190, modelo 65, série 001, número 000001234, tpEmis 1, cNF 00001234
const KEY = withDv('5126111234567800019065001000001234100001234');

test('normaliza nomes e unidades', () => {
  assert.equal(normName('  Açúcar   UNIÃO 1kg '), 'acucar uniao 1kg');
  assert.equal(unitOf('KG'), 'kg');
  assert.equal(unitOf('LT'), 'l');
  assert.equal(unitOf('UND'), 'un');
  assert.equal(unitOf('???'), 'un');
});

test('chave de acesso: DV, busca no texto do QR e partes', () => {
  assert.equal(KEY.length, 44);
  assert.ok(accessKeyValid(KEY));
  const wrong = KEY.slice(0, 43) + ((Number(KEY[43]) + 1) % 10);
  assert.equal(accessKeyValid(wrong), false);
  assert.equal(findAccessKey(`https://www.sefaz.mt.gov.br/nfce/consultanfce?p=${KEY}|2|1|1|ABCDEF`), KEY);
  const spaced = KEY.match(/.{1,4}/g).join(' ');
  assert.equal(findAccessKey(`Chave de acesso: ${spaced}`), KEY);
  assert.equal(findAccessKey('nada aqui 123'), null);
  assert.deepEqual(accessKeyParts(KEY), { uf: '51', month: '2026-11', cnpj: '12345678000190', model: '65' });
});

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${KEY}" versao="4.00">
<ide><dhEmi>2026-11-20T18:42:10-04:00</dhEmi></ide>
<emit><CNPJ>12345678000190</CNPJ><xNome>SUPERMERCADO EXEMPLO LTDA</xNome><xFant>Mercado Exemplo</xFant>
<enderEmit><xLgr>Av. Brasil</xLgr><nro>100</nro><xBairro>Centro</xBairro><xMun>Cuiabá</xMun><UF>MT</UF></enderEmit></emit>
<det nItem="1"><prod><cProd>123</cProd><cEAN>7891234567895</cEAN><xProd>ARROZ T.JOAO 5KG</xProd><uCom>UN</uCom><qCom>2.0000</qCom><vUnCom>25.90</vUnCom><vProd>51.80</vProd><vDesc>1.80</vDesc></prod></det>
<det nItem="2"><prod><cProd>987</cProd><cEAN>SEM GTIN</cEAN><xProd>BANANA PRATA KG &amp; CIA</xProd><uCom>KG</uCom><qCom>1.250</qCom><vUnCom>6.99</vUnCom><vProd>8.74</vProd></prod></det>
<total><ICMSTot><vDesc>1.80</vDesc><vNF>58.74</vNF></ICMSTot></total>
</infNFe></NFe></nfeProc>`;

test('lê o XML da NFC-e', () => {
  const n = parseNfeXml(XML);
  assert.equal(n.access_key, KEY);
  assert.equal(n.date, '2026-11-20');
  assert.deepEqual(n.store, { name: 'Mercado Exemplo', cnpj: '12345678000190', address: 'Av. Brasil, 100, Centro, Cuiabá/MT' });
  assert.equal(n.total_cents, 5874);
  assert.equal(n.discount_cents, 180);
  assert.equal(n.items.length, 2);
  assert.deepEqual(n.items[0], { position: 1, raw_name: 'ARROZ T.JOAO 5KG', code: '7891234567895', ean: '7891234567895', unit: 'un', quantity_milli: 2000, unit_price_cents: 2590, discount_cents: 180, total_cents: 5000 });
  assert.equal(n.items[1].raw_name, 'BANANA PRATA KG & CIA');
  assert.equal(n.items[1].unit, 'kg');
  assert.equal(n.items[1].quantity_milli, 1250);
  assert.equal(n.items[1].ean, null);
  assert.throws(() => parseNfeXml('<html>oi</html>'), /nota fiscal/);
});

// Histórico: arroz e café todo mês; picanha uma vez; dois mercados.
const shop = {
  stores: [{ id: 'A', name: 'Atacadão' }, { id: 'B', name: 'Big Lar' }],
  products: [
    { id: 'arroz', name: 'Arroz 5kg', unit: 'un' },
    { id: 'cafe', name: 'Café 500g', unit: 'un' },
    { id: 'picanha', name: 'Picanha', unit: 'kg' },
    { id: 'sabao', name: 'Sabão em pó', unit: 'un', list_mode: 'always' },
    { id: 'refri', name: 'Refrigerante', unit: 'un', list_mode: 'never' },
  ],
  receipts: [
    { id: 'r1', store_id: 'A', purchased_at: '2026-01-10', total_cents: 6000 },
    { id: 'r2', store_id: 'B', purchased_at: '2026-02-12', total_cents: 7000 },
    { id: 'r3', store_id: 'A', purchased_at: '2026-03-08', total_cents: 9000 },
    { id: 'r4', store_id: 'B', purchased_at: '2026-03-20', total_cents: 3000 },
  ],
  items: [
    { receipt_id: 'r1', product_id: 'arroz', quantity_milli: 1000, unit_price_cents: 2500, total_cents: 2500 },
    { receipt_id: 'r1', product_id: 'cafe', quantity_milli: 2000, unit_price_cents: 1500, total_cents: 3000 },
    { receipt_id: 'r1', product_id: 'refri', quantity_milli: 1000, unit_price_cents: 500, total_cents: 500 },
    { receipt_id: 'r2', product_id: 'arroz', quantity_milli: 1000, unit_price_cents: 2900, total_cents: 2900 },
    { receipt_id: 'r2', product_id: 'cafe', quantity_milli: 2000, unit_price_cents: 1700, total_cents: 3400 },
    { receipt_id: 'r2', product_id: 'refri', quantity_milli: 1000, unit_price_cents: 700, total_cents: 700 },
    { receipt_id: 'r3', product_id: 'arroz', quantity_milli: 2000, unit_price_cents: 2400, total_cents: 4800 },
    { receipt_id: 'r3', product_id: 'picanha', quantity_milli: 1200, unit_price_cents: 3500, total_cents: 4200 },
    { receipt_id: 'r4', product_id: 'cafe', quantity_milli: 2000, unit_price_cents: 1500, total_cents: 3000 },
  ],
  quotes: [
    { product_id: 'arroz', store_id: null, store_name: 'Mercado Novo', price_cents: 2200, observed_on: '2026-03-25', source: 'web', url: 'https://ex.com/a' },
    { product_id: 'cafe', store_id: 'B', store_name: 'Big Lar', price_cents: 1400, observed_on: '2026-03-26', source: 'web', url: null },
    { product_id: 'arroz', store_id: null, store_name: 'Velho', price_cents: 100, observed_on: '2025-01-01', source: 'web', url: null },
  ],
};

test('estatísticas por produto: mais comprados, média ponderada, mínimo, por mercado e por mês', () => {
  const st = productStats(shop);
  assert.deepEqual(st.map((s) => s.product.id), ['arroz', 'cafe', 'refri', 'picanha']);
  const arroz = st[0];
  assert.equal(arroz.months, 3);
  assert.equal(arroz.purchases, 3);
  assert.equal(arroz.qty, 4000);
  assert.equal(arroz.spent, 10200);
  assert.equal(arroz.avg, 2550);                      // (2500 + 2900 + 2400*2) / 4
  assert.deepEqual(arroz.min, { price: 2400, date: '2026-03-08', store_id: 'A' });
  assert.deepEqual(arroz.last, { price: 2400, date: '2026-03-08', store_id: 'A' });
  assert.deepEqual(arroz.byStore.map((b) => [b.store_id, b.avg]), [['A', 2433], ['B', 2900]]);
  assert.equal(arroz.byMonthOfYear[0], 2500);
  assert.equal(arroz.byMonthOfYear[2], 2400);
  assert.equal(arroz.byMonthOfYear[5], null);
  const fev = productStats(shop, { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(fev.map((s) => s.product.id), ['cafe', 'arroz', 'refri'], 'empate em meses/compras: maior gasto primeiro');
});

test('sazonalidade e ranking de mercados', () => {
  const st = productStats(shop);
  const season = seasonIndex(st);
  assert.equal(season.length, 12);
  assert.ok(season[1].index > 1, 'fevereiro mais caro');
  assert.ok(season[2].index < 1, 'março mais barato');
  assert.equal(season[5].index, null);
  const rank = storeIndex(st);
  assert.equal(rank[0].store_id, 'A');
  assert.ok(rank[0].index < 1 && rank[1].index > 1);
  assert.equal(rank[0].cheapest, 3);                  // arroz, café e refri mais baratos no A
});

test('lista do mês: recorrentes, sempre e nunca', () => {
  const l = recurringList(shop, { month: '2026-03', months: 3 });
  assert.equal(l.activeMonths, 3);
  assert.deepEqual(l.items.map((i) => i.product.id), ['arroz', 'cafe', 'sabao']);
  const cafe = l.items.find((i) => i.product.id === 'cafe');
  assert.equal(cafe.qty, 2000);                       // 6 unidades em 3 meses = 2 por mês
  assert.equal(l.items.find((i) => i.product.id === 'sabao').always, true);
  assert.equal(l.items.find((i) => i.product.id === 'sabao').qty, 1000);
});

test('preços mais recentes e comparação da cesta', () => {
  const prices = latestPrices(shop, { today: '2026-03-31', maxAgeDays: 120 });
  const arroz = prices.get('arroz');
  assert.equal(arroz.get('s:A').price, 2400);
  assert.equal(arroz.get('n:mercado novo').price, 2200);
  assert.equal(arroz.has('n:velho'), false, 'cotação velha ignorada');
  assert.equal(prices.get('cafe').get('s:B').price, 1400, 'cotação mais nova vence o cupom');

  const st = productStats(shop);
  const list = [{ product: shop.products[0], qty: 1000 }, { product: shop.products[1], qty: 2000 }, { product: shop.products[3], qty: 1000 }];
  const cmp = basketCompare(list, prices, st);
  assert.equal(cmp.best.total, 2200 + 2800);          // arroz no Mercado Novo, café no Big Lar
  assert.equal(cmp.best.storeCount, 2);
  assert.deepEqual(cmp.best.missing.map((p) => p.id), ['sabao']);
  assert.equal(cmp.usual, 2550 + Math.round((1567 * 2000) / 1000));
  const b = cmp.stores.find((s) => s.key === 's:B');
  assert.equal(b.covered, 2);
  assert.equal(b.total, 2900 + 2800);
  assert.deepEqual(cmp.stores.find((s) => s.key === 'n:mercado novo').missing.map((p) => p.id), ['cafe', 'sabao']);
});

test('resumo do período', () => {
  const s = shopSummary(shop, { from: '2026-03-01', to: '2026-03-31' });
  assert.equal(s.receipts, 2);
  assert.equal(s.total, 12000);
  assert.equal(s.ticket, 6000);
  assert.deepEqual(s.byStore, [{ store_id: 'A', amount: 9000 }, { store_id: 'B', amount: 3000 }]);
});

test('sazonalidade não confunde época com mercado caro', () => {
  // Mesmo preço o ano todo em cada mercado; em junho só comprou no mercado caro.
  const s2 = {
    stores: [{ id: 'A' }, { id: 'B' }], products: [{ id: 'x', name: 'X', unit: 'un' }],
    receipts: [
      { id: '1', store_id: 'A', purchased_at: '2026-01-05' }, { id: '2', store_id: 'B', purchased_at: '2026-01-06' },
      { id: '3', store_id: 'B', purchased_at: '2026-06-05' }, { id: '4', store_id: 'A', purchased_at: '2026-03-05' },
    ],
    items: [
      { receipt_id: '1', product_id: 'x', quantity_milli: 1000, unit_price_cents: 1000, total_cents: 1000 },
      { receipt_id: '2', product_id: 'x', quantity_milli: 1000, unit_price_cents: 1500, total_cents: 1500 },
      { receipt_id: '3', product_id: 'x', quantity_milli: 1000, unit_price_cents: 1500, total_cents: 1500 },
      { receipt_id: '4', product_id: 'x', quantity_milli: 1000, unit_price_cents: 1000, total_cents: 1000 },
    ],
  };
  const season = seasonIndex(productStats(s2));
  assert.equal(season[5].index, 1, 'junho não é "caro": foi o mercado');
  assert.equal(season[0].index, 1);
});

test('razão social sem tipo de empresa', async () => {
  const { cleanCompany } = await import('../js/shopping.js');
  assert.equal(cleanCompany('NOVO MERCADO LTDA'), 'NOVO MERCADO');
  assert.equal(cleanCompany('SUPERMERCADO X LTDA - EPP'), 'SUPERMERCADO X');
  assert.equal(cleanCompany('COMERCIAL MELO S/A'), 'COMERCIAL MELO');
  assert.equal(cleanCompany('MEGA ATACADO'), 'MEGA ATACADO');
});
