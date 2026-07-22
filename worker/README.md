# Checkout Worker

Takes a configured build from `/residential/finder`, prices it server-side, and
creates a **Shopify draft order** so the customer pays through the existing
Hydrate Filters store. Orders land in Shopify admin like any other.

Nothing here is live yet. The site deploys as static files only; the steps
below switch the Worker on.

## Why a Worker at all

The configurator is a static page, so it cannot be trusted with the price -
anyone can edit the JavaScript and pay $1. The browser sends only the *build*
(functions, filtration, warranty). `checkout.js` recomputes the price from its
own table and sends that to Shopify.

It also returns the total it calculated. The page compares that against what it
displayed and refuses to redirect if they differ, so if the two price tables
ever drift apart you get an error instead of a customer charged the wrong amount.

## Before you start

You need a **Shopify Admin API access token** with the `write_draft_orders`
scope. Shopify admin → Settings → Apps and sales channels → Develop apps →
create an app → Configure Admin API scopes → tick `write_draft_orders` →
Install → reveal the token.

Treat it like a password. It goes into a Cloudflare secret, never into the repo.

## 1. Point the deploy at the Worker

The current `wrangler.jsonc` serves static assets only. It needs a `main` entry
and an assets binding so the Worker can fall through to the site:

```jsonc
{
  "name": "hydrateserve",
  "compatibility_date": "2026-07-22",
  "compatibility_flags": ["nodejs_compat"],
  "main": "worker/checkout.js",
  "assets": { "directory": ".", "binding": "ASSETS" },
  "observability": { "enabled": true }
}
```

Cloudflare currently generates that file on its own `cloudflare/workers-autoconfig`
branch. Check which branch the Workers project builds from before editing, or
you may find your change overwritten.

## 2. Set the secrets

```bash
npx wrangler secret put SHOPIFY_STORE        # hydrate-filters.myshopify.com
npx wrangler secret put SHOPIFY_ADMIN_TOKEN  # the token from above
```

## 3. Test before going near real money

```bash
npx wrangler dev
```

Then open the configurator, build something, and choose **Pay now**.

Shopify has a test gateway so you can complete a checkout without a real card:
Settings → Payments → switch on **Bogus Gateway** (or put Shopify Payments in
test mode). Card `1` for success, `2` for failure, any future expiry, any CVV.
Turn it off before you take real orders.

Check as you go:

- the draft order appears in Shopify admin with the right line items
- the total matches what the configurator showed
- GST is right (see below)

## 4. Check the GST setting

Prices in the workbook and the configurator **include GST**. The Worker sends
them as-is, which is only correct if the store is set to tax-inclusive pricing:
Settings → Taxes and duties → *All prices include tax*.

If that is off, Shopify adds 15% on top and every total comes out high. Worth
confirming before the first real order.

## Keeping prices in step

`worker/checkout.js` and `residential/finder/index.html` each hold the price
table. **Change one, change the other.** The mismatch check will catch drift,
but as a blocked checkout rather than a silent overcharge.

## Not done yet

- **Order confirmation.** The customer is sent to Shopify's checkout, which
  emails them. If you want anything to happen on your side when payment
  clears, that needs a Shopify webhook - the redirect back is not reliable
  because people close the tab.
- **Abuse.** Anyone can POST to `/api/checkout` and create draft orders. Fine
  at low volume; add rate limiting if it ever gets noticed.
