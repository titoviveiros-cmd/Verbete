-- ============================================================
-- Fase 1 (segurança) — parte 1: blindagem do banco de palavras
--
-- Problema S2 do plano v2.0: `words.meaning` (e curiosidade/origem/
-- exemplo/sinonimos) eram legíveis pelo client a qualquer momento —
-- qualquer jogador podia consultar o significado da palavra da rodada
-- e vencer sempre.
--
-- Estratégia:
--   1) Grants POR COLUNA em words: client só lê id/word/category/
--      rarity/nivel/classe/pronuncia. meaning e metadados reveladores
--      só saem por RPC com validação de fase.
--   2) get_random_word_prompts: sorteio seguro (sem meaning) p/ client;
--      get_random_words fica interna (revogada do client) — as funções
--      SECURITY DEFINER continuam usando-a normalmente.
--   3) get_word_reveal: dados completos da palavra APENAS quando a sala
--      está em reveal/scoreboard/finished.
--   4) get_ballot / get_room_definitions: criadas AGORA para o cutover
--      do problema S1 (verdade identificável no ballot). O REVOKE de
--      SELECT em definitions acontece numa migration posterior, depois
--      que o client migrar para as RPCs (ordem de cutover documentada
--      no plano — mesma receita do motor server-authoritative).
--   5) BUGFIX: advance_writing_to_voting não inseria a verdade quando a
--      palavra era customizada (room_words) — a sala travava em writing.
--      Agora cai para room_words quando não acha em words.
--
-- ROLLBACK:
--   GRANT SELECT ON public.words TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.get_random_words(uuid[],int,int,text[],text) TO anon, authenticated;
--   DROP FUNCTION public.get_random_word_prompts, public.get_word_reveal,
--        public.get_ballot, public.get_room_definitions;
--   (advance_writing_to_voting: reaplicar corpo de 20260719100000)
-- ============================================================

-- ---------- 1) Grants por coluna em words ----------
REVOKE SELECT ON public.words FROM anon, authenticated;
GRANT SELECT (id, word, category, rarity, nivel, classe, pronuncia, created_at)
  ON public.words TO anon, authenticated;

-- ---------- 2) Sorteio seguro (sem meaning) ----------
REVOKE EXECUTE ON FUNCTION public.get_random_words(uuid[], integer, integer, text[], text)
  FROM anon, authenticated, public;

CREATE OR REPLACE FUNCTION public.get_random_word_prompts(
  exclude_ids uuid[] DEFAULT ARRAY[]::uuid[],
  min_rarity integer DEFAULT 2,
  lim integer DEFAULT 3,
  p_categories text[] DEFAULT ARRAY[]::text[],
  p_nivel text DEFAULT NULL
)
RETURNS TABLE(id uuid, word text, category text, rarity int, nivel text, classe text, pronuncia text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT w.id, w.word, w.category, w.rarity, w.nivel, w.classe, w.pronuncia
  FROM public.get_random_words(exclude_ids, min_rarity, lim, p_categories, p_nivel) AS w;
$function$;

GRANT EXECUTE ON FUNCTION public.get_random_word_prompts(uuid[], integer, integer, text[], text) TO anon, authenticated;

-- ---------- 3) Palavra completa só após a revelação ----------
CREATE OR REPLACE FUNCTION public.get_word_reveal(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
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
$function$;

GRANT EXECUTE ON FUNCTION public.get_word_reveal(uuid) TO anon, authenticated;

-- ---------- 4) RPCs do ballot seguro (cutover S1, client migra depois) ----------
-- Votação: cédulas SEM autor e SEM marcador de verdade.
CREATE OR REPLACE FUNCTION public.get_ballot(p_room_id uuid)
RETURNS TABLE(id uuid, letter text, text text)
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
    RETURN;
  END IF;
  RETURN QUERY
    SELECT d.id, d.letter, d.text
    FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round AND d.letter IS NOT NULL
    ORDER BY d.letter;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_ballot(uuid) TO anon, authenticated;

-- Pós-revelação: definições completas (autores visíveis) da sala inteira,
-- para Reveal/Scoreboard/Finished. Antes da revelação da rodada corrente,
-- a rodada corrente fica de fora.
CREATE OR REPLACE FUNCTION public.get_room_definitions(p_room_id uuid)
RETURNS TABLE(id uuid, round int, player_id text, letter text, text text)
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
  IF v_room IS NULL THEN RETURN; END IF;
  -- Rodadas passadas sempre; a corrente só depois de pontuada (reveal+).
  v_max_round := CASE
    WHEN v_room.status IN ('reveal', 'scoreboard', 'finished') THEN v_room.current_round
    ELSE v_room.current_round - 1
  END;
  RETURN QUERY
    SELECT d.id, d.round, d.player_id, d.letter, d.text
    FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round <= v_max_round
    ORDER BY d.round, d.letter;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_room_definitions(uuid) TO anon, authenticated;

-- ---------- 5) BUGFIX: verdade de palavras customizadas ----------
CREATE OR REPLACE FUNCTION public.advance_writing_to_voting(p_room_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_room public.rooms;
  v_meaning text;
  v_def_ids uuid[];
  v_letters text := 'ABCDEFGHIJKLM';
  v_id uuid;
  v_idx int := 1;
  v_truth text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status NOT IN ('writing', 'shuffling') THEN RETURN; END IF;
  IF v_room.current_word_id IS NULL THEN RETURN; END IF;

  IF EXISTS (
    SELECT 1
    FROM public.players p
    WHERE p.room_id = p_room_id
      AND p.is_bot = false
      AND p.kicked_at IS NULL
      AND p.id <> COALESCE(v_room.current_coordinator, '')
      AND (v_room.phase_started_at IS NULL OR p.joined_at <= v_room.phase_started_at + interval '3 seconds')
      AND NOT EXISTS (
        SELECT 1
        FROM public.definitions d
        WHERE d.room_id = p_room_id
          AND d.round = v_room.current_round
          AND d.player_id = p.id
      )
  ) THEN
    RETURN;
  END IF;

  -- Significado: banco global OU palavra customizada da sala (bugfix)
  SELECT w.meaning INTO v_meaning FROM public.words w WHERE w.id = v_room.current_word_id;
  IF v_meaning IS NULL THEN
    SELECT rw.meaning INTO v_meaning FROM public.room_words rw WHERE rw.id = v_room.current_word_id;
  END IF;
  IF v_meaning IS NULL THEN RETURN; END IF;

  v_truth := lower(extensions.unaccent(v_meaning));
  v_truth := regexp_replace(v_truth, '^(\(?[a-z]{1,5}\.(\s*[a-z]{1,5}\.)?\)?|\([^)]{1,30}\))[\s:;,-]+', '', 'g');
  v_truth := regexp_replace(v_truth, '^(\(?[a-z]{1,5}\.(\s*[a-z]{1,5}\.)?\)?|\([^)]{1,30}\))[\s:;,-]+', '', 'g');
  v_truth := split_part(v_truth, ';', 1);
  v_truth := btrim(v_truth);
  IF char_length(v_truth) > 60 THEN
    v_truth := substring(v_truth from 1 for 60);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.definitions
    WHERE room_id = p_room_id AND round = v_room.current_round AND is_truth = true
  ) THEN
    INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
    VALUES (p_room_id, v_room.current_round, '__truth__', v_truth, true);
  END IF;

  SELECT array_agg(d.id ORDER BY random()) INTO v_def_ids
  FROM public.definitions d
  WHERE d.room_id = p_room_id AND d.round = v_room.current_round;

  FOREACH v_id IN ARRAY v_def_ids LOOP
    UPDATE public.definitions SET letter = substr(v_letters, v_idx, 1) WHERE id = v_id;
    v_idx := v_idx + 1;
  END LOOP;

  UPDATE public.rooms
  SET status = 'voting',
      round_phase_ends_at = now() + interval '30 seconds',
      phase_started_at = now()
  WHERE id = p_room_id;
END;
$function$;
