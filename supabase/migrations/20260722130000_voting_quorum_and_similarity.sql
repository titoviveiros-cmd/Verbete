-- =============================================================================
-- Correção definitiva do voto perdido (sala 7850, playtest 2026-07-20) +
-- barreira de similaridade nas definições.
--
-- CADEIA DO BUG (auditoria): o client injeta voto OTIMISTA local; o allVoted
-- do host contava esse voto e disparava advance_voting_to_reveal em corrida
-- com o próprio cast_vote. O advance ganhava o lock, pontuava a rodada com os
-- votos dos bots (guard antigo só barrava com ZERO votos) e o voto real
-- chegava em 'reveal' → wrong_phase → jogador sem o ponto.
--
-- Defesas:
-- 1) advance_voting_to_reveal: QUÓRUM REAL — enquanto houver humano vivo sem
--    voto e o prazo não tiver estourado (+2s de folga de latência), é no-op.
-- 2) rejoin_room: joined_at só renova para quem foi EXPULSO e voltou; um
--    simples reload/retomada de aba não muda mais o status do jogador na
--    rodada (era o vetor de "dispensa" indevida).
-- 3) submit_definition: rejeita definição MUITO PARECIDA (pg_trgm) com outra
--    da rodada — playtest mostrou IA/bots convergindo em textos quase iguais.
-- ROLLBACK: reaplicar as versões de 20260721140000/20260722100000.
-- =============================================================================

-- 1) Quórum real na virada da votação
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

  -- QUÓRUM REAL (sala 7850): humano vivo sem voto + prazo ainda válido
  -- (+2s de folga p/ latência móvel) → não avança. Nenhum bug de client
  -- consegue mais pontuar a rodada sem o voto de alguém dentro do tempo.
  IF v_room.round_phase_ends_at IS NOT NULL
     AND now() < v_room.round_phase_ends_at + interval '2 seconds'
     AND EXISTS (
       SELECT 1 FROM public.players p
       WHERE p.room_id = p_room_id AND p.kicked_at IS NULL AND p.is_bot = false
         AND NOT EXISTS (
           SELECT 1 FROM public.votes v
           WHERE v.room_id = p_room_id
             AND v.round = v_room.current_round
             AND v.voter_id = p.id
         )
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

  -- Acertou a definição verdadeira: +3
  IF v_truth_def_id IS NOT NULL THEN
    UPDATE public.players p SET score = p.score + 3
    WHERE p.id IN (
      SELECT voter_id FROM public.votes
      WHERE room_id = p_room_id AND round = v_room.current_round AND definition_id = v_truth_def_id
    );
  END IF;

  -- Cada voto no seu blefe: +1 por voto
  FOR r IN
    SELECT d.player_id, count(v.id) AS votes
    FROM public.definitions d
    LEFT JOIN public.votes v ON v.definition_id = d.id
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.is_truth = false AND d.player_id <> '__truth__'
    GROUP BY d.player_id
    HAVING count(v.id) > 0
  LOOP
    UPDATE public.players SET score = score + r.votes WHERE id = r.player_id;
  END LOOP;

  -- Coordenador: +2 se ninguém achou a verdade (e houve votos)
  IF v_truth_voters = 0 AND v_total_votes > 0 AND v_room.current_coordinator IS NOT NULL THEN
    UPDATE public.players SET score = score + 2 WHERE id = v_room.current_coordinator;
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

-- 2) rejoin_room: joined_at só renova para expulso que voltou
CREATE OR REPLACE FUNCTION public.rejoin_room(p_code text, p_player_id text, p_nickname text, p_avatar text, p_color text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_existing public.players;
  v_uid uuid := auth.uid();
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE code = p_code LIMIT 1;
  IF v_room IS NULL THEN
    RAISE EXCEPTION 'room_not_found';
  END IF;

  SELECT * INTO v_existing FROM public.players WHERE id = p_player_id AND room_id = v_room.id LIMIT 1;

  IF v_existing.id IS NOT NULL AND v_existing.user_id IS NOT NULL
     AND v_uid IS NOT NULL AND v_existing.user_id <> v_uid THEN
    RAISE EXCEPTION 'player_id_taken';
  END IF;

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.players
      SET kicked_at = NULL,
          is_connected = true,
          writing_extensions = 0,
          voting_extensions = 0,
          user_id = COALESCE(v_existing.user_id, v_uid),
          -- Só quem foi EXPULSO e voltou é tratado como entrada tardia
          -- (sala 7850: reload/retomada de aba renovava joined_at e o
          -- jogador era dispensado da rodada — voto ignorado).
          joined_at = CASE
            WHEN v_existing.kicked_at IS NOT NULL
                 AND v_room.status IN ('writing','voting') THEN now()
            ELSE v_existing.joined_at
          END,
          nickname = COALESCE(NULLIF(p_nickname, ''), nickname),
          avatar = COALESCE(NULLIF(p_avatar, ''), avatar),
          color = COALESCE(NULLIF(p_color, ''), color)
      WHERE id = p_player_id;
  ELSE
    INSERT INTO public.players (id, room_id, nickname, avatar, color, is_connected, user_id)
    VALUES (p_player_id, v_room.id, p_nickname, p_avatar, p_color, true, v_uid);
  END IF;

  RETURN to_jsonb(v_room);
END;
$function$;

-- 3) submit_definition: rejeita definição muito parecida (pg_trgm)
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
