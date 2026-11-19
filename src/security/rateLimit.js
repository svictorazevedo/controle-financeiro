/**
 * Limitador de requisições em memória (janela deslizante simples).
 * Suficiente para uma instância única. Com várias instâncias, troque por Redis.
 */
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60_000));
  timer.unref();

  return {
    /** Retorna { ok, retryAfter } e registra a tentativa. */
    hit(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.reset <= now) {
        entry = { count: 0, reset: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return { ok: entry.count <= max, retryAfter: Math.ceil((entry.reset - now) / 1000) };
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

export function rateLimitMiddleware(limiter, keyFn, message = 'Muitas requisições. Tente novamente mais tarde.') {
  return (req, res, next) => {
    const { ok, retryAfter } = limiter.hit(keyFn(req));
    if (!ok) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
