// Gerador de PDF mínimo, sem bibliotecas: tabelas de texto com Helvetica (fonte padrão do PDF),
// paginação, cabeçalho repetido e numeração. Acentos via WinAnsiEncoding.

// Larguras da Helvetica (1/1000 em) para ASCII 32..126 (AFM padrão).
const W = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611,
  722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const BASE = { 'á': 'a', 'à': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'é': 'e', 'ê': 'e', 'è': 'e', 'í': 'i', 'î': 'i', 'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o', 'ú': 'u', 'ü': 'u', 'ç': 'c', 'ñ': 'n' };
const WIN = { '€': 0x80, '…': 0x85, '•': 0x95, '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '›': 0x9b, '‹': 0x8b };

function charWidth(ch, bold) {
  let c = ch;
  const lower = c.toLowerCase();
  if (BASE[lower]) c = c === lower ? BASE[lower] : BASE[lower].toUpperCase();
  const code = c.charCodeAt(0);
  const w = code >= 32 && code <= 126 ? W[code - 32] : 556;
  return bold && !/[0-9 .,]/.test(c) ? w * 1.06 : w;
}
export function textWidth(str, size, bold = false) {
  let w = 0;
  for (const ch of String(str)) w += charWidth(ch, bold);
  return (w * size) / 1000;
}

/** Texto -> bytes WinAnsi escapados para uma string literal do PDF. */
function pdfString(str) {
  let out = '';
  for (const ch of String(str).normalize('NFC')) {
    let code = WIN[ch] ?? ch.charCodeAt(0);
    if (ch === '−') code = 45;            // sinal de menos
    if (ch === ' ' || ch === ' ') code = 32;
    if (code > 255) code = 63;                 // '?'
    if (code === 40 || code === 41 || code === 92) out += `\\${String.fromCharCode(code)}`;
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(code);
  }
  return `(${out})`;
}

function fit(str, maxW, size, bold) {
  const s = String(str ?? '');
  if (textWidth(s, size, bold) <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${s.slice(0, mid)}…`, size, bold) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo)}…`;
}

/**
 * @param doc { title, subtitle, org, generatedAt, columns: [{label, align, weight}], rows: [[texto...]], footer: [texto...] | null, landscape }
 * @returns Uint8Array com o PDF
 */
export function tablePdf(doc) {
  const landscape = doc.landscape ?? doc.columns.length > 5;
  const PW = landscape ? 842 : 595;
  const PH = landscape ? 595 : 842;
  const M = 40;
  const size = 9;
  const rowH = 16;
  const usable = PW - 2 * M;
  const weights = doc.columns.map((c) => c.weight ?? 1);
  const totalW = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => (w / totalW) * usable);
  const xs = widths.map((_, i) => M + widths.slice(0, i).reduce((a, b) => a + b, 0));

  const pages = [];
  let ops = [];
  let y = 0;
  const text = (x, yy, str, sz, bold = false, gray = 0) => {
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${sz} Tf ${gray} g ${x.toFixed(2)} ${yy.toFixed(2)} Td ${pdfString(str)} Tj ET`);
  };
  const cell = (i, str, yy, bold, gray = 0) => {
    const pad = 4;
    const s = fit(str, widths[i] - 2 * pad, size, bold);
    const x = doc.columns[i].align === 'right' ? xs[i] + widths[i] - pad - textWidth(s, size, bold) : xs[i] + pad;
    text(x, yy, s, size, bold, gray);
  };
  const header = () => {
    const first = pages.length === 0;
    y = PH - M;
    if (first) {
      if (doc.org) text(M, y - 10, doc.org, 10, false, 0.35);
      text(M, y - 30, doc.title, 16, true);
      if (doc.subtitle) text(M, y - 46, doc.subtitle, 10, false, 0.35);
      y -= 64;
    } else {
      text(M, y - 10, `${doc.title} (continuação)`, 10, true, 0.35);
      y -= 24;
    }
    ops.push(`0.93 g ${M} ${(y - rowH + 4).toFixed(2)} ${usable} ${rowH} re f`);
    doc.columns.forEach((c, i) => cell(i, c.label.toUpperCase(), y - 8, true, 0.3));
    y -= rowH;
  };
  const finishPage = () => {
    pages.push(ops);
    ops = [];
  };

  header();
  doc.rows.forEach((r, idx) => {
    if (y - rowH < M + 24) {
      finishPage();
      header();
    }
    if (idx % 2 === 1) ops.push(`0.975 g ${M} ${(y - rowH + 4).toFixed(2)} ${usable} ${rowH} re f`);
    r.forEach((v, i) => cell(i, v, y - 8, false));
    y -= rowH;
  });
  if (doc.footer) {
    if (y - rowH < M + 24) {
      finishPage();
      header();
    }
    ops.push(`0 G 0.8 w ${M} ${(y + 4).toFixed(2)} m ${PW - M} ${(y + 4).toFixed(2)} l S`);
    doc.footer.forEach((v, i) => cell(i, v ?? '', y - 8, true));
    y -= rowH;
  }
  if (!doc.rows.length) text(M + 4, y - 10, 'Nenhum registro no período.', size, false, 0.45);
  finishPage();

  // Rodapé com numeração
  pages.forEach((p, i) => {
    const label = `${doc.generatedAt ?? ''}   ·   Página ${i + 1} de ${pages.length}`;
    p.push(`BT /F1 8 Tf 0.45 g ${(PW - M - textWidth(label, 8)).toFixed(2)} ${M - 16} Td ${pdfString(label)} Tj ET`);
  });

  // Montagem do arquivo
  const objs = [];
  const add = (body) => {
    objs.push(body);
    return objs.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const p of pages) {
    const stream = p.join('\n');
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${pdfString(doc.title)} /Producer (Controle Financeiro) >>`);

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
