process.on("uncaughtException", (err) => {
  console.error("🔥 uncaughtException:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("🔥 unhandledRejection:", err);
});

const express = require("express");
const fetch = require("node-fetch");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

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

// ✅ OpenAI helper
async function askOpenAI(userText) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "Eres un asesor de BK GLOBAL. Respondes en español, claro, corto y amable. Si te saludan, te presentas.",
      },
      { role: "user", content: userText },
    ],
    temperature: 0.4,
  });

  return (
    r.choices?.[0]?.message?.content?.trim() ||
    "Hola 👋 Soy BK GLOBAL. ¿En qué puedo ayudarte?"
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

    const aiReply = await askOpenAI(text);
    await sendWhatsAppText(from, aiReply);

    return res.sendStatus(200);
  } catch (err) {
    console.log("❌ Error in webhook:", err);
    return res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
