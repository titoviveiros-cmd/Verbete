-- ============================================================
-- Fase 1 (segurança) — parte 3: resultado calculado NO SERVIDOR (S3)
--
-- Antes: record_match_result recebia score/posição/acertos/blefes do
-- CLIENT (com meros caps de sanidade) — leaderboard e XP infláveis por
-- chamada REST direta.
--
-- Agora: o client informa APENAS o código da sala. Tudo o mais é
-- derivado das tabelas oficiais (players/definitions/votes), vinculando
-- o usuário logado ao jogador via players.user_id = auth.uid().
--
-- Vínculo de identidade: novo claim_player_identity(p_player_id) —
-- chamado pelo client logado ao registrar o resultado; só reivindica
-- linha sem dono (user_id NULL) ou já do próprio usuário, nunca de
-- terceiros. (Parte 4 da Fase 1 moverá o vínculo para o momento do
-- join via auth anônima.)
--
-- ROLLBACK:
--   DROP FUNCTION public.record_match_result(text);
--   DROP FUNCTION public.claim_player_identity(text);
--   (reaplicar record_match_result de 20260713120000_xp_achievements.sql)
--   ALTER TABLE public.players DROP COLUMN user_id;
-- ============================================================

ALTER TABLE public.players ADD COLUMN IF NOT EXISTS user_id uuid;
CREATE INDEX IF NOT EXISTS idx_players_user_id ON public.players(user_id) WHERE user_id IS NOT NULL;

-- ---------- Vínculo jogador <-> usuário logado ----------
CREATE OR REPLACE FUNCTION public.claim_player_identity(p_player_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  UPDATE public.players
  SET user_id = auth.uid()
  WHERE id = p_player_id
    AND (user_id IS NULL OR user_id = auth.uid());
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'player_owned_by_other_user');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.claim_player_identity(text) TO authenticated;

-- ---------- record_match_result: assinatura antiga removida ----------
DROP FUNCTION IF EXISTS public.record_match_result(uuid, text, integer, integer, integer, integer, integer, integer);

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

GRANT EXECUTE ON FUNCTION public.record_match_result(text) TO authenticated;
