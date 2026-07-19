// Testa a chave Gemini no endpoint OpenAI-compatível usado pelas edge functions.
// Uso: GEMINI_API_KEY=... node scripts/test-gemini.mjs
const key = process.env.GEMINI_API_KEY;
const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "gemini-2.5-flash",
    messages: [{ role: "user", content: "Responda apenas: ok" }],
  }),
});
const body = await r.text();
console.log("status:", r.status);
console.log("body:", body.slice(0, 300));
