-- Depois da migração v1 -> v2: os dados antigos continuam lá e foram convertidos.
\set ON_ERROR_STOP on
reset role;
select t.eq('gasto antigo virou lançamento de saída na Conta principal',
  (select t2.type || '|' || a.name from public.transactions t2 join public.accounts a on a.id = t2.account_id where t2.description = 'Compra antiga'), 'expense|Conta principal');
select t.eq('renda e desconto antigos ligados à Conta principal',
  (select count(*) from public.incomes i join public.accounts a on a.id = i.account_id where a.name = 'Conta principal')::text
  || (select count(*) from public.recurring r join public.accounts a on a.id = r.account_id where a.name = 'Conta principal')::text, '11');
select t.eq('categorias de entrada criadas na casa antiga',
  (select count(*) from public.categories c join public.houses h on h.id = c.house_id where h.name = 'Casa v1' and c.type = 'income')::text, '5');
select t.eq('categorias antigas ganharam cor', (select count(*) from public.categories where color is null)::text, '0');
select t.eq('tabela antiga não existe mais', (select to_regclass('public.expenses'))::text, null);
select t.eq('autor continua protegido por gatilho',
  (select count(*) from pg_trigger where tgname = 'transaction_author' and tgrelid = 'public.transactions'::regclass)::text, '1');
select t.eq('nenhuma política da v1 sobrou com nome antigo', (select count(*) from pg_policies where policyname like 'expenses_%')::text, '0');
