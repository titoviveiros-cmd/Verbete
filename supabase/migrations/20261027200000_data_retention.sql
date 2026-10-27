-- =============================================================================
-- Retenção de dados (Rodada 2B da conformidade Google Play, 2026-10-27).
--
-- Decisão do proprietário (27/10/2026):
--   - salas ENCERRADAS: apagadas 30 dias depois do encerramento (e da última
--     atividade humana registrada nelas); sala que não está 'finished' nunca;
--   - sessões de convidado (auth.users.is_anonymous) INATIVAS há 30 dias:
--     apagadas com perfil, estatísticas, histórico, conquistas e palpites;
--     conta real (e-mail/Google) NUNCA entra;
--   - denúncias resolvidas/descartadas: apagadas 180 dias depois de
--     resolved_at; pendente nunca expira por idade; denúncia fechada sem
--     resolved_at não é apagada (só contada);
--   - banimentos (banned_players): NÃO são tocados — temporário vale até
--     expires_at, permanente (expires_at NULL) nunca é apagado aqui.
--
-- Auditoria do schema (base 482e9a9):
--   - rooms não tinha momento de encerramento: só status/finish_reason
--     (cleanup_zombie_rooms marca 'finished' e nunca apaga). Agora
--     rooms.finished_at, mantido por trigger em QUALQUER caminho que mude o
--     status (fim natural, limpeza, revanche via reset_room zera).
--     Salas já encerradas: estimativa conservadora = última atividade
--     conhecida + 12 h (o maior prazo de encerramento automático: pausa),
--     limitada a now() — nunca antes do encerramento real.
--   - DELETE em rooms leva por CASCADE players, definitions, votes,
--     reactions, rounds, room_messages e ai_served_defs. Sem FK (apagadas à
--     parte, pelo room_id): round_extensions, room_words, room_presence.
--     reports.room_id/definition_id NÃO têm FK: a denúncia guarda o retrato
--     (texto, apelido, player_id, user_id, código, rodada) e sobrevive.
--   - Nenhuma tabela tem trigger de DELETE; nenhum FK trava a limpeza.
--   - auth.users → profiles, user_stats, match_history (CASCADE). Sem FK:
--     daily_attempts, user_achievements (apagadas à parte); players.user_id,
--     reports, banned_players e user_roles ficam (outras políticas).
--
-- Mecanismo: run_data_retention() num job pg_cron PRÓPRIO, de hora em hora
-- ('verbete-data-retention'), fora do tick de 1 min — uma falha aqui nunca
-- atrasa o motor das partidas. Limitado por execução, idempotente (cada
-- passo só apaga o que ainda cumpre o critério, com a linha travada e
-- SKIP LOCKED), observável (ops_heartbeat 'data_retention'; ops_events
-- 'data_retention' quando apaga algo e 'retention_error' quando falha) e
-- fail-safe (cada item num bloco próprio: erro conta e segue).
-- Funções internas: sem EXECUTE para anon/authenticated.
--
-- ORDEM: aplicar ANTES de publicar os textos que prometem os prazos.
-- ROLLBACK: supabase/rollback/data_retention.sql
-- =============================================================================

-- 1) Momento do encerramento da sala ------------------------------------------
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS finished_at timestamptz;

COMMENT ON COLUMN public.rooms.finished_at IS
  'Quando a sala virou finished (trigger rooms_track_finished_at). NULL fora de finished. Base da retenção de 30 dias (retention_purge_rooms).';

UPDATE public.rooms r
   SET finished_at = LEAST(
         now(),
         GREATEST(r.created_at, r.phase_started_at, r.paused_at,
                  public.room_last_human_activity(r.id)) + interval '12 hours'
       )
 WHERE r.status = 'finished' AND r.finished_at IS NULL;

ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_finished_at_check;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_finished_at_check
  CHECK (status = 'finished' OR finished_at IS NULL);

CREATE INDEX IF NOT EXISTS rooms_finished_at_idx
  ON public.rooms (finished_at) WHERE status = 'finished';

CREATE OR REPLACE FUNCTION public.rooms_track_finished_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status = 'finished' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.finished_at := COALESCE(NEW.finished_at, now());
    ELSIF OLD.status IS DISTINCT FROM 'finished' OR NEW.finished_at IS NULL THEN
      NEW.finished_at := now();
    END IF;
  ELSE
    -- revanche (reset_room) ou qualquer volta à partida: a sala está viva
    NEW.finished_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.rooms_track_finished_at() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS rooms_track_finished_at ON public.rooms;
CREATE TRIGGER rooms_track_finished_at
BEFORE INSERT OR UPDATE OF status ON public.rooms
FOR EACH ROW
EXECUTE FUNCTION public.rooms_track_finished_at();

-- Apagar a sala apaga as definições, e cada uma dispara o CASCADE para
-- votes(definition_id) — sem índice, uma varredura de votes por definição.
CREATE INDEX IF NOT EXISTS idx_votes_definition_id ON public.votes (definition_id);

CREATE INDEX IF NOT EXISTS reports_resolved_at_idx
  ON public.reports (resolved_at) WHERE status IN ('resolved', 'dismissed');

-- 2) Salas encerradas há 30 dias -----------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_purge_rooms(p_limit int DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cutoff timestamptz := now() - interval '30 days';
  v_id uuid;
  v_deleted int := 0;
  v_skipped int := 0;
  v_errors int := 0;
  v_first text;
BEGIN
  FOR v_id IN
    SELECT r.id FROM public.rooms r
     WHERE r.status = 'finished'
       AND r.finished_at < v_cutoff
       AND public.room_last_human_activity(r.id) < v_cutoff
     ORDER BY r.finished_at
     LIMIT GREATEST(p_limit, 0)
  LOOP
    BEGIN
      -- Ação em andamento na sala (revanche, entrada) segura a linha: pula.
      PERFORM 1 FROM public.rooms WHERE id = v_id FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
      -- Reconfere com a linha travada (a revanche zera finished_at).
      IF NOT EXISTS (
           SELECT 1 FROM public.rooms r
            WHERE r.id = v_id AND r.status = 'finished' AND r.finished_at < v_cutoff
         )
         OR public.room_last_human_activity(v_id) >= v_cutoff THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
      DELETE FROM public.round_extensions WHERE room_id = v_id;
      DELETE FROM public.room_words WHERE room_id = v_id;
      DELETE FROM public.room_presence WHERE room_id = v_id;
      DELETE FROM public.rooms WHERE id = v_id;  -- CASCADE: o resto da sala
      v_deleted := v_deleted + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      IF v_first IS NULL THEN
        v_first := left('rooms: ' || SQLSTATE || ' ' || SQLERRM, 300);
      END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object('deleted', v_deleted, 'skipped', v_skipped,
                            'errors', v_errors, 'first_error', v_first);
END;
$$;

REVOKE ALL ON FUNCTION public.retention_purge_rooms(int) FROM PUBLIC, anon, authenticated;

-- 3) Sessões de convidado inativas há 30 dias ----------------------------------
-- Candidatas: SÓ is_anonymous, sem e-mail/telefone (nem troca pendente), sem
-- identidade de provedor real, sem papel (admin), sem lugar em sala viva e
-- sem NENHUM sinal de uso desde o corte: login, sessão/refresh do token (o
-- app renova o token ao abrir), entrada em sala, perfil, estatísticas,
-- partidas, palpites e conquistas. p_only reconfere um id só.
CREATE OR REPLACE FUNCTION public.retention_anon_candidates(
  p_cutoff timestamptz,
  p_only uuid DEFAULT NULL,
  p_limit int DEFAULT 500
)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT u.id
    FROM auth.users u
   WHERE (p_only IS NULL OR u.id = p_only)
     AND u.is_anonymous IS TRUE
     AND COALESCE(u.email, '') = ''
     AND COALESCE(u.email_change, '') = ''
     AND COALESCE(u.phone, '') = ''
     AND u.created_at < p_cutoff
     AND COALESCE(u.updated_at, u.created_at) < p_cutoff
     AND COALESCE(u.last_sign_in_at, u.created_at) < p_cutoff
     AND NOT EXISTS (SELECT 1 FROM auth.identities i
                      WHERE i.user_id = u.id AND i.provider <> 'anonymous')
     AND NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = u.id)
     AND NOT EXISTS (SELECT 1 FROM auth.sessions s
                      WHERE s.user_id = u.id
                        AND GREATEST(s.created_at, s.updated_at) >= p_cutoff)
     AND NOT EXISTS (SELECT 1 FROM auth.refresh_tokens t
                      WHERE t.user_id = u.id::text
                        AND GREATEST(t.created_at, t.updated_at) >= p_cutoff)
     AND NOT EXISTS (SELECT 1 FROM public.players p
                       JOIN public.rooms r ON r.id = p.room_id
                      WHERE p.user_id = u.id
                        AND (r.status <> 'finished' OR p.joined_at >= p_cutoff))
     AND NOT EXISTS (SELECT 1 FROM public.profiles pr
                      WHERE pr.user_id = u.id AND pr.updated_at >= p_cutoff)
     AND NOT EXISTS (SELECT 1 FROM public.user_stats st
                      WHERE st.user_id = u.id
                        AND GREATEST(st.updated_at, st.last_played_hour) >= p_cutoff)
     AND NOT EXISTS (SELECT 1 FROM public.match_history m
                      WHERE m.user_id = u.id AND m.played_at >= p_cutoff)
     AND NOT EXISTS (SELECT 1 FROM public.daily_attempts d
                      WHERE d.user_id = u.id AND d.created_at >= p_cutoff)
     AND NOT EXISTS (SELECT 1 FROM public.user_achievements a
                      WHERE a.user_id = u.id AND a.unlocked_at >= p_cutoff)
   ORDER BY u.created_at
   LIMIT GREATEST(p_limit, 0);
$$;

REVOKE ALL ON FUNCTION public.retention_anon_candidates(timestamptz, uuid, int) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.retention_purge_anon_users(p_limit int DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cutoff timestamptz := now() - interval '30 days';
  v_id uuid;
  v_deleted int := 0;
  v_skipped int := 0;
  v_errors int := 0;
  v_first text;
BEGIN
  FOR v_id IN SELECT c FROM public.retention_anon_candidates(v_cutoff, NULL, p_limit) c
  LOOP
    BEGIN
      -- Login/conversão em andamento segura a linha: pula.
      PERFORM 1 FROM auth.users WHERE id = v_id FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
      -- Reconfere TUDO com a linha travada (virou conta real? voltou a jogar?).
      IF NOT EXISTS (SELECT 1 FROM public.retention_anon_candidates(v_cutoff, v_id, 1)) THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
      DELETE FROM public.daily_attempts WHERE user_id = v_id;
      DELETE FROM public.user_achievements WHERE user_id = v_id;
      -- CASCADE: profiles, user_stats, match_history e o interno do Auth.
      DELETE FROM auth.users WHERE id = v_id AND is_anonymous IS TRUE;
      v_deleted := v_deleted + 1;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      IF v_first IS NULL THEN
        v_first := left('anon: ' || SQLSTATE || ' ' || SQLERRM, 300);
      END IF;
    END;
  END LOOP;

  RETURN jsonb_build_object('deleted', v_deleted, 'skipped', v_skipped,
                            'errors', v_errors, 'first_error', v_first);
END;
$$;

REVOKE ALL ON FUNCTION public.retention_purge_anon_users(int) FROM PUBLIC, anon, authenticated;

-- 4) Denúncias fechadas há 180 dias ---------------------------------------------
CREATE OR REPLACE FUNCTION public.retention_purge_reports(p_limit int DEFAULT 1000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_cutoff timestamptz := now() - interval '180 days';
  v_deleted int := 0;
  v_undated int := 0;
BEGIN
  WITH doomed AS (
    SELECT id FROM public.reports
     WHERE status IN ('resolved', 'dismissed')
       AND resolved_at IS NOT NULL
       AND resolved_at < v_cutoff
     ORDER BY resolved_at
     LIMIT GREATEST(p_limit, 0)
     FOR UPDATE SKIP LOCKED
  ), gone AS (
    DELETE FROM public.reports r
     USING doomed d
     WHERE r.id = d.id
       AND r.status IN ('resolved', 'dismissed')
       AND r.resolved_at < v_cutoff
    RETURNING 1
  )
  SELECT count(*) INTO v_deleted FROM gone;

  -- Fechada sem data de resolução: não dá para contar o prazo — fica.
  SELECT count(*) INTO v_undated FROM public.reports
   WHERE status IN ('resolved', 'dismissed') AND resolved_at IS NULL;

  RETURN jsonb_build_object('deleted', v_deleted, 'closed_without_date', v_undated);
END;
$$;

REVOKE ALL ON FUNCTION public.retention_purge_reports(int) FROM PUBLIC, anon, authenticated;

-- 5) Orquestração + observabilidade --------------------------------------------
CREATE OR REPLACE FUNCTION public.run_data_retention(
  p_rooms int DEFAULT 500,
  p_anon int DEFAULT 500,
  p_reports int DEFAULT 1000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_t0 timestamptz := clock_timestamp();
  v_rooms jsonb := '{}'::jsonb;
  v_anon jsonb := '{}'::jsonb;
  v_reports jsonb := '{}'::jsonb;
  v_errors int := 0;
  v_first text;
  v_out jsonb;
BEGIN
  BEGIN
    v_rooms := public.retention_purge_rooms(p_rooms);
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors + 1;
    v_first := COALESCE(v_first, left('rooms: ' || SQLSTATE || ' ' || SQLERRM, 300));
  END;
  BEGIN
    v_anon := public.retention_purge_anon_users(p_anon);
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors + 1;
    v_first := COALESCE(v_first, left('anon: ' || SQLSTATE || ' ' || SQLERRM, 300));
  END;
  BEGIN
    v_reports := public.retention_purge_reports(p_reports);
  EXCEPTION WHEN OTHERS THEN
    v_errors := v_errors + 1;
    v_first := COALESCE(v_first, left('reports: ' || SQLSTATE || ' ' || SQLERRM, 300));
  END;

  v_errors := v_errors
    + COALESCE((v_rooms ->> 'errors')::int, 0)
    + COALESCE((v_anon ->> 'errors')::int, 0);
  v_first := COALESCE(v_first, v_rooms ->> 'first_error', v_anon ->> 'first_error');

  v_out := jsonb_build_object(
    'rooms_deleted', COALESCE((v_rooms ->> 'deleted')::int, 0),
    'rooms_skipped', COALESCE((v_rooms ->> 'skipped')::int, 0),
    'anon_deleted', COALESCE((v_anon ->> 'deleted')::int, 0),
    'anon_skipped', COALESCE((v_anon ->> 'skipped')::int, 0),
    'reports_deleted', COALESCE((v_reports ->> 'deleted')::int, 0),
    'reports_closed_without_date', COALESCE((v_reports ->> 'closed_without_date')::int, 0),
    'errors', v_errors
  );

  IF (v_out ->> 'rooms_deleted')::int > 0
     OR (v_out ->> 'anon_deleted')::int > 0
     OR (v_out ->> 'reports_deleted')::int > 0 THEN
    INSERT INTO public.ops_events (kind, payload) VALUES ('data_retention', v_out);
  END IF;
  IF v_errors > 0 THEN
    INSERT INTO public.ops_events (kind, payload)
    VALUES ('retention_error', jsonb_build_object('count', v_errors, 'first', v_first));
  END IF;

  INSERT INTO public.ops_heartbeat (job, at, duration_ms, payload)
  VALUES ('data_retention', now(),
          (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int, v_out)
  ON CONFLICT (job) DO UPDATE
    SET at = EXCLUDED.at, duration_ms = EXCLUDED.duration_ms, payload = EXCLUDED.payload;

  RETURN v_out || jsonb_build_object('first_error', v_first, 'at', now());
END;
$$;

REVOKE ALL ON FUNCTION public.run_data_retention(int, int, int) FROM PUBLIC, anon, authenticated;

-- 6) Agenda: de hora em hora, no minuto 17 (longe da virada da hora) -----------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-data-retention') THEN
    PERFORM cron.unschedule('verbete-data-retention');
  END IF;
END $$;

SELECT cron.schedule(
  'verbete-data-retention',
  '17 * * * *',
  $$SELECT public.run_data_retention();$$
);
