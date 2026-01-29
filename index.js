process.on("uncaughtException", (err) => console.error("🔥 uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("🔥 unhandledRejection:", err));

const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

/* =========================
   ENV (Railway Variables)
========================= */
// ODOO_URL: http://104.225.217.59:5033
// ODOO_DB:  odoo_admin_pro
// ODOO_USER: bot@bkglobal.com.co
// ODOO_PASS: (tu clave del usuario bot)
//
// VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID
// OPENAI_API_KEY (opcional) + OPENAI_MODEL (opcional)

const ODOO_URL = process.env.ODOO_URL;
const ODOO_DB = process.env.ODOO_DB;
const ODOO_USER = process.env.ODOO_USER;
const ODOO_PASS = process.env.ODOO_PASS;

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_de_prueba";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/* =========================
   ✅ SYSTEM PROMPT (TU PROMPT)
========================= */
const BK_SYSTEM_PROMPT = `
Eres BK GLOBAL IA, el asesor comercial y técnico oficial de BK GLOBAL S.A.S (Colombia).

BK GLOBAL se dedica a la venta de:
- Repuestos de celulares y tablets
- Cerraduras digitales
- GPS para vehículos (incluyendo modelos con anti-inhibidor)
- Intercomunicadores para moto
- Tiras LED para televisores
- Accesorios tecnológicos

Tu comportamiento debe ser el de un asesor humano experto, cercano y confiable.

REGLAS CLAVE:
1. El cliente NO conoce nombres técnicos ni códigos internos.
2. Nunca inventes productos, precios, compatibilidades ni disponibilidad.
3. Si no tienes información exacta, dilo claramente y ofrece verificar.
4. Haz preguntas cortas y necesarias, no interrogatorios.
5. Prioriza siempre asesorar y vender, no solo informar.
6. Usa lenguaje claro, natural y profesional, ideal para WhatsApp.

FORMA DE ATENDER:
- Primero entiende la necesidad real del cliente.
- Luego ofrece las mejores opciones disponibles.
- Explica beneficios en lenguaje sencillo.
- Incluye precios solo cuando los tengas confirmados.
- Si hay varias opciones, preséntalas de forma clara y ordenada.

SEGÚN CATEGORÍA:

• Cerraduras digitales:
Pregunta el uso (puerta principal, habitación, oficina, cajón, exterior).
Explica tipo de acceso, nivel de seguridad y si es resistente al agua.

• GPS para vehículos:
Pregunta tipo de vehículo y necesidad (seguridad, rastreo, flota).
Explica claramente la diferencia entre GPS normal y GPS con anti-inhibidor.

• Repuestos de celulares:
Guía al cliente aunque no sepa el modelo.
Pregunta marca, modelo y problema.
Aclara si incluye táctil o no.

• Tiras LED para TV:
Nunca asumas el modelo.
Pregunta marca, pulgadas y modelo.
Explica diferencias de calidad y durabilidad.

• Intercomunicadores para moto:
Pregunta si es para uno o dos cascos, distancia y tipo de uso.

POLÍTICAS:
Explica garantías, cambios y devoluciones de forma clara y conforme a la ley colombiana.
Nunca prometas algo fuera de política.

OBJETIVO FINAL:
Asesorar como un vendedor experto de BK GLOBAL, generar confianza y cerrar la venta sin confundir al cliente.
`.trim();

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

function isLikelyCode(text) {
  const t = String(text || "").trim();
  return /^\d{4,}$/.test(t);
}

function moneyCOP(n) {
  const x = Math.round(Number(n || 0));
  if (!isFinite(x)) return "$0";
  return `$${x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

function isGenericOptionsText(text = "") {
  const t = norm(text);
  const keys = [
    "que opciones tienes",
    "que opciones hay",
    "que tienes",
    "cuales tienes",
    "cuales hay",
    "en existencia",
    "disponibles",
    "con existencia",
    "muestrame opciones",
    "muestra opciones",
    "opciones",
    "disponible",
    "existencia",
    "dime todas las opciones",
    "todas las opciones",
  ];
  return keys.some((k) => t.includes(k));
}

function isNoStockRequest(text = "") {
  const t = norm(text);
  const keys = [
    "no hay existencia",
    "sin existencia",
    "sin stock",
    "agotad",
    "que no haya exist",
    "que no hay exist",
    "cuales no hay",
    "cuales no tienen",
    "que modelos no hay",
    "que tienes sin",
    "sin inventario",
  ];
  return keys.some((k) => t.includes(k));
}

function isEtaRequest(text = "") {
  const t = norm(text);
  const keys = [
    "para cuando llegan",
    "cuando llegan",
    "cuando vuelven",
    "cuando hay",
    "cuando entran",
    "cuando ingresan",
    "cuando reponen",
    "cuando hay stock",
    "fecha de llegada",
    "fecha de ingreso",
    "cuando tendran",
    "cuando tendrian",
    "cuanto se demora",
    "en cuanto tiempo llega",
    "en cuanto tiempo vuelven",
    "cuando vuelve a haber",
    "cuando les llega",
    "cuando les entran",
  ];
  return keys.some((k) => t.includes(k));
}

/**
 * Limpia el display_name solo para que se vea más humano.
 * (Igual vamos a mostrar el código aparte, porque tú lo pediste).
 */
function publicName(displayName = "") {
  let s = String(displayName || "").trim();
  s = s.replace(/^\[[^\]]+\]\s*/g, "");
  s = s.replace(/\s*\(([A-Za-z0-9\-\_\. ]{2,})\)\s*$/g, "").trim();
  s = s.replace(/\s{2,}/g, " ").trim();
  if (s.length < 4) return String(displayName || "").trim();
  return s;
}

function priceLabelCOP(n) {
  const x = Math.round(Number(n || 0));
  if (!isFinite(x) || x < 1000) return "Precio: Por confirmar";
  return `Precio: ${moneyCOP(x)}`;
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
   Odoo Queries
========================= */
async function odooFindProducts({ code = null, q = null, limit = 3 }) {
  const domain = [];
  if (code) {
    domain.push(["default_code", "=", String(code).trim()]);
  } else if (q) {
    const qq = String(q).trim();
    domain.push("|", ["name", "ilike", qq], ["default_code", "ilike", qq]);
  } else return [];

  const fields = ["id", "display_name", "default_code", "list_price", "categ_id"];
  const products = await odooExecuteKw("product.product", "search_read", [domain], {
    fields,
    limit,
    order: "id desc",
  });

  return Array.isArray(products) ? products : [];
}

async function odooFindCategoryIdByName(name) {
  const domain = [["name", "ilike", String(name).trim()]];
  const rows = await odooExecuteKw("product.category", "search_read", [domain], {
    fields: ["id", "name"],
    limit: 1,
  });
  return rows?.[0]?.id || null;
}

async function odooFindProductsByCategory({ categoryName, q = null, limit = 50 }) {
  const catId = await odooFindCategoryIdByName(categoryName);
  if (!catId) return [];

  const domain = [["categ_id", "=", catId]];

  if (q && String(q).trim()) {
    const qq = String(q).trim();
    domain.push("|", ["name", "ilike", qq], ["default_code", "ilike", qq]);
  }

  const fields = ["id", "display_name", "default_code", "list_price", "categ_id"];
  const products = await odooExecuteKw("product.product", "search_read", [domain], {
    fields,
    limit,
    order: "id desc",
  });

  return Array.isArray(products) ? products : [];
}

async function odooHasStock(productId) {
  const quants = await odooExecuteKw(
    "stock.quant",
    "search_read",
    [[
      ["product_id", "=", productId],
      ["location_id.usage", "=", "internal"],
    ]],
    { fields: ["quantity", "reserved_quantity"], limit: 2000 }
  );

  let available = 0;
  for (const q of quants || []) {
    const qty = Number(q.quantity || 0);
    const res = Number(q.reserved_quantity || 0);
    available += (qty - res);
  }
  return available > 0;
}

async function odooGetPrice(product) {
  const p = Number(product?.list_price ?? 0);
  return isFinite(p) ? p : 0;
}

function getCategoryName(product) {
  const c = product?.categ_id;
  if (Array.isArray(c) && typeof c[1] === "string") return c[1];
  return "";
}

/* =========================
   Category Rules (BK GLOBAL)
========================= */
function allowSuggestionsByCategoryName(catName = "") {
  const c = norm(catName);
  return c === "cerraduras digitales" || c === "intercomunicadores";
}

function detectAdvisorCategoryFromNeed(text = "") {
  const t = norm(text);

  if (t.includes("cerradura") || t.includes("chapa") || t.includes("puerta")) {
    return "CERRADURAS DIGITALES";
  }

  if (t.includes("intercom") || t.includes("intercomunicador") || t.includes("moto") || t.includes("casco")) {
    return "INTERCOMUNICADORES";
  }

  return null;
}

function buildNeedKeyword(text = "") {
  const t = norm(text);
  if (t.includes("principal")) return "principal";
  if (t.includes("exterior")) return "exterior";
  if (t.includes("interior")) return "interior";
  if (t.includes("puerta")) return "puerta";
  if (t.includes("moto")) return "moto";
  if (t.includes("casco")) return "casco";
  return "";
}

async function odooSuggestAlternativesSameCategory({ product, limit = 3 }) {
  const categ = product?.categ_id;
  const categId = Array.isArray(categ) ? categ[0] : null;
  if (!categId) return [];

  const fields = ["id", "display_name", "default_code", "list_price", "categ_id"];
  const candidates = await odooExecuteKw(
    "product.product",
    "search_read",
    [[["categ_id", "=", categId], ["id", "!=", product.id]]],
    { fields, limit: 25, order: "id desc" }
  );

  const out = [];
  for (const p of candidates || []) {
    const has = await odooHasStock(p.id);
    if (!has) continue;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/* =========================
   OpenAI (opcional)
========================= */
async function openaiChatJSON({ system, user, temperature = 0 }) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  const data = await resp.json().catch(() => null);
  if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}: ${JSON.stringify(data)?.slice(0, 250)}`);
  const txt = data?.choices?.[0]?.message?.content?.trim() || "";

  try {
    return JSON.parse(txt);
  } catch {
    const start = txt.indexOf("{");
    const end = txt.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(txt.slice(start, end + 1));
    throw new Error(`OpenAI returned non-JSON: ${txt.slice(0, 200)}`);
  }
}

async function classifyIntentWithOpenAI({ userText, session }) {
  const sys = `
Eres un clasificador de intención para un bot de WhatsApp de BK GLOBAL.
Devuelve SOLO JSON válido:

{
  "intent": "GREETING" | "RESET" | "PICK_OPTION" | "CODE_LOOKUP" | "SEARCH" | "ASK_CLARIFY",
  "choice_number": number|null,
  "code": "..."|null,
  "query": "..."|null
}

Reglas:
- Saludos => GREETING
- Reset => RESET
- Si el mensaje es un número (ej: "7") => PICK_OPTION con choice_number
- Si texto es número >=4 dígitos y no hay lista activa => CODE_LOOKUP
- Si es búsqueda por texto => SEARCH
- Si es ambiguo => ASK_CLARIFY
`;

  const sess = session || {};
  const listed = Array.isArray(sess.lastOptions)
    ? sess.lastOptions.map((p, i) => ({ n: i + 1, nombre: p.display_name || "" }))
    : [];

  const user = `
USER_TEXT: ${userText}
SESSION:
- pending: ${sess.pending || "null"}
- anchorCategory: ${sess.anchorCategory || "null"}
- listed_options: ${JSON.stringify(listed)}
`;

  const obj = await openaiChatJSON({ system: sys, user, temperature: 0 });
  if (!obj?.intent) return { intent: "SEARCH", choice_number: null, code: null, query: userText };
  return obj;
}

async function generateReplyWithOpenAI({ mode, userText, data, fallback }) {
  if (!OPENAI_API_KEY) return fallback;

  const sys = `
${BK_SYSTEM_PROMPT}

REGLAS TÉCNICAS (OBLIGATORIAS):
- Usa ÚNICAMENTE la info que venga en DATA.
- NUNCA muestres cantidades de stock. Solo: "✅ Hay existencia" o "❌ Sin existencia".
- Si DATA trae "opciones_con_existencia" y/o "opciones_sin_existencia", muéstralas numeradas.
- IMPORTANTE: el cliente pidió ver el "código" del producto, así que si DATA trae "codigo", sí lo puedes mostrar.
- Si el cliente pregunta por "cuándo llega / reposición / fecha", y DATA no trae una fecha exacta,
  di "No tengo fecha exacta confirmada en este momento" y ofrece verificar/avisar.
- Devuelve SOLO JSON válido: {"reply":"..."} (sin texto extra).
`.trim();

  const user = `
MODE: ${mode}
USER_TEXT: ${userText}
DATA (fuente única):
${JSON.stringify(data, null, 2)}
`;

  try {
    const obj = await openaiChatJSON({ system: sys, user, temperature: 0.35 });
    const txt = obj?.reply && typeof obj.reply === "string" ? obj.reply.trim() : "";
    if (txt) return txt;
  } catch (e) {
    console.error("⚠️ OpenAI reply error:", e.message || e);
  }

  return fallback;
}

/* =========================
   WhatsApp Sender (con chunking)
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
    text: { body: text },
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
  console.log("📤 WhatsApp send response:", resp.status, data);
}

function splitIntoChunks(text, maxLen = 1400) {
  const s = String(text || "");
  if (s.length <= maxLen) return [s];

  const lines = s.split("\n");
  const chunks = [];
  let cur = "";

  for (const line of lines) {
    const add = (cur ? "\n" : "") + line;
    if ((cur + add).length > maxLen) {
      if (cur) chunks.push(cur);
      cur = line;
    } else {
      cur += add;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function sendWhatsAppTextChunked(to, text) {
  const chunks = splitIntoChunks(text, 1400);
  for (const c of chunks) {
    await sendWhatsAppText(to, c);
  }
}

/* =========================
   Session + Dedup
========================= */
const sessions = new Map(); // from -> { pending, lastOptions, anchorCategory }
const seenMsg = new Map();  // msgId -> ts
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

/* =========================
   ✅ Respuesta ETA / reposición (sin inventar)
========================= */
async function respondEta({ from, userText, categoryName }) {
  const pregunta =
    categoryName === "CERRADURAS DIGITALES"
      ? "¿La necesitas para interior o exterior y qué prefieres: huella, clave o tarjeta?"
      : "¿Lo quieres para 1 casco o 2 cascos, y tu uso es más ciudad o carretera?";

  const fallback =
    `Buena pregunta 👌\n` +
    `En este momento no tengo una fecha exacta confirmada de llegada para ${categoryName}.\n` +
    `Si quieres, lo verifico y te aviso apenas entre.\n\n` +
    `${pregunta}`;

  const reply = await generateReplyWithOpenAI({
    mode: "ETA_REPOSICION",
    userText,
    data: { categoria: categoryName, note: "No hay fecha exacta en Odoo. Ofrecer verificar y asesorar." },
    fallback,
  });

  await sendWhatsAppTextChunked(from, reply);
}

/* =========================
   ✅ ASESOR: listar TODAS las opciones
   - Muestra CON y SIN existencia
   - Incluye CÓDIGO (default_code)
   - Guarda lastOptions en el mismo orden numerado para que el cliente responda con un número
========================= */
async function respondAdvisorAllOptions({ from, userText, categoryName }) {
  const kw = buildNeedKeyword(userText);

  // subimos el límite para intentar "todas"
  let found = await odooFindProductsByCategory({ categoryName, q: kw, limit: 80 });
  if (!found.length) found = await odooFindProductsByCategory({ categoryName, q: null, limit: 80 });

  // ancla
  const sessPrev = sessions.get(from) || { pending: null, lastOptions: [], anchorCategory: null };
  sessions.set(from, { ...sessPrev, anchorCategory: categoryName });

  if (!found.length) {
    await sendWhatsAppText(from, `En este momento no veo productos en la categoría ${categoryName} en Odoo.`);
    return;
  }

  // enriquecer
  const enriched = [];
  for (const p of found) {
    const has = await odooHasStock(p.id);
    const price = await odooGetPrice(p);
    enriched.push({
      id: p.id,
      nombre: publicName(p.display_name),
      codigo: p.default_code || "N/A",
      precio_label: priceLabelCOP(price),
      existencia: has ? "HAY" : "NO_HAY",
      _raw: p,
    });
  }

  // ordenar: primero con existencia, luego sin
  const inStock = enriched.filter((x) => x.existencia === "HAY");
  const outStock = enriched.filter((x) => x.existencia !== "HAY");

  const ordered = [...inStock, ...outStock];

  // lastOptions: en el mismo orden numerado
  const orderedRaw = ordered.map((x) => x._raw);
  sessions.set(from, { pending: "pick", lastOptions: orderedRaw, anchorCategory: categoryName });

  const pregunta =
    categoryName === "CERRADURAS DIGITALES"
      ? "Para recomendarte la mejor: ¿es para interior o exterior y qué prefieres (huella/clave/tarjeta)?"
      : "Para recomendarte bien: ¿lo quieres para 1 casco o 2 cascos y tu uso es ciudad o carretera?";

  // fallback directo (sin OpenAI) para asegurar que SIEMPRE liste
  const linesIn = inStock.length
    ? `✅ CON EXISTENCIA:\n` +
      inStock
        .map((o, i) => {
          const n = i + 1;
          return `${n}) ${o.nombre}\nCódigo: ${o.codigo}\n${o.precio_label}\n✅ Hay existencia`;
        })
        .join("\n\n")
    : `✅ CON EXISTENCIA:\n(No hay opciones con existencia en este momento)`;

  const offset = inStock.length;
  const linesOut = outStock.length
    ? `\n\n❌ SIN EXISTENCIA:\n` +
      outStock
        .map((o, i) => {
          const n = offset + i + 1;
          return `${n}) ${o.nombre}\nCódigo: ${o.codigo}\n${o.precio_label}\n❌ Sin existencia`;
        })
        .join("\n\n")
    : `\n\n❌ SIN EXISTENCIA:\n(No hay opciones sin existencia listadas)`;

  const fallback =
    `Listo 👌 Estas son las opciones que manejo en ${categoryName} (con y sin existencia):\n\n` +
    linesIn +
    linesOut +
    `\n\n${pregunta}\nSi alguna te gusta, respóndeme con el número (1-${ordered.length}).`;

  // DATA para OpenAI (pero igual usamos chunked y fallback es completo)
  const data = {
    categoria: categoryName,
    opciones_con_existencia: inStock.map((x, idx) => ({
      n: idx + 1,
      nombre: x.nombre,
      codigo: x.codigo,
      precio_label: x.precio_label,
      existencia: "HAY",
    })),
    opciones_sin_existencia: outStock.map((x, idx) => ({
      n: offset + idx + 1,
      nombre: x.nombre,
      codigo: x.codigo,
      precio_label: x.precio_label,
      existencia: "NO_HAY",
    })),
    pregunta,
    total: ordered.length,
  };

  const reply = await generateReplyWithOpenAI({
    mode: "ASESOR_TODAS_OPCIONES",
    userText,
    data,
    fallback,
  });

  await sendWhatsAppTextChunked(from, reply);
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
    if (!OPENAI_API_KEY) return res.json({ ok: false, error: "Missing OPENAI_API_KEY" });
    const obj = await classifyIntentWithOpenAI({ userText: "hola", session: {} });
    res.json({ ok: true, sample: obj });
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
      console.log("🔁 Duplicate message ignored:", msgId);
      return;
    }

    console.log("✅ Incoming message:", { from, text, msgId });

    const tnorm = norm(text);
    const greetings = new Set(["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "hey"]);
    const resets = new Set(["reiniciar", "reset", "cancelar", "empezar", "borrar"]);

    // Saludo = reset
    if (greetings.has(tnorm)) {
      sessions.delete(from);

      const reply = await generateReplyWithOpenAI({
        mode: "SALUDO",
        userText: text,
        data: { note: "Saluda y pregunta qué necesita." },
        fallback: "Hola 👋 ¡Con gusto! ¿Qué estás buscando hoy?",
      });

      await sendWhatsAppTextChunked(from, reply);
      return;
    }

    if (resets.has(tnorm)) {
      sessions.delete(from);
      await sendWhatsAppText(from, "Listo 👍 Empezamos de nuevo. ¿Qué necesitas?");
      return;
    }

    const sess = sessions.get(from) || { pending: null, lastOptions: [], anchorCategory: null };

    // clasificador
    let intentObj;
    if (OPENAI_API_KEY) {
      intentObj = await classifyIntentWithOpenAI({ userText: text, session: sess });
    } else {
      intentObj = { intent: "SEARCH", choice_number: null, code: null, query: text };
      const justNumber = String(text || "").trim();
      if (/^\d+$/.test(justNumber)) intentObj = { intent: "PICK_OPTION", choice_number: Number(justNumber), code: null, query: null };
      if (isLikelyCode(text) && (!Array.isArray(sess.lastOptions) || sess.lastOptions.length === 0)) {
        intentObj = { intent: "CODE_LOOKUP", choice_number: null, code: String(text).trim(), query: null };
      }
    }

    // HARD ANCHOR: si hay lista activa, cualquier número es elección
    const justNumber = String(text || "").trim();
    if (Array.isArray(sess.lastOptions) && sess.lastOptions.length > 0 && /^\d+$/.test(justNumber)) {
      intentObj.intent = "PICK_OPTION";
      intentObj.choice_number = Number(justNumber);
    }

    if (intentObj.intent === "RESET") {
      sessions.delete(from);
      await sendWhatsAppText(from, "Listo 👍 Empezamos de nuevo. ¿Qué necesitas?");
      return;
    }

    // Mantener tema por ancla (ETA / opciones)
    if (sess.anchorCategory && !isLikelyCode(text)) {
      if (isEtaRequest(text)) {
        await respondEta({ from, userText: text, categoryName: sess.anchorCategory });
        return;
      }
      if (isGenericOptionsText(text) || isNoStockRequest(text)) {
        // ✅ ahora siempre mostramos TODAS (con y sin existencia) + código
        await respondAdvisorAllOptions({ from, userText: text, categoryName: sess.anchorCategory });
        return;
      }
    }

    /* =========================
       PICK: el usuario elige un número de la lista
    ========================= */
    if (sess.pending === "pick" || intentObj.intent === "PICK_OPTION") {
      const n = Number(intentObj.choice_number);
      const idx = Number.isFinite(n) ? n - 1 : -1;
      const chosen = sess.lastOptions?.[idx];

      if (!chosen) {
        await sendWhatsAppText(from, "¿Cuál opción eliges? respóndeme con el número 🙂");
        return;
      }

      const price = await odooGetPrice(chosen);
      const has = await odooHasStock(chosen.id);
      const catName = getCategoryName(chosen);

      let alternatives = [];
      if (!has && allowSuggestionsByCategoryName(catName)) {
        const alts = await odooSuggestAlternativesSameCategory({ product: chosen, limit: 3 });
        alternatives = await Promise.all(
          alts.map(async (p) => ({
            nombre: publicName(p.display_name),
            codigo: p.default_code || "N/A",
            precio_label: priceLabelCOP(await odooGetPrice(p)),
            existencia: "HAY",
          }))
        );
      }

      const safe = {
        producto: {
          nombre: publicName(chosen.display_name),
          codigo: chosen.default_code || "N/A",
          categoria: catName || null,
          precio_label: priceLabelCOP(price),
          existencia: has ? "HAY" : "NO_HAY",
        },
        alternativas,
      };

      const fallback =
        `${safe.producto.nombre}\n` +
        `Código: ${safe.producto.codigo}\n` +
        `${safe.producto.precio_label}\n` +
        (safe.producto.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia") +
        (alternatives.length
          ? `\n\nAlternativas con existencia:\n` +
            alternatives.map((a, i) => `${i + 1}) ${a.nombre}\nCódigo: ${a.codigo}\n${a.precio_label}\n✅ Hay existencia`).join("\n\n")
          : "");

      const reply = await generateReplyWithOpenAI({
        mode: "RESPUESTA_ELEGIDA",
        userText: text,
        data: safe,
        fallback,
      });

      // mantenemos anchor
      sessions.set(from, { pending: null, lastOptions: [], anchorCategory: sess.anchorCategory || null });

      await sendWhatsAppTextChunked(from, reply);
      return;
    }

    /* =========================
       ✅ MODO ASESOR (Cerraduras / Intercom)
       - Ahora: siempre lista TODAS (con/sin existencia) + código
    ========================= */
    if (intentObj.intent === "SEARCH") {
      const advisorCat = detectAdvisorCategoryFromNeed(text);

      if (advisorCat === "CERRADURAS DIGITALES" || advisorCat === "INTERCOMUNICADORES") {
        await respondAdvisorAllOptions({ from, userText: text, categoryName: advisorCat });
        return;
      }
    }

    /* =========================
       Búsqueda normal (otros productos)
    ========================= */
    let products = [];

    if (intentObj.intent === "CODE_LOOKUP" || isLikelyCode(text)) {
      const code = intentObj.code || String(text).trim();
      products = await odooFindProducts({ code, limit: 3 });
    } else if (intentObj.intent === "SEARCH") {
      const q = intentObj.query || text;
      products = await odooFindProducts({ q, limit: 3 });
    } else if (intentObj.intent === "ASK_CLARIFY") {
      await sendWhatsAppText(from, "¿Me das un detalle adicional (marca/modelo) para confirmarte precio y disponibilidad? 🙂");
      return;
    } else {
      products = await odooFindProducts({ q: text, limit: 3 });
    }

    if (!products.length) {
      await sendWhatsAppText(from, "No lo encontré en Odoo. ¿Me das un detalle extra (marca/modelo) para verificar? 🙏");
      return;
    }

    if (products.length === 1) {
      const p = products[0];
      const price = await odooGetPrice(p);
      const has = await odooHasStock(p.id);

      const safe = {
        producto: {
          nombre: publicName(p.display_name),
          codigo: p.default_code || "N/A",
          precio_label: priceLabelCOP(price),
          existencia: has ? "HAY" : "NO_HAY",
        },
      };

      const fallback =
        `${safe.producto.nombre}\n` +
        `Código: ${safe.producto.codigo}\n` +
        `${safe.producto.precio_label}\n` +
        (safe.producto.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia");

      const reply = await generateReplyWithOpenAI({
        mode: "RESPUESTA_FINAL",
        userText: text,
        data: safe,
        fallback,
      });

      sessions.delete(from);
      await sendWhatsAppTextChunked(from, reply);
      return;
    }

    sessions.set(from, { pending: "pick", lastOptions: products, anchorCategory: sess.anchorCategory || null });

    const opciones = products.map((p, i) => ({
      n: i + 1,
      nombre: publicName(p.display_name),
      codigo: p.default_code || "N/A",
    }));

    const fallback =
      `Encontré estas opciones:\n` +
      opciones.map((o) => `${o.n}) ${o.nombre}\nCódigo: ${o.codigo}`).join("\n\n") +
      `\n\n¿Cuál te interesa? (responde con el número)`;

    const reply = await generateReplyWithOpenAI({
      mode: "LISTAR_OPCIONES",
      userText: text,
      data: { opciones },
      fallback,
    });

    await sendWhatsAppTextChunked(from, reply);
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
