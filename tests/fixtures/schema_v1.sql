-- ============================================================================
-- Controle Financeiro — esquema do banco (Supabase / Postgres 15+)
-- Rode inteiro no Supabase: SQL Editor › New query › colar › Run.
--
-- Como o site é estático (GitHub Pages), NÃO existe servidor próprio: quem protege
-- os dados é o próprio Postgres, com Row Level Security (RLS). Cada regra abaixo
-- vale mesmo que alguém chame a API do Supabase direto, sem passar pelo site.
--
-- Dinheiro: sempre em CENTAVOS (bigint). Percentual: PONTOS-BASE (1000 = 10,00%).
-- ============================================================================

-- ---------------------------------------------------------------- tabelas
create table public.houses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  created_at  timestamptz not null default now()
);

create table public.residents (
  id          uuid primary key default gen_random_uuid(),
  house_id    uuid not null references public.houses(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  role        text not null default 'member' check (role in ('admin', 'member')),
  created_at  timestamptz not null default now(),
  unique (house_id, user_id),
  unique (id, house_id)               -- permite chaves estrangeiras compostas (integridade entre casas)
);
create index on public.residents (user_id);

-- Convites: só o hash do código fica salvo; o código aparece uma única vez para o admin.
create table public.invites (
  resident_id  uuid primary key,
  house_id     uuid not null,
  code_hash    text not null unique,
  expires_at   timestamptz not null,
  foreign key (resident_id, house_id) references public.residents(id, house_id) on delete cascade
);

create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  house_id    uuid not null references public.houses(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  is_default  boolean not null default false,
  unique (id, house_id)
);
create unique index categories_house_name_key on public.categories (house_id, lower(btrim(name)));

create table public.incomes (
  id            uuid primary key default gen_random_uuid(),
  house_id      uuid not null,
  resident_id   uuid not null,
  description   text not null check (char_length(btrim(description)) between 1 and 120),
  amount_cents  bigint not null check (amount_cents > 0 and amount_cents <= 10000000000),
  kind          text not null check (kind in ('recurring', 'once')),
  start_month   text not null check (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  end_month     text check (end_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  created_at    timestamptz not null default now(),
  check (end_month is null or (kind = 'recurring' and end_month >= start_month)),
  foreign key (resident_id, house_id) references public.residents(id, house_id) on delete cascade
);
create index on public.incomes (house_id);

create table public.goals (
  id           uuid primary key default gen_random_uuid(),
  house_id     uuid not null,
  resident_id  uuid not null,
  name         text not null check (char_length(btrim(name)) between 1 and 80),
  percent_bp   integer not null check (percent_bp between 1 and 10000),
  created_at   timestamptz not null default now(),
  foreign key (resident_id, house_id) references public.residents(id, house_id) on delete cascade
);
create index on public.goals (house_id);

create table public.expenses (
  id            uuid primary key default gen_random_uuid(),
  house_id      uuid not null references public.houses(id) on delete cascade,
  resident_id   uuid,                 -- NULL = gasto da casa (compartilhado)
  category_id   uuid,
  description   text not null check (char_length(btrim(description)) between 1 and 120),
  amount_cents  bigint not null check (amount_cents > 0 and amount_cents <= 10000000000),
  date          date not null check (date between '2000-01-01' and '2100-12-31'),
  created_by    uuid default auth.uid() references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  foreign key (resident_id, house_id) references public.residents(id, house_id) on delete set null (resident_id),
  foreign key (category_id, house_id) references public.categories(id, house_id) on delete set null (category_id)
);
create index on public.expenses (house_id, date);

-- Descontos automáticos: dízimo (% da renda), aluguel (fixo), parcelas (some ao terminar)...
create table public.recurring (
  id            uuid primary key default gen_random_uuid(),
  house_id      uuid not null references public.houses(id) on delete cascade,
  resident_id   uuid,                 -- NULL = da casa
  category_id   uuid,
  description   text not null check (char_length(btrim(description)) between 1 and 120),
  mode          text not null check (mode in ('fixed', 'percent')),
  amount_cents  bigint check (amount_cents > 0 and amount_cents <= 10000000000),
  percent_bp    integer check (percent_bp between 1 and 10000),
  start_month   text not null check (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  installments  integer check (installments between 1 and 600),
  end_month     text check (end_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  check ((mode = 'fixed' and amount_cents is not null and percent_bp is null)
      or (mode = 'percent' and percent_bp is not null and amount_cents is null)),
  check (end_month is null or end_month >= start_month),
  foreign key (resident_id, house_id) references public.residents(id, house_id) on delete cascade,
  foreign key (category_id, house_id) references public.categories(id, house_id) on delete set null (category_id)
);
create index on public.recurring (house_id);

-- Configuração de IA: os membros veem provedor/modelo; a chave fica em ai_secrets,
-- criptografada pela Edge Function e inacessível pelo site (sem nenhuma política RLS).
create table public.ai_settings (
  house_id    uuid primary key references public.houses(id) on delete cascade,
  provider    text not null check (provider in ('anthropic', 'openai', 'gemini')),
  model       text not null check (char_length(model) between 1 and 100),
  base_url    text check (char_length(base_url) <= 300),
  key_hint    text check (char_length(key_hint) <= 4),
  updated_at  timestamptz not null default now()
);
create table public.ai_secrets (
  house_id     uuid primary key references public.houses(id) on delete cascade,
  api_key_enc  text not null
);
create table public.ai_usage (
  id          bigint generated always as identity primary key,
  user_id     uuid not null,
  created_at  timestamptz not null default now()
);
create index on public.ai_usage (user_id, created_at);

create table public.invite_attempts (
  id          bigint generated always as identity primary key,
  user_id     uuid not null,
  created_at  timestamptz not null default now()
);
create index on public.invite_attempts (user_id, created_at);

-- ---------------------------------------------------------------- funções de apoio
-- SECURITY DEFINER + search_path vazio: rodam com privilégio do dono, sem risco de sequestro de nomes.
create function public.is_member(h uuid) returns boolean
language sql stable security definer set search_path = '' as
$$ select exists (select 1 from public.residents r where r.house_id = h and r.user_id = auth.uid()) $$;

create function public.is_admin(h uuid) returns boolean
language sql stable security definer set search_path = '' as
$$ select exists (select 1 from public.residents r where r.house_id = h and r.user_id = auth.uid() and r.role = 'admin') $$;

create function public.my_resident(h uuid) returns uuid
language sql stable security definer set search_path = '' as
$$ select r.id from public.residents r where r.house_id = h and r.user_id = auth.uid() $$;

/** Admin mexe em tudo da casa; morador só nos próprios dados. */
create function public.can_manage(h uuid, rid uuid) returns boolean
language sql stable security definer set search_path = '' as
$$ select public.is_admin(h) or (rid is not null and rid = public.my_resident(h)) $$;

-- ---------------------------------------------------------------- gatilhos de integridade
-- Um registro nunca muda de casa.
create function public.keep_house_id() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.house_id is distinct from old.house_id then
    raise exception 'house_id_immutable' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger keep_house before update on public.residents  for each row execute function public.keep_house_id();
create trigger keep_house before update on public.categories for each row execute function public.keep_house_id();
create trigger keep_house before update on public.incomes    for each row execute function public.keep_house_id();
create trigger keep_house before update on public.goals      for each row execute function public.keep_house_id();
create trigger keep_house before update on public.expenses   for each row execute function public.keep_house_id();
create trigger keep_house before update on public.recurring  for each row execute function public.keep_house_id();

-- Quem lançou o gasto é sempre o usuário logado (não dá para forjar).
create function public.expense_author() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then new.created_by := auth.uid();
  else new.created_by := old.created_by; end if;
  return new;
end $$;
create trigger expense_author before insert or update on public.expenses for each row execute function public.expense_author();

-- O vínculo morador ↔ conta só muda pelas funções de convite (não por UPDATE direto).
create function public.resident_guard() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' and new.user_id is not null and current_setting('app.rpc', true) is distinct from 'on' then
    raise exception 'resident_link_via_invite' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id and current_setting('app.rpc', true) is distinct from 'on' then
    raise exception 'resident_link_via_invite' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger resident_guard before insert or update on public.residents for each row execute function public.resident_guard();

-- A casa precisa manter pelo menos um administrador com login.
-- SECURITY DEFINER: precisa enxergar a casa mesmo depois que o próprio usuário saiu dela (RLS).
create function public.keep_one_admin() returns trigger language plpgsql security definer set search_path = '' as $$
declare h uuid := coalesce(old.house_id, new.house_id);
begin
  if exists (select 1 from public.houses where id = h)
     and not exists (select 1 from public.residents where house_id = h and role = 'admin' and user_id is not null) then
    raise exception 'need_one_admin' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger keep_one_admin after update or delete on public.residents
  for each row execute function public.keep_one_admin();

-- Soma dos objetivos de um morador ≤ 100% da renda.
create function public.goals_max_100() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select coalesce(sum(percent_bp), 0) from public.goals where resident_id = new.resident_id) > 10000 then
    raise exception 'goals_over_100' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger goals_max_100 after insert or update on public.goals
  for each row execute function public.goals_max_100();

-- ---------------------------------------------------------------- RLS
alter table public.houses          enable row level security;
alter table public.residents       enable row level security;
alter table public.invites         enable row level security;
alter table public.categories      enable row level security;
alter table public.incomes         enable row level security;
alter table public.goals           enable row level security;
alter table public.expenses        enable row level security;
alter table public.recurring       enable row level security;
alter table public.ai_settings     enable row level security;
alter table public.ai_secrets      enable row level security;
alter table public.ai_usage        enable row level security;
alter table public.invite_attempts enable row level security;

-- Casa: membros veem; admin renomeia/exclui; criação só pela função create_house.
create policy houses_select on public.houses for select to authenticated using (public.is_member(id));
create policy houses_update on public.houses for update to authenticated using (public.is_admin(id)) with check (public.is_admin(id));
create policy houses_delete on public.houses for delete to authenticated using (public.is_admin(id));

-- Moradores: membros veem; admin cadastra (sem login), renomeia, muda papel e remove.
create policy residents_select on public.residents for select to authenticated using (public.is_member(house_id));
create policy residents_insert on public.residents for insert to authenticated with check (public.is_admin(house_id) and user_id is null);
create policy residents_update on public.residents for update to authenticated using (public.is_admin(house_id)) with check (public.is_admin(house_id));
create policy residents_delete on public.residents for delete to authenticated using (public.is_admin(house_id));

-- Convites: só o admin vê quais estão pendentes; criação/uso pelas funções.
create policy invites_select on public.invites for select to authenticated using (public.is_admin(house_id));
create policy invites_delete on public.invites for delete to authenticated using (public.is_admin(house_id));

-- Categorias: todos os moradores criam e renomeiam; só admin exclui.
create policy categories_select on public.categories for select to authenticated using (public.is_member(house_id));
create policy categories_insert on public.categories for insert to authenticated with check (public.is_member(house_id));
create policy categories_update on public.categories for update to authenticated using (public.is_member(house_id)) with check (public.is_member(house_id));
create policy categories_delete on public.categories for delete to authenticated using (public.is_admin(house_id));

-- Ganhos e objetivos: todos veem; cada um mexe nos seus; admin em todos.
create policy incomes_select on public.incomes for select to authenticated using (public.is_member(house_id));
create policy incomes_write  on public.incomes for all to authenticated
  using (public.can_manage(house_id, resident_id)) with check (public.can_manage(house_id, resident_id));
create policy goals_select on public.goals for select to authenticated using (public.is_member(house_id));
create policy goals_write  on public.goals for all to authenticated
  using (public.can_manage(house_id, resident_id)) with check (public.can_manage(house_id, resident_id));

-- Gastos: todos veem e lançam (para si ou para a casa); edita quem lançou, o dono do gasto ou o admin.
create policy expenses_select on public.expenses for select to authenticated using (public.is_member(house_id));
create policy expenses_insert on public.expenses for insert to authenticated
  with check (public.is_member(house_id) and (resident_id is null or public.can_manage(house_id, resident_id)));
create policy expenses_update on public.expenses for update to authenticated
  using (public.is_admin(house_id) or created_by = auth.uid() or (resident_id is not null and resident_id = public.my_resident(house_id)))
  with check (public.is_member(house_id) and (resident_id is null or public.can_manage(house_id, resident_id)));
create policy expenses_delete on public.expenses for delete to authenticated
  using (public.is_admin(house_id) or created_by = auth.uid() or (resident_id is not null and resident_id = public.my_resident(house_id)));

-- Descontos automáticos: os da casa (sem morador) só o admin; os pessoais, o próprio morador.
create policy recurring_select on public.recurring for select to authenticated using (public.is_member(house_id));
create policy recurring_write  on public.recurring for all to authenticated
  using (public.can_manage(house_id, resident_id) or (resident_id is null and public.is_admin(house_id)))
  with check (public.can_manage(house_id, resident_id) or (resident_id is null and public.is_admin(house_id)));

-- IA: membros leem provedor/modelo. Gravação só pela Edge Function (service role).
create policy ai_settings_select on public.ai_settings for select to authenticated using (public.is_member(house_id));
-- ai_secrets, ai_usage e invite_attempts: SEM políticas => ninguém acessa pelo site.

revoke all on public.ai_secrets, public.ai_usage, public.invite_attempts from anon, authenticated;
revoke all on all tables in schema public from anon;      -- visitante não logado não lê nada
revoke execute on all functions in schema public from anon, public;
grant execute on function public.is_member(uuid), public.is_admin(uuid), public.my_resident(uuid), public.can_manage(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- funções chamadas pelo site (RPC)
/** Cria uma casa com o usuário como administrador e as categorias padrão. */
create function public.create_house(p_name text, p_my_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare h uuid; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  if (select count(*) from public.residents where user_id = uid) >= 10 then
    raise exception 'too_many_houses' using errcode = '23514';
  end if;
  perform set_config('app.rpc', 'on', true);
  insert into public.houses (name) values (btrim(p_name)) returning id into h;
  insert into public.residents (house_id, user_id, name, role) values (h, uid, btrim(p_my_name), 'admin');
  insert into public.categories (house_id, name, is_default)
  select h, c, true from unnest(array[
    'Moradia', 'Contas (água, luz, internet)', 'Mercado', 'Alimentação fora', 'Transporte',
    'Saúde', 'Educação', 'Lazer', 'Vestuário', 'Dízimo e ofertas', 'Assinaturas',
    'Pets', 'Cuidados pessoais', 'Presentes', 'Outros']) as c;
  perform set_config('app.rpc', 'off', true);
  return h;
end $$;

/** Gera um código de convite (uso único, 72h) para um morador sem login. Só admin. */
create function public.create_invite(p_resident uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare r public.residents; code text;
begin
  select * into r from public.residents where id = p_resident;
  if r.id is null or not public.is_admin(r.house_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if r.user_id is not null then raise exception 'resident_has_login' using errcode = '23514'; end if;
  code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6) || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  insert into public.invites (resident_id, house_id, code_hash, expires_at)
  values (r.id, r.house_id, encode(sha256(convert_to(code, 'UTF8')), 'hex'), now() + interval '72 hours')
  on conflict (resident_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at;
  return substr(code, 1, 4) || '-' || substr(code, 5, 4) || '-' || substr(code, 9, 4);
end $$;

/** Usa um código de convite: vincula o usuário logado ao morador. Limite: 10 tentativas/hora. */
create function public.join_house(p_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); norm text; inv public.invites;
begin
  if uid is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
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

-- Funções novas nascem executáveis por PUBLIC (e o Supabase ainda dá acesso ao anon): fecha e libera só para quem está logado.
revoke execute on all functions in schema public from public, anon;
grant execute on function public.create_house(text, text), public.create_invite(uuid), public.join_house(text) to authenticated;

-- Grants de tabela para usuários logados (o RLS acima decide as linhas).
grant select, insert, update, delete on public.houses, public.residents, public.categories, public.incomes,
  public.goals, public.expenses, public.recurring to authenticated;
grant select, delete on public.invites to authenticated;
grant select on public.ai_settings to authenticated;
revoke insert on public.houses from authenticated;          -- casa só nasce por create_house
