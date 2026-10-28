const corsHeaders = (origin: string) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

function response(origin: string, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

class PayloadTooLargeError extends Error {}

async function readJsonBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing request body.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new PayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

Deno.serve(async request => {
  const origin = request.headers.get("origin") ?? "";
  const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!origin || !allowedOrigins.includes(origin)) {
    return new Response("This store origin is not configured for order enquiries.", { status: 403 });
  }
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") return response(origin, 405, { error: "Use POST to save an order enquiry." });

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 16_384) return response(origin, 413, { error: "This enquiry is too large to process." });

  const clientIp = request.headers.get("cf-connecting-ip");
  if (!clientIp) return response(origin, 400, { error: "We couldn't verify this connection. Please try again." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("create-order is missing its server-side Supabase configuration.");
    return response(origin, 503, { error: "Order enquiries are temporarily unavailable. Please contact the shop." });
  }

  const headers = { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" };
  let rateResponse: Response;
  try {
    rateResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/consume_order_rate_limit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_ip_hash: await sha256(clientIp) }),
    });
  } catch (error) {
    console.error("create-order rate-limit request failed.", error);
    return response(origin, 503, { error: "Order enquiries are temporarily unavailable. Please try again shortly." });
  }
  if (!rateResponse.ok) {
    console.error("create-order rate-limit check failed.", rateResponse.status);
    return response(origin, 503, { error: "Order enquiries are temporarily unavailable. Please try again shortly." });
  }
  let allowed: unknown;
  try {
    allowed = await rateResponse.json();
  } catch (error) {
    console.error("create-order rate-limit response was invalid.", error);
    return response(origin, 503, { error: "Order enquiries are temporarily unavailable. Please try again shortly." });
  }
  if (allowed !== true) return response(origin, 429, { error: "Too many enquiries were sent from this connection. Please wait a little before trying again." });

  let body: Record<string, unknown>;
  try {
    const parsed = await readJsonBody(request);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response(origin, 400, { error: "The enquiry details are not valid." });
    }
    body = parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return response(origin, 413, { error: "This enquiry is too large to process." });
    }
    return response(origin, 400, { error: "The enquiry details could not be read." });
  }

  const name = typeof body.customer_name === "string" ? body.customer_name.trim() : "";
  const phone = typeof body.contact_number === "string" ? body.contact_number.trim() : "";
  const address = typeof body.delivery_address === "string" ? body.delivery_address.trim() : "";
  const message = typeof body.gift_message === "string" ? body.gift_message : "";
  const items = body.items;
  const packagingId = body.packaging_id;
  const deliveryZoneId = body.delivery_zone_id;
  const couponCode = typeof body.coupon_code === "string" ? body.coupon_code.trim().toUpperCase() : "";
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (name.length < 1 || name.length > 120 || !/^[+0-9][0-9+() \-]{5,31}$/.test(phone) ||
      address.length < 5 || address.length > 1000 || message.length > 400 ||
      couponCode.length > 40 ||
      !Array.isArray(items) || items.length < 1 || items.length > 30 ||
      (packagingId !== null && packagingId !== undefined && (typeof packagingId !== "string" || !uuidPattern.test(packagingId))) ||
      (deliveryZoneId !== null && deliveryZoneId !== undefined && (typeof deliveryZoneId !== "string" || !uuidPattern.test(deliveryZoneId)))) {
    return response(origin, 400, { error: "Check the name, contact number, delivery address and selected products." });
  }

  const seen = new Set<string>();
  const validatedItems: Array<{ product_id: string; variant_id: string | null; quantity: number }> = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return response(origin, 400, { error: "One of the selected products is not valid." });
    }
    const record = item as Record<string, unknown>;
    if (typeof record.product_id !== "string" || !uuidPattern.test(record.product_id) ||
        (record.variant_id !== null && record.variant_id !== undefined &&
          (typeof record.variant_id !== "string" || !uuidPattern.test(record.variant_id))) ||
        typeof record.quantity !== "number" || !Number.isSafeInteger(record.quantity) ||
        record.quantity < 1 || record.quantity > 100 || seen.has(record.product_id)) {
      return response(origin, 400, { error: "Review product quantities and remove duplicate selections." });
    }
    seen.add(record.product_id);
    validatedItems.push({
      product_id: record.product_id,
      variant_id: typeof record.variant_id === "string" ? record.variant_id : null,
      quantity: record.quantity,
    });
  }

  let orderResponse: Response;
  try {
    orderResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/create_guest_order`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_customer_name: name,
        p_contact_number: phone,
        p_delivery_address: address,
        p_gift_message: message,
        p_items: validatedItems,
        p_packaging_id: packagingId || null,
        p_delivery_zone_id: deliveryZoneId || null,
        p_coupon_code: couponCode,
      }),
    });
  } catch (error) {
    console.error("create-order database request failed.", error);
    return response(origin, 503, { error: "We couldn't save this enquiry. Please try again or contact the shop." });
  }
  if (!orderResponse.ok) {
    const details = await orderResponse.text();
    console.error("create-order database call failed.", orderResponse.status);
    if (details.toLowerCase().includes("temporarily not taking order enquiries")) {
      return response(origin, 409, { error: "The store has paused new enquiries. Please contact the shop directly." });
    }
    if (details.toLowerCase().includes("delivery option")) {
      return response(origin, 422, { error: "The selected delivery area is no longer available. Review your selection and try again." });
    }
    if (details.toLowerCase().includes("packaging option") || details.toLowerCase().includes("packaging option does not fit")) {
      return response(origin, 422, { error: "The selected packaging option is no longer available or does not fit your gift. Review your selection and try again." });
    }
    if (details.toLowerCase().includes("coupon")) {
      return response(origin, 422, { error: "That coupon cannot be used for this gift. Check its spelling, eligibility and expiry." });
    }
    if (orderResponse.status === 400 || orderResponse.status === 404) {
      return response(origin, 422, { error: "A selected product or packaging option is no longer available. Review your gift and try again." });
    }
    return response(origin, 503, { error: "We couldn't save this enquiry. Please try again or contact the shop." });
  }

  let result: unknown;
  try {
    result = await orderResponse.json();
  } catch (error) {
    console.error("create-order database response was invalid.", error);
    return response(origin, 503, { error: "The saved enquiry could not be confirmed. Please contact the shop before retrying." });
  }
  const saved = Array.isArray(result) ? result[0] as Record<string, unknown> | undefined : undefined;
  if (!saved || typeof saved.order_number !== "string" ||
      typeof saved.order_id !== "string" ||
      !Number.isSafeInteger(saved.subtotal_lkr) ||
      !Number.isSafeInteger(saved.packaging_charge_lkr) ||
      !Number.isSafeInteger(saved.delivery_charge_lkr) ||
      typeof saved.delivery_zone_name !== "string" ||
      !Number.isSafeInteger(saved.discount_lkr) ||
      typeof saved.coupon_code !== "string" ||
      !Number.isSafeInteger(saved.total_lkr) ||
      !Array.isArray(saved.items) ||
      !saved.items.every(item => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        const line = item as Record<string, unknown>;
        return typeof line.product_name === "string" &&
          typeof line.variant_name === "string" &&
          Number.isSafeInteger(line.quantity) &&
          Number.isSafeInteger(line.unit_price_lkr) &&
          Number.isSafeInteger(line.line_total_lkr);
      })) {
    console.error("create-order returned an unexpected database result.");
    return response(origin, 503, { error: "The saved enquiry could not be confirmed. Please contact the shop before retrying." });
  }
  return response(origin, 201, saved);
});
