-- Mínimo de 4 participantes para começar a partida (humanos + bots),
-- garantido NO SERVIDOR — o client já bloqueia o botão, mas uma chamada
-- direta à RPC não pode burlar a regra (playtest 2026-10-20).
-- Mesmo corpo da versão anterior (20260727120000_scale_phase_times_large_rooms)
-- + a checagem v_active < 4 → {ok:false, reason:'min_players'}.
-- Reversão: supabase/rollback/start_game_min_4.sql (recria a versão anterior).

CREATE OR REPLACE FUNCTION public.start_game(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_reason text;
  v_min_count int;
  v_next_coordinator text;
  v_active int;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found'); END IF;
  IF v_room.status <> 'lobby' THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state'); END IF;
  v_reason := public.assert_actor_identity(p_room_id, v_room.host_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  -- Regra de produto (playtest 2026-10-20): partida só começa com 4+
  -- participantes ativos (humanos + bots). Checada DEPOIS da autorização —
  -- quem não é host continua recebendo not_authorized.
  SELECT count(*) INTO v_active
  FROM public.players WHERE room_id = p_room_id AND kicked_at IS NULL;
  IF v_active < 4 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'min_players', 'players', v_active, 'min', 4);
  END IF;

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
      round_phase_ends_at = now() + make_interval(secs => public.phase_secs(p_room_id, 60)),
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true, 'coordinator', v_next_coordinator);
END;
$function$;
