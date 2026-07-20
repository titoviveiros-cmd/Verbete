// Sonda: anonymous sign-in habilitado? Cria uma sessão anônima real via
// GoTrue (mesma chamada do client) e confere o claim de identidade.
const { SUPA_URL, ANON } = process.env;

const r = await fetch(`${SUPA_URL}/auth/v1/signup`, {
  method: "POST",
  headers: { apikey: ANON, "Content-Type": "application/json" },
  body: JSON.stringify({}),
});
const body = await r.json();
if (!r.ok) {
  console.log("❌ anonymous sign-in indisponível:", r.status, JSON.stringify(body).slice(0, 200));
  process.exit(1);
}
console.log("✅ sessão anônima criada — user:", body.user?.id, "is_anonymous:", body.user?.is_anonymous);

// Com a sessão, o claim de identidade deve funcionar (auth.uid() presente)
const claim = await fetch(`${SUPA_URL}/rest/v1/rpc/claim_player_identity`, {
  method: "POST",
  headers: {
    apikey: ANON,
    Authorization: `Bearer ${body.access_token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ p_player_id: "p_probe_anon_" + Math.random().toString(36).slice(2, 8) }),
});
console.log("claim (esperado ok:false player inexistente, mas SEM not_authenticated):", await claim.text());
