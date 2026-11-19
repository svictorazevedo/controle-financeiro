import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// scrypt é resistente a ataques com GPU/ASIC (memory-hard). Parâmetros: ~32 MB por hash.
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 64;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem,
  });
  return crypto.timingSafeEqual(actual, expected); // comparação em tempo constante
}

// Hash "falso" usado quando o e-mail não existe, para que o tempo de resposta
// seja o mesmo e não revele quais e-mails estão cadastrados.
let dummyHash;
export async function burnPasswordTime(password) {
  dummyHash ??= await hashPassword('senha-inexistente-para-timing');
  await verifyPassword(password, dummyHash);
}

const COMMON = new Set([
  '1234567890', '12345678910', 'senha12345', 'senha123456', 'password123', 'qwertyuiop',
  'abcdefghij', '0123456789', '1111111111', 'iloveyou12', 'brasil1234', 'mudar12345',
]);

/** Retorna uma mensagem de erro ou null se a senha for aceitável. */
export function checkPasswordPolicy(password, email = '') {
  if (typeof password !== 'string') return 'Senha inválida.';
  if (password.length < 10) return 'A senha deve ter pelo menos 10 caracteres.';
  if (password.length > 128) return 'A senha deve ter no máximo 128 caracteres.';
  if (COMMON.has(password.toLowerCase())) return 'Essa senha é muito comum. Escolha outra.';
  if (/^(.)\1+$/.test(password)) return 'A senha não pode ser um único caractere repetido.';
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && password.toLowerCase().includes(local)) return 'A senha não deve conter o seu e-mail.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2 && password.length < 16) return 'Use letras e números (ou uma frase com 16+ caracteres).';
  return null;
}
