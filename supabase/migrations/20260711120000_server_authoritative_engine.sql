-- ============================================================
-- Motor de jogo server-authoritative (Fase 1 da reconstrução do Verbete)
--
-- Até aqui, quem fazia a sala avançar de fase (escolher palavra, votar,
-- revelar, pontuar, próxima rodada) era o navegador do host, com updates
-- diretos em `rooms` sem lock real nem checagem de autoridade. Um caminho
-- server-side já existia (pg_cron -> tick_stalled_rooms -> extend_*_or_advance
-- -> advance_writing_to_voting / advance_voting_to_reveal / advance_reveal_to_scoreboard),
-- mas cobria só parte do ciclo: as transições "choosing -> writing" e
-- "scoreboard -> próxima rodada/fim" continuavam 100% client-side e SEM
-- timer nenhum no banco — um coordenador ou host que fecha o navegador
-- nesses dois pontos trava a sala indefinidamente (só o cleanup de 30min
-- resolve). Esta migration:
--
--   1) Fecha essas duas lacunas com RPCs atômicas + cobertura no cron.
--   2) Resolve a divergência de pontuação do bônus de equivalência semântica
--      (hoje só aplicado no caminho client; perdido silenciosamente quando
--      o cron vence a corrida de pontuação).
--   3) Tranca a escrita direta de `rooms` no client a UPDATE de host_id
--      apenas (migração de host) — todo o resto passa a exigir as RPCs
--      SECURITY DEFINER abaixo.
--
-- ATENÇÃO — passo manual necessário após aplicar esta migration:
--   O bônus de similaridade agora é disparado de dentro do Postgres via
--   pg_net, então a função abaixo precisa saber a URL do projeto e uma key
--   para chamar a edge function. Configure (Dashboard > Database > Custom
--   Postgres config, ou via SQL como superuser):
--     ALTER DATABASE postgres SET app.settings.supabase_url = 'https://<project-ref>.supabase.co';
--     ALTER DATABASE postgres SET app.settings.supabase_anon_key = '<anon-key>';
--   Sem isso, a transição de fase continua funcionando normalmente — só o
--   bônus de IA fica pulado (mesmo comportamento de falha silenciosa que já
--   existia no caminho client quando a edge function não respondia).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------- 1) choose_word: escolha humana, agora atômica ----------
CREATE OR REPLACE FUNCTION public.choose_word(
  p_room_id uuid,
  p_word_id uuid,
  p_duration_sec int DEFAULT 60
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found'); END IF;
  IF v_room.status <> 'choosing' THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state'); END IF;
  IF v_room.current_word_id IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'already_chosen'); END IF;

  UPDATE public.rooms
  SET status = 'writing',
      current_word_id = p_word_id,
      used_word_ids = CASE
        WHEN p_word_id = ANY(used_word_ids) THEN used_word_ids
        ELSE array_append(used_word_ids, p_word_id)
      END,
      round_phase_ends_at = now() + make_interval(secs => p_duration_sec),
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.choose_word(uuid, uuid, int) TO anon, authenticated;

-- ---------- 2) advance_choosing_to_writing: backstop do cron ----------
-- Sorteia uma palavra automaticamente se ninguém escolheu dentro do prazo
-- (coordenador ausente/AFK). Antes desta migration, a fase "choosing" não
-- tinha round_phase_ends_at nenhum, então este caso travava a sala.
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

  SELECT * INTO v_word FROM public.get_random_words(v_room.used_word_ids, 2, 1, v_room.categories) LIMIT 1;
  IF v_word IS NULL THEN
    -- Sem palavras elegíveis (categorias esgotadas): dá mais 60s antes de tentar de novo.
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

-- ---------- 3) start_shuffling: idem, só para fechar a RLS de rooms ----------
CREATE OR REPLACE FUNCTION public.start_shuffling(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
BEGIN
  UPDATE public.rooms SET status = 'shuffling'
  WHERE id = p_room_id AND status = 'writing'
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', v_id IS NOT NULL);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.start_shuffling(uuid) TO anon, authenticated;

-- ---------- 4) start_game: reset + início atômico ----------
CREATE OR REPLACE FUNCTION public.start_game(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_min_count int;
  v_next_coordinator text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found'); END IF;
  IF v_room.status <> 'lobby' THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state'); END IF;

  UPDATE public.players
  SET score = 0, coordinator_count = 0, writing_extensions = 0, voting_extensions = 0
  WHERE room_id = p_room_id;
  DELETE FROM public.definitions WHERE room_id = p_room_id;
  DELETE FROM public.votes WHERE room_id = p_room_id;
  DELETE FROM public.rounds WHERE room_id = p_room_id;

  SELECT min(coordinator_count) INTO v_min_count
  FROM public.players WHERE room_id = p_room_id AND kicked_at IS NULL;
  SELECT id INTO v_next_coordinator FROM public.players
  WHERE room_id = p_room_id AND kicked_at IS NULL AND coordinator_count = v_min_count
  ORDER BY random() LIMIT 1;

  UPDATE public.rooms
  SET status = 'choosing',
      current_round = 1,
      current_coordinator = v_next_coordinator,
      current_word_id = NULL,
      round_phase_ends_at = now() + interval '60 seconds',
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true, 'coordinator', v_next_coordinator);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.start_game(uuid) TO anon, authenticated;

-- ---------- 5) finish_reveal: transição deliberada reveal -> scoreboard/finished ----------
-- Chamada pelo client ao fim da animação de revelação (client controla o
-- timing visual). Diferente de advance_reveal_to_scoreboard (que só existe
-- como rede de segurança do cron, com uma janela de 35s pra nunca competir
-- com o client), esta roda sem espera — é sempre uma chamada intencional.
CREATE OR REPLACE FUNCTION public.finish_reveal(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_max_score int;
  v_status text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'reveal' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;

  IF v_room.mode = 'teams' AND jsonb_array_length(v_room.teams) > 0 THEN
    SELECT COALESCE(MAX(team_total), 0) INTO v_max_score FROM (
      SELECT COALESCE(SUM(p.score), 0) AS team_total
      FROM jsonb_array_elements(v_room.teams) t
      LEFT JOIN public.players p ON p.room_id = p_room_id AND p.team_id = t->>'id'
      GROUP BY t->>'id'
    ) totals;
  ELSE
    SELECT COALESCE(MAX(score), 0) INTO v_max_score FROM public.players WHERE room_id = p_room_id;
  END IF;

  v_status := CASE
    WHEN v_room.win_condition = 'score' AND v_max_score >= v_room.win_target THEN 'finished'
    ELSE 'scoreboard'
  END;

  UPDATE public.rooms
  SET status = v_status,
      round_phase_ends_at = CASE WHEN v_status = 'scoreboard' THEN now() + interval '25 seconds' ELSE NULL END
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.finish_reveal(uuid) TO anon, authenticated;

-- ---------- 6) advance_scoreboard_to_next_round_or_finished ----------
-- p_force = true: chamada deliberada do host clicando "próxima rodada"
--   (ignora o timer, sempre avança na hora).
-- p_force = false (default): usada pelo cron, respeita round_phase_ends_at
--   setado por finish_reveal/advance_reveal_to_scoreboard (25s de "hold").
CREATE OR REPLACE FUNCTION public.advance_scoreboard_to_next_round_or_finished(
  p_room_id uuid,
  p_force boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_max_score int;
  v_everyone_coordinated_twice boolean;
  v_won boolean;
  v_min_count int;
  v_next_coordinator text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'scoreboard' THEN RETURN jsonb_build_object('action', 'noop'); END IF;

  IF NOT p_force AND (v_room.round_phase_ends_at IS NULL OR v_room.round_phase_ends_at > now()) THEN
    RETURN jsonb_build_object('action', 'noop_grace');
  END IF;

  IF v_room.mode = 'teams' AND jsonb_array_length(v_room.teams) > 0 THEN
    SELECT COALESCE(MAX(team_total), 0) INTO v_max_score FROM (
      SELECT COALESCE(SUM(p.score), 0) AS team_total
      FROM jsonb_array_elements(v_room.teams) t
      LEFT JOIN public.players p ON p.room_id = p_room_id AND p.team_id = t->>'id'
      GROUP BY t->>'id'
    ) totals;
  ELSE
    SELECT COALESCE(MAX(score), 0) INTO v_max_score FROM public.players WHERE room_id = p_room_id;
  END IF;

  SELECT NOT EXISTS (
    SELECT 1 FROM public.players WHERE room_id = p_room_id AND kicked_at IS NULL AND coordinator_count < 2
  ) INTO v_everyone_coordinated_twice;

  v_won := (v_room.win_condition = 'score' AND v_max_score >= v_room.win_target)
        OR (v_room.win_condition = 'rounds' AND v_everyone_coordinated_twice);

  IF v_won THEN
    UPDATE public.rooms SET status = 'finished', round_phase_ends_at = NULL WHERE id = p_room_id;
    RETURN jsonb_build_object('action', 'finished');
  END IF;

  SELECT min(coordinator_count) INTO v_min_count
  FROM public.players
  WHERE room_id = p_room_id AND kicked_at IS NULL AND id <> COALESCE(v_room.current_coordinator, '');
  IF v_min_count IS NULL THEN
    SELECT min(coordinator_count) INTO v_min_count
    FROM public.players WHERE room_id = p_room_id AND kicked_at IS NULL;
  END IF;

  SELECT id INTO v_next_coordinator FROM public.players
  WHERE room_id = p_room_id AND kicked_at IS NULL AND coordinator_count = v_min_count
    AND id <> COALESCE(v_room.current_coordinator, '')
  ORDER BY random() LIMIT 1;
  IF v_next_coordinator IS NULL THEN
    SELECT id INTO v_next_coordinator FROM public.players
    WHERE room_id = p_room_id AND kicked_at IS NULL AND coordinator_count = v_min_count
    ORDER BY random() LIMIT 1;
  END IF;

  UPDATE public.rooms
  SET status = 'choosing',
      current_round = v_room.current_round + 1,
      current_coordinator = v_next_coordinator,
      current_word_id = NULL,
      round_phase_ends_at = now() + interval '60 seconds',
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('action', 'next_round', 'coordinator', v_next_coordinator);
END;
$function$;

GRANT EXECUTE ON FUNCTION public.advance_scoreboard_to_next_round_or_finished(uuid, boolean) TO anon, authenticated;

-- ---------- 7) apply_similarity_bonus: chamada exclusiva da edge function ----------
-- Aplica o near_truth=true + score+3 de forma atômica. Só service_role pode
-- chamar (nunca client), senão qualquer jogador se auto-concederia o bônus.
CREATE OR REPLACE FUNCTION public.apply_similarity_bonus(p_definition_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
BEGIN
  IF p_definition_ids IS NULL OR array_length(p_definition_ids, 1) IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'bumped', 0);
  END IF;

  UPDATE public.definitions SET near_truth = true
  WHERE id = ANY(p_definition_ids) AND near_truth IS DISTINCT FROM true;

  WITH bumped AS (
    UPDATE public.players p
    SET score = p.score + 3
    FROM public.definitions d
    WHERE d.id = ANY(p_definition_ids) AND d.player_id = p.id
    RETURNING p.id
  )
  SELECT count(*) INTO v_count FROM bumped;

  RETURN jsonb_build_object('ok', true, 'bumped', v_count);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.apply_similarity_bonus(uuid[]) FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.apply_similarity_bonus(uuid[]) TO service_role;

-- ---------- 8) advance_voting_to_reveal: agora dispara o bônus de IA ----------
-- Mesma lógica de pontuação-base de antes; a única mudança é o bloco final
-- que chama a edge function score-similarity via pg_net (fire-and-forget).
-- Isso resolve a divergência: antes só o caminho client (revealAndScore)
-- aplicava o bônus; agora quem vencer a corrida do INSERT em `rounds` —
-- client OU cron — dispara o mesmo bônus.
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
    UPDATE public.players p SET score = p.score + 3
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
    UPDATE public.players SET score = score + r.votes WHERE id = r.player_id;
  END LOOP;

  IF v_truth_voters = 0 AND v_total_votes > 0 AND v_room.current_coordinator IS NOT NULL THEN
    UPDATE public.players SET score = score + 2 WHERE id = v_room.current_coordinator;
  END IF;

  IF v_room.current_coordinator IS NOT NULL THEN
    UPDATE public.players SET coordinator_count = coordinator_count + 1
    WHERE id = v_room.current_coordinator;
  END IF;

  UPDATE public.rooms SET status = 'reveal' WHERE id = p_room_id;

  BEGIN
    v_base_url := current_setting('app.settings.supabase_url', true);
    v_anon_key := current_setting('app.settings.supabase_anon_key', true);
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
      RAISE WARNING 'advance_voting_to_reveal: app.settings.supabase_url/supabase_anon_key não configurados — bônus de similaridade pulado nesta rodada';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'advance_voting_to_reveal: falha ao chamar score-similarity via pg_net: %', SQLERRM;
  END;
END;
$function$;

-- ---------- 9) tick_stalled_rooms: cobre choosing e scoreboard também ----------
CREATE OR REPLACE FUNCTION public.tick_stalled_rooms()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  r record;
  v_count int := 0;
  v_clean jsonb;
BEGIN
  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'choosing'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.advance_choosing_to_writing(r.id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'writing'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.extend_writing_or_advance(r.id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'voting'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.advance_voting_to_reveal(r.id);
    v_count := v_count + 1;
  END LOOP;

  FOR r IN
    SELECT ro.id FROM public.rooms ro WHERE ro.status = 'reveal'
  LOOP
    PERFORM public.advance_reveal_to_scoreboard(r.id);
  END LOOP;

  FOR r IN
    SELECT id FROM public.rooms
    WHERE status = 'scoreboard'
      AND round_phase_ends_at IS NOT NULL
      AND round_phase_ends_at < now() - interval '3 seconds'
  LOOP
    PERFORM public.advance_scoreboard_to_next_round_or_finished(r.id, false);
    v_count := v_count + 1;
  END LOOP;

  v_clean := public.cleanup_zombie_rooms();

  RETURN jsonb_build_object('advanced', v_count, 'cleanup', v_clean, 'at', now());
END;
$$;

-- ---------- 10) Tranca a escrita direta em rooms ----------
-- Só o campo host_id continua gravável direto pelo client (migração de
-- host, já feita com guarda otimista .eq("host_id", expected)). Todo o
-- resto do ciclo de vida da sala passa a exigir as RPCs SECURITY DEFINER
-- acima, que rodam como dono da função e não são afetadas por este REVOKE.
REVOKE UPDATE ON public.rooms FROM anon, authenticated;
GRANT UPDATE (host_id) ON public.rooms TO anon, authenticated;
