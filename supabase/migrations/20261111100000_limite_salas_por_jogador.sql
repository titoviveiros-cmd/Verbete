-- =============================================================================
-- Limite de criação de salas por jogador + código liberado das salas limpas
-- (11/11/2026 — empilhada sobre 20261111090000/20261111090100, PR #60).
--
-- Problema (P1-b do Red Team do #60, pré-existente): UMA sessão anônima
-- chama create_room_with_host (ou join_public_room sem lobby aberto) com ids
-- arbitrários, sem teto por identidade. ≈ 9.000 chamadas ocupam os 9.000
-- códigos de 4 dígitos; lobby abandonado vira 'finished' em 60 min, mas o
-- código fica preso 30 dias (retention_purge_rooms) → "Criar sala" quebra
-- para todos.
--
-- Correção (assinaturas, retorno, permissões e demais erros iguais):
--   1) room_create_guard(uid), chamado só quando uma sala VAI ser criada
--      (depois das checagens de sessão/id/banimento). Por identidade de
--      sessão (auth.uid()):
--        • no máx. 5 salas VIVAS em que ela é a host (status ≠ finished);
--        • no máx. 12 criações por hora e 40 por 24 h.
--      Serializado por identidade (advisory lock): corrida não fura o teto.
--      Erro: 'room_rate_limited' (o client antigo mostra o texto genérico
--      "Não deu para criar a sala agora. Tente de novo.").
--      Sem auth.uid() (service_role/cron) não há teto — a API anônima nunca
--      chega aqui sem sessão (session_required antes).
--   2) Registro mínimo em public.room_create_log: SÓ o sha256 da identidade
--      e a hora — nada de id, apelido, IP ou sala; apagado após 48 h; sem
--      acesso pela API (RLS sem policy + REVOKE).
--   3) Código liberado antes dos 30 dias SÓ das salas encerradas PELA
--      LIMPEZA (room_code_releasable): sem partida (cleanup_lobby/empty) após
--      30 min; com partida real (cleanup_idle/stale/paused) após 6 h.
--      Essas salas não geram estatística nem histórico
--      (record_match_result recusa por finish_reason), então reusar o código
--      não toca no dedup de match_history (que é por código). A sala antiga
--      fica com code = 'arq-<id>' (fora do formato de 4 dígitos) e segue
--      até a retenção de 30 dias como antes. Partidas que terminaram de
--      verdade continuam com o código preso 30 dias (sem mudança).
-- Rollback: supabase/rollback/limite_salas_por_jogador.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.room_create_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  who bytea NOT NULL,            -- sha256(auth.uid()) — nunca o uid cru
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_create_log_who_at_idx ON public.room_create_log (who, at DESC);
CREATE INDEX IF NOT EXISTS room_create_log_at_idx ON public.room_create_log (at);
ALTER TABLE public.room_create_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.room_create_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.room_create_log_id_seq FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.room_create_log TO service_role;
COMMENT ON TABLE public.room_create_log IS
  'Limite de criação de salas (20261111100000): sha256 da identidade + hora; 48 h; sem acesso pela API.';

-- Quando o código de uma sala encerrada pode ser reusado (pós Red Team #67):
--   • cleanup_lobby / cleanup_empty (sem partida: lobby abandonado ou rodada
--     sem humanos): 30 min de folga;
--   • cleanup_idle / cleanup_stale / cleanup_paused (houve partida real, gente
--     pode voltar à aba/link): 6 h de folga;
--   • fim normal (finish_reason NULL) ou motivo novo/desconhecido: NUNCA
--     (segue preso os 30 dias da retenção, como hoje).
CREATE OR REPLACE FUNCTION public.room_code_releasable(p_status text, p_reason text, p_finished_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
-- sem SET: só now() e literais (nenhuma tabela) — e assim o planner a embute (inline)
AS $function$
  SELECT p_status = 'finished' AND p_finished_at IS NOT NULL AND CASE
    WHEN p_reason IN ('cleanup_lobby', 'cleanup_empty') THEN p_finished_at < now() - interval '30 minutes'
    WHEN p_reason IN ('cleanup_idle', 'cleanup_stale', 'cleanup_paused') THEN p_finished_at < now() - interval '6 hours'
    ELSE false
  END
$function$;
REVOKE ALL ON FUNCTION public.room_code_releasable(text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.room_code_releasable(text, text, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.room_create_guard(p_uid uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_who bytea;
  v_live int;
  v_hour int;
  v_day int;
BEGIN
  IF p_uid IS NULL THEN
    RETURN; -- service_role/cron; a API sem sessão já parou em session_required
  END IF;
  v_who := sha256(convert_to(p_uid::text, 'UTF8'));
  -- Uma criação por vez por identidade: N chamadas simultâneas não furam o teto.
  PERFORM pg_advisory_xact_lock(hashtextextended('room_create_guard|' || p_uid::text, 0));

  SELECT count(*) INTO v_live
    FROM public.rooms r
    JOIN public.players p ON p.id = r.host_id
   WHERE p.user_id = p_uid
     AND r.status <> 'finished';
  IF v_live >= 5 THEN
    RAISE EXCEPTION 'room_rate_limited' USING DETAIL = 'live';
  END IF;

  SELECT count(*) FILTER (WHERE at > now() - interval '1 hour'), count(*)
    INTO v_hour, v_day
    FROM public.room_create_log
   WHERE who = v_who AND at > now() - interval '24 hours';
  IF v_hour >= 12 OR v_day >= 40 THEN
    RAISE EXCEPTION 'room_rate_limited' USING DETAIL = CASE WHEN v_hour >= 12 THEN 'hour' ELSE 'day' END;
  END IF;

  -- Conta já: se a criação falhar depois, a transação inteira desfaz isto.
  INSERT INTO public.room_create_log (who) VALUES (v_who);

  -- Retenção curta (48 h), em lotes pequenos, sem cron novo.
  DELETE FROM public.room_create_log
   WHERE id IN (SELECT id FROM public.room_create_log
                 WHERE at < now() - interval '48 hours'
                 ORDER BY at LIMIT 200);
END;
$function$;

REVOKE ALL ON FUNCTION public.room_create_guard(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.room_create_guard(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.create_room_with_host(p_host_id text, p_nickname text, p_avatar text, p_color text)
RETURNS rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_code text;
  v_room public.rooms;
  v_attempts int := 0;
  v_uid uuid := auth.uid();
  v_nick text := left(btrim(COALESCE(p_nickname, '')), 24);
BEGIN
  IF public.is_sessionless_api_call() THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_host_id IS NULL OR char_length(p_host_id) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid_player_id';
  END IF;
  IF v_nick = '' THEN v_nick := 'Anônimo'; END IF;

  -- Sala nova = id novo: id que já existe (de outra pessoa ou de uma partida
  -- anterior) volta 'player_id_taken' e o cliente gera outro. Antes, o
  -- ON CONFLICT movia o jogador da sala antiga em silêncio.
  IF EXISTS (SELECT 1 FROM public.players WHERE id = p_host_id) THEN
    RAISE EXCEPTION 'player_id_taken';
  END IF;

  -- Teto por identidade (vivas/hora/dia) — 20261111100000.
  PERFORM public.room_create_guard(v_uid);

  -- Código de 4 dígitos (1000–9999), único em rooms (rooms_code_key).
  -- Até 12 sorteios, depois sorteio ENTRE OS LIVRES; colisão no INSERT
  -- (corrida) tenta de novo. Código de sala encerrada PELA LIMPEZA (room_code_releasable:
  -- 30 min sem partida, 6 h com partida) conta como livre: a sala antiga passa a 'arq-<id>' (20261111100000).
  -- Erro só com os 9.000 códigos ocupados (ou 40 voltas).
  LOOP
    v_attempts := v_attempts + 1;
    IF v_attempts > 40 THEN
      RAISE EXCEPTION 'could not generate unique room code';
    END IF;
    IF v_attempts <= 12 THEN
      v_code := lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
    ELSE
      v_code := NULL;
      SELECT c::text INTO v_code
        FROM generate_series(1000, 9999) AS c
       WHERE NOT EXISTS (
               SELECT 1 FROM public.rooms r
                WHERE r.code = c::text
                  AND NOT public.room_code_releasable(r.status, r.finish_reason, r.finished_at))
       ORDER BY random()
       LIMIT 1;
      IF v_code IS NULL THEN
        RAISE EXCEPTION 'could not generate unique room code';
      END IF;
    END IF;
    UPDATE public.rooms SET code = 'arq-' || id::text
     WHERE code = v_code
       AND public.room_code_releasable(status, finish_reason, finished_at);
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code);
    BEGIN
      INSERT INTO public.rooms (code, host_id, status)
      VALUES (v_code, p_host_id, 'lobby')
      RETURNING * INTO v_room;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      -- Só a corrida do código é absorvida; outra violação sobe.
      IF NOT EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code) THEN
        RAISE;
      END IF;
    END;
  END LOOP;

  BEGIN
    INSERT INTO public.players (id, room_id, nickname, avatar, color, user_id)
    VALUES (p_host_id, v_room.id, v_nick, left(p_avatar, 16), left(p_color, 32), v_uid);
  EXCEPTION WHEN unique_violation THEN
    -- Corrida com outra entrada do mesmo id: desfaz a sala criada (a
    -- exceção reverte a transação inteira) e o cliente troca de id.
    RAISE EXCEPTION 'player_id_taken';
  END;

  RETURN v_room;
END;
$function$;

CREATE OR REPLACE FUNCTION public.join_public_room(p_player_id text, p_nickname text, p_avatar text, p_color text)
RETURNS rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_code text;
  v_attempts int := 0;
  v_uid uuid := auth.uid();
  v_nick text := left(btrim(COALESCE(p_nickname, '')), 24);
BEGIN
  IF public.is_sessionless_api_call() THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_player_id IS NULL OR char_length(p_player_id) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid_player_id';
  END IF;
  IF v_nick = '' THEN v_nick := 'Anônimo'; END IF;

  -- Bloqueia banidos ANTES de qualquer outra resposta (mesma checagem do
  -- fluxo de entrar com código) — trocar de id não escapa do banimento.
  IF public.is_player_banned(p_player_id, v_uid) THEN
    RAISE EXCEPTION 'player_banned';
  END IF;

  -- Mesma regra da criação: id existente (outra pessoa ou outra sala) não
  -- entra — antes o ON CONFLICT movia o jogador de sala.
  IF EXISTS (SELECT 1 FROM public.players WHERE id = p_player_id) THEN
    RAISE EXCEPTION 'player_id_taken';
  END IF;

  -- Procura lobby público com vaga; SKIP LOCKED evita que dois jogadores
  -- em corrida travem um no outro (cada um pega um lobby diferente ou cria).
  SELECT r.* INTO v_room
  FROM public.rooms r
  WHERE r.visibility = 'public'
    AND r.status = 'lobby'
    AND (SELECT count(*) FROM public.players p WHERE p.room_id = r.id AND p.kicked_at IS NULL) < 12
  ORDER BY r.created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_room IS NULL THEN
    -- Nenhum lobby aberto: cria sala pública nova com o chamador como host.
    -- Entrar num lobby existente NÃO conta no teto; criar conta (20261111100000).
    PERFORM public.room_create_guard(v_uid);
    -- Código: mesma regra da criação (sorteio, livres, corrida, liberação
    -- das salas encerradas pela limpeza — room_code_releasable).
    LOOP
      v_attempts := v_attempts + 1;
      IF v_attempts > 40 THEN
        RAISE EXCEPTION 'could not generate unique room code';
      END IF;
      IF v_attempts <= 12 THEN
        v_code := lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
      ELSE
        v_code := NULL;
        SELECT c::text INTO v_code
          FROM generate_series(1000, 9999) AS c
         WHERE NOT EXISTS (
                 SELECT 1 FROM public.rooms r
                  WHERE r.code = c::text
                    AND NOT public.room_code_releasable(r.status, r.finish_reason, r.finished_at))
         ORDER BY random()
         LIMIT 1;
        IF v_code IS NULL THEN
          RAISE EXCEPTION 'could not generate unique room code';
        END IF;
      END IF;
      UPDATE public.rooms SET code = 'arq-' || id::text
       WHERE code = v_code
         AND public.room_code_releasable(status, finish_reason, finished_at);
      CONTINUE WHEN EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code);
      BEGIN
        INSERT INTO public.rooms (code, host_id, status, visibility)
        VALUES (v_code, p_player_id, 'lobby', 'public')
        RETURNING * INTO v_room;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- Só a corrida do código é absorvida; outra violação sobe.
        IF NOT EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code) THEN
          RAISE;
        END IF;
      END;
    END LOOP;
  END IF;

  BEGIN
    INSERT INTO public.players (id, room_id, nickname, avatar, color, user_id)
    VALUES (p_player_id, v_room.id, v_nick, left(p_avatar, 16), left(p_color, 32), v_uid);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'player_id_taken';
  END;

  RETURN v_room;
END;
$function$;
