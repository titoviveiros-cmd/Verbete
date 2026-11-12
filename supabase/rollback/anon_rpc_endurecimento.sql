-- Reversão da 20261111090100_anon_rpc_endurecimento: log_ops_event volta ao
-- corpo da 20260727180000_ops_observability (byte a byte) e send_room_message
-- volta a ser executável como em produção antes (PUBLIC, anon, authenticated).
-- Depois: supabase migration repair --status reverted 20261111090100

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

GRANT EXECUTE ON FUNCTION public.send_room_message(uuid, text, text) TO PUBLIC, anon, authenticated, service_role;
