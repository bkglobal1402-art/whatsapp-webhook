process.on("uncaughtException", (err) => console.error("🔥 uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("🔥 unhandledRejection:", err));

const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

/* =========================
   ENV (Railway Variables)
========================= */
const ODOO_URL = process.env.ODOO_URL;      // ej: http://104.225.217.59:5033  (mejor SIN /odoo)
const ODOO_DB = process.env.ODOO_DB;        // ej: odoo_admin_pro
const ODOO_USER = process.env.ODOO_USER;    // ej: bot@bkglobal.com.co
const ODOO_PASS = process.env.ODOO_PASS;    // contraseña del bot
const PRICELIST_ID = process.env.ODOO_PRICELIST_ID ? Number(process.env.ODOO_PRICELIST_ID) : null;

// WhatsApp Cloud API
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_de_prueba";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

/* =========================
   Helpers
========================= */
function getRpcBase(url) {
  // Si alguien deja .../odoo, lo recortamos para /jsonrpc
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

function looksLikeCode(text) {
  const t = String(text || "").trim();
  return /^\d{4,}$/.test(t);
}

function detectIntent(text) {
  const t = norm(text);

  const wantsPrice =
    t.includes("precio") || t.includes("vale") || t.includes("cuesta") || t.includes("valor");

  const wantsStock =
    t.includes("hay") ||
    t.includes("existencia") ||
    t.includes("disponible") ||
    t.includes("stock") ||
    t.includes("tienen");

  // por defecto: ambos (para responder completo)
  return {
    wantsPrice: wantsPrice || (!wantsPrice && !wantsStock),
    wantsStock: wantsStock || (!wantsPrice && !wantsStock),
  };
}

function cleanQuery(text) {
  // Limpia muletillas para buscar mejor por nombre
  return norm(text)
    .replace(
      /\b(tienes|tiene|hay|precio|vale|cuesta|disponible|stock|existencia|me|puedes|porfa|porfavor|necesito|quiero|busco|una|un|el|la|los|las|para|de|del|al|y|con|por|que|q|dame|info|informacion|cuanto|muestrame|muestra|por favor|pf)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================
   Odoo JSON-RPC
========================= */
let authCache = { uid: null, at: 0 };
const AUTH_TTL_MS = 10 * 60 * 1000; // 10 min

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

/* =========================
   Odoo Queries
========================= */

// Busca productos por código (default_code) o por nombre (ilike).
// Devuelve hasta `limit` productos con id, display_name, default_code, list_price, type.
async function odooFindProducts({ code = null, q = null, limit = 5 }) {
  const domain = [];

  if (code) {
    domain.push(["default_code", "=", String(code).trim()]);
  } else if (q) {
    const qq = String(q).trim();
    // Busca por nombre o por código parcial
    domain.push("|", ["name", "ilike", qq], ["default_code", "ilike", qq]);
  } else {
    return [];
  }

  // product.product suele ser lo más directo para default_code
  const fields = ["id", "display_name", "default_code", "list_price", "type", "product_tmpl_id"];
  const products = await odooExecuteKw("product.product", "search_read", [domain], {
    fields,
    limit,
    order: "id desc",
  });

  return Array.isArray(products) ? products : [];
}

// Existencia “HAY/NO HAY” sin mostrar cantidades.
// Suma quantity - reserved_quantity en ubicaciones internas.
async function odooHasStock(productId) {
  if (!productId) return false;

  const quants = await odooExecuteKw("stock.quant", "search_read", [[
    ["product_id", "=", productId],
    ["location_id.usage", "=", "internal"],
  ]], {
    fields: ["quantity", "reserved_quantity"],
    limit: 2000,
  });

  let available = 0;
  for (const q of quants || []) {
    const qty = Number(q.quantity || 0);
    const res = Number(q.reserved_quantity || 0);
    available += (qty - res);
  }
  return available > 0;
}

// Precio: usa list_price (precio de venta).
// Si luego quieres pricelist real, lo agregamos, pero list_price es lo más estable.
async function odooGetPrice(product) {
  // product.list_price ya viene en search_read
  const p = Number(product?.list_price ?? 0);
  return isFinite(p) ? p : 0;
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
   Session (para elegir 1/2/3)
========================= */
const sessions = new Map();
/*
sessions.get(from) = {
  pending: "pick" | null,
  lastOptions: [ {id, display_name, default_code, list_price, ...} ],
  wantsPrice: boolean,
  wantsStock: boolean
}
*/

/* =========================
   Format response
========================= */
function formatOptionLine(p, i) {
  const code = p.default_code ? ` (${p.default_code})` : "";
  return `${i + 1}) ${p.display_name}${code}`;
}

function moneyCOP(n) {
  // formato simple (sin depender de locale)
  const x = Math.round(Number(n || 0));
  return `$${x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

/* =========================
   Routes
========================= */
app.get("/", (req, res) => res.status(200).send("OK"));

/** ✅ Test Odoo */
app.get("/test-odoo", async (req, res) => {
  try {
    const uid = await odooAuthenticate();
    res.json({ ok: true, uid });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** Buscar productos */
app.get("/odoo-find", async (req, res) => {
  try {
    const code = req.query.code ? String(req.query.code) : null;
    const q = req.query.q ? String(req.query.q) : null;

    const products = await odooFindProducts({ code, q, limit: 10 });
    res.json({ ok: true, count: products.length, products });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** Stock (HAY/NO HAY) por código */
app.get("/odoo-stock", async (req, res) => {
  try {
    const code = String(req.query.code || "").trim();
    if (!code) return res.status(400).json({ ok: false, error: "Missing ?code=" });

    const products = await odooFindProducts({ code, limit: 1 });
    if (!products.length) return res.json({ ok: true, found: false });

    const has = await odooHasStock(products[0].id);
    res.json({ ok: true, found: true, code, product: products[0].display_name, stock: has ? "HAY" : "NO_HAY" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/** Precio por código (list_price) */
app.get("/odoo-price", async (req, res) => {
  try {
    const code = String(req.query.code || "").trim();
    if (!code) return res.status(400).json({ ok: false, error: "Missing ?code=" });

    const products = await odooFindProducts({ code, limit: 1 });
    if (!products.length) return res.json({ ok: true, found: false });

    const price = await odooGetPrice(products[0]);
    res.json({ ok: true, found: true, code, product: products[0].display_name, price });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/* =========================
   WhatsApp webhook verify
========================= */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* =========================
   WhatsApp webhook receive
========================= */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    const from = messages[0]?.from;
    const text = messages[0]?.text?.body || "";
    if (!from || !text) return;

    console.log("✅ Incoming message:", { from, text });

    const t = text.trim();
    const intent = detectIntent(t);

    // Si hay sesión de escoger 1/2/3
    const sess = sessions.get(from);
    if (sess?.pending === "pick") {
      const n = Number(t.replace(/[^\d]/g, ""));
      const idx = Number.isFinite(n) ? n - 1 : -1;
      const chosen = sess.lastOptions?.[idx];

      if (!chosen) {
        await sendWhatsAppText(from, "Dime 1, 2 o 3 para escoger una opción 🙂");
        return;
      }

      const price = sess.wantsPrice ? await odooGetPrice(chosen) : null;
      const has = sess.wantsStock ? await odooHasStock(chosen.id) : null;

      let reply = `${chosen.display_name}${chosen.default_code ? ` (${chosen.default_code})` : ""}\n`;
      if (sess.wantsPrice) reply += `Precio: ${moneyCOP(price)}\n`;
      if (sess.wantsStock) reply += has ? "✅ Hay existencia" : "❌ Sin existencia";

      sessions.delete(from);
      await sendWhatsAppText(from, reply.trim());
      return;
    }

    // Flujo normal: buscar por código o por nombre
    let products = [];
    if (looksLikeCode(t)) {
      products = await odooFindProducts({ code: t, limit: 3 });
    } else {
      const q = cleanQuery(t);
      products = await odooFindProducts({ q, limit: 3 });
    }

    if (!products.length) {
      await sendWhatsAppText(from, "No lo encontré en Odoo. ¿Me envías el código o el nombre exacto? 🙏");
      return;
    }

    // Si encontró 1 producto: responder directo
    if (products.length === 1) {
      const p = products[0];
      const price = intent.wantsPrice ? await odooGetPrice(p) : null;
      const has = intent.wantsStock ? await odooHasStock(p.id) : null;

      let reply = `${p.display_name}${p.default_code ? ` (${p.default_code})` : ""}\n`;
      if (intent.wantsPrice) reply += `Precio: ${moneyCOP(price)}\n`;
      if (intent.wantsStock) reply += has ? "✅ Hay existencia" : "❌ Sin existencia";

      await sendWhatsAppText(from, reply.trim());
      return;
    }

    // Múltiples: listar y pedir opción
    sessions.set(from, {
      pending: "pick",
      lastOptions: products,
      wantsPrice: intent.wantsPrice,
      wantsStock: intent.wantsStock,
    });

    const list = products.map((p, i) => formatOptionLine(p, i)).join("\n");
    await sendWhatsAppText(
      from,
      `Encontré estas opciones:\n${list}\n\n¿Cuál te interesa? (1, 2 o 3)`
    );
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
