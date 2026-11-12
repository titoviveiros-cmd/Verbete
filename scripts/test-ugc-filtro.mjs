// ECA Digital (11/11/2026) — filtro de conteúdo de jogador NO SERVIDOR
// (20261111120000_ugc_filtro_servidor.sql). Confere:
//   * public.ugc_text_issue com os MESMOS casos do cliente
//     (scripts/ugc-filter-cases.mjs ↔ src/lib/__tests__/ugc-filter-parity.test.ts);
//   * submit_definition recusa por gatilho (erro "ugc_rejected:<motivo>"),
//     aceita texto legítimo; bot e definição verdadeira ficam de fora;
//   * apelido (players) e nome exibido (profiles, inclusive via cadastro)
//     com problema viram 'Jogador'; avatar com texto vira 🦊; reação com
//     texto é descartada;
//   * categorias e times da sala (host_update_room_config e UPDATE direto):
//     só a lista fechada do app (R6, 12/11);
//   * funções internas fechadas para anon/authenticated;
//   * rollback limpo.
// Tudo numa transação desfeita no fim. Envs: DB_URL.
import { readFileSync } from "node:fs";
import pg from "pg";
import { UGC_CASES } from "./ugc-filter-cases.mjs";

const { DB_URL } = process.env;
const ssl = /supabase\.co/.test(DB_URL ?? "")
  ? { rejectUnauthorized: false }
  : false;
const db = new pg.Client({ connectionString: DB_URL, ssl });
await db.connect();
let total = 0;
let fails = 0;
const check = (name, ok, detail = "") => {
  total++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
const row = async (sql, p = []) => (await db.query(sql, p)).rows[0];

for (const [text, expected] of UGC_CASES) {
  const got = (await row("SELECT public.ugc_text_issue($1) r", [text])).r;
  check(`ugc_text_issue ${JSON.stringify(text)} → ${expected}`, got === expected, `veio ${got}`);
}

await db.query("BEGIN");
try {
  const tag = Math.random().toString(36).slice(2, 7);
  const w = await row(
    `INSERT INTO public.words (word, meaning, category, status) VALUES ($1, 'guia de visitantes', 'pessoa', 'published')
     ON CONFLICT (word) DO UPDATE SET word = EXCLUDED.word RETURNING id`,
    ["cicerone"],
  );
  const r = await row(
    `INSERT INTO public.rooms (code, host_id, status, current_round, current_word_id, current_coordinator, phase_started_at)
     VALUES ($1, $2, 'writing', 1, $3, $4, now()) RETURNING id`,
    [`UG${tag}`, `ug_h_${tag}`, w.id, `ug_c_${tag}`],
  );
  for (const id of [`ug_h_${tag}`, `ug_c_${tag}`, `ug_p_${tag}`])
    await db.query(
      `INSERT INTO public.players (id, room_id, nickname, avatar, color) VALUES ($1, $2, $1, 'x', '#000')`,
      [id, r.id],
    );
  const submit = async (text) => {
    await db.query("SAVEPOINT s");
    try {
      const v = (
        await row("SELECT public.submit_definition($1, $2, $3) v", [r.id, `ug_p_${tag}`, text])
      ).v;
      await db.query("RELEASE SAVEPOINT s");
      return v;
    } catch (e) {
      await db.query("ROLLBACK TO SAVEPOINT s");
      return { error: e.message };
    }
  };

  const bad = await submit("me chama no zapzap 11987654321");
  check(
    "submit_definition: contato recusado pelo gatilho (ugc_rejected:contact)",
    bad.error === "ugc_rejected:contact",
    JSON.stringify(bad),
  );
  const swear = await submit("que porra de guia");
  check(
    "submit_definition: palavrão recusado (ugc_rejected:blocked_word)",
    swear.error === "ugc_rejected:blocked_word",
    JSON.stringify(swear),
  );
  const ok = await submit("guia de turistas que conduz visitas");
  check("submit_definition: texto legítimo aceito", ok.ok === true, JSON.stringify(ok));
  const n = await row("SELECT count(*)::int n FROM public.definitions WHERE room_id = $1", [r.id]);
  check("recusadas não gravam", n.n === 1, `gravadas=${n.n}`);
  // UPDATE direto do texto também passa pelo gatilho.
  await db.query("SAVEPOINT u");
  let upd = "";
  try {
    await db.query("UPDATE public.definitions SET text = 'me segue @fulano' WHERE room_id = $1", [r.id]);
  } catch (e) {
    upd = e.message;
  }
  await db.query("ROLLBACK TO SAVEPOINT u");
  check("UPDATE do texto passa pelo gatilho", upd === "ugc_rejected:contact", upd);

  // Bot e definição verdadeira ficam de fora.
  await db.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot) VALUES ($1, $2, 'Bot', 'x', '#000', true)`,
    [`ug_b_${tag}`, r.id],
  );
  await db.query(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth) VALUES ($1, 1, $2, 'texto do bot com wpp', false)`,
    [r.id, `ug_b_${tag}`],
  );
  await db.query(
    `INSERT INTO public.definitions (room_id, round, player_id, text, is_truth) VALUES ($1, 1, '__truth__', 'merda (verbete do dicionario)', true)`,
    [r.id],
  );
  check("bot e definição verdadeira não passam pelo filtro", true);

  // Apelido: troca por 'Jogador' (INSERT e UPDATE); bot intocado.
  await db.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color) VALUES ($1, $2, 'Porra Louca', 'x', '#000')`,
    [`ug_q_${tag}`, r.id],
  );
  const nick1 = await row("SELECT nickname FROM public.players WHERE id = $1", [`ug_q_${tag}`]);
  check("apelido com palavrão vira 'Jogador' (INSERT)", nick1.nickname === "Jogador", nick1.nickname);
  await db.query("UPDATE public.players SET nickname = 'Ana 11987654321' WHERE id = $1", [`ug_p_${tag}`]);
  const nick2 = await row("SELECT nickname FROM public.players WHERE id = $1", [`ug_p_${tag}`]);
  check("apelido com telefone vira 'Jogador' (UPDATE)", nick2.nickname === "Jogador", nick2.nickname);
  await db.query("UPDATE public.players SET nickname = 'Ze Tagarela' WHERE id = $1", [`ug_p_${tag}`]);
  const nick3 = await row("SELECT nickname FROM public.players WHERE id = $1", [`ug_p_${tag}`]);
  check("apelido limpo fica como está", nick3.nickname === "Ze Tagarela", nick3.nickname);

  // Avatar: só símbolo; texto vira o avatar padrão.
  await db.query("UPDATE public.players SET avatar = 'zap 11987654321' WHERE id = $1", [`ug_p_${tag}`]);
  const av = await row("SELECT avatar FROM public.players WHERE id = $1", [`ug_p_${tag}`]);
  check("avatar com texto vira o padrão 🦊", av.avatar === "🦊", av.avatar);
  await db.query("UPDATE public.players SET avatar = '🐸' WHERE id = $1", [`ug_p_${tag}`]);
  const av2 = await row("SELECT avatar FROM public.players WHERE id = $1", [`ug_p_${tag}`]);
  check("avatar emoji fica como está", av2.avatar === "🐸", av2.avatar);

  // Reação: texto descartado, emoji passa.
  await db.query(
    `INSERT INTO public.reactions (room_id, player_id, emoji) VALUES ($1, $2, 'zap 123'), ($1, $2, '😂')`,
    [r.id, `ug_p_${tag}`],
  );
  const rx = await db.query("SELECT emoji FROM public.reactions WHERE room_id = $1", [r.id]);
  check(
    "reação com texto é descartada; emoji passa",
    rx.rows.length === 1 && rx.rows[0].emoji === "😂",
    JSON.stringify(rx.rows),
  );

  // Nome exibido: cadastro (handle_new_user) e UPDATE direto.
  const uid = (await row("SELECT gen_random_uuid() id")).id;
  await db.query(
    `INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, raw_user_meta_data)
     VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '', now(), now(), $3)`,
    [uid, `ug_${tag}@test.local`, JSON.stringify({ display_name: "Caralho Voador" })],
  );
  const p1 = await row("SELECT display_name FROM public.profiles WHERE user_id = $1", [uid]);
  check("nome exibido com palavrão no cadastro vira 'Jogador'", p1?.display_name === "Jogador", p1?.display_name);
  await db.query("UPDATE public.profiles SET display_name = 'me add no discord' WHERE user_id = $1", [uid]);
  const p2 = await row("SELECT display_name FROM public.profiles WHERE user_id = $1", [uid]);
  check("nome exibido com rede social (UPDATE) vira 'Jogador'", p2.display_name === "Jogador", p2.display_name);
  await db.query("UPDATE public.profiles SET display_name = 'Leitora Voraz' WHERE user_id = $1", [uid]);
  const p3 = await row("SELECT display_name FROM public.profiles WHERE user_id = $1", [uid]);
  check("nome exibido limpo fica como está", p3.display_name === "Leitora Voraz", p3.display_name);

  // R6 (12/11): categorias e times da sala = LISTA FECHADA (o app só oferece
  // opções prontas). Pela RPC do dono e por UPDATE direto.
  const lobby = await row(
    `INSERT INTO public.rooms (code, host_id, status) VALUES ($1, $2, 'lobby') RETURNING id`,
    [`UL${tag}`, `ug_lh_${tag}`],
  );
  await db.query(
    `INSERT INTO public.players (id, room_id, nickname, avatar, color) VALUES ($1, $2, 'Dona', 'x', '#000')`,
    [`ug_lh_${tag}`, lobby.id],
  );
  const cfg = async (patch) => {
    await db.query("SAVEPOINT c");
    try {
      const v = (
        await row("SELECT public.host_update_room_config($1, $2, $3::jsonb) v", [
          lobby.id,
          `ug_lh_${tag}`,
          JSON.stringify(patch),
        ])
      ).v;
      await db.query("RELEASE SAVEPOINT c");
      return { ok: v?.ok === true, v };
    } catch (e) {
      await db.query("ROLLBACK TO SAVEPOINT c");
      return { ok: false, error: e.message };
    }
  };
  const roomCfg = () => row("SELECT categories, teams FROM public.rooms WHERE id = $1", [lobby.id]);
  const TEAMS_AB = [
    { id: "a", name: "Time A", color: "#FFD166", emoji: "🅰️" },
    { id: "b", name: "Time B", color: "#06D6A0", emoji: "🅱️" },
  ];
  const TEAMS_MW = [
    { id: "men", name: "Homens", color: "#3B82F6", emoji: "👨" },
    { id: "women", name: "Mulheres", color: "#EC4899", emoji: "👩" },
  ];

  const c1 = await cfg({ categories: ["animal", "nautica"] });
  check("categorias da lista do app: aceitas", c1.ok && JSON.stringify((await roomCfg()).categories) === '["animal","nautica"]', JSON.stringify(c1));
  const c2 = await cfg({ categories: ["animal", "me chama 11987654321"] });
  check("categoria fora da lista (texto livre): recusada", !c2.ok && /ugc_rejected:categories/.test(c2.error ?? ""), JSON.stringify(c2));
  const c3 = await cfg({ categories: ["Animal"] });
  check("categoria com grafia diferente da chave: recusada", !c3.ok && /ugc_rejected:categories/.test(c3.error ?? ""), JSON.stringify(c3));
  const c4 = await cfg({ categories: ["animal", "animal"] });
  check("categoria repetida: recusada", !c4.ok && /ugc_rejected:categories/.test(c4.error ?? ""), JSON.stringify(c4));
  check("recusa desfaz a chamada inteira (categorias anteriores ficam)", JSON.stringify((await roomCfg()).categories) === '["animal","nautica"]');
  const c5 = await cfg({ categories: [] });
  check("categorias vazias (= Todas): aceitas", c5.ok && (await roomCfg()).categories.length === 0, JSON.stringify(c5));

  const t1 = await cfg({ mode: "teams", teams: TEAMS_MW });
  check("times: preset Homens × Mulheres aceito", t1.ok, JSON.stringify(t1));
  const t2 = await cfg({ teams: TEAMS_AB });
  check("times: preset Time A × Time B aceito", t2.ok, JSON.stringify(t2));
  const t3 = await cfg({ teams: [{ ...TEAMS_AB[0], name: "zap 11987654321" }, TEAMS_AB[1]] });
  check("times: nome trocado pela API: recusado", !t3.ok && /ugc_rejected:teams/.test(t3.error ?? ""), JSON.stringify(t3));
  const t4 = await cfg({ teams: [TEAMS_AB[0]] });
  check("times: pedaço de preset: recusado", !t4.ok && /ugc_rejected:teams/.test(t4.error ?? ""), JSON.stringify(t4));
  const t5 = await cfg({ teams: [{ ...TEAMS_AB[0], extra: "x" }, TEAMS_AB[1]] });
  check("times: campo a mais: recusado", !t5.ok && /ugc_rejected:teams/.test(t5.error ?? ""), JSON.stringify(t5));
  const t6 = await cfg({ mode: "individual", teams: [] });
  check("times: '[]' (modo individual) aceito", t6.ok && JSON.stringify((await roomCfg()).teams) === "[]", JSON.stringify(t6));

  await db.query("SAVEPOINT d");
  let direct = null;
  try {
    await db.query("UPDATE public.rooms SET categories = ARRAY['instagram fulano'] WHERE id = $1", [lobby.id]);
  } catch (e) {
    direct = e.message;
  }
  await db.query("ROLLBACK TO SAVEPOINT d");
  check("UPDATE direto também passa pelo gatilho", /ugc_rejected:categories/.test(direct ?? ""), direct);

  // Linha antiga fora da lista só é conferida se o campo mudar.
  await db.query("ALTER TABLE public.rooms DISABLE TRIGGER rooms_config_ugc_guard");
  await db.query("UPDATE public.rooms SET categories = ARRAY['natureza'] WHERE id = $1", [lobby.id]);
  await db.query("ALTER TABLE public.rooms ENABLE TRIGGER rooms_config_ugc_guard");
  const old = await cfg({ nivel: "facil" });
  check("sala antiga com categoria fora da lista: outro campo muda normalmente", old.ok, JSON.stringify(old));

  const open = await row(
    `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
      WHERE s.nspname = 'public'
        AND p.proname IN ('ugc_text_issue', 'ugc_symbol_issue', 'definitions_ugc_guard', 'players_nickname_ugc_guard', 'profiles_display_name_ugc_guard', 'reactions_ugc_guard', 'room_config_issue', 'rooms_config_ugc_guard')
        AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
  );
  check("funções internas fechadas para anon/authenticated", open.n === 0, `${open.n} abertas`);

  // Rollback (dentro da transação desfeita): o texto volta a passar.
  await db.query(readFileSync("supabase/rollback/ugc_filtro_servidor.sql", "utf8"));
  const rb = await submit("me chama no zapzap 11987654321");
  const rbCfg = await cfg({ categories: ["texto livre"] });
  const gone = await row(
    `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
      WHERE s.nspname = 'public' AND p.proname IN ('ugc_text_issue', 'ugc_symbol_issue', 'definitions_ugc_guard', 'players_nickname_ugc_guard', 'profiles_display_name_ugc_guard', 'reactions_ugc_guard', 'room_config_issue', 'rooms_config_ugc_guard')`,
  );
  check(
    "rollback: gatilhos e funções saem; submit e configuração voltam a aceitar",
    rb.ok === true && rbCfg.ok === true && gone.n === 0,
    `${JSON.stringify(rb)} ${JSON.stringify(rbCfg)} funções=${gone.n}`,
  );
} catch (e) {
  check("suíte rodou até o fim", false, e.message);
} finally {
  await db.query("ROLLBACK").catch(() => {});
  await db.end();
}
console.log(`\n${total - fails}/${total} verificações OK`);
process.exit(fails ? 1 : 0);
