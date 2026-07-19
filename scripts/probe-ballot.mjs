// Sonda S1: tenta identificar a verdade antes da revelação, como um
// cheater com DevTools faria. Uso: SUPA_URL=... ANON=... [CODE=1234]
const { SUPA_URL, ANON, CODE } = process.env;
const H = { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" };

const get = async (p) => { const r = await fetch(`${SUPA_URL}/rest/v1/${p}`, { headers: H }); return { s: r.status, b: (await r.text()).slice(0, 160) }; };
const rpc = async (fn, body) => { const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: H, body: JSON.stringify(body) }); return { s: r.status, b: (await r.text()).slice(0, 400) }; };

console.log("1. SELECT direto em definitions (deve falhar 401):");
console.log("  ", JSON.stringify(await get("definitions?select=*&limit=1")));

console.log("2. SELECT só is_truth (deve falhar 401):");
console.log("  ", JSON.stringify(await get("definitions?select=id,is_truth&limit=1")));

if (CODE) {
  const state = await rpc("get_room_state", { p_code: CODE });
  console.log("3. get_room_state (não deve conter is_truth/__truth__/meaning fora de reveal):");
  console.log("   status:", state.s);
  console.log("   contem is_truth?", state.b.includes("is_truth"), "| contem __truth__?", state.b.includes("__truth__"), "| contem meaning?", state.b.includes("meaning"));
  console.log("   trecho:", state.b.slice(0, 240));
}
