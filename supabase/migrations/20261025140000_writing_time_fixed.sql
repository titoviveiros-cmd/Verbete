-- =============================================================================
-- Escrita com tempo fixo (2026-10-25, testes reais em Android): cada jogador
-- escreve UMA definição, com 4 ou com 12 na sala — o prazo da escrita deixa
-- de crescer com o nº de jogadores (antes: phase_secs = base × n/6, 60 s →
-- 80/100/120 s com 8/10/12) e passa a ser a base atual + 10 s fixos (70 s).
-- A prorrogação da escrita (20 s / 15 s) também deixa de escalar.
-- Votação (mais cédulas) e revelação (mais cards) seguem proporcionais:
-- public.phase_secs fica intocada.
--
-- Corpos iguais às definições em produção (pg_get_functiondef, 25/10 — e às
-- últimas migrations), trocando SÓ o prazo da escrita.
-- Espelho no cliente: src/lib/game-times.ts (writingPhaseSecs).
-- ROLLBACK: supabase/rollback/writing_time_fixed.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION public.writing_phase_secs(p_base integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT p_base + 10;
$$;
REVOKE ALL ON FUNCTION public.writing_phase_secs(integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.choose_word(p_room_id uuid, p_word_id uuid, p_duration_sec integer DEFAULT 60)
 RETURNS jsonb
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
      -- escrita: base + 10 s, sem escalar com a sala (2026-10-25)
      round_phase_ends_at = now() + make_interval(secs => public.writing_phase_secs(p_duration_sec)),
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

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
    -- retry técnico, não é tempo de jogo: fica fixo
    UPDATE public.rooms SET round_phase_ends_at = now() + interval '60 seconds' WHERE id = p_room_id;
    RETURN jsonb_build_object('action', 'noop_no_words');
  END IF;

  UPDATE public.rooms
  SET status = 'writing',
      current_word_id = v_word.id,
      used_word_ids = array_append(v_room.used_word_ids, v_word.id),
      -- escrita: base + 10 s, sem escalar com a sala (2026-10-25)
      round_phase_ends_at = now() + make_interval(secs => public.writing_phase_secs(60)),
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('action', 'auto_picked', 'word_id', v_word.id);
END;
$function$;

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
           -- escrita: base + 10 s, sem escalar com a sala (2026-10-25)
           WHEN 'writing' THEN now() + make_interval(secs => public.writing_phase_secs(60))
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
