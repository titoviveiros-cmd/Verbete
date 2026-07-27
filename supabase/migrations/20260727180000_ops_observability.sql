-- Fase 8 — Observabilidade própria (sem Sentry): eventos de operação em
-- tabela, ingestão com rate-limit, leitura só p/ admin, retenção de 30 dias.
--
-- Privacidade: o client envia HASHES (session_key = hash do player_id,
-- room_hash = hash do código da sala) — nada reversível; sem IP, sem nome.
--
-- ROLLBACK: DROP FUNCTION public.admin_ops_recent(int); DROP FUNCTION
-- public.admin_ops_summary(int); DROP FUNCTION public.log_ops_event(text,
-- jsonb, text, text, text); DROP TABLE public.ops_events; reaplicar
-- tick_stalled_rooms da migration 20260721150000.

CREATE TABLE public.ops_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  build text,
  session_key text,
  room_hash text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE public.ops_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_events FROM anon, authenticated;

CREATE INDEX ops_events_at_idx ON public.ops_events (at DESC);
CREATE INDEX ops_events_kind_at_idx ON public.ops_events (kind, at DESC);
CREATE INDEX ops_events_session_at_idx ON public.ops_events (session_key, at DESC);

-- Ingestão: qualquer client pode reportar, mas no máx. 30 eventos por
-- sessão a cada 5 min (um client bugado não inunda a tabela).
CREATE OR REPLACE FUNCTION public.log_ops_event(
  p_kind text,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_session_key text DEFAULT NULL,
  p_room_hash text DEFAULT NULL,
  p_build text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_recent int;
BEGIN
  IF p_kind NOT IN ('client_error', 'boundary_crash', 'rpc_failure', 'reconnect') THEN
    RETURN;
  END IF;
  IF p_session_key IS NOT NULL THEN
    SELECT count(*) INTO v_recent FROM public.ops_events
    WHERE session_key = left(p_session_key, 64)
      AND at > now() - interval '5 minutes';
    IF v_recent >= 30 THEN RETURN; END IF;
  END IF;
  INSERT INTO public.ops_events (kind, payload, session_key, room_hash, build)
  VALUES (
    p_kind,
    COALESCE(p_payload, '{}'::jsonb),
    left(p_session_key, 64),
    left(p_room_hash, 64),
    left(p_build, 32)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_ops_event(text, jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_ops_event(text, jsonb, text, text, text) TO anon, authenticated, service_role;

-- Resumo operacional (admin): funil + saúde nas últimas N horas.
CREATE OR REPLACE FUNCTION public.admin_ops_summary(p_hours int DEFAULT 24)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_since timestamptz := now() - make_interval(hours => LEAST(GREATEST(p_hours, 1), 720));
  v_result jsonb;
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  SELECT jsonb_build_object(
    'since', v_since,
    'funnel', jsonb_build_object(
      'rooms_created', (SELECT count(*) FROM public.rooms WHERE created_at > v_since),
      'games_started', (SELECT count(DISTINCT room_id) FROM public.rounds r
                        WHERE r.round = 1 AND r.scored_at > v_since),
      'rounds_played', (SELECT count(*) FROM public.rounds WHERE scored_at > v_since),
      'games_finished', (SELECT count(DISTINCT room_code) FROM public.match_history WHERE played_at > v_since),
      'daily_attempts', (SELECT count(*) FROM public.daily_attempts WHERE created_at > v_since)
    ),
    'health', jsonb_build_object(
      'client_errors', (SELECT count(*) FROM public.ops_events WHERE kind IN ('client_error','boundary_crash') AND at > v_since),
      'rpc_failures', (SELECT count(*) FROM public.ops_events WHERE kind = 'rpc_failure' AND at > v_since),
      'reconnects', (SELECT count(*) FROM public.ops_events WHERE kind = 'reconnect' AND at > v_since),
      'stalled_advances', (SELECT COALESCE(sum((payload->>'advanced')::int), 0)
                           FROM public.ops_events WHERE kind = 'stalled_advance' AND at > v_since),
      'sessions_with_errors', (SELECT count(DISTINCT session_key) FROM public.ops_events
                               WHERE kind IN ('client_error','boundary_crash') AND at > v_since)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_ops_summary(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_ops_summary(int) TO authenticated;

-- Últimos eventos (admin) — p/ inspecionar erros com stack.
CREATE OR REPLACE FUNCTION public.admin_ops_recent(p_limit int DEFAULT 50)
RETURNS SETOF public.ops_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  RETURN QUERY SELECT * FROM public.ops_events
  ORDER BY at DESC LIMIT LEAST(GREATEST(p_limit, 1), 200);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_ops_recent(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_ops_recent(int) TO authenticated;

-- tick_stalled_rooms: registra avanços do backstop (sala travada = host
-- ausente ou client quebrado — sinal de saúde) e aplica retenção de 30 dias.
CREATE OR REPLACE FUNCTION public.tick_stalled_rooms()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    SELECT id FROM public.rooms WHERE status = 'shuffling'
  LOOP
    PERFORM public.advance_writing_to_voting(r.id);
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

  -- Fase 8: métrica de backstop + retenção dos eventos (30 dias)
  IF v_count > 0 THEN
    INSERT INTO public.ops_events (kind, payload)
    VALUES ('stalled_advance', jsonb_build_object('advanced', v_count));
  END IF;
  DELETE FROM public.ops_events WHERE at < now() - interval '30 days';

  RETURN jsonb_build_object('advanced', v_count, 'cleanup', v_clean, 'at', now());
END;
$function$;
