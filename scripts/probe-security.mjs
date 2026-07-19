// Sonda de segurança: simula um jogador malicioso usando a anon key via REST.
// Uso: SUPA_URL=... ANON=... node scripts/probe-security.mjs
const { SUPA_URL, ANON } = process.env;

const get = async (path) => {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
  });
  return { status: r.status, body: (await r.text()).slice(0, 180) };
};

// 1) Tentar ler meaning direto (deve FALHAR com 401/403/permission denied)
console.log("1. SELECT words.meaning (deve falhar):");
console.log("  ", JSON.stringify(await get("words?select=id,word,meaning&limit=1")));

// 2) Colunas seguras (deve FUNCIONAR)
console.log("2. SELECT colunas seguras (deve funcionar):");
console.log("  ", JSON.stringify(await get("words?select=id,word,category,nivel&limit=1")));

// 3) select=* (deve FALHAR — inclui colunas bloqueadas)
console.log("3. SELECT * em words (deve falhar):");
console.log("  ", JSON.stringify(await get("words?select=*&limit=1")));

// 4) RPC de sorteio seguro (deve FUNCIONAR, sem meaning no payload)
const rpc = await fetch(`${SUPA_URL}/rest/v1/rpc/get_random_word_prompts`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
  body: JSON.stringify({ lim: 1 }),
});
const rpcBody = await rpc.text();
console.log("4. get_random_word_prompts (deve funcionar, sem meaning):");
console.log("  ", rpc.status, rpcBody.slice(0, 200));
console.log("   contem 'meaning'?", rpcBody.includes("meaning"));

// 5) get_random_words interna (deve FALHAR para anon)
const rpc2 = await fetch(`${SUPA_URL}/rest/v1/rpc/get_random_words`, {
  method: "POST",
  headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
  body: JSON.stringify({ lim: 1 }),
});
console.log("5. get_random_words interna (deve falhar):");
console.log("  ", rpc2.status, (await rpc2.text()).slice(0, 140));
