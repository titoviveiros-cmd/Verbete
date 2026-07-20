const r = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.GEMINI}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "gemini-flash-lite-latest",
    messages: [{ role: "user", content: 'A palavra pindaiba significa "falta completa de dinheiro". A definicao "pobreza" e semanticamente equivalente? Responda apenas JSON {"match": true} ou {"match": false}' }],
  }),
});
const d = await r.json().catch(() => null);
console.log(r.status, JSON.stringify(d?.choices?.[0]?.message?.content ?? d?.error?.message ?? d).slice(0, 200));
