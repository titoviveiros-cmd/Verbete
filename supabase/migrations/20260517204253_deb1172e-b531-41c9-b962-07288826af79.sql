
-- Rastreio de prorrogações por jogador/rodada
CREATE TABLE IF NOT EXISTS public.round_extensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL,
  round integer NOT NULL,
  player_id text NOT NULL,
  attempt integer NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, round, player_id, attempt)
);

ALTER TABLE public.round_extensions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "round_extensions public read"
  ON public.round_extensions FOR SELECT USING (true);

CREATE POLICY "round_extensions open insert"
  ON public.round_extensions FOR INSERT WITH CHECK (true);

-- RPC: aplica prorrogação ou avança a fase writing
CREATE OR REPLACE FUNCTION public.extend_writing_or_advance(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_room public.rooms;
  v_pending record;
  v_extended boolean := false;
  v_kicked text[] := ARRAY[]::text[];
  v_extended_players text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'writing' THEN
    RETURN jsonb_build_object('action', 'noop');
  END IF;

  -- Para cada jogador humano conectado SEM definição entregue nesta rodada
  FOR v_pending IN
    SELECT p.id, p.writing_extensions
    FROM public.players p
    WHERE p.room_id = p_room_id
      AND p.is_bot = false
      AND p.is_connected = true
      AND NOT EXISTS (
        SELECT 1 FROM public.definitions d
        WHERE d.room_id = p_room_id
          AND d.round = v_room.current_round
          AND d.player_id = p.id
      )
  LOOP
    IF v_pending.writing_extensions < 2 THEN
      -- Aplica penalidade e prorrogação
      UPDATE public.players
        SET score = score - 1,
            writing_extensions = writing_extensions + 1
        WHERE id = v_pending.id;

      INSERT INTO public.round_extensions (room_id, round, player_id, attempt)
      VALUES (p_room_id, v_room.current_round, v_pending.id, v_pending.writing_extensions + 1)
      ON CONFLICT DO NOTHING;

      v_extended := true;
      v_extended_players := array_append(v_extended_players, v_pending.id);
    ELSE
      -- 3ª falha: penaliza e remove da partida
      UPDATE public.players SET score = score - 1 WHERE id = v_pending.id;
      DELETE FROM public.players WHERE id = v_pending.id;
      v_kicked := array_append(v_kicked, v_pending.id);
    END IF;
  END LOOP;

  IF v_extended THEN
    -- Estende a fase em 20s, sem avançar
    UPDATE public.rooms
      SET round_phase_ends_at = now() + interval '20 seconds'
      WHERE id = p_room_id;
    RETURN jsonb_build_object(
      'action', 'extended',
      'extended_players', to_jsonb(v_extended_players),
      'kicked', to_jsonb(v_kicked)
    );
  END IF;

  -- Sem prorrogação pendente → avança normalmente
  PERFORM public.advance_writing_to_voting(p_room_id);
  RETURN jsonb_build_object(
    'action', 'advanced',
    'kicked', to_jsonb(v_kicked)
  );
END;
$$;

-- Atualiza tick para usar a nova lógica em writing
CREATE OR REPLACE FUNCTION public.tick_stalled_rooms()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  v_count int := 0;
BEGIN
  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'writing'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.extend_writing_or_advance(r.id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'voting'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.advance_voting_to_reveal(r.id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT ro.id FROM public.rooms ro
    WHERE ro.status = 'reveal'
  LOOP
    PERFORM public.advance_reveal_to_scoreboard(r.id);
  END LOOP;

  RETURN jsonb_build_object('advanced', v_count, 'at', now());
END;
$$;


