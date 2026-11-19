import { HttpError } from './middleware.js';

// Validação explícita de toda entrada do usuário (lista de permissões, tamanhos máximos).
const fail = (msg) => {
  throw new HttpError(400, msg);
};

export function text(v, field, { min = 1, max = 120, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    fail(`${field} é obrigatório.`);
  }
  if (typeof v !== 'string') fail(`${field} inválido.`);
  // remove caracteres de controle
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (s.length < min) fail(`${field} é obrigatório.`);
  if (s.length > max) fail(`${field} deve ter no máximo ${max} caracteres.`);
  return s;
}

export function email(v) {
  const s = text(v, 'E-mail', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) fail('E-mail inválido.');
  return s;
}

/** Valor em centavos: inteiro positivo até R$ 100 milhões. */
export function cents(v, field = 'Valor') {
  if (!Number.isSafeInteger(v) || v <= 0 || v > 10_000_000_000) fail(`${field} inválido.`);
  return v;
}

/** Percentual em pontos-base: 1 a 10000 (0,01% a 100%). */
export function percentBp(v, field = 'Percentual') {
  if (!Number.isSafeInteger(v) || v <= 0 || v > 10000) fail(`${field} deve estar entre 0,01% e 100%.`);
  return v;
}

export function month(v, field = 'Mês', { optional = false } = {}) {
  if ((v === undefined || v === null || v === '') && optional) return null;
  if (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) fail(`${field} inválido (use AAAA-MM).`);
  return v;
}

export function date(v, field = 'Data') {
  if (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v)) fail(`${field} inválida.`);
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) fail(`${field} inválida.`);
  return v;
}

export function id(v, field = 'ID', { optional = false } = {}) {
  if ((v === undefined || v === null || v === '') && optional) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) fail(`${field} inválido.`);
  return n;
}

export function oneOf(v, allowed, field) {
  if (!allowed.includes(v)) fail(`${field} inválido.`);
  return v;
}

export function intRange(v, field, minV, maxV, { optional = false } = {}) {
  if ((v === undefined || v === null || v === '') && optional) return null;
  if (!Number.isSafeInteger(v) || v < minV || v > maxV) fail(`${field} deve estar entre ${minV} e ${maxV}.`);
  return v;
}
