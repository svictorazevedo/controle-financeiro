import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Valores monetários: sempre inteiros em CENTAVOS (evita erros de ponto flutuante).
// Percentuais: sempre inteiros em PONTOS-BASE (1000 = 10,00%).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash     TEXT PRIMARY KEY,           -- SHA-256 do token; o token em si nunca é salvo
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS houses (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS residents (
  id              INTEGER PRIMARY KEY,
  house_id        INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin','member')),
  invite_hash     TEXT UNIQUE,            -- SHA-256 do código de convite
  invite_expires  INTEGER,
  created_at      INTEGER NOT NULL,
  UNIQUE (house_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_residents_user ON residents(user_id);

CREATE TABLE IF NOT EXISTS incomes (
  id            INTEGER PRIMARY KEY,
  resident_id   INTEGER NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  description   TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  kind          TEXT NOT NULL CHECK (kind IN ('recurring','once')),
  start_month   TEXT NOT NULL,            -- YYYY-MM (para 'once' é o mês do recebimento)
  end_month     TEXT,                     -- opcional, só para 'recurring'
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id           INTEGER PRIMARY KEY,
  resident_id  INTEGER NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  percent_bp   INTEGER NOT NULL CHECK (percent_bp > 0 AND percent_bp <= 10000),
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY,
  house_id    INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (house_id, name)
);

CREATE TABLE IF NOT EXISTS expenses (
  id            INTEGER PRIMARY KEY,
  house_id      INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  resident_id   INTEGER REFERENCES residents(id) ON DELETE SET NULL,  -- NULL = gasto da casa
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  description   TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  date          TEXT NOT NULL,            -- YYYY-MM-DD
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_house_date ON expenses(house_id, date);

-- Descontos automáticos: dízimo (percentual da renda), aluguel, parcelas, assinaturas...
CREATE TABLE IF NOT EXISTS recurring (
  id            INTEGER PRIMARY KEY,
  house_id      INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  resident_id   INTEGER REFERENCES residents(id) ON DELETE CASCADE,  -- NULL = da casa
  category_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  description   TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('fixed','percent')),
  amount_cents  INTEGER,                  -- para 'fixed'
  percent_bp    INTEGER,                  -- para 'percent' (sobre a renda do morador ou da casa)
  start_month   TEXT NOT NULL,
  installments  INTEGER,                  -- nº de parcelas; some do painel quando termina
  end_month     TEXT,                     -- fim opcional (ex.: contrato de aluguel)
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  CHECK ((mode = 'fixed' AND amount_cents > 0) OR (mode = 'percent' AND percent_bp > 0 AND percent_bp <= 10000))
);

CREATE TABLE IF NOT EXISTS ai_settings (
  house_id     INTEGER PRIMARY KEY REFERENCES houses(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL CHECK (provider IN ('anthropic','openai','gemini')),
  model        TEXT NOT NULL,
  base_url     TEXT,
  api_key_enc  TEXT,                      -- AES-256-GCM; nunca retornada ao navegador
  key_hint     TEXT,                      -- últimos 4 caracteres, para exibição
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER,
  house_id    INTEGER,
  action      TEXT NOT NULL,
  detail      TEXT,
  ip          TEXT,
  created_at  INTEGER NOT NULL
);
`;

export const DEFAULT_CATEGORIES = [
  'Moradia', 'Contas (água, luz, internet)', 'Mercado', 'Alimentação fora', 'Transporte',
  'Saúde', 'Educação', 'Lazer', 'Vestuário', 'Dízimo e ofertas', 'Assinaturas',
  'Pets', 'Cuidados pessoais', 'Presentes', 'Outros',
];

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Executa fn dentro de uma transação, com rollback automático em caso de erro. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
