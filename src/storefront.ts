import { createClient, FunctionsHttpError, type SupabaseClient } from "@supabase/supabase-js";

type StorefrontProduct = {
  id: string;
  category_id: string | null;
  name: string;
  description: string;
  price_lkr: number;
  sale_price_lkr: number | null;
  sale_starts_at: string | null;
  sale_ends_at: string | null;
  is_available: boolean;
  is_featured: boolean;
  is_new: boolean;
  is_bestseller: boolean;
};
type StorefrontVariant = {
  id: string;
  product_id: string;
  name: string;
  price_delta_lkr: number;
  is_available: boolean;
  sort_order: number;
};
type StorefrontCategory = { id: string; name: string; image_path: string | null; sort_order: number };
type ProductImage = { product_id: string; storage_path: string; alt_text: string; is_primary: boolean; sort_order: number };
type PackagingOption = {
  id: string;
  name: string;
  price_lkr: number;
  is_available: boolean;
  min_items: number;
  max_items: number | null;
};
type DeliveryZone = {
  id: string;
  name: string;
  fee_lkr: number;
  estimated_delivery: string;
  is_available: boolean;
};
type GameSettings = { game_key: string; title: string; description: string; settings: Record<string, unknown>; is_enabled: boolean };
type HomeSection = { id: string; section_key: string; title: string; content: Record<string, unknown>; sort_order: number };
type OrderRequest = {
  customer_name: string;
  contact_number: string;
  delivery_address: string;
  gift_message: string;
  items: Array<{ product_id: string; variant_id: string | null; quantity: number }>;
  packaging_id: string | null;
  delivery_zone_id: string | null;
  coupon_code: string;
};
type SavedOrder = {
  order_id: string;
  order_number: string;
  subtotal_lkr: number;
  packaging_charge_lkr: number;
  delivery_charge_lkr: number;
  delivery_zone_name: string;
  discount_lkr: number;
  coupon_code: string;
  total_lkr: number;
  items: Array<{
    product_name: string;
    variant_name: string;
    quantity: number;
    unit_price_lkr: number;
    line_total_lkr: number;
  }>;
};

function isSavedOrder(value: unknown): value is SavedOrder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const order = value as Record<string, unknown>;
  return typeof order.order_id === "string" &&
    typeof order.order_number === "string" &&
  Number.isSafeInteger(order.subtotal_lkr) &&
  Number.isSafeInteger(order.packaging_charge_lkr) &&
  Number.isSafeInteger(order.delivery_charge_lkr) &&
  typeof order.delivery_zone_name === "string" &&
  Number.isSafeInteger(order.discount_lkr) &&
  typeof order.coupon_code === "string" &&
  Number.isSafeInteger(order.total_lkr) &&
    Array.isArray(order.items) &&
    order.items.every(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const line = item as Record<string, unknown>;
      return typeof line.product_name === "string" &&
        typeof line.variant_name === "string" &&
        Number.isSafeInteger(line.quantity) &&
        Number.isSafeInteger(line.unit_price_lkr) &&
        Number.isSafeInteger(line.line_total_lkr);
    });
}

declare global {
  interface Window {
    setWildStorefront?: (data: {
      products: Array<Record<string, unknown>>;
      categories: Array<Record<string, unknown>>;
      packagingOptions: PackagingOption[];
      settings: Record<string, unknown>;
      games: GameSettings[];
      deliveryZones: DeliveryZone[];
      homepageSections: HomeSection[];
      logoUrl?: string;
    }) => void;
    createWildOrder?: (payload: OrderRequest) => Promise<SavedOrder>;
  }
}

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
if (url && anonKey) {
  const supabase = createClient(url, anonKey);
  const feedback = document.getElementById("storefront-feedback");
  if (feedback) {
    feedback.textContent = "Loading the latest shop details…";
    feedback.hidden = false;
  }
  document.getElementById("whatsapp-order")?.setAttribute("disabled", "true");
  void loadStorefront(supabase);
  window.createWildOrder = async payload => {
    const { data, error } = await supabase.functions.invoke("create-order", { body: payload });
    if (error) {
      let message = error.message || "The order enquiry service could not be reached.";
      if (error instanceof FunctionsHttpError && error.context instanceof Response) {
        try {
          const body: unknown = await error.context.clone().json();
          if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
            message = body.error;
          }
        } catch (parseError) {
          console.error("Could not read the order service error response.", parseError);
        }
      }
      throw new Error(message);
    }
    if (!isSavedOrder(data)) {
      throw new Error("The order service returned an unexpected response. Please contact the shop before retrying.");
    }
    return data;
  };
}

async function loadStorefront(client: SupabaseClient<any, "public">) {
  const feedback = document.getElementById("storefront-feedback");
  const showError = (text: string) => {
    if (!feedback) return;
    feedback.textContent = text;
    feedback.hidden = false;
  };

  const loadResults = () => Promise.all([
    client.from("storefront_products").select("id,category_id,name,description,price_lkr,sale_price_lkr,sale_starts_at,sale_ends_at,is_available,is_featured,is_new,is_bestseller").order("created_at", { ascending: false }),
    client.from("categories").select("id,name,image_path,sort_order").eq("is_visible", true).order("sort_order"),
    client.from("product_images").select("product_id,storage_path,alt_text,is_primary,sort_order").order("sort_order"),
    client.from("product_variants").select("id,product_id,name,price_delta_lkr,is_available,sort_order").eq("is_available", true).order("sort_order"),
    client.rpc("get_public_store_settings"),
    client.from("packaging_options").select("id,name,price_lkr,is_available,min_items,max_items").eq("is_available", true).order("sort_order"),
    client.from("game_settings").select("game_key,title,description,settings,is_enabled").eq("is_enabled", true),
    client.from("delivery_zones").select("id,name,fee_lkr,estimated_delivery,is_available").eq("is_available", true).order("sort_order"),
    client.from("homepage_sections").select("id,section_key,title,content,sort_order").eq("is_visible", true).order("sort_order"),
  ]);
  let results: Awaited<ReturnType<typeof loadResults>>;
  try {
    results = await loadResults();
  } catch (error) {
    showError("The shared shop data could not be loaded. This page is showing its clearly labelled preview catalogue; please try refreshing.");
    document.getElementById("whatsapp-order")?.setAttribute("disabled", "true");
    console.error("Storefront data request failed.", error);
    return;
  }
  const [productsResult, categoriesResult, imagesResult, variantsResult, settingsResult, packagingResult, gamesResult, zonesResult, sectionsResult] = results;
  const failure = productsResult.error || categoriesResult.error || imagesResult.error ||
    variantsResult.error || settingsResult.error || packagingResult.error || gamesResult.error || zonesResult.error || sectionsResult.error;
  if (failure) {
    showError("The shared shop data could not be loaded. This page is showing its clearly labelled preview catalogue; please try refreshing.");
    document.getElementById("whatsapp-order")?.setAttribute("disabled", "true");
    console.error("Storefront data could not be loaded from Supabase.", failure.message);
    return;
  }

  const categories = (categoriesResult.data ?? []) as StorefrontCategory[];
  const categoryNames = new Map(categories.map(category => [category.id, category.name]));
  const images = (imagesResult.data ?? []) as ProductImage[];
  const variants = (variantsResult.data ?? []) as StorefrontVariant[];
  const productRows = (productsResult.data ?? []) as StorefrontProduct[];
  const products = productRows.map(product => {
    const image = images.find(item => item.product_id === product.id && item.is_primary)
      ?? images.find(item => item.product_id === product.id);
    const onSale = product.sale_price_lkr !== null &&
      (!product.sale_starts_at || new Date(product.sale_starts_at).getTime() <= Date.now()) &&
      (!product.sale_ends_at || new Date(product.sale_ends_at).getTime() > Date.now());
    return {
      id: product.id,
      name: product.name,
      category: product.category_id ? categoryNames.get(product.category_id) ?? "Little extras" : "Little extras",
      description: product.description,
      price: onSale ? product.sale_price_lkr : product.price_lkr,
      originalPrice: onSale ? product.price_lkr : null,
      imageUrl: image ? client.storage.from("store-images").getPublicUrl(image.storage_path).data.publicUrl : "",
      imageAlt: image?.alt_text || product.name,
      available: product.is_available,
      featured: product.is_featured,
      isNew: product.is_new,
      bestseller: product.is_bestseller,
      variants: variants.filter(variant => variant.product_id === product.id),
      isRemote: true,
    };
  });
  const categoryCards = categories.map(category => ({
    id: category.id, name: category.name, imageUrl: category.image_path
      ? client.storage.from("store-images").getPublicUrl(category.image_path).data.publicUrl
      : "",
  }));
  const rawSettings = settingsResult.data;
  const settings = rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)
    ? rawSettings as Record<string, unknown>
    : {};
  const settingsLogo = typeof settings.logo_path === "string" ? settings.logo_path : "";
  const logoUrl = settingsLogo
    ? /^https?:\/\//i.test(settingsLogo)
      ? settingsLogo
      : settingsLogo.startsWith("assets/")
        ? `/${settingsLogo}`
        : client.storage.from("store-images").getPublicUrl(settingsLogo).data.publicUrl
    : undefined;

  window.setWildStorefront?.({
    products,
    categories: categoryCards,
    packagingOptions: (packagingResult.data ?? []) as PackagingOption[],
    settings,
    games: (gamesResult.data ?? []) as GameSettings[],
    deliveryZones: (zonesResult.data ?? []) as DeliveryZone[],
    homepageSections: (sectionsResult.data ?? []) as HomeSection[],
    logoUrl,
  });
}
