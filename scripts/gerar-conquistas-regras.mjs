// Gera a migration e o rollback das REGRAS de conquistas (19/11/2026) a partir dos corpos
// REAIS das funções em produção (copiados das migrations), aplicando só as mudanças
// planejadas — cada substituição é conferida (falha se não casar o número exato de vezes).
//   node scripts/gerar-conquistas-regras.mjs
// Saídas: supabase/migrations/20261119120000_conquistas_regras.sql
//         supabase/rollback/conquistas_regras.sql
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

/** Bloco CREATE OR REPLACE FUNCTION public.<nome>(…) … <tag>; (a ÚLTIMA definição do arquivo). */
export function fnBlock(sql, nome) {
  const ini = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${nome}(`);
  if (ini < 0) throw new Error(`função ${nome} não encontrada`);
  const m = /AS (\$[A-Za-z_]*\$)/.exec(sql.slice(ini));
  if (!m) throw new Error(`${nome}: sem dollar-quote`);
  const tag = m[1];
  const abre = ini + m.index + m[0].length;
  const fecha = sql.indexOf(tag, abre);
  const pv = sql.indexOf(";", fecha + tag.length);
  return sql.slice(ini, pv + 1);
}

const trocar = (txt, de, para, vezes, rotulo) => {
  const n = txt.split(de).length - 1;
  if (n !== vezes)
    throw new Error(`${rotulo}: esperado ${vezes}×, achou ${n}×`);
  return txt.split(de).join(para);
};

// ------------------------------------------------------------------ fontes (produção)
const SRC_SCORED =
  "supabase/migrations/20260608161016_4a498957-8605-4dfc-a9cd-494245ccb841.sql";
const SRC_PART = "supabase/migrations/20261108120000_diario_d1_escolha.sql";
const SRC_MATCH =
  "supabase/migrations/20261112110000_rooms_leitura_restrita.sql";
const orig = {
  scored: fnBlock(rd(SRC_SCORED), "submit_daily_attempt_scored"),
  part: fnBlock(rd(SRC_PART), "daily_record_participation"),
  match: fnBlock(rd(SRC_MATCH), "record_match_result"),
};

// ------------------------------------------------------------------ Diário: sequência por DIA
const BLOCO_HORA = `  IF v_stats.last_played_hour = v_prev_hour THEN
    v_new_streak := v_stats.current_streak + 1;
  ELSIF v_stats.last_played_hour = v_hour THEN
    v_new_streak := v_stats.current_streak;
  ELSE
    v_new_streak := 1;
  END IF;`;
const BLOCO_DIA = `  -- Sequência por DIA de calendário no horário de Brasília (America/Sao_Paulo), decidida
  -- no servidor pela hora do desafio: várias participações no mesmo dia não somam; o dia
  -- seguinte soma 1; um dia sem participação recomeça em 1. Acerto não importa.
  v_day := (v_hour AT TIME ZONE 'America/Sao_Paulo')::date;
  IF v_stats.last_played_date = v_day THEN
    v_new_streak := GREATEST(v_stats.current_streak, 1);
  ELSIF v_stats.last_played_date = v_day - 1 THEN
    v_new_streak := v_stats.current_streak + 1;
  ELSE
    v_new_streak := 1;
  END IF;`;
// concessão idempotente: ON CONFLICT (requisição repetida/concorrente não aborta a jogada)
const concessao = (txt) =>
  txt.replace(
    /IF (v_new_streak >= \d+ AND )?NOT EXISTS \(SELECT 1 FROM public\.user_achievements WHERE user_id = p_user_id AND achievement_code = '(\w+)'\) THEN\n(\s+)INSERT INTO public\.user_achievements \(user_id, achievement_code\) VALUES \(p_user_id, '\2'\);\n\s+v_unlocked_codes := array_append\(v_unlocked_codes, '\2'\);/g,
    (_m, cond, code, ind) =>
      `IF ${cond ? cond.replace(/ AND $/, "") : "TRUE"} THEN\n${ind}INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, '${code}')\n${ind}ON CONFLICT (user_id, achievement_code) DO NOTHING;\n${ind}IF FOUND THEN v_unlocked_codes := array_append(v_unlocked_codes, '${code}'); END IF;`,
  );
const diario = (f, rot) => {
  let t = trocar(f, BLOCO_HORA, BLOCO_DIA, 1, `${rot}: bloco da sequência`);
  t = trocar(
    t,
    "  v_new_streak integer := 1;\n",
    "  v_new_streak integer := 1;\n  v_day date;\n",
    1,
    `${rot}: declaração`,
  );
  t = trocar(
    t,
    "    last_played_date = v_hour::date,\n",
    "    last_played_date = v_day,\n",
    1,
    `${rot}: last_played_date`,
  );
  const antes = (
    t.match(/NOT EXISTS \(SELECT 1 FROM public\.user_achievements/g) ?? []
  ).length;
  t = concessao(t);
  const depois = (
    t.match(/ON CONFLICT \(user_id, achievement_code\) DO NOTHING/g) ?? []
  ).length;
  if (antes !== 4 || depois !== 4)
    throw new Error(`${rot}: concessões ${antes}→${depois} (esperado 4)`);
  return t;
};
const novo = {
  scored: diario(orig.scored, "submit_daily_attempt_scored"),
  part: diario(orig.part, "daily_record_participation"),
};

// ------------------------------------------------------------------ Partida: 4 conquistas sem regra
let m = orig.match;
m = trocar(
  m,
  "  v_fooled int;\n",
  "  v_fooled int;\n  v_max_votos_def int;\n",
  1,
  "match: declaração",
);
const POS_FOOLED = `    AND d.is_truth = false AND v.voter_id <> v_player.id;\n`;
m = trocar(
  m,
  POS_FOOLED,
  `${POS_FOOLED}
  -- Mestre do Blefe: maior número de votos recebidos por UMA definição falsa sua nesta
  -- partida (mesma contagem de votos do Maior Enganador, mas por definição).
  SELECT COALESCE(max(n), 0) INTO v_max_votos_def FROM (
    SELECT count(*) AS n
      FROM public.votes v
      JOIN public.definitions d ON d.id = v.definition_id
     WHERE v.room_id = v_room.id AND d.player_id = v_player.id
       AND d.is_truth = false AND v.voter_id <> v_player.id
     GROUP BY d.id) x;
`,
  1,
  "match: votos por definição",
);
m = trocar(
  m,
  "      ('maior_enganador', v_fooled >= 5)\n",
  `      ('maior_enganador', v_fooled >= 5),
      ('truth_seeker',    v_stats.total_truth_hits >= 10),
      ('coordinator_5',   v_stats.rounds_coordinated >= 5),
      ('big_score',       v_player.score >= 30),
      ('bluff_master',    v_max_votos_def >= 5)
`,
  1,
  "match: metas",
);
novo.match = m;

// ------------------------------------------------------------------ migration
const DESC_ME_ANTES = "Engane 5 ou mais jogadores numa única partida.";
const DESC_ME_DEPOIS =
  "Receba pelo menos 5 votos nas suas definições falsas em uma única partida.";
const migration = `-- =============================================================================
-- Conquistas: regras alinhadas às descrições do catálogo (19/11/2026). PREPARADA, NÃO APLICADA.
--
-- 1) Sequência do Diário (Em Chamas 3 / Semana Perfeita 7 / Lenda do Verbete 30) passa a contar
--    DIAS de calendário no horário de Brasília (America/Sao_Paulo), nos DOIS caminhos ativos:
--    modo juiz (submit_daily_attempt_scored, chamada por daily_finish_ok) e modo escolha
--    (daily_record_participation, chamada por daily_choice_finish). Antes contava HORAS seguidas.
-- 2) Concessões do Diário idempotentes (ON CONFLICT DO NOTHING): repetição/concorrência não
--    aborta a jogada nem duplica conquista (UNIQUE (user_id, achievement_code) já existe).
-- 3) record_match_result concede as 4 conquistas que não tinham regra: Caçador da Verdade
--    (10 acertos), Coordenador Nato (5 rodadas), Pontuação Massiva (30+ pontos numa partida),
--    Mestre do Blefe (5+ votos numa única definição falsa). Borboleta Social: só proposta
--    (exige armazenamento novo; ver docs).
-- 4) Maior Enganador: descrição alinhada ao critério (votos, não jogadores distintos).
-- 5) Conversão dos contadores de sequência (horas → dias), recalculados do histórico de
--    daily_attempts; valores antigos guardados em public.conquistas_streak_horas_bkp (rollback).
-- NÃO muda: pontuação, XP, total_score, demais estatísticas, conquistas já concedidas,
-- permissões (CREATE OR REPLACE preserva a ACL). Rollback: supabase/rollback/conquistas_regras.sql
-- Funções = corpos de produção (${SRC_SCORED.split("/").pop()}, ${SRC_PART.split("/").pop()},
-- ${SRC_MATCH.split("/").pop()}) + só as mudanças acima (gerado por scripts/gerar-conquistas-regras.mjs).
-- =============================================================================

${novo.scored}

${novo.part}

${novo.match}

UPDATE public.achievements SET description = '${DESC_ME_DEPOIS}'
 WHERE code = 'maior_enganador' AND description = '${DESC_ME_ANTES}';

-- Conversão horas → dias (backup antes; recálculo só de quem tem histórico no Diário).
CREATE TABLE IF NOT EXISTS public.conquistas_streak_horas_bkp AS
  SELECT user_id, current_streak, best_streak, last_played_date, last_played_hour, now() AS salvo_em
    FROM public.user_stats;
ALTER TABLE public.conquistas_streak_horas_bkp ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conquistas_streak_horas_bkp FROM PUBLIC, anon, authenticated;

WITH dias AS (
  SELECT DISTINCT user_id, (challenge_hour AT TIME ZONE 'America/Sao_Paulo')::date AS dia
    FROM public.daily_attempts
), grupos AS (
  SELECT user_id, dia, dia - (row_number() OVER (PARTITION BY user_id ORDER BY dia))::int AS g
    FROM dias
), sequencias AS (
  SELECT user_id, count(*)::int AS tam, max(dia) AS fim FROM grupos GROUP BY user_id, g
), por_usuario AS (
  SELECT user_id, max(tam) AS melhor, (array_agg(tam ORDER BY fim DESC))[1] AS atual, max(fim) AS ultimo
    FROM sequencias GROUP BY user_id
)
UPDATE public.user_stats s
   SET current_streak = p.atual, best_streak = p.melhor, last_played_date = p.ultimo, updated_at = now()
  FROM por_usuario p
 WHERE s.user_id = p.user_id;
-- Sem histórico no Diário: a sequência em horas não vira dias (zera; o valor antigo fica no backup).
UPDATE public.user_stats s SET current_streak = 0, best_streak = 0, updated_at = now()
 WHERE (s.current_streak <> 0 OR s.best_streak <> 0)
   AND NOT EXISTS (SELECT 1 FROM public.daily_attempts a WHERE a.user_id = s.user_id);
`;

const rollback = `-- ROLLBACK de 20261119120000_conquistas_regras.sql: devolve os 3 corpos de antes (byte a byte),
-- a descrição do Maior Enganador e os contadores de sequência (do backup). Conquistas concedidas
-- depois da migration NÃO são removidas (foram conquistadas pelas regras vigentes).
-- Depois: supabase migration repair --status reverted 20261119120000

${orig.scored}

${orig.part}

${orig.match}

UPDATE public.achievements SET description = '${DESC_ME_ANTES}'
 WHERE code = 'maior_enganador' AND description = '${DESC_ME_DEPOIS}';

UPDATE public.user_stats s
   SET current_streak = b.current_streak, best_streak = b.best_streak,
       last_played_date = b.last_played_date, last_played_hour = b.last_played_hour, updated_at = now()
  FROM public.conquistas_streak_horas_bkp b
 WHERE s.user_id = b.user_id;
DROP TABLE IF EXISTS public.conquistas_streak_horas_bkp;
`;

// só grava quando executado direto (importar fnBlock nos testes NÃO pode regravar a migration)
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  writeFileSync(
    join(ROOT, "supabase/migrations/20261119120000_conquistas_regras.sql"),
    migration,
  );
  writeFileSync(
    join(ROOT, "supabase/rollback/conquistas_regras.sql"),
    rollback,
  );
  console.log("ok: migration e rollback gerados");
}
