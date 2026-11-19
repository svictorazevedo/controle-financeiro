import express from 'express';
import { DEFAULT_CATEGORIES, tx } from '../db.js';
import { HttpError, requireAuth, wrap } from '../middleware.js';
import { normalizeInvite, sha256 } from '../security/crypto.js';
import { burnPasswordTime, checkPasswordPolicy, hashPassword, verifyPassword } from '../security/password.js';
import { createRateLimiter, rateLimitMiddleware } from '../security/rateLimit.js';
import * as v from '../validate.js';

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

export function authRouter({ db, cfg, sessions, audit }) {
  const r = express.Router();

  // Força bruta: no máximo N (padrão 20) tentativas de login/cadastro por IP a cada 15 min,
  // além do bloqueio temporário da conta após 5 senhas erradas seguidas.
  const ipLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: cfg.authAttemptsPer15Min });
  const limitByIp = rateLimitMiddleware(ipLimiter, (req) => `auth:${req.ip}`, 'Muitas tentativas. Aguarde alguns minutos.');

  const q = {
    byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (email, name, password_hash, created_at) VALUES (?, ?, ?, ?)'),
    fail: db.prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?'),
    okLogin: db.prepare('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?'),
    setPwd: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    houses: db.prepare(`SELECT h.id, h.name, r.role, r.id AS resident_id FROM residents r JOIN houses h ON h.id = r.house_id
                        WHERE r.user_id = ? ORDER BY h.id`),
    inviteByHash: db.prepare('SELECT * FROM residents WHERE invite_hash = ?'),
    alreadyIn: db.prepare('SELECT 1 FROM residents WHERE house_id = ? AND user_id = ?'),
    claimInvite: db.prepare('UPDATE residents SET user_id = ?, invite_hash = NULL, invite_expires = NULL WHERE id = ? AND user_id IS NULL'),
    insertHouse: db.prepare('INSERT INTO houses (name, created_at) VALUES (?, ?)'),
    insertResident: db.prepare('INSERT INTO residents (house_id, user_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)'),
    insertCat: db.prepare('INSERT INTO categories (house_id, name, is_default) VALUES (?, ?, 1)'),
  };

  /** Vincula o usuário ao morador do convite. Retorna o house_id ou lança erro. */
  function claimInvite(userId, code) {
    const norm = normalizeInvite(code);
    if (norm.length !== 12) throw new HttpError(400, 'Código de convite inválido ou expirado.');
    const res = q.inviteByHash.get(sha256(norm));
    if (!res || !res.invite_expires || res.invite_expires < Date.now() || res.user_id) {
      throw new HttpError(400, 'Código de convite inválido ou expirado.');
    }
    if (q.alreadyIn.get(res.house_id, userId)) throw new HttpError(409, 'Você já faz parte dessa casa.');
    q.claimInvite.run(userId, res.id);
    return res.house_id;
  }

  /** Cria uma casa com categorias padrão e o usuário como administrador. */
  function createHouse(userId, houseName, residentName) {
    const now = Date.now();
    const houseId = Number(q.insertHouse.run(houseName, now).lastInsertRowid);
    q.insertResident.run(houseId, userId, residentName, 'admin', now);
    for (const c of DEFAULT_CATEGORIES) q.insertCat.run(houseId, c);
    return houseId;
  }

  r.post('/auth/register', limitByIp, wrap(async (req, res) => {
    const name = v.text(req.body?.name, 'Nome', { max: 80 });
    const email = v.email(req.body?.email);
    const password = req.body?.password;
    const inviteCode = req.body?.inviteCode ? String(req.body.inviteCode) : null;
    if (!cfg.allowRegistration && !inviteCode) {
      throw new HttpError(403, 'O cadastro está fechado. Peça um código de convite ao administrador da casa.');
    }
    const policy = checkPasswordPolicy(password, email);
    if (policy) throw new HttpError(400, policy);
    const hash = await hashPassword(password);

    let userId;
    try {
      userId = tx(db, () => {
        const id = Number(q.insertUser.run(email, name, hash, Date.now()).lastInsertRowid);
        if (inviteCode) claimInvite(id, inviteCode);
        return id;
      });
    } catch (e) {
      if (String(e.message).includes('UNIQUE') && String(e.message).includes('users.email')) {
        throw new HttpError(409, 'Não foi possível criar a conta com esse e-mail.');
      }
      throw e;
    }
    audit(req, userId, null, 'register');
    const { csrf } = sessions.create(res, userId, req);
    res.status(201).json({ ok: true, csrf });
  }));

  r.post('/auth/login', limitByIp, wrap(async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
    const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 128) : '';
    const generic = new HttpError(401, 'E-mail ou senha incorretos.');
    const user = email ? q.byEmail.get(email) : null;
    if (!user) {
      await burnPasswordTime(password || 'x');
      throw generic;
    }
    if (user.locked_until > Date.now()) {
      await burnPasswordTime(password || 'x');
      throw new HttpError(429, 'Conta bloqueada temporariamente por excesso de tentativas. Tente em alguns minutos.');
    }
    const ok = password ? await verifyPassword(password, user.password_hash) : false;
    if (!ok) {
      const fails = user.failed_logins + 1;
      q.fail.run(fails >= MAX_FAILS ? 0 : fails, fails >= MAX_FAILS ? Date.now() + LOCK_MS : 0, user.id);
      audit(req, user.id, null, fails >= MAX_FAILS ? 'login_locked' : 'login_failed');
      throw generic;
    }
    q.okLogin.run(user.id);
    audit(req, user.id, null, 'login');
    const { csrf } = sessions.create(res, user.id, req);
    res.json({ ok: true, csrf });
  }));

  r.post('/auth/logout', (req, res) => {
    sessions.destroy(req, res);
    res.json({ ok: true });
  });

  r.get('/auth/me', (req, res) => {
    if (!req.session) return res.json({ user: null, allowRegistration: cfg.allowRegistration });
    const houses = q.houses.all(req.session.userId).map((h) => ({ id: h.id, name: h.name, role: h.role, residentId: h.resident_id }));
    res.json({
      user: { id: req.session.userId, name: req.session.name, email: req.session.email },
      csrf: req.session.csrf,
      houses,
    });
  });

  r.post('/auth/password', requireAuth, limitByIp, wrap(async (req, res) => {
    const user = q.byId.get(req.session.userId);
    const ok = await verifyPassword(String(req.body?.currentPassword ?? '').slice(0, 128), user.password_hash);
    if (!ok) throw new HttpError(400, 'Senha atual incorreta.');
    const policy = checkPasswordPolicy(req.body?.newPassword, user.email);
    if (policy) throw new HttpError(400, policy);
    q.setPwd.run(await hashPassword(req.body.newPassword), user.id);
    sessions.destroyAllForUser(user.id, req.session.idHash); // derruba as outras sessões
    audit(req, user.id, null, 'password_changed');
    res.json({ ok: true });
  }));

  r.post('/auth/logout-all', requireAuth, (req, res) => {
    sessions.destroyAllForUser(req.session.userId);
    sessions.destroy(req, res);
    res.json({ ok: true });
  });

  // Criar casa / entrar em casa por convite
  r.post('/houses', requireAuth, wrap(async (req, res) => {
    const name = v.text(req.body?.name, 'Nome da casa', { max: 80 });
    const houseId = tx(db, () => createHouse(req.session.userId, name, req.session.name));
    audit(req, req.session.userId, houseId, 'house_created');
    res.status(201).json({ id: houseId });
  }));

  r.post('/houses/join', requireAuth, limitByIp, wrap(async (req, res) => {
    const houseId = tx(db, () => claimInvite(req.session.userId, req.body?.code));
    audit(req, req.session.userId, houseId, 'house_joined');
    res.json({ id: houseId });
  }));

  return r;
}
