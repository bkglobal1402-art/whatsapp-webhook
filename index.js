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
      /\b(tienes|tiene|hay|precio|vale|cuesta|disponible|stock|existencia|me|puedes|porfa|porfavor|necesito|quiero|busco|una|un|el|la|los|las|para|de|del|al|y|con|por|que|q|dame|info|informacion|cuanto|tendras|tendrian)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function isGreeting(text) {
  const t = normalizeText(text);
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

function stockHasExistence(saldoGeneral) {
  const raw = String(saldoGeneral || "").replace(/\./g, "").replace(",", ".").trim();
  const n = Number(raw);
  if (Number.isNaN(n)) return false;
  return n > 0;
}

function availabilityText(saldoGeneral) {
  return stockHasExistence(saldoGeneral) ? "✅ Hay existencia" : "❌ Sin existencia";
}

function formatOneProduct(p) {
  return `${p.Producto}\nPrecio: ${p.Precio_1}\n${availabilityText(p.SaldoGeneral)}`;
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

/* =========================
   Variant engine (general)
   - Pregunta SOLO si hay más de una variante real entre los resultados.
   - Variantes soportadas: pro max, pro, mini, plus, max, ultra, lite, se
========================= */
const VARIANT_PATTERNS = [
  { key: "PRO MAX", patterns: ["pro max", "promax"] },
  { key: "PRO", patterns: [" pro "] }, // con espacios para no confundir
  { key: "MINI", patterns: [" mini "] },
  { key: "PLUS", patterns: [" plus "] },
  { key: "MAX", patterns: [" max "] },
  { key: "ULTRA", patterns: [" ultra "] },
  { key: "LITE", patterns: [" lite "] },
  { key: "SE", patterns: [" se "] },
];

// detecta si el usuario YA dijo una variante en el mensaje
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

// clasifica un producto en una variante (si aplica). Si no aplica, null.
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

// construye opciones reales de variante según los matches
function computeVariantOptions(items) {
  const map = new Map(); // key -> items[]
  for (const p of items) {
    const key = classifyVariantFromProductName(p.Producto);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }

  // Solo tiene sentido preguntar si hay 2+ variantes distintas
  const keys = Array.from(map.keys());
  if (keys.length < 2) return null;

  // Ordenar por el orden de VARIANT_PATTERNS
  const order = new Map(VARIANT_PATTERNS.map((v, i) => [v.key, i]));
  keys.sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));

  return { keys, map };
}

/* =========================
   Session memory (RAM)
========================= */
const sessions = new Map();
/*
sessions.get(from) = {
  pending: "variant" | "color",
  items: [...],          // items actuales filtrados
  variantKeys?: [...],   // variantes disponibles para mostrar
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

function searchCatalog(query, limit = 20) {
  if (!catalogCache.fuse) return [];

  const raw = String(query || "").trim();
  const q = cleanQuery(raw);

  const exact = catalogCache.rows.find(
    (r) => normalizeText(r.Codigo) && normalizeText(r.Codigo) === normalizeText(raw)
  );
  if (exact) return [exact];

  if (!q) return [];

  return catalogCache.fuse.search(q).slice(0, limit).map((r) => r.item);
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
   OpenAI (solo si NO hay match)
========================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function askOpenAI(userText) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const systemRules = `
Eres asesor comercial de BK GLOBAL.
Responde en español natural, corto y claro (máx 5 líneas).
No inventes precios ni disponibilidad.
Si falta información, haz 1 pregunta para aclarar.
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

    // Saludo opción 1
    if (isGreeting(text)) {
      await sendWhatsAppText(from, "Hola 👋 ¿En qué te puedo ayudar?");
      return;
    }

    // Si hay sesión pendiente (VARIANTE / COLOR)
    const sess = sessions.get(from);

    if (sess?.pending === "variant") {
      const userVariant = detectVariantFromText(text);
      if (!userVariant) {
        const list = (sess.variantKeys || []).join(", ");
        await sendWhatsAppText(from, `Perfecto 👌 ¿Cuál necesitas: ${list}?`);
        return;
      }

      // filtrar por variante
      const filtered = (sess.items || []).filter((p) => classifyVariantFromProductName(p.Producto) === userVariant);

      if (filtered.length === 0) {
        const list = (sess.variantKeys || []).join(", ");
        await sendWhatsAppText(from, `No te entendí esa variante. ¿Cuál necesitas: ${list}?`);
        return;
      }

      // después de variante: si hay color, preguntar
      if (hasColorMix(filtered) && !detectColor(text)) {
        sessions.set(from, { pending: "color", items: filtered });
        await sendWhatsAppText(from, "Perfecto 👌 ¿Lo necesitas en BLANCO o NEGRO?");
        return;
      }

      await sendWhatsAppText(from, formatOneProduct(filtered[0]));
      sessions.delete(from);
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

    // Cargar catálogo y buscar
    await loadCatalogFromCSV();
    const matches = searchCatalog(text, 25);

    console.log("🔎 Search raw:", text);
    console.log("🔎 Search clean:", cleanQuery(text));
    console.log("🔎 Matches:", matches.slice(0, 3));

    // Si no hay match: conversación natural (1 pregunta)
    if (matches.length === 0) {
      const reply = await askOpenAI(text);
      await sendWhatsAppText(from, reply);
      return;
    }

    // Si el usuario pide precio/disponibilidad, aplicamos “inteligencia de variantes”
    if (asksPriceOrAvailability(text)) {
      const userVariant = detectVariantFromText(text);

      // Si ya dijo variante, filtrar por ella
      let refined = matches;
      if (userVariant) {
        const filtered = matches.filter((p) => classifyVariantFromProductName(p.Producto) === userVariant);
        if (filtered.length > 0) refined = filtered;
      }

      // 1) Si hay mezcla de variantes y el usuario NO especificó -> preguntar variante (con lista real)
      const variantOptions = computeVariantOptions(refined);
      if (!userVariant && variantOptions) {
        sessions.set(from, {
          pending: "variant",
          items: refined,
          variantKeys: variantOptions.keys,
        });
        await sendWhatsAppText(from, `Perfecto 👌 ¿Cuál necesitas: ${variantOptions.keys.join(", ")}?`);
        return;
      }

      // 2) Si hay mezcla de colores -> preguntar color
      if (hasColorMix(refined) && !detectColor(text)) {
        sessions.set(from, { pending: "color", items: refined });
        await sendWhatsAppText(from, "Perfecto 👌 ¿Lo necesitas en BLANCO o NEGRO?");
        return;
      }

      // 3) Responder con el mejor match (sin cantidades)
      await sendWhatsAppText(from, formatOneProduct(refined[0]));
      return;
    }

    // Si NO pidió precio: mostrar 2–3 opciones y preguntar cuál
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
