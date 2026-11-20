-- P1 do pré-lançamento (20/11/2026) — NÃO aplicada. Só com autorização expressa (migration em produção).
-- Não toca no Diário (B4), em ai_mode/daily_mode nem em tabelas: 3 funções, CREATE OR REPLACE (GRANTs preservados).
--  1) get_round_sync: na escrita/embaralhamento devolvia o id de cada definição; na votação, a única cédula
--     com id nunca visto era a verdade (+3 garantidos por rodada). Agora id = NULL nessas fases.
--  2) choose_word: aceitava qualquer p_word_id (rascunho/rejeitada) — com get_word_reveal, baixava o banco
--     editorial inteiro. Agora só palavra publicada ou palavra própria da sala.
--  3) get_word_reveal: deixa de devolver review_notes (anotação interna da revisão).
-- Rollback: supabase/rollback/p1_seguranca_lancamento.sql (recria as 3 definições anteriores).
-- Testes: scripts/test-autorizacao-fase3.mjs (integração, CI).

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
  -- PF2: só quem participa da sala (ou chamada interna: service_role, cron,
  -- SQL do dono) lê; de fora = a mesma resposta de sala inexistente.
  IF NOT public.room_read_allowed(p_room_id) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN RETURN NULL; END IF;

  IF v_room.status IN ('writing', 'shuffling') THEN
    -- Progresso: quem já enviou (sem expor texto nem a verdade)
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      -- 21/11: SEM id — o id visto na escrita, comparado com as cédulas da votação,
      -- entregava a verdade (a única cédula com id novo). O cliente só usa player_id aqui.
      'id', NULL, 'room_id', d.room_id, 'round', d.round,
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

CREATE OR REPLACE FUNCTION public.choose_word(p_room_id uuid, p_word_id uuid, p_duration_sec integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  -- Fase 3 (13/11/2026): quem chama — antes de travar a sala
  v_gate text := public.room_actor_gate(p_room_id);
BEGIN
  -- Fase 3: sem sessão / de fora / expulso = a resposta de sala inexistente
  IF v_gate IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found'); END IF;
  -- Fase 3: o app manda sempre 60; negativo vencia a escrita na hora
  p_duration_sec := LEAST(GREATEST(COALESCE(p_duration_sec, 60), 30), 120);
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found'); END IF;
  IF v_room.status <> 'choosing' THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state'); END IF;
  IF v_room.current_word_id IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'already_chosen'); END IF;
  -- Fase 3: só o coordenador da rodada; coordenador bot = qualquer participante
  IF NOT public.room_actor_is(p_room_id, v_room.current_coordinator)
     AND NOT EXISTS (
       SELECT 1 FROM public.players b
        WHERE b.id = v_room.current_coordinator AND b.room_id = p_room_id
          AND b.is_bot AND b.kicked_at IS NULL
     ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;
  -- Diário D1: a palavra da hora do Desafio Diário não pode ser escolhida numa sala
  IF p_word_id IS NOT DISTINCT FROM public.daily_current_word_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'word_unavailable');
  END IF;
  -- 21/11: só palavra PUBLICADA do banco ou palavra própria DESTA sala. Antes qualquer id
  -- (rascunho/rejeitada) virava a palavra da rodada e get_word_reveal entregava o verbete.
  IF NOT EXISTS (SELECT 1 FROM public.words w WHERE w.id = p_word_id AND w.status = 'published')
     AND NOT EXISTS (SELECT 1 FROM public.room_words rw WHERE rw.id = p_word_id AND rw.room_id = p_room_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'word_unavailable');
  END IF;

  UPDATE public.rooms
  SET status = 'writing',
      current_word_id = p_word_id,
      used_word_ids = CASE
        WHEN p_word_id = ANY(used_word_ids) THEN used_word_ids
        ELSE array_append(used_word_ids, p_word_id)
      END,
      -- escrita: base + 10 s, sem escalar com a sala (2026-10-25)
      round_phase_ends_at = now() + make_interval(secs => public.writing_phase_secs(p_duration_sec)),
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

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
  -- PF2: só quem participa da sala (ou chamada interna: service_role, cron,
  -- SQL do dono) lê; de fora = a mesma resposta de sala inexistente.
  IF NOT public.room_read_allowed(p_room_id) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL OR v_room.current_word_id IS NULL THEN RETURN NULL; END IF;
  -- Gate de fase: metadados reveladores só depois que a rodada foi pontuada.
  IF v_room.status NOT IN ('reveal', 'scoreboard', 'finished') THEN RETURN NULL; END IF;

  -- 21/11: sem as notas internas de revisão editorial
  SELECT to_jsonb(w) - 'review_notes' INTO v_out FROM public.words w WHERE w.id = v_room.current_word_id;
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
