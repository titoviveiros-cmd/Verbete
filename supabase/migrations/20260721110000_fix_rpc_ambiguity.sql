-- ============================================================
-- BUGFIX (achado no playtest): get_room_definitions falhava com
-- "column reference id is ambiguous" (42702) — em RETURNS TABLE, os
-- nomes das colunas de saída viram variáveis PL/pgSQL e colidem com as
-- colunas da tabela na query. Resultado: o breakdown do placar e os
-- destaques do fim de partida vinham vazios.
--
-- Fix: ambas as RPCs (get_room_definitions e get_ballot, mesmo padrão)
-- passam a devolver jsonb — o mesmo shape que o client já consome como
-- array. ROLLBACK: reaplicar as versões RETURNS TABLE de
-- 20260720110000/20260721100000.
-- ============================================================

DROP FUNCTION IF EXISTS public.get_room_definitions(uuid);
CREATE OR REPLACE FUNCTION public.get_room_definitions(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_max_round int;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN RETURN '[]'::jsonb; END IF;
  v_max_round := CASE
    WHEN v_room.status IN ('reveal', 'scoreboard', 'finished') THEN v_room.current_round
    ELSE v_room.current_round - 1
  END;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', d.id, 'room_id', d.room_id, 'round', d.round,
      'player_id', d.player_id, 'letter', d.letter, 'text', d.text
    ) ORDER BY d.round, d.letter)
    FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round <= v_max_round
  ), '[]'::jsonb);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_room_definitions(uuid) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.get_ballot(uuid);
CREATE OR REPLACE FUNCTION public.get_ballot(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL OR v_room.status NOT IN ('voting', 'reveal', 'scoreboard', 'finished') THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', d.id, 'letter', d.letter, 'text', d.text) ORDER BY d.letter)
    FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round AND d.letter IS NOT NULL
  ), '[]'::jsonb);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_ballot(uuid) TO anon, authenticated;
