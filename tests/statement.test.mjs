import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeBytes, parseAmount, parseDate, parseOfx, parseCsv, parseStatement, descKey, tidyDescription,
  looksLikeTransfer, buildSuggester, reconcile,
} from '../js/statement.js';

test('valores em vários formatos', () => {
  assert.equal(parseAmount('-52.90'), -5290);
  assert.equal(parseAmount('-52,90'), -5290);
  assert.equal(parseAmount('1.234,56'), 123456);
  assert.equal(parseAmount('1,234.56'), 123456);
  assert.equal(parseAmount('R$ -1.234,56'), -123456);
  assert.equal(parseAmount('52,90 D'), -5290);
  assert.equal(parseAmount('52,90 C'), 5290);
  assert.equal(parseAmount('(10,00)'), -1000);
  assert.equal(parseAmount('1.500'), 150000);
  assert.equal(parseAmount('3000'), 300000);
  assert.equal(parseAmount('12.5'), 1250);
  assert.equal(parseAmount('abc'), null);
  assert.equal(parseAmount(''), null);
});

test('datas em vários formatos', () => {
  assert.equal(parseDate('20261120120000[-3:BRT]'), '2026-11-20');
  assert.equal(parseDate('20261120'), '2026-11-20');
  assert.equal(parseDate('20/11/2026'), '2026-11-20');
  assert.equal(parseDate('20/11/26'), '2026-11-20');
  assert.equal(parseDate('2026-11-20'), '2026-11-20');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('Saldo'), null);
});

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261124</DTSERVER><LANGUAGE>POR</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STMTRS><CURDEF>BRL
<BANKACCTFROM><BANKID>0260<BRANCHID>0001<ACCTID>12345-6<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261101<DTEND>20261124
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261103000000[-3:BRT]<TRNAMT>-52.90<FITID>a1<MEMO>Compra no débito - IFOOD *RESTAURANTE</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261105000000[-3:BRT]<TRNAMT>5000.00<FITID>a2<MEMO>Transferência recebida pelo Pix - EMPRESA X LTDA</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261110000000[-3:BRT]<TRNAMT>-1200.00<FITID>a3<MEMO>Pagamento de fatura</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261112<TRNAMT>-89.90<FITID>a4<NAME>VIVO FIXO<MEMO>CONTA 11/2026</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>3657.20<DTASOF>20261124</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

test('OFX 1.x (SGML, sem fechamento de tags) em Windows-1252', () => {
  const bytes = Uint8Array.from(OFX_SGML, (ch) => {
    const map = { 'é': 0xe9, 'ê': 0xea, 'ç': 0xe7, 'ã': 0xe3 };
    return map[ch] ?? ch.charCodeAt(0);
  });
  const text = decodeBytes(bytes);
  assert.ok(text.includes('Compra no débito'));
  const st = parseStatement(text);
  assert.equal(st.format, 'ofx');
  assert.equal(st.card, false);
  assert.equal(st.acctId, '12345-6');
  assert.equal(st.bankId, '0260');
  assert.equal(st.currency, 'BRL');
  assert.equal(st.balance, 365720);
  assert.equal(st.balanceDate, '2026-11-24');
  assert.equal(st.items.length, 4);
  assert.deepEqual(st.items[0], { fitid: 'a1', date: '2026-11-03', amount: -5290, description: 'Compra no débito - IFOOD *RESTAURANTE' });
  assert.equal(st.items[1].amount, 500000);
  assert.equal(st.items[3].description, 'VIVO FIXO CONTA 11/2026');
});

test('OFX 2.x (XML) de cartão de crédito', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><?OFX OFXHEADER="200" VERSION="211"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>BRL</CURDEF><CCACCTFROM><ACCTID>4111</ACCTID></CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261102</DTPOSTED><TRNAMT>-120.50</TRNAMT><FITID>x</FITID><NAME>SUPERMERCADO BOM PRECO</NAME></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261110</DTPOSTED><TRNAMT>1200.00</TRNAMT><FITID>y</FITID><NAME>Pagamento recebido</NAME></STMTTRN>
</BANKTRANLIST><LEDGERBAL><BALAMT>-980.10</BALAMT><DTASOF>20261124</DTASOF></LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
  const st = parseOfx(xml);
  assert.equal(st.card, true);
  assert.equal(st.items.length, 2);
  assert.equal(st.items[0].amount, -12050);
  assert.equal(st.items[0].description, 'SUPERMERCADO BOM PRECO');
  assert.equal(st.balance, -98010);
});

test('CSV da conta (vírgula, aspas, identificador UUID ignorado)', () => {
  const csv = `Data,Valor,Identificador,Descrição
03/11/2026,-52.90,6543a1b2-0000-4000-8000-1234567890ab,"Compra no débito - IFOOD, RESTAURANTE"
05/11/2026,5000.00,6543a1b2-0000-4000-8000-1234567890ac,Transferência recebida pelo Pix
`;
  const st = parseCsv(csv);
  assert.equal(st.items.length, 2);
  assert.equal(st.items[0].description, 'Compra no débito - IFOOD, RESTAURANTE');
  assert.equal(st.items[0].amount, -5290);
  assert.equal(st.items[1].amount, 500000);
});

test('CSV com linhas antes do cabeçalho, ponto e vírgula e linha de saldo', () => {
  const csv = `Extrato Conta Corrente
Conta ;123456
Período ;01/11/2026 a 24/11/2026

Data Lançamento;Histórico;Descrição;Valor;Saldo
24/11/2026;Pix enviado ;Fulano de Tal;-1.250,00;2.407,20
23/11/2026;Compra no debito;POSTO SHELL;-200,00;3.657,20
22/11/2026;Saldo do dia;;0,00;3.857,20
`;
  const st = parseCsv(csv);
  assert.equal(st.items.length, 2);
  assert.deepEqual(st.items[0], { fitid: '', date: '2026-11-24', amount: -125000, description: 'Pix enviado Fulano de Tal' });
  assert.equal(st.items[1].description, 'Compra no debito POSTO SHELL');
});

test('CSV com colunas de débito e crédito separadas, e fatura invertida', () => {
  const csv = `data;descricao;debito;credito
01/11/2026;Tarifa pacote;29,90;
02/11/2026;Rendimento;;3,15
`;
  const st = parseCsv(csv);
  assert.deepEqual(st.items.map((x) => x.amount), [-2990, 315]);
  const card = parseCsv('date,title,amount\n2026-11-02,Netflix.com,55.90\n', { invert: true });
  assert.equal(card.items[0].amount, -5590);
});

test('CSV sem colunas reconhecíveis dá erro claro', () => {
  assert.throws(() => parseCsv('a;b;c\n1;2;3\n'), /colunas de data/);
});

test('chave e descrição limpas', () => {
  assert.equal(descKey('COMPRA CARTAO DEB IFOOD *RESTAURANTE 20/11'), 'ifood restaurante');
  assert.equal(descKey('Compra no débito - IFOOD *RESTAURANTE'), 'ifood restaurante');
  assert.equal(tidyDescription('POSTO SHELL 23/11 14:22'), 'Posto Shell');
  assert.equal(tidyDescription('Uber *Trip'), 'Uber *Trip');
  assert.ok(tidyDescription('x'.repeat(300)).length <= 120);
});

test('transferências / pagamento de fatura', () => {
  assert.ok(looksLikeTransfer('Pagamento de fatura'));
  assert.ok(looksLikeTransfer('PAGAMENTO RECEBIDO'));
  assert.ok(!looksLikeTransfer('Pagamento conta de luz'));
});

test('sugere categoria pelo histórico e por palavra-chave', () => {
  const categories = [
    { id: 'alim', name: 'Alimentação', type: 'expense' },
    { id: 'rest', name: 'Restaurante', type: 'expense', parent_id: 'alim' },
    { id: 'transp', name: 'Transporte', type: 'expense' },
    { id: 'sal', name: 'Salário', type: 'income' },
  ];
  const transactions = [
    { type: 'expense', description: 'Compra no débito - IFOOD *RESTAURANTE', category_id: 'rest' },
    { type: 'expense', description: 'iFood', category_id: 'rest' },
    { type: 'expense', description: 'iFood pizza', category_id: 'rest' },
  ];
  const s = buildSuggester(transactions, categories);
  const a = s('COMPRA CARTAO DEB IFOOD *RESTAURANTE', 'expense');
  assert.equal(a.categoryId, 'rest');
  assert.equal(a.description, 'Compra no débito - IFOOD *RESTAURANTE');
  assert.equal(s('IFOOD *OUTRO LUGAR', 'expense').categoryId, 'rest');       // por palavra
  assert.equal(s('POSTO IPIRANGA', 'expense').categoryId, 'transp');          // por palavra-chave
  assert.equal(s('SALARIO NOVEMBRO', 'income').categoryId, 'sal');
  assert.equal(s('QUALQUER COISA', 'expense').categoryId, null);
});

test('confere com o que já está lançado (1 para 1, data próxima, mesma conta)', () => {
  const items = [
    { date: '2026-11-03', amount: -5290 },
    { date: '2026-11-03', amount: -5290 },   // duas compras iguais no mesmo dia
    { date: '2026-11-05', amount: 500000 },
    { date: '2026-11-20', amount: -1000 },
  ];
  const existing = [
    { id: 't1', source: 'tx', type: 'expense', amount: 5290, date: '2026-11-04', accountId: 'nu', description: 'iFood' },
    { id: 'auto', source: 'auto', type: 'income', amount: 500000, date: '2026-11-05', accountId: null, description: 'Salário' },
    { id: 't2', source: 'tx', type: 'expense', amount: 1000, date: '2026-11-20', accountId: 'outra', description: 'Outra conta' },
    { id: 't3', source: 'tx', type: 'expense', amount: 1000, date: '2026-11-01', accountId: 'nu', description: 'Longe demais' },
  ];
  const m = reconcile(items, existing, 'nu');
  assert.equal(m[0]?.id ?? m[1]?.id, 't1');
  assert.ok(!(m[0] && m[1]), 'um lançamento existente só casa com uma linha');
  assert.equal(m[2]?.id, 'auto');
  assert.equal(m[3], null);
});
