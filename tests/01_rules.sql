-- Testes das regras de acesso (RLS) e de integridade do banco.
-- Rodar com:  npm run test:db
\set ON_ERROR_STOP on

create schema t;
grant usage on schema t to anon, authenticated;
create table t.ids (name text primary key, id uuid);
grant all on t.ids to anon, authenticated;

create function t.as_user(u uuid) returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claim.sub', u::text, false); perform set_config('request.jwt.claims', '', false); execute 'set role authenticated'; end $$;
create function t.as_anon() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claim.sub', '', false); execute 'set role anon'; end $$;
create function t.as_root() returns void language plpgsql as $$
begin execute 'reset role'; perform set_config('request.jwt.claim.sub', '', false); end $$;
create function t.id(n text) returns uuid language sql stable as $$ select id from t.ids where name = n $$;
create function t.put(n text, v uuid) returns void language sql as $$ insert into t.ids values (n, v) on conflict (name) do update set id = v $$;
create function t.expect_fail(sql text, needle text) returns void language plpgsql as $$
begin
  begin execute sql;
  exception when others then
    if position(lower(needle) in lower(sqlerrm)) = 0 then
      raise exception 'FALHA: erro inesperado para [%]: %', sql, sqlerrm; end if;
    raise notice 'ok  bloqueado: %', left(sql, 70);
    return;
  end;
  raise exception 'FALHA: deveria ter falhado: %', sql;
end $$;
create function t.eq(label text, got text, want text) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'FALHA %: obtido=% esperado=%', label, got, want; end if;
  raise notice 'ok  %', label;
end $$;
create table t.codes (name text primary key, code text);
grant all on t.codes to anon, authenticated;
grant execute on all functions in schema t to anon, authenticated;

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-00000000000a', 'ana@a.com'),    -- admin da casa A
  ('b0000000-0000-0000-0000-00000000000b', 'beto@a.com'),   -- morador da casa A (entra por convite)
  ('c0000000-0000-0000-0000-00000000000c', 'carla@c.com');  -- dona da casa C (intrusa para A)

-- ── criar casas ───────────────────────────────────────────────────────────
select t.as_user('a0000000-0000-0000-0000-00000000000a');
select t.put('houseA', public.create_house('Casa A', 'Ana'));
select t.eq('15 categorias padrão de saída', (select count(*) from public.categories where house_id = t.id('houseA') and type = 'expense')::text, '15');
select t.put('ana', (select id from public.residents where house_id = t.id('houseA') and name = 'Ana'));
insert into public.residents (house_id, name) values (t.id('houseA'), 'Beto');
insert into public.residents (house_id, name) values (t.id('houseA'), 'Filho');
select t.put('beto', (select id from public.residents where name = 'Beto'));
select t.put('filho', (select id from public.residents where name = 'Filho'));
select t.put('catMercado', (select id from public.categories where house_id = t.id('houseA') and name = 'Mercado'));
insert into t.codes values ('beto', public.create_invite(t.id('beto')));

select t.as_user('c0000000-0000-0000-0000-00000000000c');
select t.put('houseC', public.create_house('Casa C', 'Carla'));
select t.put('catC', (select id from public.categories where house_id = t.id('houseC') and name = 'Mercado'));

-- ── convite ───────────────────────────────────────────────────────────────
select t.as_user('b0000000-0000-0000-0000-00000000000b');
select t.eq('antes do convite Beto não vê a casa A', (select count(*) from public.houses)::text, '0');
select t.expect_fail($$ select public.join_house('AAAA-BBBB-CCCC') $$, 'invalid_invite');
select t.eq('convite aceito (minúsculas e sem traço também)', public.join_house(lower(replace((select code from t.codes where name = 'beto'), '-', '')))::text, t.id('houseA')::text);
select t.expect_fail($$ select public.join_house((select code from t.codes where name = 'beto')) $$, 'invalid_invite');
select t.eq('depois Beto vê a casa A', (select count(*) from public.houses)::text, '1');
select t.eq('Beto não vê hashes de convite', (select count(*) from public.invites)::text, '0');

-- ── visitante não logado ──────────────────────────────────────────────────
select t.as_anon();
select t.expect_fail($$ select count(*) from public.transactions $$, 'permission denied');
select t.expect_fail($$ select public.create_house('x', 'y') $$, 'permission denied');

-- ── isolamento entre casas (intrusa Carla) ────────────────────────────────
select t.as_user('c0000000-0000-0000-0000-00000000000c');
select t.eq('Carla não vê moradores de A', (select count(*) from public.residents where house_id = t.id('houseA'))::text, '0');
select t.expect_fail(format($$ insert into public.transactions (house_id, description, amount_cents, date) values (%L, 'x', 100, '2026-01-01') $$, t.id('houseA')), 'row-level security');
select t.expect_fail(format($$ insert into public.residents (house_id, name) values (%L, 'Invasor') $$, t.id('houseA')), 'row-level security');
select t.expect_fail(format($$ select public.create_invite(%L) $$, t.id('filho')), 'forbidden');
-- usar categoria da casa A num gasto da casa C: barrado pela chave estrangeira composta
select t.expect_fail(format($$ insert into public.transactions (house_id, category_id, description, amount_cents, date) values (%L, %L, 'x', 100, '2026-01-01') $$, t.id('houseC'), t.id('catMercado')), 'foreign key');
update public.houses set name = 'hackeada' where id = t.id('houseA');
delete from public.transactions where house_id = t.id('houseA');

-- ── permissões dentro da casa ─────────────────────────────────────────────
select t.as_user('b0000000-0000-0000-0000-00000000000b');
insert into public.incomes (house_id, resident_id, description, amount_cents, kind, start_month)
  values (t.id('houseA'), t.id('beto'), 'Salário', 300000, 'recurring', '2026-01');
select t.expect_fail(format($$ insert into public.incomes (house_id, resident_id, description, amount_cents, kind, start_month) values (%L, %L, 'x', 1, 'once', '2026-01') $$, t.id('houseA'), t.id('ana')), 'row-level security');
select t.expect_fail(format($$ insert into public.recurring (house_id, description, mode, amount_cents, start_month) values (%L, 'Aluguel', 'fixed', 100, '2026-01') $$, t.id('houseA')), 'row-level security');
update public.residents set role = 'admin' where id = t.id('beto');   -- RLS: não altera nada
select t.eq('morador não promove a si mesmo', (select role from public.residents where id = t.id('beto')), 'member');
insert into public.transactions (house_id, description, amount_cents, date, created_by)
  values (t.id('houseA'), 'Pão', 1500, '2026-03-02', 'a0000000-0000-0000-0000-00000000000a');
select t.eq('autor do gasto não pode ser forjado', (select created_by::text from public.transactions where description = 'Pão'), 'b0000000-0000-0000-0000-00000000000b');
select t.expect_fail(format($$ update public.transactions set house_id = %L where description = 'Pão' $$, t.id('houseC')), 'house_id_immutable');
insert into public.goals (house_id, resident_id, name, percent_bp) values (t.id('houseA'), t.id('beto'), 'Reserva', 6000);
select t.expect_fail(format($$ insert into public.goals (house_id, resident_id, name, percent_bp) values (%L, %L, 'Demais', 5000) $$, t.id('houseA'), t.id('beto')), 'goals_over_100');
delete from public.categories where id = t.id('catMercado');   -- RLS: não apaga nada

-- ── admin ─────────────────────────────────────────────────────────────────
select t.as_user('a0000000-0000-0000-0000-00000000000a');
select t.eq('categoria continua (só admin exclui)', (select count(*) from public.categories where id = t.id('catMercado'))::text, '1');
insert into public.transactions (house_id, resident_id, description, amount_cents, date) values (t.id('houseA'), t.id('filho'), 'Material escolar', 9000, '2026-03-05');
insert into public.recurring (house_id, description, mode, amount_cents, start_month, category_id) values (t.id('houseA'), 'Aluguel', 'fixed', 150000, '2026-01', t.id('catMercado'));
select t.expect_fail(format($$ update public.residents set user_id = 'c0000000-0000-0000-0000-00000000000c' where id = %L $$, t.id('filho')), 'resident_link_via_invite');
select t.expect_fail(format($$ update public.residents set role = 'member' where id = %L $$, t.id('ana')), 'need_one_admin');
select t.expect_fail(format($$ delete from public.residents where id = %L $$, t.id('ana')), 'need_one_admin');
select t.eq('admin não vê a chave de IA', (select has_table_privilege('authenticated', 'public.ai_secrets', 'select'))::text, 'false');
delete from public.categories where id = t.id('catMercado');
select t.eq('gasto fica sem categoria ao excluir a categoria', (select count(*) from public.recurring where category_id is null)::text, '1');
select t.eq('casa A no nome original', (select name from public.houses where id = t.id('houseA')), 'Casa A');
select t.eq('gastos de A intactos', (select count(*) from public.transactions where house_id = t.id('houseA'))::text, '2');
delete from public.houses where id = t.id('houseA');
select t.eq('excluir casa apaga tudo dela', (select count(*) from public.residents where house_id = t.id('houseA'))::text, '0');
