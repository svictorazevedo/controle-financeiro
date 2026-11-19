import crypto from 'node:crypto';
import { randomToken, sha256 } from './crypto.js';

/**
 * Sessões no servidor (token opaco aleatório de 256 bits).
 * - O cookie é HttpOnly (inacessível ao JavaScript => protege contra roubo via XSS),
 *   SameSite=Strict (não é enviado em requisições vindas de outros sites => CSRF) e
 *   Secure em produção (só trafega por HTTPS). Em produção usa o prefixo __Host-.
 * - No banco fica apenas o SHA-256 do token: um vazamento do banco não permite sequestrar sessões.
 * - Expira por inatividade e também por tempo máximo absoluto.
 */
export function createSessionManager(db, cfg) {
  const cookieName = cfg.cookieSecure ? '__Host-sid' : 'sid';
  const idleMs = cfg.sessionIdleMinutes * 60_000;
  const maxMs = cfg.sessionMaxDays * 86_400_000;

  const q = {
    insert: db.prepare(`INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, last_seen, expires_at, ip, user_agent)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    get: db.prepare(`SELECT s.*, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`),
    touch: db.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?'),
    del: db.prepare('DELETE FROM sessions WHERE id_hash = ?'),
    delUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    delUserExcept: db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash <> ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?'),
  };

  const timer = setInterval(() => {
    const now = Date.now();
    q.purge.run(now, now - idleMs);
  }, 15 * 60_000);
  timer.unref();

  function cookieOptions() {
    return { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'strict', path: '/', maxAge: maxMs };
  }

  function readToken(req) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === cookieName) return decodeURIComponent(v.join('='));
    }
    return null;
  }

  return {
    cookieName,
    /** Cria uma sessão nova (sempre um token novo após o login => evita fixação de sessão). */
    create(res, userId, req) {
      const token = randomToken(32);
      const now = Date.now();
      const csrf = randomToken(32);
      q.insert.run(sha256(token), userId, csrf, now, now, now + maxMs, req.ip ?? null, String(req.headers['user-agent'] || '').slice(0, 200));
      res.cookie(cookieName, token, cookieOptions());
      return { csrf };
    },
    load(req) {
      const token = readToken(req);
      if (!token || token.length > 100) return null;
      const idHash = sha256(token);
      const s = q.get.get(idHash);
      if (!s) return null;
      const now = Date.now();
      if (s.expires_at < now || s.last_seen + idleMs < now) {
        q.del.run(idHash);
        return null;
      }
      if (now - s.last_seen > 60_000) q.touch.run(now, idHash);
      return { idHash, userId: s.user_id, email: s.email, name: s.name, csrf: s.csrf_token };
    },
    destroy(req, res) {
      const token = readToken(req);
      if (token) q.del.run(sha256(token));
      res.clearCookie(cookieName, { ...cookieOptions(), maxAge: undefined });
    },
    destroyAllForUser(userId, exceptIdHash) {
      if (exceptIdHash) q.delUserExcept.run(userId, exceptIdHash);
      else q.delUser.run(userId);
    },
  };
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
