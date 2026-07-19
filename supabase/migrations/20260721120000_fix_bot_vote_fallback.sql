-- ============================================================
-- BUGFIX (playtest): bots "demoravam" na votação.
--
-- Com o ballot seguro, as cédulas chegam ao client SEM autor — o host
-- não consegue mais excluir a própria definição do bot ao sortear o
-- voto. Quando o sorteio caía na própria cédula, cast_votes_bulk
-- DESCARTAVA o voto em silêncio e aquele bot nunca votava, forçando a
-- rodada a esperar o timer de 30s inteiro.
--
-- Fix: em vez de descartar, o servidor re-sorteia outra definição
-- válida da rodada (qualquer uma que não seja do próprio bot, incluindo
-- a verdade). Todo bot passa a votar sempre.
--
-- ROLLBACK: reaplicar o corpo anterior (skip silencioso) preservado no
-- histórico git / dump-functions.
-- ============================================================

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
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL OR v_room.status <> 'voting' OR v_room.current_round <> p_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_votes, '[]'::jsonb))
  LOOP
    v_voter := v_row->>'voter_id';
    v_def_id := NULLIF(v_row->>'definition_id', '')::uuid;
    IF v_voter IS NULL OR v_def_id IS NULL THEN CONTINUE; END IF;

    -- Apenas bots desta sala podem ser inseridos em lote.
    IF NOT EXISTS (
      SELECT 1 FROM public.players
      WHERE id = v_voter AND room_id = p_room_id AND is_bot = true AND kicked_at IS NULL
    ) THEN CONTINUE; END IF;

    -- Cédula precisa ser da rodada e não pertencer ao próprio votante.
    -- Se for a própria (client não enxerga autores no ballot seguro),
    -- re-sorteia outra válida em vez de descartar o voto.
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
