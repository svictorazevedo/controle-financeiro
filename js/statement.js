// Importação de extrato bancário / fatura de cartão (OFX ou CSV).
// Tudo roda no navegador: o arquivo não sai do computador e não passa por IA.
// Funções puras (sem DOM) para poderem ser testadas no Node.

// ---------------------------------------------------------------- texto do arquivo
/** Decodifica o arquivo respeitando o CHARSET do OFX (muitos bancos brasileiros usam Windows-1252). */
export function decodeBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = new TextDecoder('latin1').decode(u8.slice(0, 600));
  const declared = /CHARSET:\s*(1252|ISO-?8859-?1|LATIN)/i.test(head) || /encoding="(windows-1252|iso-8859-1)"/i.test(head);
  if (!declared) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^﻿/, '');
    } catch { /* não é UTF-8 válido: cai para Windows-1252 */ }
  }
  return new TextDecoder('windows-1252').decode(u8).replace(/^﻿/, '');
}

const clean = (s) => String(s ?? '').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();

/** "1.234,56" | "-1234.56" | "R$ -52,90" | "52,90 D" | "(10,00)" -> centavos com sinal, ou null. */
export function parseAmount(raw) {
  let t = String(raw ?? '').trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  if (/\s*D$/i.test(t)) {
    neg = true;
    t = t.replace(/\s*D$/i, '');
  } else t = t.replace(/\s*C$/i, '');
  t = t.replace(/[R$\s ]/g, '');
  if (/^[-−–]/.test(t)) {
    neg = !neg;
    t = t.slice(1);
  } else if (/^\+/.test(t)) t = t.slice(1);
  if (/-$/.test(t)) {
    neg = !neg;
    t = t.slice(0, -1);
  }
  if (!/^[\d.,]+$/.test(t)) return null;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  if (lastComma > lastDot) t = t.replace(/\./g, '').replace(',', '.');          // 1.234,56
  else if (lastDot > lastComma && lastComma >= 0) t = t.replace(/,/g, '');      // 1,234.56
  else if (lastDot >= 0 && (t.match(/\./g).length > 1 || /\.\d{3}$/.test(t) && !/^0?\.\d{3}$/.test(t))) t = t.replace(/\./g, ''); // 1.234 (milhar)
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return neg ? -cents : cents;
}

/** "20261120120000[-3:BRT]" | "20/11/2026" | "20/11/26" | "2026-11-20" | "20-11-2026" -> "2026-11-20" ou null. */
export function parseDate(raw) {
  const t = String(raw ?? '').trim();
  let y;
  let m;
  let d;
  let r;
  if ((r = /^(\d{4})(\d{2})(\d{2})/.exec(t)) && !/^\d{4}[-/]/.test(t)) [, y, m, d] = r;
  else if ((r = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(t))) [, y, m, d] = r;
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(t))) {
    [, d, m, y] = r;
    if (y.length === 2) y = `20${y}`;
  } else return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return null;
  if (iso < '2000-01-01' || iso > '2100-12-31') return null;
  return iso;
}

// ---------------------------------------------------------------- OFX (SGML 1.x e XML 2.x)
const tag = (block, name) => {
  const r = new RegExp(`<${name}>\\s*([^<\\r\\n]*)`, 'i').exec(block);
  return r ? clean(r[1]) : '';
};

export function parseOfx(text) {
  const src = String(text ?? '');
  if (!/<OFX>/i.test(src)) throw new Error('Este arquivo não parece um OFX.');
  const card = /<CCSTMTRS>/i.test(src);
  const items = [];
  const re = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi;
  let r;
  while ((r = re.exec(src))) {
    const b = r[1];
    const amount = parseAmount(tag(b, 'TRNAMT'));
    const date = parseDate(tag(b, 'DTPOSTED') || tag(b, 'DTUSER'));
    if (amount === null || !date || amount === 0) continue;
    const name = tag(b, 'NAME');
    const memo = tag(b, 'MEMO');
    // Alguns bancos repetem o texto em NAME e MEMO; outros põem o detalhe só no MEMO.
    let description = name && memo && !memo.toLowerCase().includes(name.toLowerCase()) && !name.toLowerCase().includes(memo.toLowerCase())
      ? `${name} ${memo}` : (memo.length > name.length ? memo : name) || memo || tag(b, 'TRNTYPE');
    description = description || 'Lançamento importado';
    items.push({ fitid: tag(b, 'FITID'), date, amount, description });
  }
  const balBlock = /<LEDGERBAL>([\s\S]*?)(?=<\/LEDGERBAL>|<AVAILBAL>|<\/STMTRS>|<\/CCSTMTRS>|$)/i.exec(src)?.[1] ?? '';
  const balance = balBlock ? parseAmount(tag(balBlock, 'BALAMT')) : null;
  return {
    format: 'ofx',
    card,
    bankId: tag(src, 'BANKID') || tag(src, 'ORG'),
    acctId: tag(src, 'ACCTID'),
    currency: tag(src, 'CURDEF') || null,
    balance,
    balanceDate: balBlock ? parseDate(tag(balBlock, 'DTASOF')) : null,
    items,
  };
}

// ---------------------------------------------------------------- CSV (cada banco tem o seu)
function splitCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const COLS = {
  date: /^(data|date|dt)( (do )?(lancamento|movimento|transacao|compra|mov\.?))?$|^data lanc/,
  description: /^(descricao|historico|lancamento|title|titulo|estabelecimento|description|detalhe|detalhes|memo)( .*)?$/,
  amount: /^(valor|amount|quantia|valor \(r\$\)|valor r\$|valor em r\$|value)$/,
  debit: /^(debito|saida|saidas|valor debito|debit)( .*)?$/,
  credit: /^(credito|entrada|entradas|valor credito|credit)( .*)?$/,
  detail: /^(descricao|identificador|complemento|detalhe|detalhes)$/,
};

/** Lê o CSV, achando sozinho o separador, a linha de cabeçalho e as colunas de data, descrição e valor. */
export function parseCsv(text, { invert = false } = {}) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('O arquivo está vazio.');
  const sample = lines.slice(0, 30).join('\n');
  const sep = [';', '\t', ','].map((s) => [s, sample.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  let headerIdx = -1;
  let map = null;
  for (let i = 0; i < Math.min(lines.length, 30) && headerIdx < 0; i++) {
    const cells = splitCsvLine(lines[i], sep).map(norm);
    const find = (re, skip = []) => cells.findIndex((c, j) => !skip.includes(j) && re.test(c));
    const date = find(COLS.date);
    if (date < 0) continue;
    const description = find(COLS.description);
    const amount = find(COLS.amount);
    const debit = find(COLS.debit);
    const credit = find(COLS.credit);
    if (description < 0 || (amount < 0 && debit < 0 && credit < 0)) continue;
    const detail = find(COLS.detail, [description, date, amount]);
    headerIdx = i;
    map = { date, description, amount, debit, credit, detail: detail >= 0 && detail !== description ? detail : -1 };
  }
  if (!map) {
    throw new Error('Não achei as colunas de data, descrição e valor. Exporte o extrato em OFX (melhor opção) ou em CSV com cabeçalho.');
  }
  const items = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const c = splitCsvLine(line, sep);
    const date = parseDate(c[map.date]);
    if (!date) continue;                       // linhas de saldo, totais, rodapé...
    let amount = null;
    if (map.amount >= 0) amount = parseAmount(c[map.amount]);
    if ((amount === null || amount === 0) && (map.debit >= 0 || map.credit >= 0)) {
      const deb = map.debit >= 0 ? parseAmount(c[map.debit]) : null;
      const cre = map.credit >= 0 ? parseAmount(c[map.credit]) : null;
      if (deb) amount = -Math.abs(deb);
      else if (cre) amount = Math.abs(cre);
    }
    if (!amount) continue;
    if (invert) amount = -amount;
    let description = clean(c[map.description]);
    const extra = map.detail >= 0 ? clean(c[map.detail]) : '';
    if (extra && !/^[0-9a-f-]{20,}$/i.test(extra) && !description.toLowerCase().includes(extra.toLowerCase())) description = `${description} ${extra}`.trim();
    if (/^saldo( do dia| anterior| final)?$/i.test(norm(description))) continue;
    items.push({ fitid: '', date, amount, description: description || 'Lançamento importado' });
  }
  if (!items.length) throw new Error('Não encontrei lançamentos no arquivo.');
  return { format: 'csv', card: false, bankId: '', acctId: '', currency: null, balance: null, balanceDate: null, items };
}

/** OFX ou CSV, pelo conteúdo. */
export function parseStatement(text, opts = {}) {
  return /<OFX>/i.test(String(text).slice(0, 5000)) ? parseOfx(text) : parseCsv(text, opts);
}

// ---------------------------------------------------------------- descrição e categoria
const NOISE = /\b(compra|compras|no|na|com|cartao|debito|credito|deb|cred|pagto|pagamento|pag|pgto|pix|ted|doc|tef|transf|transferencia|enviad[ao]|recebid[ao]|elo|visa|master|mastercard|maestro|electron|nacional|internacional|aut|autorizad[ao]|parc|parcela|de|do|da|em|para|ltda|me|eireli|sa|s a|br|bra|cuiaba|mt|brasil)\b/g;

/** Chave de comparação: sem acentos, números, datas e palavras genéricas do banco. "COMPRA CARTAO DEB IFOOD *RESTAURANTE 20/11" -> "ifood restaurante". */
export function descKey(desc) {
  return norm(desc).replace(/\d+[/:.-]\d+([/:.-]\d+)?/g, ' ').replace(/[*_#@|/\\.,:;()[\]{}'"!?+-]/g, ' ').replace(/\d+/g, ' ')
    .replace(NOISE, ' ').replace(/\b\w\b/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Descrição mais legível para salvar: tira datas, códigos e excesso de espaços, sem passar de 120 letras. */
export function tidyDescription(desc) {
  let t = clean(desc).replace(/\b\d{2}\/\d{2}(\/\d{2,4})?\b/g, ' ').replace(/\b\d{2}:\d{2}(:\d{2})?\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (t === t.toUpperCase() && /[A-Z]/.test(t)) {
    t = t.toLowerCase().replace(/(^|[\s*/-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
  }
  return (t || 'Lançamento importado').slice(0, 120);
}

// Palavras do extrato -> nomes de categoria prováveis (procura uma categoria da casa com esse nome).
const HINTS = [
  [/\b(supermerc|mercado|atacad|assai|atacadao|carrefour|big|comper|extra|pao de acucar|hortifruti|sacolao|acougue|padaria|panific)/, ['mercado', 'supermercado', 'alimentacao', 'compras']],
  [/\b(ifood|rappi|restaurante|lanchonete|pizzaria|burger|mcdonald|bk |lanche|bar |cafe|cafeteria|sushi|churrascaria|delivery)/, ['restaurante', 'alimentacao fora', 'lanches', 'alimentacao', 'delivery']],
  [/\b(uber|99 ?app|99pop|99 tecnologia|taxi|cabify|posto|combustiv|gasolina|shell|ipiranga|petrobras|br mania|estacionamento|pedagio|sem parar|conectcar|veloe)/, ['transporte', 'combustivel', 'carro', 'veiculo']],
  [/\b(farmacia|drogaria|droga|pague menos|raia|drogasil|pacheco|panvel|hospital|clinica|laboratorio|unimed|odonto|dentista|medic)/, ['saude', 'farmacia', 'remedios']],
  [/\b(energisa|energia|cemig|enel|light|copel|celpe|coelba|aguas|saneamento|sabesp|copasa|agua )/, ['energia', 'luz', 'agua', 'contas da casa', 'moradia', 'casa']],
  [/\b(vivo|claro|tim|oi |net |internet|telefon|celular|starlink)/, ['internet', 'telefone', 'celular', 'contas da casa', 'moradia']],
  [/\b(netflix|spotify|disney|hbo|max|prime video|amazon prime|youtube|globoplay|deezer|apple com|google storage|icloud|paramount|crunchyroll)/, ['assinaturas', 'streaming', 'lazer']],
  [/\b(aluguel|condominio|iptu|imobiliaria)/, ['aluguel', 'moradia', 'casa']],
  [/\b(escola|colegio|faculdade|universidade|curso|udemy|alura|livraria|papelaria)/, ['educacao', 'escola', 'cursos']],
  [/\b(pet|petshop|veterinar|cobasi|petz)/, ['pet', 'pets', 'animais']],
  [/\b(academia|smartfit|smart fit|bluefit|crossfit)/, ['academia', 'saude', 'esporte']],
  [/\b(salario|folha|pagto salario|proventos|vencimentos|remuneracao)/, ['salario', 'renda', 'trabalho']],
  [/\b(rendimento|juros|dividendo|resgate|cdb|tesouro|aplicacao)/, ['investimentos', 'rendimentos', 'juros']],
  [/\b(tarifa|anuidade|iof|encargo|cesta de servicos|manutencao de conta)/, ['tarifas', 'tarifas bancarias', 'banco', 'taxas']],
  [/\b(shopee|mercado livre|mercadolivre|amazon|magalu|magazine|americanas|aliexpress|shein|casas bahia)/, ['compras online', 'compras', 'lojas']],
];

/** Pagamento de fatura / transferência entre contas: aparece nos dois extratos e não é gasto de verdade. */
export function looksLikeTransfer(desc) {
  const t = norm(desc);
  return /pagamento (de )?fatura|pagto fatura|pag fatura|fatura (do )?cartao|pagamento recebido|pagamento efetuado cartao|transferencia entre contas|transf(erencia)? (p\/|para )?(mesma titularidade|propria)|aplicacao automatica|resgate automatico|aplic\.? aut|resg\.? aut|poupanca.*(aplic|resg)|credito de fatura/.test(t);
}

/**
 * Aprende com os lançamentos que já existem: para cada "chave" de descrição, qual categoria (e descrição)
 * a pessoa costuma usar. Devolve uma função (descrição do extrato, tipo) -> { categoryId, description }.
 */
export function buildSuggester(transactions, categories) {
  const byKey = new Map();
  const byToken = new Map();
  for (const t of transactions) {
    const key = descKey(t.description);
    if (!key) continue;
    const k = `${t.type}|${key}`;
    if (!byKey.has(k)) byKey.set(k, new Map());
    const m = byKey.get(k);
    const c = t.category_id ?? '';
    m.set(c, { n: (m.get(c)?.n ?? 0) + 1, description: t.description });
    for (const tok of new Set(key.split(' ').filter((w) => w.length >= 4))) {
      const tk = `${t.type}|${tok}`;
      if (!byToken.has(tk)) byToken.set(tk, new Map());
      const mm = byToken.get(tk);
      mm.set(c, (mm.get(c) ?? 0) + 1);
    }
  }
  const best = (m) => [...m].filter(([c]) => c).sort((a, b) => (b[1].n ?? b[1]) - (a[1].n ?? a[1]))[0];
  const catByName = (type, names) => {
    const mine = categories.filter((c) => (c.type ?? 'expense') === type);
    for (const n of names) {
      const hit = mine.find((c) => norm(c.name) === n) ?? mine.find((c) => norm(c.name).startsWith(n));
      if (hit) return hit.id;
    }
    return null;
  };
  return (desc, type) => {
    const key = descKey(desc);
    const exact = byKey.get(`${type}|${key}`);
    if (exact) {
      const b = best(exact);
      if (b) return { categoryId: b[0], description: b[1].description, how: 'history' };
    }
    // Palavra a palavra: "ifood" sozinho já costuma bastar.
    const votes = new Map();
    for (const tok of key.split(' ').filter((w) => w.length >= 4)) {
      for (const [c, n] of byToken.get(`${type}|${tok}`) ?? []) if (c) votes.set(c, (votes.get(c) ?? 0) + n);
    }
    const v = [...votes].sort((a, b) => b[1] - a[1])[0];
    if (v && v[1] >= 2) return { categoryId: v[0], description: null, how: 'history' };
    const text = ` ${norm(desc)} `;
    for (const [re, names] of HINTS) {
      if (re.test(text)) {
        const id = catByName(type, names);
        if (id) return { categoryId: id, description: null, how: 'keyword' };
      }
    }
    if (v) return { categoryId: v[0], description: null, how: 'history' };
    return { categoryId: null, description: null, how: null };
  };
}

// ---------------------------------------------------------------- conferência com o que já está lançado
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);

/**
 * Casa cada linha do extrato com um movimento já existente (lançado ou automático) da mesma conta,
 * mesmo tipo e mesmo valor, até `tolerance` dias de diferença. Um movimento só casa com uma linha.
 * @param items  [{ date, amount (com sinal) }]
 * @param existing movimentos de finance.movements() — { id, source, type, amount, date, accountId, description }
 * @returns array paralelo a items: movimento casado ou null
 */
export function reconcile(items, existing, accountId, { tolerance = 4 } = {}) {
  const pool = existing.filter((m) => (m.accountId ?? null) === (accountId ?? null) || m.accountId == null);
  const used = new Set();
  const out = new Array(items.length).fill(null);
  // Primeiro os encaixes perfeitos (mesma data), depois os mais próximos — evita roubar o par de outra linha.
  const cand = [];
  items.forEach((it, i) => {
    const type = it.amount > 0 ? 'income' : 'expense';
    const abs = Math.abs(it.amount);
    for (const m of pool) {
      if (m.type !== type || Number(m.amount) !== abs) continue;
      const dd = Math.abs(dayDiff(it.date, m.date));
      if (dd > tolerance) continue;
      // Mesma conta vale mais que "sem conta"
      cand.push({ i, m, score: dd * 10 + ((m.accountId ?? null) === (accountId ?? null) ? 0 : 5) });
    }
  });
  cand.sort((a, b) => a.score - b.score);
  for (const { i, m } of cand) {
    if (out[i] || used.has(m.id)) continue;
    out[i] = m;
    used.add(m.id);
  }
  return out;
}
