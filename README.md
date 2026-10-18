# CFO-oriented synthetic FP&A dataset v2

All data is fictional and USD-denominated. Actuals end September 2026; October 2026–December 2027 are modeled forecasts. This is a replacement data model, NOT a drop-in update of existing embedded dashboard JSON.

## Story
- Mid-2026 transaction-volume disruption (especially strategic client C002), API attrition and remediation costs.
- Fixed personnel/corporate costs do not fall with revenue; modest cost restructuring starts October 2026.
- Business-line direct contribution differs from fully allocated operating profit. Corporate shared costs are allocated by revenue share in fact_cost_allocation for management reporting only; never add allocations again to consolidated expense.
- Cash receipts lag recognized revenue by 30/60/90 days, illustrating liquidity pressure.
- Stress scenarios apply 25%, 50%, or 65% cuts to TOTAL forecast revenue, not incremental growth. Variable expenses scale proportionally; fixed costs do not. Savings-to-break-even are operating savings, not automatically achievable cash savings.

## Main tables
- dim_month, dim_product, dim_customer, dim_contract, dim_expense_account, dim_cost_center
- fact_revenue_actual, fact_expense_actual, fact_budget_monthly, fact_usage_monthly
- fact_revenue_drivers, fact_cost_allocation, fact_pnl_monthly
- fact_cashflow_actual, fact_cashflow_forecast, fact_revenue_forecast, fact_stress_scenarios

## Formula definitions
- Operating contribution = recognized revenue - all operating expenses (EBITDA proxy, not audited EBITDA).
- Business-line fully allocated profit = product revenue - direct product expenses - allocated corporate shared costs.
- Stress profit = shocked total revenue - proportionally shocked variable expenses - unchanged fixed costs.
- Required fixed savings to break even = max(0, -stress profit).
- Closing cash = opening cash + collections - operating cash payments - capex.

## Limitations
- No taxes, interest, depreciation, debt, VAT, FX, deferred revenue, AR aging or restructuring cash costs.
- Cash receipts use approximate monthly payment terms and opening cash; initial opening receivables are assumed zero.
- Usage units are stylized proxies and must not be interpreted as real transaction/asset economics.
- Revenue allocation to clients is synthetic; price-volume decomposition requires a more detailed volume/price history.
- Cost allocations use revenue share as a simple explicit assumption, not activity-based costing.
- Current dashboard HTML pages require a regeneration or data-mapping step to use these files.

## Live AI analyst widget
The three HTML pages embed the existing Cloudflare Worker chat at https://restless-scene-009b.ozornov-s-a.workers.dev/chat. The previous rule-based chat UI is removed, while dashboard interactions and charts remain. The iframe is loaded on first opening. Ensure the Worker permits iframe embedding from your Neocities domain via its CSP frame-ancestors / X-Frame-Options settings. The iframe does not automatically send dashboard data.json or selected month to the Worker; that requires a separate backend integration.
