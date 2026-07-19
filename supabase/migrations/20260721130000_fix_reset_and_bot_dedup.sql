-- ============================================================
-- BUGFIXES do playtest (2 causas server-side):
--
-- 1) "Estourou o tempo" fantasma em partida nova: reset_room (revanche)
--    não apagava round_extensions nem zerava voting_extensions — as
--    penalidades da partida anterior vazavam pro breakdown e toasts da
--    nova. start_game já limpava contadores mas também não apagava
--    round_extensions. Ambos agora limpam tudo.
--
-- 2) Definição duplicada permitida: com o ballot seguro o dedup
--    client-side dos bots morreu (não leem mais as definições da
--    rodada) e submit_bot_definitions_bulk não deduplicava — a IA podia
--    repetir exatamente o texto de um humano. Agora o servidor pula
--    linhas cujo texto normalizado já existe na rodada (mesma
--    normalização do submit_definition).
--
-- ROLLBACK: reaplicar corpos anteriores (dump em scripts/dump-functions).
-- ============================================================

CREATE OR REPLACE FUNCTION public.reset_room(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.players
    SET score = 0, coordinator_count = 0,
        writing_extensions = 0, voting_extensions = 0
    WHERE room_id = p_room_id;
  DELETE FROM public.definitions WHERE room_id = p_room_id;
  DELETE FROM public.votes WHERE room_id = p_room_id;
  DELETE FROM public.rounds WHERE room_id = p_room_id;
  DELETE FROM public.round_extensions WHERE room_id = p_room_id;
  UPDATE public.rooms SET
    status = 'lobby',
    current_round = 0,
    current_coordinator = NULL,
    current_word_id = NULL,
    round_phase_ends_at = NULL
  WHERE id = p_room_id;
END;
$function$;

-- start_game: mesma limpeza (recria com o DELETE extra)
CREATE OR REPLACE FUNCTION public.start_game(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_min_count int;
  v_next_coordinator text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found'); END IF;
  IF v_room.status <> 'lobby' THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state'); END IF;

  UPDATE public.players
  SET score = 0, coordinator_count = 0, writing_extensions = 0, voting_extensions = 0
  WHERE room_id = p_room_id;
  DELETE FROM public.definitions WHERE room_id = p_room_id;
  DELETE FROM public.votes WHERE room_id = p_room_id;
  DELETE FROM public.rounds WHERE room_id = p_room_id;
  DELETE FROM public.round_extensions WHERE room_id = p_room_id;

  SELECT min(coordinator_count) INTO v_min_count
  FROM public.players WHERE room_id = p_room_id AND kicked_at IS NULL;
  SELECT id INTO v_next_coordinator FROM public.players
  WHERE room_id = p_room_id AND kicked_at IS NULL AND coordinator_count = v_min_count
  ORDER BY random() LIMIT 1;

  UPDATE public.rooms
  SET status = 'choosing',
      current_round = 1,
      current_coordinator = v_next_coordinator,
      current_word_id = NULL,
      round_phase_ends_at = now() + interval '60 seconds',
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true, 'coordinator', v_next_coordinator);
END;
$function$;

-- Bots: dedup de texto normalizado no servidor
CREATE OR REPLACE FUNCTION public.submit_bot_definitions_bulk(p_room_id uuid, p_round integer, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_room public.rooms;
  v_row jsonb;
  v_pid text;
  v_text text;
  v_norm text;
  v_inserted int := 0;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL OR v_room.status <> 'writing' OR v_room.current_round <> p_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb))
  LOOP
    v_pid := v_row->>'player_id';
    v_text := substring(btrim(COALESCE(v_row->>'text', '')) from 1 for 140);
    IF v_pid IS NULL OR char_length(v_text) = 0 THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.players
      WHERE id = v_pid AND room_id = p_room_id AND is_bot = true AND kicked_at IS NULL
    ) THEN CONTINUE; END IF;

    -- Dedup: pula se o texto normalizado já existe na rodada (humanos,
    -- outros bots ou a verdade) — antes a IA podia clonar o texto de um
    -- jogador e o duplicado entrava.
    v_norm := regexp_replace(lower(extensions.unaccent(v_text)), '[^a-z0-9]+', ' ', 'g');
    IF EXISTS (
      SELECT 1 FROM public.definitions d
      WHERE d.room_id = p_room_id AND d.round = p_round
        AND d.player_id <> v_pid
        AND regexp_replace(lower(extensions.unaccent(d.text)), '[^a-z0-9]+', ' ', 'g') = v_norm
    ) THEN CONTINUE; END IF;

    INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
    VALUES (p_room_id, p_round, v_pid, v_text, false)
    ON CONFLICT (room_id, round, player_id) DO NOTHING;

    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'inserted', v_inserted);
END;
$function$;
