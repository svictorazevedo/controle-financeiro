-- ============================================================================
-- Controle Financeiro — esquema do banco (Supabase / Postgres 15+)
-- INSTALAÇÃO NOVA: rode este arquivo inteiro no Supabase (SQL Editor › New query › colar › Run).
-- Banco que já tinha a versão 1: rode supabase/migrations/002_v2.sql em vez deste.
--
-- Como o site é estático (GitHub Pages), NÃO existe servidor próprio: quem protege
-- os dados é o próprio Postgres, com Row Level Security (RLS). Cada regra abaixo
-- vale mesmo que alguém chame a API do Supabase direto, sem passar pelo site.
--
-- Dinheiro: sempre em CENTAVOS (bigint). Percentual: PONTOS-BASE (1000 = 10,00%).
-- ============================================================================

-- ---------------------------------------------------------------- permissões por tela
-- Módulos (telas) e níveis: 0 = sem acesso, 1 = ver, 2 = ver e editar. Admin tem 2 em tudo.
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

-- ---------------------------------------------------------------- tabelas
create table public.houses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  currency    text not null default 'BRL' check (currency ~ '^[A-Z]{3}$'),
  -- logo e ícone: imagem pequena embutida (data URL). SVG não é aceito.
  logo        text check (logo is null or (char_length(logo) <= 300000 and logo ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$')),
  icon        text check (icon is null or (char_length(icon) <= 100000 and icon ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$')),
  created_at  timestamptz not null default now()
);

create table public.residents (
  id          uuid primary key default gen_random_uuid(),
  house_id    uuid not null references public.houses(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  role        text not null default 'member' check (role in ('admin', 'member')),
  permissions jsonb not null default '{}'::jsonb check (public.valid_permissions(permissions)),
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

-- Contas: banco, carteira, poupança, cartão... O saldo é calculado (saldo inicial + movimentos).
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

-- Categorias de entrada e de saída, com um nível de subcategoria e cor.
create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  house_id    uuid not null references public.houses(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 60),
  type        text not null default 'expense' check (type in ('income', 'expense')),
  parent_id   uuid,
  color       text check (color ~ '^#[0-9a-f]{6}$'),
  is_default  boolean not null default false,
  unique (id, house_id),
  foreign key (parent_id, house_id) references public.categories(id, house_id) on delete cascade
);
create unique index categories_house_name_key on public.categories
  (house_id, type, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));

-- Rendas fixas ou previstas (salário todo mês, 13º num mês).
create table public.incomes (
  id            uuid primary key default gen_random_uuid(),
  house_id      uuid not null,
  resident_id   uuid not null,
  account_id    uuid,
  category_id   uuid,
  description   text not null check (char_length(btrim(description)) between 1 and 120),
  amount_cents  bigint not null check (amount_cents > 0 and amount_cents <= 10000000000),
  kind          text not null check (kind in ('recurring', 'once')),
  start_month   text not null check (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  end_month     text check (end_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  day           smallint check (day between 1 and 31),
  created_at    timestamptz not null default now(),
  check (end_month is null or (kind = 'recurring' and end_month >= start_month)),
  foreign key (resident_id, house_id) references public.residents(id, house_id) on delete cascade,
  foreign key (account_id, house_id) references public.accounts(id, house_id),
  foreign key (category_id, house_id) references public.categories(id, house_id) on delete set null (category_id)
);
create index on public.incomes (house_id);

-- Distribuição da renda em % (ex.: Reserva 10%).
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

-- Lançamentos: entradas e saídas com data, conta, categoria e comprovante.
create table public.transactions (
  id               uuid primary key default gen_random_uuid(),
  house_id         uuid not null references public.houses(id) on delete cascade,
  type             text not null default 'expense' check (type in ('income', 'expense')),
  resident_id      uuid,                 -- NULL = da casa (compartilhado)
  account_id       uuid,
  category_id      uuid,
  description      text not null check (char_length(btrim(description)) between 1 and 120),
  amount_cents     bigint not null check (amount_cents > 0 and amount_cents <= 10000000000),
  date             date not null check (date between '2000-01-01' and '2100-12-31'),
  -- comprovante no Storage (bucket "receipts"); o caminho sempre começa pelo id da casa
  attachment_path  text check (attachment_path is null or (char_length(attachment_path) <= 200 and split_part(attachment_path, '/', 1) = house_id::text)),
  created_by       uuid default auth.uid() references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  foreign key (resident_id, house_id) references public.residents(id, house_id) on delete set null (resident_id),
  foreign key (account_id, house_id) references public.accounts(id, house_id),
  foreign key (category_id, house_id) references public.categories(id, house_id) on delete set null (category_id)
);
create index transactions_house_date_idx on public.transactions (house_id, date);

-- Descontos automáticos: dízimo (% da renda), aluguel (fixo), parcelas (some ao terminar)...
create table public.recurring (
  id            uuid primary key default gen_random_uuid(),
  house_id      uuid not null references public.houses(id) on delete cascade,
  resident_id   uuid,                 -- NULL = da casa
  account_id    uuid,
  category_id   uuid,
  description   text not null check (char_length(btrim(description)) between 1 and 120),
  mode          text not null check (mode in ('fixed', 'percent')),
  amount_cents  bigint check (amount_cents > 0 and amount_cents <= 10000000000),
  percent_bp    integer check (percent_bp between 1 and 10000),
  start_month   text not null check (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  installments  integer check (installments between 1 and 600),
  end_month     text check (end_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  day           smallint check (day between 1 and 31),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  check ((mode = 'fixed' and amount_cents is not null and percent_bp is null)
      or (mode = 'percent' and percent_bp is not null and amount_cents is null)),
  check (end_month is null or end_month >= start_month),
  foreign key (resident_id, house_id) references public.residents(id, house_id) on delete cascade,
  foreign key (account_id, house_id) references public.accounts(id, house_id),
  foreign key (category_id, house_id) references public.categories(id, house_id) on delete set null (category_id)
);
create index on public.recurring (house_id);

-- Orçamento: limite de gasto por categoria. month NULL = vale para todo mês; com mês = só naquele mês.
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

-- Metas de economia (valor + data-alvo) e seus aportes/retiradas.
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
  amount_cents  bigint not null check (amount_cents <> 0 and abs(amount_cents) <= 10000000000),  -- negativo = retirada
  date          date not null check (date between '2000-01-01' and '2100-12-31'),
  note          text check (char_length(note) <= 120),
  created_by    uuid default auth.uid() references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  foreign key (goal_id, house_id) references public.savings_goals(id, house_id) on delete cascade
);
create index on public.goal_deposits (house_id);

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

/** Nível do usuário logado num módulo (0, 1 ou 2). Quem não é da casa: 0. */
create function public.perm(h uuid, m text) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when r.role = 'admin' then 2 else coalesce((r.permissions ->> m)::integer, public.perm_default(m)) end
      from public.residents r where r.house_id = h and r.user_id = auth.uid()), 0)
$$;

/** Pode ver pelo menos uma das telas da lista? */
create function public.can_view(h uuid, ms text[]) returns boolean
language sql stable security definer set search_path = '' as
$$ select exists (select 1 from unnest(ms) m where public.perm(h, m) >= 1) $$;

/**
 * 2FA: quem ativou a verificação em duas etapas só acessa os dados com uma sessão verificada (aal2).
 * Quem não ativou continua entrando só com a senha.
 */
create function public.mfa_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status::text = 'verified')
$$;

-- Telas que precisam dos lançamentos / dos fixos para funcionar.
create function public.tx_screens() returns text[] language sql immutable set search_path = '' as
$$ select array['painel', 'lancamentos', 'contas', 'calendario', 'relatorios'] $$;
create function public.fixed_screens() returns text[] language sql immutable set search_path = '' as
$$ select array['painel', 'lancamentos', 'contas', 'calendario', 'relatorios', 'recorrentes'] $$;

-- ---------------------------------------------------------------- gatilhos de integridade
-- Um registro nunca muda de casa.
create function public.keep_house_id() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.house_id is distinct from old.house_id then
    raise exception 'house_id_immutable' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger keep_house before update on public.residents     for each row execute function public.keep_house_id();
create trigger keep_house before update on public.categories    for each row execute function public.keep_house_id();
create trigger keep_house before update on public.incomes       for each row execute function public.keep_house_id();
create trigger keep_house before update on public.goals         for each row execute function public.keep_house_id();
create trigger keep_house before update on public.transactions  for each row execute function public.keep_house_id();
create trigger keep_house before update on public.recurring     for each row execute function public.keep_house_id();
create trigger keep_house before update on public.accounts      for each row execute function public.keep_house_id();
create trigger keep_house before update on public.budgets       for each row execute function public.keep_house_id();
create trigger keep_house before update on public.savings_goals for each row execute function public.keep_house_id();
create trigger keep_house before update on public.goal_deposits for each row execute function public.keep_house_id();

-- Quem lançou é sempre o usuário logado (não dá para forjar).
create function public.transaction_author() returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then new.created_by := auth.uid();
  else new.created_by := old.created_by; end if;
  return new;
end $$;
create trigger transaction_author before insert or update on public.transactions for each row execute function public.transaction_author();
create trigger deposit_author before insert or update on public.goal_deposits for each row execute function public.transaction_author();

-- Categoria do lançamento precisa ser do mesmo tipo (entrada/saída).
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

-- Subcategoria: só um nível, mesmo tipo da categoria-mãe; orçamento só em categoria de saída.
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
alter table public.accounts        enable row level security;
alter table public.categories      enable row level security;
alter table public.incomes         enable row level security;
alter table public.goals           enable row level security;
alter table public.transactions    enable row level security;
alter table public.recurring       enable row level security;
alter table public.budgets         enable row level security;
alter table public.savings_goals   enable row level security;
alter table public.goal_deposits   enable row level security;
alter table public.ai_settings     enable row level security;
alter table public.ai_secrets      enable row level security;
alter table public.ai_usage        enable row level security;
alter table public.invite_attempts enable row level security;

-- (O bloco de políticas abaixo é idêntico ao de supabase/migrations/002_v2.sql.)
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
revoke all on all tables in schema public from anon;      -- visitante não logado não lê nada
revoke execute on all functions in schema public from anon, public;
grant execute on function public.is_member(uuid), public.is_admin(uuid), public.my_resident(uuid), public.can_manage(uuid, uuid),
  public.perm(uuid, text), public.can_view(uuid, text[]), public.mfa_ok(), public.perm_default(text), public.valid_permissions(jsonb),
  public.tx_screens(), public.fixed_screens() to authenticated;

-- ---------------------------------------------------------------- comprovantes (Supabase Storage)
-- Bucket privado. Caminho: <id da casa>/<arquivo>. Ver: quem vê lançamentos; enviar/apagar: "Lançamentos: editar".
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

create function public.receipt_house(path text) returns uuid
language sql immutable set search_path = '' as $$
  select case when split_part(path, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then split_part(path, '/', 1)::uuid end
$$;
grant execute on function public.receipt_house(text) to authenticated;

create policy receipts_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and public.mfa_ok() and public.can_view(public.receipt_house(name), public.tx_screens()));
create policy receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and public.mfa_ok() and public.perm(public.receipt_house(name), 'lancamentos') = 2);
create policy receipts_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and public.mfa_ok() and public.perm(public.receipt_house(name), 'lancamentos') = 2);

-- ---------------------------------------------------------------- funções chamadas pelo site (RPC)
/** Cria uma casa com o usuário como administrador, contas e categorias padrão. */
create function public.create_house(p_name text, p_my_name text) returns uuid
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

/** Contas e categorias padrão (também usado pela migração da v1). */
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

/** Gera um código de convite (uso único, 72h) para um morador sem login. Só admin. */
create function public.create_invite(p_resident uuid) returns text
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

/** Usa um código de convite: vincula o usuário logado ao morador. Limite: 10 tentativas/hora. */
create function public.join_house(p_code text) returns uuid
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

-- Funções novas nascem executáveis por PUBLIC (e o Supabase ainda dá acesso ao anon): fecha e libera só para quem está logado.
revoke execute on all functions in schema public from public, anon;
grant execute on function public.create_house(text, text), public.create_invite(uuid), public.join_house(text) to authenticated;

-- Grants de tabela para usuários logados (o RLS acima decide as linhas).
grant select, insert, update, delete on public.houses, public.residents, public.categories, public.incomes,
  public.goals, public.transactions, public.recurring, public.accounts, public.budgets,
  public.savings_goals, public.goal_deposits to authenticated;
grant select, delete on public.invites to authenticated;
grant select on public.ai_settings to authenticated;
revoke insert on public.houses from authenticated;          -- casa só nasce por create_house
