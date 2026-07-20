// Testa as guardas de identidade (Fase 1 · parte 4) simulando sessões
// autenticadas via SET LOCAL request.jwt.claims — auth.uid() lê esse GUC,
// então dá para validar o enforcement sem o toggle de anonymous sign-in.
import pg from "pg";
// SSL só contra o Supabase remoto; o Postgres local do CI (supabase start) não tem TLS.
const ssl = /supabase\.co/.test(process.env.DB_URL ?? "") ? { rejectUnauthorized: false } : false;
const c = new pg.Client({ connectionString: process.env.DB_URL, ssl });
await c.connect();

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
};

// FK de players.user_id?
const { rows: cons } = await c.query(
  `SELECT conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint WHERE conrelid = 'public.players'::regclass`);
const userFk = cons.find(x => /user_id/.test(x.def) && /FOREIGN KEY/.test(x.def));
console.log("players constraints:", cons.map(x => x.def).join(" | "));
console.log("user_id FK:", userFk ? userFk.def : "nenhuma (uuid livre)");

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const asUser = (uid) =>
  `SET LOCAL request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; SET LOCAL ROLE authenticated;`;

// Se houver FK para auth.users, cria usuários fake direto (service-level)
if (userFk) {
  await c.query(`
    INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at)
    VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u1@test.local', '', now(), now()),
           ($2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u2@test.local', '', now(), now())
    ON CONFLICT (id) DO NOTHING`, [U1, U2]);
}

// ---------- setup: sala de teste com A (claimed U1, host), B (claimed U2), C (livre)
await c.query(`DELETE FROM public.rooms WHERE code = '9901'`);
const { rows: [room] } = await c.query(
  `INSERT INTO public.rooms (code, host_id, status) VALUES ('9901', 'idtest_a', 'lobby') RETURNING id`);
const rid = room.id;
await c.query(`
  INSERT INTO public.players (id, room_id, nickname, avatar, color, user_id, is_bot) VALUES
  ('idtest_a', $1, 'Alice', '🐸', '#f00', $2, false),
  ('idtest_b', $1, 'Beto',  '🦊', '#0f0', $3, false),
  ('idtest_c', $1, 'Livre', '🐼', '#00f', NULL, false)`, [rid, U1, U2]);

const rpc = async (claims, sql, params) => {
  await c.query("BEGIN");
  try {
    if (claims) await c.query(asUser(claims));
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return { ok: true, rows: r.rows };
  } catch (e) {
    await c.query("ROLLBACK");
    return { ok: false, err: e.message };
  }
};

// 1) U2 tenta mandar mensagem como Alice → identity_mismatch
let r = await rpc(U2, `SELECT public.send_room_message($1, 'idtest_a', 'oi') AS out`, [rid]);
check("mensagem forjada (U2 como Alice) bloqueada",
  r.ok && r.rows[0].out.reason === "identity_mismatch", JSON.stringify(r.rows?.[0]?.out ?? r.err));

// 2) U1 manda mensagem como Alice → ok
r = await rpc(U1, `SELECT public.send_room_message($1, 'idtest_a', 'oi legit') AS out`, [rid]);
check("mensagem legítima (U1 como Alice) passa",
  r.ok && r.rows[0].out.ok === true, JSON.stringify(r.rows?.[0]?.out ?? r.err));

// 3) Sem sessão → fallback libera
r = await rpc(null, `SELECT public.send_room_message($1, 'idtest_c', 'sem sessao') AS out`, [rid]);
check("sem sessão (fallback) passa",
  r.ok && r.rows[0].out.ok === true, JSON.stringify(r.rows?.[0]?.out ?? r.err));

// 4) Jogador livre (user_id NULL) com sessão → residual liberado
await new Promise((res) => setTimeout(res, 900)); // fora do rate-limit de 800ms
r = await rpc(U2, `SELECT public.send_room_message($1, 'idtest_c', 'livre com sessao') AS out`, [rid]);
check("jogador não-reivindicado com sessão passa (residual)",
  r.ok && r.rows[0].out.ok === true, JSON.stringify(r.rows?.[0]?.out ?? r.err));

// 5) INSERT direto forjado em definitions → exceção do trigger
r = await rpc(U2, `INSERT INTO public.definitions (room_id, round, player_id, text) VALUES ($1, 1, 'idtest_a', 'def forjada')`, [rid]);
check("definição forjada (trigger) bloqueada",
  !r.ok && /identity_mismatch/.test(r.err ?? ""), r.err);

// 6) Voto forjado → descartado em silêncio (linha não entra)
await c.query(`INSERT INTO public.definitions (room_id, round, player_id, text) VALUES ($1, 1, 'idtest_c', 'def do livre')`, [rid]);
const { rows: [defRow] } = await c.query(`SELECT id FROM public.definitions WHERE room_id = $1 AND player_id = 'idtest_c'`, [rid]);
r = await rpc(U2, `INSERT INTO public.votes (room_id, round, voter_id, definition_id) VALUES ($1, 1, 'idtest_a', $2)`, [rid, defRow.id]);
const { rows: [vc] } = await c.query(`SELECT count(*)::int AS n FROM public.votes WHERE room_id = $1 AND voter_id = 'idtest_a'`, [rid]);
check("voto forjado descartado em silêncio", r.ok && vc.n === 0, `insert ok=${r.ok}, votos de Alice=${vc.n}`);

// 7) rejoin com id de outra identidade → player_id_taken
r = await rpc(U2, `SELECT public.rejoin_room('9901', 'idtest_a', 'Ladrao', '🦹', '#000') AS out`);
check("rejoin sequestrando id de Alice bloqueado",
  !r.ok && /player_id_taken/.test(r.err ?? ""), r.err);

// 8) create_room_with_host com id de outra identidade → player_id_taken
r = await rpc(U2, `SELECT public.create_room_with_host('idtest_a', 'Ladrao', '🦹', '#000') AS out`);
check("create_room sequestrando id de Alice bloqueado",
  !r.ok && /player_id_taken/.test(r.err ?? ""), r.err);

// 9) reset_room por quem não é o host → not_authorized
r = await rpc(U2, `SELECT public.reset_room($1)`, [rid]);
check("reset_room por não-host bloqueado",
  !r.ok && /not_authorized/.test(r.err ?? ""), r.err);

// 10) reset_room pelo host (U1) → ok
r = await rpc(U1, `SELECT public.reset_room($1)`, [rid]);
check("reset_room pelo host passa", r.ok, r.err ?? "");

// 11) start_game por não-host → not_authorized (retorno jsonb)
await c.query(`UPDATE public.rooms SET status = 'lobby' WHERE id = $1`, [rid]);
r = await rpc(U2, `SELECT public.start_game($1) AS out`, [rid]);
check("start_game por não-host bloqueado",
  r.ok && r.rows[0].out.reason === "not_authorized", JSON.stringify(r.rows?.[0]?.out ?? r.err));

// 12) kick_player forjando ator host → identity_mismatch
r = await rpc(U2, `SELECT public.kick_player($1, 'idtest_a', 'idtest_b') AS out`, [rid]);
check("kick forjando o host bloqueado",
  r.ok && r.rows[0].out.reason === "identity_mismatch", JSON.stringify(r.rows?.[0]?.out ?? r.err));

// 13) rejoin legítimo do jogador livre com sessão → reivindica user_id
r = await rpc(U2, `SELECT public.rejoin_room('9901', 'idtest_c', 'Livre', '🐼', '#00f') AS out`);
const { rows: [claimed] } = await c.query(`SELECT user_id FROM public.players WHERE id = 'idtest_c'`);
check("rejoin reivindica identidade do jogador livre",
  r.ok && claimed.user_id === U2, `user_id=${claimed.user_id}`);

// ---------- limpeza
await c.query(`DELETE FROM public.rooms WHERE code = '9901'`);
await c.query(`DELETE FROM public.players WHERE id LIKE 'idtest_%'`);
if (userFk) await c.query(`DELETE FROM auth.users WHERE id IN ($1, $2)`, [U1, U2]);

const fails = results.filter(x => !x.ok).length;
console.log(`\n${results.length - fails}/${results.length} testes passaram`);
process.exit(fails ? 1 : 0);
