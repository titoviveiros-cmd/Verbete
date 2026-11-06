-- =============================================================================
-- V3 mínima — guarda das Edge Functions de IA (05/11/2026)
-- Projeto: verbete-piloto-ia/PROJETO-SEGURANCA-IA-V1-V2-V3.md (frente V3).
-- Documento: docs/seguranca-v3-edges.md
--
-- Nada de dado de jogo, tabela nova ou mudança de pontuação. Esta migration:
--   1) configuração (ON CONFLICT DO NOTHING: reaplicar nunca sobrescreve):
--      * bots_auth_mode — interruptor das edges bot-definitions, bot-definitions-v2
--        e score-similarity:
--          'desligado' → fluxo antigo (rollback sem deploy);
--          'observar'  → (PADRÃO) decide e REGISTRA em ops_events (kind 'ai_guard')
--                        o que bloquearia, sem bloquear;
--          'aplicar'   → bloqueia (401 sem sessão, 403 fora da sala, 429 cota,
--                        score-similarity sem IA para rodada já julgada).
--        Valor ausente ou inválido é lido como 'observar' pelas edges — nunca 'aplicar'.
--      * bots_ai_round_limit — pedidos de IA dos bots por sala/rodada. As edges
--        limitam a [20, 1000].
--   2) bots_quota_take(sala, rodada): contador atômico da cota, na tabela
--      public.ai_quota da V2, com a chave montada AQUI ('bots_round:<sala>:<rodada>',
--      janela de 1 dia).
--
-- Por que uma função própria (CI do PR #42, run 42141677897): a 1ª versão chamava
-- public.ai_quota_add (V2) pela API com a chave de serviço e recebia "permission
-- denied" → guard_error (503) para o convidado legítimo e cota nunca contada
-- (has_function_privilege('service_role', ai_quota_add) = false). A V2 revoga
-- de PUBLIC e só concede EXECUTE explícito às funções do Diário; o acesso do
-- service_role a ai_quota_add dependia do PUBLIC. Um GRANT avulso não resolve de
-- forma estável: qualquer DROP/CREATE da função da V2 (o próprio rollback da V2 e
-- o teste dele) o apaga. Aqui o GRANT é desta função, que a V2 não toca.
--
-- DEPENDE da V2 (20261105150000_daily_guard_v2.sql): tabela public.ai_quota.
-- ROLLBACK: supabase/rollback/bots_auth_guard_v3.sql (depois de voltar as edges).
-- =============================================================================

INSERT INTO public.app_config (key, value) VALUES
  ('bots_auth_mode', 'observar'),
  ('bots_ai_round_limit', '60')   -- 12 jogadores × (💡 + sugestão automática + recargas) + bots
ON CONFLICT (key) DO NOTHING;

-- Soma 1 e devolve o total da sala/rodada na janela (atômico: pedidos simultâneos
-- recebem totais distintos 1, 2, 3…, então no máximo `limite` passam).
CREATE OR REPLACE FUNCTION public.bots_quota_take(p_room_id uuid, p_round integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_used integer;
BEGIN
  IF p_room_id IS NULL OR p_round IS NULL THEN
    RAISE EXCEPTION 'bots_quota_take: sala/rodada ausentes' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ai_quota AS q (key, window_start, used)
  VALUES ('bots_round:' || p_room_id::text || ':' || p_round::text,
          to_timestamp(floor(extract(epoch FROM now()) / 86400) * 86400), 1)
  ON CONFLICT (key, window_start) DO UPDATE SET used = q.used + 1
  RETURNING used INTO v_used;
  RETURN v_used;
END $$;

REVOKE ALL ON FUNCTION public.bots_quota_take(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bots_quota_take(uuid, integer) TO service_role;
