# Cloudflare Worker — Gemini FP&A agent, R2 storage

This file updates the existing Gemini-based Worker supplied by the user. It keeps `/chat`, `/api/chat`, sessionStorage UI chat history and the `/api/test/variance` route. It replaces the D1 SQL dependency with read-only R2 access to `data.json`.

## Configure in Cloudflare Dashboard UI

1. Open **R2 Object Storage**, create/select a private bucket, and upload the dashboard's **`data.json`** object to the bucket root (exact key `data.json`). The JSON must have top-level arrays such as `fact_pnl_monthly`, `fact_revenue_actual`, `fact_budget_monthly`, `fact_expense_actual`, and `dim_expense_account`.
2. Go to **Workers & Pages** > your existing Worker > **Settings** > **Bindings** > **Add** > **R2 bucket**; select your bucket and name the **binding variable** `FINANCIAL_DATA`. The bucket name and binding variable are separate concepts.
3. Add/retain the secret `GEMINI_API_KEY` (do not place the key into source).
4. Back up your current Worker. Copy the content of `worker_r2_financial_data.js` into the dashboard code editor; deploy.
5. Check `/api/health/data` on your Worker URL: it should return `{"connected":true,"source":"R2",...}`. `/api/health/db` remains as a backwards-compatible alias, but it now checks R2, not D1.
6. Check `/api/test/variance?month=2026-09`: with the included dataset, operating contribution is about **-$26,968**, budget **$426,813**, and variance about **-$453,781**. Some rounding differences come from CSV row rounding.
7. Open `/chat` and ask "Why did EBITDA differ from budget in September 2026?" or "What fixed-cost savings are needed after a 50% total revenue decline in October 2026?".

## Financial tools

- `get_ebitda_variance`: reconciles monthly revenue, COGS, OPEX and operating contribution against the budget.
- `get_revenue_drivers`: returns product budget gaps, synthetic incident notes and modeled revenues.
- `get_cash_position`: actual or forecast cashflow for a given month.
- `get_revenue_stress`: precomputed total-revenue stress scenarios for forecast months (0%, 25%, 50%, 65%).

## Operational notes

- Existing Gemini model `gemini-2.5-flash-lite` and embedded chat UI retained. The chat is single-request context to Gemini: browser history is displayed/persisted but not supplied to the model (same as supplied implementation).
- R2 objects are cached in-memory by Worker isolate for **60 seconds**, so updates can take up to a minute to become visible, and caches are not shared across isolates.
- The R2 bucket can remain private. You do **not** need a public bucket URL.
- The chat endpoint is publicly accessible. Add Cloudflare rate limiting, bot controls and API quotas/spending alerts before public promotion. Consider protecting the diagnostic routes if you do not want them public.
- The Content Security Policy allows framing under `*.neocities.org`. Adjust `frame-ancestors` if you host your portfolio elsewhere.
- The Worker code was syntax-tested with Node.js and exercised against a local mock R2 binding and a simulated Gemini function-call response. It has **not** been deployed to, or live tested against, your Cloudflare account or Gemini API.
