-- Reversão da 20261112110000_rooms_leitura_restrita: devolve a leitura pública
-- de rooms ("public read rooms", USING (true), papel PUBLIC — EXATAMENTE como
-- na 20260510003432), get_room_state como na 20260722100000 (STABLE) e
-- record_match_result como na 20261019030000 (corpos byte a byte; permissões
-- não mudam com CREATE OR REPLACE), e apaga as 4 funções novas e a chave
-- rooms_vc8_compat do app_config.
-- ATENÇÃO: reverter REABRE a listagem de códigos de sala por anon.
-- Depois: supabase migration repair --status reverted 20261112110000

DROP POLICY IF EXISTS "rooms participantes leem" ON public.rooms;
DROP POLICY IF EXISTS "rooms vc8 leitura por codigo exato (transitoria)" ON public.rooms;
DROP POLICY IF EXISTS "public read rooms" ON public.rooms;
CREATE POLICY "public read rooms" ON public.rooms FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION public.get_room_state(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_sync jsonb;
  v_word jsonb;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE code = p_code LIMIT 1;
  IF v_room IS NULL THEN
    RETURN NULL;
  END IF;

  v_sync := public.get_round_sync(v_room.id);

  IF v_room.status IN ('reveal', 'scoreboard', 'finished') THEN
    v_word := public.get_word_reveal(v_room.id);
  ELSE
    SELECT jsonb_build_object(
      'id', w.id, 'word', w.word, 'category', w.category, 'rarity', w.rarity,
      'nivel', w.nivel, 'classe', w.classe, 'pronuncia', w.pronuncia
    ) INTO v_word
    FROM public.words w WHERE w.id = v_room.current_word_id;
    IF v_word IS NULL AND v_room.current_word_id IS NOT NULL THEN
      SELECT jsonb_build_object(
        'id', rw.id, 'word', rw.word,
        'category', COALESCE(rw.category, 'custom'), 'rarity', 2
      ) INTO v_word
      FROM public.room_words rw WHERE rw.id = v_room.current_word_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'room', to_jsonb(v_room),
    'players', COALESCE((
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.joined_at)
      FROM public.players p
      WHERE p.room_id = v_room.id AND p.kicked_at IS NULL
    ), '[]'::jsonb),
    'definitions', COALESCE(v_sync->'definitions', '[]'::jsonb),
    'votes', COALESCE(v_sync->'votes', '[]'::jsonb),
    'word', v_word
  );
END;
$function$

;

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

DROP FUNCTION IF EXISTS public.rooms_vc8_exact_code_read();
DROP FUNCTION IF EXISTS public.is_room_participant(uuid);
DROP FUNCTION IF EXISTS public.my_room_ids();
DROP FUNCTION IF EXISTS public.rooms_vc8_compat_on();
DELETE FROM public.app_config WHERE key = 'rooms_vc8_compat';
