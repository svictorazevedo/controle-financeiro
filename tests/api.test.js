import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let server;
let base;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-test-'));

before(async () => {
  const cfg = loadConfig({ dataDir: tmp, databasePath: ':memory:', encryptionKey: crypto.randomBytes(32), cookieSecure: false, allowRegistration: true, authAttemptsPer15Min: 1000 });
  const { app } = createApp(cfg);
  await new Promise((res) => {
    server = app.listen(0, '127.0.0.1', res);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Cliente HTTP mínimo que guarda cookie e token CSRF, como o navegador. */
function client() {
  let cookie = '';
  let csrf = '';
  async function call(method, url, body, { skipCsrf = false, headers = {} } = {}) {
    const h = { ...headers };
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    if (csrf && !skipCsrf) h['x-csrf-token'] = csrf;
    const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const json = await res.json().catch(() => null);
    if (json?.csrf) csrf = json.csrf;
    return { status: res.status, body: json, headers: res.headers };
  }
  return { call, get cookie() { return cookie; } };
}

async function newUser(name) {
  const c = client();
  const email = `${name}-${crypto.randomUUID()}@exemplo.com`;
  const r = await c.call('POST', '/api/auth/register', { name, email, password: 'Senha-forte-123' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await c.call('GET', '/api/auth/me');
  return { c, email };
}

test('cadastro, login e senha fraca', async () => {
  const c = client();
  const weak = await c.call('POST', '/api/auth/register', { name: 'A', email: 'a@exemplo.com', password: '123' });
  assert.equal(weak.status, 400);

  const { email } = await newUser('ana');
  const bad = await client().call('POST', '/api/auth/login', { email, password: 'errada-123456' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'E-mail ou senha incorretos.');
  const unknown = await client().call('POST', '/api/auth/login', { email: 'ninguem@exemplo.com', password: 'qualquer-1234' });
  assert.equal(unknown.body.error, bad.body.error, 'mensagem não pode revelar se o e-mail existe');

  const ok = await client().call('POST', '/api/auth/login', { email, password: 'Senha-forte-123' });
  assert.equal(ok.status, 200);
});

test('cookie de sessão é HttpOnly e SameSite=Strict', async () => {
  const c = client();
  const r = await fetch(base + '/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Cookie', email: `cookie-${Date.now()}@exemplo.com`, password: 'Senha-forte-123' }),
  });
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Strict/i);
  assert.ok(c);
});

test('bloqueio da conta após 5 senhas erradas', async () => {
  const { email } = await newUser('bloq');
  for (let i = 0; i < 5; i++) await client().call('POST', '/api/auth/login', { email, password: `errada-${i}-abcdef` });
  const r = await client().call('POST', '/api/auth/login', { email, password: 'Senha-forte-123' });
  assert.equal(r.status, 429);
});

test('CSRF: sem token, com origem externa ou sem JSON => bloqueado', async () => {
  const { c } = await newUser('csrf');
  assert.equal((await c.call('POST', '/api/houses', { name: 'Casa' }, { skipCsrf: true })).status, 403);
  assert.equal((await c.call('POST', '/api/houses', { name: 'Casa' }, { headers: { origin: 'https://site-malicioso.com' } })).status, 403);
  const form = await fetch(base + '/api/houses', { method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Casa' });
  assert.equal(form.status, 415);
  assert.equal((await c.call('POST', '/api/houses', { name: 'Casa' })).status, 201);
});

test('sem login não acessa nada', async () => {
  const r = await client().call('GET', '/api/houses/1/dashboard');
  assert.equal(r.status, 401);
});

test('isolamento entre casas (IDOR)', async () => {
  const a = await newUser('dono');
  const h = (await a.c.call('POST', '/api/houses', { name: 'Casa A' })).body.id;
  const b = await newUser('intruso');
  for (const url of ['', '/dashboard', '/incomes', '/expenses', '/ai']) {
    assert.equal((await b.c.call('GET', `/api/houses/${h}${url}`)).status, 404, url);
  }
  assert.equal((await b.c.call('POST', `/api/houses/${h}/expenses`, { description: 'x', amount: 100, date: '2026-01-01' })).status, 404);

  // a categoria/morador de outra casa não pode ser usada
  const hb = (await b.c.call('POST', '/api/houses', { name: 'Casa B' })).body.id;
  const catA = (await a.c.call('GET', `/api/houses/${h}/categories`)).body[0].id;
  const r = await b.c.call('POST', `/api/houses/${hb}/expenses`, { description: 'x', amount: 100, date: '2026-01-01', categoryId: catA });
  assert.equal(r.status, 400);
});

test('painel: ganhos, gastos, dízimo, parcelas e objetivos', async () => {
  const { c } = await newUser('fin');
  const h = (await c.call('POST', '/api/houses', { name: 'Família' })).body.id;
  const house = (await c.call('GET', `/api/houses/${h}`)).body;
  const me = house.me.residentId;
  const cat = (n) => house.categories.find((x) => x.name === n).id;
  const P = (u, b) => c.call('POST', `/api/houses/${h}${u}`, b);

  assert.equal((await P('/incomes', { residentId: me, description: 'Salário', amount: 500000, kind: 'recurring', startMonth: '2026-01' })).status, 201);
  await P('/incomes', { residentId: me, description: 'Freela', amount: 100000, kind: 'once', startMonth: '2026-03' });
  await P('/recurring', { residentId: me, description: 'Dízimo', mode: 'percent', percentBp: 1000, startMonth: '2026-01', categoryId: cat('Dízimo e ofertas') });
  await P('/recurring', { description: 'Aluguel', mode: 'fixed', amount: 150000, startMonth: '2026-01', categoryId: cat('Moradia') });
  await P('/recurring', { residentId: me, description: 'Geladeira', mode: 'fixed', amount: 30000, startMonth: '2026-02', installments: 3 });
  await P('/expenses', { residentId: me, description: 'Mercado', amount: 80000, date: '2026-03-10', categoryId: cat('Mercado') });
  await P('/goals', { residentId: me, name: 'Reserva', percentBp: 1500 });
  assert.equal((await P('/goals', { residentId: me, name: 'Demais', percentBp: 9000 })).status, 400, 'soma > 100%');

  const m3 = (await c.call('GET', `/api/houses/${h}/dashboard?month=2026-03`)).body;
  assert.equal(m3.totals.income, 600000);                 // 5000 + 1000
  const dizimo = m3.automatic.find((a) => a.description === 'Dízimo');
  assert.equal(dizimo.amount, 60000);                       // 10% de 6000
  assert.equal(m3.automatic.find((a) => a.description === 'Geladeira').detail, 'Parcela 2/3');
  assert.equal(m3.totals.expenses, 80000 + 60000 + 150000 + 30000);
  assert.equal(m3.totals.balance, 600000 - 320000);
  assert.equal(m3.residents[0].goals[0].target, 90000);     // 15% de 6000

  const m5 = (await c.call('GET', `/api/houses/${h}/dashboard?month=2026-05`)).body;
  assert.equal(m5.automatic.find((a) => a.description === 'Geladeira'), undefined, 'parcelas terminadas somem');
  assert.equal(m5.trend.length, 6);
});

test('membro comum não altera dados de outro morador', async () => {
  const admin = await newUser('admin');
  const h = (await admin.c.call('POST', '/api/houses', { name: 'Casa' })).body.id;
  const adminRes = (await admin.c.call('GET', `/api/houses/${h}`)).body.me.residentId;
  const rid = (await admin.c.call('POST', `/api/houses/${h}/residents`, { name: 'Filho' })).body.id;
  const { code } = (await admin.c.call('POST', `/api/houses/${h}/residents/${rid}/invite`, {})).body;

  const m = await newUser('membro');
  assert.equal((await m.c.call('POST', '/api/houses/join', { code: code.toLowerCase() })).status, 200);
  assert.equal((await m.c.call('POST', '/api/houses/join', { code })).status, 400, 'convite é de uso único');
  assert.equal((await m.c.call('POST', `/api/houses/${h}/incomes`, { residentId: adminRes, description: 'x', amount: 1, kind: 'once', startMonth: '2026-01' })).status, 403);
  assert.equal((await m.c.call('POST', `/api/houses/${h}/incomes`, { residentId: rid, description: 'Mesada', amount: 1000, kind: 'once', startMonth: '2026-01' })).status, 201);
  assert.equal((await m.c.call('PUT', `/api/houses/${h}/ai`, { provider: 'anthropic' })).status, 403);
});

test('chave de IA é criptografada e nunca volta ao navegador; URL interna é bloqueada', async () => {
  const { c } = await newUser('ia');
  const h = (await c.call('POST', '/api/houses', { name: 'Casa IA' })).body.id;
  const r = await c.call('PUT', `/api/houses/${h}/ai`, { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-ant-segredo-1234' });
  assert.equal(r.status, 200);
  const g = await c.call('GET', `/api/houses/${h}/ai`);
  assert.equal(JSON.stringify(g.body).includes('segredo'), false);
  assert.equal(g.body.settings.keyHint, '1234');

  for (const url of ['http://169.254.169.254/latest', 'https://127.0.0.1/v1', 'https://10.0.0.5/v1', 'http://localhost:11434/v1', 'file:///etc/passwd']) {
    const s = await c.call('PUT', `/api/houses/${h}/ai`, { provider: 'openai', model: 'x', baseUrl: url });
    assert.equal(s.status, 400, url);
  }
});

test('cabeçalhos de segurança', async () => {
  const r = await fetch(base + '/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});
