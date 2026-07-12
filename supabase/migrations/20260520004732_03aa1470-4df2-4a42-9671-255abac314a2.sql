-- 1) daily_challenges: remove leitura pública. Cliente já usa a RPC SECURITY DEFINER
--    get_or_create_daily_challenge, que devolve apenas {id, word, category} (sem word_id cru).
DROP POLICY IF EXISTS "daily_challenges past read" ON public.daily_challenges;

-- 2) room_words: restringe DELETE a salas que ainda não começaram a rodada,
--    para impedir que um anônimo apague palavras durante o jogo.
DROP POLICY IF EXISTS "room_words public delete" ON public.room_words;
CREATE POLICY "room_words delete only in lobby/choosing"
  ON public.room_words
  FOR DELETE
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_words.room_id
        AND r.status IN ('lobby', 'choosing')
    )
  );

-- 3) record_match_result: passa a validar que a sala existe e limita o score
--    para que usuários autenticados não consigam inflar o leaderboard com
--    partidas inventadas (room_code aleatório + score 9999).
CREATE OR REPLACE FUNCTION public.record_match_result(
  p_user_id uuid,
  p_room_code text,
  p_final_score integer,
  p_position integer,
  p_players_count integer,
  p_rounds_coordinated integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room_exists boolean;
BEGIN
  IF auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Validação básica de limites para evitar valores absurdos.
  IF p_final_score IS NULL OR p_final_score < 0 OR p_final_score > 200 THEN
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
  IF p_room_code IS NULL OR char_length(p_room_code) NOT BETWEEN 3 AND 12 THEN
    RAISE EXCEPTION 'invalid room_code';
  END IF;

  -- A sala precisa existir (mesmo que já tenha terminado). Como rooms é
  -- pública, isso impede injeção de room_codes inventados na hora.
  SELECT EXISTS (
    SELECT 1 FROM public.rooms WHERE code = p_room_code
  ) INTO v_room_exists;
  IF NOT v_room_exists THEN
    RAISE EXCEPTION 'room not found';
  END IF;

  INSERT INTO public.user_stats (user_id) VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  -- Dedup mais agressivo: 1 registro por (user_id, room_code) — definitivo.
  IF EXISTS (
    SELECT 1 FROM public.match_history
    WHERE user_id = p_user_id AND room_code = p_room_code
  ) THEN
    RETURN;
  END IF;

  INSERT INTO public.match_history (user_id, room_code, final_score, position, players_count)
  VALUES (p_user_id, p_room_code, p_final_score, p_position, p_players_count);

  UPDATE public.user_stats SET
    games_played = games_played + 1,
    games_won = games_won + (CASE WHEN p_position = 1 THEN 1 ELSE 0 END),
    total_score = total_score + p_final_score,
    best_match_score = GREATEST(best_match_score, p_final_score),
    rounds_coordinated = rounds_coordinated + p_rounds_coordinated,
    updated_at = now()
  WHERE user_id = p_user_id;
END;
$function$;

