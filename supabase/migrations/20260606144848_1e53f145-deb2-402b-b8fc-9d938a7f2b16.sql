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
  -- Cliente exibe contagem regressiva de 30s no reveal. O watchdog só age
  -- como rede de segurança caso o host trave: aguarda 35s antes de avançar.
  IF v_scored_at IS NULL OR v_scored_at > now() - interval '35 seconds' THEN RETURN; END IF;
  UPDATE public.rooms SET status = 'scoreboard' WHERE id = p_room_id;
END;
$function$;

