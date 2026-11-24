-- Testes do módulo Compras (003_compras.sql): cupons, produtos, apelidos, cotações, permissões e RLS.
-- Usa as funções auxiliares (schema t) de 01_rules.sql.
\set ON_ERROR_STOP on
reset role;

insert into auth.users (id, email) values
  ('f1000000-0000-0000-0000-0000000000f1', 'fabi@f.com'),   -- admin da casa F
  ('91000000-0000-0000-0000-000000000091', 'gui@f.com');    -- colaborador da casa F

select t.as_user('f1000000-0000-0000-0000-0000000000f1');
select t.put('houseF', public.create_house('Casa F', 'Fabi'));
select t.put('contaF', (select id from public.accounts where house_id = t.id('houseF') and name = 'Conta principal'));
select t.put('mercadoF', (select id from public.categories where house_id = t.id('houseF') and name = 'Mercado'));
insert into public.residents (house_id, name) values (t.id('houseF'), 'Gui');
select t.put('gui', (select id from public.residents where house_id = t.id('houseF') and name = 'Gui'));
insert into t.codes values ('gui', public.create_invite(t.id('gui')));
select t.as_user('91000000-0000-0000-0000-000000000091');
select public.join_house((select code from t.codes where name = 'gui'));

-- permissão nova é aceita; chave desconhecida continua recusada
select t.as_user('f1000000-0000-0000-0000-0000000000f1');
select t.eq('padrão de compras = editar', public.perm_default('compras')::text, '2');
select t.expect_fail(format($$ update public.residents set permissions = '{"compraz": 1}' where id = %L $$, t.id('gui')), 'check');

-- ── salvar cupom com lançamento de saída ──────────────────────────────────
select t.put('rec1', public.save_shop_receipt(t.id('houseF'), jsonb_build_object(
  'store', jsonb_build_object('name', 'Mercado Exemplo', 'cnpj', '12345678000190', 'address', 'Av. Brasil, 100'),
  'purchased_at', '2026-11-20', 'total_cents', 5874, 'discount_cents', 180, 'source', 'xml',
  'access_key', '51261112345678000190650010000012341000012345',
  'image_paths', jsonb_build_array(t.id('houseF') || '/cupons/a.jpg'),
  'items', jsonb_build_array(
    jsonb_build_object('product', jsonb_build_object('name', 'Arroz Tio João 5kg', 'unit', 'un', 'ean', '7891234567895'),
      'raw_name', 'ARROZ T.JOAO 5KG', 'quantity_milli', 2000, 'unit_price_cents', 2590, 'discount_cents', 180, 'total_cents', 5000, 'position', 1),
    jsonb_build_object('product', jsonb_build_object('name', 'Banana prata', 'unit', 'kg'),
      'raw_name', 'BANANA  PRATA KG', 'quantity_milli', 1250, 'unit_price_cents', 699, 'total_cents', 874, 'position', 2)),
  'transaction', jsonb_build_object('account_id', t.id('contaF'), 'category_id', t.id('mercadoF'), 'description', 'Mercado Exemplo'))));
select t.eq('mercado criado', (select count(*) from public.stores where house_id = t.id('houseF'))::text, '1');
select t.eq('2 produtos', (select count(*) from public.products where house_id = t.id('houseF'))::text, '2');
select t.eq('2 itens', (select count(*) from public.shop_items where receipt_id = t.id('rec1'))::text, '2');
select t.eq('apelido normalizado', (select string_agg(alias, '|' order by alias) from public.product_aliases where house_id = t.id('houseF')), 'arroz t.joao 5kg|banana prata kg');
select t.eq('lançamento de saída criado e ligado',
  (select tx.amount_cents::text || ' ' || tx.type || ' ' || tx.attachment_path from public.shop_receipts r join public.transactions tx on tx.id = r.transaction_id where r.id = t.id('rec1')),
  '5874 expense ' || t.id('houseF') || '/cupons/a.jpg');
select t.eq('autor do cupom', (select created_by::text from public.shop_receipts where id = t.id('rec1')), 'f1000000-0000-0000-0000-0000000000f1');

-- mesmo cupom de novo: chave de acesso repetida
select t.expect_fail(format($$ select public.save_shop_receipt(%L, jsonb_build_object('store', jsonb_build_object('name', 'X'),
  'purchased_at', '2026-11-20', 'total_cents', 100, 'access_key', '51261112345678000190650010000012341000012345',
  'items', jsonb_build_array(jsonb_build_object('product', jsonb_build_object('name', 'Y'), 'raw_name', 'Y', 'quantity_milli', 1000, 'unit_price_cents', 100, 'total_cents', 100)))) $$,
  t.id('houseF')), 'shop_receipts_access_key');
-- imagem de outra casa
select t.expect_fail(format($$ select public.save_shop_receipt(%L, jsonb_build_object('store', jsonb_build_object('name', 'X'),
  'purchased_at', '2026-11-20', 'total_cents', 100, 'image_paths', jsonb_build_array('outra-casa/x.jpg'),
  'items', jsonb_build_array(jsonb_build_object('product', jsonb_build_object('name', 'Y'), 'raw_name', 'Y', 'quantity_milli', 1000, 'unit_price_cents', 100, 'total_cents', 100)))) $$,
  t.id('houseF')), 'check');
-- cupom sem itens
select t.expect_fail(format($$ select public.save_shop_receipt(%L, '{"store":{"name":"X"},"purchased_at":"2026-11-20","total_cents":100,"items":[]}') $$, t.id('houseF')), 'receipt_items_invalid');
select t.eq('nada sobrou dos cupons recusados', (select count(*) from public.stores where house_id = t.id('houseF'))::text, '1');

-- ── colaborador: reaproveita mercado (CNPJ) e produto (EAN), sem lançamento ───
select t.as_user('91000000-0000-0000-0000-000000000091');
select t.put('rec2', public.save_shop_receipt(t.id('houseF'), jsonb_build_object(
  'store', jsonb_build_object('name', 'MERCADO EXEMPLO FILIAL?', 'cnpj', '12345678000190'),
  'purchased_at', '2026-12-02', 'total_cents', 2490,
  'items', jsonb_build_array(jsonb_build_object('product', jsonb_build_object('name', 'Arroz TJ 5 kg', 'ean', '7891234567895'),
    'raw_name', 'ARROZ TIO JOAO 5KG', 'quantity_milli', 1000, 'unit_price_cents', 2490, 'total_cents', 2490)))));
select t.eq('mesmo mercado pelo CNPJ', (select count(*) from public.stores where house_id = t.id('houseF'))::text, '1');
select t.eq('mesmo produto pelo EAN', (select count(*) from public.products where house_id = t.id('houseF'))::text, '2');
select t.eq('sem lançamento', (select coalesce(transaction_id::text, 'nenhum') from public.shop_receipts where id = t.id('rec2')), 'nenhum');
-- colaborador não altera nem apaga o cupom da Fabi
delete from public.shop_receipts where id = t.id('rec1');
select t.eq('colaborador não apaga cupom alheio', (select count(*) from public.shop_receipts where id = t.id('rec1'))::text, '1');
delete from public.shop_items where receipt_id = t.id('rec1');
select t.eq('nem os itens dele', (select count(*) from public.shop_items where receipt_id = t.id('rec1'))::text, '2');
-- cotação
insert into public.price_quotes (house_id, product_id, store_name, price_cents, source, url, observed_on)
values (t.id('houseF'), (select id from public.products where house_id = t.id('houseF') and ean = '7891234567895'), 'Atacadão', 2299, 'web', 'https://exemplo.com/arroz', '2026-12-03');
select t.expect_fail(format($$ insert into public.price_quotes (house_id, product_id, store_name, price_cents, url, observed_on) values (%L, %L, 'X', 1, 'javascript:alert(1)', '2026-12-03') $$,
  t.id('houseF'), (select id from public.products where house_id = t.id('houseF') and ean = '7891234567895')), 'check');

-- ── colaborador sem acesso a Compras ──────────────────────────────────────
select t.as_user('f1000000-0000-0000-0000-0000000000f1');
update public.residents set permissions = '{"compras": 0}' where id = t.id('gui');
select t.as_user('91000000-0000-0000-0000-000000000091');
select t.eq('sem acesso não vê cupons', (select count(*) from public.shop_receipts)::text, '0');
select t.eq('sem acesso não vê produtos', (select count(*) from public.products)::text, '0');
select t.expect_fail(format($$ select public.save_shop_receipt(%L, '{"store":{"name":"X"},"purchased_at":"2026-11-20","total_cents":100,"items":[{"product":{"name":"Y"},"raw_name":"Y","quantity_milli":1000,"unit_price_cents":100,"total_cents":100}]}') $$, t.id('houseF')), 'forbidden');
select t.as_user('f1000000-0000-0000-0000-0000000000f1');
update public.residents set permissions = '{"compras": 1}' where id = t.id('gui');
select t.as_user('91000000-0000-0000-0000-000000000091');
select t.eq('só ver: vê cupons', (select count(*) from public.shop_receipts)::text, '2');
select t.expect_fail(format($$ insert into public.products (house_id, name) values (%L, 'Z') $$, t.id('houseF')), 'row-level security');

-- ── intrusa de outra casa ─────────────────────────────────────────────────
select t.as_user('c0000000-0000-0000-0000-00000000000c');
select t.eq('outra casa não vê cupons', (select count(*) from public.shop_receipts where house_id = t.id('houseF'))::text, '0');
select t.expect_fail(format($$ select public.save_shop_receipt(%L, '{"store":{"name":"X"},"purchased_at":"2026-11-20","total_cents":100,"items":[{"product":{"name":"Y"},"raw_name":"Y","quantity_milli":1000,"unit_price_cents":100,"total_cents":100}]}') $$, t.id('houseF')), 'forbidden');
select t.expect_fail(format($$ insert into public.stores (house_id, name) values (%L, 'Invasor') $$, t.id('houseF')), 'row-level security');

-- ── mesclar produtos ──────────────────────────────────────────────────────
select t.as_user('f1000000-0000-0000-0000-0000000000f1');
insert into public.products (house_id, name, unit) values (t.id('houseF'), 'Arroz T. João 5 kg', 'un');
select t.put('arrozDup', (select id from public.products where house_id = t.id('houseF') and name = 'Arroz T. João 5 kg'));
select t.put('arroz', (select id from public.products where house_id = t.id('houseF') and ean = '7891234567895'));
insert into public.product_aliases (house_id, alias, product_id) values (t.id('houseF'), 'arroz tj', t.id('arrozDup'));
select public.merge_products(t.id('arroz'), t.id('arrozDup'));
select t.eq('itens movidos', (select count(*) from public.shop_items where product_id = t.id('arrozDup'))::text, '2');
select t.eq('cotação movida', (select count(*) from public.price_quotes where product_id = t.id('arrozDup'))::text, '1');
select t.eq('EAN herdado', (select ean from public.products where id = t.id('arrozDup')), '7891234567895');
select t.eq('origem apagada', (select count(*) from public.products where id = t.id('arroz'))::text, '0');
select t.expect_fail(format($$ select public.merge_products(%L, %L) $$, t.id('arrozDup'), t.id('arrozDup')), 'product_not_found');

-- apagar o lançamento deixa o cupom (só desliga)
delete from public.transactions where id = (select transaction_id from public.shop_receipts where id = t.id('rec1'));
select t.eq('cupom continua sem lançamento', (select coalesce(transaction_id::text, 'nenhum') from public.shop_receipts where id = t.id('rec1')), 'nenhum');
-- apagar o cupom apaga os itens
delete from public.shop_receipts where id = t.id('rec1');
select t.eq('itens apagados junto', (select count(*) from public.shop_items where receipt_id = t.id('rec1'))::text, '0');

-- visitante não lê nada
select t.as_anon();
select t.expect_fail($$ select count(*) from public.products $$, 'permission denied');
select t.expect_fail($$ select count(*) from public.shop_receipts $$, 'permission denied');
select t.as_root();
