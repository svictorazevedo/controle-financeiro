// Testes do banco SEM Docker: Postgres em WebAssembly (PGlite) + um mini-psql (set, echo, gset, :'var').
// Uso: npm i --no-save @electric-sql/pglite@0.3.14 && npm run test:db
// Avançado: node tests/run-pglite.mjs . tests/01_rules.sql --from-old <schema-antigo.sql> <migracao.sql>
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const [repo, testFile, flag, oldSchema, migration] = process.argv.slice(2);
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const db = new PGlite();
const notices = [];
const vars = {};

// Separa instruções como o psql: respeita 'texto', "ident", $tag$…$tag$, comentários -- e de bloco.
function split(sql) {
  const out = []; let cur = ''; let i = 0;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (c === '-' && n === '-') { const j = sql.indexOf('\n', i); const e = j < 0 ? sql.length : j; cur += sql.slice(i, e); i = e; continue; }
    if (c === '/' && n === '*') { const j = sql.indexOf('*/', i + 2) + 2; cur += sql.slice(i, j); i = j; continue; }
    if (c === "'" || c === '"') { let j = i + 1; while (j < sql.length) { if (sql[j] === c) { if (sql[j + 1] === c) { j += 2; continue; } break; } j++; } cur += sql.slice(i, j + 1); i = j + 1; continue; }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) { const tag = m[0]; const j = sql.indexOf(tag, i + tag.length); const e = j < 0 ? sql.length : j + tag.length; cur += sql.slice(i, e); i = e; continue; }
    }
    if (c === ';') { if (cur.trim()) out.push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
let lastStmt = '';
async function execChunk(sql) {
  sql = sql.replace(/:'([a-z_][a-z0-9_]*)'/gi, (_, v) => {
    if (!(v in vars)) throw new Error('variável não definida: ' + v);
    return `'${String(vars[v]).replace(/'/g, "''")}'`;
  });
  for (const st of split(sql)) {
    if (!st.replace(/--.*$/gm, '').trim()) continue;
    lastStmt = st;
    await db.query(st, [], { onNotice: (n) => notices.push(n.message) });
  }
}

async function runScript(text, label) {
  const lines = text.split('\n');
  let buf = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^\\(set|pset)\b/.test(t)) continue;
    if (/^\\echo/.test(t)) { await execChunk(buf.join('\n')); buf = []; console.log(t.replace(/^\\echo\s*/, '').replace(/^'|'$/g, '')); continue; }
    if (/\\gset\s*$/.test(t)) {
      // a instrução começa depois da última linha do buffer terminada em ';'
      let k = buf.length; while (k > 0 && !/;\s*(--.*)?$/.test(buf[k - 1])) k--;
      await execChunk(buf.slice(0, k).join('\n'));
      const stmt = [...buf.slice(k), line.replace(/\\gset\s*$/, '')].join('\n')
        .replace(/:'([a-z_][a-z0-9_]*)'/gi, (_, v) => `'${String(vars[v]).replace(/'/g, "''")}'`);
      const r = await db.query(stmt, [], { onNotice: (n) => notices.push(n.message) });
      Object.assign(vars, r.rows[0]);
      buf = []; continue;
    }
    buf.push(line);
  }
  await execChunk(buf.join('\n'));
  console.log(`[${label}] ok`);
}

db.onNotice?.((n) => notices.push(n.message));
try {
  await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin;`);
  await runScript(read(`${repo}/tests/00_stub_supabase.sql`).replace(/^create role.*$/m, ''), 'stub');
  if (flag === '--from-old') {
    await runScript(read(oldSchema), 'schema antigo');
    await runScript(read(migration), 'migração');
  } else {
    await runScript(read(`${repo}/supabase/schema.sql`), 'schema');
  }
  if (testFile && testFile !== '-') await runScript(read(testFile), 'testes');
} catch (e) {
  console.error('ERRO:', e.message);
  console.error('na instrução:', lastStmt.trim().slice(0, 400));
  process.exitCode = 1;
}
if (process.env.SHOW_NOTICES) notices.forEach((n) => console.log('  ' + n));
else console.log(`${notices.filter((n) => n.startsWith('ok')).length} verificações "ok"`);
