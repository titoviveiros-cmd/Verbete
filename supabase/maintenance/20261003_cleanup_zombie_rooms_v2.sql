-- =============================================================================
-- MANUTENÇÃO (NÃO é migration automática) — cleanup_zombie_rooms v2
--
-- Fica FORA de supabase/migrations/ de propósito: aplicar esta função muda
-- dados de produção no tick seguinte (as ~37 salas-zumbi de julho viram
-- 'finished'). Só aplicar com autorização expressa, depois de rodar o
-- dry-run (20261003_cleanup_zombie_rooms_v2_dryrun.sql) e conferir a lista.
--
-- Como aplicar (após autorização):
--   1) copiar este arquivo para supabase/migrations/<timestamp>_cleanup_zombie_rooms_v2.sql
--   2) npx supabase db push --db-url "<DB_URL>" --include-all --yes
--   3) no minuto seguinte o tick encerra os resíduos; conferir no /admin/ops
--      que "Salas-resíduo" foi a 0.
--
-- O que muda (AN-02 + ONB-02):
--   • Fases de jogo: "última atividade" = início da fase atual
--     (phase_started_at). Antes era GREATEST(created_at, round_phase_ends_at)
--     — e o próprio tick rearma round_phase_ends_at de sala sem palavra
--     elegível a cada 60s, então ela nunca envelhecia.
--   • Lobby: encerra só sem atividade há 60 min (criação, entrada de jogador
--     ou mensagem no chat). Antes: 30 min após a CRIAÇÃO, mesmo com gente
--     conversando dentro.
--   • Regra de 'shuffling/choosing sem humano conectado' (2 min): inalterada.
--
-- ROLLBACK: reaplicar cleanup_zombie_rooms de 20260518210523.
-- =============================================================================

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
BEGIN
  WITH stale AS (
    UPDATE public.rooms
    SET status = 'finished', round_phase_ends_at = NULL
    WHERE status IN ('shuffling', 'choosing', 'writing', 'voting', 'reveal', 'scoreboard')
      AND COALESCE(phase_started_at, created_at) < now() - interval '30 minutes'
    RETURNING 1
  )
  SELECT count(*) INTO v_finished FROM stale;

  WITH stale_lobby AS (
    UPDATE public.rooms r
    SET status = 'finished'
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
    SET status = 'finished'
    WHERE r.status IN ('shuffling', 'choosing')
      AND r.created_at < now() - interval '2 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM public.players p
        WHERE p.room_id = r.id AND p.is_bot = false AND p.is_connected = true
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_unstuck FROM no_humans;

  RETURN jsonb_build_object(
    'finished_stale', v_finished,
    'finished_lobby', v_lobby,
    'finished_empty', v_unstuck,
    'at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_zombie_rooms() FROM PUBLIC, anon, authenticated;
