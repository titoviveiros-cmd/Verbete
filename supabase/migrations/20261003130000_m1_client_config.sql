-- =============================================================================
-- M1 · Lote H — Controle remoto mínimo do app instalado (RC-01)
--
-- O APK empacota um bundle fixo: sem isto, um client ruim publicado só morre
-- com atualização voluntária. get_client_config() expõe APENAS as chaves
-- 'client.*' de app_config (a tabela segue fechada; as chaves internas, como
-- a URL/anon key do pg_net e o webhook de alertas, continuam invisíveis).
--
-- Chaves lidas pelo app (todas opcionais; ausência = comportamento atual):
--   client.min_native_build    inteiro; APK com versionCode menor vê a tela
--                              "Atualize o Verbete" (kill switch de versão)
--   client.maintenance         'on' bloqueia o jogo com aviso de manutenção
--                              (web e app)
--   client.maintenance_message texto do aviso (opcional)
--   client.store_url           link da loja na tela de atualização (opcional)
--
-- Nenhuma chave é criada aqui (sem mutação de dados). Ligar/desligar:
--   INSERT INTO public.app_config (key, value) VALUES ('client.maintenance', 'on')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
--
-- ROLLBACK: DROP FUNCTION public.get_client_config();
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_client_config()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(jsonb_object_agg(substr(key, 8), value), '{}'::jsonb)
  FROM public.app_config
  WHERE key LIKE 'client.%';
$$;

REVOKE ALL ON FUNCTION public.get_client_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_client_config() TO anon, authenticated, service_role;
