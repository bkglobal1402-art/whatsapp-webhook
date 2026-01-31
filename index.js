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
const MAX_TOOL_LOOPS = Number(process.env.MAX_TOOL_LOOPS || 5);
const DEBUG = String(process.env.DEBUG || "true").toLowerCase() !== "false";

function dlog(...args) {
  if (DEBUG) console.log(...args);
}

if (!OPENAI_API_KEY) {
  console.warn("⚠️ Falta OPENAI_API_KEY. El bot seguirá, pero sin IA no hará tool-calling.");
}
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

/* =========================
   CONFIG: links / pagos
========================= */
const LOCKS_FB_SOURCE =
  "https://www.facebook.com/bkglobal.com.co/posts/pfbid0v6LpXxdHUky7gH1KZksJowQcM3HGZ1j59vDdAS78s87yXXPj4kPYuzyxrATTWKxql";

const PAY_WOMPI_URL = "https://checkout.wompi.co/l/VPOS_6LIOMn";
const PAY_BANCOLOMBIA = {
  bank: "Bancolombia",
  type: "Ahorros",
  account: "23600005240",
  nit: "901800875",
  name: "BK GLOBAL SAS",
};

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

function stripPunct(s = "") {
  return String(s)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
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

function truncateWhatsApp(text, max = 1600) {
  const t = String(text || "");
  if (t.length <= max) return t;
  return t.slice(0, max - 10) + "\n…(cortado)";
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

function includesAny(hay, words) {
  const h = norm(hay);
  return words.some((w) => h.includes(norm(w)));
}

/* =========================
   ✅ Query simplifier
========================= */
const STOPWORDS_ES = new Set([
  "tienes",
  "tiene",
  "hay",
  "precio",
  "precios",
  "valor",
  "vale",
  "cuanto",
  "cuánto",
  "me",
  "das",
  "dame",
  "de",
  "del",
  "la",
  "el",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "para",
  "por",
  "y",
  "o",
  "en",
  "con",
  "quiero",
  "necesito",
  "busco",
  "favor",
  "porfa",
  "porfavor",
  "hola",
  "buenas",
  "buenos",
  "dias",
  "tardes",
  "no",
]);

function simplifySearchQuery(raw = "") {
  const x = norm(stripPunct(raw));
  if (!x) return "";
  const tokens = x
    .split(" ")
    .filter(Boolean)
    .filter((t) => !STOPWORDS_ES.has(t));
  return tokens.join(" ").trim();
}

/* =========================
   ✅ Scoring
========================= */
function tokenizeQuery(q) {
  const x = norm(q);
  return x.split(" ").filter(Boolean);
}

function detectIphoneModel(q) {
  const x = norm(q);
  if (!x.includes("iphone")) return null;
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
  score += overlap * 6;

  const wantsDisplay = includesAny(q, ["display", "pantalla", "modulo", "tactil", "táctil"]);
  if (wantsDisplay) {
    if (includesAny(n, ["display", "pantalla"])) score += 55;
    if (includesAny(n, ["tactil", "táctil", "incell", "oled", "lcd"])) score += 15;

    const wantsGlass = includesAny(q, ["vidrio", "visor", "cristal", "glass", "protector", "lente"]);
    const isGlass = includesAny(n, ["vidrio", "visor", "cristal", "glass", "protector", "lente"]);
    if (isGlass && !wantsGlass) score -= 120;
  }

  const qModel = detectIphoneModel(q);
  if (qModel === "iphone 11") {
    if (includesAny(n, ["pro max", "promax"])) score -= 120;
    else if (includesAny(n, [" pro"])) score -= 80;
    else score += 15;
  }

  if (q.length >= 4 && n.includes(q)) score += 25;
  return score;
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
    [[["product_id", "in", ids], ["location_id.usage", "=", "internal"]]],
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
   Template details
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

  return { name: row.name || null, description };
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
   ✅ WhatsApp Media (images) -> base64 data URL
========================= */
async function fetchWhatsAppImageAsDataUrl(mediaId) {
  if (!WHATSAPP_TOKEN) throw new Error("Missing WHATSAPP_TOKEN");
  if (!mediaId) throw new Error("Missing mediaId");

  const metaUrl = `https://graph.facebook.com/v22.0/${mediaId}?fields=url,mime_type`;
  const metaResp = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const meta = await metaResp.json().catch(() => null);
  if (!metaResp.ok || !meta?.url) {
    throw new Error(`Failed to get media url: ${metaResp.status} ${JSON.stringify(meta)?.slice(0, 200)}`);
  }

  const binResp = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!binResp.ok) throw new Error(`Failed to download media: ${binResp.status}`);
  const arrayBuf = await binResp.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  const mime = meta.mime_type || "image/jpeg";
  const b64 = buf.toString("base64");
  return `data:${mime};base64,${b64}`;
}

/* =========================
   ✅ Vision extractor (TV label)
   - Extrae MARCA + MODELO y texto clave
========================= */
async function extractTvLabelInfo(imageDataUrl) {
  if (!openai) return { ok: false, brand: null, model: null, raw: null };
  try {
    const r = await openai.responses.create({
      model: OPENAI_MODEL,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Lee la etiqueta del TV en la imagen y devuelve SOLO JSON con: " +
                '{ "brand": "...", "model": "...", "model_alt": "...", "raw": "..." }. ' +
                "brand = marca (LG, Samsung, etc). model = modelo principal (ej: 55LA8600). " +
                "model_alt = si aparece otro código útil. raw = líneas relevantes. Si no se ve, usa null.",
            },
            { type: "input_image", image_url: imageDataUrl },
          ],
        },
      ],
    });

    const txt = (r.output_text || "").trim();
    // intenta parsear json, si no, fallback
    let obj = null;
    try {
      obj = JSON.parse(txt);
    } catch {
      // fallback simple: buscar LG y patron modelo
      const raw = txt;
      const m = raw.match(/([A-Z]{1,3})\s*([0-9]{2}[A-Z]{1,3}[0-9]{2,4})/);
      obj = {
        brand: raw.includes("LG") ? "LG" : null,
        model: m ? m[2] : null,
        model_alt: null,
        raw,
      };
    }
    return { ok: true, brand: obj.brand || null, model: obj.model || null, model_alt: obj.model_alt || null, raw: obj.raw || null };
  } catch (e) {
    console.error("❌ extractTvLabelInfo error:", e?.message || e);
    return { ok: false, brand: null, model: null, model_alt: null, raw: null };
  }
}

/* =========================
   Sessions + Dedup + CART
========================= */
const sessions = new Map(); // from -> session
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
  if (!sessions.has(from)) {
    sessions.set(from, {
      inputItems: [],
      lastCategory: null,
      lastOptions: [], // últimas opciones devueltas por tools
      cart: [], // {code,name,qty,price_cop,in_stock}
      lead: { lockReferral: false, askedTech: false, pricingTier: null, sourceUrl: null },
    });
  }
  return sessions.get(from);
}

function resetSession(from) {
  sessions.delete(from);
}

/* =========================
   ✅ Cart helpers
========================= */
function cartAddItem(sess, item, qty = 1) {
  const q = Math.max(1, Number(qty || 1));
  const code = item?.code || null;
  if (!code) return false;

  const existing = sess.cart.find((x) => x.code === code);
  if (existing) existing.qty += q;
  else sess.cart.push({ code, name: item.name || "", qty: q, price_cop: item.price_cop || null, in_stock: !!item.in_stock });
  return true;
}

function cartTotalCOP(sess) {
  let total = 0;
  for (const it of sess.cart) {
    const p = Number(String(it.price_cop || "").replace(/\./g, "").replace(/\$/g, "")) || 0;
    total += p * (Number(it.qty) || 1);
  }
  return total;
}

function cartSummaryText(sess) {
  if (!sess.cart.length) return "Tu carrito está vacío por ahora.";
  let out = "Resumen de tu pedido:\n";
  let i = 1;
  for (const it of sess.cart) {
    const stock = it.in_stock ? "✅ Hay" : "❌ No hay";
    const price = it.price_cop ? it.price_cop : "Precio: no disponible";
    out += `${i}) [${it.code}] ${it.name} — ${price} — x${it.qty} — ${stock}\n`;
    i++;
  }
  const total = cartTotalCOP(sess);
  if (total > 0) out += `\nTotal: ${moneyCOP(total)}`;
  return out.trim();
}

function isAddMoreIntent(text) {
  const x = norm(text);
  return (
    x.startsWith("espera tambien") ||
    x.startsWith("espera también") ||
    x.includes("tambien necesito") ||
    x.includes("también necesito") ||
    x.includes("ademas necesito") ||
    x.includes("además necesito") ||
    x.includes("agrega") ||
    x.includes("añade") ||
    x.includes("sumale") ||
    x.includes("súmale")
  );
}

/* =========================
   ✅ PROMPT (reglas + códigos + carrito + no mezclar categorías)
========================= */
const BK_PROMPT = `
Eres BK GLOBAL IA, asesor comercial y técnico de BK GLOBAL (Colombia).
No inventes nada. Usa SOLO lo que llega de herramientas (tools) para productos/precios/stock.

FORMATO OBLIGATORIO DE OPCIONES (siempre):
- Muestra SIEMPRE: [CODIGO] NOMBRE — PRECIO — ✅ Hay / ❌ No hay
- Nunca muestres opciones sin código.

CARRITO:
- Si el cliente confirma algo (por código, por “la primera”, “esa”, “me llevo X”), debes usar tools de carrito.
- Si el cliente dice “espera también necesito…”, NO cierres: agrega al carrito y luego muestra resumen + total.

IMÁGENES / ETIQUETAS (TIRAS LED):
- Si llega foto de etiqueta, usa la información extraída (marca + modelo) y cotiza.
- Si no se ve el modelo, pide otra foto más cerca o que escriba el modelo.

REGLAS POR CATEGORÍA:
A) REPUESTOS CELULARES / TABLETS:
- Pide modelo exacto + repuesto exacto si no está claro.
B) TIRAS LED:
- Requiere modelo exacto del TV (de etiqueta). Cotiza con ese modelo.
C) REPUESTOS VIDEOJUEGOS:
- Pide consola exacta + repuesto (o código).
D) GPS (solo B2B):
- Antes de cotizar: “¿Eres empresa de rastreo o técnico instalador?”
- Si no, explica que GPS es solo para esos perfiles.
E) CERRADURAS DIGITALES:
- Si piden cerradura, NO ofrezcas intercomunicadores.
- Puedes asesorar con 3-8 opciones.
F) INTERCOMUNICADORES:
- Si piden intercom, NO ofrezcas cerraduras.

REGLAS DISPLAY/PANTALLA:
- Si piden display/pantalla, prioriza DISPLAY/PANTALLA y descarta VIDRIO/VISOR/CRISTAL/GLASS/PROTECTOR/LENTE salvo que lo pidan.

CIERRE DE COMPRA (cuando el cliente diga “proceder”, “comprar”, “confirmo”, o ya haya carrito):
- Ofrece SIEMPRE:
  1) Contraentrega: paga la totalidad + envío al recibir en la puerta.
  2) Wompi: ${PAY_WOMPI_URL}
  3) Transferencia Bancolombia: Bancolombia Ahorros ${PAY_BANCOLOMBIA.account} — NIT ${PAY_BANCOLOMBIA.nit} — ${PAY_BANCOLOMBIA.name}
- Luego pide: nombre, ciudad, dirección, barrio y teléfono.

NOTA: Si hay “lead de cerraduras” y aún no se sabe si es técnico, pregunta primero:
“¿Eres técnico instalador?” para definir precio punto o cliente final.
`;

/* =========================
   Tools
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
    name: "get_product_details",
    description: "Obtiene características reales del producto desde Odoo (descripción) usando código o texto.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Código o texto del producto" },
        limit: { type: "integer", description: "Máximo coincidencias (normal 3-5)" },
      },
      required: ["query", "limit"],
      additionalProperties: false,
    },
    strict: true,
  },

  // ✅ Carrito
  {
    type: "function",
    name: "cart_add_last_option",
    description: "Agrega al carrito una opción de la última lista mostrada (por posición 1..N).",
    parameters: {
      type: "object",
      properties: {
        position: { type: "integer", description: "Posición en la lista (1 = primera)" },
        qty: { type: "integer", description: "Cantidad" },
      },
      required: ["position", "qty"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "cart_add_by_code",
    description: "Agrega al carrito por código exacto (si existe en últimas opciones, lo usa; si no, busca en Odoo).",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "Código del producto (default_code)" },
        qty: { type: "integer", description: "Cantidad" },
      },
      required: ["code", "qty"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    type: "function",
    name: "cart_get_summary",
    description: "Devuelve resumen del carrito y total.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "cart_clear",
    description: "Vacía el carrito.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    type: "function",
    name: "set_pricing_tier",
    description: "Guarda si el cliente es técnico (precio punto) o cliente final.",
    parameters: {
      type: "object",
      properties: { tier: { type: "string", enum: ["technician", "final"] } },
      required: ["tier"],
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

  const fetchLimit = Math.min(Math.max(limit * 5, 20), 80);

  const products = await odooSearchProductsByCategory({
    categoryName: category_name,
    q: query,
    limit: fetchLimit,
  });

  if (!products.length) {
    sess.lastOptions = [];
    return { ok: true, category_name, count: 0, items: [] };
  }

  const ids = products.map((p) => p.id);
  const availMap = await odooGetAvailabilityMap(ids);

  const items = products
    .map((p) => {
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
    })
    .filter((x) => x.code); // ✅ solo items con código

  if (!items.length) {
    sess.lastOptions = [];
    return { ok: true, category_name, count: 0, items: [] };
  }

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

  filtered = filtered.slice(0, Math.min(Math.max(limit, 1), 30)).map((x) => {
    const y = { ...x };
    delete y._score;
    return y;
  });

  sess.lastOptions = filtered; // ✅ para "la primera"
  return { ok: true, category_name, count: filtered.length, items: filtered };
}

async function tool_search_products(args, sess) {
  const rawQuery = String(args?.query || "").trim();
  const limit = Number(args?.limit || OPTIONS_LIMIT);
  if (!rawQuery) return { ok: false, error: "query vacío" };

  const qRaw = rawQuery;
  const qNorm = norm(stripPunct(rawQuery));
  const qSimple = simplifySearchQuery(rawQuery);

  const queries = [qRaw, qSimple, qNorm].filter(Boolean);
  const tokens = qNorm.split(" ");
  for (const t of tokens) {
    if (/^[a-z]\d{2,3}[a-z]$/.test(t)) {
      queries.push(t);
      queries.push(t.replace(/([a-z])(\d+)/, "$1 $2")); // a10s -> a 10s
      queries.push(t.replace(/(\d+)([a-z])$/, "$1 $2")); // 10s -> 10 s
    }
  }

  const uniqQueries = [...new Set(queries.map((x) => x.trim()).filter(Boolean))].slice(0, 6);
  const fetchLimit = Math.min(Math.max(limit * 10, 60), 150);

  const merged = new Map();
  for (const q of uniqQueries) {
    const products = await odooSearchProducts({ q, limit: fetchLimit });
    for (const p of products || []) merged.set(p.id, p);
  }

  const productsAll = Array.from(merged.values());
  if (!productsAll.length) {
    sess.lastOptions = [];
    return { ok: true, count: 0, items: [] };
  }

  const ids = productsAll.map((p) => p.id);
  const availMap = await odooGetAvailabilityMap(ids);

  const items = productsAll
    .map((p) => {
      const available = (availMap.get(p.id) || 0) > 0;
      const priceOk = shouldShowPrice(p.list_price);
      const score = scoreProductForQuery({ name: p.display_name, code: p.default_code }, qRaw);

      return {
        id: p.id,
        name: p.display_name,
        code: p.default_code || null,
        price_cop: priceOk ? moneyCOP(p.list_price || 0) : null,
        in_stock: !!available,
        category: getCategoryName(p) || null,
        _score: score,
      };
    })
    .filter((x) => x.code); // ✅ solo items con código

  if (!items.length) {
    sess.lastOptions = [];
    return { ok: true, count: 0, items: [] };
  }

  items.sort((a, b) => {
    const sa = Number(a._score || 0);
    const sb = Number(b._score || 0);
    if (sb !== sa) return sb - sa;
    if (b.in_stock !== a.in_stock) return (b.in_stock ? 1 : 0) - (a.in_stock ? 1 : 0);
    return 0;
  });

  const sorted = [...items.filter((x) => x.in_stock), ...items.filter((x) => !x.in_stock)]
    .slice(0, Math.min(Math.max(limit, 1), 30))
    .map((x) => {
      const y = { ...x };
      delete y._score;
      return y;
    });

  sess.lastOptions = sorted;
  const bestCat = sorted.find((x) => x.category)?.category || null;
  if (bestCat) sess.lastCategory = bestCat;

  return { ok: true, count: sorted.length, items: sorted };
}

async function tool_get_product_details(args, sess) {
  const raw = String(args?.query || "").trim();
  const limit = Number(args?.limit || 3);
  if (!raw) return { ok: false, error: "query vacío" };

  const q1 = raw;
  const q2 = norm(stripPunct(raw));
  const q3 = simplifySearchQuery(raw);
  const queries = [...new Set([q1, q2, q3].filter(Boolean))].slice(0, 3);

  const merged = new Map();
  for (const q of queries) {
    const products = await odooSearchProducts({ q, limit: 30 });
    for (const p of products || []) merged.set(p.id, p);
  }
  const productsAll = Array.from(merged.values());
  if (!productsAll.length) {
    return { ok: true, found: 0, items: [], note: "No se encontró el producto en Odoo con ese texto/código." };
  }

  const ranked = productsAll
    .map((p) => ({ p, score: scoreProductForQuery({ name: p.display_name, code: p.default_code }, raw) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);

  const ids = ranked.map((p) => p.id);
  const availMap = await odooGetAvailabilityMap(ids);

  const items = [];
  for (const p of ranked.slice(0, Math.min(limit, ranked.length))) {
    const available = (availMap.get(p.id) || 0) > 0;
    const tmplId = Array.isArray(p.product_tmpl_id) ? p.product_tmpl_id[0] : p.product_tmpl_id;
    const tmpl = await odooGetTemplateDetails(tmplId);

    const priceOk = shouldShowPrice(p.list_price);
    if (!p.default_code) continue;

    items.push({
      name: p.display_name,
      code: p.default_code || null,
      in_stock: !!available,
      price_cop: priceOk ? moneyCOP(p.list_price || 0) : null,
      category: getCategoryName(p) || null,
      description: tmpl?.description || null,
    });
  }

  const bestCat = items.find((x) => x.category)?.category || null;
  if (bestCat) sess.lastCategory = bestCat;

  return { ok: true, found: ranked.length, items };
}

/* =========================
   ✅ Cart tools
========================= */
async function tool_cart_add_last_option(args, sess) {
  const pos = Number(args?.position || 0);
  const qty = Number(args?.qty || 1);
  if (!pos || pos < 1) return { ok: false, error: "position inválida" };

  const opt = (sess.lastOptions || [])[pos - 1];
  if (!opt) return { ok: false, error: "No existe esa opción en la última lista." };

  const ok = cartAddItem(sess, opt, qty);
  if (!ok) return { ok: false, error: "No se pudo agregar (sin código)." };

  return { ok: true, cart_count: sess.cart.length, summary: cartSummaryText(sess) };
}

async function tool_cart_add_by_code(args, sess) {
  const code = String(args?.code || "").trim();
  const qty = Number(args?.qty || 1);
  if (!code) return { ok: false, error: "code vacío" };

  // 1) si está en lastOptions
  const found = (sess.lastOptions || []).find((x) => norm(x.code) === norm(code));
  if (found) {
    cartAddItem(sess, found, qty);
    return { ok: true, cart_count: sess.cart.length, summary: cartSummaryText(sess) };
  }

  // 2) buscar en Odoo por default_code exacto
  const products = await odooExecuteKw(
    "product.product",
    "search_read",
    [[["default_code", "=", code]]],
    { fields: ["id", "display_name", "default_code", "list_price", "categ_id"], limit: 1 }
  );

  const p = Array.isArray(products) ? products[0] : null;
  if (!p) return { ok: false, error: "No encontré ese código en Odoo." };

  const availMap = await odooGetAvailabilityMap([p.id]);
  const available = (availMap.get(p.id) || 0) > 0;

  const item = {
    id: p.id,
    name: p.display_name,
    code: p.default_code,
    price_cop: shouldShowPrice(p.list_price) ? moneyCOP(p.list_price || 0) : null,
    in_stock: !!available,
    category: getCategoryName(p) || null,
  };
  cartAddItem(sess, item, qty);

  return { ok: true, cart_count: sess.cart.length, summary: cartSummaryText(sess) };
}

async function tool_cart_get_summary(_args, sess) {
  return { ok: true, cart_count: sess.cart.length, summary: cartSummaryText(sess) };
}

async function tool_cart_clear(_args, sess) {
  sess.cart = [];
  return { ok: true, cart_count: 0, summary: "Listo 👍 Carrito vaciado." };
}

async function tool_set_pricing_tier(args, sess) {
  const tier = String(args?.tier || "");
  if (!["technician", "final"].includes(tier)) return { ok: false, error: "tier inválido" };
  sess.lead.pricingTier = tier;
  sess.lead.askedTech = true;
  return { ok: true, pricing_tier: tier };
}

async function callToolByName(name, args, sess) {
  if (name === "list_products_by_category") return await tool_list_products_by_category(args, sess);
  if (name === "search_products") return await tool_search_products(args, sess);
  if (name === "get_product_details") return await tool_get_product_details(args, sess);

  if (name === "cart_add_last_option") return await tool_cart_add_last_option(args, sess);
  if (name === "cart_add_by_code") return await tool_cart_add_by_code(args, sess);
  if (name === "cart_get_summary") return await tool_cart_get_summary(args, sess);
  if (name === "cart_clear") return await tool_cart_clear(args, sess);
  if (name === "set_pricing_tier") return await tool_set_pricing_tier(args, sess);

  return { ok: false, error: `Tool desconocida: ${name}` };
}

/* =========================
   ✅ OpenAI Agent Loop (Responses API)
========================= */
async function runAgent({ from, userText = "", imageDataUrl = null, imageHint = "" }) {
  if (!openai) return "Hola 👋 En este momento no tengo IA activa (falta OPENAI_API_KEY). ¿Qué producto buscas?";

  const sess = getSession(from);

  // ✅ Inyectar nota de referral (solo una vez)
  if (sess.lead.lockReferral && !sess.lead._noteInjected) {
    sess.inputItems.push({
      role: "user",
      content:
        "NOTA INTERNA: El cliente llegó desde un enlace/anuncio de CERRADURAS. Antes de dar precio de cerraduras, pregunta: “¿Eres técnico instalador?” para definir precio punto vs cliente final.",
    });
    sess.lead._noteInjected = true;
  }

  // input item con imagen o texto
  if (imageDataUrl) {
    const txt = (userText || "").trim() || "Imagen enviada por el cliente.";
    const hint = imageHint ? `\nContexto: ${imageHint}` : "";
    sess.inputItems.push({
      role: "user",
      content: [
        { type: "input_text", text: `${txt}${hint}` },
        { type: "input_image", image_url: imageDataUrl },
      ],
    });
  } else {
    sess.inputItems.push({ role: "user", content: String(userText || "") });
  }

  if (sess.inputItems.length > 50) sess.inputItems = sess.inputItems.slice(-50);

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
      if (sess.inputItems.length > 80) sess.inputItems = sess.inputItems.slice(-80);
    }

    const toolCalls = (response.output || []).filter((it) => it.type === "function_call");
    if (!toolCalls.length) {
      const out = cleanWhatsAppText((response.output_text || "").trim());
      const finalText = out || "Listo 👍 ¿Qué repuesto necesitas y para qué modelo?";
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
      dlog("🧰 toolResult:", tc.name, result?.summary ? { ...result, summary: String(result.summary).slice(0, 300) } : result);

      sess.inputItems.push({
        type: "function_call_output",
        call_id: tc.call_id,
        output: safeJsonStringify(result),
      });
    }

    if (sess.inputItems.length > 110) sess.inputItems = sess.inputItems.slice(-110);
  }

  return "Para ayudarte bien, dime el modelo exacto y qué necesitas. Si es tiras LED, envíame la foto de la etiqueta del TV.";
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
    const msgId = msg?.id;
    const type = msg?.type;

    if (!from) return;

    if (seenBefore(msgId)) {
      dlog("🔁 Duplicate message ignored:", msgId);
      return;
    }

    const sess = getSession(from);

    // ✅ Referral (Click-to-WhatsApp)
    const referralUrl = msg?.referral?.source_url || msg?.context?.referral?.source_url || null;
    if (referralUrl) {
      sess.lead.sourceUrl = referralUrl;
      if (referralUrl.includes("facebook.com/bkglobal.com.co/posts/") || referralUrl === LOCKS_FB_SOURCE) {
        sess.lead.lockReferral = true;
      }
      dlog("🔗 Referral detected:", referralUrl, "lockReferral=", sess.lead.lockReferral);
    }

    // TEXT
    if (type === "text") {
      const text = msg?.text?.body || "";
      if (!text) return;

      dlog("✅ Incoming text:", { from, text, msgId });

      if (isGreeting(text)) {
        // no resetea carrito automáticamente; solo reinicia si el usuario lo pide
        const hi = "¡Hola! 😄 ¿Qué te puedo ayudar el día de hoy?";
        await sendWhatsAppText(from, hi);
        return;
      }

      if (isReset(text)) {
        resetSession(from);
        const rr = "Listo 👍 Empezamos de nuevo. ¿Qué estás buscando?";
        await sendWhatsAppText(from, rr);
        return;
      }

      // ✅ Si el cliente dice "espera también necesito", mantenemos carrito vivo
      // (El prompt + tools ya lo suman. Aquí no hacemos nada extra, solo NO reseteamos.)

      const reply = await runAgent({ from, userText: text });
      await sendWhatsAppText(from, reply);
      return;
    }

    // IMAGE
    if (type === "image") {
      const imageId = msg?.image?.id;
      const caption = msg?.image?.caption || "";
      dlog("✅ Incoming image:", { from, msgId, imageId, caption });

      if (!imageId) {
        await sendWhatsAppText(from, "Recibí la imagen, pero no pude leerla. ¿Me confirmas el modelo en texto por favor?");
        return;
      }

      let dataUrl = null;
      try {
        dataUrl = await fetchWhatsAppImageAsDataUrl(imageId);
      } catch (e) {
        console.error("❌ fetchWhatsAppImageAsDataUrl error:", e?.message || e);
        await sendWhatsAppText(from, "Recibí la imagen, pero no pude descargarla. ¿Me escribes el modelo exacto que aparece en la etiqueta?");
        return;
      }

      // ✅ Doble paso: primero extrae marca+modelo (mejor precisión)
      const info = await extractTvLabelInfo(dataUrl);
      const modelText =
        info?.ok && (info.model || info.model_alt)
          ? `Etiqueta leída: Marca=${info.brand || "N/D"}, Modelo=${info.model || "N/D"}${info.model_alt ? `, Alt=${info.model_alt}` : ""}.`
          : "No logré leer el modelo con claridad en la etiqueta.";

      const hint = `Si es etiqueta de TV para tiras LED: usa el MODELO exacto. ${modelText} ${info.raw ? `Texto relevante: ${info.raw}` : ""}`;

      const reply = await runAgent({
        from,
        userText: caption || "El cliente envió una imagen de etiqueta.",
        imageDataUrl: dataUrl,
        imageHint: hint,
      });

      await sendWhatsAppText(from, reply);
      return;
    }

    // fallback other types
    dlog("ℹ️ Incoming message type not handled:", type);
    await sendWhatsAppText(from, "Recibí tu mensaje. ¿Me lo puedes escribir en texto para ayudarte más rápido?");
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
