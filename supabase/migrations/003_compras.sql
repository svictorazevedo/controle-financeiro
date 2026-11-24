-- ============================================================================
-- Controle Financeiro v3.2 — COMPRAS: cupons fiscais, preços por produto, mercados e pesquisa de preços.
-- Rode no Supabase (SQL Editor › New query › colar › Run) DEPOIS do schema.sql (instalação nova)
-- ou da 002_v2.sql (quem já usa). Roda numa transação: se der erro, nada muda. Pode rodar de novo? Não:
-- rode uma vez só.
--
-- Dinheiro em CENTAVOS; quantidade em MILÉSIMOS (1,250 kg = 1250).
-- ============================================================================
begin;

-- ---------------------------------------------------------------- permissão por tela "compras"
create or replace function public.perm_default(m text) returns integer
language sql immutable set search_path = '' as $$
  select case m
    when 'painel' then 1 when 'lancamentos' then 2 when 'contas' then 1 when 'recorrentes' then 2
    when 'categorias' then 2 when 'orcamento' then 1 when 'metas' then 2 when 'relatorios' then 1
    when 'calendario' then 1 when 'ia' then 1 when 'compras' then 2 else 0 end
$$;

create or replace function public.valid_permissions(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object' and not exists (
    select 1 from jsonb_each(p) e
     where e.key not in ('painel', 'lancamentos', 'contas', 'recorrentes', 'categorias', 'orcamento', 'metas', 'relatorios', 'calendario', 'ia', 'compras')
        or e.value not in ('0'::jsonb, '1'::jsonb, '2'::jsonb))
$$;

-- Região usada na pesquisa de preços (ex.: "Cuiabá - MT, bairro Centro").
alter table public.houses add column region text check (region is null or char_length(region) <= 120);

-- Permite ligar um cupom ao lançamento de saída da mesma casa (chave estrangeira composta).
alter table public.transactions add constraint transactions_id_house_key unique (id, house_id);

/** Todos os caminhos de imagem começam pelo id da casa (bucket "receipts"). */
create function public.paths_in_house(paths text[], h uuid) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(split_part(p, '/', 1) = h::text and char_length(p) <= 200), true) from unnest(paths) p
$$;

-- ---------------------------------------------------------------- tabelas
-- Mercados/lojas. CNPJ identifica a filial; sem CNPJ, o nome não pode repetir.
create table public.stores (
  id          uuid primary key default gen_random_uuid(),
  house_id    uuid not null references public.houses(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  cnpj        text check (cnpj ~ '^\d{14}$'),
  address     text check (char_length(address) <= 200),
  created_at  timestamptz not null default now(),
  unique (id, house_id)
);
create unique index stores_house_cnpj_key on public.stores (house_id, cnpj) where cnpj is not null;
create unique index stores_house_name_key on public.stores (house_id, lower(btrim(name))) where cnpj is null;

-- Produtos "de verdade" (o mesmo arroz em cupons de mercados diferentes vira um produto só).
-- list_mode: 'auto' entra na lista do mês se se repetir; 'always' sempre; 'never' nunca.
create table public.products (
  id          uuid primary key default gen_random_uuid(),
  house_id    uuid not null references public.houses(id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  unit        text not null default 'un' check (unit in ('un', 'kg', 'g', 'l', 'ml', 'pct', 'cx', 'dz')),
  ean         text check (ean ~ '^\d{8,14}$'),
  list_mode   text not null default 'auto' check (list_mode in ('auto', 'always', 'never')),
  created_at  timestamptz not null default now(),
  unique (id, house_id)
);
create unique index products_house_name_key on public.products (house_id, lower(btrim(name)));
create unique index products_house_ean_key on public.products (house_id, ean) where ean is not null;

-- Como cada mercado escreve o produto no cupom ("ARROZ T.JOAO 5KG") -> produto. Da 2ª vez já reconhece sozinho.
create table public.product_aliases (
  house_id    uuid not null,
  alias       text not null check (char_length(alias) between 1 and 120),
  product_id  uuid not null,
  primary key (house_id, alias),
  foreign key (product_id, house_id) references public.products(id, house_id) on delete cascade
);

-- Cupom fiscal (uma compra).
create table public.shop_receipts (
  id              uuid primary key default gen_random_uuid(),
  house_id        uuid not null references public.houses(id) on delete cascade,
  store_id        uuid not null,
  purchased_at    date not null check (purchased_at between '2000-01-01' and '2100-12-31'),
  total_cents     bigint not null check (total_cents > 0 and total_cents <= 10000000000),
  discount_cents  bigint not null default 0 check (discount_cents >= 0 and discount_cents <= 10000000000),
  access_key      text check (access_key ~ '^\d{44}$'),
  image_paths     text[] not null default '{}' check (cardinality(image_paths) <= 8 and public.paths_in_house(image_paths, house_id)),
  source          text not null default 'photo' check (source in ('photo', 'xml', 'manual')),
  transaction_id  uuid,
  created_by      uuid default auth.uid() references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (id, house_id),
  foreign key (store_id, house_id) references public.stores(id, house_id),
  foreign key (transaction_id, house_id) references public.transactions(id, house_id) on delete set null (transaction_id)
);
create index shop_receipts_house_date_idx on public.shop_receipts (house_id, purchased_at);
create unique index shop_receipts_access_key on public.shop_receipts (house_id, access_key) where access_key is not null;

-- Itens do cupom: preço unitário pago, quantidade, desconto.
create table public.shop_items (
  id                uuid primary key default gen_random_uuid(),
  house_id          uuid not null,
  receipt_id        uuid not null,
  product_id        uuid not null,
  position          smallint check (position between 1 and 999),
  raw_name          text not null check (char_length(btrim(raw_name)) between 1 and 120),
  code              text check (char_length(code) <= 20),
  quantity_milli    integer not null check (quantity_milli > 0 and quantity_milli <= 100000000),
  unit_price_cents  bigint not null check (unit_price_cents > 0 and unit_price_cents <= 10000000000),
  discount_cents    bigint not null default 0 check (discount_cents >= 0 and discount_cents <= 10000000000),
  total_cents       bigint not null check (total_cents > 0 and total_cents <= 10000000000),
  foreign key (receipt_id, house_id) references public.shop_receipts(id, house_id) on delete cascade,
  foreign key (product_id, house_id) references public.products(id, house_id) on delete cascade
);
create index shop_items_house_product_idx on public.shop_items (house_id, product_id);
create index shop_items_receipt_idx on public.shop_items (receipt_id);

-- Cotações: preço visto num mercado (pesquisa na web pela IA, encarte, ou digitado).
create table public.price_quotes (
  id           uuid primary key default gen_random_uuid(),
  house_id     uuid not null,
  product_id   uuid not null,
  store_id     uuid,
  store_name   text not null check (char_length(btrim(store_name)) between 1 and 80),
  price_cents  bigint not null check (price_cents > 0 and price_cents <= 10000000000),
  source       text not null default 'manual' check (source in ('web', 'manual', 'flyer')),
  url          text check (url is null or (url ~ '^https?://' and char_length(url) <= 500)),
  note         text check (char_length(note) <= 200),
  observed_on  date not null check (observed_on between '2000-01-01' and '2100-12-31'),
  created_by   uuid default auth.uid() references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  foreign key (product_id, house_id) references public.products(id, house_id) on delete cascade,
  foreign key (store_id, house_id) references public.stores(id, house_id) on delete set null (store_id)
);
create index price_quotes_house_product_idx on public.price_quotes (house_id, product_id, observed_on);

-- ---------------------------------------------------------------- gatilhos
create trigger keep_house before update on public.stores        for each row execute function public.keep_house_id();
create trigger keep_house before update on public.products      for each row execute function public.keep_house_id();
create trigger keep_house before update on public.product_aliases for each row execute function public.keep_house_id();
create trigger keep_house before update on public.shop_receipts for each row execute function public.keep_house_id();
create trigger keep_house before update on public.shop_items    for each row execute function public.keep_house_id();
create trigger keep_house before update on public.price_quotes  for each row execute function public.keep_house_id();
create trigger receipt_author before insert or update on public.shop_receipts for each row execute function public.transaction_author();
create trigger quote_author   before insert or update on public.price_quotes  for each row execute function public.transaction_author();

-- ---------------------------------------------------------------- RLS
alter table public.stores          enable row level security;
alter table public.products        enable row level security;
alter table public.product_aliases enable row level security;
alter table public.shop_receipts   enable row level security;
alter table public.shop_items      enable row level security;
alter table public.price_quotes    enable row level security;

create policy mfa on public.stores          as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.products        as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.product_aliases as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.shop_receipts   as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.shop_items      as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());
create policy mfa on public.price_quotes    as restrictive for all to authenticated using (public.mfa_ok()) with check (public.mfa_ok());

-- Ver: quem tem a tela Compras. Gravar: "Compras: editar". Cupom: altera/exclui quem lançou ou o admin.
create policy stores_select on public.stores for select to authenticated using (public.perm(house_id, 'compras') >= 1);
create policy stores_write  on public.stores for all to authenticated using (public.perm(house_id, 'compras') = 2) with check (public.perm(house_id, 'compras') = 2);
create policy products_select on public.products for select to authenticated using (public.perm(house_id, 'compras') >= 1);
create policy products_write  on public.products for all to authenticated using (public.perm(house_id, 'compras') = 2) with check (public.perm(house_id, 'compras') = 2);
create policy aliases_select on public.product_aliases for select to authenticated using (public.perm(house_id, 'compras') >= 1);
create policy aliases_write  on public.product_aliases for all to authenticated using (public.perm(house_id, 'compras') = 2) with check (public.perm(house_id, 'compras') = 2);
create policy shop_receipts_select on public.shop_receipts for select to authenticated using (public.perm(house_id, 'compras') >= 1);
create policy shop_receipts_insert on public.shop_receipts for insert to authenticated with check (public.perm(house_id, 'compras') = 2);
create policy shop_receipts_update on public.shop_receipts for update to authenticated
  using (public.perm(house_id, 'compras') = 2 and (public.is_admin(house_id) or created_by = auth.uid()))
  with check (public.perm(house_id, 'compras') = 2);
create policy shop_receipts_delete on public.shop_receipts for delete to authenticated
  using (public.perm(house_id, 'compras') = 2 and (public.is_admin(house_id) or created_by = auth.uid()));
create policy shop_items_select on public.shop_items for select to authenticated using (public.perm(house_id, 'compras') >= 1);
create policy shop_items_write  on public.shop_items for all to authenticated
  using (public.perm(house_id, 'compras') = 2 and exists (select 1 from public.shop_receipts r where r.id = receipt_id and (public.is_admin(r.house_id) or r.created_by = auth.uid())))
  with check (public.perm(house_id, 'compras') = 2 and exists (select 1 from public.shop_receipts r where r.id = receipt_id and (public.is_admin(r.house_id) or r.created_by = auth.uid())));
create policy price_quotes_select on public.price_quotes for select to authenticated using (public.perm(house_id, 'compras') >= 1);
create policy price_quotes_write  on public.price_quotes for all to authenticated using (public.perm(house_id, 'compras') = 2) with check (public.perm(house_id, 'compras') = 2);

-- Comprovantes/fotos de cupom no Storage: agora quem tem "Compras" também vê e envia.
drop policy receipts_select on storage.objects;
drop policy receipts_insert on storage.objects;
drop policy receipts_delete on storage.objects;
create policy receipts_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and public.mfa_ok() and (public.can_view(public.receipt_house(name), public.tx_screens()) or public.perm(public.receipt_house(name), 'compras') >= 1));
create policy receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and public.mfa_ok() and (public.perm(public.receipt_house(name), 'lancamentos') = 2 or public.perm(public.receipt_house(name), 'compras') = 2));
create policy receipts_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and public.mfa_ok() and (public.perm(public.receipt_house(name), 'lancamentos') = 2 or public.perm(public.receipt_house(name), 'compras') = 2));

-- ---------------------------------------------------------------- salvar um cupom inteiro (uma transação só)
/**
 * p = {
 *   store: { id } | { name, cnpj, address },
 *   purchased_at, total_cents, discount_cents, access_key, image_paths[], source,
 *   items: [{ product_id | product: { name, unit, ean }, raw_name, alias, code, position,
 *             quantity_milli, unit_price_cents, discount_cents, total_cents }],
 *   transaction: null | { account_id, category_id, resident_id, description }
 * }
 * SECURITY INVOKER: roda com as permissões de quem chama (RLS vale normalmente).
 * Lançamento de saída junto exige também "Lançamentos: editar".
 */
create function public.save_shop_receipt(p_house uuid, p jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  v_store uuid; v_receipt uuid; v_product uuid; v_tx uuid; it jsonb; s jsonb := p -> 'store'; t jsonb := p -> 'transaction';
  v_cnpj text := nullif(s ->> 'cnpj', ''); v_alias text;
begin
  if public.perm(p_house, 'compras') < 2 then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 or jsonb_array_length(p -> 'items') > 300 then
    raise exception 'receipt_items_invalid' using errcode = '23514';
  end if;

  -- mercado: pelo id, pelo CNPJ, pelo nome (sem CNPJ) ou cria
  if s ? 'id' then
    select id into v_store from public.stores where id = (s ->> 'id')::uuid and house_id = p_house;
  elsif v_cnpj is not null then
    select id into v_store from public.stores where house_id = p_house and cnpj = v_cnpj;
  else
    select id into v_store from public.stores where house_id = p_house and cnpj is null and lower(btrim(name)) = lower(btrim(s ->> 'name'));
  end if;
  if v_store is null then
    if s ? 'id' then raise exception 'store_not_found' using errcode = '23503'; end if;
    insert into public.stores (house_id, name, cnpj, address)
    values (p_house, btrim(s ->> 'name'), v_cnpj, nullif(btrim(s ->> 'address'), '')) returning id into v_store;
  end if;

  -- lançamento de saída (opcional)
  if t is not null and jsonb_typeof(t) = 'object' then
    insert into public.transactions (house_id, type, resident_id, account_id, category_id, description, amount_cents, date, attachment_path)
    values (p_house, 'expense', nullif(t ->> 'resident_id', '')::uuid, nullif(t ->> 'account_id', '')::uuid, nullif(t ->> 'category_id', '')::uuid,
            coalesce(nullif(btrim(t ->> 'description'), ''), 'Mercado'), (p ->> 'total_cents')::bigint, (p ->> 'purchased_at')::date,
            (p -> 'image_paths') ->> 0)
    returning id into v_tx;
  end if;

  insert into public.shop_receipts (house_id, store_id, purchased_at, total_cents, discount_cents, access_key, image_paths, source, transaction_id)
  values (p_house, v_store, (p ->> 'purchased_at')::date, (p ->> 'total_cents')::bigint, coalesce((p ->> 'discount_cents')::bigint, 0),
          nullif(p ->> 'access_key', ''), coalesce(array(select jsonb_array_elements_text(p -> 'image_paths')), '{}'),
          coalesce(p ->> 'source', 'photo'), v_tx)
  returning id into v_receipt;

  for it in select * from jsonb_array_elements(p -> 'items') loop
    v_product := null;
    if it ? 'product_id' and nullif(it ->> 'product_id', '') is not null then
      select id into v_product from public.products where id = (it ->> 'product_id')::uuid and house_id = p_house;
      if v_product is null then raise exception 'product_not_found' using errcode = '23503'; end if;
    else
      if nullif(it #>> '{product,ean}', '') is not null then
        select id into v_product from public.products where house_id = p_house and ean = it #>> '{product,ean}';
      end if;
      if v_product is null then
        select id into v_product from public.products where house_id = p_house and lower(btrim(name)) = lower(btrim(it #>> '{product,name}'));
      end if;
      if v_product is null then
        insert into public.products (house_id, name, unit, ean)
        values (p_house, btrim(it #>> '{product,name}'), coalesce(nullif(it #>> '{product,unit}', ''), 'un'), nullif(it #>> '{product,ean}', ''))
        returning id into v_product;
      end if;
    end if;
    insert into public.shop_items (house_id, receipt_id, product_id, position, raw_name, code, quantity_milli, unit_price_cents, discount_cents, total_cents)
    values (p_house, v_receipt, v_product, nullif(it ->> 'position', '')::smallint, btrim(it ->> 'raw_name'), nullif(it ->> 'code', ''),
            (it ->> 'quantity_milli')::integer, (it ->> 'unit_price_cents')::bigint, coalesce((it ->> 'discount_cents')::bigint, 0), (it ->> 'total_cents')::bigint);
    -- lembra como esse mercado escreve o produto (a próxima leitura já acerta sozinha)
    v_alias := left(lower(regexp_replace(btrim(coalesce(nullif(it ->> 'alias', ''), it ->> 'raw_name')), '\s+', ' ', 'g')), 120);
    if v_alias <> '' then
      insert into public.product_aliases (house_id, alias, product_id) values (p_house, v_alias, v_product)
      on conflict (house_id, alias) do update set product_id = excluded.product_id;
    end if;
  end loop;
  return v_receipt;
end $$;

/** Junta dois produtos (ex.: "Arroz Tio Joao 5kg" e "Arroz T. João 5 kg"): move histórico, cotações e apelidos. */
create function public.merge_products(p_from uuid, p_into uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare h uuid; v_ean text;
begin
  select house_id, ean into h, v_ean from public.products where id = p_from;
  if h is null or not exists (select 1 from public.products where id = p_into and house_id = h) or p_from = p_into then
    raise exception 'product_not_found' using errcode = '23503';
  end if;
  if public.perm(h, 'compras') < 2 then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.shop_items set product_id = p_into where product_id = p_from;
  update public.price_quotes set product_id = p_into where product_id = p_from;
  update public.product_aliases set product_id = p_into where product_id = p_from;
  delete from public.products where id = p_from;
  if v_ean is not null then update public.products set ean = v_ean where id = p_into and ean is null; end if;
end $$;

-- ---------------------------------------------------------------- grants
revoke all on all tables in schema public from anon;
grant select, insert, update, delete on public.stores, public.products, public.product_aliases, public.shop_receipts,
  public.shop_items, public.price_quotes to authenticated;
revoke execute on all functions in schema public from public, anon;
grant execute on function public.paths_in_house(text[], uuid), public.save_shop_receipt(uuid, jsonb), public.merge_products(uuid, uuid),
  public.perm_default(text), public.valid_permissions(jsonb) to authenticated;

commit;
