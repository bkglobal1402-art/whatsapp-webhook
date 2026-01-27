process.on("uncaughtException", (err) =>
  console.error("🔥 uncaughtException:", err)
);
process.on("unhandledRejection", (err) =>
  console.error("🔥 unhandledRejection:", err)
);

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
    .replace(/\s+/g, " ")
    .trim();
}

/* =========================
   Catalog cache (Google Sheets CSV)
========================= */
let catalogCache = {
  rows: [],
  updatedAt: 0,
  fuse: null,
};

const FIVE_MIN = 5 * 60 * 1000;

async function loadCatalogFromCSV() {
  const url = process.env.CATALOG_CSV_URL;
  if (!url) throw new Error("Missing CATALOG_CSV_URL");

  const now = Date.now();
  if (catalogCache.rows.length > 0 && now - catalogCache.updatedAt < FIVE_MIN) {
    return catalogCache;
  }

  console.log("📦 Downloading catalog from Google Sheets (CSV)...");

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to download CSV: ${resp.status}`);
  }

  const csvText = await resp.text();

  const records = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
  });

  // Columnas esperadas:
  // Codigo | Producto | Precio_1 | SaldoGeneral | Nombre_Grupo
  const rows = records
    .filter((r) => r.Codigo || r.Producto)
    .map((r) => ({
      Codigo: String(r.Codigo || "").trim(),
      Producto: String(r.Producto || "").trim(),
      Precio_1: String(r.Precio_1 || "").trim(),
      SaldoGeneral: String(r.SaldoGeneral || "").trim(),
      Nombre_Grupo: String(r.Nombre_Grupo || "").trim(),
      _q: normalizeText(`${r.Codigo} ${r.Producto} ${r.Nombre_Grupo}`),
    }));

  const fuse = new Fuse(rows, {
    includeScore: true,
    threshold: 0.35,
    keys: ["Codigo", "Producto", "_q", "Nombre_Grupo"],
  });

  catalogCache = {
    rows,
    updatedAt: Date.now(),
    fuse,
  };

  console.log(`✅ Catalog loaded: ${rows.length} items`);
  return catalogCache;
}

function searchCatalog(query, limit = 6) {
  if (!catalogCache.fuse) return [];

  const raw = String(query || "").trim();
  const q = normalizeText(raw);

  // Match exacto por código
  const exact = catalogCache.rows.find(
    (r) => r.Codigo && r.Codigo === raw
  );
  if (exact) return [exact];

  const results = catalogCache.fuse.search(q).slice(0, limit);
  return results.map((r) => r.item);
}

function formatItemsForPrompt(items) {
  if (!items || items.length === 0) {
    return "No encontré coincidencias en el catálogo.";
  }

  return items
    .map(
      (p, i) =>
        `${i + 1}) Código: ${p.Codigo} | ${p.Producto} | Precio: ${p.Precio_1} | Stock: ${p.SaldoGeneral}`
    )
    .join("\n");
}

/* =========================
   OpenAI
========================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function askOpenAI(userText, catalogContext, catalogOk) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const systemRules = `
Eres un asesor comercial de BK GLOBAL (Colombia).

Estilo:
- Español natural, corto y claro.
- Tono amable y vendedor.

Reglas:
- Si saludan: preséntate corto.
- Si preguntan precio o stock: usa SOLO el catálogo.
- Si hay varias opciones: ofrece 2–3 y pide aclaración.
- Si no está el producto: dilo y pide más datos.
- NO inventes precios ni stock.
- Respuestas de máximo 6 líneas.
`;

  const catalogSystem = catalogOk
    ? `CATÁLOGO (coincidencias encontradas):\n${catalogContext}`
    : `CATÁLOGO NO DISPONIBLE. Indica que estás verificando y pide código o nombre exacto.`;

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

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// Webhook verify (Meta)
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
  // Responder rápido a Meta
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

    let catalogOk = false;
    let catalogContext = "";

    try {
      await loadCatalogFromCSV();
      const matches = searchCatalog(text, 6);
      catalogContext = formatItemsForPrompt(matches);
      catalogOk = true;
    } catch (e) {
      console.error("⚠️ Catalog error:", e.message);
    }

    let reply;
    try {
      reply = await askOpenAI(text, catalogContext, catalogOk);
    } catch (e) {
      console.error("⚠️ OpenAI error:", e.message);
      reply =
        "Hola 👋 Soy BK GLOBAL. Estoy presentando una falla técnica, pero dime qué producto buscas y te ayudo.";
    }

    await sendWhatsAppText(from, reply);
  } catch (err) {
    console.error("❌ Webhook error:", err);
  }
});

/* =========================
   Start
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`✅ Server running on port ${PORT}`)
);
