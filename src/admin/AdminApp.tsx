import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import logoAssetUrl from "../../assets/the-wild-co-logo.png";
import { supabase } from "./supabase";

type Role = "owner" | "manager" | "order_staff";
type Tab = "overview" | "products" | "inventory" | "categories" | "orders" | "gift-studio" | "delivery" | "promotions" | "content" | "games" | "testimonials" | "team" | "settings";
type Product = {
  id: string; category_id: string | null; name: string; slug: string; description: string;
  price_lkr: number; sale_price_lkr: number | null; sku: string | null; stock_quantity: number;
  low_stock_threshold: number; is_available: boolean; is_published: boolean; is_featured: boolean;
  is_new: boolean; is_bestseller: boolean; gift_box_eligible: boolean; tags: string[];
};
type Category = { id: string; name: string; slug: string; description: string; is_visible: boolean; sort_order: number };
type ProductImage = { id: string; product_id: string; storage_path: string; alt_text: string; sort_order: number; is_primary: boolean };
type ProductVariant = { id: string; product_id: string; name: string; sku: string | null; price_delta_lkr: number; stock_quantity: number; is_available: boolean; sort_order: number };
type Order = {
  id: string; order_number: string; customer_name: string; contact_number: string; delivery_address: string;
  subtotal_lkr: number; packaging_charge_lkr: number; delivery_charge_lkr: number; discount_lkr: number;
  total_lkr: number; status: string; payment_status: string; internal_notes: string; assigned_to: string | null; created_at: string;
  delivery_zone_name_snapshot: string; promotion_code_snapshot: string;
};
type Settings = Record<string, string | number | boolean>;
type Game = { id: string; game_key: string; title: string; description: string; settings: Record<string, unknown>; is_enabled: boolean };
type Promo = { id: string; code: string | null; name: string; discount_type: "percentage" | "fixed"; discount_value: number; minimum_order_lkr: number; starts_at: string | null; ends_at: string | null; usage_limit: number | null; usage_count: number; is_active: boolean; banner_text: string };
type Testimonial = { id: string; display_name: string; review_text: string; is_approved: boolean; is_published: boolean; submitted_at: string };

const pageSize = 10;
const orderStatuses = ["new", "awaiting_confirmation", "confirmed", "preparing", "ready_for_dispatch", "dispatched", "delivered", "cancelled"];
const defaultSettings: Settings = {
  store_name: "The Wild Co.", currency: "LKR", instagram_handle: "@thewildcoshop",
  instagram_url: "https://www.instagram.com/thewildcoshop/", instagram_posts: 54,
  instagram_followers: 326, instagram_snapshot_date: "2026-10-28", whatsapp_number: "",
  delivery_information: "Delivery options and fees are confirmed by the shop before an order is final.",
  contact_email: "", contact_phone: "", hero_title: "A little joy, wrapped just for you.",
  hero_description: "Discover thoughtful little gifts, meet your new stationery sidekicks, and make someone's day extra special.",
  announcement: "Little things, thoughtful gifts, lots of joy ✿",
  logo_path: "assets/the-wild-co-logo.png",
  store_open: true, brand_primary: "#A8C3A6", brand_sage: "#537865",
  brand_cream: "#FFFAF0", brand_butter: "#F4DC8C", brand_blush: "#F4B7B2",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
function money(amount: number): string {
  return `LKR ${new Intl.NumberFormat("en-LK").format(amount)}`;
}
function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function imageUrl(path: string | null): string {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  if (!supabase) return path;
  return supabase.storage.from("store-images").getPublicUrl(path).data.publicUrl;
}

export function AdminApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [role, setRole] = useState<Role | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [message, setMessage] = useState("");
  const [globalError, setGlobalError] = useState("");

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return;
    }
    let active = true;
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setGlobalError(error.message);
      setSession(data.session);
      setAuthReady(true);
    }).catch(error => {
      if (!active) return;
      setGlobalError(errorText(error));
      setAuthReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      if (event === "PASSWORD_RECOVERY") setRecoveryMode(true);
      if (event === "SIGNED_OUT") {
        setRole(null);
        setRecoveryMode(false);
      }
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!supabase || !session?.user.id) {
      setRole(null);
      setProfileLoading(false);
      return;
    }
    let active = true;
    setProfileLoading(true);
    supabase.from("admin_profiles").select("role").eq("user_id", session.user.id).maybeSingle()
      .then(({ data, error }) => {
        if (!active) return;
        if (error) setGlobalError(`Couldn't verify your admin role: ${error.message}`);
        setRole(data?.role as Role | null);
        setProfileLoading(false);
      });
    return () => { active = false; };
  }, [session]);

  if (!supabase) {
    return <SetupScreen />;
  }
  if (!authReady || profileLoading) return <LoadingScreen />;
  if (recoveryMode && session) {
    return <PasswordRecovery onDone={() => setRecoveryMode(false)} onError={setGlobalError} />;
  }
  if (!session) {
    return <LoginScreen onMessage={setMessage} message={message} onError={setGlobalError} error={globalError} />;
  }
  if (!role) {
    return <AccessDenied email={session.user.email ?? ""} error={globalError} onSignOut={async () => {
      if (!supabase) return;
      const { error } = await supabase.auth.signOut();
      if (error) setGlobalError(error.message);
    }} />;
  }
  return <Dashboard role={role} email={session.user.email ?? ""} userId={session.user.id} />;
}

function Logo({ small = false }: { small?: boolean }) {
  return <img className={`admin-logo${small ? " small" : ""}`} src={logoAssetUrl} alt="The Wild Co. logo" />;
}

function SetupScreen() {
  return <main className="setup-shell">
    <section className="setup-card"><Logo /><span className="eyebrow">One little setup step</span>
      <h1>Connect your store to its private admin.</h1>
      <p>Add your Supabase project URL and public anon key to a local <code>.env</code> file, then apply the database migration.</p>
      <pre>VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co{"\n"}VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_KEY</pre>
      <p className="muted">Only the public anon key belongs in this frontend. Never place a service-role key here.</p>
      <a className="button-link" href={import.meta.env.BASE_URL}>Back to The Wild Co.</a>
    </section>
  </main>;
}
function LoadingScreen() {
  return <main className="setup-shell"><div className="setup-card"><Logo /><p role="status">Opening your little admin space…</p></div></main>;
}
function LoginScreen({ onMessage, message, onError, error }: { onMessage: (value: string) => void; message: string; onError: (value: string) => void; error: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  async function login(event: FormEvent) {
    event.preventDefault();
    onError(""); onMessage("");
    if (!supabase) return;
    setBusy(true);
    const { error: authError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (authError) onError(authError.message);
  }
  async function resetPassword() {
    onError(""); onMessage("");
    if (!supabase) return;
    if (!email.trim()) { onError("Enter your admin email address first."); return; }
    setBusy(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/admin.html` });
    setBusy(false);
    if (resetError) onError(resetError.message);
    else onMessage("If an account exists for that address, a password reset email is on its way.");
  }
  return <main className="login-shell">
    <section className="login-card">
      <Logo />
      <span className="eyebrow">A little space just for the shop</span>
      <h1>Welcome back.</h1>
      <p className="muted">Sign in with the administrator account created by the store owner.</p>
      <form className="form-stack" onSubmit={login}>
        <label>Email address<input autoComplete="username" type="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label>Password<input autoComplete="current-password" type="password" required maxLength={128} value={password} onChange={event => setPassword(event.target.value)} /></label>
        <button className="button-link" disabled={busy}>{busy ? "One moment…" : "Sign in"}</button>
      </form>
      <button className="quiet-button" type="button" disabled={busy} onClick={resetPassword}>Send a password reset email</button>
      {message && <p className="notice" role="status">{message}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <p className="security-note">Admin accounts are created by the owner. There is no public admin sign-up.</p>
    </section>
  </main>;
}
function PasswordRecovery({ onDone, onError }: { onDone: () => void; onError: (value: string) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    if (password.length < 12) { onError("Choose a password with at least 12 characters."); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) onError(error.message);
    else { onError(""); setMessage("Your password has been updated."); window.setTimeout(onDone, 900); }
  }
  return <main className="login-shell"><section className="login-card"><Logo /><span className="eyebrow">A fresh little start</span><h1>Choose a new password.</h1>
    <form className="form-stack" onSubmit={submit}><label>New password<input type="password" autoComplete="new-password" minLength={12} required value={password} onChange={event => setPassword(event.target.value)} /></label><button className="button-link" disabled={busy}>{busy ? "Saving…" : "Update password"}</button></form>
    {message && <p className="notice" role="status">{message}</p>}
  </section></main>;
}
function AccessDenied({ email, error, onSignOut }: { email: string; error: string; onSignOut: () => void }) {
  return <main className="login-shell"><section className="login-card"><Logo /><span className="eyebrow">A private little space</span><h1>Admin access is not set up for this account.</h1><p className="muted">Signed in as {email}. Ask the store owner to provision your account's admin role in Supabase.</p>{error && <p className="error-message">{error}</p>}<button className="button-link secondary" onClick={onSignOut}>Sign out</button></section></main>;
}

const tabLabels: Record<Tab, string> = {
  overview: "Overview", products: "Products", inventory: "Inventory", categories: "Categories", orders: "Orders",
  "gift-studio": "Gift Studio", delivery: "Delivery", promotions: "Promotions", content: "Homepage",
  games: "Mini-games", testimonials: "Testimonials", team: "Admin team", settings: "Store settings",
};

function Dashboard({ role, email, userId }: { role: Role; email: string; userId: string }) {
  const [tab, setTab] = useState<Tab>(role === "order_staff" ? "orders" : "overview");
  const [toast, setToast] = useState("");
  const manager = role === "owner" || role === "manager";
  const owner = role === "owner";
  const tabs = useMemo(() => ([
    "overview", "products", "inventory", "categories", "orders", "gift-studio", "delivery", "promotions",
    "content", "games", "testimonials", ...(owner ? ["team", "settings"] : []),
  ] as Tab[]).filter(item => manager || item === "orders"), [manager, owner]);
  async function signOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) setToast(error.message);
  }
  function notify(value: string) {
    setToast(value);
    window.setTimeout(() => setToast(""), 4500);
  }
  return <div className="admin-layout">
    <aside className="admin-sidebar">
      <a className="admin-brand" href={import.meta.env.BASE_URL}><Logo small /><span><strong>The Wild Co.</strong><small>little gifts, big feelings</small></span></a>
      <p className="nav-caption">YOUR LITTLE SHOP</p>
      <nav className="admin-nav" aria-label="Admin navigation">
        {tabs.map(item => <button key={item} type="button" className={tab === item ? "active" : ""} onClick={() => setTab(item)}><span aria-hidden="true">{iconFor(item)}</span>{tabLabels[item]}</button>)}
      </nav>
      <div className="sidebar-bottom"><span className="role-pill">{role.replace("_", " ")}</span><span className="signed-in">{email}</span><button className="quiet-button" onClick={signOut}>Sign out ↗</button></div>
    </aside>
    <main className="admin-main">
      <header className="admin-topbar"><div><span className="eyebrow">The Wild Co. · Admin</span><h1>{tabLabels[tab]}</h1></div><a className="preview-link" href={import.meta.env.BASE_URL} target="_blank" rel="noreferrer">View the shop ↗</a></header>
      {toast && <p className="toast" role="status">{toast}</p>}
      <div className="admin-content">
        {tab === "overview" && <Overview onOpenOrders={() => setTab("orders")} />}
        {tab === "products" && manager && <ProductsPage notify={notify} />}
        {tab === "inventory" && manager && <InventoryPage notify={notify} />}
        {tab === "categories" && manager && <CategoriesPage notify={notify} />}
        {tab === "orders" && <OrdersPage role={role} notify={notify} />}
        {tab === "gift-studio" && manager && <PackagingPage notify={notify} />}
        {tab === "delivery" && manager && <DeliveryPage notify={notify} />}
        {tab === "promotions" && manager && <PromotionsPage notify={notify} />}
        {tab === "content" && manager && <ContentPage notify={notify} />}
        {tab === "games" && manager && <GamesPage notify={notify} />}
        {tab === "testimonials" && manager && <TestimonialsPage notify={notify} />}
        {tab === "team" && owner && <TeamPage notify={notify} userId={userId} />}
        {tab === "settings" && owner && <SettingsPage notify={notify} />}
      </div>
    </main>
  </div>;
}
function iconFor(tab: Tab): string {
  return ({ overview: "✿", products: "◇", inventory: "▤", categories: "▦", orders: "♡", "gift-studio": "🎁", delivery: "↗", promotions: "✦", content: "⌂", games: "✧", testimonials: "☻", team: "◎", settings: "⚙" })[tab];
}

function Overview({ onOpenOrders }: { onOpenOrders: () => void }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => { void load(); }, [from, to]);
  async function load() {
    if (!supabase) return;
    setLoading(true); setError("");
    const { data: result, error: resultError } = await supabase.rpc("get_admin_dashboard", {
      p_from: from || null, p_to: to || null,
    });
    if (resultError) setError(resultError.message);
    else setData(result as Record<string, unknown>);
    setLoading(false);
  }
  const counts = (data?.status_counts ?? {}) as Record<string, number>;
  const recent = (data?.recent_orders ?? []) as Array<{ id: string; order_number: string; customer_name: string; status: string; total_lkr: number; created_at: string }>;
  const best = (data?.best_sellers ?? []) as Array<{ name: string; units_sold: number }>;
  const labels: Array<[string, string]> = [["new", "New orders"], ["awaiting_confirmation", "Awaiting confirmation"], ["confirmed", "Confirmed"], ["preparing", "Preparing"], ["dispatched", "Dispatched"], ["delivered", "Completed"], ["cancelled", "Cancelled"]];
  return <section>
    <div className="page-intro"><div><h2>A real little snapshot</h2><p>These numbers come from saved orders and published products. Nothing here is sample sales data.</p></div><div className="date-filter"><label>From<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>To<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label></div></div>
    {error && <ErrorBanner message={error} />}
    {loading ? <LoadingPanel /> : <><div className="metric-grid">
      <Metric title="Total orders" value={String(data?.total_orders ?? 0)} tone="mint" />
      <Metric title="Order value" value={money(Number(data?.total_order_value_lkr ?? 0))} tone="butter" />
      <Metric title="Low-stock items" value={String(data?.low_stock ?? 0)} tone="blush" />
      <Metric title="New to review" value={String(counts.new ?? 0)} tone="lilac" />
    </div>
    <div className="metric-grid status-metrics">{labels.map(([key, title]) => <Metric key={key} title={title} value={String(counts[key] ?? 0)} />)}</div>
    <div className="panel-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">The latest notes</span><h2>Recent orders</h2></div><button className="quiet-button" onClick={onOpenOrders}>All orders →</button></div>
        {recent.length ? <div className="table-wrap"><table><thead><tr><th>Reference</th><th>Customer</th><th>Status</th><th>Estimate</th></tr></thead><tbody>{recent.map(order => <tr key={order.id}><td>{order.order_number}</td><td>{order.customer_name}</td><td><StatusBadge status={order.status} /></td><td>{money(order.total_lkr)}</td></tr>)}</tbody></table></div> : <EmptyState title="No orders yet" text="New customer enquiries that are saved to the database will appear here." />}</section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">From saved orders</span><h2>Best sellers</h2></div></div>
        {best.length ? <ul className="simple-list">{best.map(item => <li key={item.name}><span>{item.name}</span><strong>{item.units_sold} sold</strong></li>)}</ul> : <EmptyState title="Nothing sold yet" text="This list will appear when saved orders have product items." />}</section>
    </div></>}
  </section>;
}
function Metric({ title, value, tone = "" }: { title: string; value: string; tone?: string }) {
  return <article className={`metric-card ${tone}`}><span>{title}</span><strong>{value}</strong></article>;
}

function ProductsPage({ notify }: { notify: (message: string) => void }) {
  const [items, setItems] = useState<Product[]>([]);
  const [images, setImages] = useState<ProductImage[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Product | null>(null);
  const [adding, setAdding] = useState(false);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  async function load() {
    if (!supabase) return;
    setLoading(true); setError("");
    let query = supabase.from("products").select("*", { count: "exact" }).is("archived_at", null).order("created_at", { ascending: false }).range(page * pageSize, page * pageSize + pageSize - 1);
    if (search.trim()) query = query.ilike("name", `%${search.trim()}%`);
    if (category) query = query.eq("category_id", category);
    const [{ data, error: productError, count }, { data: categoryRows, error: categoryError }] = await Promise.all([
      query,
      supabase.from("categories").select("*").order("sort_order").order("name"),
    ]);
    if (productError || categoryError) {
      setError(productError?.message ?? categoryError?.message ?? "Could not load products.");
      setLoading(false); return;
    }
    const productRows = (data ?? []) as Product[];
    setItems(productRows); setCategories((categoryRows ?? []) as Category[]); setTotal(count ?? 0);
    const ids = productRows.map(product => product.id);
    if (ids.length) {
      const { data: imageRows, error: imageError } = await supabase.from("product_images").select("*").in("product_id", ids).order("sort_order");
      if (imageError) setError(imageError.message);
      else setImages((imageRows ?? []) as ProductImage[]);
    } else setImages([]);
    setLoading(false);
  }
  useEffect(() => { void load(); }, [page, search, category]);
  async function deleteProduct(product: Product) {
    if (!supabase || !window.confirm(`Permanently delete “${product.name}”? It will be removed from the catalogue and its inventory history will be deleted. Saved order snapshots will be retained.`)) return;
    setError("");
    const { data: productImages, error: imageLoadError } = await supabase.from("product_images").select("storage_path").eq("product_id", product.id);
    if (imageLoadError) { setError(imageLoadError.message); return; }
    const { error: deleteError } = await supabase.from("products").delete().eq("id", product.id);
    if (deleteError) { setError(deleteError.message); return; }
    const paths = (productImages ?? []).map(image => image.storage_path);
    if (paths.length) {
      const { error: storageError } = await supabase.storage.from("store-images").remove(paths);
      if (storageError) setError(`Product deleted, but image cleanup failed: ${storageError.message}`);
      else notify("Product deleted.");
    } else notify("Product deleted.");
    await load();
  }
  async function togglePublished(product: Product) {
    if (!supabase) return;
    setPublishingId(product.id);
    setError("");
    const { error: updateError } = await supabase.from("products")
      .update({ is_published: !product.is_published })
      .eq("id", product.id);
    setPublishingId(null);
    if (updateError) {
      setError(`Could not ${product.is_published ? "unpublish" : "publish"} “${product.name}”: ${updateError.message}`);
      return;
    }
    notify(product.is_published ? "Product unpublished." : "Product published.");
    await load();
  }
  const imageByProduct = (id: string) => images.find(image => image.product_id === id && image.is_primary) ?? images.find(image => image.product_id === id);
  return <section className="panel">
    <div className="panel-heading"><div><span className="eyebrow">Your catalogue</span><h2>Little things in the shop</h2><p>{total} product{total === 1 ? "" : "s"} · published products show on the customer site</p></div><button className="button-link" onClick={() => { setEditing(null); setAdding(true); }}>＋ Add a product</button></div>
    <div className="toolbar"><input aria-label="Search products by name" placeholder="Search products…" value={search} onChange={event => { setPage(0); setSearch(event.target.value); }} /><select aria-label="Filter products by category" value={category} onChange={event => { setPage(0); setCategory(event.target.value); }}><option value="">All categories</option>{categories.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div>
    {error && <ErrorBanner message={error} />}{loading ? <LoadingPanel /> : items.length ? <div className="product-admin-list">{items.map(product => {
      const image = imageByProduct(product.id);
      return <article className="product-admin-row" key={product.id}>
        {image ? <img src={imageUrl(image.storage_path)} alt={image.alt_text || product.name} /> : <span className="image-placeholder">✿</span>}
        <div className="product-admin-info"><strong>{product.name}</strong><span>{money(product.price_lkr)}{product.sale_price_lkr != null ? ` · sale ${money(product.sale_price_lkr)}` : ""}</span><span>{product.stock_quantity} in stock · {product.is_published ? "Published" : "Draft"}{product.is_featured ? " · Featured" : ""}</span></div>
        <div className="row-actions"><button className="quiet-button" disabled={publishingId === product.id} onClick={() => void togglePublished(product)}>{publishingId === product.id ? "Saving…" : product.is_published ? "Unpublish" : "Publish"}</button><button className="quiet-button" onClick={() => { setEditing(product); setAdding(true); }}>Edit</button><button className="quiet-button danger-text" onClick={() => void deleteProduct(product)}>Delete</button></div>
      </article>;
    })}</div> : <EmptyState title="Your catalogue is ready for its first product" text="Add a product to get started. It will only appear publicly once you publish it." />}
    <Pagination page={page} total={total} onPage={setPage} />
    {adding && <ProductEditor product={editing} categories={categories} images={images.filter(image => image.product_id === editing?.id)} onClose={() => setAdding(false)} onChanged={async text => { notify(text); await load(); }} onSaved={async text => { setAdding(false); notify(text); await load(); }} />}
  </section>;
}

function ProductEditor({ product, categories, images, onClose, onChanged, onSaved }: { product: Product | null; categories: Category[]; images: ProductImage[]; onClose: () => void; onChanged: (text: string) => Promise<void>; onSaved: (text: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [imageDrafts, setImageDrafts] = useState(images.slice().sort((a, b) => a.sort_order - b.sort_order));
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [price, setPrice] = useState(String(product?.price_lkr ?? ""));
  const [salePrice, setSalePrice] = useState(product?.sale_price_lkr == null ? "" : String(product.sale_price_lkr));
  const [sku, setSku] = useState(product?.sku ?? "");
  const [categoryId, setCategoryId] = useState(product?.category_id ?? "");
  const [stock, setStock] = useState(String(product?.stock_quantity ?? 0));
  const [threshold, setThreshold] = useState(String(product?.low_stock_threshold ?? 5));
  const [tags, setTags] = useState((product?.tags ?? []).join(", "));
  const [published, setPublished] = useState(product?.is_published ?? false);
  const [available, setAvailable] = useState(product?.is_available ?? true);
  const [featured, setFeatured] = useState(product?.is_featured ?? false);
  const [isNew, setIsNew] = useState(product?.is_new ?? false);
  const [bestseller, setBestseller] = useState(product?.is_bestseller ?? false);
  const [eligible, setEligible] = useState(product?.gift_box_eligible ?? true);
  const [primaryImage, setPrimaryImage] = useState(images.find(image => image.is_primary)?.id ?? "");
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    const priceValue = Number(price), saleValue = salePrice === "" ? null : Number(salePrice);
    const stockValue = Number(stock), thresholdValue = Number(threshold);
    if (!name.trim() || !Number.isSafeInteger(priceValue) || priceValue < 0 ||
      (saleValue !== null && (!Number.isSafeInteger(saleValue) || saleValue < 0 || saleValue > priceValue)) ||
      !Number.isSafeInteger(stockValue) || stockValue < 0 ||
      !Number.isSafeInteger(thresholdValue) || thresholdValue < 0) {
      setError("Enter a product name, whole-number LKR prices, and non-negative whole-number stock values.");
      return;
    }
    if (files.some(file => !["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024)) {
      setError("Use JPG, PNG or WebP images, up to 5 MB each.");
      return;
    }
    setBusy(true); setError("");
    const payload = {
      name: name.trim(), slug: slugify(name), description: description.trim(), price_lkr: priceValue,
      sale_price_lkr: saleValue, sku: sku.trim() || null, category_id: categoryId || null,
      low_stock_threshold: thresholdValue,
      is_published: published, is_available: available, is_featured: featured, is_new: isNew,
      is_bestseller: bestseller, gift_box_eligible: eligible,
      tags: tags.split(",").map(tag => tag.trim()).filter(Boolean).slice(0, 30),
    };
    const result = product
      ? await supabase.from("products").update(payload).eq("id", product.id).select().single()
      : await supabase.from("products").insert({ ...payload, stock_quantity: stockValue }).select().single();
    if (result.error) { setError(result.error.message); setBusy(false); return; }
    const saved = result.data as Product;
    const existing = imageDrafts.length;
    const uploadedImages: ProductImage[] = [];
    for (const [index, file] of files.entries()) {
      const path = `products/${saved.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
      const { error: uploadError } = await supabase.storage.from("store-images").upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) { setError(`Product saved, but image upload failed: ${uploadError.message}`); setBusy(false); return; }
      const { data: imageRow, error: imageError } = await supabase.from("product_images").insert({
        product_id: saved.id, storage_path: path, alt_text: `${saved.name} product photograph`,
        sort_order: existing + index, is_primary: existing === 0 && index === 0,
      }).select().single();
      if (imageError) { setError(`Image uploaded, but its product record failed: ${imageError.message}`); setBusy(false); return; }
      uploadedImages.push(imageRow as ProductImage);
    }
    const finalImages = [...imageDrafts, ...uploadedImages];
    if (finalImages.length) {
      const selectedPrimary = finalImages.some(image => image.id === primaryImage)
        ? primaryImage
        : finalImages.find(image => image.is_primary)?.id ?? finalImages[0].id;
      const { error: clearError } = await supabase.from("product_images").update({ is_primary: false }).eq("product_id", saved.id);
      if (clearError) { setError(clearError.message); setBusy(false); return; }
      for (const [index, image] of finalImages.entries()) {
        const { error: imageUpdateError } = await supabase.from("product_images").update({
          alt_text: image.alt_text, sort_order: index, is_primary: image.id === selectedPrimary,
        }).eq("id", image.id);
        if (imageUpdateError) { setError(`Product saved, but image details could not be saved: ${imageUpdateError.message}`); setBusy(false); return; }
      }
    }
    setBusy(false);
    await onSaved(product ? "Product updated." : "Product created.");
  }
  async function deleteImage(image: ProductImage) {
    if (!supabase || !window.confirm("Remove this product image?")) return;
    const { error: deleteError } = await supabase.from("product_images").delete().eq("id", image.id);
    if (deleteError) setError(deleteError.message);
    else {
      setImageDrafts(current => current.filter(item => item.id !== image.id));
      if (primaryImage === image.id) setPrimaryImage(imageDrafts.find(item => item.id !== image.id)?.id ?? "");
      const { error: storageError } = await supabase.storage.from("store-images").remove([image.storage_path]);
      if (storageError) setError(`Image record removed, but storage cleanup failed: ${storageError.message}`);
      else setError("Image removed. Save to keep the current product details.");
    }
  }
  function moveImage(imageId: string, direction: -1 | 1) {
    setImageDrafts(current => {
      const index = current.findIndex(image => image.id === imageId);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= current.length) return current;
      const next = current.slice();
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="editor-modal" role="dialog" aria-modal="true" aria-labelledby="product-editor-title">
      <div className="panel-heading"><div><span className="eyebrow">A new little thing</span><h2 id="product-editor-title">{product ? "Edit product" : "Add a product"}</h2></div><button className="icon-button" disabled={busy} onClick={onClose} aria-label="Close">×</button></div>
      {error && <ErrorBanner message={error} />}
      <form className="editor-form" onSubmit={save}>
        <label>Product name<input required maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Category<select value={categoryId} onChange={event => setCategoryId(event.target.value)}><option value="">No category</option>{categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="wide-field">Description<textarea rows={3} maxLength={5000} value={description} onChange={event => setDescription(event.target.value)} /></label>
        <label>Price (LKR)<input type="number" min="0" max="100000000" step="1" required value={price} onChange={event => setPrice(event.target.value)} /></label>
        <label>Sale price (optional)<input type="number" min="0" max={price || undefined} step="1" value={salePrice} onChange={event => setSalePrice(event.target.value)} /></label>
        <label>SKU<input maxLength={80} value={sku} onChange={event => setSku(event.target.value)} /></label>
        {product ? <div className="stock-readonly">Base stock: <strong>{product.stock_quantity}</strong><small>For products without options. Adjust base or variant quantities in Inventory.</small></div> : <label>Starting base stock<input type="number" min="0" step="1" required value={stock} onChange={event => setStock(event.target.value)} /><small>Initial stock is recorded in Inventory; adjust later from that screen.</small></label>}
        <label>Low-stock alert at<input type="number" min="0" step="1" required value={threshold} onChange={event => setThreshold(event.target.value)} /></label>
        <label>Tags, comma separated<input maxLength={500} value={tags} onChange={event => setTags(event.target.value)} /></label>
        <fieldset className="check-grid wide-field"><legend>Where this little thing can go</legend>
          <Check label="Available" checked={available} onChange={setAvailable} /><Check label="Published in shop" checked={published} onChange={setPublished} />
          <Check label="Featured" checked={featured} onChange={setFeatured} /><Check label="New arrival" checked={isNew} onChange={setIsNew} />
          <Check label="Bestseller" checked={bestseller} onChange={setBestseller} /><Check label="Gift box eligible" checked={eligible} onChange={setEligible} />
        </fieldset>
        <label className="wide-field">Add photographs<input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={event => setFiles(Array.from(event.target.files ?? []))} /><small>JPG, PNG or WebP. Up to 5 MB per image; stored in Supabase Storage.</small></label>
        {!!files.length && <p className="notice wide-field">{files.length} image{files.length === 1 ? "" : "s"} selected. They will upload when you save.</p>}
        {product && <ProductVariantsEditor product={product} onChanged={onChanged} />}
        {!!imageDrafts.length && <div className="existing-images wide-field"><strong>Saved images · edit alt text, order and primary image</strong><div>{imageDrafts.map((image, index) => <article key={image.id}><img src={imageUrl(image.storage_path)} alt={image.alt_text || "Product image"} /><label>Alt text<input maxLength={240} value={image.alt_text} onChange={event => setImageDrafts(current => current.map(item => item.id === image.id ? { ...item, alt_text: event.target.value } : item))} /></label><label><input type="radio" name="primary-image" checked={primaryImage === image.id} onChange={() => setPrimaryImage(image.id)} /> Primary</label><div><button type="button" className="quiet-button" disabled={index === 0} onClick={() => moveImage(image.id, -1)} aria-label="Move image up">↑</button><button type="button" className="quiet-button" disabled={index === imageDrafts.length - 1} onClick={() => moveImage(image.id, 1)} aria-label="Move image down">↓</button><button type="button" className="quiet-button danger-text" onClick={() => void deleteImage(image)}>Remove</button></div></article>)}</div></div>}
        <div className="form-actions wide-field"><button className="button-link" disabled={busy}>{busy ? "Saving…" : "Save product"}</button><button type="button" className="button-link secondary" disabled={busy} onClick={onClose}>Cancel</button></div>
      </form>
    </section>
  </div>;
}

function ProductVariantsEditor({ product, onChanged }: { product: Product; onChanged: (text: string) => Promise<void> }) {
  const [items, setItems] = useState<ProductVariant[]>([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [delta, setDelta] = useState("0");
  const [initialStock, setInitialStock] = useState("0");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!supabase) return;
    const { data, error: loadError } = await supabase.from("product_variants").select("*").eq("product_id", product.id).order("sort_order");
    if (loadError) setError(loadError.message);
    else setItems((data ?? []) as ProductVariant[]);
  }
  useEffect(() => { void load(); }, [product.id]);

  async function addVariant() {
    const priceDelta = Number(delta);
    const stock = Number(initialStock);
    if (!supabase || !name.trim() || !Number.isSafeInteger(priceDelta) ||
      product.price_lkr + priceDelta < 0 || product.price_lkr + priceDelta > 100000000 ||
      !Number.isSafeInteger(stock) || stock < 0) {
      setError("Enter an option name, a valid price adjustment, and non-negative whole-number stock.");
      return;
    }
    setBusy(true); setError("");
    const { data, error: insertError } = await supabase.from("product_variants").insert({
      product_id: product.id, name: name.trim(), sku: sku.trim() || null,
      price_delta_lkr: priceDelta, stock_quantity: 0, sort_order: items.length,
    }).select().single();
    if (insertError) { setError(insertError.message); setBusy(false); return; }
    if (stock > 0) {
      const { error: stockError } = await supabase.rpc("adjust_inventory_stock", {
        p_product_id: product.id, p_variant_id: data.id, p_quantity_delta: stock,
        p_reason: "Initial variant stock",
      });
      if (stockError) { setError(`Option created, but initial stock was not added: ${stockError.message}`); setBusy(false); await load(); return; }
    }
    setName(""); setSku(""); setDelta("0"); setInitialStock("0"); setBusy(false);
    await load(); await onChanged("Product option added.");
  }

  async function updateVariant(item: ProductVariant, changes: Pick<ProductVariant, "name" | "sku" | "price_delta_lkr" | "is_available" | "sort_order">) {
    if (!supabase) return;
    const priceDelta = Number(changes.price_delta_lkr);
    if (!changes.name?.trim() || !Number.isSafeInteger(priceDelta) ||
      product.price_lkr + priceDelta < 0 || product.price_lkr + priceDelta > 100000000) {
      setError("Check the option name and price adjustment.");
      return;
    }
    setBusy(true); setError("");
    const { error: updateError } = await supabase.from("product_variants").update({
      name: changes.name.trim(), sku: changes.sku?.trim() || null,
      price_delta_lkr: priceDelta, is_available: changes.is_available,
      sort_order: changes.sort_order,
    }).eq("id", item.id);
    if (updateError) { setError(updateError.message); setBusy(false); return; }
    setBusy(false); await load(); await onChanged("Product option updated.");
  }

  async function removeVariant(item: ProductVariant) {
    if (!supabase || !window.confirm(`Remove option “${item.name}”? Existing order snapshots will be kept.`)) return;
    const { error: removeError } = await supabase.from("product_variants").delete().eq("id", item.id);
    if (removeError) setError(removeError.message);
    else { await load(); await onChanged("Product option removed."); }
  }

  return <section className="variant-editor wide-field">
    <div><strong>Product options</strong><p>Each option can have its own price adjustment, SKU and tracked stock. Adjust option quantities in Inventory. Orders save the selected option and server-calculated price.</p></div>
    {error && <ErrorBanner message={error} />}
    {items.map(item => <VariantEditorRow key={item.id} item={item} basePrice={product.price_lkr} busy={busy} onSave={changes => void updateVariant(item, changes)} onDelete={() => void removeVariant(item)} />)}
    <div className="variant-add-form">
      <label>Option name<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} placeholder="For example, Sage green" /></label>
      <label>SKU<input maxLength={80} value={sku} onChange={event => setSku(event.target.value)} /></label>
      <label>Price adjustment (LKR)<input type="number" step="1" value={delta} onChange={event => setDelta(event.target.value)} /></label>
      <label>Starting stock<input type="number" min="0" step="1" value={initialStock} onChange={event => setInitialStock(event.target.value)} /></label>
      <button type="button" className="button-link" disabled={busy} onClick={() => void addVariant()}>{busy ? "Saving…" : "Add option"}</button>
    </div>
  </section>;
}

function VariantEditorRow({ item, basePrice, busy, onSave, onDelete }: {
  item: ProductVariant; basePrice: number; busy: boolean;
  onSave: (changes: Pick<ProductVariant, "name" | "sku" | "price_delta_lkr" | "is_available" | "sort_order">) => void; onDelete: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [sku, setSku] = useState(item.sku ?? "");
  const [delta, setDelta] = useState(String(item.price_delta_lkr));
  const [available, setAvailable] = useState(item.is_available);
  return <div className="variant-row">
    <label>Option<input maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label>
    <label>SKU<input maxLength={80} value={sku} onChange={event => setSku(event.target.value)} /></label>
    <label>Price adjustment<input type="number" step="1" value={delta} onChange={event => setDelta(event.target.value)} /><small>Current price: {money(basePrice + Number(delta || 0))}</small></label>
    <span className="variant-stock">Stock: <strong>{item.stock_quantity}</strong></span>
    <Check label="Available" checked={available} onChange={setAvailable} />
    <div className="row-actions"><button type="button" className="quiet-button" disabled={busy} onClick={() => onSave({
      name, sku, price_delta_lkr: Number(delta),
      is_available: available, sort_order: item.sort_order,
    })}>Save option</button><button type="button" className="quiet-button danger-text" onClick={onDelete}>Remove</button></div>
  </div>;
}

function InventoryPage({ notify }: { notify: (message: string) => void }) {
  const [products, setProducts] = useState<Array<{ id: string; name: string; stock_quantity: number }>>([]);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [movements, setMovements] = useState<Array<{ id: string; product_id: string; variant_id: string | null; quantity_delta: number; quantity_after: number; reason: string; created_at: string }>>([]);
  const [productId, setProductId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!supabase) return;
    const [{ data: productRows, error: productError }, { data: variantRows, error: variantError }, { data: movementRows, error: movementError }] = await Promise.all([
      supabase.from("products").select("id,name,stock_quantity").is("archived_at", null).order("name"),
      supabase.from("product_variants").select("*").order("product_id").order("sort_order"),
      supabase.from("inventory_movements").select("id,product_id,variant_id,quantity_delta,quantity_after,reason,created_at").order("created_at", { ascending: false }).limit(100),
    ]);
    const failure = productError || variantError || movementError;
    if (failure) { setError(failure.message); return; }
    const productList = productRows ?? [];
    setProducts(productList);
    setVariants((variantRows ?? []) as ProductVariant[]);
    setMovements((movementRows ?? []) as typeof movements);
    if (!productList.some(product => product.id === productId)) setProductId(productList[0]?.id ?? "");
  }
  useEffect(() => { void load(); }, []);

  async function adjust(event: FormEvent) {
    event.preventDefault();
    const quantityDelta = Number(delta);
    if (!supabase || !productId || !Number.isSafeInteger(quantityDelta) || quantityDelta === 0 || !reason.trim()) {
      setError("Choose an item and enter a non-zero whole-number stock change with a reason.");
      return;
    }
    setBusy(true); setError("");
    const { error: adjustError } = await supabase.rpc("adjust_inventory_stock", {
      p_product_id: productId, p_variant_id: variantId || null,
      p_quantity_delta: quantityDelta, p_reason: reason.trim(),
    });
    if (adjustError) setError(adjustError.message);
    else {
      setDelta(""); setReason(""); notify("Inventory adjusted and movement recorded.");
      await load();
    }
    setBusy(false);
  }
  const variantsForProduct = variants.filter(variant => variant.product_id === productId);
  const productNames = new Map(products.map(product => [product.id, product.name]));
  const variantNames = new Map(variants.map(variant => [variant.id, variant.name]));

  return <div className="panel-grid">
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">Every adjustment, accounted for</span><h2>Inventory movements</h2><p>Recent stock changes show who adjusted the quantity, why, and the resulting balance. Up to 100 latest movements are shown.</p></div></div>
      {error && <ErrorBanner message={error} />}
      {movements.length ? <div className="table-wrap"><table><thead><tr><th>Date</th><th>Product / option</th><th>Change</th><th>Balance</th><th>Reason</th></tr></thead><tbody>{movements.map(movement => <tr key={movement.id}>
        <td>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(movement.created_at))}</td>
        <td>{productNames.get(movement.product_id) ?? "Deleted product"}{movement.variant_id && variantNames.has(movement.variant_id) ? ` · ${variantNames.get(movement.variant_id)}` : ""}</td>
        <td>{movement.quantity_delta > 0 ? "+" : ""}{movement.quantity_delta}</td><td>{movement.quantity_after}</td><td>{movement.reason}</td>
      </tr>)}</tbody></table></div> : <EmptyState title="No stock movements yet" text="New stock changes will be recorded here." />}
    </section>
    <section className="panel"><span className="eyebrow">A careful little correction</span><h2>Adjust stock</h2><p className="notice">Positive numbers add stock; negative numbers remove it. Saved order enquiries do not reserve or deduct stock.</p>
      <form className="form-stack" onSubmit={adjust}>
        <label>Product<select required value={productId} onChange={event => { setProductId(event.target.value); setVariantId(""); }}><option value="">Choose a product</option>{products.map(product => <option key={product.id} value={product.id}>{product.name} · base stock {product.stock_quantity}</option>)}</select></label>
        <label>Stock item<select value={variantId} onChange={event => setVariantId(event.target.value)}><option value="">Base product stock</option>{variantsForProduct.map(variant => <option key={variant.id} value={variant.id}>{variant.name} · {variant.stock_quantity} in stock</option>)}</select></label>
        <label>Quantity change<input required type="number" step="1" value={delta} onChange={event => setDelta(event.target.value)} placeholder="e.g. 5 or -2" /></label>
        <label>Reason<input required maxLength={240} value={reason} onChange={event => setReason(event.target.value)} placeholder="Stock count, delivery received…" /></label>
        <button className="button-link" disabled={busy || !products.length}>{busy ? "Saving…" : "Record stock change"}</button>
      </form>
    </section>
  </div>;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="check-label"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />{label}</label>;
}

function CategoriesPage({ notify }: { notify: (message: string) => void }) {
  const [items, setItems] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    if (!supabase) return;
    const { data, error: loadError } = await supabase.from("categories").select("*").order("sort_order").order("name");
    if (loadError) setError(loadError.message);
    else setItems((data ?? []) as Category[]);
  }
  useEffect(() => { void load(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!supabase || !name.trim()) return;
    setBusy(true); setError("");
    const row = { name: name.trim(), slug: slugify(name), description: description.trim() };
    const result = editId
      ? await supabase.from("categories").update(row).eq("id", editId)
      : await supabase.from("categories").insert(row);
    setBusy(false);
    if (result.error) setError(result.error.message);
    else { setName(""); setDescription(""); setEditId(null); notify(editId ? "Category updated." : "Category added."); await load(); }
  }
  async function toggle(item: Category) {
    if (!supabase) return;
    const { error: updateError } = await supabase.from("categories").update({ is_visible: !item.is_visible }).eq("id", item.id);
    if (updateError) setError(updateError.message); else await load();
  }
  async function remove(item: Category) {
    if (!supabase || !window.confirm(`Remove “${item.name}”? Products will remain but won't have a category.`)) return;
    const { error: deleteError } = await supabase.from("categories").delete().eq("id", item.id);
    if (deleteError) setError(deleteError.message); else { notify("Category removed."); await load(); }
  }
  return <div className="panel-grid">
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">Shop by happy place</span><h2>Categories</h2></div></div>{error && <ErrorBanner message={error} />}
      {items.length ? <div className="simple-list">{items.map(item => <article className="list-row" key={item.id}><div><strong>{item.name}</strong><span>/{item.slug} · {item.is_visible ? "Visible" : "Hidden"}</span></div><div className="row-actions"><button className="quiet-button" onClick={() => { setEditId(item.id); setName(item.name); setDescription(item.description); }}>Edit</button><button className="quiet-button" onClick={() => void toggle(item)}>{item.is_visible ? "Hide" : "Show"}</button><button className="quiet-button danger-text" onClick={() => void remove(item)}>Remove</button></div></article>)}</div> : <EmptyState title="No categories yet" text="Add your first shop category." />}
    </section>
    <section className="panel"><span className="eyebrow">Keep it tidy</span><h2>{editId ? "Edit this category" : "Add a category"}</h2><form className="form-stack" onSubmit={save}><label>Name<input required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label><label>Description<textarea rows={3} maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} /></label><button className="button-link" disabled={busy}>{busy ? "Saving…" : editId ? "Save category" : "Add category"}</button>{editId && <button className="quiet-button" type="button" onClick={() => { setEditId(null); setName(""); setDescription(""); }}>Cancel edit</button>}</form></section>
  </div>;
}

function OrdersPage({ role, notify }: { role: Role; notify: (message: string) => void }) {
  const [items, setItems] = useState<Order[]>([]);
  const [staffMembers, setStaffMembers] = useState<Array<{ user_id: string; display_name: string }>>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Order | null>(null);
  const [history, setHistory] = useState<Array<{ old_status: string | null; new_status: string; note: string; created_at: string }>>([]);
  const [orderItems, setOrderItems] = useState<Array<{ product_name_snapshot: string; variant_name_snapshot: string; quantity: number; unit_price_lkr: number; line_total_lkr: number }>>([]);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  async function load() {
    if (!supabase) return;
    setLoading(true); setError("");
    let query = supabase.from("orders").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(page * pageSize, page * pageSize + pageSize - 1);
    if (status) query = query.eq("status", status);
    if (search.trim()) query = query.ilike("order_number", `%${search.trim()}%`);
    const { data, error: loadError, count } = await query;
    if (loadError) setError(loadError.message); else { setItems((data ?? []) as Order[]); setTotal(count ?? 0); }
    if (role === "owner" || role === "manager") {
      const { data: staff, error: staffError } = await supabase.rpc("get_order_staff");
      if (staffError) setError(staffError.message);
      else setStaffMembers((staff ?? []) as typeof staffMembers);
    }
    setLoading(false);
  }
  useEffect(() => { void load(); }, [page, status, search, role]);
  async function inspect(order: Order) {
    setSelected(order); setNotes(order.internal_notes);
    if (!supabase) return;
    const [{ data, error: historyError }, { data: lines, error: itemsError }] = await Promise.all([
      supabase.from("order_history").select("old_status,new_status,note,created_at").eq("order_id", order.id).order("created_at", { ascending: false }),
      supabase.from("order_items").select("product_name_snapshot,variant_name_snapshot,quantity,unit_price_lkr,line_total_lkr").eq("order_id", order.id),
    ]);
    if (historyError || itemsError) setError(historyError?.message ?? itemsError?.message ?? "Could not load the order details.");
    else { setHistory((data ?? []) as typeof history); setOrderItems((lines ?? []) as typeof orderItems); }
  }
  async function saveOrder(event: FormEvent) {
    event.preventDefault();
    if (!supabase || !selected) return;
    setError("");
    const { error: updateError } = await supabase.from("orders").update({ status: selected.status, internal_notes: notes }).eq("id", selected.id);
    if (updateError) setError(updateError.message);
    else { notify("Order workflow updated. Status changes are saved in the order history."); setSelected(null); await load(); }
  }
  async function assignOrder(userId: string) {
    if (!supabase || !selected || (role !== "owner" && role !== "manager")) return;
    const { error: assignError } = await supabase.rpc("assign_order_to_staff", {
      p_order_id: selected.id, p_staff_user_id: userId || null,
    });
    if (assignError) setError(assignError.message);
    else { setSelected({ ...selected, assigned_to: userId || null }); notify("Order assignment saved."); await load(); }
  }
  return <section className="panel">
    <div className="panel-heading"><div><span className="eyebrow">Customer enquiries</span><h2>Order book</h2><p>WhatsApp messages are not read by this store. Only database orders appear here.</p></div></div>
    <div className="toolbar"><input aria-label="Search order reference" placeholder="Search order reference…" value={search} onChange={event => { setPage(0); setSearch(event.target.value); }} /><select aria-label="Filter by order status" value={status} onChange={event => { setPage(0); setStatus(event.target.value); }}><option value="">Every status</option>{orderStatuses.map(item => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}</select></div>
    {error && <ErrorBanner message={error} />}
    {loading ? <LoadingPanel /> : items.length ? <div className="table-wrap"><table><thead><tr><th>Order</th><th>Customer</th><th>Contact</th><th>Status</th><th>Estimate</th><th>Date</th><th></th></tr></thead><tbody>{items.map(order => <tr key={order.id}><td><strong>{order.order_number}</strong></td><td>{order.customer_name}</td><td>{order.contact_number}</td><td><StatusBadge status={order.status} /></td><td>{money(order.total_lkr)}</td><td>{new Date(order.created_at).toLocaleDateString()}</td><td><button className="quiet-button" onClick={() => void inspect(order)}>Review</button></td></tr>)}</tbody></table></div> : <EmptyState title="No saved orders yet" text="Orders created through the secure storefront workflow will appear here." />}
    <Pagination page={page} total={total} onPage={setPage} />
    {selected && <div className="modal-backdrop"><section className="editor-modal" role="dialog" aria-modal="true" aria-labelledby="order-modal-title">
      <div className="panel-heading"><div><span className="eyebrow">{selected.order_number}</span><h2 id="order-modal-title">Order details</h2></div><button className="icon-button" onClick={() => setSelected(null)} aria-label="Close">×</button></div>
      <div className="order-detail-grid"><div><strong>{selected.customer_name}</strong><span>{selected.contact_number}</span><span>{selected.delivery_address}</span><span>{selected.delivery_zone_name_snapshot || "Delivery area to be confirmed"}</span></div><div><span>Items: {money(selected.subtotal_lkr)}</span><span>Packaging: {money(selected.packaging_charge_lkr)}</span><span>Delivery: {money(selected.delivery_charge_lkr)}</span>{selected.promotion_code_snapshot && <span>Coupon {selected.promotion_code_snapshot}: −{money(selected.discount_lkr)}</span>}<strong>Estimate: {money(selected.total_lkr)}</strong><span>Payment: {selected.payment_status} · order not necessarily confirmed or paid</span></div></div>
      {orderItems.length > 0 && <div className="order-line-list"><strong>Saved items</strong>{orderItems.map((item, index) => <p key={`${item.product_name_snapshot}-${index}`}>{item.product_name_snapshot}{item.variant_name_snapshot ? ` · ${item.variant_name_snapshot}` : ""} × {item.quantity} · {money(item.line_total_lkr)}</p>)}</div>}
      {error && <ErrorBanner message={error} />}
      {(role === "owner" || role === "manager") && <label className="assignment-field">Assigned order staff<select value={selected.assigned_to ?? ""} onChange={event => void assignOrder(event.target.value)}><option value="">Unassigned</option>{staffMembers.map(member => <option key={member.user_id} value={member.user_id}>{member.display_name || member.user_id.slice(0, 8)}</option>)}</select></label>}
      <form className="form-stack" onSubmit={saveOrder}><label>Workflow status<select value={selected.status} onChange={event => setSelected({ ...selected, status: event.target.value })}>{orderStatuses.map(item => <option value={item} key={item}>{item.replaceAll("_", " ")}</option>)}</select></label><label>Internal notes<textarea rows={3} maxLength={2000} value={notes} onChange={event => setNotes(event.target.value)} /></label><button className="button-link">Save order update</button></form>
      <div className="history-list"><h3>Order history</h3>{history.length ? history.map((entry, index) => <p key={`${entry.created_at}-${index}`}>{entry.old_status ?? "created"} → {entry.new_status} · {new Date(entry.created_at).toLocaleString()}</p>) : <p className="muted">No status changes recorded yet.</p>}</div>
    </section></div>}
  </section>;
}
function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-${status}`}>{status.replaceAll("_", " ")}</span>;
}

type Packaging = { id: string; name: string; description: string; price_lkr: number; is_available: boolean; min_items: number; max_items: number | null; sort_order: number };
function PackagingPage({ notify }: { notify: (message: string) => void }) {
  const [items, setItems] = useState<Packaging[]>([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [price, setPrice] = useState("0");
  const [minItems, setMinItems] = useState("0");
  const [maxItems, setMaxItems] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  async function load() {
    if (!supabase) return;
    const { data, error: loadError } = await supabase.from("packaging_options").select("*").order("sort_order");
    if (loadError) setError(loadError.message); else setItems((data ?? []) as Packaging[]);
  }
  useEffect(() => { void load(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    const minimum = Number(minItems);
    const maximum = maxItems.trim() ? Number(maxItems) : null;
    if (!supabase || !name.trim() || !Number.isSafeInteger(Number(price)) || Number(price) < 0 ||
      !Number.isSafeInteger(minimum) || minimum < 0 ||
      (maximum !== null && (!Number.isSafeInteger(maximum) || maximum < minimum))) {
      setError("Enter a name, whole-number LKR price, and valid item limits.");
      return;
    }
    const payload = {
      name: name.trim(), description: description.trim(), price_lkr: Number(price),
      min_items: minimum, max_items: maximum,
    };
    const result = editId ? await supabase.from("packaging_options").update(payload).eq("id", editId) : await supabase.from("packaging_options").insert(payload);
    if (result.error) setError(result.error.message);
    else { setName(""); setDescription(""); setPrice("0"); setMinItems("0"); setMaxItems(""); setEditId(null); notify("Packaging option saved."); await load(); }
  }
  async function toggle(item: Packaging) {
    if (!supabase) return;
    const { error: updateError } = await supabase.from("packaging_options").update({ is_available: !item.is_available }).eq("id", item.id);
    if (updateError) setError(updateError.message); else await load();
  }
  return <div className="panel-grid"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">Gift Studio</span><h2>Packaging choices</h2></div></div>{error && <ErrorBanner message={error} />}{items.length ? <div className="simple-list">{items.map(item => <article className="list-row" key={item.id}><div><strong>{item.name}</strong><span>{money(item.price_lkr)} · {item.min_items}–{item.max_items ?? "no max"} items · {item.is_available ? "Available" : "Hidden"}</span><small>{item.description}</small></div><div className="row-actions"><button className="quiet-button" onClick={() => { setEditId(item.id); setName(item.name); setDescription(item.description); setPrice(String(item.price_lkr)); setMinItems(String(item.min_items)); setMaxItems(item.max_items === null ? "" : String(item.max_items)); }}>Edit</button><button className="quiet-button" onClick={() => void toggle(item)}>{item.is_available ? "Hide" : "Show"}</button></div></article>)}</div> : <EmptyState title="No packaging options" text="Add options here before offering them to customers." />}</section>
    <section className="panel"><span className="eyebrow">A thoughtful finish</span><h2>{editId ? "Edit packaging" : "Add packaging"}</h2><form className="form-stack" onSubmit={save}><label>Name<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label><label>Description<textarea rows={3} maxLength={1000} value={description} onChange={event => setDescription(event.target.value)} /></label><label>Price (LKR)<input type="number" min="0" step="1" required value={price} onChange={event => setPrice(event.target.value)} /></label><label>Minimum gift items<input type="number" min="0" step="1" required value={minItems} onChange={event => setMinItems(event.target.value)} /></label><label>Maximum gift items (optional)<input type="number" min={minItems} step="1" value={maxItems} onChange={event => setMaxItems(event.target.value)} /></label><button className="button-link">Save packaging</button></form></section></div>;
}

type DeliveryZoneRecord = { id: string; name: string; fee_lkr: number; estimated_delivery: string; is_available: boolean; sort_order: number };
function DeliveryPage({ notify }: { notify: (message: string) => void }) {
  const [zones, setZones] = useState<DeliveryZoneRecord[]>([]);
  const [name, setName] = useState("");
  const [fee, setFee] = useState("0");
  const [estimate, setEstimate] = useState("");
  const [editId, setEditId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    if (!supabase) return;
    const { data, error: loadError } = await supabase.from("delivery_zones").select("*").order("sort_order").order("name");
    if (loadError) setError(loadError.message); else setZones((data ?? []) as DeliveryZoneRecord[]);
  }
  useEffect(() => { void load(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    const price = Number(fee);
    if (!supabase || !name.trim() || !Number.isSafeInteger(price) || price < 0) {
      setError("Enter a delivery area and a whole-number non-negative LKR fee.");
      return;
    }
    setBusy(true); setError("");
    const payload = { name: name.trim(), fee_lkr: price, estimated_delivery: estimate.trim() };
    const result = editId
      ? await supabase.from("delivery_zones").update(payload).eq("id", editId)
      : await supabase.from("delivery_zones").insert(payload);
    setBusy(false);
    if (result.error) setError(result.error.message);
    else {
      setName(""); setFee("0"); setEstimate(""); setEditId(null);
      notify("Delivery option saved."); await load();
    }
  }
  async function toggle(zone: DeliveryZoneRecord) {
    if (!supabase) return;
    const { error: updateError } = await supabase.from("delivery_zones").update({ is_available: !zone.is_available }).eq("id", zone.id);
    if (updateError) setError(updateError.message); else await load();
  }
  return <div className="panel-grid">
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">Delivery options</span><h2>Areas and fees</h2><p>When active areas exist, customers must choose one; its current fee is included in the server-calculated estimate.</p></div></div>{error && <ErrorBanner message={error} />}
      {zones.length ? <div className="simple-list">{zones.map(zone => <article className="list-row" key={zone.id}><div><strong>{zone.name}</strong><span>{money(zone.fee_lkr)} · {zone.is_available ? "Available" : "Hidden"}</span><small>{zone.estimated_delivery || "Delivery timing to be confirmed"}</small></div><div className="row-actions"><button className="quiet-button" onClick={() => { setEditId(zone.id); setName(zone.name); setFee(String(zone.fee_lkr)); setEstimate(zone.estimated_delivery); }}>Edit</button><button className="quiet-button" onClick={() => void toggle(zone)}>{zone.is_available ? "Hide" : "Show"}</button></div></article>)}</div> : <EmptyState title="No delivery areas configured" text="Until you add an area, delivery charges remain for the shop to confirm." />}
    </section>
    <section className="panel"><span className="eyebrow">A clear delivery promise</span><h2>{editId ? "Edit area" : "Add delivery area"}</h2><form className="form-stack" onSubmit={save}><label>Area name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label><label>Delivery fee (LKR)<input type="number" min="0" step="1" required value={fee} onChange={event => setFee(event.target.value)} /></label><label>Estimated delivery<textarea rows={2} maxLength={240} value={estimate} onChange={event => setEstimate(event.target.value)} placeholder="For example, 2–4 business days" /></label><button className="button-link" disabled={busy}>{busy ? "Saving…" : "Save delivery option"}</button></form></section>
  </div>;
}

function PromotionsPage({ notify }: { notify: (message: string) => void }) {
  const [items, setItems] = useState<Promo[]>([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<"percentage" | "fixed">("fixed");
  const [min, setMin] = useState("0");
  const [bannerText, setBannerText] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [usageLimit, setUsageLimit] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  async function load() {
    if (!supabase) return;
    const { data, error: loadError } = await supabase.from("promotions").select("*").order("created_at", { ascending: false });
    if (loadError) setError(loadError.message); else setItems((data ?? []) as Promo[]);
  }
  useEffect(() => { void load(); }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    const parsedLimit = usageLimit.trim() ? Number(usageLimit) : null;
    if (!supabase || !name.trim() || !Number.isSafeInteger(Number(amount)) || Number(amount) <= 0 ||
      !Number.isSafeInteger(Number(min)) || Number(min) < 0 ||
      (kind === "percentage" && Number(amount) > 100) ||
      (parsedLimit !== null && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1)) ||
      (startsAt && endsAt && endsAt < startsAt)) {
      setError("Enter a name, valid discount, optional positive usage limit, and valid date range. Percentage discounts are capped at 100%.");
      return;
    }
    const payload = {
      name: name.trim(), code: code.trim().toUpperCase() || null, discount_type: kind,
      discount_value: Number(amount), minimum_order_lkr: Number(min),
      starts_at: startsAt ? new Date(`${startsAt}T00:00:00.000Z`).toISOString() : null,
      ends_at: endsAt ? new Date(`${endsAt}T23:59:59.999Z`).toISOString() : null,
      usage_limit: parsedLimit, banner_text: bannerText.trim(),
    };
    const result = editing
      ? await supabase.from("promotions").update(payload).eq("id", editing)
      : await supabase.from("promotions").insert({ ...payload, is_active: false });
    const saveError = result.error;
    if (saveError) setError(saveError.message);
    else {
      setName(""); setCode(""); setAmount(""); setMin("0"); setBannerText("");
      setStartsAt(""); setEndsAt(""); setUsageLimit(""); setEditing(null);
      notify(editing ? "Promotion updated." : "Promotion saved as inactive.");
      await load();
    }
  }
  async function toggle(item: Promo) {
    if (!supabase) return;
    const { error: updateError } = await supabase.from("promotions").update({ is_active: !item.is_active }).eq("id", item.id);
    if (updateError) setError(updateError.message); else await load();
  }
  async function removePromotion(item: Promo) {
    if (!supabase || !window.confirm(`Delete promotion “${item.name}”?`)) return;
    const { error: deleteError } = await supabase.from("promotions").delete().eq("id", item.id);
    if (deleteError) setError(deleteError.message);
    else { if (editing === item.id) setEditing(null); notify("Promotion deleted."); await load(); }
  }
  return <div className="panel-grid">
    <section className="panel">
      <div className="panel-heading"><div><span className="eyebrow">Little thank-yous</span><h2>Promotions</h2></div></div>
      {error && <ErrorBanner message={error} />}
      {items.length ? <div className="simple-list">{items.map(item => <article className="list-row" key={item.id}>
        <div><strong>{item.name} {item.code && <code>{item.code}</code>}</strong>
          <span>{item.discount_type === "fixed" ? money(item.discount_value) : `${item.discount_value}%`} off · {item.is_active ? "Active" : "Inactive"} · saved enquiries {item.usage_count}{item.usage_limit ? `/${item.usage_limit}` : ""}</span>
          {item.banner_text && <small>{item.banner_text}</small>}
        </div>
        <div className="row-actions">
          <button className="quiet-button" onClick={() => { setEditing(item.id); setName(item.name); setCode(item.code ?? ""); setAmount(String(item.discount_value)); setKind(item.discount_type); setMin(String(item.minimum_order_lkr)); setBannerText(item.banner_text); setStartsAt(item.starts_at?.slice(0, 10) ?? ""); setEndsAt(item.ends_at?.slice(0, 10) ?? ""); setUsageLimit(item.usage_limit == null ? "" : String(item.usage_limit)); }}>Edit</button>
          <button className="quiet-button" onClick={() => void toggle(item)}>{item.is_active ? "Pause" : "Activate"}</button>
          <button className="quiet-button danger-text" onClick={() => void removePromotion(item)}>Delete</button>
        </div>
      </article>)}</div> : <EmptyState title="No promotions yet" text="Create promotions and optional homepage banners here." />}
    </section>
    <section className="panel">
      <span className="eyebrow">Make a little offer</span><h2>{editing ? "Edit promotion" : "New promotion"}</h2>
      <p className="notice">Active coupons are checked by the order function. A use is counted when an enquiry is saved, not when it is paid or confirmed. Only active, in-date promotions with banner text appear in the homepage banner.</p>
      <form className="form-stack" onSubmit={save}>
        <label>Name<input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label>
        <label>Coupon code (optional)<input maxLength={40} value={code} onChange={event => setCode(event.target.value.toUpperCase())} /></label>
        <label>Discount type<select value={kind} onChange={event => setKind(event.target.value as "percentage" | "fixed")}><option value="fixed">Fixed LKR amount</option><option value="percentage">Percent</option></select></label>
        <label>Discount value<input type="number" min="1" max={kind === "percentage" ? 100 : undefined} step="1" value={amount} onChange={event => setAmount(event.target.value)} /></label>
        <label>Minimum order (LKR)<input type="number" min="0" step="1" value={min} onChange={event => setMin(event.target.value)} /></label>
        <label>Usage limit (optional)<input type="number" min="1" step="1" value={usageLimit} onChange={event => setUsageLimit(event.target.value)} /></label>
        <label>Starts on (optional)<input type="date" value={startsAt} onChange={event => setStartsAt(event.target.value)} /></label>
        <label>Ends on (optional)<input type="date" value={endsAt} onChange={event => setEndsAt(event.target.value)} /></label>
        <label className="wide-field">Homepage banner text (optional)<input maxLength={240} value={bannerText} onChange={event => setBannerText(event.target.value)} /></label>
        <button className="button-link">{editing ? "Update promotion" : "Save promotion"}</button>
        {editing && <button type="button" className="button-link secondary" onClick={() => { setEditing(null); setName(""); setCode(""); setAmount(""); setMin("0"); setBannerText(""); setStartsAt(""); setEndsAt(""); setUsageLimit(""); }}>Cancel edit</button>}
      </form>
    </section>
  </div>;
}

function ContentPage({ notify }: { notify: (message: string) => void }) {
  const [sections, setSections] = useState<Array<{ id: string; section_key: string; title: string; content: Record<string, unknown>; is_visible: boolean; sort_order: number }>>([]);
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [sortOrder, setSortOrder] = useState("0");
  const [editing, setEditing] = useState<string | null>(null);
  async function load() {
    if (!supabase) return;
    const { data, error: loadError } = await supabase.from("homepage_sections").select("*").order("sort_order");
    if (loadError) setError(loadError.message); else setSections((data ?? []) as typeof sections);
  }
  useEffect(() => { void load(); }, []);
  async function saveSection(event: FormEvent) {
    event.preventDefault();
    const order = Number(sortOrder);
    if (!supabase || !key.trim() || !title.trim() || !Number.isSafeInteger(order)) {
      setError("Enter a section key, heading and whole-number display order.");
      return;
    }
    const row = { section_key: slugify(key), title: title.trim(), content: { body: body.trim() }, sort_order: order };
    const result = editing
      ? await supabase.from("homepage_sections").update(row).eq("id", editing)
      : await supabase.from("homepage_sections").insert(row);
    if (result.error) setError(result.error.message);
    else {
      setKey(""); setTitle(""); setBody(""); setSortOrder("0"); setEditing(null);
      notify(editing ? "Homepage section updated." : "Homepage section added.");
      await load();
    }
  }
  async function toggle(item: typeof sections[number]) {
    if (!supabase) return;
    const { error: updateError } = await supabase.from("homepage_sections").update({ is_visible: !item.is_visible }).eq("id", item.id);
    if (updateError) setError(updateError.message); else await load();
  }
  async function remove(item: typeof sections[number]) {
    if (!supabase || !window.confirm(`Delete the homepage section “${item.title}”?`)) return;
    const { error: deleteError } = await supabase.from("homepage_sections").delete().eq("id", item.id);
    if (deleteError) setError(deleteError.message);
    else { if (editing === item.id) { setEditing(null); setKey(""); setTitle(""); setBody(""); } notify("Homepage section deleted."); await load(); }
  }
  return <div className="panel-grid"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">Your shop's story</span><h2>Homepage sections</h2><p>Visible sections publish on the storefront in display-order sequence.</p></div></div>{error && <ErrorBanner message={error} />}{sections.length ? <div className="simple-list">{sections.map(item => <article className="list-row" key={item.id}><div><strong>{item.title}</strong><span>{item.section_key} · order {item.sort_order} · {item.is_visible ? "Visible" : "Hidden"}</span><small>{typeof item.content.body === "string" ? item.content.body : JSON.stringify(item.content)}</small></div><div className="row-actions"><button className="quiet-button" onClick={() => { setEditing(item.id); setKey(item.section_key); setTitle(item.title); setBody(typeof item.content.body === "string" ? item.content.body : ""); setSortOrder(String(item.sort_order)); }}>Edit</button><button className="quiet-button" onClick={() => void toggle(item)}>{item.is_visible ? "Hide" : "Show"}</button><button className="quiet-button danger-text" onClick={() => void remove(item)}>Delete</button></div></article>)}</div> : <EmptyState title="No custom sections" text="Add a short text section to publish it on the customer homepage." />}</section>
    <section className="panel"><span className="eyebrow">A new story</span><h2>{editing ? "Edit homepage section" : "Add a homepage section"}</h2><form className="form-stack" onSubmit={saveSection}><label>Section key<input required maxLength={80} value={key} onChange={event => setKey(event.target.value)} placeholder="our-little-story" /></label><label>Heading<input required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label><label>Section text<textarea rows={5} maxLength={2000} value={body} onChange={event => setBody(event.target.value)} /></label><label>Display order<input type="number" step="1" value={sortOrder} onChange={event => setSortOrder(event.target.value)} /></label><button className="button-link">{editing ? "Update section" : "Add section"}</button>{editing && <button type="button" className="button-link secondary" onClick={() => { setEditing(null); setKey(""); setTitle(""); setBody(""); setSortOrder("0"); }}>Cancel edit</button>}</form></section></div>;
}

function GamesPage({ notify }: { notify: (message: string) => void }) {
  const [items, setItems] = useState<Game[]>([]);
  const [error, setError] = useState("");
  async function load() {
    if (!supabase) return;
    const { data, error: loadError } = await supabase.from("game_settings").select("*").order("game_key");
    if (loadError) setError(loadError.message); else setItems((data ?? []) as Game[]);
  }
  useEffect(() => { void load(); }, []);
  async function update(item: Game, changes: Partial<Game>) {
    if (!supabase) return;
    const { error: updateError } = await supabase.from("game_settings").update(changes).eq("id", item.id);
    if (updateError) setError(updateError.message);
    else { notify("Game settings saved."); await load(); }
  }
  return <section className="panel"><div className="panel-heading"><div><span className="eyebrow">Playful little moments</span><h2>Mini-game settings</h2><p>Titles, descriptions, visibility, hunt rewards, memory pairs, gift recommendations and affirmation messages are read from saved settings.</p></div></div>{error && <ErrorBanner message={error} />}{items.length ? <div className="game-admin-list">{items.map(item => <GameEditor key={item.id} item={item} onSave={changes => update(item, changes)} />)}</div> : <EmptyState title="Games are not configured" text="Apply the store migration to load the five game settings." />}</section>;
}
function GameEditor({ item, onSave }: { item: Game; onSave: (changes: Partial<Game>) => Promise<void> }) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [settings, setSettings] = useState(JSON.stringify(item.settings, null, 2));
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(settings) as Record<string, unknown>; } catch { setError("Game settings must be valid JSON."); return; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { setError("Game settings must be a JSON object."); return; }
    if (!title.trim() || !description.trim()) { setError("Add a title and description before saving."); return; }
    if (item.game_key === "memory_match" &&
      (!Number.isSafeInteger(parsed.pairs) || Number(parsed.pairs) < 2 || Number(parsed.pairs) > 6)) {
      setError("Memory Match pairs must be a whole number from 2 to 6.");
      return;
    }
    if (item.game_key === "little_hunt" &&
      (typeof parsed.reward !== "string" || parsed.reward.trim().length > 180)) {
      setError("Little Hunt reward must be text no longer than 180 characters.");
      return;
    }
    if (item.game_key === "gift_mood" && parsed.recommendations !== undefined &&
      (!parsed.recommendations || typeof parsed.recommendations !== "object" || Array.isArray(parsed.recommendations) ||
        !Object.values(parsed.recommendations).every(value => Array.isArray(value) && value.every(id => typeof id === "string")))) {
      setError("Mood recommendations must map each mood to a list of product IDs.");
      return;
    }
    if (item.game_key === "affirmation" && parsed.messages !== undefined &&
      (!Array.isArray(parsed.messages) || parsed.messages.length > 100 ||
        !parsed.messages.every(message => typeof message === "string" && message.trim().length > 0 && message.length <= 240))) {
      setError("Affirmations must be a list of up to 100 non-empty messages, each 240 characters or fewer.");
      return;
    }
    if (item.game_key === "budget_challenge") {
      const minimum = parsed.min_budget_lkr ?? 1;
      const maximum = parsed.max_budget_lkr ?? 100000000;
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) ||
        Number(minimum) < 1 || Number(maximum) < Number(minimum) || Number(maximum) > 100000000) {
        setError("Budget limits must be whole LKR amounts from 1 to 100,000,000, with the maximum at least the minimum.");
        return;
      }
    }
    setError("");
    await onSave({ title: title.trim(), description: description.trim(), settings: parsed });
  }
  return <article className="game-editor"><form className="editor-form" onSubmit={save}>
    <div className="game-editor-head"><div><strong>{item.game_key.replaceAll("_", " ")}</strong><Check label="Visible on shop" checked={item.is_enabled} onChange={value => void onSave({ is_enabled: value })} /></div><button className="quiet-button">Save</button></div>
    <label>Title<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></label><label>Description<input required maxLength={300} value={description} onChange={event => setDescription(event.target.value)} /></label>
    <label className="wide-field">Rules and content (JSON)<textarea rows={5} value={settings} onChange={event => setSettings(event.target.value)} /><small>{gameSettingsHelp(item.game_key)}</small></label>
    {error && <p className="error-message wide-field">{error}</p>}
  </form></article>;
}

function gameSettingsHelp(key: string) {
  const examples: Record<string, string> = {
    little_hunt: 'Example: {"reward":"You found all five friends!"}',
    memory_match: 'Example: {"pairs":4} (2–6 pairs)',
    gift_mood: 'Example: {"recommendations":{"Cosy and Calm":["PRODUCT_UUID"]}}',
    affirmation: 'Example: {"messages":["You are doing beautifully."]}',
    budget_challenge: 'Example: {"min_budget_lkr":500,"max_budget_lkr":50000}',
  };
  return examples[key] ?? "Enter a JSON object of supported game settings.";
}

function TestimonialsPage({ notify }: { notify: (message: string) => void }) {
  const [items, setItems] = useState<Testimonial[]>([]);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  async function load() {
    if (!supabase) return;
    const { data, error: loadError } = await supabase.from("testimonials").select("*").order("submitted_at", { ascending: false });
    if (loadError) setError(loadError.message); else setItems((data ?? []) as Testimonial[]);
  }
  useEffect(() => { void load(); }, []);
  async function add(event: FormEvent) {
    event.preventDefault();
    if (!supabase || !name.trim() || !text.trim()) return;
    const { error: saveError } = await supabase.from("testimonials").insert({ display_name: name.trim(), review_text: text.trim(), is_approved: false, is_published: false });
    if (saveError) setError(saveError.message); else { setName(""); setText(""); notify("Testimonial saved as private until approved."); await load(); }
  }
  async function update(item: Testimonial, changes: Partial<Testimonial>) {
    if (!supabase) return;
    const { error: updateError } = await supabase.from("testimonials").update(changes).eq("id", item.id);
    if (updateError) setError(updateError.message); else await load();
  }
  async function remove(item: Testimonial) {
    if (!supabase || !window.confirm(`Remove feedback from ${item.display_name}?`)) return;
    const { error: deleteError } = await supabase.from("testimonials").delete().eq("id", item.id);
    if (deleteError) setError(deleteError.message); else { notify("Testimonial removed."); await load(); }
  }
  return <div className="panel-grid"><section className="panel"><span className="eyebrow">Kind words</span><h2>Testimonials</h2>{error && <ErrorBanner message={error} />}{items.length ? <div className="simple-list">{items.map(item => <article className="testimonial-row" key={item.id}><div><strong>{item.display_name}</strong><p>{item.review_text}</p><small>{new Date(item.submitted_at).toLocaleDateString()}</small></div><div className="row-actions"><Check label="Approved" checked={item.is_approved} onChange={value => void update(item, { is_approved: value, is_published: value && item.is_published })} /><Check label="Published" checked={item.is_published} onChange={value => void update(item, { is_published: value, is_approved: value || item.is_approved })} /><button className="quiet-button danger-text" onClick={() => void remove(item)}>Remove</button></div></article>)}</div> : <EmptyState title="No testimonials yet" text="Feedback stays private until an owner or manager approves and publishes it." />}</section>
    <section className="panel"><span className="eyebrow">Add feedback with permission</span><h2>New testimonial</h2><p className="muted">Only publish customer feedback when you have permission to share it.</p><form className="form-stack" onSubmit={add}><label>Display name<input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></label><label>Review<textarea required rows={5} maxLength={2000} value={text} onChange={event => setText(event.target.value)} /></label><button className="button-link">Save privately</button></form></section></div>;
}

function TeamPage({ notify, userId }: { notify: (message: string) => void; userId: string }) {
  const [members, setMembers] = useState<Array<{ user_id: string; display_name: string; role: Role; created_at: string }>>([]);
  const [error, setError] = useState("");
  async function load() {
    if (!supabase) return;
    const { data, error: loadError } = await supabase.from("admin_profiles").select("*").order("created_at");
    if (loadError) setError(loadError.message); else setMembers((data ?? []) as typeof members);
  }
  useEffect(() => { void load(); }, []);
  async function changeRole(member: typeof members[number], role: Role) {
    if (!supabase || (role === "owner" && !window.confirm("Owners can manage all admin roles and store settings. Continue?"))) return;
    const { error: updateError } = await supabase.from("admin_profiles").update({ role }).eq("user_id", member.user_id);
    if (updateError) setError(updateError.message); else { notify("Admin role updated."); await load(); }
  }
  return <section className="panel"><div className="panel-heading"><div><span className="eyebrow">People who help run the shop</span><h2>Admin team</h2><p>Create or invite team accounts in Supabase Auth first. Only the owner can assign roles here.</p></div></div>{error && <ErrorBanner message={error} />}{members.length ? <div className="table-wrap"><table><thead><tr><th>Account ID</th><th>Name</th><th>Role</th><th>Joined</th></tr></thead><tbody>{members.map(member => <tr key={member.user_id}><td><code>{member.user_id.slice(0, 8)}…</code>{member.user_id === userId && " (you)"}</td><td>{member.display_name || "—"}</td><td><select aria-label={`Role for ${member.display_name || member.user_id}`} value={member.role} onChange={event => void changeRole(member, event.target.value as Role)}><option value="owner">Owner</option><option value="manager">Manager</option><option value="order_staff">Order staff</option></select></td><td>{new Date(member.created_at).toLocaleDateString()}</td></tr>)}</tbody></table></div> : <EmptyState title="No admin roles found" text="Provision the first owner using the secure SQL bootstrap instructions in the README." />}</section>;
}

function SettingsPage({ notify }: { notify: (message: string) => void }) {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    if (!supabase) return;
    setLoading(true);
    const { data, error: loadError } = await supabase.from("store_settings").select("settings").eq("id", true).single();
    if (loadError) setError(loadError.message); else setSettings({ ...defaultSettings, ...(data.settings as Settings) });
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);
  function change(key: string, value: string | number | boolean) { setSettings(current => ({ ...current, [key]: value })); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    const number = String(settings.whatsapp_number ?? "");
    const handle = String(settings.instagram_handle ?? "");
    const url = String(settings.instagram_url ?? "");
    const posts = Number(settings.instagram_posts), followers = Number(settings.instagram_followers);
    if (number && !/^[1-9]\d{7,14}$/.test(number)) { setError("WhatsApp number must use international digits-only format, including its country code."); return; }
    if (!/^@[a-zA-Z0-9._]{1,30}$/.test(handle)) { setError("Instagram handle should start with @ and contain a valid profile name."); return; }
    if (!/^https:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9._]+\/?$/.test(url)) { setError("Use a valid HTTPS Instagram profile URL."); return; }
    if (!Number.isSafeInteger(posts) || posts < 0 || !Number.isSafeInteger(followers) || followers < 0) { setError("Instagram figures must be non-negative whole numbers."); return; }
    setBusy(true); setError("");
    const { error: saveError } = await supabase.from("store_settings").update({ settings }).eq("id", true);
    setBusy(false);
    if (saveError) setError(saveError.message); else notify("Store settings saved to the shared database.");
  }
  async function uploadLogo(file: File | undefined) {
    if (!supabase || !file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) { setError("Use a JPG, PNG or WebP logo up to 5 MB."); return; }
    const path = `store/logo-${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    const { error: uploadError } = await supabase.storage.from("store-images").upload(path, file, { contentType: file.type, upsert: false });
    if (uploadError) setError(uploadError.message);
    else { change("logo_path", path); notify("Logo uploaded. Save store settings to publish the new logo path."); }
  }
  if (loading) return <LoadingPanel />;
  return <section className="panel"><div className="panel-heading"><div><span className="eyebrow">A few useful details</span><h2>Store settings</h2><p>These settings are shared in Supabase. Social counts stay manually maintained; they are not live Instagram metrics.</p></div></div>{error && <ErrorBanner message={error} />}
    <form className="settings-form" onSubmit={save}>
      <label>Store name<input maxLength={120} value={String(settings.store_name ?? "")} onChange={event => change("store_name", event.target.value)} /></label>
      <label>WhatsApp number <small>Digits only, with country code</small><input inputMode="numeric" maxLength={15} value={String(settings.whatsapp_number ?? "")} onChange={event => change("whatsapp_number", event.target.value.replace(/\D/g, ""))} placeholder="94…" /></label>
      <label>Contact email<input type="email" maxLength={254} value={String(settings.contact_email ?? "")} onChange={event => change("contact_email", event.target.value)} /></label>
      <label>Contact phone<input type="tel" maxLength={32} value={String(settings.contact_phone ?? "")} onChange={event => change("contact_phone", event.target.value)} /></label>
      <label>Instagram handle<input maxLength={32} value={String(settings.instagram_handle ?? "")} onChange={event => change("instagram_handle", event.target.value)} /></label>
      <label>Instagram profile URL<input type="url" maxLength={240} value={String(settings.instagram_url ?? "")} onChange={event => change("instagram_url", event.target.value)} /></label>
      <label>Instagram posts (snapshot)<input type="number" min="0" step="1" value={Number(settings.instagram_posts ?? 0)} onChange={event => change("instagram_posts", Number(event.target.value))} /></label>
      <label>Instagram followers (snapshot)<input type="number" min="0" step="1" value={Number(settings.instagram_followers ?? 0)} onChange={event => change("instagram_followers", Number(event.target.value))} /></label>
      <label>Snapshot date<input type="date" value={String(settings.instagram_snapshot_date ?? "")} onChange={event => change("instagram_snapshot_date", event.target.value)} /></label>
      <label className="wide-field">Announcement bar<input maxLength={180} value={String(settings.announcement ?? "")} onChange={event => change("announcement", event.target.value)} /></label>
      <label className="wide-field">Delivery information<textarea rows={3} maxLength={600} value={String(settings.delivery_information ?? "")} onChange={event => change("delivery_information", event.target.value)} /></label>
      <label className="wide-field">Homepage hero heading<input maxLength={180} value={String(settings.hero_title ?? "")} onChange={event => change("hero_title", event.target.value)} /></label>
      <label className="wide-field">Homepage hero description<textarea rows={3} maxLength={600} value={String(settings.hero_description ?? "")} onChange={event => change("hero_description", event.target.value)} /></label>
      <label>Store availability<select value={String(settings.store_open)} onChange={event => change("store_open", event.target.value === "true")}><option value="true">Open</option><option value="false">Paused</option></select></label>
      <div className="wide-field logo-upload"><strong>Brand logo</strong><img src={imageUrl(String(settings.logo_path ?? ""))} alt="Current store logo" /><label>Upload a replacement<input type="file" accept="image/jpeg,image/png,image/webp" onChange={event => void uploadLogo(event.target.files?.[0])} /></label></div>
      <fieldset className="brand-colours wide-field"><legend>Brand colour tokens</legend>{[["brand_primary", "Primary sage"], ["brand_sage", "Deep sage"], ["brand_cream", "Warm cream"], ["brand_butter", "Butter yellow"], ["brand_blush", "Blush pink"]].map(([key, label]) => <label key={key}>{label}<input type="color" value={String(settings[key])} onChange={event => change(key, event.target.value)} /></label>)}</fieldset>
      <p className="notice wide-field">Instagram numbers are manually maintained screenshot figures, not live statistics. Storefront changes publish when the customer site is built with the same Supabase project configuration.</p>
      <button className="button-link wide-field" disabled={busy}>{busy ? "Saving…" : "Save store settings"}</button>
    </form>
  </section>;
}

function Pagination({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return <nav className="pagination" aria-label="Pagination"><button disabled={page === 0} onClick={() => onPage(page - 1)}>← Previous</button><span>Page {page + 1} of {pages}</span><button disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next →</button></nav>;
}
function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><span aria-hidden="true">✿</span><strong>{title}</strong><p>{text}</p></div>;
}
function ErrorBanner({ message }: { message: string }) {
  return <p className="error-banner" role="alert">{message}</p>;
}
function LoadingPanel() {
  return <p className="loading-panel" role="status">A moment, please…</p>;
}
