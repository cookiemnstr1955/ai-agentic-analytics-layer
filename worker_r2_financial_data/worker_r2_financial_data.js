// THE SAFE FP&A — Cloudflare Worker (R2 + Gemini)
// R2 binding: FINANCIAL_DATA | object key: data.json
// Secret: GEMINI_API_KEY
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const DATA_KEY = "data.json";

const SYSTEM_PROMPT = `You are a CFO-level FP&A analyst for a fictional digital-asset infrastructure company.
All data is synthetic and amounts are USD. The latest actual month is September 2026; future periods are forecasts.
You MUST call the relevant financial tool before reporting financial amounts, comparisons or conclusions.
Never invent financial numbers, incident causes, customer data or cost assumptions.
Revenue variance = actual revenue - budget revenue. Favorable cost impact = budget cost - actual cost.
Operating contribution (EBITDA proxy) = revenue - COGS - OPEX; it is NOT statutory/audited EBITDA.
Distinguish actuals, budgets, forecasts, and scenario estimates. Cite the month and distinguish vs-budget from vs-prior-period.
For unavailable metrics, admit the limitation. Interpret tool errors as missing/invalid information, not zeroes.
Explain major risk drivers and actionable implications in plain language. Keep replies concise.`;

const TOOL_DECLARATIONS = [
  {
    name: "get_ebitda_variance",
    description: "Compute recognized revenue, COGS, OPEX, operating contribution and actual-minus-budget waterfall for an actual month.",
    parameters: { type: "OBJECT", properties: {
      month: { type: "STRING", description: "Actual month YYYY-MM, e.g. 2026-09" }
    }, required: ["month"] }
  },
  {
    name: "get_revenue_drivers",
    description: "Explain product-level recognized revenue budget gaps and modeled incident drivers for an actual month.",
    parameters: { type: "OBJECT", properties: {
      month: { type: "STRING", description: "Actual month YYYY-MM" }
    }, required: ["month"] }
  },
  {
    name: "get_cash_position",
    description: "Return actual or forecast month-end cash, customer collections, payments, capex and net cash movement.",
    parameters: { type: "OBJECT", properties: {
      month: { type: "STRING", description: "Month YYYY-MM" }
    }, required: ["month"] }
  },
  {
    name: "get_revenue_stress",
    description: "Find a precomputed total-revenue shock scenario (0%, 25%, 50%, or 65%) and required fixed cost savings for a forecast month.",
    parameters: { type: "OBJECT", properties: {
      month: { type: "STRING", description: "Forecast month YYYY-MM, e.g. 2026-10" },
      decline_pct: { type: "NUMBER", description: "Percent reduction in TOTAL revenue (0, 25, 50 or 65)." }
    }, required: ["month", "decline_pct"] }
  }
];

const round = v => Math.round((v + Number.EPSILON) * 100) / 100;
const num = v => { const n = Number(v); if (v == null || v === "" || !Number.isFinite(n)) throw new Error("Invalid amount in dataset"); return n; };
const sum = (rows, field) => rows.reduce((acc, r) => acc + num(r[field]), 0);
const byMonth = (rows, date) => rows.filter(r => r.month === date);
function dateFor(month) {
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Month must be YYYY-MM");
  return month + "-01";
}
function requireTable(data, name) {
  if (!Array.isArray(data[name])) throw new Error(`Missing ${name} in data.json`);
  return data[name];
}

// Per-isolate hot cache. A fresh isolate or dataset refresh will reload from R2.
let cache = null;
let cacheTime = 0;
async function loadFinancialData(env) {
  if (!env.FINANCIAL_DATA || typeof env.FINANCIAL_DATA.get !== "function") {
    throw new Error("Missing R2 binding FINANCIAL_DATA");
  }
  if (cache && Date.now() - cacheTime < 60_000) return cache;
  const object = await env.FINANCIAL_DATA.get(DATA_KEY);
  if (!object) throw new Error(`R2 object ${DATA_KEY} not found`);
  const data = await object.json();
  if (!data || typeof data !== "object" || !Array.isArray(data.fact_pnl_monthly)) {
    throw new Error("Invalid R2 financial data structure");
  }
  cache = data;
  cacheTime = Date.now();
  return data;
}

function getEbitdaVariance(data, month) {
  const date = dateFor(month);
  const pnl = requireTable(data, "fact_pnl_monthly").find(r => r.month === date && r.period_type === "Actual");
  if (!pnl) throw new Error(`Actual P&L unavailable for ${month}`);
  const revenue = sum(byMonth(requireTable(data,"fact_revenue_actual"),date),"recognized_revenue_usd");
  const accounts = Object.fromEntries(requireTable(data,"dim_expense_account").map(a=>[a.account_id,a.pnl_group]));
  const expenses = byMonth(requireTable(data,"fact_expense_actual"),date);
  const costs = { COGS:0, OPEX:0 };
  for (const e of expenses) {
    const group = accounts[e.account_id];
    if (!(group in costs)) throw new Error(`Unknown expense category for ${e.account_id}`);
    costs[group] += num(e.amount_usd);
  }
  const budgetRows = byMonth(requireTable(data,"fact_budget_monthly"),date);
  const budgets = { Revenue:0, COGS:0, OPEX:0 };
  for (const b of budgetRows) {
    if (b.budget_type === "REVENUE") budgets.Revenue += num(b.amount_usd);
    else if (b.budget_type === "EXPENSE") {
      const group = accounts[b.account_id];
      if (!(group in budgets)) throw new Error(`Unknown budget account ${b.account_id}`);
      budgets[group] += num(b.amount_usd);
    }
  }
  if (!budgetRows.length || budgets.Revenue === 0) throw new Error(`Budget unavailable for ${month}`);
  const actual = revenue-costs.COGS-costs.OPEX;
  const budget = budgets.Revenue-budgets.COGS-budgets.OPEX;
  const drivers = { revenue:revenue-budgets.Revenue, cogs:budgets.COGS-costs.COGS, opex:budgets.OPEX-costs.OPEX };
  const variance = actual-budget;
  const reconciled = Math.abs(variance-(drivers.revenue+drivers.cogs+drivers.opex))<0.02 &&
    Math.abs(actual-num(pnl.operating_contribution_usd))<0.05;
  if (!reconciled) throw new Error(`Financial reconciliation failed for ${month}`);
  return {
    month, currency:"USD", data_type:"synthetic", period_type:"Actual", metric:"Operating contribution / EBITDA proxy",
    actual:round(actual), budget:round(budget), variance:round(variance),
    variance_pct: budget===0?null:round(100*variance/Math.abs(budget)),
    actual_lines:{ revenue:round(revenue), cogs:round(costs.COGS), opex:round(costs.OPEX) },
    budget_lines:{ revenue:round(budgets.Revenue), cogs:round(budgets.COGS), opex:round(budgets.OPEX) },
    drivers:Object.fromEntries(Object.entries(drivers).map(([k,v])=>[k,round(v)])),
    reconciled:true
  };
}
function getRevenueDrivers(data,month) {
  const date=dateFor(month);
  const rows=byMonth(requireTable(data,"fact_revenue_drivers"),date);
  if (!rows.length || !requireTable(data,"fact_pnl_monthly").some(r=>r.month===date && r.period_type==="Actual"))
    throw new Error(`Revenue drivers unavailable for ${month}`);
  const names=Object.fromEntries(requireTable(data,"dim_product").map(p=>[p.product_id,p.product_name]));
  const products=rows.map(r=>({ product_id:r.product_id, product:names[r.product_id]||r.product_id,
    budget_revenue_usd:round(num(r.budget_revenue_usd)), modeled_revenue_usd:round(num(r.modeled_revenue_usd)),
    variance_usd:round(num(r.revenue_gap_usd)), driver_note:r.driver_note, incident_multiplier:num(r.incident_multiplier) }));
  return {month, currency:"USD", period_type:"Actual", data_type:"synthetic",
    total_budget_usd:round(products.reduce((a,p)=>a+p.budget_revenue_usd,0)),
    total_modeled_usd:round(products.reduce((a,p)=>a+p.modeled_revenue_usd,0)),
    products:products.sort((a,b)=>a.variance_usd-b.variance_usd)};
}
function getCashPosition(data,month) {
  const date=dateFor(month);
  const records=[...requireTable(data,"fact_cashflow_actual"),...requireTable(data,"fact_cashflow_forecast")];
  const row=records.find(r=>r.month===date);
  if (!row) throw new Error(`Cashflow unavailable for ${month}`);
  return { month, currency:"USD", period_type:row.period_type, data_type:"synthetic",
    opening_cash_usd:round(num(row.opening_cash_usd)), closing_cash_usd:round(num(row.closing_cash_usd)),
    collections_usd:round(num(row.customer_collections_usd)), operating_payments_usd:round(num(row.operating_payments_usd)),
    capex_usd:round(num(row.capex_usd)), net_cash_flow_usd:round(num(row.net_cash_flow_usd)) };
}
function getRevenueStress(data,month,declinePct) {
  const date=dateFor(month);
  const shock=num(declinePct);
  if (![0,25,50,65].includes(shock)) throw new Error("Available decline_pct values: 0, 25, 50, 65");
  const scenario=`revenue_down_${shock}pct`;
  const row=requireTable(data,"fact_stress_scenarios").find(r=>r.month===date&&r.scenario===scenario);
  if (!row) throw new Error(`No stress scenario for ${month} and ${shock}%`);
  return {month, scenario, currency:"USD", period_type:"Forecast stress scenario", data_type:"synthetic",
    total_revenue_shock_pct:shock, stressed_total_revenue_usd:round(num(row.stressed_total_revenue_usd)),
    stressed_variable_cost_usd:round(num(row.stressed_variable_cost_usd)),
    fixed_cost_before_action_usd:round(num(row.fixed_cost_before_action_usd)),
    operating_profit_before_action_usd:round(num(row.operating_profit_before_action_usd)),
    fixed_cost_savings_to_break_even_usd:round(num(row.fixed_cost_savings_to_break_even_usd)),
    fixed_cost_cut_to_break_even_pct:round(num(row.fixed_cost_cut_to_break_even_pct)),
    feasible_with_fixed_cost_cuts_only:String(row.feasible_with_fixed_cost_cuts_only).toLowerCase()==="true"};
}
const HANDLERS={
  get_ebitda_variance:(data,args)=>getEbitdaVariance(data,args?.month),
  get_revenue_drivers:(data,args)=>getRevenueDrivers(data,args?.month),
  get_cash_position:(data,args)=>getCashPosition(data,args?.month),
  get_revenue_stress:(data,args)=>getRevenueStress(data,args?.month,args?.decline_pct)
};

async function callGemini(env,contents) {
  const response=await fetch(GEMINI_API_URL,{
    method:"POST", headers:{ "Content-Type":"application/json", "x-goog-api-key":env.GEMINI_API_KEY },
    body:JSON.stringify({ systemInstruction:{parts:[{text:SYSTEM_PROMPT}]}, contents,
      tools:[{functionDeclarations:TOOL_DECLARATIONS}],
      generationConfig:{temperature:0.1,maxOutputTokens:1000} })
  });
  if (!response.ok) {
    console.error("Gemini API failed",response.status,(await response.text()).slice(0,300));
    throw new Error("Gemini API request failed");
  }
  return response.json();
}
async function handleChat(request,env) {
  if (!env.FINANCIAL_DATA||!env.GEMINI_API_KEY)
    return Response.json({error:"Missing FINANCIAL_DATA or GEMINI_API_KEY configuration"},{status:500});
  if (Number(request.headers.get("Content-Length")||0)>10_000)
    return Response.json({error:"Request too large"},{status:413});
  let input;
  try { input=await request.json(); } catch { return Response.json({error:"Invalid JSON"},{status:400}); }
  const message=input?.message;
  if(typeof message!=="string"||!message.trim()||message.length>1200)
    return Response.json({error:"Invalid message"},{status:400});
  try {
    const data=await loadFinancialData(env);
    const contents=[{role:"user",parts:[{text:message}]}];
    const toolsUsed=[];
    for (let turn=0;turn<4;turn++) {
      const result=await callGemini(env,contents);
      const modelContent=result.candidates?.[0]?.content;
      if (!modelContent?.parts?.length) throw new Error("No Gemini response");
      const calls=modelContent.parts.filter(p=>p.functionCall).map(p=>p.functionCall);
      if (!calls.length) {
        const answer=modelContent.parts.filter(p=>typeof p.text==="string").map(p=>p.text).join("\n");
        return Response.json({answer:answer||"No explanation available.",tools_used:toolsUsed,data_type:"synthetic"});
      }
      if (turn===3) throw new Error("Too many tool rounds");
      contents.push(modelContent);
      const responses=[];
      for(const call of calls.slice(0,3)) {
        let payload;
        try {
          if (!Object.prototype.hasOwnProperty.call(HANDLERS,call.name)) throw new Error("Unsupported tool");
          payload=HANDLERS[call.name](data,call.args);
          toolsUsed.push({name:call.name,month:payload.month});
        } catch(e) { payload={error:String(e.message||e)}; }
        responses.push({functionResponse:{...(call.id?{id:call.id}:{}),name:call.name,response:payload}});
      }
      contents.push({role:"user",parts:responses});
    }
    throw new Error("Tool loop exhausted");
  } catch(error) {
    console.error("Financial AI error",error);
    return Response.json({error:"Unable to generate an explanation"},{status:502});
  }
}

const CHAT_HTML = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  >
  <title>THE SAFE AI Analyst</title>
  <style>
    * {
      box-sizing: border-box;
    }
    :root {
      color-scheme: dark;
    }
    body {
      margin: 0;
      background: #11131b;
      color: #eeeeff;
      font-family: system-ui, sans-serif;
      font-size: 14px;
    }
    main {
      height: 100dvh;
      display: flex;
      flex-direction: column;
      padding: 14px;
      gap: 12px;
    }
    header {
      padding-bottom: 12px;
      border-bottom: 1px solid #353547;
    }
    .title {
      font-weight: 700;
      font-size: 15px;
    }
    .note {
      color: #9999b0;
      font-size: 11px;
      margin-top: 5px;
    }
    #log {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      line-height: 1.6;
    }
    .msg {
      padding: 12px;
      border-radius: 10px;
      margin-bottom: 10px;
      background: #242635;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .user {
      background: #34264e;
    }
    .bot {
      background: #242635;
    }
    form {
      display: flex;
      gap: 8px;
    }
    input {
      min-width: 0;
      flex: 1;
      padding: 12px;
      border-radius: 9px;
      border: 1px solid #44445d;
      outline: none;
      background: #1c1e2a;
      color: white;
    }
    input:focus {
      border-color: #9777f0;
    }
    button {
      padding: 10px 14px;
      border: none;
      border-radius: 9px;
      background: #906be5;
      color: white;
      cursor: pointer;
      font-weight: 600;
    }
    button:disabled {
      opacity: 0.5;
    }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .clear-btn {
      background: transparent;
      border: 1px solid #414154;
      color: #aaaac0;
      font-size: 11px;
      padding: 6px 9px;
    }
  </style>
</head>
<body>
<main>
  <header>
    <div class="toolbar">
      <div class="title">
        ✦ THE SAFE AI Financial Analyst
      </div>
      <button
        type="button"
        class="clear-btn"
        id="clear"
      >
        Clear chat
      </button>
    </div>
    <div class="note">
      Synthetic financial dataset · AI-powered analysis
    </div>
  </header>
  <div id="log" aria-live="polite"></div>
  <form id="f">
    <input
      id="q"
      maxlength="1200"
      placeholder="Ask about financial performance..."
      aria-label="Financial question"
      autocomplete="off"
      required
    >
    <button id="send" type="submit">
      Send
    </button>
  </form>
</main>
<script>
  const log = document.getElementById("log");
  const form = document.getElementById("f");
  const input = document.getElementById("q");
  const send = document.getElementById("send");
  const clearButton = document.getElementById("clear");
  // =============================================
  // CHAT HISTORY STORAGE
  // =============================================
  const HISTORY_KEY = "vault_chat_history_v1";
  let chatHistory = [];
  function loadHistory() {
    try {
      const stored = sessionStorage.getItem(HISTORY_KEY);
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(item =>
          item &&
          (item.role === "user" || item.role === "bot") &&
          typeof item.text === "string"
        )
        .slice(-30);
    } catch (error) {
      console.warn("History unavailable:", error);
      return [];
    }
  }
  function saveHistory() {
    chatHistory = chatHistory.slice(-30);
    try {
      sessionStorage.setItem(
        HISTORY_KEY,
        JSON.stringify(chatHistory)
      );
    } catch (error) {
      console.warn("Unable to save history:", error);
    }
  }
  function rememberMessage(role, text) {
    chatHistory.push({
      role,
      text
    });
    saveHistory();
  }
  // =============================================
  // MESSAGE DISPLAY
  // =============================================
  function addMessage(text, role) {
    const element = document.createElement("div");
    element.className = "msg " + role;
    element.textContent = text;
    log.appendChild(element);
    log.scrollTop = log.scrollHeight;
    return element;
  }
  // =============================================
  // RESTORE PREVIOUS MESSAGES
  // =============================================
  chatHistory = loadHistory();
  if (chatHistory.length > 0) {
    chatHistory.forEach(item => {
      addMessage(item.text, item.role);
    });
  } else {
    addMessage(
      "Hello! I can explain EBITDA performance and " +
      "budget variances using the synthetic financial data. " +
      "Try asking about September 2026.",
      "bot"
    );
  }
  // =============================================
  // SEND MESSAGE
  // =============================================
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const message = input.value.trim();
    if (!message) return;
    addMessage(message, "user");
    rememberMessage("user", message);
    input.value = "";
    send.disabled = true;
    const bubble = addMessage("Analyzing...", "bot");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data.error || "Request failed"
        );
      }
      const answer =
        data.answer || "No explanation available.";
      bubble.textContent = answer;
      rememberMessage("bot", answer);
    } catch (error) {
      bubble.textContent =
        "Unable to complete the analysis. Please retry.";
    } finally {
      send.disabled = false;
      input.focus();
    }
  });
  // =============================================
  // CLEAR CONVERSATION
  // =============================================
  clearButton.addEventListener("click", () => {
    chatHistory = [];
    try {
      sessionStorage.removeItem(HISTORY_KEY);
    } catch (error) {
      console.warn("Unable to clear storage:", error);
    }
    log.textContent = "";
    addMessage(
      "Conversation cleared. How can I help?",
      "bot"
    );
    input.focus();
  });
</script>
</body>
</html>
`;

export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if (request.method==="GET" && (url.pathname==="/"||url.pathname==="/chat")) {
      return new Response(CHAT_HTML,{headers:{
        "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store",
        "X-Content-Type-Options":"nosniff", "Referrer-Policy":"no-referrer",
        "Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors https://*.neocities.org"
      }});
    }
    if (request.method==="GET" && (url.pathname==="/api/health/db"||url.pathname==="/api/health/data")) {
      try {
        const data=await loadFinancialData(env);
        return Response.json({connected:true,source:"R2",object_key:DATA_KEY,
          pnl_records:requireTable(data,"fact_pnl_monthly").length,
          revenue_records:requireTable(data,"fact_revenue_actual").length},
          {headers:{"Cache-Control":"no-store"}});
      } catch(error) {
        console.error("R2 health failed",error);
        return Response.json({connected:false,source:"R2"},{status:503});
      }
    }
    if (request.method==="GET"&&url.pathname==="/api/test/variance") {
      try {
        const data=await loadFinancialData(env);
        return Response.json(getEbitdaVariance(data,url.searchParams.get("month")),
          {headers:{"Cache-Control":"no-store"}});
      } catch(error) {return Response.json({error:String(error.message||error)},{status:400});}
    }
    if(request.method==="POST"&&url.pathname==="/api/chat") return handleChat(request,env);
    return new Response("Not Found",{status:404});
  }
};
