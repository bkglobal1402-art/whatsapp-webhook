process.on("uncaughtException", (err) => console.error("🔥 uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("🔥 unhandledRejection:", err));

const express = require("express");
const fetch = require("node-fetch");
const OpenAI = require("openai");
const XLSX = require("xlsx");
const Fuse = require("fuse.js");

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
    .replace(/\s+/g, " ")
    .trim();
}

function safeNumberString(v) {
  // Deja tal cual venga (porque tu Excel trae "20.000,00" etc.)
  return String(v ?? "").trim();
}

/* =========================
   Catalog cache + loader
========================= */
let catalogCache = {
  rows: [],
  updatedAt: 0,
  fuse: null,
  sheetName: null,
};

const FIVE_MIN = 5 * 60 * 1000;

async function loadCatalogFromXlsx() {
  const url = process.env.CATALOG_XLSX_URL;
  if (!url) throw new Error("Missing CATALOG_XLSX_URL");

  const now = Date.now();
  if (catalogCache.rows.length > 0 && now - catalogCache.updatedAt < FIVE_MIN) {
    return catalogCache; // cache fresh
  }

  console.log("📦 Downloading XLSX catalog...");
  const resp = await fetch(url, {
    method: "GET",
    // Tip: algunos links necesitan un user-agent para no bot-block
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!resp.ok) {
    throw new Error(`Failed to download XLSX: ${resp.status}`);
  }

  const buf = await resp.buffer();
  const wb = XLSX.read(buf, { type: "buffer" });

  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  // Espera columnas: Codigo, Producto, Precio_1, SaldoGeneral, Nombre_Grupo
  const normalizedRows = rows
    .filter((r) => r.Codigo || r.Producto)
    .map((r) => ({
      Codigo: String(r.Codigo || "").trim(),
      Producto: String(r.Producto || "").trim(),
      Precio_1: safeNumberString(r.Precio_1),
      SaldoGeneral: safeNumberString(r.SaldoGeneral),
      Nombre_Grupo: String(r.Nombre_Grupo || "").trim(),
      _q: normalizeText(`${r.Codigo} ${r.Producto} ${r.Nombre_Grupo}`),
    }));

  const fuse = new Fuse(normalizedRows, {
    includeScore: true,
    threshold: 0.35,
    keys: ["Codigo", "Producto", "_q", "Nombre_Grupo"],
  });

  catalogCache = {
    rows: normalizedRows,
    updatedAt: Date.now(),
    fuse,
    sheetName,
  };

  console.log(`✅ Catalog loaded: ${normalizedRows.length} items (sheet: ${sheetName})`);
  return catalogCache;
}

function searchCatalog(query, limit = 6) {
  if (!catalogCache.fuse) return [];
  const raw = String(query || "").trim();
  const q = normalizeText(raw);

  // match exacto por código
  const exact = catalogCache.rows.find((r) => r.Codigo && r.Codigo === raw);
  if (exact) return [exact];

  const results = catalogCache.fuse.search(q).slice(0, limit);
  return results.map((r) => r.item);
}

function formatItemsForPrompt(items) {
  if (!items || items.length === 0) return "No encontré coincidencias en el catálogo.";

  return items
    .map((p, i) => {
      return `${i + 1}) Codigo: ${p.Codigo} | Producto: ${p.Producto} | Precio_1: ${p.Precio_1} | Stock(SaldoGeneral): ${p.SaldoGeneral} | Grupo: ${p.Nombre_Grupo}`;
    })
    .join("\n");
}

/* =========================
   OpenAI
========================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function askOpenAI(userText, catalogContextText, catalogOk) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const systemRules =
    `Eres un asesor comercial de BK GLOBAL (Colombia). ` +
    `Respondes en español, natural, amable y directo. ` +
    `Objetivo: ayudar al cliente y vender.\n\n` +
    `Reglas:\n` +
    `- Si te saludan: te presentas corto.\n` +
    `- Si preguntan por precio/stock: responde usando el catálogo (Precio_1 y SaldoGeneral) si está disponible.\n` +
    `- Si hay varias coincidencias: ofrece 2-3 opciones y pide una aclaración (marca/modelo/código).\n` +
    `- Si NO encuentras el producto: pide marca/modelo/código y sugiere alternativas por grupo si aplica.\n` +
    `- No inventes precios ni stock.\n` +
    `- Respuestas cortas: 2 a 6 líneas máximo.\n`;

  const catalogSystem =
    catalogOk
      ? `CATÁLOGO (coincidencias para esta conversación):\n${catalogContextText}`
      : `CATÁLOGO: No disponible en este momento (responde sin inventar precios/stock; ofrece verificar si el cliente da código o más detalles).`;

  const r = await openai.chat.completions.create({
    model,
    temperature: 0.4,
    messages: [
      { role: "system", content: systemRules },
      { role: "system", content: catalogSystem },
      { role: "user", content: userText },
    ],
  });

  return (
    r.choices?.[0]?.message?.content?.trim() ||
    "Hola 👋 Soy BK GLOBAL. ¿Qué producto estás buscando?"
  );
}

/* =========================
   WhatsApp send
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

// Home
app.get("/", (req, res) => res.status(200).send("OK"));

// Webhook verify
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "mi_token_de_prueba";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Webhook events
app.post("/webhook", async (req, res) => {
  try {
    // IMPORTANTE: responder 200 rápido a Meta
    res.sendStatus(200);

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages;
    if (!messages || messages.length === 0) return;

    const from = messages[0]?.from;
    const text = messages[0]?.text?.body || "";

    if (!from || !text) return;

    console.log("✅ Incoming message:", { from, text });

    // 1) Intentar cargar catálogo UNA sola vez por mensaje (con fallback)
    let catalogOk = false;
    let catalogContextText = "";
    try {
      await loadCatalogFromXlsx();
      const matches = searchCatalog(text, 6);
      catalogContextText = formatItemsForPrompt(matches);
      catalogOk = true;
    } catch (e) {
      console.error("⚠️ Catalog not available, continuing without it:", e?.message);
      catalogOk = false;
      catalogContextText = "";
    }

    // 2) OpenAI con fallback
    let aiReply = "";
    try {
      aiReply = await askOpenAI(text, catalogContextText, catalogOk);
    } catch (e) {
      console.error("⚠️ OpenAI failed, using fallback:", e?.message);
      aiReply =
        "Hola 👋 Soy BK GLOBAL. En este momento tengo una falla técnica, pero dime el código o nombre del producto y te ayudo.";
    }

    // 3) Enviar WhatsApp
    await sendWhatsAppText(from, aiReply);
  } catch (err) {
    console.log("❌ Error in webhook:", err);
    // ya respondimos 200 arriba, no hacemos nada más
  }
});

/* =========================
   Start
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
