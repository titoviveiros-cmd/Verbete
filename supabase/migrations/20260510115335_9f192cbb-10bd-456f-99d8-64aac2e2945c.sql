CREATE OR REPLACE FUNCTION public.reset_room(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.players SET score = 0, coordinator_count = 0 WHERE room_id = p_room_id;
  DELETE FROM public.definitions WHERE room_id = p_room_id;
  DELETE FROM public.votes WHERE room_id = p_room_id;
  DELETE FROM public.rounds WHERE room_id = p_room_id;
  -- IMPORTANT: keep used_word_ids so palavras nunca repitam, mesmo após reiniciar o jogo
  UPDATE public.rooms SET
    status = 'lobby',
    current_round = 0,
    current_coordinator = NULL,
    current_word_id = NULL,
    round_phase_ends_at = NULL
  WHERE id = p_room_id;
END;
$function$;

