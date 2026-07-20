// Regressão E2E pós-guardas de identidade: rodada completa via REST com a
// anon key SEM sessão (auth.uid() NULL — caminho dos clients atuais).
// Valida que o motor continua intacto: create → start → choose → defs →
// voting → reveal com a pontuação ORIGINAL (+3 verdade, +1 por enganado).
import pg from "pg";
const { SUPA_URL, ANON, DB_URL } = process.env;

const rpc = async (fn, body) => {
  const r = await fetch(`${SUPA_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (r.status >= 300) console.log(`  !! ${fn} -> ${r.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
};

// SSL só contra o Supabase remoto; o Postgres local do CI (supabase start) não tem TLS.
const db = new pg.Client({
  connectionString: DB_URL,
  ssl: /supabase\.co/.test(DB_URL ?? "") ? { rejectUnauthorized: false } : false,
});
await db.connect();
let fails = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};

// 1) cria sala (REST anônimo)
const room = await rpc("create_room_with_host", {
  p_host_id: "e2e_host", p_nickname: "E2E Host", p_avatar: "🤖", p_color: "#abc",
});
check("create_room_with_host", !!room?.id, room?.code);
const rid = room.id;

// 2) bots direto no DB (como faz o client do host via inserts permitidos)
await db.query(`
  INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot) VALUES
  ('e2e_b1', $1, 'Bot1', '🦊', '#111', true),
  ('e2e_b2', $1, 'Bot2', '🐸', '#222', true),
  ('e2e_b3', $1, 'Bot3', '🦉', '#333', true)`, [rid]);

// 3) start + coordenador determinístico (host)
const sg = await rpc("start_game", { p_room_id: rid });
check("start_game", sg?.ok === true, JSON.stringify(sg));
await db.query(`UPDATE public.rooms SET current_coordinator = 'e2e_host' WHERE id = $1`, [rid]);

// 4) escolhe palavra
const { rows: [word] } = await db.query(`SELECT id, word FROM public.words LIMIT 1`);
const cw = await rpc("choose_word", { p_room_id: rid, p_word_id: word.id, p_duration_sec: 60 });
check("choose_word", cw?.ok === true || cw === "" || cw == null, JSON.stringify(cw).slice(0, 80));
const { rows: [st1] } = await db.query(`SELECT status FROM public.rooms WHERE id = $1`, [rid]);
check("status = writing", st1.status === "writing", st1.status);

// 5) verdade + blefes dos bots
await rpc("insert_truth_definition", { p_room_id: rid, p_round: 1, p_text: "significado verdadeiro de teste e2e" });
await rpc("submit_bot_definitions_bulk", {
  p_room_id: rid, p_round: 1,
  p_rows: [
    { player_id: "e2e_b1", text: "blefe astuto do bot um" },
    { player_id: "e2e_b2", text: "blefe esperto do bot dois" },
    { player_id: "e2e_b3", text: "blefe criativo do bot tres" },
  ],
});
const { rows: [dc] } = await db.query(
  `SELECT count(*)::int AS n FROM public.definitions WHERE room_id = $1 AND round = 1`, [rid]);
check("4 definições (verdade + 3 blefes)", dc.n === 4, `n=${dc.n}`);

// 6) avança para votação
await rpc("advance_writing_to_voting", { p_room_id: rid });
const { rows: [st2] } = await db.query(`SELECT status FROM public.rooms WHERE id = $1`, [rid]);
check("status = voting", ["voting", "shuffling"].includes(st2.status), st2.status);
if (st2.status === "shuffling") {
  await rpc("advance_writing_to_voting", { p_room_id: rid });
}

// 7) votos: b1→verdade (+3), b3→verdade (+3), b2→blefe do b1 (b1 +1)
const { rows: defs } = await db.query(
  `SELECT id, player_id FROM public.definitions WHERE room_id = $1 AND round = 1`, [rid]);
const truth = defs.find((d) => d.player_id === "__truth__");
const defB1 = defs.find((d) => d.player_id === "e2e_b1");
await rpc("cast_votes_bulk", {
  p_room_id: rid, p_round: 1,
  p_votes: [
    { voter_id: "e2e_b1", definition_id: truth.id },
    { voter_id: "e2e_b3", definition_id: truth.id },
    { voter_id: "e2e_b2", definition_id: defB1.id },
  ],
});
const { rows: [vc] } = await db.query(
  `SELECT count(*)::int AS n FROM public.votes WHERE room_id = $1 AND round = 1`, [rid]);
check("3 votos registrados", vc.n === 3, `n=${vc.n}`);

// 8) revela e confere pontuação ORIGINAL congelada
await rpc("advance_voting_to_reveal", { p_room_id: rid });
const { rows: scores } = await db.query(
  `SELECT id, score FROM public.players WHERE room_id = $1 ORDER BY id`, [rid]);
const S = Object.fromEntries(scores.map((p) => [p.id, p.score]));
check("b1 = 4 (+3 verdade, +1 enganou)", S.e2e_b1 === 4, `b1=${S.e2e_b1}`);
check("b2 = 0", S.e2e_b2 === 0, `b2=${S.e2e_b2}`);
check("b3 = 3 (+3 verdade)", S.e2e_b3 === 3, `b3=${S.e2e_b3}`);
check("host (coord) = 0 (alguém achou a verdade)", S.e2e_host === 0, `host=${S.e2e_host}`);
const { rows: [st3] } = await db.query(`SELECT status FROM public.rooms WHERE id = $1`, [rid]);
check("status = reveal", st3.status === "reveal", st3.status);

// limpeza
await db.query(`DELETE FROM public.rooms WHERE id = $1`, [rid]);
await db.query(`DELETE FROM public.players WHERE id LIKE 'e2e_%'`);
await db.end();
console.log(fails ? `\n${fails} FALHAS` : "\nRODADA E2E OK — motor intacto");
process.exit(fails ? 1 : 0);
