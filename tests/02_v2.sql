-- Testes da v2: contas, entradas, subcategorias, orçamento, metas, permissões por tela, 2FA e comprovantes.
-- Usa as funções auxiliares (schema t) criadas em 01_rules.sql.
\set ON_ERROR_STOP on
reset role;

create function t.as_user_aal(u uuid, aal text) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', u::text, false);
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'aal', aal)::text, false);
  execute 'set role authenticated';
end $$;
grant execute on function t.as_user_aal(uuid, text) to authenticated;

insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-00000000000d', 'dani@d.com'),   -- admin da casa D
  ('e0000000-0000-0000-0000-00000000000e', 'edu@d.com');    -- colaborador da casa D

select t.as_user('d0000000-0000-0000-0000-00000000000d');
select t.put('houseD', public.create_house('Empresa D', 'Dani'));
select t.eq('contas padrão', (select string_agg(name, ',' order by name) from public.accounts where house_id = t.id('houseD')), 'Carteira,Conta principal');
select t.eq('categorias de entrada padrão', (select count(*) from public.categories where house_id = t.id('houseD') and type = 'income')::text, '5');
select t.eq('todas as categorias têm cor', (select count(*) from public.categories where house_id = t.id('houseD') and color is null)::text, '0');
select t.put('conta', (select id from public.accounts where house_id = t.id('houseD') and name = 'Conta principal'));
select t.put('salario', (select id from public.categories where house_id = t.id('houseD') and name = 'Salário'));
select t.put('mercado', (select id from public.categories where house_id = t.id('houseD') and name = 'Mercado'));
insert into public.residents (house_id, name) values (t.id('houseD'), 'Edu');
select t.put('edu', (select id from public.residents where house_id = t.id('houseD') and name = 'Edu'));
insert into t.codes values ('edu', public.create_invite(t.id('edu')));

-- moeda, logo e ícone
update public.houses set currency = 'USD', logo = 'data:image/png;base64,iVBORw0KGgo=' where id = t.id('houseD');
select t.eq('moeda salva', (select currency from public.houses where id = t.id('houseD')), 'USD');
select t.expect_fail(format($$ update public.houses set logo = 'data:image/svg+xml;base64,PHN2Zz4=' where id = %L $$, t.id('houseD')), 'check');
select t.expect_fail(format($$ update public.houses set currency = 'real' where id = %L $$, t.id('houseD')), 'check');

-- subcategorias
insert into public.categories (house_id, name, type, parent_id, color) values (t.id('houseD'), 'Hortifruti', 'expense', t.id('mercado'), '#1baf7a');
select t.put('horti', (select id from public.categories where name = 'Hortifruti'));
select t.expect_fail(format($$ insert into public.categories (house_id, name, type, parent_id) values (%L, 'Neta', 'expense', %L) $$, t.id('houseD'), t.id('horti')), 'category_tree_invalid');
select t.expect_fail(format($$ insert into public.categories (house_id, name, type, parent_id) values (%L, 'Tipo errado', 'income', %L) $$, t.id('houseD'), t.id('mercado')), 'category_tree_invalid');
insert into public.categories (house_id, name, type, parent_id) values (t.id('houseD'), 'Outros', 'expense', t.id('mercado'));
select t.eq('mesmo nome em níveis diferentes', (select count(*) from public.categories where house_id = t.id('houseD') and name = 'Outros')::text, '2');

-- lançamentos de entrada e saída com conta
insert into public.transactions (house_id, type, account_id, category_id, description, amount_cents, date)
  values (t.id('houseD'), 'income', t.id('conta'), t.id('salario'), 'Salário', 500000, '2026-11-05');
select t.expect_fail(format($$ insert into public.transactions (house_id, type, category_id, description, amount_cents, date) values (%L, 'income', %L, 'x', 1, '2026-11-01') $$, t.id('houseD'), t.id('mercado')), 'category_type_mismatch');
select t.expect_fail(format($$ insert into public.recurring (house_id, category_id, description, mode, amount_cents, start_month) values (%L, %L, 'x', 'fixed', 1, '2026-01') $$, t.id('houseD'), t.id('salario')), 'category_type_mismatch');
select t.expect_fail(format($$ update public.categories set type = 'income' where id = %L $$, t.id('mercado')), 'category');
select t.expect_fail(format($$ delete from public.accounts where id = %L $$, t.id('conta')), 'foreign key');
select t.expect_fail(format($$ insert into public.transactions (house_id, description, amount_cents, date, attachment_path) values (%L, 'x', 1, '2026-11-01', 'outra-casa/x.pdf') $$, t.id('houseD')), 'check');

-- orçamento
insert into public.budgets (house_id, category_id, amount_cents) values (t.id('houseD'), t.id('mercado'), 120000);
insert into public.budgets (house_id, category_id, month, amount_cents) values (t.id('houseD'), t.id('mercado'), '2026-12', 200000);
select t.expect_fail(format($$ insert into public.budgets (house_id, category_id, amount_cents) values (%L, %L, 1) $$, t.id('houseD'), t.id('mercado')), 'duplicate');
select t.expect_fail(format($$ insert into public.budgets (house_id, category_id, amount_cents) values (%L, %L, 1) $$, t.id('houseD'), t.id('salario')), 'budget_income_category');

-- metas de economia
insert into public.savings_goals (house_id, name, target_cents, target_date) values (t.id('houseD'), 'Viagem', 1000000, '2027-06-30');
select t.put('viagem', (select id from public.savings_goals where name = 'Viagem'));
insert into public.goal_deposits (house_id, goal_id, amount_cents, date) values (t.id('houseD'), t.id('viagem'), 50000, '2026-11-10');
select t.expect_fail(format($$ insert into public.goal_deposits (house_id, goal_id, amount_cents, date) values (%L, %L, 0, '2026-11-10') $$, t.id('houseD'), t.id('viagem')), 'check');

-- ── colaborador com as permissões padrão ─────────────────────────────────
select t.as_user('e0000000-0000-0000-0000-00000000000e');
select public.join_house((select code from t.codes where name = 'edu'));
select t.eq('colaborador vê os lançamentos', (select count(*) from public.transactions where house_id = t.id('houseD'))::text, '1');
insert into public.transactions (house_id, type, account_id, category_id, description, amount_cents, date)
  values (t.id('houseD'), 'expense', t.id('conta'), t.id('horti'), 'Feira', 8000, '2026-11-12');
select t.expect_fail(format($$ insert into public.accounts (house_id, name) values (%L, 'Conta do Edu') $$, t.id('houseD')), 'row-level security');
select t.expect_fail(format($$ insert into public.budgets (house_id, category_id, month, amount_cents) values (%L, %L, '2026-11', 1) $$, t.id('houseD'), t.id('mercado')), 'row-level security');
insert into public.goal_deposits (house_id, goal_id, amount_cents, date) values (t.id('houseD'), t.id('viagem'), 10000, '2026-11-15');
update public.residents set permissions = '{"contas": 2}' where id = t.id('edu');   -- RLS: não altera nada
select t.eq('colaborador não muda as próprias permissões', (select permissions::text from public.residents where id = t.id('edu')), '{}');
insert into storage.objects (bucket_id, name) values ('receipts', t.id('houseD')::text || '/nota.pdf');
select t.eq('colaborador vê o comprovante', (select count(*) from storage.objects where bucket_id = 'receipts')::text, '1');

-- intrusa (Carla, da casa C) não vê nem envia comprovantes da casa D
select t.as_user('c0000000-0000-0000-0000-00000000000c');
select t.eq('intrusa não vê comprovantes', (select count(*) from storage.objects)::text, '0');
select t.expect_fail(format($$ insert into storage.objects (bucket_id, name) values ('receipts', %L) $$, t.id('houseD')::text || '/x.pdf'), 'row-level security');
select t.expect_fail($$ insert into storage.objects (bucket_id, name) values ('receipts', 'nao-e-uuid/x.pdf') $$, 'row-level security');
select t.eq('intrusa não vê metas', (select count(*) from public.savings_goals)::text, '0');

-- ── admin restringe o colaborador ────────────────────────────────────────
select t.as_user('d0000000-0000-0000-0000-00000000000d');
select t.expect_fail(format($$ update public.residents set permissions = '{"lancamentos": 3}' where id = %L $$, t.id('edu')), 'check');
select t.expect_fail(format($$ update public.residents set permissions = '{"casa": 2}' where id = %L $$, t.id('edu')), 'check');
update public.residents set permissions = '{"painel": 0, "lancamentos": 0, "contas": 0, "calendario": 0, "relatorios": 0, "metas": 0}' where id = t.id('edu');

select t.as_user('e0000000-0000-0000-0000-00000000000e');
select t.eq('sem as telas de lançamentos, não lê lançamentos', (select count(*) from public.transactions)::text, '0');
select t.eq('sem as telas, não lê comprovantes', (select count(*) from storage.objects)::text, '0');
select t.eq('sem metas nem painel, não lê metas', (select count(*) from public.savings_goals)::text, '0');
select t.expect_fail(format($$ insert into public.transactions (house_id, description, amount_cents, date) values (%L, 'x', 1, '2026-11-01') $$, t.id('houseD')), 'row-level security');
select t.expect_fail(format($$ insert into public.goal_deposits (house_id, goal_id, amount_cents, date) values (%L, %L, 1, '2026-11-01') $$, t.id('houseD'), t.id('viagem')), 'row-level security');
select t.expect_fail(format($$ insert into public.accounts (house_id, name, kind) values (%L, 'Poupança', 'savings') $$, t.id('houseD')), 'row-level security');
select t.eq('ainda vê rendas fixas pela tela de fixos', (select public.perm(t.id('houseD'), 'recorrentes'))::text, '2');

-- ── 2FA ──────────────────────────────────────────────────────────────────
select t.as_root();
insert into auth.mfa_factors (user_id, status) values ('d0000000-0000-0000-0000-00000000000d', 'unverified');
select t.as_user('d0000000-0000-0000-0000-00000000000d');
select t.eq('fator não verificado não exige 2FA', (select count(*) from public.houses where id = t.id('houseD'))::text, '1');
select t.as_root();
update auth.mfa_factors set status = 'verified' where user_id = 'd0000000-0000-0000-0000-00000000000d';
select t.as_user_aal('d0000000-0000-0000-0000-00000000000d', 'aal1');
select t.eq('com 2FA ativo, sessão só com senha não lê nada', (select count(*) from public.transactions)::text, '0');
select t.eq('… nem a casa', (select count(*) from public.houses)::text, '0');
select t.expect_fail($$ select public.create_house('Outra', 'Dani') $$, 'mfa_required');
select t.as_user_aal('d0000000-0000-0000-0000-00000000000d', 'aal2');
select t.eq('com o código (aal2) lê normalmente', (select count(*) from public.transactions where house_id = t.id('houseD'))::text, '2');

-- excluir a casa apaga contas, lançamentos, orçamentos e metas
delete from public.houses where id = t.id('houseD');
select t.as_root();
select t.eq('nada sobra da casa D', (select (select count(*) from public.accounts where house_id = t.id('houseD')) + (select count(*) from public.transactions where house_id = t.id('houseD'))
  + (select count(*) from public.budgets where house_id = t.id('houseD')) + (select count(*) from public.goal_deposits where house_id = t.id('houseD')))::text, '0');
