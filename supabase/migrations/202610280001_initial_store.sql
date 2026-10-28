create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create type public.admin_role as enum ('owner', 'manager', 'order_staff');
create type public.order_status as enum (
  'new', 'awaiting_confirmation', 'confirmed', 'preparing',
  'ready_for_dispatch', 'dispatched', 'delivered', 'cancelled'
);
create type public.payment_status as enum ('pending', 'unpaid', 'paid', 'refunded', 'failed');

create table public.admin_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role public.admin_role not null default 'order_staff',
  display_name text not null default '',
  created_at timestamptz not null default now()
);

create function private.current_admin_role()
returns public.admin_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.admin_profiles p where p.user_id = (select auth.uid())
$$;

create function private.has_admin_role(allowed public.admin_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.current_admin_role() = any (allowed), false)
$$;

revoke all on function private.current_admin_role() from public, anon;
revoke all on function private.has_admin_role(public.admin_role[]) from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.current_admin_role() to authenticated;
grant execute on function private.has_admin_role(public.admin_role[]) to authenticated;

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table public.categories (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text not null default '',
  image_path text,
  is_visible boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default extensions.gen_random_uuid(),
  category_id uuid references public.categories(id) on delete set null,
  name text not null check (char_length(name) between 1 and 160),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text not null default '',
  price_lkr integer not null check (price_lkr between 0 and 100000000),
  sale_price_lkr integer check (sale_price_lkr is null or (sale_price_lkr between 0 and price_lkr)),
  sale_starts_at timestamptz,
  sale_ends_at timestamptz,
  sku text unique,
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  low_stock_threshold integer not null default 5 check (low_stock_threshold >= 0),
  is_available boolean not null default true,
  is_published boolean not null default false,
  is_featured boolean not null default false,
  is_new boolean not null default false,
  is_bestseller boolean not null default false,
  gift_box_eligible boolean not null default true,
  tags text[] not null default '{}',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_public_catalogue_idx on public.products (is_published, archived_at, category_id);
create index products_name_search_idx on public.products using gin (to_tsvector('simple', name || ' ' || description));

create view public.storefront_products with (security_invoker = false) as
select
  id, category_id, name, slug, description, price_lkr, sale_price_lkr,
  sale_starts_at, sale_ends_at,
  (is_available and stock_quantity > 0) as is_available,
  is_featured, is_new, is_bestseller, gift_box_eligible, tags, created_at
from public.products
where is_published and archived_at is null;

create table public.product_images (
  id uuid primary key default extensions.gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  storage_path text not null unique,
  alt_text text not null default '',
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index product_images_one_primary_idx on public.product_images(product_id) where is_primary;

create table public.product_variants (
  id uuid primary key default extensions.gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  sku text unique,
  price_delta_lkr integer not null default 0,
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  is_available boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, name)
);

create table public.inventory_movements (
  id uuid primary key default extensions.gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete set null,
  quantity_delta integer not null check (quantity_delta <> 0),
  quantity_after integer not null check (quantity_after >= 0),
  reason text not null check (char_length(reason) between 1 and 240),
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.packaging_options (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 100),
  description text not null default '',
  image_path text,
  price_lkr integer not null default 0 check (price_lkr >= 0),
  is_available boolean not null default true,
  min_items integer not null default 0 check (min_items >= 0),
  max_items integer check (max_items is null or max_items >= min_items),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.delivery_zones (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null unique,
  fee_lkr integer not null default 0 check (fee_lkr >= 0),
  estimated_delivery text not null default '',
  is_available boolean not null default true,
  sort_order integer not null default 0
);

create table public.promotions (
  id uuid primary key default extensions.gen_random_uuid(),
  code text unique,
  name text not null,
  discount_type text not null check (discount_type in ('percentage', 'fixed')),
  discount_value integer not null check (discount_value > 0),
  minimum_order_lkr integer not null default 0 check (minimum_order_lkr >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  usage_limit integer check (usage_limit is null or usage_limit > 0),
  usage_count integer not null default 0 check (usage_count >= 0),
  product_ids uuid[] not null default '{}',
  category_ids uuid[] not null default '{}',
  is_active boolean not null default false,
  banner_text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (discount_type <> 'percentage' or discount_value <= 100),
  check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create table public.store_settings (
  id boolean primary key default true check (id),
  settings jsonb not null default jsonb_build_object(
    'store_name', 'The Wild Co.',
    'currency', 'LKR',
    'instagram_handle', '@thewildcoshop',
    'instagram_url', 'https://www.instagram.com/thewildcoshop/',
    'instagram_posts', 54,
    'instagram_followers', 326,
    'instagram_snapshot_date', '2026-10-28',
    'whatsapp_number', '',
    'contact_email', '',
    'contact_phone', '',
    'hero_title', 'A little joy, wrapped just for you.',
    'hero_description', 'Discover thoughtful little gifts, meet your new stationery sidekicks, and make someone''s day extra special.',
    'announcement', 'Little things, thoughtful gifts, lots of joy ✿',
    'delivery_information', 'Delivery options and fees are confirmed by the shop before an order is final.',
    'logo_path', 'assets/the-wild-co-logo.png',
    'store_open', true,
    'brand_primary', '#A8C3A6',
    'brand_sage', '#537865',
    'brand_cream', '#FFFAF0',
    'brand_butter', '#F4DC8C',
    'brand_blush', '#F4B7B2'
  ),
  updated_at timestamptz not null default now(),
  check (settings ->> 'currency' is null or settings ->> 'currency' = 'LKR'),
  check (settings ->> 'whatsapp_number' is null or settings ->> 'whatsapp_number' = '' or settings ->> 'whatsapp_number' ~ '^[1-9][0-9]{7,14}$'),
  check (settings ->> 'instagram_handle' is null or settings ->> 'instagram_handle' ~ '^@[A-Za-z0-9._]{1,30}$'),
  check (settings ->> 'instagram_url' is null or settings ->> 'instagram_url' ~ '^https://(www[.])?instagram[.]com/[A-Za-z0-9._]+/?$'),
  check (settings ->> 'instagram_posts' is null or settings ->> 'instagram_posts' ~ '^[0-9]{1,9}$'),
  check (settings ->> 'instagram_followers' is null or settings ->> 'instagram_followers' ~ '^[0-9]{1,9}$'),
  check (settings ->> 'store_open' is null or settings ->> 'store_open' in ('true', 'false'))
);
insert into public.store_settings (id) values (true) on conflict (id) do nothing;

create table public.homepage_sections (
  id uuid primary key default extensions.gen_random_uuid(),
  section_key text not null unique,
  title text not null default '',
  content jsonb not null default '{}'::jsonb,
  is_visible boolean not null default true,
  sort_order integer not null default 0,
  updated_at timestamptz not null default now()
);

create table public.game_settings (
  id uuid primary key default extensions.gen_random_uuid(),
  game_key text not null unique check (game_key in ('little_hunt', 'memory_match', 'gift_mood', 'affirmation', 'budget_challenge')),
  title text not null,
  description text not null default '',
  settings jsonb not null default '{}'::jsonb,
  is_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table public.testimonials (
  id uuid primary key default extensions.gen_random_uuid(),
  display_name text not null check (char_length(display_name) between 1 and 100),
  review_text text not null check (char_length(review_text) between 1 and 2000),
  image_path text,
  is_approved boolean not null default false,
  is_published boolean not null default false,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (not is_published or is_approved)
);

create table public.orders (
  id uuid primary key default extensions.gen_random_uuid(),
  assigned_to uuid references public.admin_profiles(user_id) on delete set null,
  order_number text not null unique default ('WC-' || upper(substr(replace(extensions.gen_random_uuid()::text, '-', ''), 1, 10))),
  customer_name text not null check (char_length(customer_name) between 1 and 120),
  contact_number text not null check (char_length(contact_number) between 6 and 32),
  delivery_address text not null check (char_length(delivery_address) between 1 and 1000),
  gift_message text not null default '' check (char_length(gift_message) <= 400),
  packaging_id uuid references public.packaging_options(id) on delete set null,
  packaging_name_snapshot text not null default '',
  delivery_zone_id uuid references public.delivery_zones(id) on delete set null,
  delivery_zone_name_snapshot text not null default '',
  subtotal_lkr integer not null check (subtotal_lkr >= 0),
  packaging_charge_lkr integer not null default 0 check (packaging_charge_lkr >= 0),
  delivery_charge_lkr integer not null default 0 check (delivery_charge_lkr >= 0),
  discount_lkr integer not null default 0 check (discount_lkr >= 0),
  total_lkr integer not null check (total_lkr >= 0),
  status public.order_status not null default 'new',
  payment_status public.payment_status not null default 'pending',
  internal_notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_status_created_idx on public.orders(status, created_at desc);
create index orders_created_idx on public.orders(created_at desc);

create table public.order_items (
  id uuid primary key default extensions.gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  product_name_snapshot text not null,
  variant_name_snapshot text not null default '',
  quantity integer not null check (quantity between 1 and 100),
  unit_price_lkr integer not null check (unit_price_lkr >= 0),
  line_total_lkr integer not null check (line_total_lkr >= 0)
);
create index order_items_order_idx on public.order_items(order_id);

create table public.order_history (
  id uuid primary key default extensions.gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  old_status public.order_status,
  new_status public.order_status not null,
  note text not null default '',
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index order_history_order_idx on public.order_history(order_id, created_at desc);

create table public.audit_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table private.order_rate_limits (
  ip_hash text primary key check (ip_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  attempts integer not null check (attempts > 0),
  updated_at timestamptz not null default now()
);

insert into public.categories (name, slug, sort_order) values
  ('Candles', 'candles', 1),
  ('Stationery', 'stationery', 2),
  ('Affirmation cards', 'affirmation-cards', 3),
  ('Little extras', 'little-extras', 4)
on conflict (slug) do nothing;

insert into public.game_settings (game_key, title, description, settings) values
  ('little_hunt', 'The Wild Little Hunt', 'Find the hidden characters.', '{"reward":"A little joy looks good on you ♡"}'),
  ('memory_match', 'The Little Match Game', 'Match the cheerful characters.', '{"pairs":4}'),
  ('gift_mood', 'What''s Your Gift Mood?', 'Find a gift for the feeling.', '{"recommendations":{}}'),
  ('affirmation', 'A Little Affirmation', 'A little reminder, whenever you need one.', '{"messages":[]}'),
  ('budget_challenge', 'The Gift Budget Challenge', 'Find a thoughtful gift within your budget.', '{"currency":"LKR"}')
on conflict (game_key) do nothing;

create function private.record_stock_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.stock_quantity is distinct from old.stock_quantity then
    insert into public.inventory_movements (product_id, quantity_delta, quantity_after, reason, actor_id)
    values (
      new.id,
      new.stock_quantity - old.stock_quantity,
      new.stock_quantity,
      'Product stock adjusted',
      (select auth.uid())
    );
  end if;
  return new;
end;
$$;

create function private.record_order_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    insert into public.order_history (order_id, old_status, new_status, note, actor_id)
    values (new.id, old.status, new.status, 'Status updated by administrator', (select auth.uid()));
  end if;
  return new;
end;
$$;

create function private.record_new_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.order_history (order_id, old_status, new_status, note)
  values (new.id, null, new.status, 'Order enquiry saved. Payment and availability are not confirmed.');
  return new;
end;
$$;

create trigger products_updated_at before update on public.products
for each row execute function public.set_updated_at();
create trigger categories_updated_at before update on public.categories
for each row execute function public.set_updated_at();
create trigger product_variants_updated_at before update on public.product_variants
for each row execute function public.set_updated_at();
create trigger packaging_options_updated_at before update on public.packaging_options
for each row execute function public.set_updated_at();
create trigger promotions_updated_at before update on public.promotions
for each row execute function public.set_updated_at();
create trigger orders_updated_at before update on public.orders
for each row execute function public.set_updated_at();
create trigger orders_status_history after update on public.orders
for each row execute function private.record_order_status_change();
create trigger orders_initial_history after insert on public.orders
for each row execute function private.record_new_order();
create trigger products_stock_history after update on public.products
for each row execute function private.record_stock_change();
create trigger store_settings_updated_at before update on public.store_settings
for each row execute function public.set_updated_at();
create trigger homepage_sections_updated_at before update on public.homepage_sections
for each row execute function public.set_updated_at();
create trigger game_settings_updated_at before update on public.game_settings
for each row execute function public.set_updated_at();

alter table public.admin_profiles enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_images enable row level security;
alter table public.product_variants enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.packaging_options enable row level security;
alter table public.delivery_zones enable row level security;
alter table public.promotions enable row level security;
alter table public.store_settings enable row level security;
alter table public.homepage_sections enable row level security;
alter table public.game_settings enable row level security;
alter table public.testimonials enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_history enable row level security;
alter table public.audit_logs enable row level security;

create policy "Admins can view their own profile"
on public.admin_profiles for select to authenticated using (user_id = (select auth.uid()));
create policy "Owners can manage admin profiles"
on public.admin_profiles for all to authenticated
using ((select private.has_admin_role(array['owner']::public.admin_role[])))
with check ((select private.has_admin_role(array['owner']::public.admin_role[])));

create policy "Visitors can view visible categories"
on public.categories for select to anon, authenticated using (is_visible);
create policy "Admins can manage categories"
on public.categories for all to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])))
with check ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));

create policy "Visitors can view published products"
on public.products for select to anon, authenticated
using (is_published and archived_at is null);
create policy "Admins can manage products"
on public.products for all to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])))
with check ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));

create policy "Visitors can view images of published products"
on public.product_images for select to anon, authenticated
using (exists (select 1 from public.storefront_products p where p.id = product_id));
create policy "Admins can manage product images"
on public.product_images for all to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])))
with check ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));

create policy "Visitors can view variants of published products"
on public.product_variants for select to anon, authenticated
using (is_available and exists (select 1 from public.storefront_products p where p.id = product_id and p.is_available));
create policy "Admins can manage variants"
on public.product_variants for all to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])))
with check ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));

create policy "Admins can view stock movements"
on public.inventory_movements for select to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));
create policy "Visitors can view available packaging"
on public.packaging_options for select to anon, authenticated using (is_available);
create policy "Managers can view all packaging"
on public.packaging_options for select to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));
create policy "Admins can manage packaging"
on public.packaging_options for all to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])))
with check ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));
create policy "Visitors can view available delivery zones"
on public.delivery_zones for select to anon, authenticated using (is_available);
create policy "Managers can view all delivery zones"
on public.delivery_zones for select to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));
create policy "Managers can manage delivery zones"
on public.delivery_zones for all to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])))
with check ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));

create policy "Visitors can view active promotion banners"
on public.promotions for select to anon, authenticated
using (is_active and banner_text <> '' and (starts_at is null or starts_at <= now()) and (ends_at is null or ends_at > now()));
create policy "Admins can manage promotions"
on public.promotions for all to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])))
with check ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));

create policy "Admins can view store settings"
on public.store_settings for select to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));
create policy "Owners can manage store settings"
on public.store_settings for all to authenticated
using ((select private.has_admin_role(array['owner']::public.admin_role[])))
with check ((select private.has_admin_role(array['owner']::public.admin_role[])));

create policy "Visitors can view visible homepage sections"
on public.homepage_sections for select to anon, authenticated using (is_visible);
create policy "Managers can manage homepage sections"
on public.homepage_sections for all to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])))
with check ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));

create policy "Visitors can view enabled games"
on public.game_settings for select to anon, authenticated using (is_enabled);
create policy "Managers can manage game settings"
on public.game_settings for all to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])))
with check ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));

create policy "Visitors can view approved testimonials"
on public.testimonials for select to anon, authenticated using (is_approved and is_published);
create policy "Managers can manage testimonials"
on public.testimonials for all to authenticated
using ((select private.has_admin_role(array['owner','manager']::public.admin_role[])))
with check ((select private.has_admin_role(array['owner','manager']::public.admin_role[])));

create policy "Order staff can view orders"
on public.orders for select to authenticated
using (
  (select private.has_admin_role(array['owner','manager']::public.admin_role[]))
  or (
    (select private.has_admin_role(array['order_staff']::public.admin_role[]))
    and assigned_to = (select auth.uid())
  )
);
create policy "Order staff can update order workflow"
on public.orders for update to authenticated
using (
  (select private.has_admin_role(array['owner','manager']::public.admin_role[]))
  or (
    (select private.has_admin_role(array['order_staff']::public.admin_role[]))
    and assigned_to = (select auth.uid())
  )
)
with check (
  (select private.has_admin_role(array['owner','manager']::public.admin_role[]))
  or (
    (select private.has_admin_role(array['order_staff']::public.admin_role[]))
    and assigned_to = (select auth.uid())
  )
);
create policy "Admins can view order items"
on public.order_items for select to authenticated
using (exists (select 1 from public.orders o where o.id = order_id));
create policy "Admins can view order history"
on public.order_history for select to authenticated
using (exists (select 1 from public.orders o where o.id = order_id));
create policy "Owners can view audit log"
on public.audit_logs for select to authenticated
using ((select private.has_admin_role(array['owner']::public.admin_role[])));

create function public.get_public_store_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'store_name', settings -> 'store_name',
    'currency', settings -> 'currency',
    'instagram_handle', settings -> 'instagram_handle',
    'instagram_url', settings -> 'instagram_url',
    'instagram_posts', settings -> 'instagram_posts',
    'instagram_followers', settings -> 'instagram_followers',
    'instagram_snapshot_date', settings -> 'instagram_snapshot_date',
    'whatsapp_number', settings -> 'whatsapp_number',
    'hero_title', settings -> 'hero_title',
    'hero_description', settings -> 'hero_description',
    'announcement', settings -> 'announcement',
    'delivery_information', settings -> 'delivery_information',
    'logo_path', settings -> 'logo_path',
    'promotions', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.name, 'banner_text', p.banner_text) order by p.starts_at desc nulls last)
      from public.promotions p
      where p.is_active and p.banner_text <> ''
        and (p.starts_at is null or p.starts_at <= now())
        and (p.ends_at is null or p.ends_at > now())
    ), '[]'::jsonb),
    'brand_primary', settings -> 'brand_primary',
    'brand_sage', settings -> 'brand_sage',
    'brand_cream', settings -> 'brand_cream',
    'brand_butter', settings -> 'brand_butter',
    'brand_blush', settings -> 'brand_blush',
    'store_open', settings -> 'store_open'
  ) from public.store_settings where id
$$;
grant execute on function public.get_public_store_settings() to anon, authenticated;

create function public.get_admin_dashboard(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not (select private.has_admin_role(array['owner','manager']::public.admin_role[])) then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'The start date must be on or before the end date.' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'total_orders', (select count(*) from public.orders o where (p_from is null or o.created_at >= p_from::timestamptz) and (p_to is null or o.created_at < (p_to + 1)::timestamptz)),
    'total_order_value_lkr', coalesce((select sum(o.total_lkr) from public.orders o where o.status <> 'cancelled' and (p_from is null or o.created_at >= p_from::timestamptz) and (p_to is null or o.created_at < (p_to + 1)::timestamptz)), 0),
    'status_counts', coalesce((select jsonb_object_agg(s.status, s.amount) from (
      select o.status::text as status, count(*) as amount
      from public.orders o
      where (p_from is null or o.created_at >= p_from::timestamptz)
        and (p_to is null or o.created_at < (p_to + 1)::timestamptz)
      group by o.status
    ) s), '{}'::jsonb),
    'low_stock', (select count(*) from public.products p where p.is_published and p.archived_at is null and p.stock_quantity <= p.low_stock_threshold),
    'best_sellers', coalesce((select jsonb_agg(to_jsonb(best)) from (
      select oi.product_name_snapshot as name, sum(oi.quantity) as units_sold
      from public.order_items oi join public.orders o on o.id = oi.order_id
      where o.status <> 'cancelled'
        and (p_from is null or o.created_at >= p_from::timestamptz)
        and (p_to is null or o.created_at < (p_to + 1)::timestamptz)
      group by oi.product_name_snapshot order by units_sold desc limit 5
    ) best), '[]'::jsonb),
    'recent_orders', coalesce((select jsonb_agg(to_jsonb(recent)) from (
      select o.id, o.order_number, o.customer_name, o.status, o.total_lkr, o.created_at
      from public.orders o
      where (p_from is null or o.created_at >= p_from::timestamptz)
        and (p_to is null or o.created_at < (p_to + 1)::timestamptz)
      order by o.created_at desc limit 5
    ) recent), '[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.get_admin_dashboard(date, date) from public, anon;
grant execute on function public.get_admin_dashboard(date, date) to authenticated;

create function public.consume_order_rate_limit(p_ip_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts integer;
begin
  if auth.role() <> 'service_role' or p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Service access is required.' using errcode = '42501';
  end if;
  insert into private.order_rate_limits as current_limit (ip_hash, window_started_at, attempts)
  values (p_ip_hash, now(), 1)
  on conflict (ip_hash) do update
  set window_started_at = case
        when current_limit.window_started_at <= now() - interval '15 minutes' then now()
        else current_limit.window_started_at
      end,
      attempts = case
        when current_limit.window_started_at <= now() - interval '15 minutes' then 1
        else current_limit.attempts + 1
      end,
      updated_at = now()
  returning attempts into v_attempts;
  delete from private.order_rate_limits where updated_at < now() - interval '1 day';
  return v_attempts <= 5;
end;
$$;
revoke all on function public.consume_order_rate_limit(text) from public, anon, authenticated;
grant execute on function public.consume_order_rate_limit(text) to service_role;

create function public.assign_order_to_staff(p_order_id uuid, p_staff_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.has_admin_role(array['owner','manager']::public.admin_role[])) then
    raise exception 'Owner or manager access is required to assign orders.' using errcode = '42501';
  end if;
  if p_staff_user_id is not null and not exists (
    select 1 from public.admin_profiles p
    where p.user_id = p_staff_user_id and p.role = 'order_staff'
  ) then
    raise exception 'Choose an active order-staff account.' using errcode = '22023';
  end if;
  update public.orders set assigned_to = p_staff_user_id where id = p_order_id;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  insert into public.audit_logs (actor_id, action, entity_type, entity_id, details)
  values ((select auth.uid()), 'order.assigned', 'order', p_order_id, jsonb_build_object('assigned_to', p_staff_user_id));
end;
$$;
revoke all on function public.assign_order_to_staff(uuid, uuid) from public, anon;
grant execute on function public.assign_order_to_staff(uuid, uuid) to authenticated;

create function public.get_order_staff()
returns table (user_id uuid, display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select private.has_admin_role(array['owner','manager']::public.admin_role[])) then
    raise exception 'Owner or manager access is required to view order staff.' using errcode = '42501';
  end if;
  return query
    select p.user_id, p.display_name
    from public.admin_profiles p
    where p.role = 'order_staff'
    order by p.display_name, p.created_at;
end;
$$;
revoke all on function public.get_order_staff() from public, anon;
grant execute on function public.get_order_staff() to authenticated;

create function public.create_guest_order(
  p_customer_name text,
  p_contact_number text,
  p_delivery_address text,
  p_gift_message text,
  p_items jsonb,
  p_packaging_id uuid default null,
  p_delivery_zone_id uuid default null
)
returns table (
  order_id uuid,
  order_number text,
  subtotal_lkr integer,
  packaging_charge_lkr integer,
  delivery_charge_lkr integer,
  delivery_zone_name text,
  total_lkr integer,
  items jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_order_number text;
  v_subtotal bigint := 0;
  v_packaging_charge integer := 0;
  v_packaging_name text := '';
  v_delivery_charge integer := 0;
  v_delivery_zone_name text := '';
  v_packaging_min_items integer;
  v_packaging_max_items integer;
  v_item_count integer := 0;
  v_seen_product_ids uuid[] := '{}';
  v_item jsonb;
  v_product public.products%rowtype;
  v_quantity integer;
begin
  if exists (
    select 1 from public.store_settings
    where id and settings ->> 'store_open' = 'false'
  ) then
    raise exception 'The store is temporarily not taking order enquiries.' using errcode = '22023';
  end if;

  if p_items is null
    or char_length(trim(coalesce(p_customer_name, ''))) not between 1 and 120
    or char_length(trim(coalesce(p_contact_number, ''))) not between 6 and 32
    or char_length(trim(coalesce(p_delivery_address, ''))) not between 1 and 1000
    or char_length(coalesce(p_gift_message, '')) > 400 then
    raise exception 'Please provide valid order and contact details.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Order items must be a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) not between 1 and 30 then
    raise exception 'Choose between 1 and 30 products.' using errcode = '22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or coalesce(v_item ->> 'product_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,3}$' then
      raise exception 'An order item is invalid.' using errcode = '22023';
    end if;
    v_quantity := (v_item ->> 'quantity')::integer;
    if v_quantity not between 1 and 100 then
      raise exception 'An item quantity is outside the allowed range.' using errcode = '22023';
    end if;
    if (v_item ->> 'product_id')::uuid = any (v_seen_product_ids) then
      raise exception 'Each product may only appear once in the selection.' using errcode = '22023';
    end if;
    v_seen_product_ids := array_append(v_seen_product_ids, (v_item ->> 'product_id')::uuid);
    v_item_count := v_item_count + v_quantity;

    select * into v_product
    from public.products p
    where p.id = (v_item ->> 'product_id')::uuid
      and p.is_published and p.is_available and p.archived_at is null
      and p.gift_box_eligible
      and p.stock_quantity >= v_quantity
    for share;

    if not found then
      raise exception 'A selected product is unavailable or has insufficient stock.' using errcode = '22023';
    end if;

    v_subtotal := v_subtotal + (
      case
        when v_product.sale_price_lkr is not null
          and (v_product.sale_starts_at is null or v_product.sale_starts_at <= now())
          and (v_product.sale_ends_at is null or v_product.sale_ends_at > now())
        then v_product.sale_price_lkr
        else v_product.price_lkr
      end
    )::bigint * v_quantity;
  end loop;

  if p_packaging_id is not null then
    select o.price_lkr, o.name, o.min_items, o.max_items
    into v_packaging_charge, v_packaging_name, v_packaging_min_items, v_packaging_max_items
    from public.packaging_options o
    where o.id = p_packaging_id and o.is_available;
    if not found then
      raise exception 'The selected packaging option is unavailable.' using errcode = '22023';
    end if;
    if v_item_count < v_packaging_min_items
      or (v_packaging_max_items is not null and v_item_count > v_packaging_max_items) then
      raise exception 'The selected packaging option does not fit this gift selection.' using errcode = '22023';
    end if;
  end if;

  if p_delivery_zone_id is not null then
    select z.fee_lkr, z.name into v_delivery_charge, v_delivery_zone_name
    from public.delivery_zones z
    where z.id = p_delivery_zone_id and z.is_available;
    if not found then
      raise exception 'The selected delivery option is unavailable.' using errcode = '22023';
    end if;
  elsif exists (select 1 from public.delivery_zones z where z.is_available) then
    raise exception 'Choose an available delivery option.' using errcode = '22023';
  end if;

  if v_subtotal + v_packaging_charge + v_delivery_charge > 2147483647 then
    raise exception 'The order total is too large to process.' using errcode = '22003';
  end if;

  insert into public.orders (
    customer_name, contact_number, delivery_address, gift_message,
    packaging_id, packaging_name_snapshot, delivery_zone_id, delivery_zone_name_snapshot,
    subtotal_lkr, packaging_charge_lkr, delivery_charge_lkr, total_lkr, status, payment_status
  )
  values (
    trim(p_customer_name), trim(p_contact_number), trim(p_delivery_address),
    coalesce(p_gift_message, ''), p_packaging_id, v_packaging_name,
    p_delivery_zone_id, v_delivery_zone_name,
    v_subtotal, v_packaging_charge, v_delivery_charge,
    v_subtotal + v_packaging_charge + v_delivery_charge,
    'new', 'pending'
  )
  returning id, orders.order_number into v_order_id, v_order_number;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_quantity := (v_item ->> 'quantity')::integer;
    select * into v_product from public.products where id = (v_item ->> 'product_id')::uuid;
    insert into public.order_items (
      order_id, product_id, product_name_snapshot, quantity, unit_price_lkr, line_total_lkr
    )
    values (
      v_order_id, v_product.id, v_product.name, v_quantity,
      case
        when v_product.sale_price_lkr is not null
          and (v_product.sale_starts_at is null or v_product.sale_starts_at <= now())
          and (v_product.sale_ends_at is null or v_product.sale_ends_at > now())
        then v_product.sale_price_lkr else v_product.price_lkr
      end,
      (case
        when v_product.sale_price_lkr is not null
          and (v_product.sale_starts_at is null or v_product.sale_starts_at <= now())
          and (v_product.sale_ends_at is null or v_product.sale_ends_at > now())
        then v_product.sale_price_lkr else v_product.price_lkr
      end)::bigint * v_quantity
    );
  end loop;

  return query select
    v_order_id,
    v_order_number,
    v_subtotal::integer,
    v_packaging_charge,
    v_delivery_charge,
    v_delivery_zone_name,
    (v_subtotal + v_packaging_charge + v_delivery_charge)::integer,
    (select jsonb_agg(jsonb_build_object(
      'product_name', oi.product_name_snapshot,
      'variant_name', oi.variant_name_snapshot,
      'quantity', oi.quantity,
      'unit_price_lkr', oi.unit_price_lkr,
      'line_total_lkr', oi.line_total_lkr
    ) order by oi.product_name_snapshot) from public.order_items oi where oi.order_id = v_order_id);
end;
$$;

revoke all on function public.create_guest_order(text, text, text, text, jsonb, uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_guest_order(text, text, text, text, jsonb, uuid, uuid) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('store-images', 'store-images', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Public can view store images"
on storage.objects for select to anon, authenticated using (bucket_id = 'store-images');
create policy "Managers can upload store images"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'store-images'
  and (select private.has_admin_role(array['owner','manager']::public.admin_role[]))
);
create policy "Managers can update store images"
on storage.objects for update to authenticated
using (
  bucket_id = 'store-images'
  and (select private.has_admin_role(array['owner','manager']::public.admin_role[]))
)
with check (
  bucket_id = 'store-images'
  and (select private.has_admin_role(array['owner','manager']::public.admin_role[]))
);
create policy "Managers can delete store images"
on storage.objects for delete to authenticated
using (
  bucket_id = 'store-images'
  and (select private.has_admin_role(array['owner','manager']::public.admin_role[]))
);

revoke all on all tables in schema public from anon, authenticated;
grant select on public.categories, public.product_images,
  public.packaging_options, public.delivery_zones, public.homepage_sections,
  public.game_settings, public.testimonials to anon;
grant select (id, product_id, name, price_delta_lkr, is_available, sort_order)
on public.product_variants to anon;
revoke all on public.products from anon;
grant select on public.storefront_products to anon, authenticated;
grant select, insert, update, delete on public.categories, public.products, public.product_images,
  public.product_variants, public.packaging_options, public.delivery_zones, public.promotions,
  public.homepage_sections, public.game_settings, public.testimonials to authenticated;
grant select, insert, update, delete on public.admin_profiles to authenticated;
grant select on public.inventory_movements, public.orders, public.order_items, public.order_history,
  public.store_settings, public.audit_logs to authenticated;
grant update (status, internal_notes) on public.orders to authenticated;
grant update on public.store_settings to authenticated;
grant usage on type public.admin_role, public.order_status, public.payment_status to authenticated;
