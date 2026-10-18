-- =============================================================================
-- M1 · Lote A — Autoridade do servidor: fecha a escrita direta dos clients
-- (Master Release Audit 2026-10-02: SCORE-01/02/03/04/05, RT-01/02/05/11,
--  SEC-01/02/03/04, SM-04, SCORE-03).
--
-- Antes: policies USING(true) + GRANTs amplos deixavam qualquer portador da
-- chave pública editar players (score, user_id, kicked_at…), corromper
-- definitions, pré-inserir rounds (anulando a pontuação da rodada), roubar o
-- host_id, ler room_words.meaning durante a rodada e executar
-- apply_similarity_bonus (a revogação de 20260729120000 cobriu só PUBLIC;
-- os privilégios padrão do Supabase concedem EXECUTE direto a anon e
-- authenticated).
--
-- Depois: tabelas de jogo são SOMENTE LEITURA para anon/authenticated; toda
-- mutação passa por RPCs SECURITY DEFINER (as já existentes + migrate_host e
-- add_bot, novas). Pontuação, regras e tempos NÃO mudam.
--
-- Pré-requisito de deploy: o client da mesma branch (migrateHost/addBot via
-- RPC, sem leitura de room_words.meaning). Aplicar esta migration e publicar
-- o web na sequência (janela de ~2 min em que o client antigo não consegue
-- adicionar bot nem migrar host — o resto do jogo segue normal).
--
-- ROLLBACK (emergência; reabre os vetores):
--   GRANT INSERT, UPDATE, DELETE ON public.players, public.definitions,
--     public.rounds, public.round_extensions, public.room_words,
--     public.reactions TO anon, authenticated;
--   GRANT INSERT ON public.rooms TO anon, authenticated;
--   GRANT UPDATE (host_id) ON public.rooms TO anon, authenticated;
--   GRANT SELECT ON public.room_words TO anon, authenticated;
--   recriar as policies removidas (ver 20260517234649, 20260510020212,
--   20260518230317, 20260517204253, 20260518234116, 20260520004732);
--   DROP FUNCTION public.migrate_host(uuid);
--   DROP FUNCTION public.add_bot(uuid, text, text, text, text, text);
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO PUBLIC;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT ALL ON TABLES TO anon, authenticated;
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0) Sessão obrigatória para agir em nome de um jogador
--    As guardas de identidade (fase S4) LIBERAVAM qualquer chamada sem
--    sessão — e um atacante simplesmente não abre sessão: sem ela dava para
--    sobrescrever o voto ou a definição de outro jogador, tirá-lo da sala
--    ou zerar o placar dele via join_public_room. O client sempre abre
--    sessão anônima no boot e antes de criar/entrar; chamada da API PÚBLICA
--    sem sessão passa a ser negada. Cron, SQL interno e chave de serviço
--    (papel diferente de anon/authenticated) seguem liberados.
--    O papel vem do GUC 'role' (SET ROLE do PostgREST), que SECURITY
--    DEFINER não altera — independe do formato da chave usada.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_sessionless_api_call()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT auth.uid() IS NULL
     AND COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated');
$$;

CREATE OR REPLACE FUNCTION public.assert_actor_identity(p_room_id uuid, p_actor_id text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_user_id uuid;
  v_is_bot boolean;
  v_found boolean;
BEGIN
  IF v_uid IS NULL THEN
    IF public.is_sessionless_api_call() THEN RETURN 'session_required'; END IF;
    RETURN NULL;  -- cron / SQL interno / service_role
  END IF;
  SELECT user_id, is_bot, true INTO v_user_id, v_is_bot, v_found
    FROM public.players WHERE id = p_actor_id AND room_id = p_room_id;
  IF NOT COALESCE(v_found, false) THEN RETURN 'actor_not_in_room'; END IF;
  IF COALESCE(v_is_bot, false) THEN RETURN 'actor_is_bot'; END IF;
  IF v_user_id IS NULL THEN RETURN NULL; END IF;  -- legado sem claim (residual)
  IF v_user_id <> v_uid THEN RETURN 'identity_mismatch'; END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_author_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_pid text;
  v_user_id uuid;
  v_is_bot boolean;
BEGIN
  v_pid := COALESCE(to_jsonb(NEW)->>'voter_id', to_jsonb(NEW)->>'player_id');
  IF v_pid IS NULL OR v_pid = '__truth__' THEN RETURN NEW; END IF;
  SELECT user_id, is_bot INTO v_user_id, v_is_bot FROM public.players WHERE id = v_pid;
  -- bot (orquestrado pelo host) ou linha inexistente (FK decide): libera
  IF v_is_bot IS DISTINCT FROM false THEN RETURN NEW; END IF;
  IF v_uid IS NULL THEN
    IF NOT public.is_sessionless_api_call() THEN RETURN NEW; END IF;  -- cron/service
    IF TG_TABLE_NAME = 'votes' THEN RETURN NULL; END IF;
    RAISE EXCEPTION 'session_required: % em %', v_pid, TG_TABLE_NAME;
  END IF;
  IF v_user_id IS NULL OR v_user_id = v_uid THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'votes' THEN
    RETURN NULL;  -- descarta a linha forjada sem abortar o lote (cast_votes_bulk)
  END IF;
  RAISE EXCEPTION 'identity_mismatch: % em %', v_pid, TG_TABLE_NAME;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1) create_room_with_host passa a SECURITY DEFINER
--    (rodava como o próprio client e dependia do INSERT/UPDATE direto em
--    rooms/players que esta migration fecha). Corpo idêntico ao de
--    20260722100000 + sessão obrigatória + limites nos textos livres.
-- ---------------------------------------------------------------------------
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
  v_claimed_by uuid;
  v_nick text := left(btrim(COALESCE(p_nickname, '')), 24);
BEGIN
  IF public.is_sessionless_api_call() THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_host_id IS NULL OR char_length(p_host_id) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid_player_id';
  END IF;
  IF v_nick = '' THEN v_nick := 'Anônimo'; END IF;

  -- S4: impede que alguém "crie sala" com o player_id de outra pessoa —
  -- o ON CONFLICT abaixo moveria a vítima de sala.
  SELECT user_id INTO v_claimed_by FROM public.players WHERE id = p_host_id;
  IF v_claimed_by IS NOT NULL AND v_uid IS NOT NULL AND v_claimed_by <> v_uid THEN
    RAISE EXCEPTION 'player_id_taken';
  END IF;

  LOOP
    v_code := lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code);
    v_attempts := v_attempts + 1;
    IF v_attempts > 8 THEN
      RAISE EXCEPTION 'could not generate unique room code';
    END IF;
  END LOOP;

  INSERT INTO public.rooms (code, host_id, status)
  VALUES (v_code, p_host_id, 'lobby')
  RETURNING * INTO v_room;

  INSERT INTO public.players (id, room_id, nickname, avatar, color, user_id)
  VALUES (p_host_id, v_room.id, v_nick, left(p_avatar, 16), left(p_color, 32), v_uid)
  ON CONFLICT (id) DO UPDATE SET
    room_id = EXCLUDED.room_id,
    nickname = EXCLUDED.nickname,
    avatar = EXCLUDED.avatar,
    color = EXCLUDED.color,
    is_connected = true,
    user_id = COALESCE(public.players.user_id, EXCLUDED.user_id);

  RETURN v_room;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2) migrate_host: substitui o UPDATE direto de rooms.host_id (SM-04/SEC-02)
--    Regra idêntica à do client (room.$code.tsx): só age se o host atual NÃO
--    está mais na sala (linha removida ou expulsa); o herdeiro é o humano
--    vivo mais antigo (joined_at, id). O servidor calcula o herdeiro — quem
--    chama não escolhe. Idempotente; sob lock da sala.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.migrate_host(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_heir text;
  v_uid uuid := auth.uid();
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.players
    WHERE id = v_room.host_id AND room_id = p_room_id AND kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'host_id', v_room.host_id);
  END IF;

  -- Com sessão, só membro vivo da sala aciona (cron/sem sessão: liberado,
  -- mesma convenção de assert_actor_identity).
  IF v_uid IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE room_id = p_room_id AND user_id = v_uid AND kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;

  SELECT id INTO v_heir FROM public.players
  WHERE room_id = p_room_id AND is_bot = false AND kicked_at IS NULL
  ORDER BY joined_at, id
  LIMIT 1;
  IF v_heir IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_heir');
  END IF;

  UPDATE public.rooms SET host_id = v_heir WHERE id = p_room_id;
  RETURN jsonb_build_object('ok', true, 'changed', true, 'host_id', v_heir);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3) add_bot: substitui o INSERT direto em players (RT-01)
--    Regra atual preservada: qualquer jogador vivo da sala adiciona bots no
--    lobby, até 12 participantes. O id vem do client (otimismo da UI) mas é
--    validado; textos livres têm limite.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_bot(
  p_room_id uuid,
  p_actor_id text,
  p_bot_id text,
  p_nickname text,
  p_avatar text,
  p_color text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_reason text;
  v_nick text := left(btrim(COALESCE(p_nickname, '')), 24);
BEGIN
  IF p_room_id IS NULL OR p_actor_id IS NULL OR p_bot_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;
  IF p_bot_id !~ '^bot_[a-z0-9]{4,16}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_bot_id');
  END IF;
  IF v_nick = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_nickname');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.status <> 'lobby' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_lobby');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE id = p_actor_id AND room_id = p_room_id AND kicked_at IS NULL AND is_bot = false
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, p_actor_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;

  IF (SELECT count(*) FROM public.players WHERE room_id = p_room_id AND kicked_at IS NULL) >= 12 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_full');
  END IF;

  INSERT INTO public.players (id, room_id, nickname, avatar, color, is_bot)
  VALUES (p_bot_id, p_room_id, v_nick, left(p_avatar, 16), left(p_color, 32), true)
  ON CONFLICT (id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bot_id_taken');
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', p_bot_id);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3b) RPCs que agem em nome de um jogador: identidade + sessão
-- ---------------------------------------------------------------------------

-- rejoin_room (corpo de 20260722130000): sessão obrigatória + limites.
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

  SELECT * INTO v_existing FROM public.players WHERE id = p_player_id AND room_id = v_room.id LIMIT 1;

  IF v_existing.id IS NOT NULL AND v_existing.user_id IS NOT NULL
     AND v_uid IS NOT NULL AND v_existing.user_id <> v_uid THEN
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
          -- jogador era dispensado da rodada — voto ignorado).
          joined_at = CASE
            WHEN v_existing.kicked_at IS NOT NULL
                 AND v_room.status IN ('writing','voting') THEN now()
            ELSE v_existing.joined_at
          END,
          nickname = COALESCE(NULLIF(v_nick, ''), nickname),
          avatar = COALESCE(NULLIF(left(p_avatar, 16), ''), avatar),
          color = COALESCE(NULLIF(left(p_color, 32), ''), color)
      WHERE id = p_player_id;
  ELSE
    INSERT INTO public.players (id, room_id, nickname, avatar, color, is_connected, user_id)
    VALUES (p_player_id, v_room.id, COALESCE(NULLIF(v_nick, ''), 'Anônimo'),
            left(p_avatar, 16), left(p_color, 32), true, v_uid);
  END IF;

  RETURN to_jsonb(v_room);
END;
$function$;

-- join_public_room (corpo de 20260713130000): o ON CONFLICT movia de sala e
-- ZERAVA o placar de qualquer jogador cujo id fosse informado. Agora: sessão
-- obrigatória, id de outra identidade é recusado e a linha nasce reivindicada.
CREATE OR REPLACE FUNCTION public.join_public_room(
  p_player_id text,
  p_nickname text,
  p_avatar text,
  p_color text
) RETURNS public.rooms
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_code text;
  v_attempts int := 0;
  v_uid uuid := auth.uid();
  v_claimed_by uuid;
  v_nick text := COALESCE(NULLIF(left(btrim(COALESCE(p_nickname, '')), 24), ''), 'Anônimo');
BEGIN
  IF public.is_sessionless_api_call() THEN
    RAISE EXCEPTION 'session_required';
  END IF;
  IF p_player_id IS NULL OR char_length(p_player_id) NOT BETWEEN 1 AND 64 THEN
    RAISE EXCEPTION 'invalid_player_id';
  END IF;
  SELECT user_id INTO v_claimed_by FROM public.players WHERE id = p_player_id;
  IF v_claimed_by IS NOT NULL AND v_uid IS NOT NULL AND v_claimed_by <> v_uid THEN
    RAISE EXCEPTION 'player_id_taken';
  END IF;

  -- Bloqueia banidos (mesma checagem do fluxo de entrar com código)
  IF public.is_player_banned(p_player_id, v_uid) THEN
    RAISE EXCEPTION 'player_banned';
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
    -- Nenhum lobby aberto: cria sala pública nova com o chamador como host
    LOOP
      v_code := lpad((1000 + floor(random() * 9000))::int::text, 4, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.rooms WHERE code = v_code);
      v_attempts := v_attempts + 1;
      IF v_attempts > 8 THEN
        RAISE EXCEPTION 'could not generate unique room code';
      END IF;
    END LOOP;

    INSERT INTO public.rooms (code, host_id, status, visibility)
    VALUES (v_code, p_player_id, 'lobby', 'public')
    RETURNING * INTO v_room;
  END IF;

  INSERT INTO public.players (id, room_id, nickname, avatar, color, user_id)
  VALUES (p_player_id, v_room.id, v_nick, left(p_avatar, 16), left(p_color, 32), v_uid)
  ON CONFLICT (id) DO UPDATE SET
    room_id = EXCLUDED.room_id,
    nickname = EXCLUDED.nickname,
    avatar = EXCLUDED.avatar,
    color = EXCLUDED.color,
    score = 0,
    coordinator_count = 0,
    writing_extensions = 0,
    voting_extensions = 0,
    kicked_at = NULL,
    is_connected = true,
    user_id = COALESCE(public.players.user_id, EXCLUDED.user_id);

  RETURN v_room;
END;
$function$;

-- leave_room (corpo de 20260607221241): qualquer um "tirava" qualquer
-- jogador da sala (no lobby a linha é apagada — inclusive a do host).
CREATE OR REPLACE FUNCTION public.leave_room(
  p_player_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player public.players;
  v_room public.rooms;
  v_reason text;
BEGIN
  IF p_player_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  SELECT * INTO v_player FROM public.players WHERE id = p_player_id LIMIT 1;
  IF v_player IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'noop', true);
  END IF;

  v_reason := public.assert_actor_identity(v_player.room_id, p_player_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = v_player.room_id;

  -- No lobby (ou se a sala sumiu) podemos remover o registro;
  -- em qualquer fase ativa, só marcamos como desconectado p/ preservar histórico.
  IF v_room IS NULL OR v_room.status IN ('lobby','finished') THEN
    DELETE FROM public.players WHERE id = p_player_id;
  ELSE
    UPDATE public.players
       SET is_connected = false
     WHERE id = p_player_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- submit_definition (corpo de 20260722130000) + identidade explícita: o
-- gatilho já barrava, mas como exceção genérica; agora o client recebe o
-- motivo.
CREATE OR REPLACE FUNCTION public.submit_definition(p_room_id uuid, p_player_id text, p_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_room public.rooms;
  v_clean text;
  v_norm text;
  v_id uuid;
  v_reason text;
BEGIN
  IF p_room_id IS NULL OR p_player_id IS NULL OR p_text IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  v_clean := substring(btrim(p_text) from 1 for 140);
  IF char_length(v_clean) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_text');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.status <> 'writing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  END IF;
  IF v_room.current_coordinator = p_player_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'coordinator_cannot_write');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE id = p_player_id AND room_id = p_room_id AND kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, p_player_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;

  v_norm := regexp_replace(lower(unaccent(v_clean)), '[^a-z0-9]+', ' ', 'g');

  -- Idêntica (normalizada)
  IF char_length(btrim(v_norm)) > 0 AND EXISTS (
    SELECT 1 FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.player_id <> p_player_id
      AND regexp_replace(lower(unaccent(d.text)), '[^a-z0-9]+', ' ', 'g') = v_norm
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'duplicate_definition');
  END IF;

  -- Muito parecida (playtest: IA/bots convergiam em textos quase iguais,
  -- ex.: "excesso de elegancia mundana" vs "excesso de elegancia formal")
  IF char_length(btrim(v_norm)) > 12 AND EXISTS (
    SELECT 1 FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.player_id <> p_player_id
      AND similarity(
            regexp_replace(lower(unaccent(d.text)), '[^a-z0-9]+', ' ', 'g'),
            v_norm
          ) > 0.62
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'too_similar');
  END IF;

  INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
  VALUES (p_room_id, v_room.current_round, p_player_id, v_clean, false)
  ON CONFLICT (room_id, round, player_id)
    DO UPDATE SET text = EXCLUDED.text, created_at = now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'id', v_id);
END;
$function$;

-- cast_vote (corpo de 20260721140000) + identidade explícita: o ON CONFLICT
-- DO UPDATE deixava qualquer chamador sem sessão TROCAR o voto alheio.
CREATE OR REPLACE FUNCTION public.cast_vote(p_room_id uuid, p_voter_id text, p_definition_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_def public.definitions;
  v_reason text;
BEGIN
  IF p_room_id IS NULL OR p_voter_id IS NULL OR p_definition_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  -- Lock da sala: serializa com advance_voting_to_reveal/extends.
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.status <> 'voting' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'wrong_phase');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.players
    WHERE id = p_voter_id AND room_id = p_room_id AND kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, p_voter_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;

  SELECT * INTO v_def FROM public.definitions WHERE id = p_definition_id;
  IF v_def IS NULL
     OR v_def.room_id <> p_room_id
     OR v_def.round <> v_room.current_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'definition_not_in_round');
  END IF;

  IF v_def.player_id = p_voter_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cannot_vote_own');
  END IF;

  INSERT INTO public.votes (room_id, round, voter_id, definition_id)
  VALUES (p_room_id, v_room.current_round, p_voter_id, p_definition_id)
  ON CONFLICT (room_id, round, voter_id)
    DO UPDATE SET definition_id = EXCLUDED.definition_id,
                  created_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- Lotes dos bots (corpos de 20260721130000/20260721140000): o client só
-- orquestra bots no navegador do HOST; o servidor passa a exigir a sessão
-- do host. Antes, qualquer um fazia todos os bots votarem no próprio blefe
-- (+1 por bot por rodada) ou escrevia pelos bots.
CREATE OR REPLACE FUNCTION public.submit_bot_definitions_bulk(p_room_id uuid, p_round integer, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_room public.rooms;
  v_row jsonb;
  v_pid text;
  v_text text;
  v_norm text;
  v_inserted int := 0;
  v_reason text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL OR v_room.status <> 'writing' OR v_room.current_round <> p_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, v_room.host_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb))
  LOOP
    v_pid := v_row->>'player_id';
    v_text := substring(btrim(COALESCE(v_row->>'text', '')) from 1 for 140);
    IF v_pid IS NULL OR char_length(v_text) = 0 THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.players
      WHERE id = v_pid AND room_id = p_room_id AND is_bot = true AND kicked_at IS NULL
    ) THEN CONTINUE; END IF;

    -- Dedup: pula se o texto normalizado já existe na rodada (humanos,
    -- outros bots ou a verdade) — antes a IA podia clonar o texto de um
    -- jogador e o duplicado entrava.
    v_norm := regexp_replace(lower(extensions.unaccent(v_text)), '[^a-z0-9]+', ' ', 'g');
    IF EXISTS (
      SELECT 1 FROM public.definitions d
      WHERE d.room_id = p_room_id AND d.round = p_round
        AND d.player_id <> v_pid
        AND regexp_replace(lower(extensions.unaccent(d.text)), '[^a-z0-9]+', ' ', 'g') = v_norm
    ) THEN CONTINUE; END IF;

    INSERT INTO public.definitions (room_id, round, player_id, text, is_truth)
    VALUES (p_room_id, p_round, v_pid, v_text, false)
    ON CONFLICT (room_id, round, player_id) DO NOTHING;

    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'inserted', v_inserted);
END;
$function$;

CREATE OR REPLACE FUNCTION public.cast_votes_bulk(p_room_id uuid, p_round integer, p_votes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_inserted int := 0;
  v_row jsonb;
  v_voter text;
  v_def_id uuid;
  v_reason text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL OR v_room.status <> 'voting' OR v_room.current_round <> p_round THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, v_room.host_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  FOR v_row IN SELECT * FROM jsonb_array_elements(COALESCE(p_votes, '[]'::jsonb))
  LOOP
    v_voter := v_row->>'voter_id';
    v_def_id := NULLIF(v_row->>'definition_id', '')::uuid;
    IF v_voter IS NULL OR v_def_id IS NULL THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.players
      WHERE id = v_voter AND room_id = p_room_id AND is_bot = true AND kicked_at IS NULL
    ) THEN CONTINUE; END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.definitions d
      WHERE d.id = v_def_id
        AND d.room_id = p_room_id
        AND d.round = p_round
        AND d.player_id <> v_voter
    ) THEN
      SELECT d.id INTO v_def_id
      FROM public.definitions d
      WHERE d.room_id = p_room_id
        AND d.round = p_round
        AND d.letter IS NOT NULL
        AND d.player_id <> v_voter
      ORDER BY random()
      LIMIT 1;
      IF v_def_id IS NULL THEN CONTINUE; END IF;
    END IF;

    INSERT INTO public.votes (room_id, round, voter_id, definition_id)
    VALUES (p_room_id, p_round, v_voter, v_def_id)
    ON CONFLICT (room_id, round, voter_id) DO NOTHING;

    v_inserted := v_inserted + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'inserted', v_inserted);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4) record_match_result: dedup atômico (SCORE-05)
--    O dedup era check-then-insert: duas chamadas paralelas da mesma pessoa
--    para a mesma sala somavam XP duas vezes. Lock transacional por
--    (usuário, sala) serializa as chamadas; o resto do corpo é idêntico ao de
--    20260720120000 (XP, conquistas e regras inalterados).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_match_result(p_room_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_player public.players;
  v_position int;
  v_players_count int;
  v_truth_hits int;
  v_fooled int;
  v_won boolean;
  v_xp_gained int;
  v_stats public.user_stats;
  v_unlocked text[] := ARRAY[]::text[];
  v_code text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF p_room_code IS NULL OR char_length(p_room_code) NOT BETWEEN 3 AND 12 THEN
    RAISE EXCEPTION 'invalid room_code';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('record_match_result|' || auth.uid()::text || '|' || p_room_code, 0));

  SELECT * INTO v_room FROM public.rooms WHERE code = p_room_code;
  IF v_room IS NULL THEN RAISE EXCEPTION 'room not found'; END IF;
  -- Só partidas encerradas geram estatísticas (anti-replay/prematuro).
  IF v_room.status <> 'finished' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'match_not_finished');
  END IF;

  SELECT * INTO v_player FROM public.players
  WHERE room_id = v_room.id AND user_id = auth.uid() AND is_bot = false
  LIMIT 1;
  IF v_player IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'player_not_linked');
  END IF;

  -- Dedup definitivo por (user, sala)
  IF EXISTS (
    SELECT 1 FROM public.match_history
    WHERE user_id = auth.uid() AND room_code = p_room_code
  ) THEN
    RETURN jsonb_build_object('ok', true, 'deduped', true, 'xp_gained', 0, 'unlocked', '[]'::jsonb);
  END IF;

  -- Derivados 100% das tabelas oficiais
  SELECT count(*) INTO v_players_count FROM public.players WHERE room_id = v_room.id;
  SELECT 1 + count(*) INTO v_position FROM public.players
  WHERE room_id = v_room.id AND score > v_player.score;

  SELECT count(*) INTO v_truth_hits
  FROM public.votes v
  JOIN public.definitions d ON d.id = v.definition_id
  WHERE v.room_id = v_room.id AND v.voter_id = v_player.id AND d.is_truth = true;

  SELECT count(*) INTO v_fooled
  FROM public.votes v
  JOIN public.definitions d ON d.id = v.definition_id
  WHERE v.room_id = v_room.id AND d.player_id = v_player.id
    AND d.is_truth = false AND v.voter_id <> v_player.id;

  INSERT INTO public.user_stats (user_id) VALUES (auth.uid())
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.match_history (user_id, room_code, final_score, position, players_count)
  VALUES (auth.uid(), p_room_code, v_player.score, v_position, v_players_count);

  v_won := (v_position = 1);
  v_xp_gained := 20
    + (CASE WHEN v_won THEN 100 ELSE 0 END)
    + (v_truth_hits * 50)
    + (v_fooled * 30);

  UPDATE public.user_stats SET
    games_played = games_played + 1,
    games_won = games_won + (CASE WHEN v_won THEN 1 ELSE 0 END),
    total_score = total_score + v_player.score,
    best_match_score = GREATEST(best_match_score, v_player.score),
    rounds_coordinated = rounds_coordinated + v_player.coordinator_count,
    total_truth_hits = total_truth_hits + v_truth_hits,
    total_fooled = total_fooled + v_fooled,
    win_streak = (CASE WHEN v_won THEN win_streak + 1 ELSE 0 END),
    best_win_streak = GREATEST(best_win_streak, (CASE WHEN v_won THEN win_streak + 1 ELSE 0 END)),
    xp = xp + v_xp_gained,
    level = public.xp_to_level(xp + v_xp_gained),
    updated_at = now()
  WHERE user_id = auth.uid()
  RETURNING * INTO v_stats;

  FOR v_code IN
    SELECT code FROM (VALUES
      ('first_win',       v_stats.games_won >= 1),
      ('partidas_10',     v_stats.games_played >= 10),
      ('acertos_100',     v_stats.total_truth_hits >= 100),
      ('bluffs_100',      v_stats.total_fooled >= 100),
      ('invicto_3',       v_stats.win_streak >= 3),
      ('maior_enganador', v_fooled >= 5)
    ) AS checks(code, met)
    WHERE met
      AND EXISTS (SELECT 1 FROM public.achievements a WHERE a.code = checks.code)
      AND NOT EXISTS (
        SELECT 1 FROM public.user_achievements ua
        WHERE ua.user_id = auth.uid() AND ua.achievement_code = checks.code
      )
  LOOP
    INSERT INTO public.user_achievements (user_id, achievement_code)
    VALUES (auth.uid(), v_code)
    ON CONFLICT DO NOTHING;
    v_unlocked := array_append(v_unlocked, v_code);
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'xp_gained', v_xp_gained,
    'xp_total', v_stats.xp,
    'level', v_stats.level,
    'unlocked', to_jsonb(v_unlocked)
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5) Tabelas de jogo: SOMENTE LEITURA para os clients
--    REVOKE na tabela também revoga os grants por coluna (inclui o antigo
--    GRANT UPDATE (host_id) ON rooms e o INSERT por coluna de definitions).
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
  public.players,
  public.definitions,
  public.votes,
  public.rounds,
  public.round_extensions,
  public.rooms,
  public.room_words,
  public.reactions,
  public.room_messages,
  public.words
FROM anon, authenticated;

DROP POLICY IF EXISTS "players public insert" ON public.players;
DROP POLICY IF EXISTS "players public update" ON public.players;
DROP POLICY IF EXISTS "definitions public update" ON public.definitions;
DROP POLICY IF EXISTS "definitions public delete" ON public.definitions;
DROP POLICY IF EXISTS "rounds open insert" ON public.rounds;
DROP POLICY IF EXISTS "rounds public delete" ON public.rounds;
DROP POLICY IF EXISTS "round_extensions open insert" ON public.round_extensions;
DROP POLICY IF EXISTS "rooms public insert" ON public.rooms;
DROP POLICY IF EXISTS "rooms public update" ON public.rooms;
DROP POLICY IF EXISTS "room_words public insert" ON public.room_words;
DROP POLICY IF EXISTS "room_words delete only in lobby/choosing" ON public.room_words;
DROP POLICY IF EXISTS "reactions public insert" ON public.reactions;

-- room_words: o significado de palavra customizada segue o mesmo princípio
-- de words — nunca legível pelo client; chega só via get_word_reveal() a
-- partir da revelação (SEC-04).
REVOKE SELECT ON public.room_words FROM anon, authenticated;
GRANT SELECT (id, room_id, word, category, created_by, created_at) ON public.room_words TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6) EXECUTE: RPCs novas explícitas; internas fechadas por NOME (cobre
--    sobrecargas e não depende de assinatura exata). REVOKE FROM PUBLIC não
--    basta no Supabase: anon/authenticated recebem EXECUTE direto pelos
--    privilégios padrão.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.migrate_host(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.migrate_host(uuid) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.add_bot(uuid, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_bot(uuid, text, text, text, text, text) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_room_with_host(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_room_with_host(text, text, text, text) TO anon, authenticated, service_role;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = ANY (ARRAY[
        'apply_similarity_bonus',        -- só a edge score-similarity (service_role)
        'tick_stalled_rooms',            -- cron
        'cleanup_zombie_rooms',          -- cron
        'advance_choosing_to_writing',   -- cron
        'advance_reveal_to_scoreboard',  -- cron (o client usa finish_reveal)
        'get_app_config',                -- interna
        'assert_actor_identity',         -- interna
        'guard_author_identity',         -- trigger
        'guard_no_self_vote',            -- trigger
        'guard_writing_phase_advance',   -- trigger
        'handle_new_user',               -- trigger de auth.users
        'get_random_words',              -- devolve meaning; o client usa get_random_word_prompts
        'submit_daily_attempt',          -- legado; o servidor usa a versão _scored
        'submit_daily_attempt_scored',   -- só server function (service_role)
        'insert_truth_definition',       -- deixava QUALQUER um plantar/trocar a
                                         -- definição verdadeira (+3 garantido);
                                         -- a verdade é inserida pelo servidor
                                         -- em advance_writing_to_voting
        'is_sessionless_api_call'        -- auxiliar interno das guardas
      ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION public.apply_similarity_bonus(uuid, integer, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_similarity_bonus(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_daily_attempt_scored(uuid, text, integer, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 7) Privilégios padrão: objetos NOVOS nascem fechados para os clients.
--    Toda RPC/tabela futura que o client precise usar exige GRANT explícito
--    na própria migration (a suíte de segurança do CI compara a lista de
--    funções executáveis por anon/authenticated com uma allowlist).
-- ---------------------------------------------------------------------------
-- O EXECUTE de PUBLIC é padrão GLOBAL do Postgres: só um ALTER sem IN SCHEMA
-- o remove (um REVOKE por schema apenas desfaz GRANTs por schema, como os
-- que o Supabase dá a anon/authenticated).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
