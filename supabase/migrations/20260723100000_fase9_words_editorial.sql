-- =============================================================================
-- Fase 9 — Banco editorial de palavras
-- • words.status: draft | ai_generated | reviewed | approved | rejected | published
--   (as 180 curadas existentes viram 'published' via DEFAULT)
-- • words.review_notes: trilha editorial
-- • get_random_words: só sorteia 'published'
-- • RPCs de revisão (role admin): listar por status + aprovar/rejeitar/editar
-- ROLLBACK: ALTER TABLE words DROP COLUMN status, DROP COLUMN review_notes;
--           reaplicar get_random_words anterior; DROP das RPCs admin_*.
-- =============================================================================

ALTER TABLE public.words
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'published'
    CHECK (status IN ('draft','ai_generated','reviewed','approved','rejected','published')),
  ADD COLUMN IF NOT EXISTS review_notes text;

CREATE INDEX IF NOT EXISTS idx_words_status ON public.words (status);

-- Sorteio: apenas palavras publicadas entram no jogo
CREATE OR REPLACE FUNCTION public.get_random_words(exclude_ids uuid[] DEFAULT ARRAY[]::uuid[], min_rarity integer DEFAULT 2, lim integer DEFAULT 3, p_categories text[] DEFAULT ARRAY[]::text[], p_nivel text DEFAULT NULL::text)
 RETURNS SETOF words
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH preferred AS (
    SELECT * FROM public.words
    WHERE status = 'published'
      AND char_length(meaning) <= 60
      AND (exclude_ids IS NULL OR NOT (id = ANY(exclude_ids)))
      AND (
        p_categories IS NULL
        OR array_length(p_categories, 1) IS NULL
        OR category = ANY(p_categories)
      )
      AND (
        CASE
          WHEN p_nivel IS NULL OR p_nivel = 'aleatorio' THEN rarity >= min_rarity
          ELSE nivel = p_nivel
        END
      )
    ORDER BY random()
    LIMIT lim
  ),
  fallback AS (
    SELECT * FROM public.words
    WHERE status = 'published'
      AND (exclude_ids IS NULL OR NOT (id = ANY(exclude_ids)))
    ORDER BY char_length(meaning) ASC, random()
    LIMIT lim
  )
  SELECT * FROM preferred
  UNION ALL
  SELECT * FROM fallback
  WHERE (SELECT count(*) FROM preferred) < lim
  LIMIT lim;
$function$;

-- ---------------------------------------------------------------------------
-- Revisão editorial (role admin) — o client comum NÃO enxerga meaning fora
-- do reveal; estas RPCs devolvem tudo, gated por has_role(auth.uid(),'admin').
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_list_words(p_status text DEFAULT 'ai_generated', p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_admin');
  END IF;
  RETURN jsonb_build_object('ok', true, 'total',
    (SELECT count(*) FROM public.words w WHERE w.status = p_status),
    'words',
    COALESCE((
      SELECT jsonb_agg(to_jsonb(w) ORDER BY w.created_at DESC)
      FROM (
        SELECT * FROM public.words
        WHERE status = p_status
        ORDER BY created_at DESC
        LIMIT LEAST(p_limit, 100) OFFSET GREATEST(p_offset, 0)
      ) w
    ), '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_review_word(p_word_id uuid, p_action text, p_notes text DEFAULT NULL, p_meaning text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_admin');
  END IF;
  IF p_action NOT IN ('publish', 'reject', 'draft') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_action');
  END IF;
  UPDATE public.words
     SET status = CASE p_action WHEN 'publish' THEN 'published'
                                WHEN 'reject' THEN 'rejected'
                                ELSE 'draft' END,
         review_notes = COALESCE(p_notes, review_notes),
         meaning = COALESCE(NULLIF(btrim(p_meaning), ''), meaning)
   WHERE id = p_word_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'word_not_found');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;
