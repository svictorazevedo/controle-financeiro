import crypto from 'node:crypto';

/** Criptografa texto com AES-256-GCM (confidencialidade + integridade). */
export function encrypt(plain, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

export function decrypt(payload, key) {
  const [v, ivB64, tagB64, dataB64] = String(payload).split(':');
  if (v !== 'v1') throw new Error('Formato de dado criptografado desconhecido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Código de convite legível (sem 0/O/1/I), ~60 bits de entropia. */
export function inviteCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

export const normalizeInvite = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
