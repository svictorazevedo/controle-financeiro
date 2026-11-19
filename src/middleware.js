import { safeEqual } from './security/session.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Envolve handlers async para que erros caiam no tratador central. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Proteção CSRF em camadas para métodos que alteram dados:
 * 1. Content-Type precisa ser application/json (formulários HTML de outros sites não conseguem enviar isso);
 * 2. Se o navegador enviar Origin, ele precisa ser o próprio site;
 * 3. Com sessão ativa, o cabeçalho X-CSRF-Token precisa bater com o token da sessão.
 */
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.is('application/json')) return next(new HttpError(415, 'Envie os dados como JSON.'));
  const origin = req.headers.origin;
  if (origin) {
    const expected = `${req.protocol}://${req.get('host')}`;
    if (origin !== expected) return next(new HttpError(403, 'Origem não permitida.'));
  }
  if (req.session && !safeEqual(req.get('x-csrf-token') || '', req.session.csrf)) {
    return next(new HttpError(403, 'Token de segurança inválido. Recarregue a página.'));
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.session) return next(new HttpError(401, 'Faça login para continuar.'));
  next();
}

/**
 * Autorização por casa: todo acesso a /api/houses/:houseId/... verifica se o usuário
 * logado é morador daquela casa. Isso impede acessar dados de outras casas trocando o ID
 * na URL (IDOR). Todas as consultas seguintes também filtram por house_id.
 */
export function loadMembership(db) {
  const stmt = db.prepare('SELECT id, role, name FROM residents WHERE house_id = ? AND user_id = ?');
  return (req, res, next) => {
    const houseId = Number(req.params.houseId);
    if (!Number.isSafeInteger(houseId) || houseId <= 0) return next(new HttpError(404, 'Casa não encontrada.'));
    const r = stmt.get(houseId, req.session.userId);
    // 404 (e não 403) para não revelar se a casa existe.
    if (!r) return next(new HttpError(404, 'Casa não encontrada.'));
    req.house = { id: houseId, residentId: r.id, role: r.role, isAdmin: r.role === 'admin' };
    next();
  };
}

export function requireAdmin(req, res, next) {
  if (!req.house?.isAdmin) return next(new HttpError(403, 'Apenas administradores da casa podem fazer isso.'));
  next();
}

export function errorHandler(err, req, res, _next) {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Dados grandes demais.' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
  const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('[erro]', err);
  // Nunca envia stack trace ou detalhes internos ao navegador.
  res.status(status).json({ error: status >= 500 ? 'Erro interno. Tente novamente.' : err.message });
}
