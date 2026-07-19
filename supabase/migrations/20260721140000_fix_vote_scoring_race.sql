-- ============================================================
-- BUGFIX CRÍTICO (playtest): voto humano não computado na pontuação.
--
-- Evidência (sala 3035 r1): breakdown mostrava "Acertou a verdade +3"
-- para Tito mas o score real ficou 0 — o voto EXISTE na tabela, porém
-- entrou DEPOIS da contagem. Corrida clássica:
--   1. advance_voting_to_reveal pega o lock da sala (FOR UPDATE),
--      conta os votos e pontua;
--   2. cast_vote (SEM lock) lia status='voting' ainda não commitado
--      como 'reveal', inseria o voto...
--   3. ...que ficava persistido mas fora da pontuação (o breakdown do
--      client conta TODAS as linhas e por isso divergia do score).
--
-- Fix: cast_vote agora serializa com o avanço via lock da sala
-- (SELECT ... FOR UPDATE). Ou o voto entra ANTES da contagem, ou a fase
-- já virou e o voto é rejeitado com 'wrong_phase' (o client já faz
-- rollback do otimismo e o jogador vê que não contou).
--
-- ROLLBACK: reaplicar corpo sem FOR UPDATE (dump no histórico git).
-- ============================================================

CREATE OR REPLACE FUNCTION public.cast_vote(p_room_id uuid, p_voter_id text, p_definition_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_def public.definitions;
BEGIN
  IF p_room_id IS NULL OR p_voter_id IS NULL OR p_definition_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  -- Lock da sala: serializa com advance_voting_to_reveal/extends.
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.status <> 'voting' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE id = p_voter_id AND room_id = p_room_id AND kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;

  SELECT * INTO v_def FROM public.definitions WHERE id = p_definition_id;
  IF v_def IS NULL
     OR v_def.room_id <> p_room_id
     OR v_def.round <> v_room.current_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'definition_not_in_round');
  END IF;

  IF v_def.player_id = p_voter_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cannot_vote_own');
  END IF;

  INSERT INTO public.votes (room_id, round, voter_id, definition_id)
  VALUES (p_room_id, v_room.current_round, p_voter_id, p_definition_id)
  ON CONFLICT (room_id, round, voter_id)
    DO UPDATE SET definition_id = EXCLUDED.definition_id,
                  created_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- cast_votes_bulk: mesmo lock pelo mesmo motivo (votos de bots na virada).
-- Corpo idêntico ao atual, apenas com FOR UPDATE na leitura da sala.
CREATE OR REPLACE FUNCTION public.cast_votes_bulk(p_room_id uuid, p_round integer, p_votes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_inserted int := 0;
  v_row jsonb;
  v_voter text;
  v_def_id uuid;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'voting' OR v_room.current_round <> p_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_votes, '[]'::jsonb))
  LOOP
    v_voter := v_row->>'voter_id';
    v_def_id := NULLIF(v_row->>'definition_id', '')::uuid;
    IF v_voter IS NULL OR v_def_id IS NULL THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.players
      WHERE id = v_voter AND room_id = p_room_id AND is_bot = true AND kicked_at IS NULL
    ) THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.definitions d
      WHERE d.id = v_def_id
        AND d.room_id = p_room_id
        AND d.round = p_round
        AND d.player_id <> v_voter
    ) THEN
      SELECT d.id INTO v_def_id
      FROM public.definitions d
      WHERE d.room_id = p_room_id
        AND d.round = p_round
        AND d.letter IS NOT NULL
        AND d.player_id <> v_voter
      ORDER BY random()
      LIMIT 1;
      IF v_def_id IS NULL THEN CONTINUE; END IF;
    END IF;

    INSERT INTO public.votes (room_id, round, voter_id, definition_id)
    VALUES (p_room_id, p_round, v_voter, v_def_id)
    ON CONFLICT (room_id, round, voter_id) DO NOTHING;

    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'inserted', v_inserted);
END;
$function$;
