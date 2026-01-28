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
      /\b(tienes|tiene|hay|precio|vale|cuesta|disponible|stock|existencia|me|puedes|porfa|porfavor|necesito|quiero|busco|una|un|el|la|los|las|para|de|del|al|y|con|por|que|q|dame|info|informacion|cuanto|tendras|tendrian|muestrame|muestra|quiero saber)\b/g,
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

function isNumericChoice(text) {
  const t = String(text || "").trim();
  return t === "1" || t === "2" || t === "3";
}

function looksLikeCode(text) {
  const t = String(text || "").trim();
  return /^\d{4,}$/.test(t);
}

function wantsOthers(text) {
  const t = normalizeText(text);
  return (
    t.includes("las otras") ||
    t.includes("las demas") ||
    t.includes("las demás") ||
    t.includes("las restantes") ||
    t.includes("todas") ||
    t.includes("toda") ||
    t.includes("las 3") ||
    t.includes("las tres") ||
    t.includes("3 opciones") ||
    t.includes("las opciones") ||
    t.includes("precio de las otras") ||
    t.includes("precio de todas") ||
    t.includes("precio de toda") ||
    t.includes("precio de las 3") ||
    t.includes("precio de las tres") ||
    t.includes("precio de las opciones")
  );
}

/* Quitar "TACTIL" de displays iPhone (para que no lo mencione) */
function prettyProductName(name = "") {
  let s = String(name);

  // Si es display iPhone, quitar "TACTIL"
  const n = normalizeText(s);
  if (n.includes("display") && n.includes("iphone")) {
    s = s.replace(/t[aá]ctil/gi, "").replace(/\s+/g, " ").trim();
    s = s.replace(/\s{2,}/g, " ").trim();
  }
  return s;
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
/*
sessions.get(from) = {
  pending: "pick" | "variant" | "color" | null,
  items: [...],          // items actuales (si aplica)
  variantKeys?: [...],
  lastOptions?: [...],   // últimas 1..3 mostradas
  lastTopicKey?: string, // grupo normalizado
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
      const Producto = pick(r, "Producto", "PRODUCTO", "Nombre_Producto", "Nombre", "Descripcion", "Descripción");
      const Precio_1 = pick(r, "Precio_1", "Precio1", "Precio 1", "Precio");
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

  const exact = catalogCache.rows.find(
    (r) => normalizeText(r.Codigo) && normalizeText(r.Codigo) === normalizeText(raw)
  );
  if (exact) return [exact];

  if (!q) return [];
  return catalogCache.fuse.search(q).slice(0, limit).map((r) => r.item);
}

/* =========================
   OpenAI (SIEMPRE)
   - OpenAI SOLO redacta
   - Datos vienen 100% del catálogo / estado
========================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function generateReplyWithOpenAI(payload) {
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const system = `
Eres un asesor comercial de BK GLOBAL (Colombia) por WhatsApp.

REGLAS CRÍTICAS (OBLIGATORIAS):
- NO inventes precios, existencia, marcas o productos.
- Usa ÚNICAMENTE los datos que vienen en el "CATALOGO_DATA".
- NUNCA muestres cantidad de stock. Solo: "✅ Hay existencia" o "❌ Sin existencia".
- Si el producto es "DISPLAY" para "IPHONE": NO menciones la palabra "TACTIL" (asume que ya viene incluido).
- Responde natural, corto y claro (máx 5 líneas).
- Si faltan datos para decidir (ej color o variante), haz UNA sola pregunta clara.
- Tu salida debe ser SOLO JSON válido: {"reply":"..."} (sin texto extra).
`;

  const user = `
USER_TEXT:
${payload.userText}

INSTRUCCION (MODE):
${payload.mode}

CATALOGO_DATA (solo esto se puede usar):
${JSON.stringify(payload.catalogData, null, 2)}
`;

  console.log("🤖 OpenAI CALLED mode=", payload.mode);

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
    console.error("⚠️ OpenAI JSON parse failed. Raw:", txt);
  }

  return payload.fallback || "¿En qué te puedo ayudar? 🙂";
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
   Safe payload para OpenAI
========================= */
function toSafeOption(p) {
  return {
    codigo: p.Codigo,
    producto: prettyProductName(p.Producto),
    precio: p.Precio_1,
    existencia: stockHasExistence(p.SaldoGeneral) ? "HAY" : "NO_HAY",
    grupo: p.Nombre_Grupo || "",
  };
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

    await loadCatalogFromCSV();
    const sess = sessions.get(from);

    /* 0) Saludo */
    if (isGreeting(text)) {
      const reply = await generateReplyWithOpenAI({
        userText: text,
        mode: "SALUDO_SIMPLE",
        catalogData: { note: "Solo saludar y preguntar en qué ayudar. No ofrecer líneas ni inventario." },
        fallback: "Hola 👋 ¿En qué te puedo ayudar?",
      });
      await sendWhatsAppText(from, reply);
      return;
    }

    /* 1) Atajo global: si pide precio de las opciones actuales (las 3), responderlas */
    if (sess?.lastOptions?.length && wantsOthers(text)) {
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

    /* 2) Si estamos en selección 1/2/3 */
    if (sess?.pending === "pick" && Array.isArray(sess.lastOptions) && sess.lastOptions.length > 0) {
      // ✅ ATAJO: si pide precio de las 3 / todas, responder precios YA
      if (wantsOthers(text)) {
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

      const t = String(text || "").trim();

      // 2.1 escoger por número
      if (isNumericChoice(t)) {
        const idx = Number(t) - 1;
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

      // 2.2 escoger por código
      if (looksLikeCode(t)) {
        const byCode = catalogCache.rows.find((r) => normalizeText(r.Codigo) === normalizeText(t));
        if (byCode) {
          const chosenSafe = toSafeOption(byCode);

          const reply = await generateReplyWithOpenAI({
            userText: text,
            mode: "RESPONDER_PRECIO_Y_EXISTENCIA_POR_CODIGO",
            catalogData: { producto: chosenSafe },
            fallback: `${chosenSafe.producto}\nPrecio: ${chosenSafe.precio}\n${
              chosenSafe.existencia === "HAY" ? "✅ Hay existencia" : "❌ Sin existencia"
            }`,
          });

          sessions.set(from, { ...sess, pending: null });
          await sendWhatsAppText(from, reply);
          return;
        }
      }

      // 2.3 no entendió
      const reply = await generateReplyWithOpenAI({
        userText: text,
        mode: "PEDIR_QUE_ELIJA_1_2_3_O_CODIGO",
        catalogData: {
          opciones: sess.lastOptions.map((p, i) => ({
            n: i + 1,
            producto: prettyProductName(p.Producto),
            codigo: p.Codigo,
          })),
        },
        fallback: "Perfecto 👌 Responde con 1, 2, 3 o el código del producto.",
      });

      await sendWhatsAppText(from, reply);
      return;
    }

    /* 3) Si estamos esperando variante */
    if (sess?.pending === "variant") {
      const userVariant = detectVariantFromText(text);
      if (!userVariant) {
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "PREGUNTAR_VARIANTE",
          catalogData: { variantes: sess.variantKeys || [] },
          fallback: `Perfecto 👌 ¿Cuál necesitas: ${(sess.variantKeys || []).join(", ")}?`,
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      const filtered = (sess.items || []).filter((p) => classifyVariantFromProductName(p.Producto) === userVariant);
      if (filtered.length === 0) {
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "VARIANTE_NO_ENTENDIDA",
          catalogData: { variantes: sess.variantKeys || [] },
          fallback: `No te entendí esa variante. ¿Cuál necesitas: ${(sess.variantKeys || []).join(", ")}?`,
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      if (hasColorMix(filtered) && !detectColor(text)) {
        sessions.set(from, { ...sess, pending: "color", items: filtered });
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "PREGUNTAR_COLOR",
          catalogData: { colores: ["BLANCO", "NEGRO"] },
          fallback: "Perfecto 👌 ¿Lo necesitas en BLANCO o NEGRO?",
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      const chosenSafe = toSafeOption(filtered[0]);
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

    /* 4) Si estamos esperando color */
    if (sess?.pending === "color") {
      const color = detectColor(text);
      if (!color) {
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "PREGUNTAR_COLOR",
          catalogData: { colores: ["BLANCO", "NEGRO"] },
          fallback: "Perfecto 👌 ¿Lo necesitas en BLANCO o NEGRO?",
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      const chosen = filterByColor(sess.items || [], color);
      if (chosen.length === 0) {
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "COLOR_NO_DISPONIBLE",
          catalogData: { color: color, colores: ["BLANCO", "NEGRO"] },
          fallback: `En ${color} no lo veo. ¿BLANCO o NEGRO?`,
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

    /* 5) Búsqueda normal (con ancla de contexto por grupo para no desviarse) */
    let matches = searchCatalog(text, 30);

    // Si ya teníamos tema anterior, y el mensaje es corto/genérico, filtramos por el mismo grupo
    if (sess?.lastTopicKey) {
      const tnorm = normalizeText(text);
      const isGenericFollowup =
        tnorm.length <= 25 ||
        tnorm.includes("las cerraduras") ||
        tnorm.includes("cerraduras") ||
        tnorm.includes("las otras") ||
        tnorm.includes("las demas") ||
        tnorm.includes("las demás") ||
        tnorm.includes("todas") ||
        tnorm.includes("opciones") ||
        tnorm.includes("precio");

      if (isGenericFollowup) {
        const filtered = matches.filter((p) => normalizeText(p.Nombre_Grupo || "") === sess.lastTopicKey);
        if (filtered.length > 0) matches = filtered;
      }
    }

    console.log("🔎 Search raw:", text);
    console.log("🔎 Search clean:", cleanQuery(text));
    console.log("🔎 Matches:", matches.slice(0, 3).map((m) => m.Producto));

    // 5.1 no hay match -> OpenAI pregunta (sin inventar)
    if (matches.length === 0) {
      const reply = await generateReplyWithOpenAI({
        userText: text,
        mode: "SIN_COINCIDENCIAS_PEDIR_ACLARACION",
        catalogData: { note: "No hay coincidencias. Pedir código o nombre exacto." },
        fallback: "No lo encontré en el catálogo. ¿Me compartes el nombre exacto o el código, por favor?",
      });
      await sendWhatsAppText(from, reply);
      return;
    }

    // 5.2 Variantes SOLO si es celulares
    const allowVariants = isCellphoneContext(matches, text);
    if (allowVariants) {
      const userVariant = detectVariantFromText(text);
      let refined = matches;

      if (userVariant) {
        const filtered = matches.filter((p) => classifyVariantFromProductName(p.Producto) === userVariant);
        if (filtered.length > 0) refined = filtered;
      }

      const variantOptions = computeVariantOptions(refined);
      if (!userVariant && variantOptions) {
        sessions.set(from, { pending: "variant", items: refined, variantKeys: variantOptions.keys });
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "PREGUNTAR_VARIANTE",
          catalogData: { variantes: variantOptions.keys },
          fallback: `Perfecto 👌 ¿Cuál necesitas: ${variantOptions.keys.join(", ")}?`,
        });
        await sendWhatsAppText(from, reply);
        return;
      }

      if (hasColorMix(refined) && !detectColor(text)) {
        sessions.set(from, { pending: "color", items: refined });
        const reply = await generateReplyWithOpenAI({
          userText: text,
          mode: "PREGUNTAR_COLOR",
          catalogData: { colores: ["BLANCO", "NEGRO"] },
          fallback: "Perfecto 👌 ¿Lo necesitas en BLANCO o NEGRO?",
        });
        await sendWhatsAppText(from, reply);
        return;
      }
    }

    // 5.3 Si hay un match claro (1) -> responder precio/existencia
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

    // 5.4 Mostrar 3 opciones y guardar contexto
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
        `\n\n¿Cuál te interesa? (1, 2, 3 o el código)`,
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
