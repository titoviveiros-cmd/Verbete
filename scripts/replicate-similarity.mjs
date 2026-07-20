// Réplica local exata do score-similarity para isolar a falha.
// Uso: SUPA_URL, SERVICE, GEMINI, DB não necessários além dos três.
const { SUPA_URL, SERVICE, GEMINI } = process.env;
const roomId = "b43e0a71-914e-4fcd-950e-5864038332ed"; // sala 3400
const round = 4;

const sb = async (path) => {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const room = await sb(`rooms?id=eq.${roomId}&select=current_word_id,status`);
console.log("1 room:", room.status, JSON.stringify(room.json));
const wid = room.json?.[0]?.current_word_id;

const w = await sb(`words?id=eq.${wid}&select=word`);
console.log("2 word:", w.status, JSON.stringify(w.json));
const word = w.json?.[0]?.word ?? "";

const t = await sb(`definitions?room_id=eq.${roomId}&round=eq.${round}&is_truth=eq.true&select=text`);
console.log("3 truth:", t.status, JSON.stringify(t.json));
const truth = t.json?.[0]?.text ?? "";

const system = `Você avalia proximidade semântica entre definições do jogo "Verbete". Seja GENEROSO... Devolva APENAS JSON {"matches": ["<id>", ...]} com os ids aprovados, sem markdown.`;
const user = `Palavra: ${word}\nDefinição verdadeira: ${truth}\n\nCandidatas:\n1. [id=teste-pobreza] "pobreza"\n\nRetorne os ids semanticamente próximos (seja generoso com sinônimos e paráfrases).`;

const g = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${GEMINI}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gemini-flash-latest", messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
});
console.log("4 gemini:", g.status);
const gd = await g.json().catch(() => null);
console.log("   content:", JSON.stringify(gd?.choices?.[0]?.message?.content ?? gd).slice(0, 300));
