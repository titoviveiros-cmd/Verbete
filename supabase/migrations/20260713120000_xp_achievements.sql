-- ============================================================
-- XP, níveis e conquistas de partida (especificação Verbete)
--
-- XP por partida (spec): participar +20, vitória +100, cada acerto da
-- verdade +50, cada jogador enganado +30. Nível derivado do XP:
-- level = floor(sqrt(xp/100)) + 1  (100 XP p/ nível 2, 400 p/ 3, ...).
--
-- CORREÇÃO CRÍTICA embutida: record_match_result rejeitava score > 200.
-- Com a pontuação v2 em centenas (+100/+50), TODA partida estourava o
-- limite e o registro de estatísticas passaria a falhar silenciosamente.
--
-- Contagens de acertos/enganos vêm do client com caps de sanidade —
-- mesmo modelo de confiança do restante da RPC (score/position também
-- são client-reported, validados por limites e existência da sala).
-- ============================================================

ALTER TABLE public.user_stats
  ADD COLUMN IF NOT EXISTS xp int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS level int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS total_truth_hits int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_fooled int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS win_streak int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS best_win_streak int NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.xp_to_level(p_xp int)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$ SELECT GREATEST(1, floor(sqrt(GREATEST(p_xp, 0) / 100.0))::int + 1); $$;

-- Conquistas de partida do spec (o catálogo já tem as 10 do modo diário)
INSERT INTO public.achievements (code, name, description, emoji, rarity) VALUES
  ('partidas_10',     'Veterano',            'Jogue 10 partidas multiplayer.',                    '🎖️', 'common'),
  ('acertos_100',     'Mestre das Palavras', 'Acerte a definição verdadeira 100 vezes.',          '🧠', 'epic'),
  ('bluffs_100',      'Professor do Blefe',  'Engane jogadores 100 vezes com suas definições.',   '🎓', 'epic'),
  ('invicto_3',       'Invicto',             'Vença 3 partidas seguidas.',                        '🛡️', 'rare'),
  ('maior_enganador', 'Maior Enganador',     'Engane 5 ou mais jogadores numa única partida.',    '🦊', 'rare')
ON CONFLICT (code) DO NOTHING;

-- Assinatura e retorno mudam: DROP + CREATE (antes: RETURNS void).
DROP FUNCTION IF EXISTS public.record_match_result(uuid, text, integer, integer, integer, integer);

CREATE OR REPLACE FUNCTION public.record_match_result(
  p_user_id uuid,
  p_room_code text,
  p_final_score integer,
  p_position integer,
  p_players_count integer,
  p_rounds_coordinated integer DEFAULT 0,
  p_truth_hits integer DEFAULT 0,
  p_fooled_count integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room_exists boolean;
  v_won boolean;
  v_xp_gained int;
  v_stats public.user_stats;
  v_unlocked text[] := ARRAY[]::text[];
  v_code text;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Limites de sanidade (pontuação v2 em centenas: teto generoso).
  IF p_final_score IS NULL OR p_final_score < 0 OR p_final_score > 50000 THEN
    RAISE EXCEPTION 'invalid final_score';
  END IF;
  IF p_position IS NULL OR p_position < 1 OR p_position > 16 THEN
    RAISE EXCEPTION 'invalid position';
  END IF;
  IF p_players_count IS NULL OR p_players_count < 1 OR p_players_count > 16 THEN
    RAISE EXCEPTION 'invalid players_count';
  END IF;
  IF p_rounds_coordinated IS NULL OR p_rounds_coordinated < 0 OR p_rounds_coordinated > 50 THEN
    RAISE EXCEPTION 'invalid rounds_coordinated';
  END IF;
  IF p_truth_hits IS NULL OR p_truth_hits < 0 OR p_truth_hits > 100 THEN
    RAISE EXCEPTION 'invalid truth_hits';
  END IF;
  IF p_fooled_count IS NULL OR p_fooled_count < 0 OR p_fooled_count > 500 THEN
    RAISE EXCEPTION 'invalid fooled_count';
  END IF;
  IF p_room_code IS NULL OR char_length(p_room_code) NOT BETWEEN 3 AND 12 THEN
    RAISE EXCEPTION 'invalid room_code';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.rooms WHERE code = p_room_code
  ) INTO v_room_exists;
  IF NOT v_room_exists THEN
    RAISE EXCEPTION 'room not found';
  END IF;

  INSERT INTO public.user_stats (user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  -- Dedup: 1 registro por (user_id, room_code) — definitivo.
  IF EXISTS (
    SELECT 1 FROM public.match_history
    WHERE user_id = p_user_id AND room_code = p_room_code
  ) THEN
    RETURN jsonb_build_object('ok', true, 'deduped', true, 'xp_gained', 0, 'unlocked', '[]'::jsonb);
  END IF;

  INSERT INTO public.match_history (user_id, room_code, final_score, position, players_count)
  VALUES (p_user_id, p_room_code, p_final_score, p_position, p_players_count);

  v_won := (p_position = 1);
  v_xp_gained := 20
    + (CASE WHEN v_won THEN 100 ELSE 0 END)
    + (p_truth_hits * 50)
    + (p_fooled_count * 30);

  UPDATE public.user_stats SET
    games_played = games_played + 1,
    games_won = games_won + (CASE WHEN v_won THEN 1 ELSE 0 END),
    total_score = total_score + p_final_score,
    best_match_score = GREATEST(best_match_score, p_final_score),
    rounds_coordinated = rounds_coordinated + p_rounds_coordinated,
    total_truth_hits = total_truth_hits + p_truth_hits,
    total_fooled = total_fooled + p_fooled_count,
    win_streak = (CASE WHEN v_won THEN win_streak + 1 ELSE 0 END),
    best_win_streak = GREATEST(best_win_streak, (CASE WHEN v_won THEN win_streak + 1 ELSE 0 END)),
    xp = xp + v_xp_gained,
    level = public.xp_to_level(xp + v_xp_gained),
    updated_at = now()
  WHERE user_id = p_user_id
  RETURNING * INTO v_stats;

  -- Desbloqueio de conquistas de partida
  FOR v_code IN
    SELECT code FROM (VALUES
      ('first_win',       v_stats.games_won >= 1),
      ('partidas_10',     v_stats.games_played >= 10),
      ('acertos_100',     v_stats.total_truth_hits >= 100),
      ('bluffs_100',      v_stats.total_fooled >= 100),
      ('invicto_3',       v_stats.win_streak >= 3),
      ('maior_enganador', p_fooled_count >= 5)
    ) AS checks(code, met)
    WHERE met
      AND EXISTS (SELECT 1 FROM public.achievements a WHERE a.code = checks.code)
      AND NOT EXISTS (
        SELECT 1 FROM public.user_achievements ua
        WHERE ua.user_id = p_user_id AND ua.achievement_code = checks.code
      )
  LOOP
    INSERT INTO public.user_achievements (user_id, achievement_code)
    VALUES (p_user_id, v_code)
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

GRANT EXECUTE ON FUNCTION public.record_match_result(uuid, text, integer, integer, integer, integer, integer, integer) TO authenticated;
