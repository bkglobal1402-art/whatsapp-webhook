process.on("uncaughtException", (err) => console.error("🔥 uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("🔥 unhandledRejection:", err));

const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

/* =========================
   ENV
========================= */
const ODOO_URL = process.env.ODOO_URL;      // http://104.225.217.59:5033
const ODOO_DB = process.env.ODOO_DB;        // odoo_admin_pro
const ODOO_USER = process.env.ODOO_USER;    // bot@bkglobal.com.co
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

async function odooFindProducts({ code = null, q = null, limit = 3 }) {
  const domain = [];
  if (code) {
    domain.push(["default_code", "=", String(code).trim()]);
  } else if (q) {
    const qq = String(q).trim();
    // Busca por nombre o por referencia
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

async function odooGetCategoryName(product) {
  // categ_id normalmente viene como [id, "Nombre"]
  const c = product?.categ_id;
  if (Array.isArray(c) && typeof c[1] === "string") return c[1];
  return "";
}

function allowSuggestionsByCategoryName(catName = "") {
  const c = norm(catName);
  // SOLO cerraduras e intercomunicadores
  return c.includes("cerrad") || c.includes("intercom");
}

async function odooSuggestAlternatives({ product, limit = 3 }) {
  // Alternativas dentro de la misma categoría (si existe)
  const categ = product?.categ_id;
  const categId = Array.isArray(categ) ? categ[0] : null;
  if (!categId) return [];

  // Traemos varios y filtramos los que tengan stock
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
   OpenAI
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

  // Debe ser JSON
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
  "choice_number": 1|2|3|null,
  "code": "..."|null,
  "query": "..."|null
}

Reglas:
- Saludos (hola/buenas/hey) => GREETING
- Reset (reiniciar/cancelar/empezar/reset) => RESET
- Si dice 1/2/3 o "la 2" => PICK_OPTION
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
- listed_options: ${JSON.stringify(listed)}
`;

  const obj = await openaiChatJSON({ system: sys, user, temperature: 0 });
  if (!obj?.intent) return { intent: "SEARCH", choice_number: null, code: null, query: userText };
  return obj;
}

async function generateReplyWithOpenAI({ mode, userText, data, fallback }) {
  const sys = `
Eres un asesor comercial VENDEDOR por WhatsApp de BK GLOBAL (Colombia).

REGLAS CRÍTICAS:
- NO inventes precio, existencia, productos o códigos.
- Usa ÚNICAMENTE la info en DATA.
- NUNCA muestres cantidades de stock. Solo:
  "✅ Hay existencia" o "❌ Sin existencia"
- Siempre amable, vendedor, pero corto (máx 6 líneas).
- Si no hay stock y hay alternativas permitidas, sugiere 1 a 3 alternativas.
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
    if (obj?.reply && typeof obj.reply === "string") return obj.reply.trim();
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
   Session + Dedup (Meta Test Number fix)
========================= */
const sessions = new Map(); // from -> { pending, lastOptions }
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

    // Dedup (Meta test number reenvía)
    if (seenBefore(msgId)) {
      console.log("🔁 Duplicate message ignored:", msgId);
      return;
    }

    console.log("✅ Incoming message:", { from, text, msgId });

    const tnorm = norm(text);
    const greetings = new Set(["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "hey"]);
    const resets = new Set(["reiniciar", "reset", "cancelar", "empezar", "borrar"]);

    // ✅ Regla 1: Siempre saludar si dicen hola (y resetear contexto)
    if (greetings.has(tnorm)) {
      sessions.delete(from);
      const reply = await generateReplyWithOpenAI({
        mode: "SALUDO",
        userText: text,
        data: { note: "Saluda y pregunta qué necesita. Tono vendedor." },
        fallback: "Hola 👋 ¡Con gusto! ¿Qué estás buscando hoy? (puedes enviarme el código o el nombre del producto)",
      });
      await sendWhatsAppText(from, reply);
      return;
    }

    // Reset manual
    if (resets.has(tnorm)) {
      sessions.delete(from);
      await sendWhatsAppText(from, "Listo 👍 Empezamos de nuevo. ¿Qué estás buscando? (código o nombre)");
      return;
    }

    const sess = sessions.get(from) || { pending: null, lastOptions: [] };

    // OpenAI: intención
    const intentObj = await classifyIntentWithOpenAI({ userText: text, session: sess });

    if (intentObj.intent === "RESET") {
      sessions.delete(from);
      await sendWhatsAppText(from, "Listo 👍 Empezamos de nuevo. ¿Qué estás buscando? (código o nombre)");
      return;
    }

    // Si estaban en selección 1/2/3
    if (sess.pending === "pick" || intentObj.intent === "PICK_OPTION") {
      const n = intentObj.choice_number ?? (tnorm.match(/\b(1|2|3)\b/) ? Number(RegExp.$1) : null);
      const idx = typeof n === "number" ? n - 1 : -1;
      const chosen = sess.lastOptions?.[idx];

      if (!chosen) {
        const reply = await generateReplyWithOpenAI({
          mode: "PEDIR_OPCION",
          userText: text,
          data: { opciones: (sess.lastOptions || []).map((p, i) => ({ n: i + 1, nombre: p.display_name, codigo: p.default_code })) },
          fallback: "¿Cuál opción eliges? respóndeme con 1, 2 o 3 🙂",
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      const price = await odooGetPrice(chosen);
      const has = await odooHasStock(chosen.id);
      const catName = await odooGetCategoryName(chosen);

      let alternatives = [];
      if (!has && allowSuggestionsByCategoryName(catName)) {
        const alts = await odooSuggestAlternatives({ product: chosen, limit: 3 });
        alternatives = await Promise.all(
          alts.map(async (p) => ({
            nombre: p.display_name,
            codigo: p.default_code || null,
            precio: moneyCOP(await odooGetPrice(p)),
            existencia: "HAY",
          }))
        );
      }

      const safe = {
        producto: {
          nombre: chosen.display_name,
          codigo: chosen.default_code || null,
          categoria: catName || null,
          precio: moneyCOP(price),
          existencia: has ? "HAY" : "NO_HAY",
        },
        alternativas: alternatives,
      };

      const fallback =
        `${safe.producto.nombre}${safe.producto.codigo ? ` (${safe.producto.codigo})` : ""}\n` +
        `Precio: ${safe.producto.precio}\n` +
        (safe.producto.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia") +
        (alternatives.length ? "\n\nTe puedo ofrecer estas alternativas con existencia:\n" +
          alternatives.map((a, i) => `${i + 1}) ${a.nombre}${a.codigo ? ` (${a.codigo})` : ""} - ${a.precio}`).join("\n")
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

    // Buscar por código o query
    let products = [];
    if (intentObj.intent === "CODE_LOOKUP" || isLikelyCode(text)) {
      const code = intentObj.code || String(text).trim();
      products = await odooFindProducts({ code, limit: 3 });
    } else if (intentObj.intent === "SEARCH") {
      const q = intentObj.query || text;
      products = await odooFindProducts({ q, limit: 3 });
    } else if (intentObj.intent === "ASK_CLARIFY") {
      const reply = await generateReplyWithOpenAI({
        mode: "ACLARAR",
        userText: text,
        data: { tips: ["Envíame el código si lo tienes (ej: 103317).", "O el nombre exacto (ej: display iphone 11 pro max)."] },
        fallback: "¿Me compartes el código o el nombre exacto del producto para revisarte precio y disponibilidad? 🙂",
      });
      await sendWhatsAppText(from, reply);
      return;
    } else {
      // fallback búsqueda
      products = await odooFindProducts({ q: text, limit: 3 });
    }

    // Sin coincidencias
    if (!products.length) {
      const reply = await generateReplyWithOpenAI({
        mode: "SIN_COINCIDENCIAS",
        userText: text,
        data: { tips: ["Envíame el código del producto.", "O el nombre exacto como lo manejas en Odoo."] },
        fallback: "No lo encontré en Odoo. ¿Me envías el código o el nombre exacto? 🙏",
      });
      await sendWhatsAppText(from, reply);
      return;
    }

    // Único producto
    if (products.length === 1) {
      const p = products[0];
      const price = await odooGetPrice(p);
      const has = await odooHasStock(p.id);
      const catName = await odooGetCategoryName(p);

      let alternatives = [];
      if (!has && allowSuggestionsByCategoryName(catName)) {
        const alts = await odooSuggestAlternatives({ product: p, limit: 3 });
        alternatives = await Promise.all(
          alts.map(async (x) => ({
            nombre: x.display_name,
            codigo: x.default_code || null,
            precio: moneyCOP(await odooGetPrice(x)),
            existencia: "HAY",
          }))
        );
      }

      const safe = {
        producto: {
          nombre: p.display_name,
          codigo: p.default_code || null,
          categoria: catName || null,
          precio: moneyCOP(price),
          existencia: has ? "HAY" : "NO_HAY",
        },
        alternativas: alternatives,
      };

      const fallback =
        `${safe.producto.nombre}${safe.producto.codigo ? ` (${safe.producto.codigo})` : ""}\n` +
        `Precio: ${safe.producto.precio}\n` +
        (safe.producto.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia") +
        (alternatives.length ? "\n\nTe puedo ofrecer estas alternativas con existencia:\n" +
          alternatives.map((a, i) => `${i + 1}) ${a.nombre}${a.codigo ? ` (${a.codigo})` : ""} - ${a.precio}`).join("\n")
          : "");

      const reply = await generateReplyWithOpenAI({
        mode: "RESPUESTA_FINAL",
        userText: text,
        data: safe,
        fallback,
      });

      // Guardar estado mínimo (por si pregunta “y la otra?”)
      sessions.set(from, { pending: null, lastOptions: [p] });
      await sendWhatsAppText(from, reply);
      return;
    }

    // Múltiples: lista y pedir elección
    sessions.set(from, { pending: "pick", lastOptions: products });

    const opciones = products.map((p, i) => ({
      n: i + 1,
      nombre: p.display_name,
      codigo: p.default_code || null,
    }));

    const fallback =
      `Encontré estas opciones:\n` +
      opciones.map((o) => `${o.n}) ${o.nombre}${o.codigo ? ` (${o.codigo})` : ""}`).join("\n") +
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
