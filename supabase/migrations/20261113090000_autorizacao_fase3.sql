-- =============================================================================
-- Fase 3 de privacidade/integridade das salas (13/11/2026): AUTORIZAÇÃO das
-- RPCs que mudam o estado da partida.
--
-- Problema (Red Team da fase 2, P1-2; CONFIRMADO no catálogo de produção):
-- 8 RPCs SECURITY DEFINER, executáveis por anon/authenticated, mudavam a
-- partida sem conferir QUEM chama — bastava o room_id:
--   choose_word, start_shuffling, advance_writing_to_voting,
--   extend_writing_or_advance, advance_voting_to_reveal,
--   extend_voting_or_advance, finish_reveal,
--   advance_scoreboard_to_next_round_or_finished
-- Sem prazo nenhum como proteção: choose_word (escolher a palavra no lugar do
-- coordenador), finish_reveal (cortar a revelação) e o placar com
-- p_force = true (pular para a próxima rodada). As demais já tinham guardas
-- de estado/prazo (quórum, carência, gatilho de escrita), mas qualquer um
-- podia dispará-las.
--
-- Regra (mesma definição de participante do #74/#75 — linha em players da
-- sala com user_id = auth.uid() —, mas SEM expulso, que não joga):
--   • chamada interna (cron tick_stalled_rooms, service_role, SQL do dono,
--     edges) = papel ≠ anon/authenticated → inalterada;
--   • sem sessão, sessão de fora ou expulso → MESMA resposta de "sala
--     inexistente" de cada RPC (sem oráculo de existência), sem travar a sala;
--   • participante ativo (humano, kicked_at IS NULL):
--       - avanços por prazo/quórum (start_shuffling, advance_writing_to_voting,
--         extend_*, advance_voting_to_reveal, placar SEM p_force): qualquer um
--         — é o "quem estiver na sala avança quando o prazo acaba" do cliente
--         (host, deputy e, na votação, qualquer cliente) e as guardas de
--         estado/prazo de cada RPC continuam valendo;
--       - choose_word: só o coordenador da rodada; se o coordenador é BOT,
--         qualquer participante (o host escolhe por ele e os demais cobrem —
--         room.$code.tsx). Resposta: {ok:false, reason:'not_authorized'};
--       - finish_reveal e placar COM p_force = true: só o host (é o único que
--         o app chama: Reveal.tsx / Scoreboard.tsx). Resposta not_authorized;
--         sem host, o cron segue como hoje (advance_reveal_to_scoreboard e o
--         placar sem p_force, que qualquer participante também pode chamar).
--   • choose_word também passa a limitar p_duration_sec a 30–120 s (o app
--     manda sempre 60): antes um valor negativo vencia a escrita na hora e
--     a prorrogação tirava 1 ponto de todos os pendentes.
-- Corpos: os de produção (master 90a82b5) byte a byte + só as linhas
-- marcadas "Fase 3". Assinaturas, retornos, SECURITY DEFINER, search_path e
-- ACL não mudam (CREATE OR REPLACE preserva a ACL).
--
-- Independente do #74 (20261112110000) e do #75 (20261112120000): nenhum
-- objeto em comum; vale em qualquer ordem com eles (testado no isolado:
-- master + esta e master + #74 + #75 + esta).
-- Rollback: supabase/rollback/autorizacao_fase3.sql (antes de qualquer
-- rollback do M1).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) Funções auxiliares (não executáveis pela API).
-- -----------------------------------------------------------------------------

-- 'internal' = chamada fora da API (cron/service_role/dono); 'participant' =
-- sessão com linha ATIVA (humana, não expulsa) na sala; NULL = sem sessão,
-- de fora, expulso ou sala inexistente (indistinguíveis de propósito).
CREATE OR REPLACE FUNCTION public.room_actor_gate(p_room_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN COALESCE(current_setting('role', true), '') NOT IN ('anon', 'authenticated') THEN 'internal'
    WHEN auth.uid() IS NULL THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM public.players p
       WHERE p.room_id = p_room_id
         AND p.user_id = auth.uid()
         AND p.kicked_at IS NULL
         AND NOT p.is_bot
    ) THEN 'participant'
  END;
$$;

-- O jogador p_player_id (ativo, humano, desta sala) é da sessão que chama?
-- Chamada interna: sempre true.
CREATE OR REPLACE FUNCTION public.room_actor_is(p_room_id uuid, p_player_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(current_setting('role', true), '') NOT IN ('anon', 'authenticated')
      OR (auth.uid() IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.players p
             WHERE p.id = p_player_id
               AND p.room_id = p_room_id
               AND p.user_id = auth.uid()
               AND p.kicked_at IS NULL
               AND NOT p.is_bot));
$$;

REVOKE ALL ON FUNCTION public.room_actor_gate(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.room_actor_is(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.room_actor_gate(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.room_actor_is(uuid, text) TO service_role;

-- -----------------------------------------------------------------------------
-- 2) choose_word: só o coordenador (ou qualquer participante se ele é bot).
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 3) start_shuffling: qualquer participante (guarda atômica + gatilho seguem).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_shuffling(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
BEGIN
  -- Fase 3 (13/11/2026): sem sessão / de fora / expulso = a resposta de sala inexistente
  IF public.room_actor_gate(p_room_id) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;
  UPDATE public.rooms SET status = 'shuffling'
  WHERE id = p_room_id AND status = 'writing'
  RETURNING status INTO v_status;
  -- RETURNING enxerga a linha DEPOIS do gatilho guard_writing_phase_advance,
  -- que mantém a sala em 'writing' quando ainda falta definição de humano.
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;
  IF v_status <> 'shuffling' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'pending_players');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- -----------------------------------------------------------------------------
-- 4) advance_writing_to_voting: qualquer participante (re-checa pendentes).
-- -----------------------------------------------------------------------------
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
  -- Fase 3 (13/11/2026): sem sessão / de fora / expulso = no-op (como sala inexistente)
  IF public.room_actor_gate(p_room_id) IS NULL THEN RETURN; END IF;
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
    -- SM-01: em 'shuffling' o pendente não consegue mais enviar — devolve a
    -- sala a 'writing' com os mesmos prazos (o gatilho de guarda só atua na
    -- saída de 'writing', não nesta volta).
    IF v_room.status = 'shuffling' THEN
      UPDATE public.rooms SET status = 'writing' WHERE id = p_room_id;
    END IF;
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
      round_phase_ends_at = now() + make_interval(secs => public.phase_secs(p_room_id, 30)),
      phase_started_at = now()
  WHERE id = p_room_id;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 5) extend_writing_or_advance: qualquer participante (carência de 2 s segue).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.extend_writing_or_advance(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_pending record;
  v_extended boolean := false;
  v_extension_seconds int := 0;
  v_kicked text[] := ARRAY[]::text[];
  v_extended_players text[] := ARRAY[]::text[];
BEGIN
  -- Fase 3 (13/11/2026): sem sessão / de fora / expulso = a resposta de sala inexistente
  IF public.room_actor_gate(p_room_id) IS NULL THEN
    RETURN jsonb_build_object('action', 'noop');
  END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'writing' THEN
    RETURN jsonb_build_object('action', 'noop');
  END IF;

  IF v_room.round_phase_ends_at IS NOT NULL
     AND v_room.round_phase_ends_at > now() - interval '2 seconds' THEN
    RETURN jsonb_build_object('action', 'noop_grace');
  END IF;

  -- Pausa (playtest 2026-10-21): sala pausada não prorroga, não expulsa nem
  -- avança; e se nenhum humano está presente, ela pausa agora em vez de
  -- punir quem saiu (antes: −1, −1 e expulsão em ~95 s).
  IF v_room.paused_at IS NOT NULL THEN
    RETURN jsonb_build_object('action', 'paused');
  END IF;
  IF public.room_pause_due(p_room_id) THEN
    UPDATE public.rooms SET paused_at = now() WHERE id = p_room_id;
    INSERT INTO public.ops_events (kind, payload)
    VALUES ('room_paused', jsonb_build_object('room_id', p_room_id, 'status', v_room.status, 'by', 'deadline'));
    RETURN jsonb_build_object('action', 'paused');
  END IF;

  UPDATE public.players p
    SET writing_extensions = 0
    WHERE p.room_id = p_room_id
      AND p.kicked_at IS NULL
      AND p.is_bot = false
      AND p.writing_extensions > 0
      AND EXISTS (
        SELECT 1 FROM public.definitions d
        WHERE d.room_id = p_room_id
          AND d.round = v_room.current_round
          AND d.player_id = p.id
      );

  FOR v_pending IN
    SELECT p.id, p.writing_extensions
    FROM public.players p
    WHERE p.room_id = p_room_id
      AND p.is_bot = false
      AND p.kicked_at IS NULL
      AND p.id <> COALESCE(v_room.current_coordinator, '')
      AND (v_room.phase_started_at IS NULL
           OR p.joined_at <= v_room.phase_started_at + interval '3 seconds')
      AND NOT EXISTS (
        SELECT 1 FROM public.definitions d
        WHERE d.room_id = p_room_id
          AND d.round = v_room.current_round
          AND d.player_id = p.id
      )
  LOOP
    IF v_pending.writing_extensions < 2 THEN
      UPDATE public.players
        SET score = GREATEST(score - 1, 0),
            writing_extensions = writing_extensions + 1,
            is_connected = true
        WHERE id = v_pending.id;

      INSERT INTO public.round_extensions (room_id, round, player_id, attempt, phase)
      VALUES (p_room_id, v_room.current_round, v_pending.id, v_pending.writing_extensions + 1, 'writing')
      ON CONFLICT DO NOTHING;

      v_extended := true;
      v_extended_players := array_append(v_extended_players, v_pending.id);
      v_extension_seconds := GREATEST(
        v_extension_seconds,
        CASE WHEN v_pending.writing_extensions = 0 THEN 20 ELSE 15 END
      );
    ELSE
      UPDATE public.players
        SET kicked_at = now(),
            is_connected = false
        WHERE id = v_pending.id;
      v_kicked := array_append(v_kicked, v_pending.id);
    END IF;
  END LOOP;

  IF v_extended THEN
    -- prorrogação da escrita fixa (20 s / 15 s), sem escalar com a sala
    -- (2026-10-25; antes phase_secs: 40 s / 30 s com 12 jogadores)
    UPDATE public.rooms
      SET round_phase_ends_at = now() + make_interval(secs => v_extension_seconds),
          phase_started_at = now()
      WHERE id = p_room_id;
    RETURN jsonb_build_object(
      'action', 'extended',
      'seconds', v_extension_seconds,
      'extended_players', to_jsonb(v_extended_players),
      'kicked', to_jsonb(v_kicked)
    );
  END IF;

  PERFORM public.advance_writing_to_voting(p_room_id);
  RETURN jsonb_build_object(
    'action', 'advanced',
    'kicked', to_jsonb(v_kicked)
  );
END;
$function$;

-- -----------------------------------------------------------------------------
-- 6) advance_voting_to_reveal: qualquer participante (quórum + prazo seguem).
-- -----------------------------------------------------------------------------
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
  -- Fase 3 (13/11/2026): sem sessão / de fora / expulso = no-op (como sala inexistente)
  IF public.room_actor_gate(p_room_id) IS NULL THEN RETURN; END IF;
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

  -- 🧠 (2026-10-21): o disparo foi para fire_round_judge — prazo de 20 s no
  -- pg_net (o padrão de 5 s cortava a edge, que pode levar até ~17 s) e o id
  -- da requisição guardado na rodada para o reenvio (retry_round_judgments).
  BEGIN
    PERFORM public.fire_round_judge(p_room_id, v_room.current_round);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'advance_voting_to_reveal: falha ao chamar score-similarity via pg_net: %', SQLERRM;
  END;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 7) extend_voting_or_advance: qualquer participante (carência de 2 s segue).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.extend_voting_or_advance(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_pending record;
  v_extended boolean := false;
  v_extension_seconds int := 0;
  v_kicked text[] := ARRAY[]::text[];
  v_extended_players text[] := ARRAY[]::text[];
BEGIN
  -- Fase 3 (13/11/2026): sem sessão / de fora / expulso = a resposta de sala inexistente
  IF public.room_actor_gate(p_room_id) IS NULL THEN
    RETURN jsonb_build_object('action', 'noop');
  END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'voting' THEN
    RETURN jsonb_build_object('action', 'noop');
  END IF;

  IF v_room.round_phase_ends_at IS NOT NULL
     AND v_room.round_phase_ends_at > now() - interval '2 seconds' THEN
    RETURN jsonb_build_object('action', 'noop_grace');
  END IF;

  -- Pausa (playtest 2026-10-21): sala pausada não prorroga, não expulsa nem
  -- avança; e se nenhum humano está presente, ela pausa agora em vez de
  -- punir quem saiu (antes: −1, −1 e expulsão em ~95 s).
  IF v_room.paused_at IS NOT NULL THEN
    RETURN jsonb_build_object('action', 'paused');
  END IF;
  IF public.room_pause_due(p_room_id) THEN
    UPDATE public.rooms SET paused_at = now() WHERE id = p_room_id;
    INSERT INTO public.ops_events (kind, payload)
    VALUES ('room_paused', jsonb_build_object('room_id', p_room_id, 'status', v_room.status, 'by', 'deadline'));
    RETURN jsonb_build_object('action', 'paused');
  END IF;

  UPDATE public.players p
    SET voting_extensions = 0
    WHERE p.room_id = p_room_id
      AND p.kicked_at IS NULL
      AND p.is_bot = false
      AND p.voting_extensions > 0
      AND EXISTS (
        SELECT 1 FROM public.votes v
        WHERE v.room_id = p_room_id
          AND v.round = v_room.current_round
          AND v.voter_id = p.id
      );

  FOR v_pending IN
    SELECT p.id, p.voting_extensions
    FROM public.players p
    WHERE p.room_id = p_room_id
      AND p.is_bot = false
      AND p.kicked_at IS NULL
      AND (v_room.phase_started_at IS NULL
           OR p.joined_at <= v_room.phase_started_at + interval '3 seconds')
      AND NOT EXISTS (
        SELECT 1 FROM public.votes v
        WHERE v.room_id = p_room_id
          AND v.round = v_room.current_round
          AND v.voter_id = p.id
      )
  LOOP
    IF v_pending.voting_extensions < 2 THEN
      UPDATE public.players
        SET score = GREATEST(score - 1, 0),
            voting_extensions = voting_extensions + 1,
            is_connected = true
        WHERE id = v_pending.id;

      INSERT INTO public.round_extensions (room_id, round, player_id, attempt, phase)
      VALUES (p_room_id, v_room.current_round, v_pending.id, v_pending.voting_extensions + 1, 'voting')
      ON CONFLICT DO NOTHING;

      v_extended := true;
      v_extended_players := array_append(v_extended_players, v_pending.id);
      v_extension_seconds := GREATEST(
        v_extension_seconds,
        CASE WHEN v_pending.voting_extensions = 0 THEN 20 ELSE 15 END
      );
    ELSE
      UPDATE public.players
        SET score = GREATEST(score - 1, 0),
            voting_extensions = voting_extensions + 1,
            kicked_at = now(),
            is_connected = false
        WHERE id = v_pending.id;

      INSERT INTO public.round_extensions (room_id, round, player_id, attempt, phase)
      VALUES (p_room_id, v_room.current_round, v_pending.id, 3, 'voting')
      ON CONFLICT DO NOTHING;

      v_kicked := array_append(v_kicked, v_pending.id);
    END IF;
  END LOOP;

  IF v_extended THEN
    v_extension_seconds := public.phase_secs(p_room_id, v_extension_seconds);
    UPDATE public.rooms
      SET round_phase_ends_at = now() + make_interval(secs => v_extension_seconds),
          phase_started_at = now()
      WHERE id = p_room_id;
    RETURN jsonb_build_object(
      'action', 'extended',
      'seconds', v_extension_seconds,
      'extended_players', to_jsonb(v_extended_players),
      'kicked', to_jsonb(v_kicked)
    );
  END IF;

  RETURN jsonb_build_object(
    'action', 'advanced',
    'kicked', to_jsonb(v_kicked)
  );
END;
$function$;

-- -----------------------------------------------------------------------------
-- 8) finish_reveal: só o host (o cron cobre a falta dele).
-- -----------------------------------------------------------------------------
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
  -- Fase 3 (13/11/2026): quem chama — antes de travar a sala
  v_gate text := public.room_actor_gate(p_room_id);
BEGIN
  -- Fase 3: sem sessão / de fora / expulso = a resposta de sala inexistente
  IF v_gate IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'reveal' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;
  -- Fase 3: encerrar a revelação é do host (Reveal.tsx); sem ele, o cron
  IF NOT public.room_actor_is(p_room_id, v_room.host_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
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
      round_phase_ends_at = CASE WHEN v_status = 'scoreboard' THEN now() + interval '120 seconds' ELSE NULL END
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$function$;

-- -----------------------------------------------------------------------------
-- 9) Placar → próxima rodada: p_force = true só o host; sem p_force (prazo
--    vencido), qualquer participante — como o cron.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.advance_scoreboard_to_next_round_or_finished(p_room_id uuid, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_max_score int;
  v_won boolean;
  v_min_count int;
  v_next_coordinator text;
  -- Fase 3 (13/11/2026): quem chama — antes de travar a sala
  v_gate text := public.room_actor_gate(p_room_id);
BEGIN
  -- Fase 3: sem sessão / de fora / expulso = a resposta de sala inexistente
  IF v_gate IS NULL THEN RETURN jsonb_build_object('action', 'noop'); END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'scoreboard' THEN RETURN jsonb_build_object('action', 'noop'); END IF;

  -- Fase 3: pular o placar antes do prazo ("Próxima rodada") é do host
  IF p_force AND NOT public.room_actor_is(p_room_id, v_room.host_id) THEN
    RETURN jsonb_build_object('action', 'noop', 'reason', 'not_authorized');
  END IF;

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

  -- v2: modo 'rounds' = número fixo de rodadas jogadas (win_target).
  -- Modo 'score' segue igual: primeiro a atingir win_target pontos.
  v_won := (v_room.win_condition = 'score' AND v_max_score >= v_room.win_target)
        OR (v_room.win_condition = 'rounds' AND v_room.current_round >= v_room.win_target);

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
      round_phase_ends_at = now() + make_interval(secs => public.phase_secs(p_room_id, 60)),
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('action', 'next_round', 'coordinator', v_next_coordinator);
END;
$function$;
