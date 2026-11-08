-- ROLLBACK da migration 20261109100000_compartilhar_resultado.sql.
-- O gatilho de fim de partida sai junto (o fim do jogo não depende dele).
-- Ordem: Worker anterior no ar (o cliente novo chama create_match_share/get_match_share;
-- sem as funções, o botão mostra "não foi possível gerar o link" e a página de resultado
-- mostra "indisponível" — nada quebra). Apaga os links de resultado já criados.
-- Nenhum dado de jogo (salas, jogadores, pontuação, ranking, Diário) é tocado.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-match-shares-cleanup') THEN
      PERFORM cron.unschedule('verbete-match-shares-cleanup');
    END IF;
  END IF;
END $$;
DROP TRIGGER IF EXISTS match_share_on_finish ON public.rooms;
DROP FUNCTION IF EXISTS public.match_share_on_finish();
DROP TRIGGER IF EXISTS match_shares_forget_user ON auth.users;
DROP FUNCTION IF EXISTS public.match_shares_forget_user();
DROP FUNCTION IF EXISTS public.match_shares_cleanup();
DROP FUNCTION IF EXISTS public.get_match_share(text);
DROP FUNCTION IF EXISTS public.create_match_share(uuid);
DROP FUNCTION IF EXISTS public.match_share_store(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.match_share_participants(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.match_share_snapshot(uuid, timestamptz);
DROP TABLE IF EXISTS public.match_shares;
