process.on("uncaughtException", (err) => console.error("🔥 uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("🔥 unhandledRejection:", err));

const express = require("express");
const fetch = require("node-fetch");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

/* =========================
   ENV (Railway Variables)
========================= */
const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_PASS = process.env.ODOO_PASS;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_de_prueba";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const OPTIONS_LIMIT = Number(process.env.OPTIONS_LIMIT || 12);
const MAX_TOOL_LOOPS = Number(process.env.MAX_TOOL_LOOPS || 4);
const DEBUG = String(process.env.DEBUG || "true").toLowerCase() !== "false";

function dlog(...args) {
  if (DEBUG) console.log(...args);
}

if (!OPENAI_API_KEY) {
  console.warn("⚠️ Falta OPENAI_API_KEY. El bot seguirá, pero sin IA no hará tool-calling.");
}
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

/* =========================
   Helpers
========================= */
function getRpcBase(url) {
  const u = String(url || "").replace(/\/+$/, "");
  return u.replace(/\/odoo$/i, "");
}

function norm(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function moneyCOP(n) {
  const x = Math.round(Number(n || 0));
  if (!isFinite(x)) return "$0";
  return `$${x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

function safeJsonStringify(obj) {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({ ok: false, error: "JSON stringify failed" });
  }
}

function pick(arr, n) {
  return Array.isArray(arr) ? arr.slice(0, Math.max(0, n)) : [];
}

function truncateWhatsApp(text, max = 1600) {
  const t = String(text || "");
  if (t.length <= max) return t;
  return t.slice(0, max - 10) + "\n…(cortado)";
}

function shortToolResult(result) {
  if (!result || typeof result !== "object") return result;
  const r = { ...result };
  if (Array.isArray(r.items)) {
    r.items_total = r.items.length;
    r.items = r.items.slice(0, 3).map((x) => ({
      name: x.name,
      code: x.code,
      in_stock: x.in_stock,
      price_cop: x.price_cop,
      category: x.category,
    }));
    r.items_preview = true;
  }
  return r;
}

/* =========================
   Odoo JSON-RPC
========================= */
let authCache = { uid: null, at: 0 };
const AUTH_TTL_MS = 10 * 60 * 1000;

async function odooJsonRpc({ service, method, args = [], kwargs = {} }) {
  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_PASS) {
    throw new Error("Missing ODOO_URL / ODOO_DB / ODOO_USER / ODOO_PASS");
  }
  const base = getRpcBase(ODOO_URL);
  const url = `${base}/jsonrpc`;

  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: { service, method, args, kwargs },
    id: Date.now(),
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => null);

  if (!resp.ok) throw new Error(`Odoo HTTP ${resp.status}: ${JSON.stringify(data)?.slice(0, 250)}`);
  if (!data) throw new Error("Odoo returned empty response");
  if (data.error) {
    const msg = data.error?.data?.message || data.error?.message || JSON.stringify(data.error);
    throw new Error(`Odoo JSON-RPC error: ${msg}`);
  }
  return data.result;
}

async function odooAuthenticate() {
  const now = Date.now();
  if (authCache.uid && now - authCache.at < AUTH_TTL_MS) return authCache.uid;

  const uid = await odooJsonRpc({
    service: "common",
    method: "authenticate",
    args: [ODOO_DB, ODOO_USER, ODOO_PASS, {}],
  });

  if (!uid) throw new Error("Auth failed (uid vacío). Revisa DB/usuario/clave.");
  authCache = { uid, at: now };
  return uid;
}

async function odooExecuteKw(model, method, args = [], kwargs = {}) {
  const uid = await odooAuthenticate();
  return await odooJsonRpc({
    service: "object",
    method: "execute_kw",
    args: [ODOO_DB, uid, ODOO_PASS, model, method, args, kwargs],
  });
}

/* =========================
   Odoo Product Helpers
========================= */
async function odooFindCategoryIdByName(name) {
  const domain = [["name", "=", name]];
  const rows = await odooExecuteKw("product.category", "search_read", [domain], {
    fields: ["id", "name"],
    limit: 1,
  });
  return rows?.[0]?.id || null;
}

async function odooSearchProducts({ q, limit = 10 }) {
  const qq = String(q || "").trim();
  if (!qq) return [];
  const domain = ["|", ["name", "ilike", qq], ["default_code", "ilike", qq]];
  const fields = ["id", "display_name", "default_code", "list_price", "categ_id"];
  const products = await odooExecuteKw("product.product", "search_read", [domain], {
    fields,
    limit,
    order: "id desc",
  });
  return Array.isArray(products) ? products : [];
}

async function odooSearchProductsByCategory({ categoryName, q = null, limit = 30 }) {
  const catId = await odooFindCategoryIdByName(categoryName);
  if (!catId) return [];

  const domain = [["categ_id", "=", catId]];
  const qq = String(q || "").trim();
  if (qq) domain.push("|", ["name", "ilike", qq], ["default_code", "ilike", qq]);

  const fields = ["id", "display_name", "default_code", "list_price", "categ_id"];
  const products = await odooExecuteKw("product.product", "search_read", [domain], {
    fields,
    limit,
    order: "id desc",
  });
  return Array.isArray(products) ? products : [];
}

async function odooGetAvailabilityMap(productIds = []) {
  const ids = (productIds || []).filter(Boolean);
  if (!ids.length) return new Map();

  const quants = await odooExecuteKw(
    "stock.quant",
    "search_read",
    [[
      ["product_id", "in", ids],
      ["location_id.usage", "=", "internal"],
    ]],
    { fields: ["product_id", "quantity", "reserved_quantity"], limit: 5000 }
  );

  const map = new Map();
  for (const q of quants || []) {
    const pid = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
    if (!pid) continue;
    const qty = Number(q.quantity || 0);
    const res = Number(q.reserved_quantity || 0);
    const prev = map.get(pid) || 0;
    map.set(pid, prev + (qty - res));
  }
  return map;
}

function getCategoryName(product) {
  const c = product?.categ_id;
  if (Array.isArray(c) && typeof c[1] === "string") return c[1];
  return "";
}

/* =========================
   WhatsApp Sender
========================= */
async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log("❌ Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID");
    return;
  }

  const url = `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: truncateWhatsApp(text) },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  dlog("📤 WhatsApp send response:", resp.status, data);
}

/* =========================
   Sessions + Dedup
========================= */
const sessions = new Map(); // from -> { inputItems: [], lastCategory: string|null }
const seenMsg = new Map();
const SEEN_TTL = 10 * 60 * 1000;

function seenBefore(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  for (const [k, ts] of seenMsg.entries()) {
    if (now - ts > SEEN_TTL) seenMsg.delete(k);
  }
  if (seenMsg.has(msgId)) return true;
  seenMsg.set(msgId, now);
  return false;
}

function getSession(from) {
  if (!sessions.has(from)) sessions.set(from, { inputItems: [], lastCategory: null });
  return sessions.get(from);
}

function resetSession(from) {
  sessions.delete(from);
}

/* =========================
   Prompt
========================= */
const BK_PROMPT = `
Eres BK GLOBAL IA, el asesor comercial y técnico oficial de BK GLOBAL S.A.S (Colombia).
No inventes nada. Usa SOLO la info de herramientas.

Cuando pidan opciones: lista productos con y sin existencia.
- Muestra código (como viene de Odoo) y precio si existe.
- No muestres cantidades de stock: solo ✅ Hay / ❌ No hay.

Si preguntan "¿para cuándo llegan?" y NO hay ETA real:
- di que no hay fecha confirmada en sistema
- ofrece verificar
- ofrece alternativas disponibles si aplica

Respuestas cortas tipo WhatsApp (6-12 líneas).
`;

/* =========================
   Tools (STRICT FIXED)
========================= */
const tools = [
  {
    type: "function",
    name: "list_products_by_category",
    description: "Lista productos por categoría desde Odoo con precio, código y existencia (sin cantidades).",
    parameters: {
      type: "object",
      properties: {
        category_name: { type: "string", description: "Nombre exacto de la categoría en Odoo. Ej: CERRADURAS DIGITALES" },
        query: { type: ["string", "null"], description: "Filtro opcional dentro de la categoría. Si no hay, usa null." },
        availability: { type: "string", enum: ["any", "in_stock", "out_of_stock"], description: "Filtro de existencia" },
        limit: { type: "integer", description: "Máximo de productos a retornar" },
      },
      // ✅ strict=true requiere que required incluya TODAS las keys
      required: ["category_name", "query", "availability", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "search_products",
    description: "Busca productos en todo Odoo por texto, devolviendo precio, código y existencia (sin cantidades).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto de búsqueda" },
        limit: { type: "integer", description: "Máximo de productos a retornar" },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_restock_eta",
    description: "Devuelve ETA si existe; si no, devuelve unknown coherente.",
    parameters: {
      type: "object",
      properties: {
        category_name: { type: ["string", "null"], description: "Categoría (si se sabe) o null" },
        product_code: { type: ["string", "null"], description: "Código Odoo (si se sabe) o null" },
      },
      required: ["category_name", "product_code"],
      additionalProperties: false,
    },
    strict: true,
  },
];

/* =========================
   Tool implementations
========================= */
async function tool_list_products_by_category(args, sess) {
  const category_name = String(args?.category_name || "").trim();
  const query = args?.query === null ? null : String(args?.query || "").trim() || null;
  const availability = String(args?.availability || "any");
  const limit = Number(args?.limit || OPTIONS_LIMIT);

  if (!category_name) return { ok: false, error: "category_name vacío" };

  sess.lastCategory = category_name;

  const products = await odooSearchProductsByCategory({
    categoryName: category_name,
    q: query,
    limit: Math.min(Math.max(limit, 1), 60),
  });

  if (!products.length) return { ok: true, category_name, count: 0, items: [] };

  const ids = products.map((p) => p.id);
  const availMap = await odooGetAvailabilityMap(ids);

  const items = products.map((p) => {
    const available = (availMap.get(p.id) || 0) > 0;
    return {
      id: p.id,
      name: p.display_name,
      code: p.default_code || null,
      price_cop: moneyCOP(p.list_price || 0),
      in_stock: !!available,
      category: getCategoryName(p) || category_name,
    };
  });

  let filtered = items;
  if (availability === "in_stock") filtered = items.filter((x) => x.in_stock);
  if (availability === "out_of_stock") filtered = items.filter((x) => !x.in_stock);

  if (availability === "any") {
    filtered = [...filtered.filter((x) => x.in_stock), ...filtered.filter((x) => !x.in_stock)];
  }

  filtered = pick(filtered, Math.min(Math.max(limit, 1), 60));
  return { ok: true, category_name, count: filtered.length, items: filtered };
}

async function tool_search_products(args, sess) {
  const query = String(args?.query || "").trim();
  const limit = Number(args?.limit || OPTIONS_LIMIT);
  if (!query) return { ok: false, error: "query vacío" };

  const products = await odooSearchProducts({ q: query, limit: Math.min(Math.max(limit, 1), 60) });
  if (!products.length) return { ok: true, count: 0, items: [] };

  const ids = products.map((p) => p.id);
  const availMap = await odooGetAvailabilityMap(ids);

  const items = products.map((p) => {
    const available = (availMap.get(p.id) || 0) > 0;
    return {
      id: p.id,
      name: p.display_name,
      code: p.default_code || null,
      price_cop: moneyCOP(p.list_price || 0),
      in_stock: !!available,
      category: getCategoryName(p) || null,
    };
  });

  const bestCat = items.find((x) => x.category)?.category || null;
  if (bestCat) sess.lastCategory = bestCat;

  const sorted = [...items.filter((x) => x.in_stock), ...items.filter((x) => !x.in_stock)];
  return { ok: true, count: sorted.length, items: pick(sorted, Math.min(Math.max(limit, 1), 60)) };
}

async function tool_get_restock_eta(args, sess) {
  const category_name =
    args?.category_name === null ? null : String(args?.category_name || sess.lastCategory || "").trim() || null;
  const product_code =
    args?.product_code === null ? null : String(args?.product_code || "").trim() || null;

  return {
    ok: true,
    known: false,
    category_name,
    product_code,
    message: "No hay una fecha de llegada registrada en el sistema en este momento. Se puede verificar con compras/proveedor.",
  };
}

async function callToolByName(name, args, sess) {
  if (name === "list_products_by_category") return await tool_list_products_by_category(args, sess);
  if (name === "search_products") return await tool_search_products(args, sess);
  if (name === "get_restock_eta") return await tool_get_restock_eta(args, sess);
  return { ok: false, error: `Tool desconocida: ${name}` };
}

/* =========================
   OpenAI Agent Loop (Responses API)
========================= */
async function runAgent({ from, userText }) {
  if (!openai) return "Hola 👋 En este momento no tengo IA activa (falta OPENAI_API_KEY). ¿Qué producto buscas?";

  const sess = getSession(from);
  sess.inputItems.push({ role: "user", content: userText });
  if (sess.inputItems.length > 40) sess.inputItems = sess.inputItems.slice(-40);

  for (let i = 0; i < MAX_TOOL_LOOPS; i++) {
    dlog(`🧠 Agent loop ${i + 1}/${MAX_TOOL_LOOPS} | model=${OPENAI_MODEL}`);

    let response;
    try {
      response = await openai.responses.create({
        model: OPENAI_MODEL,
        instructions: BK_PROMPT,
        tools,
        input: sess.inputItems,
      });
    } catch (e) {
      console.error("❌ OpenAI responses.create error:", e?.message || e);
      return "Tuve un problema consultando el asistente. ¿Me repites tu mensaje en una línea, por favor?";
    }

    if (Array.isArray(response.output) && response.output.length) {
      sess.inputItems.push(...response.output);
      if (sess.inputItems.length > 60) sess.inputItems = sess.inputItems.slice(-60);
    }

    const toolCalls = (response.output || []).filter((it) => it.type === "function_call");
    if (!toolCalls.length) {
      const out = (response.output_text || "").trim();
      const finalText = out || "Listo 👍 ¿Me confirmas qué estás buscando exactamente para recomendarte opciones?";
      dlog("🤖 Reply to user:", finalText);
      return finalText;
    }

    dlog(
      "🧰 toolCalls:",
      toolCalls.map((t) => ({ name: t.name, arguments: t.arguments }))
    );

    for (const tc of toolCalls) {
      let args = {};
      try {
        args = tc.arguments ? JSON.parse(tc.arguments) : {};
      } catch {
        args = {};
      }

      const result = await callToolByName(tc.name, args, sess);
      dlog("🧰 toolResult:", tc.name, shortToolResult(result));

      sess.inputItems.push({
        type: "function_call_output",
        call_id: tc.call_id,
        output: safeJsonStringify(result),
      });
    }

    if (sess.inputItems.length > 80) sess.inputItems = sess.inputItems.slice(-80);
  }

  const fallback =
    "Estoy revisando opciones, pero necesito un detalle adicional para afinar. ¿Es para interior o exterior y prefieres huella o clave?";
  dlog("🤖 Reply to user (max loops reached):", fallback);
  return fallback;
}

/* =========================
   Basic Intent Helpers
========================= */
function isGreeting(t) {
  const x = norm(t);
  return ["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "hey"].includes(x);
}
function isReset(t) {
  const x = norm(t);
  return ["reiniciar", "reset", "cancelar", "empezar", "borrar"].includes(x);
}

/* =========================
   Routes
========================= */
app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/test-odoo", async (req, res) => {
  try {
    const uid = await odooAuthenticate();
    res.json({ ok: true, uid });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/test-openai", async (req, res) => {
  try {
    if (!openai) return res.json({ ok: false, error: "Missing OPENAI_API_KEY" });
    const r = await openai.responses.create({
      model: OPENAI_MODEL,
      instructions: "Responde únicamente: OK",
      input: "Di OK",
    });
    res.json({ ok: true, output_text: r.output_text });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    const msg = messages[0];
    const from = msg?.from;
    const text = msg?.text?.body || "";
    const msgId = msg?.id;

    if (!from || !text) return;

    if (seenBefore(msgId)) {
      dlog("🔁 Duplicate message ignored:", msgId);
      return;
    }

    dlog("✅ Incoming message:", { from, text, msgId });

    if (isGreeting(text)) {
      resetSession(from);
      const hi =
        "¡Hola! 😄 Soy BK GLOBAL IA. ¿Qué necesitas hoy? (ej: cerradura para puerta principal, GPS, repuesto, tira LED, intercom)";
      dlog("🤖 Reply to user:", hi);
      await sendWhatsAppText(from, hi);
      return;
    }

    if (isReset(text)) {
      resetSession(from);
      const rr = "Listo 👍 Empezamos de nuevo. ¿Qué estás buscando?";
      dlog("🤖 Reply to user:", rr);
      await sendWhatsAppText(from, rr);
      return;
    }

    const reply = await runAgent({ from, userText: text });
    dlog("🤖 Reply to user (final):", reply);
    await sendWhatsAppText(from, reply);
  } catch (err) {
    console.error("❌ Webhook error:", err.message || err);
  }
});

/* =========================
   Start
========================= */
const PORT = process.env.PORT || 3000;

process.on("SIGTERM", () => {
  console.log("👋 SIGTERM recibido, cerrando servidor...");
  process.exit(0);
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
