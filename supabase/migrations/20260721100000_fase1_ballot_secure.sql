-- ============================================================
-- Fase 1 (segurança) — parte 2: ballot seguro (S1)
--
-- Problema: a verdade era identificável ANTES da revelação por 3 vias:
--   a) SELECT direto em definitions (player_id='__truth__' + is_truth);
--   b) eventos realtime de definitions (linha completa no payload);
--   c) get_room_state (to_jsonb(d) incluía is_truth/near_truth, e o campo
--      word incluía meaning — dois vazamentos extras).
--
-- Fix (cutover completo, client migrado no mesmo commit):
--   1) get_round_sync: fonte única e phase-aware de definições+votos:
--        writing/shuffling -> progresso (autor visível, TEXTO oculto)
--        voting            -> cédulas (texto visível, AUTOR oculto)
--        reveal+           -> tudo visível
--   2) get_room_state passa a usar o mesmo shape e devolve a palavra
--      SEM meaning fora de reveal/scoreboard/finished.
--   3) submit_definition: dedup de texto normalizado no SERVIDOR (client
--      não lê mais as definições para deduplicar) + devolve o id.
--   4) REVOKE SELECT em definitions + remove da publication realtime.
--
-- ROLLBACK:
--   GRANT SELECT ON public.definitions TO anon, authenticated;
--   CREATE POLICY "public read definitions" ON public.definitions FOR SELECT USING (true);
--   ALTER PUBLICATION supabase_realtime ADD TABLE public.definitions;
--   (get_room_state/submit_definition: reaplicar corpos anteriores,
--    preservados em scripts/dump-functions.mjs + histórico git)
-- ============================================================

-- ---------- 1) Fonte única phase-aware ----------
CREATE OR REPLACE FUNCTION public.get_round_sync(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_defs jsonb;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN RETURN NULL; END IF;

  IF v_room.status IN ('writing', 'shuffling') THEN
    -- Progresso: quem já enviou (sem expor texto nem a verdade)
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', d.id, 'room_id', d.room_id, 'round', d.round,
      'player_id', d.player_id, 'text', '', 'letter', NULL
    ) ORDER BY d.created_at), '[]'::jsonb) INTO v_defs
    FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.is_truth = false AND d.player_id <> '__truth__';
  ELSIF v_room.status = 'voting' THEN
    -- Cédulas: texto e letra, SEM autor (a verdade fica indistinguível)
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', d.id, 'room_id', d.room_id, 'round', d.round,
      'player_id', '', 'text', d.text, 'letter', d.letter
    ) ORDER BY d.letter), '[]'::jsonb) INTO v_defs
    FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.letter IS NOT NULL;
  ELSIF v_room.status IN ('reveal', 'scoreboard', 'finished') THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', d.id, 'room_id', d.room_id, 'round', d.round,
      'player_id', d.player_id, 'text', d.text, 'letter', d.letter
    ) ORDER BY d.letter), '[]'::jsonb) INTO v_defs
    FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round;
  ELSE
    v_defs := '[]'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'definitions', v_defs,
    'votes', COALESCE((
      SELECT jsonb_agg(to_jsonb(v))
      FROM public.votes v
      WHERE v.room_id = p_room_id AND v.round = v_room.current_round
    ), '[]'::jsonb)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_round_sync(uuid) TO anon, authenticated;

-- ---------- 2) get_room_state sem vazamentos ----------
CREATE OR REPLACE FUNCTION public.get_room_state(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_sync jsonb;
  v_word jsonb;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE code = p_code LIMIT 1;
  IF v_room IS NULL THEN
    RETURN NULL;
  END IF;

  v_sync := public.get_round_sync(v_room.id);

  IF v_room.status IN ('reveal', 'scoreboard', 'finished') THEN
    v_word := public.get_word_reveal(v_room.id);
  ELSE
    SELECT jsonb_build_object(
      'id', w.id, 'word', w.word, 'category', w.category, 'rarity', w.rarity,
      'nivel', w.nivel, 'classe', w.classe, 'pronuncia', w.pronuncia
    ) INTO v_word
    FROM public.words w WHERE w.id = v_room.current_word_id;
    IF v_word IS NULL AND v_room.current_word_id IS NOT NULL THEN
      SELECT jsonb_build_object(
        'id', rw.id, 'word', rw.word,
        'category', COALESCE(rw.category, 'custom'), 'rarity', 2
      ) INTO v_word
      FROM public.room_words rw WHERE rw.id = v_room.current_word_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'room', to_jsonb(v_room),
    'players', COALESCE((
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.joined_at)
      FROM public.players p
      WHERE p.room_id = v_room.id AND p.kicked_at IS NULL
    ), '[]'::jsonb),
    'definitions', COALESCE(v_sync->'definitions', '[]'::jsonb),
    'votes', COALESCE(v_sync->'votes', '[]'::jsonb),
    'word', v_word
  );
END;
$function$;

-- ---------- 3) submit_definition: dedup server-side + devolve id ----------
CREATE OR REPLACE FUNCTION public.submit_definition(p_room_id uuid, p_player_id text, p_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_room public.rooms;
  v_clean text;
  v_norm text;
  v_id uuid;
BEGIN
  IF p_room_id IS NULL OR p_player_id IS NULL OR p_text IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  v_clean := substring(btrim(p_text) from 1 for 140);
  IF char_length(v_clean) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_text');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.status <> 'writing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  END IF;
  IF v_room.current_coordinator = p_player_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'coordinator_cannot_write');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE id = p_player_id AND room_id = p_room_id AND kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;

  -- Dedup de texto normalizado (o client não enxerga mais as definições
  -- da rodada, então esta checagem agora vive exclusivamente aqui).
  v_norm := regexp_replace(lower(extensions.unaccent(v_clean)), '[^a-z0-9]+', ' ', 'g');
  IF char_length(btrim(v_norm)) > 0 AND EXISTS (
    SELECT 1 FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.player_id <> p_player_id
      AND regexp_replace(lower(extensions.unaccent(d.text)), '[^a-z0-9]+', ' ', 'g') = v_norm
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'duplicate_definition');
  END IF;

  INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
  VALUES (p_room_id, v_room.current_round, p_player_id, v_clean, false)
  ON CONFLICT (room_id, round, player_id)
    DO UPDATE SET text = EXCLUDED.text, created_at = now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$function$;

-- ---------- 4) Tranca o acesso direto ----------
DROP POLICY IF EXISTS "public read definitions" ON public.definitions;
REVOKE SELECT ON public.definitions FROM anon, authenticated;
-- Condicional: definitions já tinha sido removida da publication numa
-- migration antiga (por isso o client sempre teve poll de defs) — o DROP
-- incondicional falhava com "table not in publication".
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'definitions'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.definitions;
  END IF;
END $$;
