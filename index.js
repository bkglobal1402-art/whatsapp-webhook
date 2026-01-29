process.on("uncaughtException", (err) => console.error("🔥 uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("🔥 unhandledRejection:", err));

const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

/* =========================
   ENV (Railway Variables)
========================= */
const ODOO_URL = process.env.ODOO_URL;      // ej: http://104.225.217.59:5033
const ODOO_DB = process.env.ODOO_DB;        // ej: odoo_admin_pro
const ODOO_USER = process.env.ODOO_USER;    // ej: bot@bkglobal.com.co
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

function moneyCOP(n) {
  const x = Math.round(Number(n || 0));
  if (!isFinite(x)) return "$0";
  return `$${x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

function pickOptionNumber(text) {
  const t = norm(text);
  const m = t.match(/\b(1|2|3)\b/);
  if (m) return Number(m[1]);
  return null;
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

  if (!resp.ok) {
    throw new Error(`Odoo HTTP ${resp.status}: ${JSON.stringify(data)?.slice(0, 300)}`);
  }
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

async function odooFindProducts({ code = null, q = null, limit = 5 }) {
  const domain = [];
  if (code) {
    domain.push(["default_code", "=", String(code).trim()]);
  } else if (q) {
    const qq = String(q).trim();
    domain.push("|", ["name", "ilike", qq], ["default_code", "ilike", qq]);
  } else return [];

  const fields = ["id", "display_name", "default_code", "list_price", "type"];
  const products = await odooExecuteKw("product.product", "search_read", [domain], {
    fields,
    limit,
    order: "id desc",
  });

  return Array.isArray(products) ? products : [];
}

async function odooHasStock(productId) {
  if (!productId) return false;

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

/* =========================
   OpenAI (C: interpreta + redacta)
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
  if (!resp.ok) throw new Error(`OpenAI HTTP ${resp.status}: ${JSON.stringify(data)?.slice(0, 300)}`);
  const txt = data?.choices?.[0]?.message?.content?.trim() || "";

  try {
    return JSON.parse(txt);
  } catch {
    // fallback: intenta extraer JSON si viene con texto
    const start = txt.indexOf("{");
    const end = txt.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(txt.slice(start, end + 1));
    }
    throw new Error(`OpenAI returned non-JSON: ${txt.slice(0, 200)}`);
  }
}

async function classifyIntentWithOpenAI({ userText, session }) {
  const sys = `
Eres un clasificador de intención para un bot de WhatsApp de BK GLOBAL.
Devuelve SOLO JSON válido con estas llaves:

{
  "intent": "GREETING" | "RESET" | "PICK_OPTION" | "CODE_LOOKUP" | "SEARCH" | "ASK_CLARIFY",
  "choice_number": 1|2|3|null,
  "code": "..."|null,
  "query": "..."|null,
  "want_price": true|false,
  "want_stock": true|false
}

Reglas:
- Saludos (hola/buenas/hey) => GREETING
- Reset (reiniciar/cancelar/empezar/reset) => RESET
- Si dice 1/2/3 o "la 2" => PICK_OPTION y choice_number
- Si parece código (>=4 dígitos solo números) => CODE_LOOKUP y code
- Si es búsqueda por texto => SEARCH y query (versión limpia)
- Si es ambiguo => ASK_CLARIFY

Detección precio/stock:
- Si menciona precio/vale/cuesta/valor => want_price=true
- Si menciona hay/existencia/stock/disponible => want_stock=true
- Si no menciona nada => ambos true (responder completo)

No inventes.
`;

  const sess = session || {};
  const listed = Array.isArray(sess.lastOptions)
    ? sess.lastOptions.map((p, i) => ({ n: i + 1, display_name: p.display_name, default_code: p.default_code }))
    : [];

  const user = `
USER_TEXT: ${userText}

SESSION:
- pending: ${sess.pending || "null"}
- has_listed_options: ${listed.length > 0}
- listed_options: ${JSON.stringify(listed)}
`;

  const obj = await openaiChatJSON({ system: sys, user, temperature: 0 });

  // fallback hardening
  if (!obj?.intent) return { intent: "SEARCH", choice_number: null, code: null, query: null, want_price: true, want_stock: true };
  if (obj.want_price !== false && obj.want_price !== true) obj.want_price = true;
  if (obj.want_stock !== false && obj.want_stock !== true) obj.want_stock = true;
  return obj;
}

async function generateReplyWithOpenAI({ mode, userText, data, fallback }) {
  const sys = `
Eres un asesor comercial por WhatsApp de BK GLOBAL (Colombia).

REGLAS CRÍTICAS:
- NO inventes precio, stock, productos o códigos.
- Usa ÚNICAMENTE la info en DATA.
- NUNCA muestres cantidades de stock. Solo: "✅ Hay existencia" o "❌ Sin existencia".
- Respuesta corta y clara (máx 6 líneas).
- Devuelve SOLO JSON válido: {"reply":"..."}.
`;

  const user = `
MODE: ${mode}

USER_TEXT: ${userText}

DATA (fuente única):
${JSON.stringify(data, null, 2)}
`;

  try {
    const obj = await openaiChatJSON({ system: sys, user, temperature: 0.2 });
    if (obj?.reply && typeof obj.reply === "string") return obj.reply.trim();
  } catch (e) {
    console.error("⚠️ OpenAI reply error:", e.message || e);
  }
  return fallback;
}

/* =========================
   WhatsApp sender
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
   Session + Dedup (Meta test number fix)
========================= */
const sessions = new Map(); // per phone
// sessions.get(from) = { pending:"pick"|null, lastOptions:[...], want_price, want_stock }

const seenMsg = new Map(); // msgId -> timestamp
const SEEN_TTL = 10 * 60 * 1000;

function seenBefore(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  // cleanup sometimes
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

    // ✅ Dedup (Test number often re-sends same message)
    if (seenBefore(msgId)) {
      console.log("🔁 Duplicate message ignored:", msgId);
      return;
    }

    console.log("✅ Incoming message:", { from, text, msgId });

    // Hard reset if user says "hola" or reset words (extra protection)
    const tnorm = norm(text);
    const greetings = ["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "hey"];
    const resets = ["reiniciar", "reset", "cancelar", "empezar", "borrar"];
    if (greetings.includes(tnorm) || resets.includes(tnorm)) {
      sessions.delete(from);
      const reply = await generateReplyWithOpenAI({
        mode: "SALUDO",
        userText: text,
        data: { note: "Solo saluda y pregunta en qué ayudar." },
        fallback: "Hola 👋 ¿En qué te puedo ayudar?",
      });
      await sendWhatsAppText(from, reply);
      return;
    }

    const sess = sessions.get(from) || { pending: null, lastOptions: [], want_price: true, want_stock: true };

    // 1) OpenAI: clasificar intención
    const intentObj = await classifyIntentWithOpenAI({ userText: text, session: sess });

    // 2) Manejo de reset por intención
    if (intentObj.intent === "RESET") {
      sessions.delete(from);
      await sendWhatsAppText(from, "Listo 👍 Empezamos de nuevo. ¿Qué estás buscando?");
      return;
    }

    // 3) Si el usuario está escogiendo 1/2/3
    if (sess.pending === "pick" || intentObj.intent === "PICK_OPTION") {
      const n = intentObj.choice_number ?? pickOptionNumber(text);
      const idx = typeof n === "number" ? n - 1 : -1;
      const chosen = sess.lastOptions?.[idx];

      if (!chosen) {
        const reply = await generateReplyWithOpenAI({
          mode: "PEDIR_OPCION",
          userText: text,
          data: { opciones: (sess.lastOptions || []).map((p, i) => ({ n: i + 1, nombre: p.display_name, codigo: p.default_code })) },
          fallback: "Dime 1, 2 o 3 para escoger una opción 🙂",
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      const price = intentObj.want_price ? await odooGetPrice(chosen) : null;
      const has = intentObj.want_stock ? await odooHasStock(chosen.id) : null;

      const safe = {
        nombre: chosen.display_name,
        codigo: chosen.default_code || null,
        precio: intentObj.want_price ? moneyCOP(price) : null,
        existencia: intentObj.want_stock ? (has ? "HAY" : "NO_HAY") : null,
      };

      const reply = await generateReplyWithOpenAI({
        mode: "RESPUESTA_FINAL",
        userText: text,
        data: { producto: safe },
        fallback: `${safe.nombre}${safe.codigo ? ` (${safe.codigo})` : ""}\n${safe.precio ? `Precio: ${safe.precio}\n` : ""}${safe.existencia ? (safe.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia") : ""}`.trim(),
      });

      sessions.delete(from);
      await sendWhatsAppText(from, reply);
      return;
    }

    // 4) Buscar en Odoo (por código o por query)
    let products = [];

    if (intentObj.intent === "CODE_LOOKUP" && intentObj.code) {
      products = await odooFindProducts({ code: intentObj.code, limit: 3 });
    } else {
      // SEARCH
      const q = intentObj.query ? String(intentObj.query) : String(text);
      products = await odooFindProducts({ q, limit: 3 });
    }

    // 5) Si no hay coincidencias: OpenAI pide aclaración con guía
    if (!products.length) {
      const reply = await generateReplyWithOpenAI({
        mode: "SIN_COINCIDENCIAS",
        userText: text,
        data: { tips: ["Pide el código del producto (si lo tiene).", "O el nombre exacto (ej: 'display iphone 11 pro max')."] },
        fallback: "No lo encontré en Odoo. ¿Me envías el código o el nombre exacto? 🙏",
      });
      await sendWhatsAppText(from, reply);
      return;
    }

    // 6) Si hay 1 producto: responder directo
    if (products.length === 1) {
      const p = products[0];
      const price = intentObj.want_price ? await odooGetPrice(p) : null;
      const has = intentObj.want_stock ? await odooHasStock(p.id) : null;

      const safe = {
        nombre: p.display_name,
        codigo: p.default_code || null,
        precio: intentObj.want_price ? moneyCOP(price) : null,
        existencia: intentObj.want_stock ? (has ? "HAY" : "NO_HAY") : null,
      };

      const reply = await generateReplyWithOpenAI({
        mode: "RESPUESTA_FINAL",
        userText: text,
        data: { producto: safe },
        fallback: `${safe.nombre}${safe.codigo ? ` (${safe.codigo})` : ""}\n${safe.precio ? `Precio: ${safe.precio}\n` : ""}${safe.existencia ? (safe.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia") : ""}`.trim(),
      });

      sessions.set(from, { pending: null, lastOptions: [p], want_price: intentObj.want_price, want_stock: intentObj.want_stock });
      await sendWhatsAppText(from, reply);
      return;
    }

    // 7) Si hay varias: listar 3 y pedir elección (OpenAI redacta)
    sessions.set(from, { pending: "pick", lastOptions: products, want_price: intentObj.want_price, want_stock: intentObj.want_stock });

    const optionsSafe = products.map((p, i) => ({
      n: i + 1,
      nombre: p.display_name,
      codigo: p.default_code || null,
    }));

    const reply = await generateReplyWithOpenAI({
      mode: "LISTAR_OPCIONES",
      userText: text,
      data: { opciones: optionsSafe },
      fallback:
        `Encontré estas opciones:\n` +
        optionsSafe.map((o) => `${o.n}) ${o.nombre}${o.codigo ? ` (${o.codigo})` : ""}`).join("\n") +
        `\n\n¿Cuál te interesa? (1, 2 o 3)`,
    });

    await sendWhatsAppText(from, reply);
  } catch (err) {
    console.error("❌ Webhook error:", err);
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
