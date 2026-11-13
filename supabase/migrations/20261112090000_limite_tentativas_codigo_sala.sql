-- =============================================================================
-- ECA Digital (Lei 15.211/2025, art. 21 p.ú.) — limite de tentativas de código
-- de sala (12/11/2026, R6).
--
-- (a) OBRIGAÇÃO EXPRESSA: limitar a interação por padrão (art. 21 p.ú.);
--     proteção contra contato indesejado (L14852 art. 16 VII).
-- (b) INTERPRETAÇÃO (baixa — Q22 do parecer): com código de 4 dígitos, sem
--     limite de tentativas, "sala só por convite" pode não bastar; um limite
--     por identidade é a medida mínima. NÃO resolve sozinho: rooms continua
--     com leitura pública (política "public read rooms"), então a lista de
--     códigos sai por SELECT direto — fechar essa leitura é outro PR.
-- (c) PRODUTO: 10 falhas em 15 min por identidade → "rate_limited" até a
--     janela andar; quem já está na sala (reconexão) nunca é barrado; quem
--     entra com código/link válido não soma falha.
--
-- O que conta como FALHA (só chamadas com sessão, auth.uid() presente):
--   * código que não existe (room_not_found);
--   * sala trancada para quem não está nela (room_locked), se a coluna
--     rooms.locked existir (vem do #69, 20261111140000; lida por to_jsonb, sem
--     depender da coluna para compilar).
-- Para a falha NÃO ser desfeita com a transação, esses dois casos DEVOLVEM
-- {ok:false, reason} em vez de levantar erro (o app novo lê o retorno; ver
-- src/lib/room.ts). Chamada interna (sem sessão de API: cron, SQL, testes
-- diretos) mantém o contrato antigo (erro room_not_found / gatilho do #69).
--
-- Registro PSEUDONIMIZADO e curto: public.room_code_failures guarda só
-- sha256(sal || ':' || auth.uid()) e a hora; o sal fica em tabela separada,
-- fechada. Linhas com mais de 1 hora são apagadas a cada falha nova e a cada
-- 10 min pelo pg_cron (verbete-room-code-failures-cleanup) (a
-- janela é de 15 min). Nada de código tentado, IP, apelido nem sala.
-- Corrida: trava consultiva por identidade (pg_advisory_xact_lock) — N
-- tentativas simultâneas da mesma identidade contam uma a uma.
-- ROLLBACK: supabase/rollback/limite_tentativas_codigo_sala.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.room_code_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uid_hash text NOT NULL CHECK (uid_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_code_failures_hash_time
  ON public.room_code_failures (uid_hash, created_at);
CREATE INDEX IF NOT EXISTS room_code_failures_time
  ON public.room_code_failures (created_at);
ALTER TABLE public.room_code_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_code_failures FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.room_code_failure_salt (
  id int PRIMARY KEY CHECK (id = 1),
  salt text NOT NULL
);
ALTER TABLE public.room_code_failure_salt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.room_code_failure_salt FROM PUBLIC, anon, authenticated;
INSERT INTO public.room_code_failure_salt (id, salt)
VALUES (1, encode(sha256(convert_to(
  gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text,
  'UTF8')), 'hex'))
ON CONFLICT (id) DO NOTHING;

-- Parâmetros num só lugar (o teste lê daqui).
CREATE OR REPLACE FUNCTION public.room_code_limit()
RETURNS TABLE (max_failures int, window_secs int, retention_secs int)
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 10, 900, 3600 $$;

CREATE OR REPLACE FUNCTION public.room_code_uid_hash(p_uid uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT encode(sha256(convert_to(s.salt || ':' || p_uid::text, 'UTF8')), 'hex')
    FROM public.room_code_failure_salt s WHERE s.id = 1
$$;

-- Segundos até poder tentar de novo (NULL = não está barrado).
CREATE OR REPLACE FUNCTION public.room_code_retry_after(p_hash text)
RETURNS int
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_max int;
  v_window int;
  v_n int;
  v_at timestamptz;
BEGIN
  SELECT l.max_failures, l.window_secs INTO v_max, v_window FROM public.room_code_limit() l;
  SELECT count(*)::int INTO v_n FROM public.room_code_failures
   WHERE uid_hash = p_hash AND created_at > now() - make_interval(secs => v_window);
  IF v_n < v_max THEN RETURN NULL; END IF;
  -- Libera quando sobrarem max-1 falhas na janela.
  SELECT created_at INTO v_at FROM public.room_code_failures
   WHERE uid_hash = p_hash AND created_at > now() - make_interval(secs => v_window)
   ORDER BY created_at ASC OFFSET (v_n - v_max) LIMIT 1;
  RETURN greatest(1, ceil(extract(epoch FROM
    (v_at + make_interval(secs => v_window)) - now()))::int);
END;
$$;

CREATE OR REPLACE FUNCTION public.room_code_record_failure(p_hash text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ret int;
BEGIN
  SELECT l.retention_secs INTO v_ret FROM public.room_code_limit() l;
  DELETE FROM public.room_code_failures
   WHERE created_at < now() - make_interval(secs => v_ret);
  INSERT INTO public.room_code_failures (uid_hash) VALUES (p_hash);
END;
$$;

-- rejoin_room = 20261021170000 + o limite (marcado com "R6").
CREATE OR REPLACE FUNCTION public.rejoin_room(p_code text, p_player_id text, p_nickname text, p_avatar text, p_color text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_existing public.players;
  v_uid uuid := auth.uid();
  v_nick text := left(btrim(COALESCE(p_nickname, '')), 24);
  v_hash text;
  v_retry int;
  v_member boolean;
BEGIN
  -- Mantém o endurecimento de 20261003100000 (sessão obrigatória).
  IF public.is_sessionless_api_call() THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_player_id IS NULL OR char_length(p_player_id) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid_player_id';
  END IF;

  -- R6: identidade pseudonimizada + trava por identidade (corrida).
  IF v_uid IS NOT NULL THEN
    v_hash := public.room_code_uid_hash(v_uid);
    PERFORM pg_advisory_xact_lock(hashtextextended('room_code:' || v_hash, 0));
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE code = p_code LIMIT 1;
  IF v_room IS NULL THEN
    IF v_hash IS NULL THEN
      RAISE EXCEPTION 'room_not_found';
    END IF;
    -- R6: barrado não soma (não revela se o código existe); senão, conta.
    v_retry := public.room_code_retry_after(v_hash);
    IF v_retry IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited', 'retry_after_secs', v_retry);
    END IF;
    PERFORM public.room_code_record_failure(v_hash);
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;

  -- O id em QUALQUER sala (antes: só nesta — o INSERT abaixo estourava a PK).
  SELECT * INTO v_existing FROM public.players WHERE id = p_player_id LIMIT 1;

  -- R6: quem JÁ está nesta sala (reconexão, mesma identidade) nunca é barrado.
  v_member := v_existing.id IS NOT NULL
    AND v_existing.room_id = v_room.id
    AND v_existing.kicked_at IS NULL
    AND (v_existing.user_id IS NULL OR v_existing.user_id = v_uid);
  IF v_hash IS NOT NULL AND NOT v_member THEN
    v_retry := public.room_code_retry_after(v_hash);
    IF v_retry IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited', 'retry_after_secs', v_retry);
    END IF;
    -- Sala trancada (#69) para quem não está nela: falha que conta.
    IF coalesce((to_jsonb(v_room) ->> 'locked')::boolean, false) THEN
      PERFORM public.room_code_record_failure(v_hash);
      RETURN jsonb_build_object('ok', false, 'reason', 'room_locked');
    END IF;
  END IF;

  IF v_existing.id IS NOT NULL AND v_existing.user_id IS NOT NULL
     AND v_uid IS NOT NULL AND v_existing.user_id <> v_uid THEN
    RAISE EXCEPTION 'player_id_taken';
  END IF;
  -- Id já usado em OUTRA sala: o cliente troca de id (nunca movemos).
  IF v_existing.id IS NOT NULL AND v_existing.room_id IS DISTINCT FROM v_room.id THEN
    RAISE EXCEPTION 'player_id_taken';
  END IF;

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.players
      SET kicked_at = NULL,
          is_connected = true,
          writing_extensions = 0,
          voting_extensions = 0,
          user_id = COALESCE(v_existing.user_id, v_uid),
          -- Só quem foi EXPULSO e voltou é tratado como entrada tardia
          -- (sala 7850: reload/retomada de aba renovava joined_at e o
          -- jogador era dispensado da rodada — voto ignorado). 'shuffling'
          -- faz parte da rodada em andamento (SM-01).
          joined_at = CASE
            WHEN v_existing.kicked_at IS NOT NULL
                 AND v_room.status IN ('writing','shuffling','voting') THEN now()
            ELSE v_existing.joined_at
          END,
          nickname = COALESCE(NULLIF(v_nick, ''), nickname),
          avatar = COALESCE(NULLIF(left(p_avatar, 16), ''), avatar),
          color = COALESCE(NULLIF(left(p_color, 32), ''), color)
      WHERE id = p_player_id;
  ELSE
    BEGIN
      INSERT INTO public.players (id, room_id, nickname, avatar, color, is_connected, user_id)
      VALUES (p_player_id, v_room.id, COALESCE(NULLIF(v_nick, ''), 'Anônimo'),
              left(p_avatar, 16), left(p_color, 32), true, v_uid);
    EXCEPTION WHEN unique_violation THEN
      -- Corrida (ex.: toque duplo): o mesmo id entrou agora por outra
      -- requisição. Nesta mesma sala e da mesma pessoa = já está dentro (sem
      -- trocar de id, que daria um lugar duplicado); senão, id de outro.
      IF NOT EXISTS (
        SELECT 1 FROM public.players
         WHERE id = p_player_id AND room_id = v_room.id
           AND (user_id IS NULL OR v_uid IS NULL OR user_id = v_uid)
      ) THEN
        RAISE EXCEPTION 'player_id_taken';
      END IF;
    END;
  END IF;

  RETURN to_jsonb(v_room);
END;
$function$;

-- Retenção garantida também sem tráfego: limpeza a cada 10 min pelo pg_cron
-- (além da limpeza a cada falha nova).
CREATE OR REPLACE FUNCTION public.room_code_failures_cleanup()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ret int;
  v_n int;
BEGIN
  SELECT l.retention_secs INTO v_ret FROM public.room_code_limit() l;
  DELETE FROM public.room_code_failures
   WHERE created_at < now() - make_interval(secs => v_ret);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-room-code-failures-cleanup') THEN
      PERFORM cron.unschedule('verbete-room-code-failures-cleanup');
    END IF;
    PERFORM cron.schedule('verbete-room-code-failures-cleanup', '*/10 * * * *', 'SELECT public.room_code_failures_cleanup();');
  END IF;
END $$;

-- Internas: ninguém chama pela API.
REVOKE ALL ON FUNCTION public.room_code_failures_cleanup() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.room_code_limit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.room_code_uid_hash(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.room_code_retry_after(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.room_code_record_failure(text) FROM PUBLIC, anon, authenticated;
