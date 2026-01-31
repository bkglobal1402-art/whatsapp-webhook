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
  if (!isFinite(x)) return null;
  return `$${x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

function shouldShowPrice(listPrice) {
  const n = Number(listPrice || 0);
  if (!isFinite(n)) return false;
  return n > 10; // evita $0 / $1 placeholder
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
  if (r.description && String(r.description).length > 220) {
    r.description = String(r.description).slice(0, 220) + "…";
  }
  return r;
}

function cleanWhatsAppText(text) {
  let t = String(text || "");
  t = t.replace(/\*\*/g, ""); // quita markdown fuerte
  t = t.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  // elimina duplicación exacta de líneas consecutivas
  const lines = t.split("\n");
  const out = [];
  for (const line of lines) {
    if (out.length && out[out.length - 1].trim() === line.trim()) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

/* =========================
   ✅ Query parsing + scoring
========================= */
function tokenizeQuery(q) {
  const x = norm(q);
  const tokens = x.split(" ").filter(Boolean);
  return tokens;
}

function includesAny(hay, words) {
  const h = norm(hay);
  return words.some((w) => h.includes(norm(w)));
}

function detectIphoneModel(q) {
  const x = norm(q);
  const hasIphone = x.includes("iphone");
  if (!hasIphone) return null;

  const has11 = x.includes(" 11") || x.includes("11 ");
  if (!has11) return "iphone";

  const hasProMax = x.includes("pro max") || x.includes("promax");
  const hasPro = x.includes(" pro");

  if (hasProMax) return "iphone 11 pro max";
  if (hasPro) return "iphone 11 pro";
  return "iphone 11";
}

function scoreProductForQuery({ name, code }, userQuery) {
  const q = norm(userQuery);
  const n = norm(name || "");
  const c = norm(code || "");

  let score = 0;

  const tokens = tokenizeQuery(q);
  let overlap = 0;
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (n.includes(t) || c.includes(t)) overlap += 1;
  }
  score += overlap * 5;

  const wantsDisplay = includesAny(q, ["display", "pantalla", "modulo", "tactil", "táctil"]);
  if (wantsDisplay) {
    if (includesAny(n, ["display", "pantalla"])) score += 40;
    if (includesAny(n, ["tactil", "táctil", "incell", "oled", "lcd"])) score += 10;

    const wantsGlass = includesAny(q, ["vidrio", "visor", "cristal", "glass", "protector", "lente"]);
    const isGlass = includesAny(n, ["vidrio", "visor", "cristal", "glass", "protector", "lente"]);
    if (isGlass && !wantsGlass) score -= 60;
  }

  const qModel = detectIphoneModel(q);
  if (qModel === "iphone 11") {
    if (includesAny(n, ["pro max", "promax"])) score -= 50;
    else if (includesAny(n, [" pro"])) score -= 30;
    else score += 10;
  } else if (qModel === "iphone 11 pro") {
    if (includesAny(n, ["pro max", "promax"])) score -= 30;
    if (includesAny(n, [" iphone 11 "]) && !includesAny(n, [" pro"])) score -= 10;
    if (includesAny(n, [" pro"])) score += 10;
  } else if (qModel === "iphone 11 pro max") {
    if (includesAny(n, ["pro max", "promax"])) score += 15;
    else score -= 10;
  }

  if (q.length >= 4 && n.includes(q)) score += 25;

  return score;
}

/* =========================
   ✅ NEW: stopwords + query simplifier
========================= */
const STOPWORDS_ES = new Set([
  "tienes","tiene","hay","precio","precios","valor","vale","cuanto","cuánto","me","das","dame",
  "de","del","la","el","los","las","un","una","unos","unas","para","por","y","o","en","con",
  "quiero","necesito","busco","favor","porfa","porfavor","hola","buenas","buenos","dias","tardes","no"
]);

function stripPunct(s="") {
  return String(s).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function simplifySearchQuery(raw="") {
  const x = norm(stripPunct(raw));
  if (!x) return "";
  const tokens = x.split(" ").filter(Boolean).filter(t => !STOPWORDS_ES.has(t));

  const keep = [];
  for (const t of tokens) {
    if (t === "11" || t === "12" || t === "13" || t === "14" || t === "15") keep.push(t);
    else if (t.length >= 3) keep.push(t);
  }

  const model = detectIphoneModel(x);
  const wantsDisplay = includesAny(x, ["display","pantalla","modulo","tactil","táctil"]);

  if (model && wantsDisplay) return `display ${model}`;
  if (model) return model;

  return keep.join(" ").trim();
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
  const fields = ["id", "display_name", "default_code", "list_price", "categ_id", "product_tmpl_id"];
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

  const fields = ["id", "display_name", "default_code", "list_price", "categ_id", "product_tmpl_id"];
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
   ✅ FIX: Template details (safe fields)
========================= */
async function odooGetTemplateDetails(tmplId) {
  if (!tmplId) return null;

  const tryFields = async (fields) => {
    try {
      const tmpl = await odooExecuteKw("product.template", "read", [[tmplId]], { fields });
      const row = Array.isArray(tmpl) ? tmpl[0] : null;
      return row || null;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("Invalid field")) return null;
      throw e;
    }
  };

  let row = await tryFields(["name", "description_sale", "website_description"]);
  if (!row) row = await tryFields(["name", "description_sale", "description"]);
  if (!row) row = await tryFields(["name", "description_sale"]);
  if (!row) row = await tryFields(["name"]);
  if (!row) return null;

  const descCandidates = [row.website_description, row.description_sale, row.description].filter(
    (x) => typeof x === "string" && x.trim()
  );
  const description = descCandidates.length ? descCandidates[0].trim() : null;

  let attrs = [];
  try {
    const lines = await odooExecuteKw(
      "product.template.attribute.line",
      "search_read",
      [[["product_tmpl_id", "=", tmplId]]],
      { fields: ["attribute_id", "value_ids"], limit: 100 }
    );

    for (const ln of lines || []) {
      const attrName = Array.isArray(ln.attribute_id) ? ln.attribute_id[1] : null;
      const valueIds = Array.isArray(ln.value_ids) ? ln.value_ids : [];
      let values = [];
      if (valueIds.length) {
        const vals = await odooExecuteKw("product.attribute.value", "read", [valueIds], { fields: ["name"] });
        values = (vals || []).map((v) => v.name).filter(Boolean);
      }
      if (attrName) attrs.push({ name: attrName, values });
    }
  } catch {
    attrs = [];
  }

  return { name: row.name || null, description, attributes: attrs };
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
    text: { body: truncateWhatsApp(cleanWhatsAppText(text)) },
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
const sessions = new Map();
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
   Prompt (asesor) - Mejorado
========================= */
const BK_PROMPT = `
Eres BK GLOBAL IA, asesor comercial y técnico de BK GLOBAL (Colombia).
No inventes nada. Usa SOLO lo que llega de herramientas.

OBJETIVO:
- Encontrar el producto correcto en Odoo y dar precio + disponibilidad de forma directa y útil.

REGLAS OBLIGATORIAS:
1) Si el cliente pide “precio”, responde con el precio de CADA opción válida encontrada (siempre que venga real).
2) Si el cliente pide “display / pantalla / módulo”, prioriza productos que contengan “DISPLAY” o “PANTALLA” (y si aplica “TÁCTIL”).
   - DESCARTA “VIDRIO”, “VISOR”, “CRISTAL”, “GLASS”, “PROTECTOR”, “LENTE” a menos que el cliente lo pida explícitamente.
3) “iPhone 11” NO es lo mismo que “iPhone 11 Pro” ni “Pro Max”.
   - Solo ofrece Pro/Pro Max si el cliente lo menciona o si NO existe el modelo exacto.
4) Si hay varias opciones del mismo producto (ej: GX/JK, calidades), muestra TODAS en una sola respuesta con precio y stock.
   - NO obligues a elegir antes de ver precios.
5) Stock: solo ✅ Hay / ❌ No hay. Nunca cantidades.
6) Precio: solo si viene real; si no hay precio real, dilo.
7) Siempre consulta Odoo (tools) cuando pidan opciones, precio, disponibilidad o características.
8) Si piden “características”, usa get_product_details.

FORMATO WhatsApp:
- Corto, claro, sin markdown.
- Muestra: Código, Nombre, Precio, Stock.
`;

/* =========================
   Tools (strict OK)
========================= */
const tools = [
  {
    type: "function",
    name: "list_products_by_category",
    description: "Lista productos por categoría desde Odoo con precio, código y existencia (sin cantidades).",
    parameters: {
      type: "object",
      properties: {
        category_name: { type: "string", description: "Nombre exacto de la categoría en Odoo." },
        query: { type: ["string", "null"], description: "Filtro opcional dentro de la categoría. Si no hay, null." },
        availability: { type: "string", enum: ["any", "in_stock", "out_of_stock"], description: "Filtro de existencia" },
        limit: { type: "integer", description: "Máximo de productos a retornar" },
      },
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
        category_name: { type: ["string", "null"], description: "Categoría o null" },
        product_code: { type: ["string", "null"], description: "Código Odoo o null" },
      },
      required: ["category_name", "product_code"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "get_product_details",
    description: "Obtiene características reales del producto desde Odoo (descripción/atributos) usando código o texto.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Código (ej CD104) o texto del producto" },
        limit: { type: "integer", description: "Máximo coincidencias (normal 3-5)" },
      },
      required: ["query", "limit"],
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

  const fetchLimit = Math.min(Math.max(limit * 5, 20), 60);

  const products = await odooSearchProductsByCategory({
    categoryName: category_name,
    q: query,
    limit: fetchLimit,
  });

  if (!products.length) return { ok: true, category_name, count: 0, items: [] };

  const ids = products.map((p) => p.id);
  const availMap = await odooGetAvailabilityMap(ids);

  const items = products.map((p) => {
    const available = (availMap.get(p.id) || 0) > 0;
    const priceOk = shouldShowPrice(p.list_price);
    return {
      id: p.id,
      name: p.display_name,
      code: p.default_code || null,
      price_cop: priceOk ? moneyCOP(p.list_price || 0) : null,
      in_stock: !!available,
      category: getCategoryName(p) || category_name,
      _score: query ? scoreProductForQuery({ name: p.display_name, code: p.default_code }, query) : 0,
    };
  });

  let filtered = items;
  if (availability === "in_stock") filtered = items.filter((x) => x.in_stock);
  if (availability === "out_of_stock") filtered = items.filter((x) => !x.in_stock);

  filtered.sort((a, b) => {
    const sa = Number(a._score || 0);
    const sb = Number(b._score || 0);
    if (sb !== sa) return sb - sa;
    if (b.in_stock !== a.in_stock) return (b.in_stock ? 1 : 0) - (a.in_stock ? 1 : 0);
    return 0;
  });

  if (availability === "any") {
    const inS = filtered.filter((x) => x.in_stock);
    const outS = filtered.filter((x) => !x.in_stock);
    filtered = [...inS, ...outS];
  }

  filtered = pick(filtered, Math.min(Math.max(limit, 1), 60)).map((x) => {
    const y = { ...x };
    delete y._score;
    return y;
  });

  return { ok: true, category_name, count: filtered.length, items: filtered };
}

async function tool_search_products(args, sess) {
  const rawQuery = String(args?.query || "").trim();
  const limit = Number(args?.limit || OPTIONS_LIMIT);
  if (!rawQuery) return { ok: false, error: "query vacío" };

  const q1 = simplifySearchQuery(rawQuery);

  const qNorm = norm(stripPunct(rawQuery));
  const model = detectIphoneModel(qNorm);
  const wantsDisplay = includesAny(qNorm, ["display","pantalla","modulo","tactil","táctil"]);
  const wantsGlass = includesAny(qNorm, ["vidrio","visor","cristal","glass","protector","lente"]);

  const queries = [];
  if (q1) queries.push(q1);
  if (model && wantsDisplay) queries.push(`display ${model}`);
  if (model && !wantsDisplay) queries.push(model);
  if (wantsDisplay && !model) queries.push("display");

  const uniqQueries = [...new Set(queries.filter(Boolean))].slice(0, 3);

  const fetchLimit = Math.min(Math.max(limit * 8, 40), 80);
  const merged = new Map();

  for (const q of uniqQueries) {
    const products = await odooSearchProducts({ q, limit: fetchLimit });
    for (const p of products || []) merged.set(p.id, p);
  }

  const productsAll = Array.from(merged.values());
  if (!productsAll.length) return { ok: true, count: 0, items: [] };

  const ids = productsAll.map((p) => p.id);
  const availMap = await odooGetAvailabilityMap(ids);

  const items = productsAll.map((p) => {
    const available = (availMap.get(p.id) || 0) > 0;
    const priceOk = shouldShowPrice(p.list_price);
    const product_tmpl_id = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;

    let score = scoreProductForQuery(
      { name: p.display_name, code: p.default_code },
      rawQuery
    );

    const n = norm(p.display_name || "");
    if (wantsDisplay) {
      if (includesAny(n, ["display", "pantalla"])) score += 50;
      if (includesAny(n, ["tactil", "táctil"])) score += 15;

      const isGlass = includesAny(n, ["vidrio","visor","cristal","glass","protector","lente"]);
      if (isGlass && !wantsGlass) score -= 120;
    }

    if (model === "iphone 11") {
      if (includesAny(n, ["pro max", "promax"])) score -= 120;
      else if (includesAny(n, [" pro"])) score -= 80;
      else score += 20;
    }

    return {
      id: p.id,
      name: p.display_name,
      code: p.default_code || null,
      price_cop: priceOk ? moneyCOP(p.list_price || 0) : null,
      in_stock: !!available,
      category: getCategoryName(p) || null,
      product_tmpl_id,
      _score: score,
    };
  });

  const bestCat = items.find((x) => x.category)?.category || null;
  if (bestCat) sess.lastCategory = bestCat;

  items.sort((a, b) => {
    const sa = Number(a._score || 0);
    const sb = Number(b._score || 0);
    if (sb !== sa) return sb - sa;
    if (b.in_stock !== a.in_stock) return (b.in_stock ? 1 : 0) - (a.in_stock ? 1 : 0);
    return 0;
  });

  const sorted = [...items.filter((x) => x.in_stock), ...items.filter((x) => !x.in_stock)];

  const finalItems = pick(sorted, Math.min(Math.max(limit, 1), 60)).map((x) => {
    const y = { ...x };
    delete y._score;
    return y;
  });

  return { ok: true, count: finalItems.length, items: finalItems };
}

async function tool_get_restock_eta(args, sess) {
  const category_name =
    args?.category_name === null ? null : String(args?.category_name || sess.lastCategory || "").trim() || null;
  const product_code = args?.product_code === null ? null : String(args?.product_code || "").trim() || null;

  return {
    ok: true,
    known: false,
    category_name,
    product_code,
    message: "No hay una fecha de llegada registrada en el sistema en este momento. Se puede verificar con compras/proveedor.",
  };
}

async function tool_get_product_details(args, sess) {
  const query = String(args?.query || "").trim();
  const limit = Number(args?.limit || 3);
  if (!query) return { ok: false, error: "query vacío" };

  const products = await odooSearchProducts({ q: query, limit: Math.min(Math.max(limit * 4, 6), 12) });
  if (!products.length) {
    return { ok: true, found: 0, items: [], note: "No se encontró el producto en Odoo con ese texto/código." };
  }

  const ranked = products
    .map((p) => ({
      p,
      score: scoreProductForQuery({ name: p.display_name, code: p.default_code }, query),
    }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);

  const ids = ranked.map((p) => p.id);
  const availMap = await odooGetAvailabilityMap(ids);

  const items = [];
  for (const p of ranked.slice(0, 3)) {
    const available = (availMap.get(p.id) || 0) > 0;
    const tmplId = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
    const tmpl = await odooGetTemplateDetails(tmplId);

    const priceOk = shouldShowPrice(p.list_price);
    items.push({
      name: p.display_name,
      code: p.default_code || null,
      in_stock: !!available,
      price_cop: priceOk ? moneyCOP(p.list_price || 0) : null,
      category: getCategoryName(p) || null,
      description: tmpl?.description || null,
      attributes: tmpl?.attributes || [],
    });
  }

  const bestCat = items.find((x) => x.category)?.category || null;
  if (bestCat) sess.lastCategory = bestCat;

  return { ok: true, found: ranked.length, items };
}

async function callToolByName(name, args, sess) {
  if (name === "list_products_by_category") return await tool_list_products_by_category(args, sess);
  if (name === "search_products") return await tool_search_products(args, sess);
  if (name === "get_restock_eta") return await tool_get_restock_eta(args, sess);
  if (name === "get_product_details") return await tool_get_product_details(args, sess);
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
      const out = cleanWhatsAppText((response.output_text || "").trim());
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
    "Estoy revisando opciones, pero necesito un detalle adicional para afinar. ¿Me confirmas el modelo exacto y si lo quieres con táctil?";
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
