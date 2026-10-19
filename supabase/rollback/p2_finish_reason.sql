-- =============================================================================
-- REVERSÃO do P2 XP (migration 20261019030000_p2_cleanup_finish_not_rewardable).
-- Volta ao estado anterior: cleanup_zombie_rooms v3 (R4, sem motivo),
-- record_match_result do M1 (paga qualquer sala 'finished'), sem gatilho,
-- sem CHECK e sem a coluna finish_reason (os motivos gravados se perdem).
-- Ordem: funções primeiro (elas usam a coluna), depois gatilho e coluna.
-- Para desfazer TAMBÉM a R4, rode este arquivo ANTES de
-- supabase/rollback/cleanup_zombie_rooms_v2.sql.
--   npx supabase db query --linked -f supabase/rollback/p2_finish_reason.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION public.cleanup_zombie_rooms()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_finished int := 0;
  v_lobby int := 0;
  v_unstuck int := 0;
  v_idle int := 0;
  v_id uuid;
BEGIN
  WITH stale AS (
    UPDATE public.rooms
    SET status = 'finished', round_phase_ends_at = NULL
    WHERE status IN ('shuffling', 'choosing', 'writing', 'voting', 'reveal', 'scoreboard')
      AND COALESCE(phase_started_at, created_at) < now() - interval '30 minutes'
    RETURNING 1
  )
  SELECT count(*) INTO v_finished FROM stale;

  WITH stale_lobby AS (
    UPDATE public.rooms r
    SET status = 'finished'
    WHERE r.status = 'lobby'
      AND GREATEST(
            r.created_at,
            COALESCE((SELECT max(p.joined_at) FROM public.players p WHERE p.room_id = r.id), r.created_at),
            COALESCE((SELECT max(m.created_at) FROM public.room_messages m WHERE m.room_id = r.id), r.created_at)
          ) < now() - interval '60 minutes'
    RETURNING 1
  )
  SELECT count(*) INTO v_lobby FROM stale_lobby;

  WITH no_humans AS (
    UPDATE public.rooms r
    SET status = 'finished'
    WHERE r.status IN ('shuffling', 'choosing')
      AND r.created_at < now() - interval '2 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM public.players p
        WHERE p.room_id = r.id AND p.is_bot = false AND p.is_connected = true
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_unstuck FROM no_humans;

  -- R4: sala "andando sozinha" (laço de rodadas sem ação humana).
  FOR v_id IN
    SELECT r.id FROM public.rooms r
     WHERE r.status IN ('shuffling', 'choosing', 'writing', 'voting', 'reveal', 'scoreboard')
       AND r.current_round >= 2
       AND public.room_last_human_activity(r.id) < now() - interval '30 minutes'
  LOOP
    -- Ação humana em andamento (cast_vote ou INSERT com FK para rooms) segura
    -- a linha: pula a sala neste minuto em vez de esperar ou atropelar.
    PERFORM 1 FROM public.rooms WHERE id = v_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    -- Reconfere com a sala travada (consulta nova = foto nova do banco).
    UPDATE public.rooms r
       SET status = 'finished', round_phase_ends_at = NULL
     WHERE r.id = v_id
       AND r.status IN ('shuffling', 'choosing', 'writing', 'voting', 'reveal', 'scoreboard')
       AND r.current_round >= 2
       AND public.room_last_human_activity(r.id) < now() - interval '30 minutes';
    IF FOUND THEN
      v_idle := v_idle + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'finished_stale', v_finished,
    'finished_lobby', v_lobby,
    'finished_empty', v_unstuck,
    'finished_idle', v_idle,
    'at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_zombie_rooms() FROM PUBLIC, anon, authenticated;

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
  IF v_room IS NULL THEN RAISE EXCEPTION 'room not found'; END IF;
  -- Só partidas encerradas geram estatísticas (anti-replay/prematuro).
  IF v_room.status <> 'finished' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'match_not_finished');
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
$function$;

DROP TRIGGER IF EXISTS rooms_clear_finish_reason ON public.rooms;
DROP FUNCTION IF EXISTS public.rooms_clear_finish_reason();
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_finish_reason_check;
ALTER TABLE public.rooms DROP COLUMN IF EXISTS finish_reason;
