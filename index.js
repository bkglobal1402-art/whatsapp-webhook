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
// Understands:
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

// ✅ NUEVO: detectar cuando piden SIN existencia
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

// ✅ más tolerante: ilike en vez de "="
async function odooFindCategoryIdByName(name) {
  const domain = [["name", "ilike", String(name).trim()]];
  const rows = await odooExecuteKw("product.category", "search_read", [domain], {
    fields: ["id", "name"],
    limit: 1,
  });
  return rows?.[0]?.id || null;
}

async function odooFindProductsByCategory({ categoryName, q = null, limit = 10 }) {
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
  "choice_number": 1|2|3|4|5|null,
  "code": "..."|null,
  "query": "..."|null
}

Reglas:
- Saludos (hola/buenas/hey) => GREETING
- Reset (reiniciar/cancelar/empezar/reset/borrar) => RESET
- Si dice 1/2/3/4/5 o "la 2" => PICK_OPTION
- Si texto es número >=4 dígitos => CODE_LOOKUP
- Si es búsqueda por texto => SEARCH y query (limpia)
- Si es ambiguo => ASK_CLARIFY
`;

  const sess = session || {};
  const listed = Array.isArray(sess.lastOptions)
    ? sess.lastOptions.map((p, i) => ({ n: i + 1, nombre: p.display_name, codigo: p.default_code }))
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
Eres un asesor comercial por WhatsApp de BK GLOBAL (Colombia).

REGLAS CRÍTICAS:
- NO inventes precio, existencia, productos o códigos.
- Usa ÚNICAMENTE la info en DATA.
- NUNCA muestres cantidades de stock. Solo:
  "✅ Hay existencia" o "❌ Sin existencia"
- NO pidas códigos ni nombres técnicos al cliente.
- Si DATA trae "opciones", DEBES listar mínimo 3 opciones numeradas (1) 2) 3) con Precio y existencia.
- Devuelve SOLO JSON válido: {"reply":"..."} (sin texto extra).
`;

  const user = `
MODE: ${mode}
USER_TEXT: ${userText}
DATA (fuente única):
${JSON.stringify(data, null, 2)}
`;

  try {
    const obj = await openaiChatJSON({ system: sys, user, temperature: 0.3 });
    const txt = obj?.reply && typeof obj.reply === "string" ? obj.reply.trim() : "";

    // ✅ VALIDACIÓN: si debía listar opciones y no lo hizo, usamos fallback
    if (data?.opciones?.length) {
      const hasNumbered = (/\b1\)|\b1\./.test(txt) && /\b2\)|\b2\./.test(txt));
      const mentionsPrice = /precio/i.test(txt) || /\$\d/.test(txt);
      if (!hasNumbered || !mentionsPrice) return fallback;
    }

    if (txt) return txt;
  } catch (e) {
    console.error("⚠️ OpenAI reply error:", e.message || e);
  }
  return fallback;
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
   ✅ ASESOR: mantiene contexto incluso sin stock
   - Si hay stock: lista 3-5 con existencia y permite elegir
   - Si NO hay stock: lista 3-5 sin existencia (con precio) y mantiene anchorCategory
   - NO muestra códigos
========================= */
async function respondAdvisorOptions({ from, userText, categoryName, want = "AUTO" }) {
  const kw = buildNeedKeyword(userText);

  let found = await odooFindProductsByCategory({ categoryName, q: kw, limit: 30 });
  if (!found.length) found = await odooFindProductsByCategory({ categoryName, q: null, limit: 30 });

  // ✅ ANCLA SIEMPRE
  const sessPrev = sessions.get(from) || { pending: null, lastOptions: [], anchorCategory: null };
  sessions.set(from, { ...sessPrev, anchorCategory: categoryName });

  if (!found.length) {
    await sendWhatsAppText(
      from,
      `Hola 👋 En este momento no veo productos en la categoría ${categoryName} en Odoo. ¿Me das un detalle extra y lo intento de nuevo?`
    );
    return;
  }

  const enriched = [];
  for (const p of found) {
    const has = await odooHasStock(p.id);
    const price = await odooGetPrice(p);
    enriched.push({
      id: p.id,
      nombre: p.display_name,
      precio: moneyCOP(price),
      existencia: has ? "HAY" : "NO_HAY",
    });
  }

  const inStock = enriched.filter((x) => x.existencia === "HAY");
  const outStock = enriched.filter((x) => x.existencia !== "HAY");

  const showNoStock = want === "NO_STOCK" || (want === "AUTO" && isNoStockRequest(userText));
  const showInStock = want === "IN_STOCK" || (want === "AUTO" && !showNoStock);

  const topIn = inStock.slice(0, 5);
  const topOut = outStock.slice(0, 5);

  const pregunta =
    categoryName === "CERRADURAS DIGITALES"
      ? "¿La puerta es de madera o metálica? (y si es principal: ¿interior o exterior?)"
      : "¿Lo quieres para 1 casco o 2 cascos?";

  // ✅ Con existencia
  if (showInStock && topIn.length) {
    const topProducts = found.filter((p) => topIn.some((t) => t.id === p.id)).slice(0, topIn.length);
    sessions.set(from, { pending: "pick", lastOptions: topProducts, anchorCategory: categoryName });

    const fallback =
      `Perfecto 👌 Estas son opciones con EXISTENCIA ahora mismo:\n\n` +
      topIn.map((o, i) => `${i + 1}) ${o.nombre}\nPrecio: ${o.precio}\n✅ Hay existencia`).join("\n\n") +
      `\n\n${pregunta}\nResponde con el número (1-${topIn.length}).`;

    const reply = await generateReplyWithOpenAI({
      mode: "ASESOR_EXISTENCIA",
      userText,
      data: { categoria: categoryName, pregunta, opciones: topIn },
      fallback,
    });

    await sendWhatsAppText(from, reply);
    return;
  }

  // ✅ Sin existencia: LISTA MODELOS sin pedir código
  if (topOut.length) {
    sessions.set(from, { pending: null, lastOptions: [], anchorCategory: categoryName });

    const fallback =
      `En este momento no tengo opciones con existencia en ${categoryName} 😕\n` +
      `Pero manejo estos modelos (hoy están sin existencia):\n\n` +
      topOut.map((o, i) => `${i + 1}) ${o.nombre}\nPrecio: ${o.precio}\n❌ Sin existencia`).join("\n\n") +
      `\n\nSi me dices ${categoryName === "CERRADURAS DIGITALES" ? "si es interior o exterior y el tipo de acceso (huella/clave/tarjeta)" : "si es 1 o 2 cascos y tu uso (ciudad/carretera)"}, te digo cuál te conviene y te aviso opciones disponibles.`;

    const reply = await generateReplyWithOpenAI({
      mode: "ASESOR_SIN_EXISTENCIA",
      userText,
      data: { categoria: categoryName, pregunta, opciones_sin_existencia: topOut },
      fallback,
    });

    await sendWhatsAppText(from, reply);
    return;
  }

  await sendWhatsAppText(from, `No estoy viendo productos listados en ${categoryName} en Odoo ahora mismo.`);
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

    // ✅ Saludo = reset de sesión
    if (greetings.has(tnorm)) {
      sessions.delete(from);

      const reply = await generateReplyWithOpenAI({
        mode: "SALUDO",
        userText: text,
        data: { note: "Saluda y pregunta qué necesita." },
        fallback: "Hola 👋 ¡Con gusto! ¿Qué estás buscando hoy? (dime qué necesitas y te recomiendo opciones)",
      });

      await sendWhatsAppText(from, reply);
      return;
    }

    // Reset manual
    if (resets.has(tnorm)) {
      sessions.delete(from);
      await sendWhatsAppText(from, "Listo 👍 Empezamos de nuevo. ¿Qué necesitas? (dime para qué lo quieres y te recomiendo opciones)");
      return;
    }

    // Obtener sesión
    const sess = sessions.get(from) || { pending: null, lastOptions: [], anchorCategory: null };

    // ✅ CLASIFICADOR: si no tienes OpenAI, usamos regla básica
    let intentObj;
    if (OPENAI_API_KEY) {
      intentObj = await classifyIntentWithOpenAI({ userText: text, session: sess });
    } else {
      intentObj = { intent: "SEARCH", choice_number: null, code: null, query: text };
      if (isLikelyCode(text)) intentObj = { intent: "CODE_LOOKUP", choice_number: null, code: String(text).trim(), query: null };
      const justNumber = String(text || "").trim();
      if (/^[1-5]$/.test(justNumber)) intentObj = { intent: "PICK_OPTION", choice_number: Number(justNumber), code: null, query: null };
    }

    // ✅ HARD ANCHOR: si hay lista activa, 1-5 siempre es elección
    const justNumber = String(text || "").trim();
    if (Array.isArray(sess.lastOptions) && sess.lastOptions.length > 0 && /^[1-5]$/.test(justNumber)) {
      intentObj.intent = "PICK_OPTION";
      intentObj.choice_number = Number(justNumber);
    }

    // Reset por OpenAI
    if (intentObj.intent === "RESET") {
      sessions.delete(from);
      await sendWhatsAppText(from, "Listo 👍 Empezamos de nuevo. ¿Qué necesitas? (dime para qué lo quieres y te recomiendo opciones)");
      return;
    }

    // ✅ Mantener tema por ANCLA: opciones / sin existencia
    if (sess.anchorCategory && !isLikelyCode(text)) {
      if (isGenericOptionsText(text)) {
        await respondAdvisorOptions({ from, userText: text, categoryName: sess.anchorCategory, want: "IN_STOCK" });
        return;
      }
      if (isNoStockRequest(text)) {
        await respondAdvisorOptions({ from, userText: text, categoryName: sess.anchorCategory, want: "NO_STOCK" });
        return;
      }
    }

    /* =========================
       Selección 1..5 (PICK)
    ========================= */
    if (sess.pending === "pick" || intentObj.intent === "PICK_OPTION") {
      const n = intentObj.choice_number ?? null;
      const idx = typeof n === "number" ? n - 1 : -1;
      const chosen = sess.lastOptions?.[idx];

      if (!chosen) {
        await sendWhatsAppText(from, "¿Cuál opción eliges? respóndeme con un número 🙂");
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
            nombre: p.display_name,
            precio: moneyCOP(await odooGetPrice(p)),
            existencia: "HAY",
          }))
        );
      }

      const safe = {
        producto: {
          nombre: chosen.display_name,
          categoria: catName || null,
          precio: moneyCOP(price),
          existencia: has ? "HAY" : "NO_HAY",
        },
        alternativas: alternatives,
      };

      const fallback =
        `${safe.producto.nombre}\n` +
        `Precio: ${safe.producto.precio}\n` +
        (safe.producto.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia") +
        (alternatives.length
          ? `\n\nTe recomiendo estas alternativas con existencia:\n` +
            alternatives.map((a, i) => `${i + 1}) ${a.nombre} - ${a.precio}`).join("\n")
          : "");

      const reply = await generateReplyWithOpenAI({
        mode: "RESPUESTA_FINAL",
        userText: text,
        data: safe,
        fallback,
      });

      // Mantener ancla
      sessions.set(from, { pending: null, lastOptions: [], anchorCategory: sess.anchorCategory || null });

      await sendWhatsAppText(from, reply);
      return;
    }

    /* =========================
       ✅ MODO ASESOR
    ========================= */
    if (intentObj.intent === "SEARCH") {
      const advisorCat = detectAdvisorCategoryFromNeed(text);
      if (advisorCat === "CERRADURAS DIGITALES" || advisorCat === "INTERCOMUNICADORES") {
        await respondAdvisorOptions({ from, userText: text, categoryName: advisorCat, want: "AUTO" });
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
      await sendWhatsAppText(from, "¿Me compartes el código o el nombre exacto del producto para revisarte precio y disponibilidad? 🙂");
      return;
    } else {
      products = await odooFindProducts({ q: text, limit: 3 });
    }

    if (!products.length) {
      await sendWhatsAppText(from, "No lo encontré en Odoo. ¿Me envías el código o el nombre exacto? 🙏");
      return;
    }

    if (products.length === 1) {
      const p = products[0];
      const price = await odooGetPrice(p);
      const has = await odooHasStock(p.id);
      const catName = getCategoryName(p);

      let alternatives = [];
      if (!has && allowSuggestionsByCategoryName(catName)) {
        const alts = await odooSuggestAlternativesSameCategory({ product: p, limit: 3 });
        alternatives = await Promise.all(
          alts.map(async (x) => ({
            nombre: x.display_name,
            precio: moneyCOP(await odooGetPrice(x)),
            existencia: "HAY",
          }))
        );
      }

      const safe = {
        producto: {
          nombre: p.display_name,
          precio: moneyCOP(price),
          existencia: has ? "HAY" : "NO_HAY",
        },
        alternativas: alternatives,
      };

      const fallback =
        `${safe.producto.nombre}\n` +
        `Precio: ${safe.producto.precio}\n` +
        (safe.producto.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia") +
        (alternatives.length
          ? `\n\nTe recomiendo estas alternativas con existencia:\n` +
            alternatives.map((a, i) => `${i + 1}) ${a.nombre} - ${a.precio}`).join("\n")
          : "");

      const reply = await generateReplyWithOpenAI({
        mode: "RESPUESTA_FINAL",
        userText: text,
        data: safe,
        fallback,
      });

      sessions.delete(from);
      await sendWhatsAppText(from, reply);
      return;
    }

    // múltiples: lista y pedir elección
    sessions.set(from, { pending: "pick", lastOptions: products, anchorCategory: sess.anchorCategory || null });

    const opciones = products.map((p, i) => ({
      n: i + 1,
      nombre: p.display_name,
    }));

    const fallback =
      `Encontré estas opciones:\n` +
      opciones.map((o) => `${o.n}) ${o.nombre}`).join("\n") +
      `\n\n¿Cuál te interesa? (1, 2 o 3)`;

    const reply = await generateReplyWithOpenAI({
      mode: "LISTAR_OPCIONES",
      userText: text,
      data: { opciones },
      fallback,
    });

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
