// Sonda S3: tenta inflar estatísticas como um atacante faria.
// Uso: SUPA_URL=... ANON=... node scripts/probe-stats.mjs
const { SUPA_URL, ANON } = process.env;

const rpc = async (fn, body) => {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.text()).slice(0, 160) };
};

// 1) Assinatura antiga com valores forjados (deve NÃO EXISTIR mais)
console.log("1. record_match_result assinatura antiga forjada (deve falhar/404):");
console.log("  ", JSON.stringify(await rpc("record_match_result", {
  p_user_id: "00000000-0000-0000-0000-000000000000", p_room_code: "4898",
  p_final_score: 9999, p_position: 1, p_players_count: 2,
  p_rounds_coordinated: 0, p_truth_hits: 99, p_fooled_count: 99,
})));

// 2) Assinatura nova SEM login (deve falhar: Unauthorized)
console.log("2. record_match_result(p_room_code) sem sessão (deve falhar):");
console.log("  ", JSON.stringify(await rpc("record_match_result", { p_room_code: "4898" })));

// 3) claim_player_identity sem login (deve falhar: not_authenticated)
console.log("3. claim_player_identity sem sessão (deve negar):");
console.log("  ", JSON.stringify(await rpc("claim_player_identity", { p_player_id: "p_8w3y7wafhjm6" })));
