-- ============================================================
-- BUGFIX (playtest): placar avançava sozinho mesmo com o host presente.
--
-- Duas fontes:
--   1) finish_reveal marcava o placar com hold de só 8s — o cron
--      avançava logo depois, atropelando o clique do host.
--   2) advance_reveal_to_scoreboard (caminho do cron) NEM setava
--      round_phase_ends_at — a sala herdava o deadline VENCIDO da
--      votação e o tick seguinte avançava imediatamente.
--
-- Novo contrato: o placar espera o HOST clicar. O timer server-side
-- vira apenas backstop anti-AFK de 120s.
--
-- ROLLBACK: intervalos anteriores (8s / sem set) no histórico git.
-- ============================================================

CREATE OR REPLACE FUNCTION public.finish_reveal(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_max_score int;
  v_status text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'reveal' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;

  IF v_room.mode = 'teams' AND jsonb_array_length(v_room.teams) > 0 THEN
    SELECT COALESCE(MAX(team_total), 0) INTO v_max_score FROM (
      SELECT COALESCE(SUM(p.score), 0) AS team_total
      FROM jsonb_array_elements(v_room.teams) t
      LEFT JOIN public.players p ON p.room_id = p_room_id AND p.team_id = t->>'id'
      GROUP BY t->>'id'
    ) totals;
  ELSE
    SELECT COALESCE(MAX(score), 0) INTO v_max_score FROM public.players WHERE room_id = p_room_id;
  END IF;

  v_status := CASE
    WHEN v_room.win_condition = 'score' AND v_max_score >= v_room.win_target THEN 'finished'
    ELSE 'scoreboard'
  END;

  UPDATE public.rooms
  SET status = v_status,
      round_phase_ends_at = CASE WHEN v_status = 'scoreboard' THEN now() + interval '120 seconds' ELSE NULL END
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.advance_reveal_to_scoreboard(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_scored_at timestamptz;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'reveal' THEN RETURN; END IF;
  SELECT scored_at INTO v_scored_at FROM public.rounds
  WHERE room_id = p_room_id AND round = v_room.current_round LIMIT 1;
  IF v_scored_at IS NULL OR v_scored_at > now() - interval '20 seconds' THEN RETURN; END IF;
  -- Backstop de 120s no placar (antes herdava deadline vencido e o tick
  -- seguinte avançava sozinho por cima do host).
  UPDATE public.rooms
  SET status = 'scoreboard',
      round_phase_ends_at = now() + interval '120 seconds'
  WHERE id = p_room_id;
END;
$function$;
