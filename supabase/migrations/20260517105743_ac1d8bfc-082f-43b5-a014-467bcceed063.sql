
-- Parte 1: prorrogações na fase de escrita
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS writing_extensions integer NOT NULL DEFAULT 0;

-- Parte 2: modo de jogo (individual vs equipes)
ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'individual',
  ADD COLUMN IF NOT EXISTS teams jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS team_id text;

-- Atualiza reset_room para zerar writing_extensions
CREATE OR REPLACE FUNCTION public.reset_room(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.players
    SET score = 0, coordinator_count = 0, writing_extensions = 0
    WHERE room_id = p_room_id;
  DELETE FROM public.definitions WHERE room_id = p_room_id;
  DELETE FROM public.votes WHERE room_id = p_room_id;
  DELETE FROM public.rounds WHERE room_id = p_room_id;
  UPDATE public.rooms SET
    status = 'lobby',
    current_round = 0,
    current_coordinator = NULL,
    current_word_id = NULL,
    round_phase_ends_at = NULL
  WHERE id = p_room_id;
END;
$function$;


