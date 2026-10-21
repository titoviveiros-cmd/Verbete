-- =============================================================================
-- PAUSA DE PARTIDA (playtest 2026-10-21): partida humana parada não morre.
--
-- Caso real (sala 2246, 21/10, perícia só leitura): 4 humanos pararam para
-- almoçar depois da rodada 3 (último voto humano 16:18:54 UTC). Sozinha, a
-- sala seguiu: o tick abriu a rodada 4, deu 2 prorrogações (−1 cada) a quem
-- não escreveu (16:26 e 16:27), expulsou 3 humanos às 16:28, jogou as
-- rodadas 4–6 com a única humana restante de coordenadora (Cris, 11 pts) e
-- a R4 encerrou a sala (~16:49, finish_reason 'cleanup_idle') — "Cris venceu".
--
-- Regra nova: na hora de PRORROGAR ou AVANÇAR a escrita/votação pelo prazo,
-- se nenhum humano da mesa está presente, a sala PAUSA (rooms.paused_at) em
-- vez de punir e seguir. Placar, rodada, palavra, definições e votos ficam
-- como estão; o tick não mexe em sala pausada; bot não joga sozinho.
-- Escolha da palavra, placar e revelação continuam como antes (não punem
-- ninguém) — a partida para na próxima escrita ou votação.
--
-- Presença (room_presence, só pelas RPCs): o cliente novo chama
-- touch_presence('active') quando o jogador toca no app (máx. 1×/15 s) e
-- quando o app volta à tela, e touch_presence('away') quando o app sai da
-- tela (bloqueio do celular, troca de app). Humano presente = tocou no app
-- no último minuto e não saiu da tela depois disso.
--
-- Retomada: botão "Continuar" (resume_room, qualquer humano ativo da mesa),
-- ou sozinha quando TODOS os humanos ativos voltam (touch_presence), ou
-- qualquer virada de fase. Ao retomar: prazo novo da fase (escrita 60 s,
-- votação 30 s, escalados), contadores de prorrogação zerados, nada
-- avançado de uma vez.
--
-- Compatível com o cliente em produção antes do merge: sala sem nenhuma
-- presença registrada (só cliente antigo) nunca pausa — segue a regra
-- antiga, inclusive a R4. Salas-zumbi continuam limpas: a pausa exige
-- humano ativo na mesa; R4 e "fase parada" ignoram só a sala PAUSADA, que
-- tem TTL de 12 h ('cleanup_paused', não paga XP) ou encerra antes se não
-- sobrar humano ativo ('cleanup_empty').
--
-- ROLLBACK: supabase/rollback/match_pause_resume.sql
-- =============================================================================

ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS paused_at timestamptz;

COMMENT ON COLUMN public.rooms.paused_at IS
  'Partida pausada por ausência de todos os humanos (escrita/votação). NULL = em andamento. Limpo ao retomar ou em qualquer virada de fase.';

CREATE TABLE IF NOT EXISTS public.room_presence (
  player_id text PRIMARY KEY,
  room_id uuid NOT NULL,
  active_at timestamptz NOT NULL DEFAULT now(),
  away_at timestamptz
);
CREATE INDEX IF NOT EXISTS room_presence_room_idx ON public.room_presence (room_id);
ALTER TABLE public.room_presence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.room_presence FROM PUBLIC, anon, authenticated;

-- Motivo novo de encerramento operacional: pausa abandonada (TTL).
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_finish_reason_check;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_finish_reason_check CHECK (
  finish_reason IS NULL
  OR (status = 'finished'
      AND finish_reason IN ('cleanup_stale', 'cleanup_lobby', 'cleanup_empty', 'cleanup_idle', 'cleanup_paused'))
);

-- Qualquer virada de fase encerra a pausa (ex.: todos mandaram a definição
-- durante a pausa e o host abriu o embaralhamento).
CREATE OR REPLACE FUNCTION public.rooms_clear_paused_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.paused_at := NULL;
  -- A fase nova começa agora (sem isso, a regra de "fase parada há 30 min"
  -- encerrava a sala logo depois de uma pausa longa — Red Team 2026-10-21).
  NEW.phase_started_at := now();
  RETURN NEW;
END;
$;

REVOKE ALL ON FUNCTION public.rooms_clear_paused_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rooms_clear_paused_at ON public.rooms;
CREATE TRIGGER rooms_clear_paused_at
BEFORE UPDATE OF status ON public.rooms
FOR EACH ROW
WHEN (NEW.status IS DISTINCT FROM OLD.status AND NEW.paused_at IS NOT NULL)
EXECUTE FUNCTION public.rooms_clear_paused_at();

-- Algum humano da mesa (não expulso, não saiu) está presente: tocou no app
-- DESDE O INÍCIO DESTA FASE — início, prorrogação e retomada renovam
-- phase_started_at, então cada degrau da prorrogação exige um toque novo — e
-- não saiu da tela depois disso. Humano SEM registro de presença é cliente
-- antigo: conta como presente (sala mista segue a regra antiga, nunca congela).
CREATE OR REPLACE FUNCTION public.room_humans_present(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $
  SELECT EXISTS (
    SELECT 1
      FROM public.players p
      JOIN public.rooms r ON r.id = p.room_id
      LEFT JOIN public.room_presence pr ON pr.player_id = p.id AND pr.room_id = p.room_id
     WHERE p.room_id = p_room_id
       AND p.is_bot = false
       AND p.kicked_at IS NULL
       AND p.is_connected = true
       AND (
         pr.player_id IS NULL
         OR (pr.active_at >= COALESCE(r.phase_started_at, now() - interval '60 seconds')
             AND (pr.away_at IS NULL OR pr.away_at < pr.active_at))
       )
  );
$;

REVOKE ALL ON FUNCTION public.room_humans_present(uuid) FROM PUBLIC, anon, authenticated;

-- A pausa é devida? Escrita/votação em que algum humano da mesa ainda DEVE a
-- ação (definição/voto) e nenhum humano está presente. Ninguém devendo nada
-- (só faltam bots) = a fase segue normalmente. Sala só de cliente antigo
-- nunca pausa (room_humans_present conta esse humano como presente).
CREATE OR REPLACE FUNCTION public.room_pause_due(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $
  SELECT r.status IN ('writing', 'voting')
     AND r.paused_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.players p
        WHERE p.room_id = r.id AND p.is_bot = false AND p.kicked_at IS NULL
          AND p.is_connected = true
          AND (r.phase_started_at IS NULL OR p.joined_at <= r.phase_started_at + interval '3 seconds')
          AND (
            (r.status = 'writing'
             AND p.id <> COALESCE(r.current_coordinator, '')
             AND NOT EXISTS (
               SELECT 1 FROM public.definitions d
                WHERE d.room_id = r.id AND d.round = r.current_round AND d.player_id = p.id))
            OR
            (r.status = 'voting'
             AND NOT EXISTS (
               SELECT 1 FROM public.votes v
                WHERE v.room_id = r.id AND v.round = r.current_round AND v.voter_id = p.id))
          )
     )
     AND NOT public.room_humans_present(r.id)
  FROM public.rooms r
  WHERE r.id = p_room_id;
$;

REVOKE ALL ON FUNCTION public.room_pause_due(uuid) FROM PUBLIC, anon, authenticated;

-- Retomada (interna): prazo novo para a fase e registro no ops. Os
-- contadores de prorrogação ficam como estavam: a pausa não aplica degrau
-- nenhum, e zerar faria o ausente perder −1 a cada "Continuar" sem nunca ser
-- dispensado.
CREATE OR REPLACE FUNCTION public.resume_paused_room(p_room_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_room public.rooms;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.paused_at IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.rooms
     SET paused_at = NULL,
         phase_started_at = now(),
         round_phase_ends_at = CASE v_room.status
           WHEN 'writing' THEN now() + make_interval(secs => public.phase_secs(p_room_id, 60))
           WHEN 'voting' THEN now() + make_interval(secs => public.phase_secs(p_room_id, 30))
           ELSE v_room.round_phase_ends_at
         END
   WHERE id = p_room_id;

  INSERT INTO public.ops_events (kind, payload)
  VALUES ('room_resumed', jsonb_build_object(
    'room_id', p_room_id,
    'status', v_room.status,
    'paused_s', floor(extract(epoch FROM now() - v_room.paused_at))::int
  ));
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.resume_paused_room(uuid) FROM PUBLIC, anon, authenticated;

-- Presença do jogador (cliente novo). 'active' = tocou no app / voltou à
-- tela; 'away' = o app saiu da tela. Todos os humanos ativos de volta →
-- a partida pausada retoma sozinha.
CREATE OR REPLACE FUNCTION public.touch_presence(p_room_id uuid, p_player_id text, p_state text DEFAULT 'active')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_reason text;
  v_paused timestamptz;
BEGIN
  IF p_room_id IS NULL OR p_player_id IS NULL OR p_state NOT IN ('active', 'away') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, p_player_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;

  IF p_state = 'active' THEN
    INSERT INTO public.room_presence (player_id, room_id, active_at, away_at)
    VALUES (p_player_id, p_room_id, now(), NULL)
    ON CONFLICT (player_id) DO UPDATE
      SET room_id = EXCLUDED.room_id, active_at = now(), away_at = NULL;
  ELSE
    INSERT INTO public.room_presence (player_id, room_id, active_at, away_at)
    VALUES (p_player_id, p_room_id, now(), now())
    ON CONFLICT (player_id) DO UPDATE
      SET room_id = EXCLUDED.room_id, away_at = now();
  END IF;

  SELECT paused_at INTO v_paused FROM public.rooms WHERE id = p_room_id;
  IF p_state = 'active' AND v_paused IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.players p
        WHERE p.room_id = p_room_id AND p.is_bot = false AND p.kicked_at IS NULL
          AND p.is_connected = true
          AND NOT EXISTS (
            SELECT 1 FROM public.room_presence pr
             WHERE pr.player_id = p.id AND pr.room_id = p_room_id
               AND pr.active_at > now() - interval '60 seconds'
               AND (pr.away_at IS NULL OR pr.away_at < pr.active_at)
          )
     ) THEN
    RETURN jsonb_build_object('ok', true, 'resumed', public.resume_paused_room(p_room_id));
  END IF;

  RETURN jsonb_build_object('ok', true, 'paused', v_paused IS NOT NULL);
END;
$$;

REVOKE ALL ON FUNCTION public.touch_presence(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.touch_presence(uuid, text, text) TO anon, authenticated, service_role;

-- Botão "Continuar": qualquer humano ativo (não expulso) da mesa retoma.
CREATE OR REPLACE FUNCTION public.resume_room(p_room_id uuid, p_player_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_reason text;
  v_player public.players;
BEGIN
  IF p_room_id IS NULL OR p_player_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, p_player_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;
  SELECT * INTO v_player FROM public.players WHERE id = p_player_id AND room_id = p_room_id;
  IF v_player.id IS NULL OR v_player.is_bot OR v_player.kicked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_active_player');
  END IF;

  -- Quem toca em Continuar está presente.
  INSERT INTO public.room_presence (player_id, room_id, active_at, away_at)
  VALUES (p_player_id, p_room_id, now(), NULL)
  ON CONFLICT (player_id) DO UPDATE
    SET room_id = EXCLUDED.room_id, active_at = now(), away_at = NULL;

  RETURN jsonb_build_object('ok', true, 'resumed', public.resume_paused_room(p_room_id));
END;
$$;

REVOKE ALL ON FUNCTION public.resume_room(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resume_room(uuid, text) TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Atividade humana da R4: corpo de 20261019002735 + presença
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.room_last_human_activity(p_room_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT GREATEST(
    (SELECT r.created_at FROM public.rooms r WHERE r.id = p_room_id),
    (SELECT max(p.joined_at) FROM public.players p
      WHERE p.room_id = p_room_id AND p.is_bot = false),
    (SELECT max(d.created_at) FROM public.definitions d
       JOIN public.players p ON p.id = d.player_id AND p.is_bot = false
      WHERE d.room_id = p_room_id AND d.is_truth = false),
    (SELECT max(v.created_at) FROM public.votes v
       JOIN public.players p ON p.id = v.voter_id AND p.is_bot = false
      WHERE v.room_id = p_room_id),
    (SELECT max(m.created_at) FROM public.room_messages m
       JOIN public.players p ON p.id = m.player_id AND p.is_bot = false
      WHERE m.room_id = p_room_id),
    (SELECT max(x.created_at) FROM public.reactions x
       JOIN public.players p ON p.id = x.player_id AND p.is_bot = false
      WHERE x.room_id = p_room_id),
    (SELECT max(d.created_at) FROM public.definitions d
      WHERE d.room_id = p_room_id AND d.is_truth = true AND d.round = 1),
    -- Pausa (2026-10-21): tocar no app é atividade humana — sem isto a R4
    -- encerrava a partida logo depois de retomada uma pausa de 30+ min.
    (SELECT max(pr.active_at) FROM public.room_presence pr
       JOIN public.players p ON p.id = pr.player_id AND p.room_id = pr.room_id
                            AND p.is_bot = false AND p.kicked_at IS NULL
      WHERE pr.room_id = p_room_id)
  );
$$;

REVOKE ALL ON FUNCTION public.room_last_human_activity(uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Gatilho do avanço da escrita: corpo de 20260720100000 + respeita a pausa
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_writing_phase_advance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pending record;
  v_has_pending boolean := false;
  v_extended boolean := false;
  v_now timestamptz := now();
BEGIN
  IF OLD.status = 'writing'
     AND NEW.status IN ('shuffling', 'voting')
     AND NEW.current_round = OLD.current_round THEN

    -- Pausa (2026-10-21): sala pausada — ou com a mesa inteira fora agora —
    -- não pune nem expulsa quem falta escrever; segura a escrita (e pausa).
    IF (OLD.paused_at IS NOT NULL OR public.room_pause_due(OLD.id))
       AND EXISTS (
         SELECT 1 FROM public.players p
          WHERE p.room_id = OLD.id AND p.is_bot = false AND p.kicked_at IS NULL
            AND p.id <> COALESCE(OLD.current_coordinator, '')
            AND (OLD.phase_started_at IS NULL OR p.joined_at <= OLD.phase_started_at + interval '3 seconds')
            AND NOT EXISTS (
              SELECT 1 FROM public.definitions d
               WHERE d.room_id = OLD.id AND d.round = OLD.current_round AND d.player_id = p.id)
       ) THEN
      NEW.status := 'writing';
      NEW.current_round := OLD.current_round;
      NEW.current_word_id := OLD.current_word_id;
      NEW.current_coordinator := OLD.current_coordinator;
      NEW.used_word_ids := OLD.used_word_ids;
      NEW.phase_started_at := OLD.phase_started_at;
      NEW.round_phase_ends_at := OLD.round_phase_ends_at;
      IF OLD.paused_at IS NULL THEN
        NEW.paused_at := now();
        INSERT INTO public.ops_events (kind, payload)
        VALUES ('room_paused', jsonb_build_object('room_id', OLD.id, 'status', 'writing', 'by', 'advance'));
      END IF;
      RETURN NEW;
    END IF;

    FOR v_pending IN
      SELECT p.id, p.writing_extensions
      FROM public.players p
      WHERE p.room_id = OLD.id
        AND p.is_bot = false
        AND p.kicked_at IS NULL
        AND p.id <> COALESCE(OLD.current_coordinator, '')
        AND (OLD.phase_started_at IS NULL OR p.joined_at <= OLD.phase_started_at + interval '3 seconds')
        AND NOT EXISTS (
          SELECT 1
          FROM public.definitions d
          WHERE d.room_id = OLD.id
            AND d.round = OLD.current_round
            AND d.player_id = p.id
        )
    LOOP
      v_has_pending := true;

      IF OLD.round_phase_ends_at IS NOT NULL
         AND OLD.round_phase_ends_at <= v_now THEN
        IF v_pending.writing_extensions < 2 THEN
          UPDATE public.players
          SET score = GREATEST(score - 1, 0),
              writing_extensions = writing_extensions + 1,
              is_connected = true
          WHERE id = v_pending.id;

          INSERT INTO public.round_extensions (room_id, round, player_id, attempt)
          VALUES (OLD.id, OLD.current_round, v_pending.id, v_pending.writing_extensions + 1)
          ON CONFLICT DO NOTHING;

          v_extended := true;
        ELSE
          UPDATE public.players
          SET score = GREATEST(score - 1, 0),
              kicked_at = v_now,
              is_connected = false
          WHERE id = v_pending.id;
        END IF;
      END IF;
    END LOOP;

    IF v_has_pending THEN
      NEW.status := 'writing';
      NEW.current_round := OLD.current_round;
      NEW.current_word_id := OLD.current_word_id;
      NEW.current_coordinator := OLD.current_coordinator;
      NEW.used_word_ids := OLD.used_word_ids;
      NEW.phase_started_at := CASE WHEN v_extended THEN v_now ELSE OLD.phase_started_at END;
      NEW.round_phase_ends_at := CASE WHEN v_extended THEN v_now + interval '20 seconds' ELSE OLD.round_phase_ends_at END;
      RETURN NEW;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.guard_writing_phase_advance() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Prorrogação de escrita/votação: corpos de 20260727120000 + guarda de pausa
-- ---------------------------------------------------------------------------
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

  PERFORM public.advance_writing_to_voting(p_room_id);
  RETURN jsonb_build_object(
    'action', 'advanced',
    'kicked', to_jsonb(v_kicked)
  );
END;
$function$;

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

-- ---------------------------------------------------------------------------
-- Tick: corpo de 20261003120000 + pula pausada e pausa escrita/votação
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tick_stalled_rooms()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_t0 timestamptz := clock_timestamp();
  v_res jsonb;
  v_after text;
  v_advanced int := 0;
  v_extended int := 0;
  v_by_phase jsonb := '{}'::jsonb;
  v_hosts int := 0;
  v_errors int := 0;
  v_first_error text;
  v_clean jsonb;
  v_paused int := 0;
BEGIN
  FOR r IN
    SELECT id, status FROM public.rooms
    WHERE paused_at IS NULL
      AND ((status IN ('choosing', 'writing', 'voting', 'scoreboard')
            AND round_phase_ends_at IS NOT NULL
            AND round_phase_ends_at < now() - interval '3 seconds')
           OR status IN ('shuffling', 'reveal'))
  LOOP
    BEGIN
      v_res := NULL;
      -- Pausa (playtest 2026-10-21): escrita/votação vencendo sem nenhum
      -- humano presente → a sala pausa em vez de punir e seguir sozinha.
      -- Sala pausada nem entra neste laço (paused_at IS NULL acima).
      IF r.status IN ('writing', 'voting') AND public.room_pause_due(r.id) THEN
        UPDATE public.rooms SET paused_at = now()
         WHERE id = r.id AND paused_at IS NULL AND status = r.status;
        INSERT INTO public.ops_events (kind, payload)
        VALUES ('room_paused', jsonb_build_object('room_id', r.id, 'status', r.status, 'by', 'tick'));
        v_paused := v_paused + 1;
        CONTINUE;
      END IF;
      IF r.status = 'choosing' THEN
        v_res := public.advance_choosing_to_writing(r.id);
      ELSIF r.status = 'writing' THEN
        v_res := public.extend_writing_or_advance(r.id);
      ELSIF r.status = 'shuffling' THEN
        PERFORM public.advance_writing_to_voting(r.id);
      ELSIF r.status = 'voting' THEN
        PERFORM public.advance_voting_to_reveal(r.id);
      ELSIF r.status = 'reveal' THEN
        PERFORM public.advance_reveal_to_scoreboard(r.id);
      ELSE
        v_res := public.advance_scoreboard_to_next_round_or_finished(r.id, false);
      END IF;

      SELECT status INTO v_after FROM public.rooms WHERE id = r.id;
      IF v_after IS DISTINCT FROM r.status THEN
        v_advanced := v_advanced + 1;
        v_by_phase := jsonb_set(
          v_by_phase, ARRAY[r.status],
          to_jsonb(COALESCE((v_by_phase ->> r.status)::int, 0) + 1)
        );
      ELSIF v_res ->> 'action' = 'extended' THEN
        v_extended := v_extended + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      IF v_first_error IS NULL THEN
        v_first_error := left(r.status || ': ' || SQLSTATE || ' ' || SQLERRM, 300);
      END IF;
    END;
  END LOOP;

  -- Backstop de host: sala recente cujo host saiu e que ainda tem humano.
  FOR r IN
    SELECT ro.id FROM public.rooms ro
    WHERE ro.status <> 'finished'
      AND ro.created_at > now() - interval '1 day'
      AND NOT EXISTS (
        SELECT 1 FROM public.players p
        WHERE p.id = ro.host_id AND p.room_id = ro.id AND p.kicked_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM public.players p
        WHERE p.room_id = ro.id AND p.is_bot = false AND p.kicked_at IS NULL
      )
  LOOP
    BEGIN
      v_res := public.migrate_host(r.id);
      IF (v_res ->> 'changed')::boolean THEN v_hosts := v_hosts + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      IF v_first_error IS NULL THEN
        v_first_error := left('host: ' || SQLSTATE || ' ' || SQLERRM, 300);
      END IF;
    END;
  END LOOP;

  v_clean := public.cleanup_zombie_rooms();

  IF v_advanced > 0 OR v_extended > 0 OR v_hosts > 0 OR v_paused > 0 THEN
    INSERT INTO public.ops_events (kind, payload)
    VALUES ('stalled_advance', jsonb_build_object(
      'advanced', v_advanced,
      'extended', v_extended,
      'paused', v_paused,
      'hosts_migrated', v_hosts,
      'by_phase', v_by_phase
    ));
  END IF;
  IF v_errors > 0 THEN
    INSERT INTO public.ops_events (kind, payload)
    VALUES ('tick_error', jsonb_build_object('count', v_errors, 'first', v_first_error));
  END IF;
  DELETE FROM public.ops_events WHERE at < now() - interval '30 days';

  INSERT INTO public.ops_heartbeat (job, at, duration_ms, payload)
  VALUES (
    'tick_stalled_rooms', now(),
    (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int,
    jsonb_build_object('advanced', v_advanced, 'extended', v_extended, 'paused', v_paused, 'errors', v_errors)
  )
  ON CONFLICT (job) DO UPDATE
    SET at = EXCLUDED.at, duration_ms = EXCLUDED.duration_ms, payload = EXCLUDED.payload;

  RETURN jsonb_build_object(
    'advanced', v_advanced,
    'extended', v_extended,
    'hosts_migrated', v_hosts,
    'paused', v_paused,
    'errors', v_errors,
    'cleanup', v_clean,
    'at', now()
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2) ops_health_check: avalia limiares e dispara alertas (a cada 5 min)

-- ---------------------------------------------------------------------------
-- Limpeza v5: v4 (20261019030000) + pausa (fase parada e R4 ignoram
-- pausada; TTL de 12 h; pausada sem humano ativo encerra)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cleanup_zombie_rooms()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_finished int := 0;
  v_lobby int := 0;
  v_unstuck int := 0;
  v_idle int := 0;
  v_paused_ttl int := 0;
  v_paused_empty int := 0;
  v_id uuid;
BEGIN
  -- P2: toda regra grava o motivo (finish_reason) — sala da limpeza não paga XP.
  WITH stale AS (
    UPDATE public.rooms
    SET status = 'finished', round_phase_ends_at = NULL, finish_reason = 'cleanup_stale'
    WHERE status IN ('shuffling', 'choosing', 'writing', 'voting', 'reveal', 'scoreboard')
      AND paused_at IS NULL  -- pausada tem TTL próprio (abaixo)
      AND COALESCE(phase_started_at, created_at) < now() - interval '30 minutes'
    RETURNING 1
  )
  SELECT count(*) INTO v_finished FROM stale;

  WITH stale_lobby AS (
    UPDATE public.rooms r
    SET status = 'finished', finish_reason = 'cleanup_lobby'
    WHERE r.status = 'lobby'
      AND GREATEST(
            r.created_at,
            COALESCE((SELECT max(p.joined_at) FROM public.players p WHERE p.room_id = r.id), r.created_at),
            COALESCE((SELECT max(m.created_at) FROM public.room_messages m WHERE m.room_id = r.id), r.created_at)
          ) < now() - interval '60 minutes'
    RETURNING 1
  )
  SELECT count(*) INTO v_lobby FROM stale_lobby;

  WITH no_humans AS (
    UPDATE public.rooms r
    SET status = 'finished', finish_reason = 'cleanup_empty'
    WHERE r.status IN ('shuffling', 'choosing')
      AND r.created_at < now() - interval '2 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM public.players p
        WHERE p.room_id = r.id AND p.is_bot = false AND p.is_connected = true
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_unstuck FROM no_humans;

  -- R4: sala "andando sozinha" (laço de rodadas sem ação humana).
  FOR v_id IN
    SELECT r.id FROM public.rooms r
     WHERE r.status IN ('shuffling', 'choosing', 'writing', 'voting', 'reveal', 'scoreboard')
       AND r.paused_at IS NULL  -- pausada não anda sozinha: não é laço
       AND r.current_round >= 2
       AND public.room_last_human_activity(r.id) < now() - interval '30 minutes'
  LOOP
    -- Ação humana em andamento (cast_vote ou INSERT com FK para rooms) segura
    -- a linha: pula a sala neste minuto em vez de esperar ou atropelar.
    PERFORM 1 FROM public.rooms WHERE id = v_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    -- Reconfere com a sala travada (consulta nova = foto nova do banco).
    UPDATE public.rooms r
       SET status = 'finished', round_phase_ends_at = NULL, finish_reason = 'cleanup_idle'
     WHERE r.id = v_id
       AND r.status IN ('shuffling', 'choosing', 'writing', 'voting', 'reveal', 'scoreboard')
       AND r.paused_at IS NULL
       AND r.current_round >= 2
       AND public.room_last_human_activity(r.id) < now() - interval '30 minutes';
    IF FOUND THEN
      v_idle := v_idle + 1;
    END IF;
  END LOOP;

  -- Pausa (2026-10-21): partida pausada espera os humanos até 12 h (almoço,
  -- reunião, uma tarde inteira) sem avançar nem gastar nada; depois disso é
  -- abandono e encerra sem pagar XP. Pausada sem nenhum humano ativo na
  -- mesa (todos saíram ou foram expulsos) não tem por quem esperar.
  WITH paused_ttl AS (
    UPDATE public.rooms r
       SET status = 'finished', round_phase_ends_at = NULL, finish_reason = 'cleanup_paused'
     WHERE r.paused_at IS NOT NULL
       AND r.status <> 'finished'
       AND r.paused_at < now() - interval '12 hours'
    RETURNING 1
  )
  SELECT count(*) INTO v_paused_ttl FROM paused_ttl;

  WITH paused_empty AS (
    UPDATE public.rooms r
       SET status = 'finished', round_phase_ends_at = NULL, finish_reason = 'cleanup_empty'
     WHERE r.paused_at IS NOT NULL
       AND r.status IN ('writing', 'voting')
       AND NOT EXISTS (
         SELECT 1 FROM public.players p
          WHERE p.room_id = r.id AND p.is_bot = false AND p.kicked_at IS NULL
            AND p.is_connected = true
       )
    RETURNING 1
  )
  SELECT count(*) INTO v_paused_empty FROM paused_empty;

  -- paused_at fora de escrita/votação é resíduo de corrida: a fase seguiu.
  UPDATE public.rooms SET paused_at = NULL
   WHERE paused_at IS NOT NULL AND status NOT IN ('writing', 'voting');

  -- Presença velha não serve para nada (a pausa olha só o último minuto).
  DELETE FROM public.room_presence
   WHERE active_at < now() - interval '2 days'
     AND (away_at IS NULL OR away_at < now() - interval '2 days');

  RETURN jsonb_build_object(
    'finished_paused', v_paused_ttl,
    'finished_paused_empty', v_paused_empty,
    'finished_stale', v_finished,
    'finished_lobby', v_lobby,
    'finished_empty', v_unstuck,
    'finished_idle', v_idle,
    'at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_zombie_rooms() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Alerta de sala parada: corpo de 20261003120000 sem contar a pausada
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_health_check()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_last_tick timestamptz;
  v_ai_err int;
  v_ai_ok int;
  v_ai_fallback int;
  v_rpc int;
  v_client int;
  v_tick_err int;
  v_stuck int;
  v_metrics jsonb;
  v_fired jsonb := '[]'::jsonb;
  v_url text;
  v_ping text;
  v_msg text;
  a record;
BEGIN
  SELECT at INTO v_last_tick FROM public.ops_heartbeat WHERE job = 'tick_stalled_rooms';

  SELECT
    count(*) FILTER (WHERE kind IN ('bot_ai_error', 'judge_ai_error')),
    count(*) FILTER (WHERE kind IN ('bot_ai_success', 'judge_ai_success')),
    count(*) FILTER (WHERE kind = 'bot_ai_fallback'),
    count(*) FILTER (WHERE kind = 'rpc_failure'),
    count(*) FILTER (WHERE kind IN ('client_error', 'boundary_crash'))
  INTO v_ai_err, v_ai_ok, v_ai_fallback, v_rpc, v_client
  FROM public.ops_events
  WHERE at > now() - interval '60 minutes';

  SELECT count(*) INTO v_tick_err FROM public.ops_events
  WHERE kind = 'tick_error' AND at > now() - interval '15 minutes';

  -- "Parada" = sem mudar de fase há 15+ min com humano na sala. Nenhuma fase
  -- legítima chega perto disso (escrita de 12 jogadores + 2 prorrogações
  -- ≈ 4 min). Salas criadas há mais de 1 dia são resíduo (painel), não
  -- incidente — não alertam.
  SELECT count(*) INTO v_stuck FROM public.rooms r
  WHERE r.status IN ('choosing', 'writing', 'shuffling', 'voting', 'reveal', 'scoreboard')
    AND r.paused_at IS NULL  -- pausada esperando os humanos não é incidente
    AND r.created_at > now() - interval '1 day'
    AND COALESCE(r.phase_started_at, r.created_at) < now() - interval '15 minutes'
    AND EXISTS (
      SELECT 1 FROM public.players p
      WHERE p.room_id = r.id AND p.is_bot = false AND p.kicked_at IS NULL
    );

  v_metrics := jsonb_build_object(
    'last_tick_at', v_last_tick,
    'ai_errors_1h', v_ai_err,
    'ai_successes_1h', v_ai_ok,
    'ai_fallbacks_1h', v_ai_fallback,
    'rpc_failures_1h', v_rpc,
    'client_errors_1h', v_client,
    'tick_errors_15m', v_tick_err,
    'stuck_rooms', v_stuck
  );

  FOR a IN
    SELECT * FROM (VALUES
      ('cron_stalled', 'critical',
        v_last_tick IS NULL OR v_last_tick < now() - interval '5 minutes',
        'Motor sem heartbeat do cron desde ' ||
          COALESCE(to_char(v_last_tick AT TIME ZONE 'America/Bahia', 'DD/MM HH24:MI'), 'sempre') ||
          ' — salas não avançam sozinhas'),
      ('tick_errors', 'high', v_tick_err > 0,
        v_tick_err || ' execução(ões) do tick com erro nos últimos 15 min'),
      ('ai_errors', 'high', v_ai_err >= 5 AND v_ai_err >= v_ai_ok,
        'IA falhando: ' || v_ai_err || ' erro(s) x ' || v_ai_ok || ' sucesso(s) na última hora'),
      ('stuck_rooms', 'high', v_stuck >= 3,
        v_stuck || ' sala(s) com jogadores sem mudar de fase há 15+ min'),
      ('rpc_failures', 'warning', v_rpc >= 30,
        v_rpc || ' falhas de RPC na última hora'),
      ('client_errors', 'warning', v_client >= 30,
        v_client || ' erros de client na última hora')
    ) AS t(kind, severity, fire, message)
    WHERE fire
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.ops_alerts
      WHERE kind = a.kind AND at > now() - interval '60 minutes'
    ) THEN
      INSERT INTO public.ops_alerts (kind, severity, message, payload)
      VALUES (a.kind, a.severity, a.message, v_metrics);
      v_fired := v_fired || to_jsonb(a.kind);
    END IF;
  END LOOP;

  -- Notificação (melhor-esforço; pg_net é assíncrono). Formato aceito por
  -- webhooks de Slack ('text') e Discord ('content').
  v_url := public.get_app_config('ops_alert_webhook_url');
  IF v_url ~ '^https://' THEN
    FOR a IN
      SELECT id, severity, message FROM public.ops_alerts
      WHERE notified_at IS NULL AND at > now() - interval '1 day'
      ORDER BY at
      LIMIT 10
    LOOP
      BEGIN
        v_msg := '🚨 Verbete [' || a.severity || '] ' || a.message;
        PERFORM net.http_post(
          url := v_url,
          headers := jsonb_build_object('Content-Type', 'application/json'),
          body := jsonb_build_object('text', v_msg, 'content', v_msg)
        );
        UPDATE public.ops_alerts SET notified_at = now() WHERE id = a.id;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ops_health_check: webhook falhou: %', SQLERRM;
      END;
    END LOOP;
  END IF;

  -- "Dead man's switch": um serviço externo (ex.: healthchecks.io) alerta
  -- quando os pings PARAM — único jeito de detectar o pg_cron inteiro morto.
  v_ping := public.get_app_config('ops_heartbeat_ping_url');
  IF v_ping ~ '^https://' AND v_last_tick > now() - interval '5 minutes' THEN
    BEGIN
      PERFORM net.http_get(url := v_ping);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'ops_health_check: ping falhou: %', SQLERRM;
    END;
  END IF;

  DELETE FROM public.ops_alerts WHERE at < now() - interval '90 days';

  INSERT INTO public.ops_heartbeat (job, at, payload)
  VALUES ('ops_health_check', now(), jsonb_build_object('fired', v_fired, 'metrics', v_metrics))
  ON CONFLICT (job) DO UPDATE SET at = EXCLUDED.at, payload = EXCLUDED.payload;

  RETURN jsonb_build_object('fired', v_fired, 'metrics', v_metrics);
END;
$function$;

REVOKE ALL ON FUNCTION public.ops_health_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ops_health_check() TO service_role;
