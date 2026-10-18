-- =============================================================================
-- M1 · Lote F — Sinais de saúde que significam algo (AN-02, OB-01/02/03, IA-03)
--
-- Causa do ruído do stalled_advance (medida em 01/10: 43.200 eventos/30d,
-- 1 por minuto): tick_stalled_rooms contava cada ITERAÇÃO como "avanço",
-- e ~37 salas-zumbi de julho em 'choosing' sem palavra elegível tinham o
-- prazo rearmado a cada 60s por advance_choosing_to_writing (noop_no_words)
-- — iteradas e "contadas" para sempre.
--
-- Esta migration:
--   1) tick conta só TRANSIÇÕES REAIS (status mudou) e prorrogações, com
--      quebra por fase; erro numa sala não derruba o tick inteiro (vira
--      evento tick_error); grava heartbeat a cada execução; migra host de
--      sala recente sem host (mesma regra do client, via migrate_host).
--   2) ops_alerts + ops_health_check() a cada 5 min: cron sem heartbeat,
--      erros no tick, IA falhando, salas com humanos paradas, picos de
--      falha de RPC/client. Dedup de 60 min por tipo. Webhook opcional
--      (app_config 'ops_alert_webhook_url') e ping externo opcional
--      (app_config 'ops_heartbeat_ping_url', p/ "dead man's switch" que
--      detecta o próprio pg_cron parado).
--   3) admin_ops_summary ganha o bloco 'monitor' (sem quebrar os campos
--      atuais do painel).
--
-- NÃO mexe nas salas antigas: a limpeza dos resíduos de julho é uma ação
-- separada (supabase/maintenance/), aplicada só com autorização.
--
-- ROLLBACK: SELECT cron.unschedule('verbete-ops-health');
--   DROP FUNCTION public.ops_health_check(); DROP TABLE public.ops_alerts;
--   DROP TABLE public.ops_heartbeat; reaplicar tick_stalled_rooms e
--   admin_ops_summary de 20260727180000.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ops_heartbeat (
  job text PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  duration_ms int,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.ops_heartbeat ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_heartbeat FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.ops_alerts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  message text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  notified_at timestamptz
);
ALTER TABLE public.ops_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ops_alerts FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS ops_alerts_kind_at_idx ON public.ops_alerts (kind, at DESC);

-- ---------------------------------------------------------------------------
-- 1) tick_stalled_rooms v2
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
BEGIN
  FOR r IN
    SELECT id, status FROM public.rooms
    WHERE (status IN ('choosing', 'writing', 'voting', 'scoreboard')
           AND round_phase_ends_at IS NOT NULL
           AND round_phase_ends_at < now() - interval '3 seconds')
       OR status IN ('shuffling', 'reveal')
  LOOP
    BEGIN
      v_res := NULL;
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

  IF v_advanced > 0 OR v_extended > 0 OR v_hosts > 0 THEN
    INSERT INTO public.ops_events (kind, payload)
    VALUES ('stalled_advance', jsonb_build_object(
      'advanced', v_advanced,
      'extended', v_extended,
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
    jsonb_build_object('advanced', v_advanced, 'extended', v_extended, 'errors', v_errors)
  )
  ON CONFLICT (job) DO UPDATE
    SET at = EXCLUDED.at, duration_ms = EXCLUDED.duration_ms, payload = EXCLUDED.payload;

  RETURN jsonb_build_object(
    'advanced', v_advanced,
    'extended', v_extended,
    'hosts_migrated', v_hosts,
    'errors', v_errors,
    'cleanup', v_clean,
    'at', now()
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2) ops_health_check: avalia limiares e dispara alertas (a cada 5 min)
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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-ops-health') THEN
    PERFORM cron.unschedule('verbete-ops-health');
  END IF;
END $$;

SELECT cron.schedule(
  'verbete-ops-health',
  '*/5 * * * *',
  $$SELECT public.ops_health_check();$$
);

-- ---------------------------------------------------------------------------
-- 3) admin_ops_summary: mesmos campos + bloco 'monitor'
-- ---------------------------------------------------------------------------
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
    ),
    'monitor', jsonb_build_object(
      'last_tick_at', (SELECT at FROM public.ops_heartbeat WHERE job = 'tick_stalled_rooms'),
      'last_health_check_at', (SELECT at FROM public.ops_heartbeat WHERE job = 'ops_health_check'),
      'tick_errors', (SELECT count(*) FROM public.ops_events WHERE kind = 'tick_error' AND at > v_since),
      'ai', jsonb_build_object(
        'bot_success', (SELECT count(*) FROM public.ops_events WHERE kind = 'bot_ai_success' AND at > v_since),
        'bot_fallback', (SELECT count(*) FROM public.ops_events WHERE kind = 'bot_ai_fallback' AND at > v_since),
        'bot_error', (SELECT count(*) FROM public.ops_events WHERE kind = 'bot_ai_error' AND at > v_since),
        'judge_success', (SELECT count(*) FROM public.ops_events WHERE kind = 'judge_ai_success' AND at > v_since),
        'judge_error', (SELECT count(*) FROM public.ops_events WHERE kind = 'judge_ai_error' AND at > v_since)
      ),
      'residue_rooms', (SELECT count(*) FROM public.rooms
                        WHERE status IN ('choosing','writing','shuffling','voting','reveal','scoreboard')
                          AND created_at < now() - interval '1 day'),
      'alerts', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'at', x.at, 'kind', x.kind, 'severity', x.severity,
          'message', x.message, 'notified', x.notified_at IS NOT NULL
        ) ORDER BY x.at DESC)
        FROM (SELECT * FROM public.ops_alerts WHERE at > v_since ORDER BY at DESC LIMIT 20) x
      ), '[]'::jsonb)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;
