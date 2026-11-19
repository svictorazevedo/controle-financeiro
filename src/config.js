import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Carrega um arquivo .env simples (CHAVE=valor) sem dependências externas.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'sim'].includes(String(v).toLowerCase()));
const int = (v, d) => (Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : d);

const isProd = env.NODE_ENV === 'production';

/**
 * Chave de criptografia (AES-256-GCM) usada para proteger as chaves de API de IA no banco.
 * Em produção ela é obrigatória via APP_ENCRYPTION_KEY. Em desenvolvimento, se ausente,
 * é gerada uma única vez em data/secret.key (arquivo ignorado pelo git).
 */
function resolveEncryptionKey(dataDir) {
  const fromEnv = env.APP_ENCRYPTION_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, /^[0-9a-f]{64}$/i.test(fromEnv) ? 'hex' : 'base64');
    if (buf.length !== 32) throw new Error('APP_ENCRYPTION_KEY deve ter 32 bytes (64 caracteres hex ou base64).');
    return buf;
  }
  if (isProd) throw new Error('APP_ENCRYPTION_KEY é obrigatória em produção. Gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  const keyFile = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    console.warn('[config] APP_ENCRYPTION_KEY ausente: chave de desenvolvimento gerada em data/secret.key');
  }
  return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
}

export function loadConfig(overrides = {}) {
  const dataDir = overrides.dataDir ?? path.join(ROOT, 'data');
  const cfg = {
    root: ROOT,
    isProd,
    port: int(env.PORT, 3000),
    // Por padrão escuta só na máquina local; exponha via proxy reverso com HTTPS.
    host: env.HOST || '127.0.0.1',
    databasePath: env.DATABASE_PATH || path.join(dataDir, 'financas.db'),
    allowRegistration: bool(env.ALLOW_REGISTRATION, true),
    trustProxy: bool(env.TRUST_PROXY, false),
    cookieSecure: bool(env.COOKIE_SECURE, isProd),
    allowLocalAi: bool(env.ALLOW_LOCAL_AI, false),
    sessionIdleMinutes: int(env.SESSION_IDLE_MINUTES, 12 * 60),
    sessionMaxDays: int(env.SESSION_MAX_DAYS, 7),
    aiRequestsPerHour: int(env.AI_REQUESTS_PER_HOUR, 30),
    authAttemptsPer15Min: int(env.AUTH_ATTEMPTS_PER_15MIN, 20),
    ...overrides,
  };
  cfg.encryptionKey = overrides.encryptionKey ?? resolveEncryptionKey(dataDir);
  return cfg;
}
