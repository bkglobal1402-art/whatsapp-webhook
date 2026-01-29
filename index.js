process.on("uncaughtException", (err) => console.error("🔥 uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("🔥 unhandledRejection:", err));

const express = require("express");
const fetch = require("node-fetch");
const OpenAI = require("openai");
const Fuse = require("fuse.js");
const { parse } = require("csv-parse/sync");

const app = express();
app.use(express.json());

/* =========================
   Helpers
========================= */
function normalizeText(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQuery(raw = "") {
  return normalizeText(raw)
    .replace(
      /\b(tienes|tiene|hay|precio|vale|cuesta|disponible|stock|existencia|me|puedes|porfa|porfavor|necesito|quiero|busco|una|un|el|la|los|las|para|de|del|al|y|con|por|que|q|dame|info|informacion|cuanto|muestrame|muestra|quiero saber|por favor|pf)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function stockHasExistence(saldoGeneral) {
  const raw = String(saldoGeneral || "").replace(/\./g, "").replace(",", ".").trim();
  const n = Number(raw);
  if (Number.isNaN(n)) return false;
  return n > 0;
}

function looksLikeCode(text) {
  const t = String(text || "").trim();
  return /^\d{4,}$/.test(t);
}

function detectColor(text) {
  const t = normalizeText(text);
  if (t.includes("negro")) return "NEGRO";
  if (t.includes("blanco")) return "BLANCO";
  return null;
}

/* Quitar "TACTIL" de displays iPhone (para que no lo mencione) */
function prettyProductName(name = "") {
  let s = String(name || "");
  const n = normalizeText(s);
  if (n.includes("display") && n.includes("iphone")) {
    s = s.replace(/t[aá]ctil/gi, "").replace(/\s+/g, " ").trim();
  }
  return s;
}

/* =========================
   Variant engine (solo celulares)
========================= */
const VARIANT_PATTERNS = [
  { key: "PRO MAX", patterns: ["pro max", "promax"] },
  { key: "PRO", patterns: [" pro "] },
  { key: "MINI", patterns: [" mini "] },
  { key: "PLUS", patterns: [" plus "] },
  { key: "MAX", patterns: [" max "] },
  { key: "ULTRA", patterns: [" ultra "] },
  { key: "LITE", patterns: [" lite "] },
  { key: "SE", patterns: [" se "] },
];

function detectVariantFromText(text) {
  const t = ` ${normalizeText(text)} `;
  for (const v of VARIANT_PATTERNS) {
    for (const p of v.patterns) {
      const pp = p.startsWith(" ") ? p : ` ${p} `;
      if (t.includes(pp)) return v.key;
    }
  }
  return null;
}

function classifyVariantFromProductName(productName) {
  const t = ` ${normalizeText(productName)} `;
  for (const v of VARIANT_PATTERNS) {
    for (const p of v.patterns) {
      const pp = p.startsWith(" ") ? p : ` ${p} `;
      if (t.includes(pp)) return v.key;
    }
  }
  return null;
}

function computeVariantOptions(items) {
  const map = new Map();
  for (const p of items) {
    const key = classifyVariantFromProductName(p.Producto);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  const keys = Array.from(map.keys());
  if (keys.length < 2) return null;

  const order = new Map(VARIANT_PATTERNS.map((v, i) => [v.key, i]));
  keys.sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
  return { keys, map };
}

function hasColorMix(items) {
  const hasWhite = items.some((p) => normalizeText(p.Producto).includes("blanco"));
  const hasBlack = items.some((p) => normalizeText(p.Producto).includes("negro"));
  return hasWhite && hasBlack;
}

function filterByColor(items, color) {
  const c = normalizeText(color);
  return items.filter((p) => normalizeText(p.Producto).includes(c));
}

function isCellphoneContext(items, userText) {
  const t = normalizeText(userText);

  const userMentionsPhone =
    t.includes("iphone") ||
    t.includes("samsung") ||
    t.includes("huawei") ||
    t.includes("xiaomi") ||
    t.includes("motorola") ||
    t.includes("oppo") ||
    t.includes("vivo") ||
    t.includes("infinix") ||
    t.includes("tecno");

  const groupLooksPhone = (items || []).some((p) => {
    const g = normalizeText(p.Nombre_Grupo || "");
    return g.includes("repuestos celulares") || g.includes("celular") || g.includes("telefon");
  });

  return userMentionsPhone || groupLooksPhone;
}

/* =========================
   Session memory (RAM)
========================= */
const sessions = new Map();

/* =========================
   Catalog cache
========================= */
let catalogCache = { rows: [], updatedAt: 0, fuse: null };
const FIVE_MIN = 5 * 60 * 1000;

function pick(r, ...names) {
  const keys = Object.keys(r || {});
  const normKey = (k) =>
    String(k)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "")
      .trim();

  const map = new Map(keys.map((k) => [normKey(k), k]));

  for (const n of names) {
    const realKey = map.get(normKey(n));
    if (realKey && r[realKey] != null && String(r[realKey]).trim() !== "") {
      return String(r[realKey]).trim();
    }
  }
  return "";
}

async function loadCatalogFromCSV() {
  const url = process.env.CATALOG_CSV_URL;
  if (!url) throw new Error("Missing CATALOG_CSV_URL");

  const now = Date.now();
  if (catalogCache.rows.length > 0 && now - catalogCache.updatedAt < FIVE_MIN) return catalogCache;

  console.log("📦 Downloading catalog from Google Sheets (CSV)...");

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download CSV: ${resp.status}`);

  const csvText = await resp.text();

  const records = parse(csvText, { columns: true, skip_empty_lines: true });
  console.log("🧾 CSV headers:", Object.keys(records[0] || {}));

  const rows = records
    .map((r) => {
      const Codigo = pick(r, "Codigo", "CODIGO", "Código", "code", "sku", "referencia");
      const Producto = pick(
        r,
        "Producto",
        "PRODUCTO",
        "Nombre_Producto",
        "Nombre",
        "Descripcion",
        "Descripción",
        "description",
        "name"
      );
      const Precio_1 = pick(r, "Precio_1", "Precio1", "Precio 1", "Precio", "price");
      const SaldoGeneral = pick(r, "SaldoGeneral", "Saldo General", "Stock", "Existencias", "Inventario");
      const Nombre_Grupo = pick(r, "Nombre_Grupo", "Nombre Grupo", "Grupo", "Categoria", "Categoría");

      if (!Codigo && !Producto) return null;

      return {
        Codigo,
        Producto,
        Precio_1,
        SaldoGeneral,
        Nombre_Grupo,
        _q: normalizeText(`${Codigo} ${Producto} ${Nombre_Grupo}`),
      };
    })
    .filter(Boolean);

  const fuse = new Fuse(rows, {
    includeScore: true,
    threshold: 0.45,
    keys: ["Codigo", "Producto", "_q", "Nombre_Grupo"],
  });

  catalogCache = { rows, updatedAt: Date.now(), fuse };
  console.log(`✅ Catalog loaded: ${rows.length} items`);
  return catalogCache;
}

function searchCatalog(query, limit = 30) {
  if (!catalogCache.fuse) return [];

  const raw = String(query || "").trim();
  const q = cleanQuery(raw);

  // Match exacto por código
  const exact = catalogCache.rows.find((r) => normalizeText(r.Codigo) === normalizeText(raw));
  if (exact) return [exact];

  if (!q) return [];
  return catalogCache.fuse.search(q).slice(0, limit).map((r) => r.item);
}

/* =========================
   Odoo XML-RPC (SIN CSRF) ✅
   FIXES:
   - Si ODOO_URL termina en /odoo, recorta para RPC
   - 4to param de authenticate debe ser STRUCT (no string)
========================= */
const ODOO_URL = process.env.ODOO_URL; // ej: http://104.225.217.59:5033 o .../odoo
const ODOO_DB = process.env.ODOO_DB;   // ej: odoo_admin_pro
const ODOO_USER = process.env.ODOO_USER;
const ODOO_PASS = process.env.ODOO_PASS;

function getRpcBase(url) {
  const u = String(url || "").replace(/\/+$/, "");
  return u.replace(/\/odoo$/i, "");
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Marca especial para enviar <struct></struct>
const XMLRPC_EMPTY_STRUCT = { __xmlrpc_struct_empty: true };

function xmlValue(v) {
  // Struct vacío (para authenticate)
  if (v && typeof v === "object" && v.__xmlrpc_struct_empty === true) {
    return "<value><struct></struct></value>";
  }

  if (v === null || v === undefined) return "<value><nil/></value>";
  if (typeof v === "number" && Number.isInteger(v)) return `<value><int>${v}</int></value>`;
  if (typeof v === "number") return `<value><double>${v}</double></value>`;
  if (typeof v === "boolean") return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === "string") return `<value><string>${xmlEscape(v)}</string></value>`;

  // fallback seguro: JSON string
  return `<value><string>${xmlEscape(JSON.stringify(v))}</string></value>`;
}

async function xmlrpcCall(url, methodName, params = []) {
  const body =
    `<?xml version="1.0"?>` +
    `<methodCall>` +
    `<methodName>${xmlEscape(methodName)}</methodName>` +
    `<params>` +
    params.map((p) => `<param>${xmlValue(p)}</param>`).join("") +
    `</params>` +
    `</methodCall>`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body,
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`Odoo HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }

  if (text.includes("<fault>")) {
    const faultString =
      text.match(/<name>faultString<\/name>\s*<value>[\s\S]*?<string>([\s\S]*?)<\/string>/)?.[1] ||
      text.slice(0, 200);
    throw new Error(`Odoo XML-RPC fault: ${faultString}`);
  }

  // uid int
  const mInt = text.match(/<(int|i4)>(-?\d+)<\/(int|i4)>/);
  if (mInt) return Number(mInt[2]);

  throw new Error(`Unexpected XML-RPC response: ${text.slice(0, 200)}`);
}

async function odooAuthenticate() {
  if (!ODOO_URL) throw new Error("Missing ODOO_URL env var");
  if (!ODOO_DB) throw new Error("Missing ODOO_DB env var");
  if (!ODOO_USER) throw new Error("Missing ODOO_USER env var");
  if (!ODOO_PASS) throw new Error("Missing ODOO_PASS env var");

  const RPC_BASE = getRpcBase(ODOO_URL);
  const url = `${RPC_BASE}/xmlrpc/2/common`;

  // authenticate(db, login, password, {})
  const uid = await xmlrpcCall(url, "authenticate", [ODOO_DB, ODOO_USER, ODOO_PASS, XMLRPC_EMPTY_STRUCT]);

  if (!uid) throw new Error("Auth failed (uid vacío). Revisa DB/usuario/clave.");
  return uid;
}

/* =========================
   OpenAI
========================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function toSafeOption(p) {
  return {
    codigo: p.Codigo,
    producto: prettyProductName(p.Producto),
    precio: p.Precio_1,
    existencia: stockHasExistence(p.SaldoGeneral) ? "HAY" : "NO_HAY",
    grupo: p.Nombre_Grupo || "",
  };
}

/**
 * 1) CLASIFICADOR “DURO”: OpenAI devuelve SOLO JSON con intención.
 */
async function classifyIntentWithOpenAI({ userText, session }) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const system = `
Eres un clasificador de intención para un bot de WhatsApp de BK GLOBAL.

Devuelve SOLO JSON válido con estas llaves:
{
  "intent": "GREETING" | "PRICES_ALL_LISTED" | "PICK_OPTION" | "CODE_LOOKUP" | "SEARCH" | "ASK_CLARIFY" | "VARIANT" | "COLOR",
  "choice_number": 1|2|3|null,
  "code": "..."|null,
  "variant": "PRO MAX"|"PRO"|"MINI"|"PLUS"|"MAX"|"ULTRA"|"LITE"|"SE"|null,
  "color": "BLANCO"|"NEGRO"|null,
  "search_hint": "..."|null
}

Reglas:
- Si el usuario saluda (hola/buenas/hey/etc) => GREETING.
- Si el usuario pide "precio de cada una", "precio de todas", "los precios", "cuanto valen", "precio de las opciones", "precio de las 3" => PRICES_ALL_LISTED (si hay lista activa).
- Si el usuario dice "1", "2", "3", "la 2", "opcion 3" => PICK_OPTION y choice_number.
- Si el usuario da un número largo tipo código/sku (>=4 dígitos) => CODE_LOOKUP y code.
- Si el usuario menciona BLANCO/NEGRO => COLOR.
- Si el usuario menciona PRO/MAX/PLUS/MINI/LITE/SE/ULTRA => VARIANT.
- Si no es nada de lo anterior => SEARCH (usar search_hint como versión limpia del texto si puedes).
- Si el texto es ambiguo y no hay contexto => ASK_CLARIFY.

IMPORTANTE:
- No inventes. Solo clasificas intención.
`;

  const sess = session || {};
  const listed = Array.isArray(sess.lastOptions)
    ? sess.lastOptions.map((p, i) => ({
        n: i + 1,
        producto: prettyProductName(p.Producto),
        codigo: p.Codigo,
      }))
    : [];

  const user = `
USER_TEXT: ${userText}

SESSION_STATE:
- pending: ${sess.pending || "null"}
- has_listed_options: ${listed.length > 0}
- listed_options: ${JSON.stringify(listed)}
- lastTopicKey: ${sess.lastTopicKey || "null"}

Devuelve el JSON.
`;

  console.log("🧠 Intent classifier CALLED");

  const r = await openai.chat.completions.create({
    model,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const txt = r.choices?.[0]?.message?.content?.trim() || "";
  try {
    const obj = JSON.parse(txt);
    return obj || { intent: "SEARCH" };
  } catch (e) {
    console.error("⚠️ Intent JSON parse failed. Raw:", txt);
    return { intent: "SEARCH" };
  }
}

/**
 * 2) GENERADOR DE RESPUESTA: OpenAI redacta SOLO con CATÁLOGO_DATA.
 */
async function generateReplyWithOpenAI({ userText, mode, catalogData, fallback }) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const system = `
Eres un asesor comercial de BK GLOBAL (Colombia) por WhatsApp.

REGLAS CRÍTICAS:
- NO inventes precios, existencia, productos o códigos.
- Usa ÚNICAMENTE los datos del "CATALOGO_DATA".
- NUNCA muestres cantidad de stock. Solo: "✅ Hay existencia" o "❌ Sin existencia".
- Si el producto es DISPLAY para IPHONE: NO menciones "TACTIL" (asume incluido).
- Español natural, corto y claro (máx 5 líneas).
- Si faltan datos (ej: color/variante), haz UNA sola pregunta clara.
- Devuelve SOLO JSON válido: {"reply":"..."} (sin texto extra).
`;

  const user = `
USER_TEXT:
${userText}

MODE:
${mode}

CATALOGO_DATA (única fuente):
${JSON.stringify(catalogData, null, 2)}
`;

  console.log("🤖 OpenAI REPLY CALLED mode=", mode);

  const r = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const txt = r.choices?.[0]?.message?.content?.trim() || "";
  try {
    const obj = JSON.parse(txt);
    if (obj && typeof obj.reply === "string" && obj.reply.trim()) return obj.reply.trim();
  } catch (e) {
    console.error("⚠️ Reply JSON parse failed. Raw:", txt);
  }

  return fallback || "¿En qué te puedo ayudar? 🙂";
}

/* =========================
   WhatsApp sender
========================= */
async function sendWhatsAppText(to, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.log("❌ Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID");
    return;
  }

  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await resp.json();
  console.log("📤 WhatsApp send response:", resp.status, data);
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

app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_de_prueba";

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

    const from = messages[0]?.from;
    const text = messages[0]?.text?.body || "";
    if (!from || !text) return;

    console.log("✅ Incoming message:", { from, text });

    await loadCatalogFromCSV();
    const sess = sessions.get(from) || { pending: null };

    // 1) Clasificar intención (DURO)
    const intentObj = await classifyIntentWithOpenAI({ userText: text, session: sess });
    const intent = intentObj?.intent || "SEARCH";

    // 2) Manejos rápidos por intención + estado
    if (intent === "GREETING") {
      const reply = await generateReplyWithOpenAI({
        userText: text,
        mode: "SALUDO_SIMPLE",
        catalogData: { note: "Solo saludar y preguntar en qué ayudar. No ofrecer líneas." },
        fallback: "Hola 👋 ¿En qué te puedo ayudar?",
      });
      await sendWhatsAppText(from, reply);
      return;
    }

    // Si estaban pidiendo VARIANT/COLOR, usar la info si OpenAI la detectó
    if (sess.pending === "variant") {
      const v = intentObj.variant || detectVariantFromText(text);
      if (!v) {
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "PREGUNTAR_VARIANTE",
          catalogData: { variantes: sess.variantKeys || [] },
          fallback: `¿Cuál necesitas: ${(sess.variantKeys || []).join(", ")}?`,
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      const filtered = (sess.items || []).filter((p) => classifyVariantFromProductName(p.Producto) === v);
      if (filtered.length === 0) {
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "VARIANTE_NO_DISPONIBLE",
          catalogData: { variantes: sess.variantKeys || [] },
          fallback: `No veo esa variante. ¿Cuál necesitas: ${(sess.variantKeys || []).join(", ")}?`,
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      // color si aplica
      const c = intentObj.color || detectColor(text);
      if (hasColorMix(filtered) && !c) {
        sessions.set(from, { ...sess, pending: "color", items: filtered });
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "PREGUNTAR_COLOR",
          catalogData: { colores: ["BLANCO", "NEGRO"] },
          fallback: "¿Lo necesitas en BLANCO o NEGRO?",
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      const finalList = c ? filterByColor(filtered, c) : filtered;
      const chosenSafe = toSafeOption(finalList[0]);

      const reply = await generateReplyWithOpenAI({
        userText: text,
        mode: "RESPONDER_PRECIO_Y_EXISTENCIA_FINAL",
        catalogData: { producto: chosenSafe },
        fallback: `${chosenSafe.producto}\nPrecio: ${chosenSafe.precio}\n${
          chosenSafe.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia"
        }`,
      });

      sessions.delete(from);
      await sendWhatsAppText(from, reply);
      return;
    }

    if (sess.pending === "color") {
      const c = intentObj.color || detectColor(text);
      if (!c) {
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "PREGUNTAR_COLOR",
          catalogData: { colores: ["BLANCO", "NEGRO"] },
          fallback: "¿Lo necesitas en BLANCO o NEGRO?",
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      const chosen = filterByColor(sess.items || [], c);
      if (chosen.length === 0) {
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "COLOR_NO_DISPONIBLE",
          catalogData: { color: c, colores: ["BLANCO", "NEGRO"] },
          fallback: `En ${c} no lo veo. ¿BLANCO o NEGRO?`,
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      const chosenSafe = toSafeOption(chosen[0]);
      const reply = await generateReplyWithOpenAI({
        userText: text,
        mode: "RESPONDER_PRECIO_Y_EXISTENCIA_FINAL",
        catalogData: { producto: chosenSafe },
        fallback: `${chosenSafe.producto}\nPrecio: ${chosenSafe.precio}\n${
          chosenSafe.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia"
        }`,
      });

      sessions.delete(from);
      await sendWhatsAppText(from, reply);
      return;
    }

    // PRICES_ALL_LISTED: si hay lista activa, responder precios de todas las listadas
    if (intent === "PRICES_ALL_LISTED" && Array.isArray(sess.lastOptions) && sess.lastOptions.length > 0) {
      const opts = sess.lastOptions.map(toSafeOption);

      const reply = await generateReplyWithOpenAI({
        userText: text,
        mode: "MOSTRAR_PRECIOS_DE_LISTA_ACTUAL",
        catalogData: { opciones: opts },
        fallback: opts
          .map(
            (o, i) =>
              `${i + 1}) ${o.producto}\nPrecio: ${o.precio}\n${
                o.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia"
              }`
          )
          .join("\n\n"),
      });

      await sendWhatsAppText(from, reply);
      return;
    }

    // PICK_OPTION: si hay lista activa, responder opción elegida
    if (intent === "PICK_OPTION" && Array.isArray(sess.lastOptions) && sess.lastOptions.length > 0) {
      const n = intentObj.choice_number;
      const idx = typeof n === "number" ? n - 1 : -1;
      const chosen = sess.lastOptions[idx];

      if (chosen) {
        const chosenSafe = toSafeOption(chosen);
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "RESPONDER_PRECIO_Y_EXISTENCIA_DE_OPCION_ELEGIDA",
          catalogData: { opcion_elegida: chosenSafe },
          fallback: `${chosenSafe.producto}\nPrecio: ${chosenSafe.precio}\n${
            chosenSafe.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia"
          }`,
        });

        sessions.set(from, { ...sess, pending: null });
        await sendWhatsAppText(from, reply);
        return;
      }
    }

    // CODE_LOOKUP: buscar por código
    if (intent === "CODE_LOOKUP" || looksLikeCode(text)) {
      const code = intentObj.code || String(text).trim();
      const byCode = catalogCache.rows.find((r) => normalizeText(r.Codigo) === normalizeText(code));
      if (byCode) {
        const safe = toSafeOption(byCode);
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "RESPONDER_PRECIO_Y_EXISTENCIA_POR_CODIGO",
          catalogData: { producto: safe },
          fallback: `${safe.producto}\nPrecio: ${safe.precio}\n${safe.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia"}`,
        });

        const topicKey = normalizeText(byCode.Nombre_Grupo || "");
        sessions.set(from, { pending: null, lastOptions: [byCode], lastTopicKey: topicKey });
        await sendWhatsAppText(from, reply);
        return;
      }
    }

    // SEARCH (o fallback): buscar por catálogo
    let matches = searchCatalog(intentObj.search_hint || text, 30);

    console.log("🔎 Search raw:", text);
    console.log("🔎 Search clean:", cleanQuery(text));
    console.log("🔎 Matches:", matches.slice(0, 5).map((m) => m.Producto));

    if (matches.length === 0) {
      const reply = await generateReplyWithOpenAI({
        userText: text,
        mode: "SIN_COINCIDENCIAS_PEDIR_ACLARACION",
        catalogData: { note: "No hay coincidencias. Pedir código o nombre exacto." },
        fallback: "No lo encontré en el catálogo. ¿Me compartes el nombre exacto o el código?",
      });
      await sendWhatsAppText(from, reply);
      return;
    }

    // Variantes SOLO si parece celulares
    const allowVariants = isCellphoneContext(matches, text);
    if (allowVariants) {
      const userVariant = intentObj.variant || detectVariantFromText(text);
      let refined = matches;

      if (userVariant) {
        const filtered = matches.filter((p) => classifyVariantFromProductName(p.Producto) === userVariant);
        if (filtered.length > 0) refined = filtered;
      }

      const variantOptions = computeVariantOptions(refined);
      if (!userVariant && variantOptions) {
        sessions.set(from, {
          pending: "variant",
          items: refined,
          variantKeys: variantOptions.keys,
          lastTopicKey: sess.lastTopicKey || null,
        });
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "PREGUNTAR_VARIANTE",
          catalogData: { variantes: variantOptions.keys },
          fallback: `¿Cuál necesitas: ${variantOptions.keys.join(", ")}?`,
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      // color si aplica
      const c = intentObj.color || detectColor(text);
      if (hasColorMix(refined) && !c) {
        sessions.set(from, { pending: "color", items: refined, lastTopicKey: sess.lastTopicKey || null });
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "PREGUNTAR_COLOR",
          catalogData: { colores: ["BLANCO", "NEGRO"] },
          fallback: "¿Lo necesitas en BLANCO o NEGRO?",
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      if (c) {
        const chosen = filterByColor(refined, c);
        if (chosen.length > 0) refined = chosen;
      }
    }

    // match único => responder
    if (matches.length === 1) {
      const p = matches[0];
      const safe = toSafeOption(p);

      const reply = await generateReplyWithOpenAI({
        userText: text,
        mode: "RESPONDER_PRECIO_Y_EXISTENCIA_FINAL",
        catalogData: { producto: safe },
        fallback: `${safe.producto}\nPrecio: ${safe.precio}\n${safe.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia"}`,
      });

      const topicKey = normalizeText(p.Nombre_Grupo || "");
      sessions.set(from, { pending: null, lastOptions: [p], lastTopicKey: topicKey });
      await sendWhatsAppText(from, reply);
      return;
    }

    // múltiples => listar 3 y guardar estado pick
    const lastOptions = matches.slice(0, 3);
    const topicKey = normalizeText(lastOptions[0]?.Nombre_Grupo || "");

    sessions.set(from, { pending: "pick", lastOptions, lastTopicKey: topicKey });

    const reply = await generateReplyWithOpenAI({
      userText: text,
      mode: "MOSTRAR_LISTA_DE_OPCIONES_Y_PEDIR_ELECCION",
      catalogData: {
        opciones: lastOptions.map((p, i) => ({
          n: i + 1,
          producto: prettyProductName(p.Producto),
          codigo: p.Codigo,
        })),
      },
      fallback:
        `Encontré estas opciones:\n` +
        lastOptions.map((p, i) => `${i + 1}) ${prettyProductName(p.Producto)}`).join("\n") +
        `\n\n¿Cuál te interesa? (1, 2, 3 o el código)\nSi quieres el precio de todas, escribe: "precio de cada una"`,
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
