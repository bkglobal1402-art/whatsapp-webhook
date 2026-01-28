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
      /\b(tienes|tiene|hay|precio|vale|cuesta|disponible|stock|me|puedes|porfa|porfavor|necesito|quiero|busco|una|un|el|la|los|las|para|de|del|al|y|con|por|que|q|dame|info|informacion)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function isGreeting(text) {
  const t = normalizeText(text);
  // si el mensaje empieza con saludo
  return ["hola", "buenas", "hey", "buenos dias", "buenas tardes", "buenas noches"].some(
    (w) => t === w || t.startsWith(w + " ")
  );
}

function asksPriceOrAvailability(text) {
  const t = normalizeText(text);
  return ["precio", "vale", "cuesta", "disponible", "hay", "existencia", "stock", "tienen"].some((w) =>
    t.includes(w)
  );
}

function detectColor(text) {
  const t = normalizeText(text);
  if (t.includes("negro")) return "NEGRO";
  if (t.includes("blanco")) return "BLANCO";
  return null;
}

function isDisplayIntent(text) {
  const t = normalizeText(text);
  return ["display", "pantalla", "lcd", "tactil", "touch"].some((w) => t.includes(w));
}

function mentionsIphone7(text) {
  const t = normalizeText(text);
  return t.includes("iphone 7") || t.includes("iphone7") || t.includes("ip 7");
}

function mentionsIphone7Plus(text) {
  const t = normalizeText(text);
  return t.includes("iphone 7 plus") || t.includes("iphone7 plus") || t.includes("7 plus");
}

function stockHasExistence(saldoGeneral) {
  const raw = String(saldoGeneral || "").replace(/\./g, "").replace(",", ".").trim();
  const n = Number(raw);
  if (Number.isNaN(n)) return false;
  return n > 0;
}

function availabilityText(saldoGeneral) {
  return stockHasExistence(saldoGeneral) ? "✅ Hay existencia" : "❌ Sin existencia";
}

function productHasAny(p, words) {
  const t = normalizeText(p.Producto);
  return words.some((w) => t.includes(w));
}

function filterByColor(items, color) {
  const c = normalizeText(color);
  return items.filter((p) => normalizeText(p.Producto).includes(c));
}

/* =========================
   Session memory (RAM)
========================= */
const sessions = new Map();
/*
sessions.get(from) = {
  pending: "iphone_variant" | "color",
  intent: "display_iphone7",
  items: [...]
}
*/

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
      const Producto = pick(r, "Producto", "PRODUCTO", "Nombre_Producto", "Nombre", "Descripcion", "Descripción", "description", "name");
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

function searchCatalog(query, limit = 15) {
  if (!catalogCache.fuse) return [];

  const raw = String(query || "").trim();
  const q = cleanQuery(raw);

  // exact por código
  const exact = catalogCache.rows.find(
    (r) => normalizeText(r.Codigo) && normalizeText(r.Codigo) === normalizeText(raw)
  );
  if (exact) return [exact];

  if (!q) return [];

  let items = catalogCache.fuse.search(q).map((r) => r.item);

  // Si piden display, filtra a solo display/pantalla (si hay)
  if (isDisplayIntent(raw)) {
    const filtered = items.filter((p) =>
      productHasAny(p, ["display", "pantalla", "lcd", "tactil", "touch"])
    );
    if (filtered.length > 0) items = filtered;
  }

  return items.slice(0, limit);
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
   OpenAI (solo para conversación general)
========================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function askOpenAI(userText) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const systemRules = `
Eres asesor comercial de BK GLOBAL.
Responde en español natural, corto y claro (máx 5 líneas).
No inventes precios ni disponibilidad.
Si falta información del cliente, haz 1 pregunta para aclarar.
`;

  const r = await openai.chat.completions.create({
    model,
    temperature: 0.4,
    messages: [
      { role: "system", content: systemRules },
      { role: "user", content: userText },
    ],
  });

  return r.choices?.[0]?.message?.content?.trim() || "¿En qué te puedo ayudar? 🙂";
}

/* =========================
   Formatting (sin cantidades)
========================= */
function formatOneProduct(p) {
  return `${p.Producto}\nPrecio: ${p.Precio_1}\n${availabilityText(p.SaldoGeneral)}`;
}

/* =========================
   Routes
========================= */
app.get("/", (req, res) => res.status(200).send("OK"));

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

    // 1) Saludo simple (NO listar líneas)
    if (isGreeting(text)) {
      await sendWhatsAppText(from, "Hola 👋 ¿En qué te puedo ayudar?");
      return;
    }

    // 2) Si estamos esperando respuesta del cliente (7 vs 7 Plus / color)
    const sess = sessions.get(from);
    if (sess?.pending === "iphone_variant") {
      const t = normalizeText(text);

      const saysPlus = t.includes("plus");
      const saysSeven = t.includes("7") || t.includes("iphone 7") || t.includes("iphone7");

      if (!saysSeven) {
        await sendWhatsAppText(from, "¿Es iPhone 7 normal o iPhone 7 Plus?");
        return;
      }

      const itemsForVariant = saysPlus
        ? (sess.items || []).filter((p) => normalizeText(p.Producto).includes("7 plus"))
        : (sess.items || []).filter(
            (p) => normalizeText(p.Producto).includes("iphone 7") && !normalizeText(p.Producto).includes("7 plus")
          );

      if (itemsForVariant.length === 0) {
        sessions.delete(from);
        await sendWhatsAppText(from, "Listo. No lo veo disponible para ese modelo. ¿Me confirmas el modelo exacto y si lo necesitas con táctil?");
        return;
      }

      sessions.set(from, { pending: "color", intent: sess.intent, items: itemsForVariant });
      await sendWhatsAppText(from, "Perfecto 👌 ¿Lo necesitas en BLANCO o NEGRO?");
      return;
    }

    if (sess?.pending === "color") {
      const color = detectColor(text);
      if (!color) {
        await sendWhatsAppText(from, "Perfecto 👌 ¿Lo necesitas en BLANCO o NEGRO?");
        return;
      }

      const chosen = filterByColor(sess.items || [], color);
      if (chosen.length === 0) {
        await sendWhatsAppText(from, `En ${color} no lo veo disponible. ¿Lo quieres en BLANCO o NEGRO?`);
        return;
      }

      await sendWhatsAppText(from, formatOneProduct(chosen[0]));
      sessions.delete(from);
      return;
    }

    // 3) Cargar catálogo
    await loadCatalogFromCSV();

    // 4) Flujo especial: Display iPhone 7 (preguntar 7 vs 7 Plus -> color -> precio + existencia)
    if (isDisplayIntent(text) && (mentionsIphone7(text) || mentionsIphone7Plus(text))) {
      const matches = searchCatalog(text, 40);

      // solo displays
      const displayItems = matches.filter((p) =>
        productHasAny(p, ["display", "pantalla", "lcd", "tactil", "touch"])
      );

      if (displayItems.length === 0) {
        await sendWhatsAppText(from, "No lo encuentro con ese nombre. ¿Me confirmas el modelo exacto y si lo necesitas completo con táctil?");
        return;
      }

      const color = detectColor(text);
      const alreadyPlus = mentionsIphone7Plus(text);

      // Si NO aclara plus, preguntar primero
      if (!alreadyPlus) {
        sessions.set(from, { pending: "iphone_variant", intent: "display_iphone7", items: displayItems });
        await sendWhatsAppText(from, "Perfecto 👌 ¿Es iPhone 7 normal o iPhone 7 Plus?");
        return;
      }

      // Si sí aclara Plus, ir a color
      let itemsForVariant = displayItems.filter((p) => normalizeText(p.Producto).includes("7 plus"));
      if (itemsForVariant.length === 0) {
        await sendWhatsAppText(from, "Para iPhone 7 Plus no lo veo disponible. ¿Lo necesitas para iPhone 7 normal?");
        return;
      }

      if (!color) {
        sessions.set(from, { pending: "color", intent: "display_iphone7plus", items: itemsForVariant });
        await sendWhatsAppText(from, "Perfecto 👌 ¿Lo necesitas en BLANCO o NEGRO?");
        return;
      }

      const chosen = filterByColor(itemsForVariant, color);
      if (chosen.length === 0) {
        sessions.set(from, { pending: "color", intent: "display_iphone7plus", items: itemsForVariant });
        await sendWhatsAppText(from, `En ${color} no lo veo disponible. ¿Lo quieres en BLANCO o NEGRO?`);
        return;
      }

      await sendWhatsAppText(from, formatOneProduct(chosen[0]));
      return;
    }

    // 5) Flujo general para CUALQUIER producto del catálogo
    const matches = searchCatalog(text, 10);

    console.log("🔎 Search raw:", text);
    console.log("🔎 Search clean:", cleanQuery(text));
    console.log("🔎 Matches:", matches.slice(0, 3));

    // Si pide precio/disponibilidad y tenemos match, responder directo (sin cantidades)
    if (asksPriceOrAvailability(text) && matches.length > 0) {
      // Si hay varias opciones, haz 1 pregunta en vez de listar líneas comerciales
      // Ej: si detecta BLANCO/NEGRO en los resultados, pregunta color.
      const color = detectColor(text);
      const hasWhite = matches.some((p) => normalizeText(p.Producto).includes("blanco"));
      const hasBlack = matches.some((p) => normalizeText(p.Producto).includes("negro"));

      if (!color && (hasWhite || hasBlack) && matches.length > 1) {
        sessions.set(from, { pending: "color", intent: "generic_color", items: matches });
        await sendWhatsAppText(from, "Perfecto 👌 ¿Lo necesitas en BLANCO o NEGRO?");
        return;
      }

      // Si no hay necesidad de preguntar, responde con la mejor opción
      await sendWhatsAppText(from, formatOneProduct(matches[0]));
      return;
    }

    // Si NO hay matches, conversación normal (pregunta 1 cosa)
    if (matches.length === 0) {
      const reply = await askOpenAI(text);
      await sendWhatsAppText(from, reply);
      return;
    }

    // Si hay matches pero el cliente no pidió precio todavía:
    // muestra 2-3 opciones y pregunta cuál
    const options = matches.slice(0, 3).map((p, i) => `${i + 1}) ${p.Producto}`).join("\n");
    await sendWhatsAppText(from, `Encontré estas opciones:\n${options}\n\n¿Cuál te interesa? (1, 2, 3 o el código)`);
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
