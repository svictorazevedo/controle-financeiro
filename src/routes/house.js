import express from 'express';
import { tx } from '../db.js';
import { HttpError, loadMembership, requireAdmin, wrap } from '../middleware.js';
import { encrypt, decrypt, inviteCode, normalizeInvite, sha256 } from '../security/crypto.js';
import { createRateLimiter, rateLimitMiddleware } from '../security/rateLimit.js';
import { assertSafeBaseUrl } from '../security/urlGuard.js';
import { PROVIDERS, buildContext, chat } from '../services/ai.js';
import { createFinance, currentMonth } from '../services/finance.js';
import * as v from '../validate.js';

const INVITE_TTL_MS = 72 * 3600_000;

export function houseRouter({ db, cfg, audit }) {
  const r = express.Router({ mergeParams: true });
  const finance = createFinance(db);
  r.use(loadMembership(db));

  const aiLimiter = createRateLimiter({ windowMs: 3600_000, max: cfg.aiRequestsPerHour });

  const q = {
    house: db.prepare('SELECT id, name FROM houses WHERE id = ?'),
    renameHouse: db.prepare('UPDATE houses SET name = ? WHERE id = ?'),
    deleteHouse: db.prepare('DELETE FROM houses WHERE id = ?'),
    residents: db.prepare(`SELECT id, name, role, user_id, invite_expires FROM residents WHERE house_id = ? ORDER BY id`),
    resident: db.prepare('SELECT * FROM residents WHERE id = ? AND house_id = ?'),
    insertResident: db.prepare('INSERT INTO residents (house_id, name, role, created_at) VALUES (?, ?, ?, ?)'),
    updateResident: db.prepare('UPDATE residents SET name = ?, role = ? WHERE id = ? AND house_id = ?'),
    deleteResident: db.prepare('DELETE FROM residents WHERE id = ? AND house_id = ?'),
    adminCount: db.prepare(`SELECT COUNT(*) AS n FROM residents WHERE house_id = ? AND role = 'admin' AND user_id IS NOT NULL`),
    setInvite: db.prepare('UPDATE residents SET invite_hash = ?, invite_expires = ? WHERE id = ? AND house_id = ?'),

    categories: db.prepare('SELECT id, name, is_default FROM categories WHERE house_id = ? ORDER BY name COLLATE NOCASE'),
    category: db.prepare('SELECT * FROM categories WHERE id = ? AND house_id = ?'),
    insertCategory: db.prepare('INSERT INTO categories (house_id, name) VALUES (?, ?)'),
    renameCategory: db.prepare('UPDATE categories SET name = ? WHERE id = ? AND house_id = ?'),
    deleteCategory: db.prepare('DELETE FROM categories WHERE id = ? AND house_id = ?'),

    incomes: db.prepare(`SELECT i.* FROM incomes i JOIN residents r ON r.id = i.resident_id WHERE r.house_id = ? ORDER BY i.start_month DESC, i.id DESC`),
    income: db.prepare(`SELECT i.* FROM incomes i JOIN residents r ON r.id = i.resident_id WHERE i.id = ? AND r.house_id = ?`),
    insertIncome: db.prepare('INSERT INTO incomes (resident_id, description, amount_cents, kind, start_month, end_month, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    updateIncome: db.prepare('UPDATE incomes SET resident_id = ?, description = ?, amount_cents = ?, kind = ?, start_month = ?, end_month = ? WHERE id = ?'),
    deleteIncome: db.prepare('DELETE FROM incomes WHERE id = ?'),

    goals: db.prepare(`SELECT g.* FROM goals g JOIN residents r ON r.id = g.resident_id WHERE r.house_id = ? ORDER BY g.id`),
    goal: db.prepare(`SELECT g.* FROM goals g JOIN residents r ON r.id = g.resident_id WHERE g.id = ? AND r.house_id = ?`),
    goalSum: db.prepare('SELECT COALESCE(SUM(percent_bp), 0) AS s FROM goals WHERE resident_id = ? AND id <> ?'),
    insertGoal: db.prepare('INSERT INTO goals (resident_id, name, percent_bp, created_at) VALUES (?, ?, ?, ?)'),
    updateGoal: db.prepare('UPDATE goals SET name = ?, percent_bp = ? WHERE id = ?'),
    deleteGoal: db.prepare('DELETE FROM goals WHERE id = ?'),

    expense: db.prepare('SELECT * FROM expenses WHERE id = ? AND house_id = ?'),
    insertExpense: db.prepare('INSERT INTO expenses (house_id, resident_id, category_id, description, amount_cents, date, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    updateExpense: db.prepare('UPDATE expenses SET resident_id = ?, category_id = ?, description = ?, amount_cents = ?, date = ? WHERE id = ?'),
    deleteExpense: db.prepare('DELETE FROM expenses WHERE id = ?'),

    recurringAll: db.prepare('SELECT * FROM recurring WHERE house_id = ? ORDER BY active DESC, id DESC'),
    recurring: db.prepare('SELECT * FROM recurring WHERE id = ? AND house_id = ?'),
    insertRecurring: db.prepare(`INSERT INTO recurring (house_id, resident_id, category_id, description, mode, amount_cents, percent_bp, start_month, installments, end_month, active, created_at)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateRecurring: db.prepare(`UPDATE recurring SET resident_id = ?, category_id = ?, description = ?, mode = ?, amount_cents = ?, percent_bp = ?,
                                 start_month = ?, installments = ?, end_month = ?, active = ? WHERE id = ?`),
    deleteRecurring: db.prepare('DELETE FROM recurring WHERE id = ?'),

    aiGet: db.prepare('SELECT * FROM ai_settings WHERE house_id = ?'),
    aiUpsert: db.prepare(`INSERT INTO ai_settings (house_id, provider, model, base_url, api_key_enc, key_hint, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                          ON CONFLICT(house_id) DO UPDATE SET provider = excluded.provider, model = excluded.model, base_url = excluded.base_url,
                          api_key_enc = excluded.api_key_enc, key_hint = excluded.key_hint, updated_at = excluded.updated_at`),
    aiDelete: db.prepare('DELETE FROM ai_settings WHERE house_id = ?'),
  };

  // ---------- helpers de autorização ----------
  const houseId = (req) => req.house.id;

  /** O morador pertence a esta casa? Retorna o id ou lança 400. */
  function residentInHouse(req, rid, { optional = false } = {}) {
    const id = v.id(rid, 'Morador', { optional });
    if (id === null) return null;
    if (!q.resident.get(id, houseId(req))) throw new HttpError(400, 'Morador inválido.');
    return id;
  }

  /** Admin gerencia qualquer morador; membro comum só gerencia os próprios dados. */
  function assertCanManageResident(req, rid) {
    if (req.house.isAdmin) return;
    if (rid !== req.house.residentId) throw new HttpError(403, 'Você só pode alterar os seus próprios dados.');
  }

  function categoryInHouse(req, cid) {
    const id = v.id(cid, 'Categoria', { optional: true });
    if (id === null) return null;
    if (!q.category.get(id, houseId(req))) throw new HttpError(400, 'Categoria inválida.');
    return id;
  }

  const notFound = () => new HttpError(404, 'Registro não encontrado.');

  // ---------- casa e moradores ----------
  r.get('/', (req, res) => {
    const house = q.house.get(houseId(req));
    const residents = q.residents.all(houseId(req)).map((x) => ({
      id: x.id, name: x.name, role: x.role, hasLogin: x.user_id != null,
      invitePending: !x.user_id && x.invite_expires > Date.now(),
    }));
    res.json({ ...house, me: { residentId: req.house.residentId, role: req.house.role }, residents, categories: q.categories.all(houseId(req)) });
  });

  r.patch('/', requireAdmin, (req, res) => {
    q.renameHouse.run(v.text(req.body?.name, 'Nome da casa', { max: 80 }), houseId(req));
    res.json({ ok: true });
  });

  r.delete('/', requireAdmin, (req, res) => {
    const house = q.house.get(houseId(req));
    if (req.body?.confirmName !== house.name) throw new HttpError(400, 'Digite o nome exato da casa para confirmar a exclusão.');
    q.deleteHouse.run(houseId(req));
    audit(req, req.session.userId, houseId(req), 'house_deleted');
    res.json({ ok: true });
  });

  r.post('/residents', requireAdmin, (req, res) => {
    const name = v.text(req.body?.name, 'Nome', { max: 80 });
    const role = v.oneOf(req.body?.role ?? 'member', ['admin', 'member'], 'Papel');
    const id = Number(q.insertResident.run(houseId(req), name, role, Date.now()).lastInsertRowid);
    res.status(201).json({ id });
  });

  r.patch('/residents/:rid', requireAdmin, (req, res) => {
    const rid = v.id(req.params.rid);
    const cur = q.resident.get(rid, houseId(req));
    if (!cur) throw notFound();
    const name = v.text(req.body?.name ?? cur.name, 'Nome', { max: 80 });
    const role = v.oneOf(req.body?.role ?? cur.role, ['admin', 'member'], 'Papel');
    tx(db, () => {
      q.updateResident.run(name, role, rid, houseId(req));
      if (q.adminCount.get(houseId(req)).n === 0) throw new HttpError(400, 'A casa precisa de pelo menos um administrador com login.');
    });
    res.json({ ok: true });
  });

  r.delete('/residents/:rid', requireAdmin, (req, res) => {
    const rid = v.id(req.params.rid);
    if (!q.resident.get(rid, houseId(req))) throw notFound();
    tx(db, () => {
      q.deleteResident.run(rid, houseId(req));
      if (q.adminCount.get(houseId(req)).n === 0) throw new HttpError(400, 'A casa precisa de pelo menos um administrador com login.');
    });
    audit(req, req.session.userId, houseId(req), 'resident_deleted', String(rid));
    res.json({ ok: true });
  });

  // Convite: código de uso único, válido por 72h, guardado apenas como hash.
  r.post('/residents/:rid/invite', requireAdmin, (req, res) => {
    const rid = v.id(req.params.rid);
    const cur = q.resident.get(rid, houseId(req));
    if (!cur) throw notFound();
    if (cur.user_id) throw new HttpError(400, 'Esse morador já tem login.');
    const code = inviteCode();
    q.setInvite.run(sha256(normalizeInvite(code)), Date.now() + INVITE_TTL_MS, rid, houseId(req));
    audit(req, req.session.userId, houseId(req), 'invite_created', String(rid));
    res.json({ code, expiresInHours: INVITE_TTL_MS / 3600_000 });
  });

  // ---------- categorias ----------
  r.get('/categories', (req, res) => res.json(q.categories.all(houseId(req))));

  r.post('/categories', (req, res) => {
    const name = v.text(req.body?.name, 'Nome da categoria', { max: 60 });
    try {
      const id = Number(q.insertCategory.run(houseId(req), name).lastInsertRowid);
      res.status(201).json({ id });
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Já existe uma categoria com esse nome.');
      throw e;
    }
  });

  r.patch('/categories/:cid', (req, res) => {
    const cid = v.id(req.params.cid);
    if (!q.category.get(cid, houseId(req))) throw notFound();
    try {
      q.renameCategory.run(v.text(req.body?.name, 'Nome da categoria', { max: 60 }), cid, houseId(req));
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'Já existe uma categoria com esse nome.');
      throw e;
    }
    res.json({ ok: true });
  });

  r.delete('/categories/:cid', requireAdmin, (req, res) => {
    const cid = v.id(req.params.cid);
    if (!q.category.get(cid, houseId(req))) throw notFound();
    q.deleteCategory.run(cid, houseId(req)); // gastos ficam "Sem categoria"
    res.json({ ok: true });
  });

  // ---------- ganhos ----------
  function parseIncome(req) {
    const b = req.body ?? {};
    const residentId = residentInHouse(req, b.residentId);
    assertCanManageResident(req, residentId);
    const kind = v.oneOf(b.kind, ['recurring', 'once'], 'Tipo de ganho');
    const startMonth = v.month(b.startMonth, 'Mês');
    const endMonth = kind === 'recurring' ? v.month(b.endMonth, 'Mês final', { optional: true }) : null;
    if (endMonth && endMonth < startMonth) throw new HttpError(400, 'O mês final deve ser depois do inicial.');
    return [residentId, v.text(b.description, 'Descrição'), v.cents(b.amount), kind, startMonth, endMonth];
  }

  r.get('/incomes', (req, res) => res.json(q.incomes.all(houseId(req))));
  r.post('/incomes', (req, res) => {
    const id = Number(q.insertIncome.run(...parseIncome(req), Date.now()).lastInsertRowid);
    res.status(201).json({ id });
  });
  r.put('/incomes/:id', (req, res) => {
    const cur = q.income.get(v.id(req.params.id), houseId(req));
    if (!cur) throw notFound();
    assertCanManageResident(req, cur.resident_id);
    q.updateIncome.run(...parseIncome(req), cur.id);
    res.json({ ok: true });
  });
  r.delete('/incomes/:id', (req, res) => {
    const cur = q.income.get(v.id(req.params.id), houseId(req));
    if (!cur) throw notFound();
    assertCanManageResident(req, cur.resident_id);
    q.deleteIncome.run(cur.id);
    res.json({ ok: true });
  });

  // ---------- objetivos (% da renda) ----------
  r.get('/goals', (req, res) => res.json(q.goals.all(houseId(req))));
  r.post('/goals', (req, res) => {
    const residentId = residentInHouse(req, req.body?.residentId);
    assertCanManageResident(req, residentId);
    const name = v.text(req.body?.name, 'Objetivo', { max: 80 });
    const bp = v.percentBp(req.body?.percentBp);
    if (q.goalSum.get(residentId, 0).s + bp > 10000) throw new HttpError(400, 'A soma dos objetivos não pode passar de 100% da renda.');
    const id = Number(q.insertGoal.run(residentId, name, bp, Date.now()).lastInsertRowid);
    res.status(201).json({ id });
  });
  r.put('/goals/:id', (req, res) => {
    const cur = q.goal.get(v.id(req.params.id), houseId(req));
    if (!cur) throw notFound();
    assertCanManageResident(req, cur.resident_id);
    const bp = v.percentBp(req.body?.percentBp);
    if (q.goalSum.get(cur.resident_id, cur.id).s + bp > 10000) throw new HttpError(400, 'A soma dos objetivos não pode passar de 100% da renda.');
    q.updateGoal.run(v.text(req.body?.name, 'Objetivo', { max: 80 }), bp, cur.id);
    res.json({ ok: true });
  });
  r.delete('/goals/:id', (req, res) => {
    const cur = q.goal.get(v.id(req.params.id), houseId(req));
    if (!cur) throw notFound();
    assertCanManageResident(req, cur.resident_id);
    q.deleteGoal.run(cur.id);
    res.json({ ok: true });
  });

  // ---------- gastos ----------
  function parseExpense(req) {
    const b = req.body ?? {};
    const residentId = residentInHouse(req, b.residentId, { optional: true }); // vazio = gasto da casa
    if (residentId !== null) assertCanManageResident(req, residentId);
    return [residentId, categoryInHouse(req, b.categoryId), v.text(b.description, 'Descrição'), v.cents(b.amount), v.date(b.date)];
  }
  function assertCanEditExpense(req, e) {
    if (req.house.isAdmin || e.created_by === req.session.userId || (e.resident_id && e.resident_id === req.house.residentId)) return;
    throw new HttpError(403, 'Você só pode alterar gastos lançados por você.');
  }

  r.get('/expenses', (req, res) => {
    const month = v.month(req.query.month ?? currentMonth());
    res.json(finance.monthSummary(houseId(req), month).expenses);
  });
  r.post('/expenses', (req, res) => {
    const id = Number(q.insertExpense.run(houseId(req), ...parseExpense(req), req.session.userId, Date.now()).lastInsertRowid);
    res.status(201).json({ id });
  });
  r.put('/expenses/:id', (req, res) => {
    const cur = q.expense.get(v.id(req.params.id), houseId(req));
    if (!cur) throw notFound();
    assertCanEditExpense(req, cur);
    q.updateExpense.run(...parseExpense(req), cur.id);
    res.json({ ok: true });
  });
  r.delete('/expenses/:id', (req, res) => {
    const cur = q.expense.get(v.id(req.params.id), houseId(req));
    if (!cur) throw notFound();
    assertCanEditExpense(req, cur);
    q.deleteExpense.run(cur.id);
    res.json({ ok: true });
  });

  // ---------- descontos automáticos (dízimo, aluguel, parcelas...) ----------
  function parseRecurring(req) {
    const b = req.body ?? {};
    const residentId = residentInHouse(req, b.residentId, { optional: true });
    if (residentId === null) {
      if (!req.house.isAdmin) throw new HttpError(403, 'Apenas administradores criam descontos da casa.');
    } else assertCanManageResident(req, residentId);
    const mode = v.oneOf(b.mode, ['fixed', 'percent'], 'Tipo de desconto');
    const amount = mode === 'fixed' ? v.cents(b.amount) : null;
    const bp = mode === 'percent' ? v.percentBp(b.percentBp) : null;
    const startMonth = v.month(b.startMonth, 'Mês inicial');
    const installments = v.intRange(b.installments, 'Número de parcelas', 1, 600, { optional: true });
    const endMonth = v.month(b.endMonth, 'Mês final', { optional: true });
    if (endMonth && endMonth < startMonth) throw new HttpError(400, 'O mês final deve ser depois do inicial.');
    const active = b.active === false ? 0 : 1;
    return [residentId, categoryInHouse(req, b.categoryId), v.text(b.description, 'Descrição'), mode, amount, bp, startMonth, installments, endMonth, active];
  }
  function assertCanEditRecurring(req, row) {
    if (req.house.isAdmin) return;
    if (!row.resident_id || row.resident_id !== req.house.residentId) throw new HttpError(403, 'Você só pode alterar os seus próprios descontos.');
  }

  r.get('/recurring', (req, res) => res.json(q.recurringAll.all(houseId(req))));
  r.post('/recurring', (req, res) => {
    const id = Number(q.insertRecurring.run(houseId(req), ...parseRecurring(req), Date.now()).lastInsertRowid);
    res.status(201).json({ id });
  });
  r.put('/recurring/:id', (req, res) => {
    const cur = q.recurring.get(v.id(req.params.id), houseId(req));
    if (!cur) throw notFound();
    assertCanEditRecurring(req, cur);
    q.updateRecurring.run(...parseRecurring(req), cur.id);
    res.json({ ok: true });
  });
  r.delete('/recurring/:id', (req, res) => {
    const cur = q.recurring.get(v.id(req.params.id), houseId(req));
    if (!cur) throw notFound();
    assertCanEditRecurring(req, cur);
    q.deleteRecurring.run(cur.id);
    res.json({ ok: true });
  });

  // ---------- painel ----------
  r.get('/dashboard', (req, res) => {
    const month = v.month(req.query.month ?? currentMonth());
    res.json({ ...finance.monthSummary(houseId(req), month), trend: finance.trend(houseId(req), month, 6) });
  });

  // ---------- IA ----------
  r.get('/ai', (req, res) => {
    const s = q.aiGet.get(houseId(req));
    res.json({
      providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, { label: p.label, defaultModel: p.defaultModel, defaultBaseUrl: p.defaultBaseUrl ?? null }])),
      settings: s ? { provider: s.provider, model: s.model, baseUrl: s.base_url, hasKey: !!s.api_key_enc, keyHint: s.key_hint } : null,
    });
  });

  r.put('/ai', requireAdmin, wrap(async (req, res) => {
    const b = req.body ?? {};
    const provider = v.oneOf(b.provider, Object.keys(PROVIDERS), 'Provedor');
    const model = v.text(b.model || PROVIDERS[provider].defaultModel, 'Modelo', { max: 100 });
    if (!/^[\w.:\/-]+$/.test(model)) throw new HttpError(400, 'Nome de modelo inválido.');
    let baseUrl = null;
    if (provider === 'openai') {
      baseUrl = v.text(b.baseUrl || PROVIDERS.openai.defaultBaseUrl, 'URL base', { max: 300 });
      try {
        await assertSafeBaseUrl(baseUrl, { allowLocal: cfg.allowLocalAi });
      } catch (e) {
        throw new HttpError(400, e.message);
      }
    }
    const prev = q.aiGet.get(houseId(req));
    let keyEnc = prev?.provider === provider ? prev.api_key_enc : null;
    let hint = prev?.provider === provider ? prev.key_hint : null;
    if (typeof b.apiKey === 'string' && b.apiKey.trim()) {
      const key = b.apiKey.trim();
      if (key.length > 500 || /\s/.test(key)) throw new HttpError(400, 'Chave de API inválida.');
      keyEnc = encrypt(key, cfg.encryptionKey);
      hint = key.slice(-4);
    }
    if (b.removeKey === true) {
      keyEnc = null;
      hint = null;
    }
    q.aiUpsert.run(houseId(req), provider, model, baseUrl, keyEnc, hint, Date.now());
    audit(req, req.session.userId, houseId(req), 'ai_settings_changed', provider);
    res.json({ ok: true });
  }));

  r.delete('/ai', requireAdmin, (req, res) => {
    q.aiDelete.run(houseId(req));
    res.json({ ok: true });
  });

  r.post('/ai/chat',
    rateLimitMiddleware(aiLimiter, (req) => `ai:${req.session.userId}`, 'Limite de perguntas à IA por hora atingido.'),
    wrap(async (req, res) => {
      const s = q.aiGet.get(houseId(req));
      if (!s) throw new HttpError(400, 'A IA ainda não foi configurada nesta casa.');
      const month = v.month(req.body?.month ?? currentMonth());
      const summary = finance.monthSummary(houseId(req), month);
      const context = buildContext(q.house.get(houseId(req)).name, summary);
      const apiKey = s.api_key_enc ? decrypt(s.api_key_enc, cfg.encryptionKey) : null;
      const answer = await chat({ provider: s.provider, model: s.model, baseUrl: s.base_url, apiKey }, context, req.body?.messages, cfg);
      res.json({ answer, provider: s.provider, model: s.model });
    }));

  return r;
}
