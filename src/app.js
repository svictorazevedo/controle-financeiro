import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { openDatabase } from './db.js';
import { csrfGuard, errorHandler, HttpError, requireAuth } from './middleware.js';
import { authRouter } from './routes/auth.js';
import { houseRouter } from './routes/house.js';
import { createSessionManager } from './security/session.js';

export function createApp(cfg) {
  const db = openDatabase(cfg.databasePath);
  const sessions = createSessionManager(db, cfg);
  const auditStmt = db.prepare('INSERT INTO audit_log (user_id, house_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  const audit = (req, userId, houseId, action, detail = null) => auditStmt.run(userId ?? null, houseId ?? null, action, detail, req.ip ?? null, Date.now());

  const app = express();
  app.disable('x-powered-by');
  // Só confie em X-Forwarded-* se estiver atrás de um proxy reverso seu (nginx, Caddy...).
  app.set('trust proxy', cfg.trustProxy ? 1 : false);

  // Cabeçalhos de segurança. A CSP só permite scripts e estilos do próprio site:
  // mesmo que um texto malicioso seja salvo, ele não consegue executar JavaScript.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(cfg.cookieSecure ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: cfg.cookieSecure ? { maxAge: 31536000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  }));
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });

  // API
  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store'); // dados financeiros não ficam em cache
    next();
  });
  api.use(express.json({ limit: '100kb', strict: true }));
  api.use((req, res, next) => {
    req.session = sessions.load(req);
    next();
  });
  api.use(csrfGuard);
  api.use(authRouter({ db, cfg, sessions, audit }));
  api.use('/houses/:houseId', requireAuth, houseRouter({ db, cfg, audit }));
  api.use((req, res, next) => next(new HttpError(404, 'Rota não encontrada.')));
  app.use('/api', api);

  // Front-end estático
  app.use(express.static(path.join(cfg.root, 'public'), { index: 'index.html', dotfiles: 'deny', maxAge: cfg.isProd ? '1h' : 0 }));
  app.get('*', (req, res) => res.sendFile(path.join(cfg.root, 'public', 'index.html')));

  app.use(errorHandler);
  return { app, db };
}
