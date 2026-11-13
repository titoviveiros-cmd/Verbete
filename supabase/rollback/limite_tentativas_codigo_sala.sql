-- ROLLBACK de 20261112090000_limite_tentativas_codigo_sala.sql: rejoin_room
-- volta EXATAMENTE à versão de 20261021170000_player_id_one_room.sql (código
-- inexistente volta a ser erro "room_not_found", sem limite de tentativas);
-- funções e tabelas do limite saem. APAGA o registro de falhas (só hashes de
-- identidade com hora, retenção de 1 hora) e o sal — nada mais muda.
--   npx supabase db query --linked -f supabase/rollback/limite_tentativas_codigo_sala.sql
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
BEGIN
  -- Mantém o endurecimento de 20261003100000 (sessão obrigatória).
  IF public.is_sessionless_api_call() THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_player_id IS NULL OR char_length(p_player_id) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid_player_id';
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE code = p_code LIMIT 1;
  IF v_room IS NULL THEN
    RAISE EXCEPTION 'room_not_found';
  END IF;

  -- O id em QUALQUER sala (antes: só nesta — o INSERT abaixo estourava a PK).
  SELECT * INTO v_existing FROM public.players WHERE id = p_player_id LIMIT 1;

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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-room-code-failures-cleanup') THEN
      PERFORM cron.unschedule('verbete-room-code-failures-cleanup');
    END IF;
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.room_code_failures_cleanup();
DROP FUNCTION IF EXISTS public.room_code_record_failure(text);
DROP FUNCTION IF EXISTS public.room_code_retry_after(text);
DROP FUNCTION IF EXISTS public.room_code_uid_hash(uuid);
DROP FUNCTION IF EXISTS public.room_code_limit();
DROP TABLE IF EXISTS public.room_code_failures;
DROP TABLE IF EXISTS public.room_code_failure_salt;
