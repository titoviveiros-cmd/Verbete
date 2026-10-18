-- =============================================================================
-- M1 · Lote E — Estado 'shuffling' nunca mais fica sem saída (SM-01)
--
-- Deadlock: em 'shuffling', advance_writing_to_voting não age enquanto houver
-- humano sem definição; submit_definition exige 'writing'; o cron só chama
-- advance_writing_to_voting nessa fase → sala presa até o cleanup de 30 min.
--
-- Como um humano pendente chegava a 'shuffling' (verificado nesta rodada):
--   • start_shuffling com pendente: o gatilho guard_writing_phase_advance já
--     devolve a sala a 'writing', mas a RPC respondia ok=true e o client
--     mostrava o embaralhamento à toa;
--   • jogador EXPULSO que volta DURANTE 'shuffling': rejoin_room só o trata
--     como entrada tardia em writing/voting — volta com o joined_at antigo e
--     vira "pendente" numa fase em que não pode mais escrever.
--
-- Correção (servidor-autoritativa, idempotente, compatível com o cron):
--   1) start_shuffling devolve o estado REAL (ok só se ficou em 'shuffling');
--   2) advance_writing_to_voting, se encontrar pendente em 'shuffling',
--      devolve a sala a 'writing' com os MESMOS prazos — o fluxo normal
--      (prorrogação/expulsão do cron, envio do jogador) segue dali;
--   3) rejoin_room trata a volta durante 'shuffling' como entrada tardia.
-- Pontuação, durações e regras de prorrogação: inalteradas.
--
-- ROLLBACK: reaplicar start_shuffling (20260711120000),
-- advance_writing_to_voting (20260727120000) e rejoin_room (20260722130000).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.start_shuffling(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
BEGIN
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
  v_nick text := left(btrim(COALESCE(p_nickname, '')), 24);
BEGIN
  -- Mantém o endurecimento de 20261003100000 (sessão obrigatória).
  IF public.is_sessionless_api_call() THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_player_id IS NULL OR char_length(p_player_id) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid_player_id';
  END IF;

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
          -- jogador era dispensado da rodada — voto ignorado). 'shuffling'
          -- faz parte da rodada em andamento (SM-01).
          joined_at = CASE
            WHEN v_existing.kicked_at IS NOT NULL
                 AND v_room.status IN ('writing','shuffling','voting') THEN now()
            ELSE v_existing.joined_at
          END,
          nickname = COALESCE(NULLIF(v_nick, ''), nickname),
          avatar = COALESCE(NULLIF(left(p_avatar, 16), ''), avatar),
          color = COALESCE(NULLIF(left(p_color, 32), ''), color)
      WHERE id = p_player_id;
  ELSE
    INSERT INTO public.players (id, room_id, nickname, avatar, color, is_connected, user_id)
    VALUES (p_player_id, v_room.id, COALESCE(NULLIF(v_nick, ''), 'Anônimo'),
            left(p_avatar, 16), left(p_color, 32), true, v_uid);
  END IF;

  RETURN to_jsonb(v_room);
END;
$function$;
