-- Voto dos bots decidido NO SERVIDOR (playtest 2026-10-22).
--
-- O cliente sorteava entre todas as cédulas menos a própria: a verdade
-- entrava no sorteio com o mesmo peso de cada blefe (~1/3 numa mesa de 4;
-- medido nos últimos 10 dias: 35,3% dos votos de bot na verdade) e os bots
-- disputavam a ponta toda partida. Aqui, onde a verdade já é conhecida com
-- segurança, cada bot vota na verdade com 17,5% de chance (meio da meta de
-- 15–20%) e, no resto, num blefe ALEATÓRIO que não seja o seu — sem usar a
-- verdade para escolher "o blefe mais parecido". Nada disso sai para o
-- navegador: a resposta é só {ok, inserted}.
--
-- Compatível com o cliente em produção (que segue usando cast_votes_bulk):
-- só acrescenta funções. Rollback: supabase/rollback/bot_vote_policy.sql.

-- Peça pura e testável: com p_r1/p_r2 fixos, a escolha é determinística.
-- Sem blefe disponível, sobra a verdade; sem verdade, só blefe.
CREATE OR REPLACE FUNCTION public.bot_vote_pick(
  p_truth_id uuid,
  p_bluff_ids uuid[],
  p_r1 double precision,
  p_r2 double precision,
  p_truth_rate double precision DEFAULT 0.175
)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN coalesce(cardinality(p_bluff_ids), 0) = 0 THEN p_truth_id
    WHEN p_truth_id IS NOT NULL AND p_r1 < p_truth_rate THEN p_truth_id
    ELSE p_bluff_ids[1 + least(
      cardinality(p_bluff_ids) - 1,
      greatest(0, floor(p_r2 * cardinality(p_bluff_ids))::int)
    )]
  END
$function$;

REVOKE ALL ON FUNCTION public.bot_vote_pick(uuid, uuid[], double precision, double precision, double precision) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bot_vote_pick(uuid, uuid[], double precision, double precision, double precision) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_vote_pick(uuid, uuid[], double precision, double precision, double precision) TO service_role;

-- Só o host pede (mesma checagem de identidade de cast_votes_bulk); vota
-- por todo bot da sala que ainda não votou nesta rodada — o coordenador
-- também vota, como os humanos. Idempotente: chamar de novo não muda nada.
CREATE OR REPLACE FUNCTION public.cast_bot_votes(p_room_id uuid, p_round integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_reason text;
  v_truth uuid;
  v_bot text;
  v_bluffs uuid[];
  v_pick uuid;
  v_n int;
  v_inserted int := 0;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'voting' OR v_room.current_round <> p_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, v_room.host_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  SELECT d.id INTO v_truth
    FROM public.definitions d
   WHERE d.room_id = p_room_id AND d.round = p_round
     AND d.is_truth AND d.letter IS NOT NULL
   LIMIT 1;

  FOR v_bot IN
    SELECT p.id
      FROM public.players p
     WHERE p.room_id = p_room_id AND p.is_bot AND p.kicked_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.votes v
          WHERE v.room_id = p_room_id AND v.round = p_round AND v.voter_id = p.id
       )
     ORDER BY p.id
  LOOP
    SELECT array_agg(d.id ORDER BY d.letter) INTO v_bluffs
      FROM public.definitions d
     WHERE d.room_id = p_room_id AND d.round = p_round
       AND d.letter IS NOT NULL
       AND NOT d.is_truth AND d.player_id <> '__truth__'
       AND d.player_id <> v_bot;
    v_pick := public.bot_vote_pick(v_truth, v_bluffs, random(), random());
    CONTINUE WHEN v_pick IS NULL;
    INSERT INTO public.votes (room_id, round, voter_id, definition_id)
    VALUES (p_room_id, p_round, v_bot, v_pick)
    ON CONFLICT (room_id, round, voter_id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_inserted := v_inserted + v_n;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'inserted', v_inserted);
END;
$function$;

REVOKE ALL ON FUNCTION public.cast_bot_votes(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cast_bot_votes(uuid, integer) TO anon, authenticated, service_role;
