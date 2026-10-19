-- =============================================================================
-- R4 anti-laço — cleanup_zombie_rooms v3 = regras da v2 (inalteradas) + R4.
--
-- Problema: sala em fase de jogo cujos humanos pararam de agir continua
-- avançando sozinha — o tick move as fases (phase_started_at renova a cada
-- rodada, então a regra de "fase parada" da v2 não pega) e is_connected fica
-- true para sempre (o banco só zera em saída explícita ou eliminação, então a
-- regra "sem humano conectado" também não pega). Sem pontuação humana, a
-- partida roda até esgotar as ~1.079 palavras: as 37 salas de julho/agosto e
-- a 7397 (01–08/10, já com o M1 no ar).
--
-- R4: fase de jogo, rodada >= 2 e nenhuma atividade HUMANA real há 30+ min
-- → finished. Atividade humana (room_last_human_activity): entrada de humano,
-- definição não-verdade, voto, mensagem e reação de emoji — sempre de jogador
-- humano —, o início da partida atual (verdade da rodada 1: start_game apaga
-- as definições anteriores) e a criação da sala. NÃO contam: bots, a verdade
-- automática ('__truth__'), o tick, mudança de fase, prazos e is_connected.
-- A rodada 1 inteira é carência (sala recém-iniciada).
--
-- Concorrência: a sala é travada com FOR UPDATE SKIP LOCKED — conflita com o
-- FOR UPDATE do cast_vote e com o FOR KEY SHARE que todo INSERT de ação humana
-- (FK para rooms) segura até o commit; ação humana em andamento faz a sala ser
-- pulada neste minuto. Com a trava, a inatividade é reconferida numa consulta
-- nova antes de encerrar. Só muda status/prazo: nada é apagado.
--
-- ROLLBACK: supabase/rollback/cleanup_zombie_rooms_v2.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION public.room_last_human_activity(p_room_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT GREATEST(
    (SELECT r.created_at FROM public.rooms r WHERE r.id = p_room_id),
    (SELECT max(p.joined_at) FROM public.players p
      WHERE p.room_id = p_room_id AND p.is_bot = false),
    (SELECT max(d.created_at) FROM public.definitions d
       JOIN public.players p ON p.id = d.player_id AND p.is_bot = false
      WHERE d.room_id = p_room_id AND d.is_truth = false),
    (SELECT max(v.created_at) FROM public.votes v
       JOIN public.players p ON p.id = v.voter_id AND p.is_bot = false
      WHERE v.room_id = p_room_id),
    (SELECT max(m.created_at) FROM public.room_messages m
       JOIN public.players p ON p.id = m.player_id AND p.is_bot = false
      WHERE m.room_id = p_room_id),
    (SELECT max(x.created_at) FROM public.reactions x
       JOIN public.players p ON p.id = x.player_id AND p.is_bot = false
      WHERE x.room_id = p_room_id),
    (SELECT max(d.created_at) FROM public.definitions d
      WHERE d.room_id = p_room_id AND d.is_truth = true AND d.round = 1)
  );
$$;

REVOKE ALL ON FUNCTION public.room_last_human_activity(uuid) FROM PUBLIC, anon, authenticated;

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
  v_idle int := 0;
  v_id uuid;
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

  -- R4: sala "andando sozinha" (laço de rodadas sem ação humana).
  FOR v_id IN
    SELECT r.id FROM public.rooms r
     WHERE r.status IN ('shuffling', 'choosing', 'writing', 'voting', 'reveal', 'scoreboard')
       AND r.current_round >= 2
       AND public.room_last_human_activity(r.id) < now() - interval '30 minutes'
  LOOP
    -- Ação humana em andamento (cast_vote ou INSERT com FK para rooms) segura
    -- a linha: pula a sala neste minuto em vez de esperar ou atropelar.
    PERFORM 1 FROM public.rooms WHERE id = v_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    -- Reconfere com a sala travada (consulta nova = foto nova do banco).
    UPDATE public.rooms r
       SET status = 'finished', round_phase_ends_at = NULL
     WHERE r.id = v_id
       AND r.status IN ('shuffling', 'choosing', 'writing', 'voting', 'reveal', 'scoreboard')
       AND r.current_round >= 2
       AND public.room_last_human_activity(r.id) < now() - interval '30 minutes';
    IF FOUND THEN
      v_idle := v_idle + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'finished_stale', v_finished,
    'finished_lobby', v_lobby,
    'finished_empty', v_unstuck,
    'finished_idle', v_idle,
    'at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_zombie_rooms() FROM PUBLIC, anon, authenticated;
