// Leitura simples de uma frase de lançamento, SEM IA (plano B quando a IA não está configurada ou falha).
// Tira o valor, o tipo (entrada/saída) e a data; o resto vira a descrição para o usuário revisar.
import { addDays } from './finance.js';

const INCOME = /\b(recebi|ganhei|entrou|entrada|caiu|depositaram|me pagaram|salário|salario|reembolso)\b/i;
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** "1.234,56" / "1234.56" / "50" / "50 e 90" -> centavos */
function amountFrom(text) {
  const t = text.replace(/r\$\s*/gi, '');
  const m = t.match(/(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s*(?:reais|real|conto|contos|pila))?(?:\s*e\s*(\d{1,2})\s*(?:centavos)?)?/i);
  if (!m) return null;
  let n = m[1];
  if (/\.\d{3}/.test(n)) n = n.replace(/\./g, '');
  n = n.replace(',', '.');
  let cents = Math.round(Number(n) * 100);
  if (m[2] && !n.includes('.')) cents += Number(m[2].padEnd(2, '0').slice(0, 2));
  return cents > 0 ? { cents, match: m[0] } : null;
}

function dateFrom(text, today) {
  const t = text.toLowerCase();
  if (/\banteontem\b/.test(t)) return { date: addDays(today, -2), match: /anteontem/i };
  if (/\bontem\b/.test(t)) return { date: addDays(today, -1), match: /ontem/i };
  if (/\bhoje\b/.test(t)) return { date: today, match: /hoje/i };
  const dm = t.match(/\bdia (\d{1,2})(?:\/(\d{1,2}))?\b/);
  if (dm) {
    const d = Number(dm[1]);
    const m = dm[2] ? Number(dm[2]) : Number(today.slice(5, 7));
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      const date = `${today.slice(0, 4)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (!Number.isNaN(Date.parse(`${date}T12:00:00Z`))) return { date, match: /dia \d{1,2}(?:\/\d{1,2})?/i };
    }
  }
  const wd = WEEKDAYS.findIndex((w) => t.includes(w));
  if (wd >= 0) {
    const cur = new Date(`${today}T12:00:00Z`).getUTCDay();
    const back = (cur - wd + 7) % 7 || 7;
    return { date: addDays(today, -back), match: new RegExp(`(na |no |)(última |ultimo |último |passad[oa] |)${WEEKDAYS[wd]}(-feira)?( passad[oa])?`, 'i') };
  }
  return { date: today, match: null };
}

export function quickParse(text, today) {
  const raw = String(text || '').trim();
  const type = INCOME.test(raw) ? 'income' : 'expense';
  const amount = amountFrom(raw);
  const when = dateFrom(raw, today);
  let desc = raw.replace(/r\$\s*/gi, '');
  if (amount) desc = desc.replace(amount.match, ' ');
  if (when.match) desc = desc.replace(when.match, ' ');
  desc = desc
    .replace(/\b(gastei|paguei|comprei|recebi|ganhei|entrou|caiu|saiu|foi|de|do|da|no|na|com|em|um|uma|reais|real)\b/gi, ' ')
    .replace(/[.,;]+/g, ' ').replace(/\s+/g, ' ').trim();
  desc = desc ? desc.charAt(0).toUpperCase() + desc.slice(1) : (type === 'income' ? 'Entrada' : 'Saída');
  return { type, amount_cents: amount?.cents ?? null, description: desc.slice(0, 120), date: when.date };
}
