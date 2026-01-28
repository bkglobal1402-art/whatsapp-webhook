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
    .replace(/[\u0300-\u036f]/g, "") // quita tildes
    .replace(/[^a-z0-9]+/g, " ") // limpia símbolos
    .replace(/\s+/g, " ")
    .trim();
}

function cleanQuery(raw = "") {
  return normalizeText(raw)
    .replace(
      /\b(tienes|tiene|hay|precio|vale|cuesta|disponible|stock|me|puedes|porfa|porfavor|necesito|quiero|busco|una|un|el|la|los|las|para|de|del|al|y|con|por|que|q|dame|quieres|quiero|necesitaría)\b/g,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function detectColor(text) {
  const t = normalizeText(text);
  if (t.includes("negro")) return "NEGRO";
  if (t.includes("blanco")) return "BLANCO";
  return null;
}

function detectIphoneVariant(text) {
  const t = normalizeText(text);
  if (t.includes("plus")) return "PLUS";
  // si menciona "7 plus" explícitamente, también cae acá
  return null;
}

function isGreeting(text) {
  const t = normalizeText(text);
  return ["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "hey"].some(
    (w) => t === w || t.startsWith(w + " ")
  );
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
  // saldoGeneral viene como "13,00" o "0,00" o "2"
  const raw = String(saldoGeneral || "").replace(/\./g, "").replace(",", ".").trim();
  const n = Number(raw);
  if (Number.isNaN(n)) return false;
  return n > 0;
}

function formatAvailability(saldoGeneral) {
  return stockHasExistence(saldoGeneral) ? "Sí hay existencia ✅" : "Sin existencia ❌";
}

/* =========================
   Session memory (RAM)
   Nota: se borra si Railway reinicia. Para pruebas sirve perfecto.
========================= */
const sessions = new Map();
/*
sessions.get(from) = {
  pending: "iphone_variant" | "color",
  intent: "display_iphone7",
  baseQuery: "display iphone 7",
  items: [...]
}
*/

/* =========================
   Catalog cache (Google Sheets CSV)
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

function searchCatalog(query, limit = 10) {
  if (!catalogCache.fuse) return [];

  const raw = String(query || "").trim();
  const q = cleanQuery(raw);

  // Match exacto por código
  const exact = catalogCache.rows.find(
    (r) => normalizeText(r.Codigo) && normalizeText(r.Codigo) === normalizeText(raw)
  );
  if (exact) return [exact];

  if (!q) return [];

  let items = catalogCache.fuse.search(q).map((r) => r.item);

  // Si piden display, intenta filtrar a SOLO display/pantalla
  if (isDisplayIntent(raw)) {
    const filtered = items.filter((p) =>
      ["display", "pantalla", "lcd", "tactil", "touch"].some((w) => normalizeText(p.Producto).includes(w))
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
   OpenAI
   (Lo usamos para conversar en general. Para precio/stock exacto,
    respondemos directo con catálogo y reglas.)
========================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function askOpenAI(userText) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const systemRules = `
Eres un asesor comercial de BK GLOBAL (Colombia).
Estilo: español natural, corto y claro; tono amable y vendedor.

Reglas:
- No inventes precios, disponibilidad ni características técnicas.
- Si el usuario no pide algo específico, haz 1 pregunta para entender qué busca.
- Máximo 6 líneas.
`;

  const r = await openai.chat.completions.create({
    model,
    temperature: 0.4,
    messages: [
      { role: "system", content: systemRules },
      { role: "user", content: userText },
    ],
  });

  return r.choices?.[0]?.message?.content?.trim() || "Hola 👋 ¿Qué producto estás buscando?";
}

/* =========================
   Catalog response helpers
========================= */
function findByIphoneVariant(items, variant /* "7" | "7 PLUS" */) {
  const v = normalizeText(variant);

  if (v === "7 plus") {
    return items.filter((p) => normalizeText(p.Producto).includes("7 plus"));
  }

  // iPhone 7 (no plus)
  return items.filter((p) => normalizeText(p.Producto).includes("iphone 7") && !normalizeText(p.Producto).includes("7 plus"));
}

function filterByColor(items, color /* "BLANCO" | "NEGRO" */) {
  const c = normalizeText(color);
  // en tu sheet parece venir BLANCO / NEGRO
  return items.filter((p) => normalizeText(p.Producto).includes(c));
}

function formatPriceAvailability(p) {
  // NUNCA mostrar cantidad. Solo si hay existencia o no.
  const availability = formatAvailability(p.SaldoGeneral);
  return `${p.Producto}\nPrecio: ${p.Precio_1}\n${availability}`;
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

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Webhook events
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

    // 0) Saludo
    if (isGreeting(text)) {
      await sendWhatsAppText(
        from,
        "Hola 👋 Soy tu asesor de BK GLOBAL.\n¿Qué necesitas: repuestos de celular, GPS o cerraduras inteligentes?\nSi es repuesto, dime el modelo (ej: iPhone 7 / 7 Plus) y qué parte buscas."
      );
      return;
    }

    // 1) Si hay sesión pendiente (preguntas de aclaración)
    const sess = sessions.get(from);
    if (sess?.pending) {
      // 1A) Esperando si es 7 o 7 Plus
      if (sess.pending === "iphone_variant") {
        const t = normalizeText(text);
        const isPlus = t.includes("plus");
        const isSeven = t.includes("7") || t.includes("iphone 7") || t.includes("iphone7");

        if (!isSeven) {
          await sendWhatsAppText(from, "¿Es iPhone 7 normal o iPhone 7 Plus?");
          return;
        }

        const variant = isPlus ? "7 PLUS" : "7";
        const itemsForVariant = variant === "7 PLUS"
          ? sess.items.filter((p) => normalizeText(p.Producto).includes("7 plus"))
          : sess.items.filter((p) => normalizeText(p.Producto).includes("iphone 7") && !normalizeText(p.Producto).includes("7 plus"));

        // Guardar y pasar a preguntar color (si aplica)
        const hasWhite = itemsForVariant.some((p) => normalizeText(p.Producto).includes("blanco"));
        const hasBlack = itemsForVariant.some((p) => normalizeText(p.Producto).includes("negro"));

        sessions.set(from, { pending: "color", intent: sess.intent, items: itemsForVariant });

        if (hasWhite || hasBlack) {
          await sendWhatsAppText(from, "Perfecto 👌 ¿Lo necesitas en BLANCO o NEGRO?");
          return;
        }

        // Si no hay colores, responder con lo que haya (precio + existencia/no)
        if (itemsForVariant.length === 0) {
          await sendWhatsAppText(from, "No lo veo disponible para ese modelo en este momento. ¿Me confirmas el modelo exacto y si es con táctil?");
          sessions.delete(from);
          return;
        }

        await sendWhatsAppText(from, formatPriceAvailability(itemsForVariant[0]));
        sessions.delete(from);
        return;
      }

      // 1B) Esperando color
      if (sess.pending === "color") {
        const color = detectColor(text);
        if (!color) {
          await sendWhatsAppText(from, "Perfecto 👌 ¿Lo necesitas en BLANCO o NEGRO?");
          return;
        }

        const chosen = filterByColor(sess.items || [], color);

        if (chosen.length === 0) {
          await sendWhatsAppText(from, `En ${color} no lo veo disponible ahora. ¿Lo quieres en BLANCO o NEGRO?`);
          return;
        }

        await sendWhatsAppText(from, formatPriceAvailability(chosen[0]));
        sessions.delete(from);
        return;
      }
    }

    // 2) Intento: DISPLAY iPhone 7 / 7 Plus
    // Si el usuario pide display y menciona iPhone 7 pero NO aclara Plus, preguntamos primero.
    // Si aclara Plus, saltamos a color.
    try {
      await loadCatalogFromCSV();

      const wantsDisplay = isDisplayIntent(text);
      const says7 = mentionsIphone7(text) || mentionsIphone7Plus(text);

      if (wantsDisplay && says7) {
        const matches = searchCatalog(text, 30);

        console.log("🔎 Search raw:", text);
        console.log("🔎 Search clean:", cleanQuery(text));
        console.log("🔎 Matches:", matches.slice(0, 3));

        // Solo nos interesa: productos que contengan display/pantalla
        const displayItems = matches.filter((p) =>
          ["display", "pantalla", "lcd", "tactil", "touch"].some((w) => normalizeText(p.Producto).includes(w))
        );

        if (displayItems.length === 0) {
          await sendWhatsAppText(
            from,
            "No lo veo en el catálogo con ese nombre. ¿Me confirmas si es display completo con táctil y el modelo exacto?"
          );
          return;
        }

        const alreadyPlus = mentionsIphone7Plus(text) || detectIphoneVariant(text) === "PLUS";
        const color = detectColor(text);

        if (!alreadyPlus) {
          // Preguntar 7 o 7 Plus primero
          sessions.set(from, { pending: "iphone_variant", intent: "display_iphone7", items: displayItems });
          await sendWhatsAppText(from, "Perfecto 👌 ¿Es iPhone 7 normal o iPhone 7 Plus?");
          return;
        }

        // Si ya dijo Plus, filtramos por Plus
        let itemsForVariant = displayItems.filter((p) => normalizeText(p.Producto).includes("7 plus"));
        if (itemsForVariant.length === 0) {
          // si no hay plus, avisar
          await sendWhatsAppText(from, "Para iPhone 7 Plus no lo veo disponible en este momento. ¿Lo necesitas para iPhone 7 normal?");
          return;
        }

        // Luego preguntar color (si no dijo)
        const hasWhite = itemsForVariant.some((p) => normalizeText(p.Producto).includes("blanco"));
        const hasBlack = itemsForVariant.some((p) => normalizeText(p.Producto).includes("negro"));

        if (!color && (hasWhite || hasBlack)) {
          sessions.set(from, { pending: "color", intent: "display_iphone7plus", items: itemsForVariant });
          await sendWhatsAppText(from, "Perfecto 👌 ¿Lo necesitas en BLANCO o NEGRO?");
          return;
        }

        // Si ya dijo color, responder
        if (color) {
          const chosen = filterByColor(itemsForVariant, color);
          if (chosen.length === 0) {
            await sendWhatsAppText(from, `En ${color} no lo veo disponible ahora. ¿Lo quieres en BLANCO o NEGRO?`);
            sessions.set(from, { pending: "color", intent: "display_iphone7plus", items: itemsForVariant });
            return;
          }
          await sendWhatsAppText(from, formatPriceAvailability(chosen[0]));
          return;
        }

        // Si no hay colores, responder con el primero
        await sendWhatsAppText(from, formatPriceAvailability(itemsForVariant[0]));
        return;
      }

      // 3) Si NO es este flujo especial, usamos el catálogo normal + OpenAI para hablar natural:
      // Buscar coincidencias generales
      const matches = searchCatalog(text, 6);

      // Si el usuario pregunta por precio/stock/disponibilidad, respondemos con catálogo directo (sin cantidad)
      const t = normalizeText(text);
      const asksPriceOrAvailability = ["precio", "vale", "cuesta", "disponible", "hay", "stock", "tienen"].some((w) => t.includes(w));

      if (asksPriceOrAvailability && matches.length > 0) {
        // mostrar 1–2 opciones máximo sin cantidades
        const top = matches.slice(0, 2);
        const msg = top
          .map((p) => `${p.Producto}\nPrecio: ${p.Precio_1}\n${formatAvailability(p.SaldoGeneral)}`)
          .join("\n\n");
        await sendWhatsAppText(from, msg);
        return;
      }

      // Si no hay matches, conversar para obtener más datos
      if (matches.length === 0) {
        const reply = await askOpenAI(text);
        await sendWhatsAppText(from, reply);
        return;
      }

      // Si hay matches pero el usuario no pidió precio explícito, ofrecer opciones y preguntar una cosa
      const options = matches.slice(0, 3).map((p, i) => `${i + 1}) ${p.Producto}`).join("\n");
      await sendWhatsAppText(
        from,
        `Encontré estas opciones:\n${options}\n\n¿Cuál te interesa? (puedes decir 1, 2 o el código)`
      );
      return;

    } catch (e) {
      console.error("⚠️ Catalog/OpenAI flow error:", e.message);
      await sendWhatsAppText(
        from,
        "Estoy presentando una falla técnica 🙏 pero dime el producto (modelo y referencia) y te ayudo."
      );
      return;
    }
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
