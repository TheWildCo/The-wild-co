# The Wild Co.

A responsive customer storefront and authenticated admin dashboard for The Wild Co. The site keeps the supplied brand logo, warm gifting palette, cheerful characters, and the manually maintained Instagram snapshot (54 posts, 326 followers, @thewildcoshop). Those social figures are not live Instagram statistics.

## Local development

1. Install Node.js 22 or later.
2. Install dependencies with `npm ci`.
3. Copy `.env.example` to `.env.local` and set only the Supabase project URL and public anon/publishable key:

   ```text
   VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
   VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY
   ```

4. Run `npm run dev`. The storefront is `/`; the admin is `/admin.html`.
5. Run `npm run build` to type-check and create the static site in `dist/`.

The `.env*` ignore rule excludes local environment files except `.env.example`. The service-role/secret key must never be placed in any `VITE_*` setting, `.env` file, browser code, or hosting environment exposed to the client. A successful build without a configured backend is not proof of backend functionality.

## Supabase project setup

Use a **separate non-production Supabase project** for initial setup and verification.

### Apply the database migrations

The migrations are ordered and must be applied in order:

1. `supabase/migrations/202610280001_initial_store.sql` creates the store schema, RLS policies, public storefront views, storage bucket, seed categories/game settings, admin RPCs, and the original guest-order procedure.
2. `supabase/migrations/202610280002_launch_workflows.sql` adds server-validated coupons, variant-priced orders, an inventory adjustment RPC and movement audit, and variant availability rules.

To apply both from the repository with Supabase CLI:

```powershell
npx supabase init
npx supabase login
npx supabase link --project-ref YOUR_NONPRODUCTION_PROJECT_REF
npx supabase db push
```

`db push` may request the project database password. Review the migration list it proposes before confirming. The first `supabase init` creates the local CLI configuration; keep project secrets out of that file. If the first migration was already applied manually in the dashboard, do **not** run `db push` against an untracked migration history; execute only migration `202610280002_launch_workflows.sql` in the SQL Editor, then reconcile the migration history before using `db push` later. Back up any database with real data before applying schema changes.

### Configure administrator access

1. In Supabase Authentication, configure email/password sign-in, set the project Site URL and allowed redirect URLs for the admin, and disable public administrator sign-up. Invite/create the owner's auth user using the Supabase dashboard.
2. In the SQL Editor, substitute the owner's exact email and run:

   ```sql
   insert into public.admin_profiles (user_id, role, display_name)
   select id, 'owner', 'Store owner'
   from auth.users
   where lower(email) = lower('owner@example.com')
   on conflict (user_id) do update
   set role = excluded.role, display_name = excluded.display_name;
   ```

   This is a trusted one-time bootstrap. The owner can then assign manager or order-staff roles in Admin → Admin team. Do not expose this SQL to storefront users.
3. Add the project URL and public anon/publishable key as local `.env.local` values or hosting **build** environment variables. Restart Vite or rebuild after changing them.

### Deploy the order Edge Function

The function is `supabase/functions/create-order/index.ts`. It verifies input and allowed origin, rate-limits requests using a hashed client address, and calls the service-role-only database RPC. Supabase supplies `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` inside the Edge Function runtime. Set only the allowed origins yourself:

```powershell
npx supabase functions deploy create-order --project-ref YOUR_NONPRODUCTION_PROJECT_REF
npx supabase secrets set --project-ref YOUR_NONPRODUCTION_PROJECT_REF "ALLOWED_ORIGINS=https://YOUR_TEST_HOST.example"
```

Add every exact browser origin that will send enquiries, including a separate `http://localhost:5173` entry when locally testing. Origins are comma-separated; do not include URL paths. The function uses Supabase's Edge runtime request IP header (`cf-connecting-ip`); verify that header is present in deployed logs before accepting orders. Never paste secrets into chat or commit them. Do not manually set a service-role key unless required, and then set it only as a server-side Edge Function secret in the Supabase dashboard/CLI.

### Prepare store data and test

1. Sign in at `/admin.html`. Add categories, products, variants, stock, photos, packaging, delivery areas, promotions/coupons, homepage content, and game settings.
2. In Store settings, set the business WhatsApp number in international digits-only format, delivery/contact details, and store availability. Verify the supplied logo and brand colours before launch.
3. With the non-production project configured, verify actual admin writes and RLS for owner, manager and order-staff accounts; upload and view a product image; confirm storefront product/variant/settings reads; create a coupon-backed order enquiry; compare server totals and WhatsApp message; test invalid/expired/used-up coupons, unavailable stock/variants, missing delivery area, and a paused store.
4. Verify the deployed function's CORS and rate-limit behavior, HTTPS site URL/redirect settings, and production domain origin before accepting customer enquiries. An order is an **unconfirmed and unpaid enquiry**. Stock is checked but is not reserved or decremented. Coupon usage is counted when an enquiry is saved, not when it is paid or confirmed.

## Free-tier static hosting

Cloudflare Pages Free is a practical static-hosting option:

1. Push the repository to a Git provider and connect it to Cloudflare Pages.
2. Set the build command to `npm ci && npm run build` and the output directory to `dist` (no separate functions directory is required).
3. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as build environment variables in the Cloudflare Pages project. They are public client configuration, not secrets.
4. Deploy and verify both `https://YOUR_DOMAIN/` and `https://YOUR_DOMAIN/admin.html`, including a direct refresh of the admin path.
5. Add the deployed HTTPS origin to `ALLOWED_ORIGINS` and Supabase Auth's allowed redirect URLs. Repeat the build after changing the Supabase project or public keys.

Equivalent static hosts may be used if they serve both HTML entry points and the `dist/assets/` files without rewriting `/admin.html` to a missing path.

## Admin and storefront capabilities

- Supabase Auth login, password recovery, owner/manager/order-staff roles, database RLS, image storage, product/category CRUD, product options and images (alt text, sort order and primary selection).
- Inventory adjustment and review. Stock changes are written by a role-checked RPC and recorded with the resulting balance and reason. Variant and base-product inventory are tracked separately.
- Delivery areas and fees, packaging and item limits, store settings, homepage text, promotional banners, coupon creation/activation/scheduling and server-side coupon validation/usage limits.
- Five enabled/disabled mini-games with editable titles, descriptions and game-specific rule/content JSON. Budget minimum and maximum, memory-pair count, hunt reward, mood recommendations and affirmation messages are configurable.
- Customer product catalogue and gift builder use published availability, selected variant pricing, packaging, delivery and server-saved order totals. WhatsApp opens only after the Edge Function has saved and returned the enquiry.

## Launch status and boundaries

- The SQL migrations, Edge Function, admin workflows, image upload and order journey have **not yet been verified against a real Supabase project** in this workspace. Local production builds and browser checks do not count as live backend testing. Do not regard this project as launch-approved until the non-production backend checklist above passes and deployment-specific CORS/IP behavior is confirmed.
- Saved guest orders do not reserve or deduct stock; staff must confirm availability and final order details. A coupon is consumed by a saved enquiry even if the shop later cancels it; adjust the promotion's usage count using a reviewed, audited owner process if an enquiry should not count.
- Coupon creation supports amount/percentage, minimum amount, active dates, usage caps and coupon codes. Product/category restrictions in the schema are honored by the order procedure but are not yet editable in the admin.
- Product and category image upload workflows use a public image bucket. Do not upload private/customer imagery. Product deletion removes its inventory history; saved order-item snapshots remain.
- Before launch, configure database backups/recovery, access monitoring, privacy/retention, contact, shipping, returns and customer-data policies. Test all role permissions and the Supabase project restore process.

## Brand assets

The actual supplied logo is `assets/the-wild-co-logo.png` and is reused in the storefront and admin. Friendly character illustrations are original playful decorations inspired by the supplied reference; they do not replace real product photographs.
