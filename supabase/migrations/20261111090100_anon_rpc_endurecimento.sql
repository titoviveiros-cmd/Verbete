-- =============================================================================
-- Endurecimento de 2 RPCs abertas à chave publicável (10/11/2026 — frente de
-- segurança do lançamento na Play). Sem mudar assinatura nem o caminho do app.
--
-- 1) log_ops_event (telemetria anônima, Fase 8)
--    Antes: o limite de 30 eventos/5 min valia SÓ com p_session_key; com
--    p_session_key NULL (ou trocando a chave a cada chamada) não havia teto, e
--    p_payload não tinha limite de tamanho. Qualquer um com a chave publicável
--    (pública no site) podia encher public.ops_events (retenção de 30 dias)
--    sem sessão. Produção 10/11: ~1.800 linhas vivas, 16 MB no total.
--    Agora (mesmo contrato: RETURNS void, descarte silencioso):
--      • payload acima de 2 kB vira {"truncated": true, "bytes": n, "message":
--        ≤300, "route": ≤200} — sem as pilhas (client_error ≈ 1,4 kB cabe;
--        boundary_crash com component_stack chega a ≈ 1,97 kB, então o resumo
--        guarda o que diagnostica em vez de descartar tudo);
--      • sem session_key: 60 eventos/min no total desse balde;
--      • teto GLOBAL: 300 eventos/min, 1.000/hora e 2.000/dia (qualquer chave;
--        produção 10/11 ≈ 60 eventos/dia). Pior caso sob ataque: 2.000 × 2 kB
--        × 30 dias de retenção ≈ 120 MB — o banco não enche.
--      • os tetos contam só os 4 tipos do client: eventos que o servidor grava
--        direto (data_retention, bot_ai_error…) não consomem a cota do client.
--    Efeito colateral aceito: num ataque, a telemetria legítima também é
--    descartada até a janela passar — o banco não enche.
--
-- 2) send_room_message (chat da sala, REMOVIDO do app no playtest de 20/10)
--    A RPC e a tabela ficaram dormentes, mas seguiam executáveis por anon e
--    authenticated (inclusive SEM sessão, pelo "fallback" de identidade de
--    jogador não reivindicado) e room_messages tem leitura pública + realtime:
--    texto livre de terceiros, sem moderação, num canal que o app não mostra.
--    Nenhum build com versionCode ≥ 3 chama a RPC (só o 2.0.0/vc2, de teste).
--    Agora: EXECUTE só para service_role. Tabela e dados ficam (a limpeza
--    estrutural segue como débito, sem migration destrutiva).
--
-- Rollback: supabase/rollback/anon_rpc_endurecimento.sql
-- =============================================================================

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
  v_payload jsonb := COALESCE(p_payload, '{}'::jsonb);
  v_bytes int;
BEGIN
  IF p_kind NOT IN ('client_error', 'boundary_crash', 'rpc_failure', 'reconnect') THEN
    RETURN;
  END IF;

  -- Tamanho: client_error real ≈ 1,4 kB; boundary_crash (com component_stack)
  -- chega a ≈ 1,97 kB com acentos e aspas — perto do teto. Acima de 2 kB, fica
  -- um resumo que ainda diagnostica: mensagem (300) e rota (200), sem as pilhas.
  v_bytes := octet_length(v_payload::text);
  IF v_bytes > 2048 THEN
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'truncated', true,
      'bytes', v_bytes,
      'message', left(CASE WHEN jsonb_typeof(v_payload) = 'object' THEN v_payload ->> 'message' END, 300),
      'route', left(CASE WHEN jsonb_typeof(v_payload) = 'object' THEN v_payload ->> 'route' END, 200)
    ));
  END IF;

  -- Por sessão (como antes) ou, sem sessão, um balde comum.
  IF p_session_key IS NOT NULL THEN
    SELECT count(*) INTO v_recent FROM public.ops_events
    WHERE session_key = left(p_session_key, 64)
      AND at > now() - interval '5 minutes';
    IF v_recent >= 30 THEN RETURN; END IF;
  ELSE
    SELECT count(*) INTO v_recent FROM public.ops_events
    WHERE session_key IS NULL
      AND kind IN ('client_error', 'boundary_crash', 'rpc_failure', 'reconnect')
      AND at > now() - interval '1 minute';
    IF v_recent >= 60 THEN RETURN; END IF;
  END IF;

  -- Teto global: trocar a session_key a cada chamada não fura o limite.
  SELECT count(*) INTO v_recent FROM public.ops_events
  WHERE kind IN ('client_error', 'boundary_crash', 'rpc_failure', 'reconnect') AND at > now() - interval '1 minute';
  IF v_recent >= 300 THEN RETURN; END IF;
  SELECT count(*) INTO v_recent FROM public.ops_events
  WHERE kind IN ('client_error', 'boundary_crash', 'rpc_failure', 'reconnect') AND at > now() - interval '1 hour';
  IF v_recent >= 1000 THEN RETURN; END IF;
  SELECT count(*) INTO v_recent FROM public.ops_events
  WHERE kind IN ('client_error', 'boundary_crash', 'rpc_failure', 'reconnect') AND at > now() - interval '1 day';
  IF v_recent >= 2000 THEN RETURN; END IF;

  INSERT INTO public.ops_events (kind, payload, session_key, room_hash, build)
  VALUES (
    p_kind,
    v_payload,
    left(p_session_key, 64),
    left(p_room_hash, 64),
    left(p_build, 32)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.log_ops_event(text, jsonb, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_ops_event(text, jsonb, text, text, text) TO anon, authenticated, service_role;

-- Chat dormente: fecha a porta (a função continua existindo).
REVOKE ALL ON FUNCTION public.send_room_message(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_room_message(uuid, text, text) TO service_role;
