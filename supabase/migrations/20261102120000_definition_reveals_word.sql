-- =============================================================================
-- 2.1.4 — Definições sem asteriscos (sala 5873, rodada 2, palavra "cicerone":
-- "ciceronear" virou "***ar" no aparelho). O cliente deixa de mascarar e passa
-- a recusar com aviso; o servidor confere a MESMA regra (reveals_word);
-- nada de histórico é alterado; texto já mascarado por cliente antigo
-- segue aceito nesta versão (compatibilidade com o Android 2.1.3).
-- ROLLBACK: supabase/rollback/definition_reveals_word.sql
-- =============================================================================

-- Palavras do texto com os disfarces desfeitos (igual a revealTokens do client):
-- invisíveis fora, minúsculas sem acento, pontuação no meio cola as partes,
-- sequência de letras soltas vira uma palavra.
CREATE OR REPLACE FUNCTION public.definition_reveal_tokens(p_text text)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_glued text;
  v_tok text;
  v_run text := '';
  v_out text[] := '{}';
BEGIN
  v_glued := regexp_replace(
    lower(unaccent(regexp_replace(coalesce(p_text, ''), '[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]', '', 'g'))),
    '[^a-z0-9\s]+', '', 'g');
  FOREACH v_tok IN ARRAY regexp_split_to_array(btrim(v_glued), '\s+') LOOP
    CONTINUE WHEN v_tok = '';
    IF char_length(v_tok) = 1 THEN
      v_run := v_run || v_tok;
      CONTINUE;
    END IF;
    IF v_run <> '' THEN v_out := v_out || v_run; END IF;
    v_run := '';
    v_out := v_out || v_tok;
  END LOOP;
  IF v_run <> '' THEN v_out := v_out || v_run; END IF;
  RETURN v_out;
END;
$$;

-- A definição revela a palavra? Palavra inteira (com plural), disfarçada ou
-- não; para palavras de 6+ letras, também derivadas que começam por ela
-- ("ciceronear"). Trecho dentro de outra palavra e raiz parecida NÃO contam.
CREATE OR REPLACE FUNCTION public.definition_reveals_word(p_text text, p_word text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_target text[] := public.definition_reveal_tokens(p_word);
  v_toks text[] := public.definition_reveal_tokens(p_text);
  v_w text;
  v_n int := coalesce(array_length(v_target, 1), 0);
  i int;
BEGIN
  IF v_n = 0 OR char_length(array_to_string(v_target, '')) < 3 THEN
    RETURN false;
  END IF;
  IF v_n > 1 THEN
    FOR i IN 1 .. coalesce(array_length(v_toks, 1), 0) - v_n + 1 LOOP
      IF v_toks[i:i + v_n - 1] = v_target THEN RETURN true; END IF;
    END LOOP;
    RETURN false;
  END IF;
  v_w := v_target[1];
  RETURN EXISTS (
    SELECT 1 FROM unnest(v_toks) t
     WHERE t = v_w OR t = v_w || 's' OR t = v_w || 'es'
        OR (char_length(v_w) >= 6 AND left(t, char_length(v_w)) = v_w)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.definition_reveal_tokens(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.definition_reveals_word(text, text) FROM PUBLIC, anon, authenticated;

-- submit_definition = corpo de 20261003100000 + a recusa reveals_word.
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
  v_reason text;
  v_word text;
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
  v_reason := public.assert_actor_identity(p_room_id, p_player_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;

  -- Clientes antigos (Android 2.1.3, abas velhas) ainda mascaram a palavra no
  -- aparelho e mandam "***": continuam aceitos nesta versão (recusar travaria
  -- quem não atualizou — o app antigo mascara de novo a cada tentativa). A
  -- recusa de "***" fica para depois da versão mínima subir para o vc8.
  -- Anti-cola também no servidor (mesma regra de src/lib/text-filter.ts).
  SELECT w.word INTO v_word FROM public.words w WHERE w.id = v_room.current_word_id;
  IF v_word IS NOT NULL AND public.definition_reveals_word(v_clean, v_word) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'reveals_word');
  END IF;

  v_norm := regexp_replace(lower(unaccent(v_clean)), '[^a-z0-9]+', ' ', 'g');

  -- Idêntica (normalizada)
  IF char_length(btrim(v_norm)) > 0 AND EXISTS (
    SELECT 1 FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.player_id <> p_player_id
      AND regexp_replace(lower(unaccent(d.text)), '[^a-z0-9]+', ' ', 'g') = v_norm
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'duplicate_definition');
  END IF;

  -- Muito parecida (playtest: IA/bots convergiam em textos quase iguais,
  -- ex.: "excesso de elegancia mundana" vs "excesso de elegancia formal")
  IF char_length(btrim(v_norm)) > 12 AND EXISTS (
    SELECT 1 FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.player_id <> p_player_id
      AND similarity(
            regexp_replace(lower(unaccent(d.text)), '[^a-z0-9]+', ' ', 'g'),
            v_norm
          ) > 0.62
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_similar');
  END IF;

  INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
  VALUES (p_room_id, v_room.current_round, p_player_id, v_clean, false)
  ON CONFLICT (room_id, round, player_id)
    DO UPDATE SET text = EXCLUDED.text, created_at = now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$function$;
