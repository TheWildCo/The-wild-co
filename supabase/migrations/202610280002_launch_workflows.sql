alter table public.orders
  add column promotion_id uuid references public.promotions(id) on delete set null,
  add column promotion_code_snapshot text not null default '';

revoke update on public.products, public.product_variants from authenticated;
grant update (
  category_id, name, slug, description, price_lkr, sale_price_lkr, sale_starts_at,
  sale_ends_at, sku, low_stock_threshold, is_available, is_published, is_featured,
  is_new, is_bestseller, gift_box_eligible, tags, archived_at
) on public.products to authenticated;
grant update (name, sku, price_delta_lkr, is_available, sort_order)
on public.product_variants to authenticated;

create unique index promotions_code_case_insensitive_idx
  on public.promotions (upper(code))
  where code is not null;

alter table public.promotions
  add constraint promotions_percentage_limit
  check (discount_type <> 'percentage' or discount_value <= 100) not valid;
alter table public.promotions validate constraint promotions_percentage_limit;

create or replace view public.storefront_products with (security_invoker = false) as
select
  p.id, p.category_id, p.name, p.slug, p.description, p.price_lkr, p.sale_price_lkr,
  p.sale_starts_at, p.sale_ends_at,
  (p.is_available and case
    when exists (select 1 from public.product_variants v where v.product_id = p.id)
    then exists (
      select 1 from public.product_variants v
      where v.product_id = p.id and v.is_available and v.stock_quantity > 0
    )
    else p.stock_quantity > 0
  end) as is_available,
  p.is_featured, p.is_new, p.is_bestseller, p.gift_box_eligible, p.tags, p.created_at
from public.products p
where p.is_published and p.archived_at is null;

drop policy "Visitors can view variants of published products" on public.product_variants;
create policy "Visitors can view available variants of published products"
on public.product_variants for select to anon, authenticated
using (
  is_available and stock_quantity > 0
  and exists (select 1 from public.storefront_products p where p.id = product_id and p.is_available)
);

create or replace function private.record_stock_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delta integer;
begin
  if tg_op = 'INSERT' then
    v_delta := new.stock_quantity;
  else
    v_delta := new.stock_quantity - old.stock_quantity;
  end if;

  if v_delta <> 0 then
    insert into public.inventory_movements (product_id, quantity_delta, quantity_after, reason, actor_id)
    values (
      new.id,
      v_delta,
      new.stock_quantity,
      coalesce(nullif(current_setting('wild.inventory_reason', true), ''), 'Product stock adjusted'),
      (select auth.uid())
    );
  end if;
  return new;
end;
$$;

drop trigger products_stock_history on public.products;
create trigger products_stock_history
after insert or update of stock_quantity on public.products
for each row execute function private.record_stock_change();

create or replace function private.record_variant_stock_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delta integer;
begin
  if tg_op = 'INSERT' then
    v_delta := new.stock_quantity;
  else
    v_delta := new.stock_quantity - old.stock_quantity;
  end if;

  if v_delta <> 0 then
    insert into public.inventory_movements (product_id, variant_id, quantity_delta, quantity_after, reason, actor_id)
    values (
      new.product_id,
      new.id,
      v_delta,
      new.stock_quantity,
      coalesce(nullif(current_setting('wild.inventory_reason', true), ''), 'Product variant stock adjusted'),
      (select auth.uid())
    );
  end if;
  return new;
end;
$$;

create trigger product_variants_stock_history
after insert or update of stock_quantity on public.product_variants
for each row execute function private.record_variant_stock_change();

create function public.adjust_inventory_stock(
  p_product_id uuid,
  p_variant_id uuid,
  p_quantity_delta integer,
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quantity integer;
  v_reason text := trim(coalesce(p_reason, ''));
begin
  if not (select private.has_admin_role(array['owner','manager']::public.admin_role[])) then
    raise exception 'Only store managers can adjust inventory.' using errcode = '42501';
  end if;
  if p_quantity_delta is null or p_quantity_delta = 0
    or char_length(v_reason) not between 1 and 240 then
    raise exception 'Provide a non-zero stock change and a reason of 1–240 characters.' using errcode = '22023';
  end if;

  perform set_config('wild.inventory_reason', v_reason, true);
  if p_variant_id is null then
    update public.products
    set stock_quantity = stock_quantity + p_quantity_delta
    where id = p_product_id
      and stock_quantity + p_quantity_delta between 0 and 2147483647
    returning stock_quantity into v_quantity;
  else
    update public.product_variants
    set stock_quantity = stock_quantity + p_quantity_delta
    where id = p_variant_id
      and product_id = p_product_id
      and stock_quantity + p_quantity_delta between 0 and 2147483647
    returning stock_quantity into v_quantity;
  end if;

  if not found then
    raise exception 'The inventory item was not found or the adjustment would make stock invalid.' using errcode = '22023';
  end if;
  return v_quantity;
end;
$$;
revoke all on function public.adjust_inventory_stock(uuid, uuid, integer, text) from public, anon;
grant execute on function public.adjust_inventory_stock(uuid, uuid, integer, text) to authenticated;

create function public.create_guest_order(
  p_customer_name text,
  p_contact_number text,
  p_delivery_address text,
  p_gift_message text,
  p_items jsonb,
  p_packaging_id uuid,
  p_delivery_zone_id uuid,
  p_coupon_code text
)
returns table (
  order_id uuid,
  order_number text,
  subtotal_lkr integer,
  packaging_charge_lkr integer,
  delivery_charge_lkr integer,
  delivery_zone_name text,
  discount_lkr integer,
  coupon_code text,
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
  v_eligible_subtotal bigint := 0;
  v_packaging_charge integer := 0;
  v_packaging_name text := '';
  v_delivery_charge integer := 0;
  v_delivery_zone_name text := '';
  v_discount integer := 0;
  v_coupon_code text := upper(trim(coalesce(p_coupon_code, '')));
  v_promotion public.promotions%rowtype;
  v_promotion_id uuid;
  v_packaging_min_items integer;
  v_packaging_max_items integer;
  v_item_count integer := 0;
  v_seen_product_ids uuid[] := '{}';
  v_item jsonb;
  v_product public.products%rowtype;
  v_variant public.product_variants%rowtype;
  v_variant_id uuid;
  v_quantity integer;
  v_unit_price integer;
  v_line_total bigint;
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
    or char_length(coalesce(p_gift_message, '')) > 400
    or char_length(v_coupon_code) > 40 then
    raise exception 'Please provide valid order and contact details.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Order items must be a list.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) not between 1 and 30 then
    raise exception 'Choose between 1 and 30 products.' using errcode = '22023';
  end if;

  if v_coupon_code <> '' then
    select * into v_promotion
    from public.promotions p
    where upper(p.code) = v_coupon_code
      and p.is_active
      and (p.starts_at is null or p.starts_at <= now())
      and (p.ends_at is null or p.ends_at > now())
      and (p.usage_limit is null or p.usage_count < p.usage_limit)
    for update;
    if not found then
      raise exception 'That coupon is invalid, inactive, expired, or has reached its use limit.' using errcode = '22023';
    end if;
    v_promotion_id := v_promotion.id;
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object'
      or coalesce(v_item ->> 'product_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(v_item ->> 'quantity', '') !~ '^[0-9]{1,3}$'
      or (v_item ? 'variant_id' and v_item ->> 'variant_id' is not null
        and (v_item ->> 'variant_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
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
      and p.is_published and p.is_available and p.archived_at is null and p.gift_box_eligible
    for share;
    if not found then
      raise exception 'A selected product is unavailable.' using errcode = '22023';
    end if;

    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    if exists (select 1 from public.product_variants v where v.product_id = v_product.id) then
      if v_variant_id is null then
        raise exception 'Choose an available option for each product with variants.' using errcode = '22023';
      end if;
      select * into v_variant
      from public.product_variants v
      where v.id = v_variant_id and v.product_id = v_product.id and v.is_available
        and v.stock_quantity >= v_quantity
      for share;
      if not found then
        raise exception 'A selected product option is unavailable or has insufficient stock.' using errcode = '22023';
      end if;
    elsif v_variant_id is not null or v_product.stock_quantity < v_quantity then
      raise exception 'A selected product is unavailable or has insufficient stock.' using errcode = '22023';
    end if;

    v_unit_price := case
      when v_product.sale_price_lkr is not null
        and (v_product.sale_starts_at is null or v_product.sale_starts_at <= now())
        and (v_product.sale_ends_at is null or v_product.sale_ends_at > now())
      then v_product.sale_price_lkr
      else v_product.price_lkr
    end;
    if v_variant_id is not null then
      v_unit_price := v_unit_price + v_variant.price_delta_lkr;
    end if;
    if v_unit_price < 0 or v_unit_price > 100000000 then
      raise exception 'A selected product option has an invalid price.' using errcode = '22023';
    end if;
    v_line_total := v_unit_price::bigint * v_quantity;
    v_subtotal := v_subtotal + v_line_total;
    if v_promotion_id is null
      or (
        (cardinality(v_promotion.product_ids) = 0 and cardinality(v_promotion.category_ids) = 0)
        or v_product.id = any(v_promotion.product_ids)
        or v_product.category_id = any(v_promotion.category_ids)
      ) then
      v_eligible_subtotal := v_eligible_subtotal + v_line_total;
    end if;
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

  if v_promotion_id is not null then
    if v_subtotal < v_promotion.minimum_order_lkr then
      raise exception 'The coupon minimum order has not been reached.' using errcode = '22023';
    end if;
    if v_eligible_subtotal = 0 then
      raise exception 'The coupon does not apply to the selected products.' using errcode = '22023';
    end if;
    v_discount := least(
      v_eligible_subtotal,
      case when v_promotion.discount_type = 'percentage'
        then (v_eligible_subtotal * v_promotion.discount_value / 100)::integer
        else v_promotion.discount_value
      end
    );
  end if;

  if v_subtotal + v_packaging_charge + v_delivery_charge > 2147483647 then
    raise exception 'The order total is too large to process.' using errcode = '22003';
  end if;

  insert into public.orders (
    customer_name, contact_number, delivery_address, gift_message,
    packaging_id, packaging_name_snapshot, delivery_zone_id, delivery_zone_name_snapshot,
    promotion_id, promotion_code_snapshot, subtotal_lkr, packaging_charge_lkr,
    delivery_charge_lkr, discount_lkr, total_lkr, status, payment_status
  )
  values (
    trim(p_customer_name), trim(p_contact_number), trim(p_delivery_address),
    coalesce(p_gift_message, ''), p_packaging_id, v_packaging_name,
    p_delivery_zone_id, v_delivery_zone_name, v_promotion_id,
    case when v_promotion_id is null then '' else v_coupon_code end,
    v_subtotal, v_packaging_charge, v_delivery_charge, v_discount,
    v_subtotal + v_packaging_charge + v_delivery_charge - v_discount,
    'new', 'pending'
  )
  returning id, orders.order_number into v_order_id, v_order_number;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    select * into v_product from public.products where id = (v_item ->> 'product_id')::uuid;
    if v_variant_id is not null then
      select * into v_variant from public.product_variants where id = v_variant_id;
    end if;
    v_unit_price := case
      when v_product.sale_price_lkr is not null
        and (v_product.sale_starts_at is null or v_product.sale_starts_at <= now())
        and (v_product.sale_ends_at is null or v_product.sale_ends_at > now())
      then v_product.sale_price_lkr
      else v_product.price_lkr
    end + case when v_variant_id is null then 0 else v_variant.price_delta_lkr end;
    v_quantity := (v_item ->> 'quantity')::integer;
    insert into public.order_items (
      order_id, product_id, variant_id, product_name_snapshot, variant_name_snapshot,
      quantity, unit_price_lkr, line_total_lkr
    )
    values (
      v_order_id, v_product.id, v_variant_id, v_product.name,
      case when v_variant_id is null then '' else v_variant.name end,
      v_quantity, v_unit_price, v_unit_price::bigint * v_quantity
    );
  end loop;

  if v_promotion_id is not null then
    update public.promotions
    set usage_count = usage_count + 1
    where id = v_promotion_id;
  end if;

  return query select
    v_order_id,
    v_order_number,
    v_subtotal::integer,
    v_packaging_charge,
    v_delivery_charge,
    v_delivery_zone_name,
    v_discount,
    case when v_promotion_id is null then '' else v_coupon_code end,
    (v_subtotal + v_packaging_charge + v_delivery_charge - v_discount)::integer,
    (select jsonb_agg(jsonb_build_object(
      'product_name', oi.product_name_snapshot,
      'variant_name', oi.variant_name_snapshot,
      'quantity', oi.quantity,
      'unit_price_lkr', oi.unit_price_lkr,
      'line_total_lkr', oi.line_total_lkr
    ) order by oi.product_name_snapshot) from public.order_items oi where oi.order_id = v_order_id);
end;
$$;

revoke all on function public.create_guest_order(text, text, text, text, jsonb, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.create_guest_order(text, text, text, text, jsonb, uuid, uuid, text) to service_role;
