-- ============================================================
-- Banco de palavras v2 (especificação Verbete)
--
-- Enriquece cada palavra com os campos do spec: classe gramatical,
-- origem, curiosidade, pronúncia, exemplo de uso, sinônimos e nível
-- (fácil/médio/difícil/insano). A tela de revelação passa a mostrar
-- esses campos como momento de aprendizado, e o host pode filtrar o
-- sorteio por nível no lobby.
-- ============================================================

ALTER TABLE public.words
  ADD COLUMN IF NOT EXISTS classe text,
  ADD COLUMN IF NOT EXISTS origem text,
  ADD COLUMN IF NOT EXISTS curiosidade text,
  ADD COLUMN IF NOT EXISTS pronuncia text,
  ADD COLUMN IF NOT EXISTS exemplo text,
  ADD COLUMN IF NOT EXISTS sinonimos text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS nivel text NOT NULL DEFAULT 'medio';

ALTER TABLE public.words DROP CONSTRAINT IF EXISTS words_nivel_check;
ALTER TABLE public.words ADD CONSTRAINT words_nivel_check
  CHECK (nivel IN ('facil', 'medio', 'dificil', 'insano'));

-- Backfill do nível a partir da raridade já existente
UPDATE public.words SET nivel = CASE
  WHEN rarity <= 1 THEN 'facil'
  WHEN rarity = 2 THEN 'medio'
  WHEN rarity = 3 THEN 'dificil'
  ELSE 'insano'
END
WHERE nivel = 'medio';

-- Nível escolhido pelo host da sala ('aleatorio' = sem filtro)
ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS nivel text NOT NULL DEFAULT 'aleatorio';
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_nivel_check;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_nivel_check
  CHECK (nivel IN ('facil', 'medio', 'dificil', 'insano', 'aleatorio'));

-- ---------- get_random_words com filtro de nível ----------
-- Assinatura muda (novo parâmetro com default), então DROP + CREATE.
-- Chamadas antigas com 4 argumentos continuam válidas pelo default.
DROP FUNCTION IF EXISTS public.get_random_words(uuid[], integer, integer, text[]);

CREATE OR REPLACE FUNCTION public.get_random_words(
  exclude_ids uuid[] DEFAULT ARRAY[]::uuid[],
  min_rarity integer DEFAULT 2,
  lim integer DEFAULT 3,
  p_categories text[] DEFAULT ARRAY[]::text[],
  p_nivel text DEFAULT NULL
)
RETURNS SETOF public.words
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH preferred AS (
    SELECT * FROM public.words
    WHERE char_length(meaning) <= 60
      AND (exclude_ids IS NULL OR NOT (id = ANY(exclude_ids)))
      AND (
        p_categories IS NULL
        OR array_length(p_categories, 1) IS NULL
        OR category = ANY(p_categories)
      )
      -- Quando o host fixa um nível, ele é a autoridade de dificuldade e o
      -- filtro de raridade sai do caminho (senão nível 'facil' + rarity>=2
      -- esvaziaria o pool e cairia no fallback, que ignora o nível).
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
    WHERE (exclude_ids IS NULL OR NOT (id = ANY(exclude_ids)))
    ORDER BY char_length(meaning) ASC, random()
    LIMIT lim
  )
  SELECT * FROM preferred
  UNION ALL
  SELECT * FROM fallback
  WHERE (SELECT count(*) FROM preferred) < lim
  LIMIT lim;
$function$;

-- ---------- advance_choosing_to_writing respeita o nível da sala ----------
CREATE OR REPLACE FUNCTION public.advance_choosing_to_writing(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_word public.words;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'choosing' THEN RETURN jsonb_build_object('action', 'noop'); END IF;
  IF v_room.current_word_id IS NOT NULL THEN RETURN jsonb_build_object('action', 'noop'); END IF;
  IF v_room.round_phase_ends_at IS NULL OR v_room.round_phase_ends_at > now() THEN
    RETURN jsonb_build_object('action', 'noop_grace');
  END IF;

  SELECT * INTO v_word FROM public.get_random_words(v_room.used_word_ids, 2, 1, v_room.categories, v_room.nivel) LIMIT 1;
  IF v_word IS NULL THEN
    UPDATE public.rooms SET round_phase_ends_at = now() + interval '60 seconds' WHERE id = p_room_id;
    RETURN jsonb_build_object('action', 'noop_no_words');
  END IF;

  UPDATE public.rooms
  SET status = 'writing',
      current_word_id = v_word.id,
      used_word_ids = array_append(v_room.used_word_ids, v_word.id),
      round_phase_ends_at = now() + interval '60 seconds',
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('action', 'auto_picked', 'word_id', v_word.id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.advance_choosing_to_writing(uuid) FROM anon, authenticated, public;

-- ---------- host_update_room_config aceita 'nivel' ----------
CREATE OR REPLACE FUNCTION public.host_update_room_config(
  p_room_id uuid,
  p_actor_id text,
  p_patch jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room public.rooms;
  v_win_condition text;
  v_win_target int;
  v_mode text;
  v_nivel text;
  v_categories text[];
  v_teams jsonb;
BEGIN
  IF p_room_id IS NULL OR p_actor_id IS NULL OR p_patch IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.host_id <> p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_host');
  END IF;
  IF v_room.status <> 'lobby' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_lobby');
  END IF;

  IF p_patch ? 'win_condition' THEN
    v_win_condition := p_patch->>'win_condition';
    IF v_win_condition NOT IN ('score','rounds') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_win_condition');
    END IF;
    UPDATE public.rooms SET win_condition = v_win_condition WHERE id = p_room_id;
  END IF;

  IF p_patch ? 'win_target' THEN
    v_win_target := (p_patch->>'win_target')::int;
    IF v_win_target IS NULL OR v_win_target < 1 OR v_win_target > 5000 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_win_target');
    END IF;
    UPDATE public.rooms SET win_target = v_win_target WHERE id = p_room_id;
  END IF;

  IF p_patch ? 'nivel' THEN
    v_nivel := p_patch->>'nivel';
    IF v_nivel NOT IN ('facil', 'medio', 'dificil', 'insano', 'aleatorio') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_nivel');
    END IF;
    UPDATE public.rooms SET nivel = v_nivel WHERE id = p_room_id;
  END IF;

  IF p_patch ? 'categories' THEN
    SELECT array_agg(substring(btrim(value::text, '"') from 1 for 40))
      INTO v_categories
      FROM jsonb_array_elements_text(p_patch->'categories') AS t(value)
      WHERE char_length(btrim(value::text, '"')) BETWEEN 1 AND 40;
    UPDATE public.rooms SET categories = COALESCE(v_categories, '{}'::text[]) WHERE id = p_room_id;
  END IF;

  IF p_patch ? 'mode' THEN
    v_mode := p_patch->>'mode';
    IF v_mode NOT IN ('individual','teams') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_mode');
    END IF;
    UPDATE public.rooms SET mode = v_mode WHERE id = p_room_id;
    IF v_mode = 'individual' THEN
      UPDATE public.players SET team_id = NULL WHERE room_id = p_room_id;
    END IF;
  END IF;

  IF p_patch ? 'teams' THEN
    v_teams := p_patch->'teams';
    IF jsonb_typeof(v_teams) <> 'array' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_teams');
    END IF;
    IF jsonb_array_length(v_teams) > 8 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'too_many_teams');
    END IF;
    UPDATE public.rooms SET teams = v_teams WHERE id = p_room_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.host_update_room_config(uuid, text, jsonb) TO anon, authenticated;
