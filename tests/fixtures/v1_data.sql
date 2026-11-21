-- Dados criados com o esquema da v1, antes de rodar a migração (testa a conversão).
insert into auth.users (id, email) values ('f0000000-0000-0000-0000-00000000000f', 'velho@v1.com');
reset role;
select set_config('request.jwt.claim.sub', 'f0000000-0000-0000-0000-00000000000f', false);
set role authenticated;
select public.create_house('Casa v1', 'Velho');
insert into public.expenses (house_id, category_id, description, amount_cents, date)
  select h.id, c.id, 'Compra antiga', 4321, '2026-10-10' from public.houses h join public.categories c on c.house_id = h.id and c.name = 'Mercado';
insert into public.incomes (house_id, resident_id, description, amount_cents, kind, start_month)
  select r.house_id, r.id, 'Salário', 300000, 'recurring', '2026-01' from public.residents r;
insert into public.recurring (house_id, description, mode, amount_cents, start_month)
  select id, 'Aluguel', 'fixed', 100000, '2026-01' from public.houses;
reset role;
select set_config('request.jwt.claim.sub', '', false);
