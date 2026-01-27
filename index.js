process.on("uncaughtException", (err) => {
  console.error("🔥 uncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("🔥 unhandledRejection:", err);
});

const express = require("express");
const fetch = require("node-fetch");
const OpenAI = require("openai");
const XLSX = require("xlsx");
const Fuse = require("fuse.js");

const app = express();
app.use(express.json());

let catalogCache = {
  rows: [],
  updatedAt: 0,
  fuse: null,
};

function normalizeText(s = "") {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadCatalogFromXlsx() {
  const url = process.env.CATALOG_XLSX_URL;
  if (!url) {
    console.log("❌ Missing CATALOG_XLSX_URL");
    return;
  }

  // refrescar cada 5 min
  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;
  if (catalogCache.rows.length > 0 && now - catalogCache.updatedAt < FIVE_MIN) return;

  console.log("📦 Downloading XLSX catalog...");
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to download XLSX: ${resp.status}`);

  const buf = await resp.buffer();
  const wb = XLSX.read(buf, { type: "buffer" });

  // Usa la primera hoja (o cámbiala por nombre si quieres)
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];

  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  // Espera columnas: Codigo, Producto, Precio_1, SaldoGeneral, Nombre_Grupo
  const normalizedRows = rows
    .filter(r => r.Codigo || r.Producto)
    .map(r => ({
      Codigo: String(r.Codigo || "").trim(),
      Producto: String(r.Producto || "").trim(),
      Precio_1: String(r.Precio_1 || "").trim(),
      SaldoGeneral: String(r.SaldoGeneral || "").trim(),
      Nombre_Grupo: String(r.Nombre_Grupo || "").trim(),
      _q: normalizeText(`${r.Codigo} ${r.Producto} ${r.Nombre_Grupo}`),
    }));

  const fuse = new Fuse(normalizedRows, {
    includeScore: true,
    threshold: 0.35, // más bajo = más estricto
    keys: ["Codigo", "Producto", "_q", "Nombre_Grupo"],
  });

  catalogCache = {
    rows: normalizedRows,
    updatedAt: Date.now(),
    fuse,
  };

  console.log(`✅ Catalog loaded: ${normalizedRows.length} items (sheet: ${sheetName})`);
}

function searchCatalog(query, limit = 5) {
  if (!catalogCache.fuse) return [];
  const q = normalizeText(query);

  // si el usuario escribe un código exacto, primero intentamos match exacto
  const exact = catalogCache.rows.find(r => r.Codigo && r.Codigo === query.trim());
  if (exact) return [exact];

  const results = catalogCache.fuse.search(q).slice(0, limit);
  return results.map(r => r.item);
}

function formatItemsForPrompt(items) {
  if (!items || items.length === 0) return "No encontré coincidencias en el catálogo.";

  return items
    .map((p, i) => {
      return `${i + 1}) Codigo: ${p.Codigo} | Producto: ${p.Producto} | Precio_1: ${p.Precio_1} | Stock(SaldoGeneral): ${p.SaldoGeneral} | Grupo: ${p.Nombre_Grupo}`;
    })
    .join("\n");
}


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ✅ Home test
app.get("/", (req, res) => res.status(200).send("OK"));

// ✅ Meta webhook verification (GET)
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

async function askOpenAI(userText) {
  // 1) asegúrate de tener catálogo
  await loadCatalogFromXlsx();

  // 2) busca productos relacionados con lo que preguntó el cliente
  const matches = searchCatalog(userText, 6);
  const catalogContext = formatItemsForPrompt(matches);

  const r = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          `Eres un asesor comercial de BK GLOBAL (Colombia).
Respondes en español, natural, amable y directo.
Objetivo: vender y ayudar a elegir el producto correcto.

Reglas:
- Si te saludan: te presentas corto.
- Si preguntan por precio/stock: responde usando el catálogo (Precio_1 y SaldoGeneral).
- Si hay varias coincidencias: pregunta una aclaración corta (marca/modelo/código) y ofrece 2-3 opciones.
- Si NO encuentras el producto: pide un dato (marca/modelo/código) y ofrece alternativas por grupo si aplica.
- No inventes precios ni stock: si no está en catálogo di "no lo tengo en el listado".
- Formato recomendado: 2-6 líneas máximo, con bullets si es necesario.`,
      },
      {
        role: "system",
        content:
          `CATÁLOGO (coincidencias para esta conversación):
${catalogContext}`,
      },
      { role: "user", content: userText },
    ],
    temperature: 0.4,
  });

  return (
    r.choices?.[0]?.message?.content?.trim() ||
    "Hola 👋 Soy BK GLOBAL. ¿Qué producto estás buscando?"
  );
}


// ✅ Send WhatsApp text
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

// ✅ Meta events (POST)
app.post("/webhook", async (req, res) => {
  try {
    console.log("📩 Webhook event:", JSON.stringify(req.body, null, 2));

    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    const messages = value?.messages;
    if (!messages || messages.length === 0) {
      return res.sendStatus(200);
    }

    const from = messages[0]?.from;
    const text = messages[0]?.text?.body || "";

    console.log("✅ Incoming message:", { from, text });

    // ✅ NUEVO: intento cargar catálogo
    let catalog = null;
    try {
      catalog = await loadCatalogFromXlsx(); // tu función existente
    } catch (e) {
      console.error("⚠️ Catalog not available, continuing without it:", e?.message);
    }

    // ✅ OpenAI responde con o sin catálogo
    const aiReply = await askOpenAI(text, catalog);
    await sendWhatsAppText(from, aiReply);

    return res.sendStatus(200);
  } catch (err) {
    console.log("❌ Error in webhook:", err);
    return res.sendStatus(200);
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
