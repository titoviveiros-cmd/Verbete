-- ============================================================
-- Config interna via tabela (substitui app.settings.* GUCs)
--
-- O Postgres gerenciado do Supabase nega ALTER DATABASE ... SET para
-- parâmetros customizados (permission denied ao aplicar o passo manual
-- documentado na migration do motor server-authoritative). A URL/anon key
-- usadas pelo pg_net para chamar a edge function score-similarity passam
-- a viver numa tabela com RLS ligada e SEM policies — só as funções
-- SECURITY DEFINER enxergam.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.app_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
-- Sem policies: nenhum acesso via API para anon/authenticated.
REVOKE ALL ON public.app_config FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_app_config(p_key text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$ SELECT value FROM public.app_config WHERE key = p_key; $$;

REVOKE EXECUTE ON FUNCTION public.get_app_config(text) FROM anon, authenticated, public;

-- advance_voting_to_reveal: única mudança é a fonte da URL/anon key
-- (get_app_config em vez de current_setting).
CREATE OR REPLACE FUNCTION public.advance_voting_to_reveal(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_truth_def_id uuid;
  v_truth_voters int;
  v_total_votes int;
  v_defs_count int;
  v_inserted boolean := false;
  r record;
  v_base_url text;
  v_anon_key text;
  v_candidates jsonb;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'voting' THEN RETURN; END IF;

  SELECT count(*) INTO v_total_votes FROM public.votes
  WHERE room_id = p_room_id AND round = v_room.current_round;
  SELECT count(*) INTO v_defs_count FROM public.definitions
  WHERE room_id = p_room_id AND round = v_room.current_round AND is_truth = false AND player_id <> '__truth__';

  IF v_total_votes = 0 AND v_defs_count > 0 AND (
       v_room.round_phase_ends_at IS NULL
       OR v_room.round_phase_ends_at > now() - interval '90 seconds'
     ) THEN
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.rounds (room_id, round, coordinator_id, word_id)
    VALUES (p_room_id, v_room.current_round, v_room.current_coordinator, v_room.current_word_id);
    v_inserted := true;
  EXCEPTION WHEN unique_violation THEN
    v_inserted := false;
  END;

  IF NOT v_inserted THEN
    UPDATE public.rooms SET status = 'reveal' WHERE id = p_room_id;
    RETURN;
  END IF;

  SELECT id INTO v_truth_def_id FROM public.definitions
  WHERE room_id = p_room_id AND round = v_room.current_round AND is_truth = true;

  SELECT count(*) INTO v_truth_voters FROM public.votes
  WHERE room_id = p_room_id AND round = v_room.current_round AND definition_id = v_truth_def_id;

  IF v_truth_def_id IS NOT NULL THEN
    UPDATE public.players p SET score = p.score + 100
    WHERE p.id IN (
      SELECT voter_id FROM public.votes
      WHERE room_id = p_room_id AND round = v_room.current_round AND definition_id = v_truth_def_id
    );
  END IF;

  FOR r IN
    SELECT d.player_id, count(v.id) AS votes
    FROM public.definitions d
    LEFT JOIN public.votes v ON v.definition_id = d.id
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.is_truth = false AND d.player_id <> '__truth__'
    GROUP BY d.player_id
    HAVING count(v.id) > 0
  LOOP
    UPDATE public.players SET score = score + (r.votes * 50) WHERE id = r.player_id;
  END LOOP;

  IF v_truth_voters = 0 AND v_total_votes > 0 AND v_room.current_coordinator IS NOT NULL THEN
    UPDATE public.players SET score = score + 50 WHERE id = v_room.current_coordinator;
  END IF;

  IF v_room.current_coordinator IS NOT NULL THEN
    UPDATE public.players SET coordinator_count = coordinator_count + 1
    WHERE id = v_room.current_coordinator;
  END IF;

  UPDATE public.rooms SET status = 'reveal' WHERE id = p_room_id;

  BEGIN
    v_base_url := public.get_app_config('supabase_url');
    v_anon_key := public.get_app_config('supabase_anon_key');
    IF v_base_url IS NOT NULL AND v_anon_key IS NOT NULL THEN
      SELECT jsonb_agg(jsonb_build_object('id', id, 'text', text))
        INTO v_candidates
      FROM public.definitions
      WHERE room_id = p_room_id AND round = v_room.current_round
        AND is_truth = false AND player_id <> '__truth__';

      IF v_candidates IS NOT NULL AND jsonb_array_length(v_candidates) > 0 THEN
        PERFORM net.http_post(
          url := v_base_url || '/functions/v1/score-similarity',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || v_anon_key
          ),
          body := jsonb_build_object(
            'room_id', p_room_id,
            'round', v_room.current_round,
            'candidates', v_candidates
          )
        );
      END IF;
    ELSE
      RAISE WARNING 'advance_voting_to_reveal: app_config supabase_url/supabase_anon_key ausentes — bônus de similaridade pulado nesta rodada';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'advance_voting_to_reveal: falha ao chamar score-similarity via pg_net: %', SQLERRM;
  END;
END;
$function$;
