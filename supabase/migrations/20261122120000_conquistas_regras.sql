-- =============================================================================
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
--    + (20/11) dedup por PARTIDA (sala + rooms.finished_at), não mais por sala: a revanche
--    ("Nova partida", mesmo código) e códigos reaproveitados voltam a render XP/histórico.
-- 4) Maior Enganador: descrição alinhada ao critério (votos, não jogadores distintos).
-- 5) Conversão dos contadores de sequência (horas → dias), recalculados do histórico de
--    daily_attempts; valores antigos guardados em public.conquistas_streak_horas_bkp (rollback).
-- NÃO muda: pontuação, XP, total_score, demais estatísticas, conquistas já concedidas,
-- permissões (CREATE OR REPLACE preserva a ACL). Rollback: supabase/rollback/conquistas_regras.sql
-- Funções = corpos de produção (20260608161016_4a498957-8605-4dfc-a9cd-494245ccb841.sql, 20261108120000_diario_d1_escolha.sql,
-- 20261112110000_rooms_leitura_restrita.sql) + só as mudanças acima (gerado por scripts/gerar-conquistas-regras.mjs).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.submit_daily_attempt_scored(p_user_id uuid, p_guess text, p_time_seconds integer, p_similarity integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_hour timestamptz := date_trunc('hour', now());
  v_prev_hour timestamptz := v_hour - INTERVAL '1 hour';
  v_challenge public.daily_challenges;
  v_word public.words;
  v_similarity integer := GREATEST(0, LEAST(100, COALESCE(p_similarity, 0)));
  v_is_correct boolean := false;
  v_score integer := 0;
  v_base integer := 0;
  v_existing public.daily_attempts;
  v_stats public.user_stats;
  v_new_streak integer := 1;
  v_day date;
  v_unlocked_codes text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_existing FROM public.daily_attempts
  WHERE user_id = p_user_id AND challenge_hour = v_hour;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('already_played', true, 'attempt', to_jsonb(v_existing));
  END IF;

  PERFORM public.get_or_create_daily_challenge();
  SELECT * INTO v_challenge FROM public.daily_challenges WHERE challenge_hour = v_hour;
  SELECT * INTO v_word FROM public.words WHERE id = v_challenge.word_id;

  v_is_correct := v_similarity >= 80;
  IF v_is_correct THEN
    v_base := GREATEST(100 - COALESCE(p_time_seconds, 60), 20);
    v_score := GREATEST(ROUND(v_base * v_similarity / 100.0)::int, 20);
  END IF;

  INSERT INTO public.daily_attempts (user_id, challenge_date, challenge_hour, guess, is_correct, score, time_seconds, similarity)
  VALUES (p_user_id, v_hour::date, v_hour, COALESCE(p_guess, ''), v_is_correct, v_score, COALESCE(p_time_seconds, 0), v_similarity);

  INSERT INTO public.user_stats (user_id) VALUES (p_user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO v_stats FROM public.user_stats WHERE user_id = p_user_id;

  -- Sequência por DIA de calendário no horário de Brasília (America/Sao_Paulo), decidida
  -- no servidor pela hora do desafio: várias participações no mesmo dia não somam; o dia
  -- seguinte soma 1; um dia sem participação recomeça em 1. Acerto não importa.
  v_day := (v_hour AT TIME ZONE 'America/Sao_Paulo')::date;
  IF v_stats.last_played_date = v_day THEN
    v_new_streak := GREATEST(v_stats.current_streak, 1);
  ELSIF v_stats.last_played_date = v_day - 1 THEN
    v_new_streak := v_stats.current_streak + 1;
  ELSE
    v_new_streak := 1;
  END IF;

  UPDATE public.user_stats SET
    current_streak = v_new_streak,
    best_streak = GREATEST(best_streak, v_new_streak),
    last_played_date = v_day,
    last_played_hour = v_hour,
    total_score = total_score + v_score,
    updated_at = now()
  WHERE user_id = p_user_id;

  IF TRUE THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'first_daily')
    ON CONFLICT (user_id, achievement_code) DO NOTHING;
    IF FOUND THEN v_unlocked_codes := array_append(v_unlocked_codes, 'first_daily'); END IF;
  END IF;
  IF v_new_streak >= 3 THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_3')
    ON CONFLICT (user_id, achievement_code) DO NOTHING;
    IF FOUND THEN v_unlocked_codes := array_append(v_unlocked_codes, 'streak_3'); END IF;
  END IF;
  IF v_new_streak >= 7 THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_7')
    ON CONFLICT (user_id, achievement_code) DO NOTHING;
    IF FOUND THEN v_unlocked_codes := array_append(v_unlocked_codes, 'streak_7'); END IF;
  END IF;
  IF v_new_streak >= 30 THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_30')
    ON CONFLICT (user_id, achievement_code) DO NOTHING;
    IF FOUND THEN v_unlocked_codes := array_append(v_unlocked_codes, 'streak_30'); END IF;
  END IF;

  RETURN jsonb_build_object(
    'already_played', false,
    'is_correct', v_is_correct,
    'score', v_score,
    'similarity', v_similarity,
    'truth', v_word.meaning,
    'word', v_word.word,
    'current_streak', v_new_streak,
    'unlocked', v_unlocked_codes
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.daily_record_participation(p_user_id uuid, p_hour timestamptz, p_score integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_hour timestamptz := p_hour;
  v_prev_hour timestamptz := p_hour - INTERVAL '1 hour';
  v_score integer := COALESCE(p_score, 0);
  v_stats public.user_stats;
  v_new_streak integer := 1;
  v_day date;
  v_unlocked_codes text[] := ARRAY[]::text[];
BEGIN
  INSERT INTO public.user_stats (user_id) VALUES (p_user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO v_stats FROM public.user_stats WHERE user_id = p_user_id;

  -- Sequência por DIA de calendário no horário de Brasília (America/Sao_Paulo), decidida
  -- no servidor pela hora do desafio: várias participações no mesmo dia não somam; o dia
  -- seguinte soma 1; um dia sem participação recomeça em 1. Acerto não importa.
  v_day := (v_hour AT TIME ZONE 'America/Sao_Paulo')::date;
  IF v_stats.last_played_date = v_day THEN
    v_new_streak := GREATEST(v_stats.current_streak, 1);
  ELSIF v_stats.last_played_date = v_day - 1 THEN
    v_new_streak := v_stats.current_streak + 1;
  ELSE
    v_new_streak := 1;
  END IF;

  UPDATE public.user_stats SET
    current_streak = v_new_streak,
    best_streak = GREATEST(best_streak, v_new_streak),
    last_played_date = v_day,
    last_played_hour = v_hour,
    total_score = total_score + v_score,
    updated_at = now()
  WHERE user_id = p_user_id;

  IF TRUE THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'first_daily')
    ON CONFLICT (user_id, achievement_code) DO NOTHING;
    IF FOUND THEN v_unlocked_codes := array_append(v_unlocked_codes, 'first_daily'); END IF;
  END IF;
  IF v_new_streak >= 3 THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_3')
    ON CONFLICT (user_id, achievement_code) DO NOTHING;
    IF FOUND THEN v_unlocked_codes := array_append(v_unlocked_codes, 'streak_3'); END IF;
  END IF;
  IF v_new_streak >= 7 THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_7')
    ON CONFLICT (user_id, achievement_code) DO NOTHING;
    IF FOUND THEN v_unlocked_codes := array_append(v_unlocked_codes, 'streak_7'); END IF;
  END IF;
  IF v_new_streak >= 30 THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_30')
    ON CONFLICT (user_id, achievement_code) DO NOTHING;
    IF FOUND THEN v_unlocked_codes := array_append(v_unlocked_codes, 'streak_30'); END IF;
  END IF;

  RETURN jsonb_build_object('current_streak', v_new_streak, 'unlocked', to_jsonb(v_unlocked_codes));
END $$;

CREATE OR REPLACE FUNCTION public.record_match_result(p_room_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_player public.players;
  v_position int;
  v_players_count int;
  v_truth_hits int;
  v_fooled int;
  v_max_votos_def int;
  v_won boolean;
  v_xp_gained int;
  v_stats public.user_stats;
  v_unlocked text[] := ARRAY[]::text[];
  v_code text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF p_room_code IS NULL OR char_length(p_room_code) NOT BETWEEN 3 AND 12 THEN
    RAISE EXCEPTION 'invalid room_code';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('record_match_result|' || auth.uid()::text || '|' || p_room_code, 0));

  SELECT * INTO v_room FROM public.rooms WHERE code = p_room_code;
  -- RL: sala inexistente e sala de outros respondem igual (antes: erro "room not found"
  -- × match_not_finished/player_not_linked = oráculo de código e de fase).
  IF v_room.id IS NULL OR NOT public.is_room_participant(v_room.id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'player_not_linked');
  END IF;
  -- Só partidas encerradas geram estatísticas (anti-replay/prematuro).
  IF v_room.status <> 'finished' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'match_not_finished');
  END IF;
  -- P2: sala encerrada pela LIMPEZA (motivo gravado pelo cleanup_zombie_rooms)
  -- não é partida: sem histórico, XP, nível, vitória, sequência ou conquista.
  -- Sem motivo = fim natural ou sala histórica: tudo segue igual.
  IF v_room.finish_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'match_not_rewardable', 'xp_gained', 0);
  END IF;

  SELECT * INTO v_player FROM public.players
  WHERE room_id = v_room.id AND user_id = auth.uid() AND is_bot = false
  LIMIT 1;
  IF v_player IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'player_not_linked');
  END IF;

  -- Dedup por PARTIDA (user, sala, fim desta partida). O registro desta partida tem
  -- played_at >= rooms.finished_at; os de partidas anteriores com o mesmo código, não.
  -- finished_at nulo (sala antiga) = qualquer registro da sala deduplica (regra antiga).
  IF EXISTS (
    SELECT 1 FROM public.match_history
    WHERE user_id = auth.uid() AND room_code = p_room_code
      AND played_at >= COALESCE(v_room.finished_at, '-infinity'::timestamptz)
  ) THEN
    RETURN jsonb_build_object('ok', true, 'deduped', true, 'xp_gained', 0, 'unlocked', '[]'::jsonb);
  END IF;

  -- Derivados 100% das tabelas oficiais
  SELECT count(*) INTO v_players_count FROM public.players WHERE room_id = v_room.id;
  SELECT 1 + count(*) INTO v_position FROM public.players
  WHERE room_id = v_room.id AND score > v_player.score;

  SELECT count(*) INTO v_truth_hits
  FROM public.votes v
  JOIN public.definitions d ON d.id = v.definition_id
  WHERE v.room_id = v_room.id AND v.voter_id = v_player.id AND d.is_truth = true;

  SELECT count(*) INTO v_fooled
  FROM public.votes v
  JOIN public.definitions d ON d.id = v.definition_id
  WHERE v.room_id = v_room.id AND d.player_id = v_player.id
    AND d.is_truth = false AND v.voter_id <> v_player.id;

  -- Mestre do Blefe: maior número de votos recebidos por UMA definição falsa sua nesta
  -- partida (mesma contagem de votos do Maior Enganador, mas por definição).
  SELECT COALESCE(max(n), 0) INTO v_max_votos_def FROM (
    SELECT count(*) AS n
      FROM public.votes v
      JOIN public.definitions d ON d.id = v.definition_id
     WHERE v.room_id = v_room.id AND d.player_id = v_player.id
       AND d.is_truth = false AND v.voter_id <> v_player.id
     GROUP BY d.id) x;

  INSERT INTO public.user_stats (user_id) VALUES (auth.uid())
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.match_history (user_id, room_code, final_score, position, players_count)
  VALUES (auth.uid(), p_room_code, v_player.score, v_position, v_players_count);

  v_won := (v_position = 1);
  v_xp_gained := 20
    + (CASE WHEN v_won THEN 100 ELSE 0 END)
    + (v_truth_hits * 50)
    + (v_fooled * 30);

  UPDATE public.user_stats SET
    games_played = games_played + 1,
    games_won = games_won + (CASE WHEN v_won THEN 1 ELSE 0 END),
    total_score = total_score + v_player.score,
    best_match_score = GREATEST(best_match_score, v_player.score),
    rounds_coordinated = rounds_coordinated + v_player.coordinator_count,
    total_truth_hits = total_truth_hits + v_truth_hits,
    total_fooled = total_fooled + v_fooled,
    win_streak = (CASE WHEN v_won THEN win_streak + 1 ELSE 0 END),
    best_win_streak = GREATEST(best_win_streak, (CASE WHEN v_won THEN win_streak + 1 ELSE 0 END)),
    xp = xp + v_xp_gained,
    level = public.xp_to_level(xp + v_xp_gained),
    updated_at = now()
  WHERE user_id = auth.uid()
  RETURNING * INTO v_stats;

  FOR v_code IN
    SELECT code FROM (VALUES
      ('first_win',       v_stats.games_won >= 1),
      ('partidas_10',     v_stats.games_played >= 10),
      ('acertos_100',     v_stats.total_truth_hits >= 100),
      ('bluffs_100',      v_stats.total_fooled >= 100),
      ('invicto_3',       v_stats.win_streak >= 3),
      ('maior_enganador', v_fooled >= 5),
      ('truth_seeker',    v_stats.total_truth_hits >= 10),
      ('coordinator_5',   v_stats.rounds_coordinated >= 5),
      ('big_score',       v_player.score >= 30),
      ('bluff_master',    v_max_votos_def >= 5)
    ) AS checks(code, met)
    WHERE met
      AND EXISTS (SELECT 1 FROM public.achievements a WHERE a.code = checks.code)
      AND NOT EXISTS (
        SELECT 1 FROM public.user_achievements ua
        WHERE ua.user_id = auth.uid() AND ua.achievement_code = checks.code
      )
  LOOP
    INSERT INTO public.user_achievements (user_id, achievement_code)
    VALUES (auth.uid(), v_code)
    ON CONFLICT DO NOTHING;
    v_unlocked := array_append(v_unlocked, v_code);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'xp_gained', v_xp_gained,
    'xp_total', v_stats.xp,
    'level', v_stats.level,
    'unlocked', to_jsonb(v_unlocked)
  );
END;
$function$

;

UPDATE public.achievements SET description = 'Receba pelo menos 5 votos nas suas definições falsas em uma única partida.'
 WHERE code = 'maior_enganador' AND description = 'Engane 5 ou mais jogadores numa única partida.';

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
