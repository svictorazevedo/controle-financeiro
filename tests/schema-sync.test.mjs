// O bloco de políticas RLS precisa ser idêntico na instalação nova e na migração da v1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const block = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  .match(/-- >>> POLÍTICAS\n[\s\S]*?-- <<< POLÍTICAS/)?.[0];

test('políticas iguais em schema.sql e migrations/002_v2.sql', () => {
  const a = block('supabase/schema.sql');
  assert.ok(a && a.length > 1000);
  assert.equal(block('supabase/migrations/002_v2.sql'), a);
});
