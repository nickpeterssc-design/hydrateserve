/**
 * HydrateServe checkout Worker
 * ----------------------------------------------------------------------
 *   POST /api/checkout   creates a Shopify draft order for a configured
 *                        build and returns its checkout URL
 *   everything else      falls through to the static site
 *
 * WHY THIS EXISTS
 * The configurator is a static page, so it cannot be trusted with the
 * price - anyone can edit the JavaScript and pay $1. The browser sends the
 * BUILD (which functions, which filtration, warranty yes/no) and this
 * Worker recomputes the price from its own table. The number the customer
 * types is never the number they are charged.
 *
 * SECRETS (set with `wrangler secret put NAME`, never commit them)
 *   SHOPIFY_STORE         e.g. hydrate-filters.myshopify.com
 *   SHOPIFY_ADMIN_TOKEN   Admin API access token, scope: write_draft_orders
 *
 * KEEPING PRICES IN STEP
 * The tables below mirror residential/finder/index.html. If you change one,
 * change the other. The Worker returns the total it computed and the page
 * refuses to redirect if it disagrees, so drift surfaces as an error rather
 * than as a customer being charged something they were not shown.
 */

// Shopify releases quarterly and supports each version for ~12 months.
// Bump this when convenient; check shopify.dev for the current stable.
const API_VERSION = "2026-01";

const CURRENCY = "NZD";

/* ---- pricing (mirror of the configurator) ---------------------------- */
const BASE = {
  "ambient"                   : { ufx3: 1277, ro: 1726 },
  "chilled"                   : { ufx3: 2542, ro: 2991 },
  "chilled+sparkling"         : { ufx3: 3991, ro: 4440 },
  "boiling"                   : { ufx3: 2887, ro: 3336 },
  "chilled+boiling"           : { ufx3: 4842, ro: 5291 },
  "chilled+sparkling+boiling" : { ufx3: 5601, ro: 6050 }
};
const TAP_PRICE = 379;
const WARRANTY_PRICE = 249;

const FILTRATION_LABEL = { ufx3: "UFX3 Standard", ro: "RO Upgrade" };

/** Resolve the function set the same way the page does. Sparkling implies chilled. */
function comboKey(functions) {
  const set = new Set(Array.isArray(functions) ? functions : []);
  if (set.has("sparkling")) set.add("chilled");
  const f = [];
  if (set.has("chilled")) f.push("chilled");
  if (set.has("sparkling")) f.push("sparkling");
  if (set.has("boiling")) f.push("boiling");
  return f.length ? f.join("+") : "ambient";
}

/** Authoritative price. Anything the client sent about money is ignored. */
function priceBuild(build) {
  const combo = comboKey(build.functions);
  const filtration = build.filtration === "ro" ? "ro" : "ufx3";
  const base = BASE[combo];
  if (!base) throw new Error("Unknown build: " + combo);

  const lines = [
    {
      title: `HydrateServe system - ${combo.replace(/\+/g, " + ")} (${FILTRATION_LABEL[filtration]})`,
      amount: base[filtration]
    },
    {
      title: `Tap - ${build.tap || "style to confirm"}${build.finish ? ` (${build.finish})` : ""}`,
      amount: TAP_PRICE
    }
  ];
  if (build.warranty === true) {
    lines.push({ title: "Extended warranty (+1 year)", amount: WARRANTY_PRICE });
  }

  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  return { combo, filtration, lines, total };
}

const DRAFT_ORDER_MUTATION = `
mutation CreateBuildDraftOrder($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) {
    draftOrder {
      id
      name
      invoiceUrl
      totalPriceSet { shopMoney { amount currencyCode } }
    }
    userErrors { field message }
  }
}`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function handleCheckout(request, env) {
  if (!env.SHOPIFY_STORE || !env.SHOPIFY_ADMIN_TOKEN) {
    // Not configured yet - the page falls back to its "not switched on" screen.
    return json({ error: "checkout_not_configured" }, 503);
  }

  let build;
  try {
    build = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  let priced;
  try {
    priced = priceBuild(build);
  } catch (err) {
    return json({ error: "bad_build", detail: String(err.message || err) }, 400);
  }

  // Prices are entered incl-GST, matching the workbook. This relies on the
  // store being set to "All prices include tax" (Settings > Taxes). If that
  // setting is off, Shopify will add GST on top and the totals will not match.
  const input = {
    email: typeof build.email === "string" ? build.email : undefined,
    tags: ["configurator", "residential"],
    note: [
      `Configured online.`,
      `Build: ${priced.combo}`,
      `Filtration: ${FILTRATION_LABEL[priced.filtration]}`,
      build.tap ? `Tap: ${build.tap}${build.finish ? " / " + build.finish : ""}` : null,
      build.fit_clearance ? `Under-sink clearance: ${build.fit_clearance}` : null,
      build.fit_power ? `Power point: ${build.fit_power}` : null
    ].filter(Boolean).join("\n"),
    customAttributes: [
      { key: "Source", value: "Tap configurator" },
      { key: "Build", value: priced.combo },
      { key: "Filtration", value: FILTRATION_LABEL[priced.filtration] }
    ],
    lineItems: priced.lines.map(l => ({
      title: l.title,
      quantity: 1,
      requiresShipping: true,
      taxable: true,
      originalUnitPriceWithCurrency: {
        amount: l.amount.toFixed(2),
        currencyCode: CURRENCY
      }
    }))
  };

  let payload;
  try {
    const res = await fetch(
      `https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_TOKEN
        },
        body: JSON.stringify({ query: DRAFT_ORDER_MUTATION, variables: { input } })
      }
    );
    if (!res.ok) return json({ error: "shopify_http", status: res.status }, 502);
    payload = await res.json();
  } catch (err) {
    return json({ error: "shopify_unreachable" }, 502);
  }

  if (payload.errors?.length) {
    return json({ error: "shopify_graphql", detail: payload.errors[0]?.message }, 502);
  }
  const result = payload.data?.draftOrderCreate;
  if (result?.userErrors?.length) {
    return json({ error: "shopify_rejected", detail: result.userErrors[0].message }, 400);
  }
  const url = result?.draftOrder?.invoiceUrl;
  if (!url) return json({ error: "no_invoice_url" }, 502);

  // total is returned so the page can check it against what it displayed.
  return json({ url, total: priced.total, order: result.draftOrder.name });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/checkout") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      try {
        return await handleCheckout(request, env);
      } catch (err) {
        // Never let a checkout bug take the site down.
        return json({ error: "unexpected" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
