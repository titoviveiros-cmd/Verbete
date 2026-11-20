-- ROLLBACK de 20261122120000_conquistas_regras.sql: devolve os 3 corpos de antes (byte a byte),
-- a descrição do Maior Enganador e os contadores de sequência (backup + Diário jogado depois, em horas). Conquistas concedidas
-- depois da migration NÃO são removidas (foram conquistadas pelas regras vigentes).
-- Depois: supabase migration repair --status reverted 20261122120000

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

  IF v_stats.last_played_hour = v_prev_hour THEN
    v_new_streak := v_stats.current_streak + 1;
  ELSIF v_stats.last_played_hour = v_hour THEN
    v_new_streak := v_stats.current_streak;
  ELSE
    v_new_streak := 1;
  END IF;

  UPDATE public.user_stats SET
    current_streak = v_new_streak,
    best_streak = GREATEST(best_streak, v_new_streak),
    last_played_date = v_hour::date,
    last_played_hour = v_hour,
    total_score = total_score + v_score,
    updated_at = now()
  WHERE user_id = p_user_id;

  IF NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'first_daily') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'first_daily');
    v_unlocked_codes := array_append(v_unlocked_codes, 'first_daily');
  END IF;
  IF v_new_streak >= 3 AND NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'streak_3') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_3');
    v_unlocked_codes := array_append(v_unlocked_codes, 'streak_3');
  END IF;
  IF v_new_streak >= 7 AND NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'streak_7') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_7');
    v_unlocked_codes := array_append(v_unlocked_codes, 'streak_7');
  END IF;
  IF v_new_streak >= 30 AND NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'streak_30') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_30');
    v_unlocked_codes := array_append(v_unlocked_codes, 'streak_30');
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
  v_unlocked_codes text[] := ARRAY[]::text[];
BEGIN
  INSERT INTO public.user_stats (user_id) VALUES (p_user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO v_stats FROM public.user_stats WHERE user_id = p_user_id;

  IF v_stats.last_played_hour = v_prev_hour THEN
    v_new_streak := v_stats.current_streak + 1;
  ELSIF v_stats.last_played_hour = v_hour THEN
    v_new_streak := v_stats.current_streak;
  ELSE
    v_new_streak := 1;
  END IF;

  UPDATE public.user_stats SET
    current_streak = v_new_streak,
    best_streak = GREATEST(best_streak, v_new_streak),
    last_played_date = v_hour::date,
    last_played_hour = v_hour,
    total_score = total_score + v_score,
    updated_at = now()
  WHERE user_id = p_user_id;

  IF NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'first_daily') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'first_daily');
    v_unlocked_codes := array_append(v_unlocked_codes, 'first_daily');
  END IF;
  IF v_new_streak >= 3 AND NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'streak_3') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_3');
    v_unlocked_codes := array_append(v_unlocked_codes, 'streak_3');
  END IF;
  IF v_new_streak >= 7 AND NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'streak_7') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_7');
    v_unlocked_codes := array_append(v_unlocked_codes, 'streak_7');
  END IF;
  IF v_new_streak >= 30 AND NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'streak_30') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_30');
    v_unlocked_codes := array_append(v_unlocked_codes, 'streak_30');
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

  -- Dedup definitivo por (user, sala)
  IF EXISTS (
    SELECT 1 FROM public.match_history
    WHERE user_id = auth.uid() AND room_code = p_room_code
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
      ('maior_enganador', v_fooled >= 5)
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

UPDATE public.achievements SET description = 'Engane 5 ou mais jogadores numa única partida.'
 WHERE code = 'maior_enganador' AND description = 'Receba pelo menos 5 votos nas suas definições falsas em uma única partida.';

-- Sequência de volta às HORAS sem perder o que foi jogado DEPOIS da migration:
-- * quem não jogou o Diário desde a migration volta exatamente ao backup;
-- * quem jogou (juiz ou escolha: toda participação grava daily_attempts) tem a sequência em
--   horas REJOGADA a partir do backup, com a regra antiga (hora seguinte +1; mesma hora mantém;
--   senão 1), sobre as horas posteriores à última do backup.
-- Só current_streak/best_streak/last_played_*: pontuação, XP, estatísticas de partida e
-- conquistas não são tocados.
DO $rb$
DECLARE
  v_corte timestamptz := (SELECT min(salvo_em) FROM public.conquistas_streak_horas_bkp);
  r record;
  v_h timestamptz;
  v_cur integer;
  v_best integer;
  v_last timestamptz;
BEGIN
  UPDATE public.user_stats s
     SET current_streak = b.current_streak, best_streak = b.best_streak,
         last_played_date = b.last_played_date, last_played_hour = b.last_played_hour, updated_at = now()
    FROM public.conquistas_streak_horas_bkp b
   WHERE s.user_id = b.user_id;

  FOR r IN
    SELECT s.user_id, b.current_streak, b.best_streak, b.last_played_hour
      FROM public.user_stats s
      LEFT JOIN public.conquistas_streak_horas_bkp b ON b.user_id = s.user_id
     WHERE EXISTS (SELECT 1 FROM public.daily_attempts a
                    WHERE a.user_id = s.user_id AND a.created_at >= COALESCE(v_corte, '-infinity'))
  LOOP
    v_cur := COALESCE(r.current_streak, 0);
    v_best := COALESCE(r.best_streak, 0);
    v_last := r.last_played_hour;
    FOR v_h IN
      SELECT DISTINCT a.challenge_hour FROM public.daily_attempts a
       WHERE a.user_id = r.user_id AND a.challenge_hour > COALESCE(r.last_played_hour, '-infinity')
       ORDER BY 1
    LOOP
      IF v_last = v_h - INTERVAL '1 hour' THEN
        v_cur := v_cur + 1;
      ELSIF v_last = v_h THEN
        NULL;
      ELSE
        v_cur := 1;
      END IF;
      v_best := GREATEST(v_best, v_cur);
      v_last := v_h;
    END LOOP;
    UPDATE public.user_stats
       SET current_streak = v_cur, best_streak = v_best, last_played_hour = v_last,
           last_played_date = (v_last AT TIME ZONE 'UTC')::date, updated_at = now()
     WHERE user_id = r.user_id AND v_last IS NOT NULL;
  END LOOP;
END $rb$;
DROP TABLE IF EXISTS public.conquistas_streak_horas_bkp;
