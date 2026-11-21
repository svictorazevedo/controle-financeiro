-- ============================================================================
-- Migração v1 -> v2 (contas, entradas lançadas, comprovantes, subcategorias, orçamento,
-- metas de economia, permissões por tela, 2FA, moeda/logo/ícone).
--
-- Rode UMA vez no Supabase (SQL Editor › New query › colar › Run) no banco que já tinha a v1.
-- Tudo roda numa transação: se algo falhar, nada muda.
-- Instalação nova: use supabase/schema.sql (já inclui tudo isto).
-- ============================================================================
begin;

-- ---------------------------------------------------------------- permissões por tela
create function public.perm_default(m text) returns integer
language sql immutable set search_path = '' as $$
  select case m
    when 'painel' then 1 when 'lancamentos' then 2 when 'contas' then 1 when 'recorrentes' then 2
    when 'categorias' then 2 when 'orcamento' then 1 when 'metas' then 2 when 'relatorios' then 1
    when 'calendario' then 1 when 'ia' then 1 else 0 end
$$;

create function public.valid_permissions(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object' and not exists (
    select 1 from jsonb_each(p) e
     where e.key not in ('painel', 'lancamentos', 'contas', 'recorrentes', 'categorias', 'orcamento', 'metas', 'relatorios', 'calendario', 'ia')
        or e.value not in ('0'::jsonb, '1'::jsonb, '2'::jsonb))
$$;

-- ---------------------------------------------------------------- casa e moradores
alter table public.houses
  add column currency text not null default 'BRL' check (currency ~ '^[A-Z]{3}$'),
  add column logo text check (logo is null or (char_length(logo) <= 300000 and logo ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$')),
  add column icon text check (icon is null or (char_length(icon) <= 100000 and icon ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$'));

alter table public.residents
  add column permissions jsonb not null default '{}'::jsonb check (public.valid_permissions(permissions));

-- ---------------------------------------------------------------- contas
create table public.accounts (
  id             uuid primary key default gen_random_uuid(),
  house_id       uuid not null references public.houses(id) on delete cascade,
  name           text not null check (char_length(btrim(name)) between 1 and 60),
  kind           text not null default 'checking' check (kind in ('checking', 'savings', 'wallet', 'credit', 'investment', 'other')),
  opening_cents  bigint not null default 0 check (abs(opening_cents) <= 10000000000),
  color          text check (color ~ '^#[0-9a-f]{6}$'),
  archived       boolean not null default false,
  created_at     timestamptz not null default now(),
  unique (id, house_id)
);
create unique index accounts_house_name_key on public.accounts (house_id, lower(btrim(name)));

-- ---------------------------------------------------------------- categorias
alter table public.categories
  add column type text not null default 'expense' check (type in ('income', 'expense')),
  add column parent_id uuid,
  add column color text check (color ~ '^#[0-9a-f]{6}$'),
  add foreign key (parent_id, house_id) references public.categories(id, house_id) on delete cascade;
drop index public.categories_house_name_key;
create unique index categories_house_name_key on public.categories
  (house_id, type, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));

-- ---------------------------------------------------------------- rendas fixas
alter table public.incomes
  add column account_id uuid,
  add column category_id uuid,
  add column day smallint check (day between 1 and 31),
  add foreign key (account_id, house_id) references public.accounts(id, house_id),
  add foreign key (category_id, house_id) references public.categories(id, house_id) on delete set null (category_id);

-- ---------------------------------------------------------------- gastos -> lançamentos (entradas e saídas)
alter table public.expenses rename to transactions;
alter index public.expenses_house_id_date_idx rename to transactions_house_date_idx;
alter function public.expense_author() rename to transaction_author;
alter trigger expense_author on public.transactions rename to transaction_author;
alter table public.transactions
  add column type text not null default 'expense' check (type in ('income', 'expense')),
  add column account_id uuid,
  add column attachment_path text check (attachment_path is null or (char_length(attachment_path) <= 200 and split_part(attachment_path, '/', 1) = house_id::text)),
  add foreign key (account_id, house_id) references public.accounts(id, house_id);

-- ---------------------------------------------------------------- descontos automáticos
alter table public.recurring
  add column account_id uuid,
  add column day smallint check (day between 1 and 31),
  add foreign key (account_id, house_id) references public.accounts(id, house_id);

-- ---------------------------------------------------------------- orçamento e metas
create table public.budgets (
  id            uuid primary key default gen_random_uuid(),
  house_id      uuid not null,
  category_id   uuid not null,
  month         text check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  amount_cents  bigint not null check (amount_cents > 0 and amount_cents <= 10000000000),
  foreign key (category_id, house_id) references public.categories(id, house_id) on delete cascade
);
create unique index budgets_category_month_key on public.budgets (category_id, coalesce(month, ''));
create index on public.budgets (house_id);

create table public.savings_goals (
  id            uuid primary key default gen_random_uuid(),
  house_id      uuid not null references public.houses(id) on delete cascade,
  name          text not null check (char_length(btrim(name)) between 1 and 80),
  target_cents  bigint not null check (target_cents > 0 and target_cents <= 10000000000),
  target_date   date check (target_date between '2000-01-01' and '2100-12-31'),
  color         text check (color ~ '^#[0-9a-f]{6}$'),
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (id, house_id)
);
create table public.goal_deposits (
  id            uuid primary key default gen_random_uuid(),
  house_id      uuid not null,
  goal_id       uuid not null,
  amount_cents  bigint not null check (amount_cents <> 0 and abs(amount_cents) <= 10000000000),
  date          date not null check (date between '2000-01-01' and '2100-12-31'),
  note          text check (char_length(note) <= 120),
  created_by    uuid default auth.uid() references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  foreign key (goal_id, house_id) references public.savings_goals(id, house_id) on delete cascade
);
create index on public.goal_deposits (house_id);

-- ---------------------------------------------------------------- funções de apoio
create function public.perm(h uuid, m text) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when r.role = 'admin' then 2 else coalesce((r.permissions ->> m)::integer, public.perm_default(m)) end
      from public.residents r where r.house_id = h and r.user_id = auth.uid()), 0)
$$;

create function public.can_view(h uuid, ms text[]) returns boolean
language sql stable security definer set search_path = '' as
$$ select exists (select 1 from unnest(ms) m where public.perm(h, m) >= 1) $$;

create function public.mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status::text = 'verified')
$$;

create function public.tx_screens() returns text[] language sql immutable set search_path = '' as
$$ select array['painel', 'lancamentos', 'contas', 'calendario', 'relatorios'] $$;
create function public.fixed_screens() returns text[] language sql immutable set search_path = '' as
$$ select array['painel', 'lancamentos', 'contas', 'calendario', 'relatorios', 'recorrentes'] $$;

-- ---------------------------------------------------------------- gatilhos
create trigger keep_house before update on public.accounts      for each row execute function public.keep_house_id();
create trigger keep_house before update on public.budgets       for each row execute function public.keep_house_id();
create trigger keep_house before update on public.savings_goals for each row execute function public.keep_house_id();
create trigger keep_house before update on public.goal_deposits for each row execute function public.keep_house_id();
create trigger deposit_author before insert or update on public.goal_deposits for each row execute function public.transaction_author();

create function public.category_type_check() returns trigger language plpgsql security definer set search_path = '' as $$
declare want text := case tg_table_name when 'incomes' then 'income' when 'recurring' then 'expense' else to_jsonb(new) ->> 'type' end;
begin
  if new.category_id is not null and (select c.type from public.categories c where c.id = new.category_id) is distinct from want then
    raise exception 'category_type_mismatch' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger category_type before insert or update on public.transactions for each row execute function public.category_type_check();
create trigger category_type before insert or update on public.incomes      for each row execute function public.category_type_check();
create trigger category_type before insert or update on public.recurring    for each row execute function public.category_type_check();

create function public.category_tree() returns trigger language plpgsql security definer set search_path = '' as $$
declare p public.categories;
begin
  if new.parent_id is not null then
    select * into p from public.categories where id = new.parent_id;
    if p.id = new.id or p.parent_id is not null or p.type <> new.type
       or exists (select 1 from public.categories c where c.parent_id = new.id) then
      raise exception 'category_tree_invalid' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.type <> old.type and (
       exists (select 1 from public.categories c where c.parent_id = new.id)
       or exists (select 1 from public.transactions t where t.category_id = new.id)
       or exists (select 1 from public.incomes i where i.category_id = new.id)
       or exists (select 1 from public.recurring r where r.category_id = new.id)) then
    raise exception 'category_in_use' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger category_tree before insert or update on public.categories for each row execute function public.category_tree();

create function public.budget_check() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select c.type from public.categories c where c.id = new.category_id) <> 'expense' then
    raise exception 'budget_income_category' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger budget_check before insert or update on public.budgets for each row execute function public.budget_check();

-- ---------------------------------------------------------------- RLS
alter table public.accounts      enable row level security;
alter table public.budgets       enable row level security;
alter table public.savings_goals enable row level security;
alter table public.goal_deposits enable row level security;

-- Remove as políticas da v1 e recria o conjunto completo da v2.
do $$
declare p record;
begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- >>> POLÍTICAS
-- 2FA: política RESTRITIVA (soma-se a todas as outras com AND) em todas as tabelas do app.
create policy mfa on public.houses        as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.residents     as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.invites       as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.accounts      as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.categories    as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.incomes       as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.goals         as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.transactions  as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.recurring     as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.budgets       as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.savings_goals as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.goal_deposits as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.ai_settings   as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());

-- Casa: membros veem; admin altera (nome, moeda, logo) e exclui; criação só pela função create_house.
create policy houses_select on public.houses for select to authenticated using (public.is_member(id));
create policy houses_update on public.houses for update to authenticated using (public.is_admin(id)) with check (public.is_admin(id));
create policy houses_delete on public.houses for delete to authenticated using (public.is_admin(id));

-- Moradores/usuários: membros veem; admin cadastra (sem login), renomeia, muda papel e permissões, remove.
create policy residents_select on public.residents for select to authenticated using (public.is_member(house_id));
create policy residents_insert on public.residents for insert to authenticated with check (public.is_admin(house_id) and user_id is null);
create policy residents_update on public.residents for update to authenticated using (public.is_admin(house_id)) with check (public.is_admin(house_id));
create policy residents_delete on public.residents for delete to authenticated using (public.is_admin(house_id));

-- Convites: só o admin vê quais estão pendentes; criação/uso pelas funções.
create policy invites_select on public.invites for select to authenticated using (public.is_admin(house_id));
create policy invites_delete on public.invites for delete to authenticated using (public.is_admin(house_id));

-- Contas: todos da casa veem o nome (para lançar); cria/edita/exclui quem tem "Contas: editar".
create policy accounts_select on public.accounts for select to authenticated using (public.is_member(house_id));
create policy accounts_write  on public.accounts for all to authenticated
  using (public.perm(house_id, 'contas') = 2) with check (public.perm(house_id, 'contas') = 2);

-- Categorias: todos veem; cria e edita quem tem "Categorias: editar"; só admin exclui.
create policy categories_select on public.categories for select to authenticated using (public.is_member(house_id));
create policy categories_insert on public.categories for insert to authenticated with check (public.perm(house_id, 'categorias') = 2);
create policy categories_update on public.categories for update to authenticated
  using (public.perm(house_id, 'categorias') = 2) with check (public.perm(house_id, 'categorias') = 2);
create policy categories_delete on public.categories for delete to authenticated using (public.is_admin(house_id));

-- Rendas e distribuição %: veem as telas que usam; cada um mexe nos seus (com permissão); admin em todos.
create policy incomes_select on public.incomes for select to authenticated using (public.can_view(house_id, public.fixed_screens()));
create policy incomes_write  on public.incomes for all to authenticated
  using (public.perm(house_id, 'recorrentes') = 2 and public.can_manage(house_id, resident_id))
  with check (public.perm(house_id, 'recorrentes') = 2 and public.can_manage(house_id, resident_id));
create policy goals_select on public.goals for select to authenticated using (public.can_view(house_id, public.fixed_screens()));
create policy goals_write  on public.goals for all to authenticated
  using (public.perm(house_id, 'recorrentes') = 2 and public.can_manage(house_id, resident_id))
  with check (public.perm(house_id, 'recorrentes') = 2 and public.can_manage(house_id, resident_id));

-- Lançamentos: veem as telas que usam; lança quem tem "Lançamentos: editar" (para si ou para a casa);
-- altera/exclui quem lançou, o dono do lançamento ou o admin.
create policy transactions_select on public.transactions for select to authenticated using (public.can_view(house_id, public.tx_screens()));
create policy transactions_insert on public.transactions for insert to authenticated
  with check (public.perm(house_id, 'lancamentos') = 2 and (resident_id is null or public.can_manage(house_id, resident_id)));
create policy transactions_update on public.transactions for update to authenticated
  using (public.perm(house_id, 'lancamentos') = 2 and (public.is_admin(house_id) or created_by = auth.uid() or (resident_id is not null and resident_id = public.my_resident(house_id))))
  with check (public.perm(house_id, 'lancamentos') = 2 and (resident_id is null or public.can_manage(house_id, resident_id)));
create policy transactions_delete on public.transactions for delete to authenticated
  using (public.perm(house_id, 'lancamentos') = 2 and (public.is_admin(house_id) or created_by = auth.uid() or (resident_id is not null and resident_id = public.my_resident(house_id))));

-- Descontos automáticos: os da casa (sem morador) só o admin; os pessoais, o próprio morador.
create policy recurring_select on public.recurring for select to authenticated using (public.can_view(house_id, public.fixed_screens()));
create policy recurring_write  on public.recurring for all to authenticated
  using (public.perm(house_id, 'recorrentes') = 2 and (public.can_manage(house_id, resident_id) or (resident_id is null and public.is_admin(house_id))))
  with check (public.perm(house_id, 'recorrentes') = 2 and (public.can_manage(house_id, resident_id) or (resident_id is null and public.is_admin(house_id))));

-- Orçamento e metas: veem quem tem a tela (ou o painel, que mostra o resumo); editam com "editar".
create policy budgets_select on public.budgets for select to authenticated using (public.can_view(house_id, array['orcamento', 'painel']));
create policy budgets_write  on public.budgets for all to authenticated
  using (public.perm(house_id, 'orcamento') = 2) with check (public.perm(house_id, 'orcamento') = 2);
create policy savings_goals_select on public.savings_goals for select to authenticated using (public.can_view(house_id, array['metas', 'painel']));
create policy savings_goals_write  on public.savings_goals for all to authenticated
  using (public.perm(house_id, 'metas') = 2) with check (public.perm(house_id, 'metas') = 2);
create policy goal_deposits_select on public.goal_deposits for select to authenticated using (public.can_view(house_id, array['metas', 'painel']));
create policy goal_deposits_write  on public.goal_deposits for all to authenticated
  using (public.perm(house_id, 'metas') = 2) with check (public.perm(house_id, 'metas') = 2);

-- IA: membros leem provedor/modelo. Gravação só pela Edge Function (service role).
create policy ai_settings_select on public.ai_settings for select to authenticated using (public.is_member(house_id));
-- ai_secrets, ai_usage e invite_attempts: SEM políticas => ninguém acessa pelo site.
-- <<< POLÍTICAS

revoke all on public.ai_secrets, public.ai_usage, public.invite_attempts from anon, authenticated;
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon, public;
grant execute on function public.is_member(uuid), public.is_admin(uuid), public.my_resident(uuid), public.can_manage(uuid, uuid),
  public.perm(uuid, text), public.can_view(uuid, text[]), public.mfa_ok(), public.perm_default(text), public.valid_permissions(jsonb),
  public.tx_screens(), public.fixed_screens() to authenticated;

-- ---------------------------------------------------------------- comprovantes (Storage)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

create function public.receipt_house(path text) returns uuid
language sql immutable set search_path = '' as $$
  select case when split_part(path, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(path, '/', 1)::uuid end
$$;
grant execute on function public.receipt_house(text) to authenticated;

drop policy if exists receipts_select on storage.objects;
drop policy if exists receipts_insert on storage.objects;
drop policy if exists receipts_delete on storage.objects;
create policy receipts_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and public.mfa_ok() and public.can_view(public.receipt_house(name), public.tx_screens()));
create policy receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and public.mfa_ok() and public.perm(public.receipt_house(name), 'lancamentos') = 2);
create policy receipts_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and public.mfa_ok() and public.perm(public.receipt_house(name), 'lancamentos') = 2);

-- ---------------------------------------------------------------- funções RPC (versão 2)
create function public.seed_house(h uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.accounts (house_id, name, kind, color) values
    (h, 'Conta principal', 'checking', '#2a78d6'), (h, 'Carteira', 'wallet', '#1baf7a')
  on conflict do nothing;
  insert into public.categories (house_id, name, type, color, is_default)
  select h, c.name, 'expense', c.color, true from (values
    ('Moradia', '#2a78d6'), ('Contas (água, luz, internet)', '#eb6834'), ('Mercado', '#1baf7a'),
    ('Alimentação fora', '#eda100'), ('Transporte', '#e87ba4'), ('Saúde', '#008300'), ('Educação', '#6250d6'),
    ('Lazer', '#e34948'), ('Vestuário', '#2a78d6'), ('Dízimo e ofertas', '#eb6834'), ('Assinaturas', '#1baf7a'),
    ('Pets', '#eda100'), ('Cuidados pessoais', '#e87ba4'), ('Presentes', '#008300'), ('Outros', '#73726c')) as c(name, color)
  on conflict do nothing;
  insert into public.categories (house_id, name, type, color, is_default)
  select h, c.name, 'income', c.color, true from (values
    ('Salário', '#2a78d6'), ('Freelance e extras', '#1baf7a'), ('Rendimentos', '#6250d6'),
    ('Reembolsos', '#eda100'), ('Outras entradas', '#73726c')) as c(name, color)
  on conflict do nothing;
end $$;
revoke execute on function public.seed_house(uuid) from public, anon, authenticated;

create or replace function public.create_house(p_name text, p_my_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare h uuid; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if not public.mfa_ok() then raise exception 'mfa_required' using errcode = '42501'; end if;
  if (select count(*) from public.residents where user_id = uid) >= 10 then
    raise exception 'too_many_houses' using errcode = '23514';
  end if;
  perform set_config('app.rpc', 'on', true);
  insert into public.houses (name) values (btrim(p_name)) returning id into h;
  insert into public.residents (house_id, user_id, name, role) values (h, uid, btrim(p_my_name), 'admin');
  perform public.seed_house(h);
  perform set_config('app.rpc', 'off', true);
  return h;
end $$;

create or replace function public.create_invite(p_resident uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare r public.residents; code text;
begin
  if not public.mfa_ok() then raise exception 'mfa_required' using errcode = '42501'; end if;
  select * into r from public.residents where id = p_resident;
  if r.id is null or not public.is_admin(r.house_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if r.user_id is not null then raise exception 'resident_has_login' using errcode = '23514'; end if;
  code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6) || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  insert into public.invites (resident_id, house_id, code_hash, expires_at)
  values (r.id, r.house_id, encode(sha256(convert_to(code, 'UTF8')), 'hex'), now() + interval '72 hours')
  on conflict (resident_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at;
  return substr(code, 1, 4) || '-' || substr(code, 5, 4) || '-' || substr(code, 9, 4);
end $$;

create or replace function public.join_house(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); norm text; inv public.invites;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if not public.mfa_ok() then raise exception 'mfa_required' using errcode = '42501'; end if;
  if (select count(*) from public.invite_attempts where user_id = uid and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too_many_attempts' using errcode = '42501';
  end if;
  insert into public.invite_attempts (user_id) values (uid);
  norm := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  select * into inv from public.invites
   where code_hash = encode(sha256(convert_to(norm, 'UTF8')), 'hex') and expires_at > now();
  if inv.resident_id is null then raise exception 'invalid_invite' using errcode = '23514'; end if;
  if exists (select 1 from public.residents where house_id = inv.house_id and user_id = uid) then
    raise exception 'already_member' using errcode = '23514';
  end if;
  perform set_config('app.rpc', 'on', true);
  update public.residents set user_id = uid where id = inv.resident_id and user_id is null;
  perform set_config('app.rpc', 'off', true);
  delete from public.invites where resident_id = inv.resident_id;
  return inv.house_id;
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.create_house(text, text), public.create_invite(uuid), public.join_house(text) to authenticated;

grant select, insert, update, delete on public.houses, public.residents, public.categories, public.incomes,
  public.goals, public.transactions, public.recurring, public.accounts, public.budgets,
  public.savings_goals, public.goal_deposits to authenticated;
grant select, delete on public.invites to authenticated;
grant select on public.ai_settings to authenticated;
revoke insert on public.houses from authenticated;

-- ---------------------------------------------------------------- dados existentes
-- Cada casa ganha as contas padrão e as categorias de entrada; o que já existe vai para a "Conta principal".
select public.seed_house(id) from public.houses;
update public.transactions t set account_id = a.id from public.accounts a
 where a.house_id = t.house_id and a.name = 'Conta principal' and t.account_id is null;
update public.incomes i set account_id = a.id from public.accounts a
 where a.house_id = i.house_id and a.name = 'Conta principal' and i.account_id is null;
update public.recurring r set account_id = a.id from public.accounts a
 where a.house_id = r.house_id and a.name = 'Conta principal' and r.account_id is null;
-- Cores para as categorias que não têm (paleta em ordem fixa).
update public.categories c set color = (array['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'])[1 + (x.n - 1) % 8]
  from (select id, row_number() over (partition by house_id, type order by name) as n from public.categories where color is null) x
 where c.id = x.id;

commit;
