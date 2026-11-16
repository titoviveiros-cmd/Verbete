-- Reversão da 20261112120000_privacidade_fase2: devolve a leitura pública das
-- 7 tabelas (as políticas EXATAMENTE como nasceram: mesmo nome, FOR SELECT,
-- papel PUBLIC, USING (true)), as 6 RPCs de leitura por id com os corpos de
-- produção de 12/11 (byte a byte; permissões não mudam com CREATE OR
-- REPLACE), e apaga as 2 políticas de realtime.messages e as 2 funções novas.
-- ATENÇÃO: reverter REABRE apelidos, user_id e room_id de todas as salas.
-- ORDEM: este ANTES de supabase/rollback/rooms_leitura_restrita.sql (aquele
-- apaga is_room_participant/my_room_ids, usadas pelas políticas daqui).
-- Depois: supabase migration repair --status reverted 20261112120000
-- O app novo usa canais PRIVADOS: sem as políticas de realtime.messages ele
-- fica só no polling (funciona, mais lento) até religar ou voltar o web.

DROP POLICY IF EXISTS "verbete canais: participante recebe" ON realtime.messages;
DROP POLICY IF EXISTS "verbete canais: participante envia" ON realtime.messages;

DROP POLICY IF EXISTS "players participantes leem" ON public.players;
DROP POLICY IF EXISTS "public read players" ON public.players;
CREATE POLICY "public read players" ON public.players FOR SELECT USING (true);

DROP POLICY IF EXISTS "votes participantes leem" ON public.votes;
DROP POLICY IF EXISTS "public read votes" ON public.votes;
CREATE POLICY "public read votes" ON public.votes FOR SELECT USING (true);

DROP POLICY IF EXISTS "reactions participantes leem" ON public.reactions;
DROP POLICY IF EXISTS "public read reactions" ON public.reactions;
CREATE POLICY "public read reactions" ON public.reactions FOR SELECT USING (true);

DROP POLICY IF EXISTS "round_extensions participantes leem" ON public.round_extensions;
DROP POLICY IF EXISTS "round_extensions public read" ON public.round_extensions;
CREATE POLICY "round_extensions public read" ON public.round_extensions FOR SELECT USING (true);

DROP POLICY IF EXISTS "rounds participantes leem" ON public.rounds;
DROP POLICY IF EXISTS "rounds open select" ON public.rounds;
CREATE POLICY "rounds open select" ON public.rounds FOR SELECT USING (true);

DROP POLICY IF EXISTS "room_messages participantes leem" ON public.room_messages;
DROP POLICY IF EXISTS "room_messages public read" ON public.room_messages;
CREATE POLICY "room_messages public read" ON public.room_messages FOR SELECT USING (true);

DROP POLICY IF EXISTS "room_words participantes leem" ON public.room_words;
DROP POLICY IF EXISTS "room_words public read" ON public.room_words;
CREATE POLICY "room_words public read" ON public.room_words FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION public.get_ballot(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_room_definitions(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_room_reveal(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM public.rooms WHERE id = p_room_id;
  IF v_status IS NULL OR v_status NOT IN ('reveal','scoreboard','finished') THEN
    RETURN jsonb_build_object('available', false);
  END IF;

  RETURN jsonb_build_object(
    'available', true,
    'truth_def_ids', COALESCE((
      SELECT array_agg(id) FROM public.definitions
       WHERE room_id = p_room_id AND is_truth = true
    ), ARRAY[]::uuid[]),
    'near_truth_ids', COALESCE((
      SELECT array_agg(id) FROM public.definitions
       WHERE room_id = p_room_id AND near_truth = true
    ), ARRAY[]::uuid[])
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_round_reveal(p_room_id uuid, p_round integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  v_truth_id uuid;
  v_near_ids uuid[];
BEGIN
  SELECT status INTO v_status FROM public.rooms WHERE id = p_room_id;
  IF v_status IS NULL OR v_status NOT IN ('reveal','scoreboard','finished') THEN
    RETURN jsonb_build_object('available', false);
  END IF;

  SELECT id INTO v_truth_id FROM public.definitions
   WHERE room_id = p_room_id AND round = p_round AND is_truth = true LIMIT 1;

  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_near_ids
   FROM public.definitions
   WHERE room_id = p_room_id AND round = p_round AND near_truth = true;

  RETURN jsonb_build_object(
    'available', true,
    'truth_def_id', v_truth_id,
    'near_truth_ids', v_near_ids
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_round_sync(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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
$function$
;

CREATE OR REPLACE FUNCTION public.get_word_reveal(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_out jsonb;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL OR v_room.current_word_id IS NULL THEN RETURN NULL; END IF;
  -- Gate de fase: metadados reveladores só depois que a rodada foi pontuada.
  IF v_room.status NOT IN ('reveal', 'scoreboard', 'finished') THEN RETURN NULL; END IF;

  SELECT to_jsonb(w) INTO v_out FROM public.words w WHERE w.id = v_room.current_word_id;
  IF v_out IS NULL THEN
    SELECT jsonb_build_object(
      'id', rw.id, 'word', rw.word, 'meaning', rw.meaning,
      'category', COALESCE(rw.category, 'custom'), 'rarity', 2,
      'nivel', NULL, 'classe', NULL, 'pronuncia', NULL,
      'origem', NULL, 'curiosidade', NULL, 'exemplo', NULL, 'sinonimos', NULL
    ) INTO v_out
    FROM public.room_words rw WHERE rw.id = v_room.current_word_id;
  END IF;
  RETURN v_out;
END;
$function$
;

DROP FUNCTION IF EXISTS public.room_read_allowed(uuid);
DROP FUNCTION IF EXISTS public.realtime_topic_allowed(text);
