-- =============================================================================
-- Fase 1 · parte 4 — Identidade de jogador via auth.uid() (S4)
--
-- Modelo: convidados entram com Supabase anonymous sign-in; cada linha de
-- players é REIVINDICADA no momento do join/create (user_id = auth.uid()).
-- As guardas apenas VERIFICAM — nunca reivindicam tardiamente, porque os
-- player_ids são visíveis a todos os membros da sala (get_room_state) e uma
-- reivindicação "na primeira ação" permitiria roubar a linha do host.
--
-- Fallback documentado (anonymous auth desativado / cron / service_role /
-- clientes antigos sem sessão): auth.uid() é NULL e todas as guardas liberam,
-- preservando o comportamento atual. A proteção liga sozinha quando o
-- anonymous sign-in for habilitado no projeto (Authentication → Sign In/Up).
--
-- Riscos residuais aceitos nesta parte (documentados em docs/security-audit.md):
--   • linhas legadas com user_id NULL seguem sem enforcement até rejoin;
--   • bots (is_bot) são orquestrados pelo client do host — sem identidade;
--   • choose_word/extensões continuam gated só por sala+fase (sem ator).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Helper de verificação de ator (verify-only, nunca reivindica)
-- ---------------------------------------------------------------------------
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
  IF v_uid IS NULL THEN RETURN NULL; END IF;  -- fallback sem sessão
  SELECT user_id, is_bot, true INTO v_user_id, v_is_bot, v_found
    FROM public.players WHERE id = p_actor_id AND room_id = p_room_id;
  IF NOT COALESCE(v_found, false) THEN RETURN 'actor_not_in_room'; END IF;
  IF COALESCE(v_is_bot, false) THEN RETURN 'actor_is_bot'; END IF;
  IF v_user_id IS NULL THEN RETURN NULL; END IF;  -- legado sem claim (residual)
  IF v_user_id <> v_uid THEN RETURN 'identity_mismatch'; END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.assert_actor_identity(uuid, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Trigger de guarda nas tabelas de autoria (defesa em profundidade:
--    cobre RPCs SECURITY DEFINER e qualquer caminho direto via RLS)
-- ---------------------------------------------------------------------------
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
  IF v_uid IS NULL THEN RETURN NEW; END IF;  -- cron/service/sem sessão
  v_pid := CASE WHEN TG_TABLE_NAME = 'votes' THEN NEW.voter_id ELSE NEW.player_id END;
  IF v_pid IS NULL OR v_pid = '__truth__' THEN RETURN NEW; END IF;
  SELECT user_id, is_bot INTO v_user_id, v_is_bot FROM public.players WHERE id = v_pid;
  -- bot (orquestrado pelo host) ou linha inexistente (FK decide): libera
  IF v_is_bot IS DISTINCT FROM false THEN RETURN NEW; END IF;
  IF v_user_id IS NULL OR v_user_id = v_uid THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'votes' THEN
    RETURN NULL;  -- descarta a linha forjada sem abortar o lote (cast_votes_bulk)
  END IF;
  RAISE EXCEPTION 'identity_mismatch: % em %', v_pid, TG_TABLE_NAME;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.guard_author_identity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_identity ON public.votes;
CREATE TRIGGER trg_guard_identity BEFORE INSERT ON public.votes
  FOR EACH ROW EXECUTE FUNCTION public.guard_author_identity();

DROP TRIGGER IF EXISTS trg_guard_identity ON public.definitions;
CREATE TRIGGER trg_guard_identity BEFORE INSERT ON public.definitions
  FOR EACH ROW EXECUTE FUNCTION public.guard_author_identity();

DROP TRIGGER IF EXISTS trg_guard_identity ON public.room_messages;
CREATE TRIGGER trg_guard_identity BEFORE INSERT ON public.room_messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_author_identity();

DROP TRIGGER IF EXISTS trg_guard_identity ON public.reactions;
CREATE TRIGGER trg_guard_identity BEFORE INSERT ON public.reactions
  FOR EACH ROW EXECUTE FUNCTION public.guard_author_identity();

-- ---------------------------------------------------------------------------
-- 3) Claim no momento do join/create + bloqueio de sequestro de player_id
-- ---------------------------------------------------------------------------
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
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE code = p_code LIMIT 1;
  IF v_room IS NULL THEN
    RAISE EXCEPTION 'room_not_found';
  END IF;

  SELECT * INTO v_existing FROM public.players WHERE id = p_player_id AND room_id = v_room.id LIMIT 1;

  -- S4: player_id já reivindicado por OUTRA identidade → nega o rejoin.
  -- O client trata 'player_id_taken' gerando um novo id local.
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
          -- Se a sala está em fase ativa, "renova" o joined_at para que o
          -- jogador seja tratado como entrada tardia e não leve penalidade
          -- na rodada que já estava em andamento.
          joined_at = CASE
            WHEN v_room.status IN ('writing','voting') THEN now()
            ELSE v_existing.joined_at
          END,
          nickname = COALESCE(NULLIF(p_nickname, ''), nickname),
          avatar = COALESCE(NULLIF(p_avatar, ''), avatar),
          color = COALESCE(NULLIF(p_color, ''), color)
      WHERE id = p_player_id;
  ELSE
    INSERT INTO public.players (id, room_id, nickname, avatar, color, is_connected, user_id)
    VALUES (p_player_id, v_room.id, p_nickname, p_avatar, p_color, true, v_uid);
  END IF;

  RETURN to_jsonb(v_room);
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_room_with_host(p_host_id text, p_nickname text, p_avatar text, p_color text)
RETURNS rooms
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_code text;
  v_room public.rooms;
  v_attempts int := 0;
  v_uid uuid := auth.uid();
  v_claimed_by uuid;
BEGIN
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
  VALUES (p_host_id, v_room.id, p_nickname, p_avatar, p_color, v_uid)
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
-- 4) RPCs de ação: ator passa a ser validado contra auth.uid()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kick_player(p_room_id uuid, p_actor_id text, p_target_player_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_reason text;
BEGIN
  IF p_room_id IS NULL OR p_actor_id IS NULL OR p_target_player_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.host_id <> p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_host');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, p_actor_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;
  IF p_target_player_id = p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cannot_kick_self');
  END IF;

  -- No lobby, remove definitivamente (não há histórico ainda).
  IF v_room.status = 'lobby' THEN
    DELETE FROM public.players
      WHERE id = p_target_player_id AND room_id = p_room_id;
  ELSE
    UPDATE public.players
       SET kicked_at = now(), is_connected = false
     WHERE id = p_target_player_id AND room_id = p_room_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.assign_player_team(p_room_id uuid, p_actor_id text, p_player_id text, p_team_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_reason text;
BEGIN
  IF p_room_id IS NULL OR p_actor_id IS NULL OR p_player_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.host_id <> p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_host');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, p_actor_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;
  IF v_room.status <> 'lobby' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_lobby');
  END IF;

  UPDATE public.players
     SET team_id = NULLIF(p_team_id, '')
   WHERE id = p_player_id AND room_id = p_room_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- host_update_room_config: idêntica à versão vigente + assert do ator
CREATE OR REPLACE FUNCTION public.host_update_room_config(p_room_id uuid, p_actor_id text, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_reason text;
  v_win_condition text;
  v_win_target int;
  v_mode text;
  v_nivel text;
  v_categories text[];
  v_teams jsonb;
BEGIN
  IF p_room_id IS NULL OR p_actor_id IS NULL OR p_patch IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.host_id <> p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_host');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, p_actor_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;
  IF v_room.status <> 'lobby' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_lobby');
  END IF;

  IF p_patch ? 'win_condition' THEN
    v_win_condition := p_patch->>'win_condition';
    IF v_win_condition NOT IN ('score','rounds') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_win_condition');
    END IF;
    UPDATE public.rooms SET win_condition = v_win_condition WHERE id = p_room_id;
  END IF;

  IF p_patch ? 'win_target' THEN
    v_win_target := (p_patch->>'win_target')::int;
    IF v_win_target IS NULL OR v_win_target < 1 OR v_win_target > 5000 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_win_target');
    END IF;
    UPDATE public.rooms SET win_target = v_win_target WHERE id = p_room_id;
  END IF;

  IF p_patch ? 'nivel' THEN
    v_nivel := p_patch->>'nivel';
    IF v_nivel NOT IN ('facil', 'medio', 'dificil', 'insano', 'aleatorio') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_nivel');
    END IF;
    UPDATE public.rooms SET nivel = v_nivel WHERE id = p_room_id;
  END IF;

  IF p_patch ? 'categories' THEN
    SELECT array_agg(substring(btrim(value::text, '"') from 1 for 40))
      INTO v_categories
      FROM jsonb_array_elements_text(p_patch->'categories') AS t(value)
      WHERE char_length(btrim(value::text, '"')) BETWEEN 1 AND 40;
    UPDATE public.rooms SET categories = COALESCE(v_categories, '{}'::text[]) WHERE id = p_room_id;
  END IF;

  IF p_patch ? 'mode' THEN
    v_mode := p_patch->>'mode';
    IF v_mode NOT IN ('individual','teams') THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_mode');
    END IF;
    UPDATE public.rooms SET mode = v_mode WHERE id = p_room_id;
    IF v_mode = 'individual' THEN
      UPDATE public.players SET team_id = NULL WHERE room_id = p_room_id;
    END IF;
  END IF;

  IF p_patch ? 'teams' THEN
    v_teams := p_patch->'teams';
    IF jsonb_typeof(v_teams) <> 'array' THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'invalid_teams');
    END IF;
    IF jsonb_array_length(v_teams) > 8 THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'too_many_teams');
    END IF;
    UPDATE public.rooms SET teams = v_teams WHERE id = p_room_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- start_game / reset_room: sem parâmetro de ator — valida contra o host da sala
CREATE OR REPLACE FUNCTION public.start_game(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_reason text;
  v_min_count int;
  v_next_coordinator text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found'); END IF;
  IF v_room.status <> 'lobby' THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state'); END IF;
  v_reason := public.assert_actor_identity(p_room_id, v_room.host_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  UPDATE public.players
  SET score = 0, coordinator_count = 0, writing_extensions = 0, voting_extensions = 0
  WHERE room_id = p_room_id;
  DELETE FROM public.definitions WHERE room_id = p_room_id;
  DELETE FROM public.votes WHERE room_id = p_room_id;
  DELETE FROM public.rounds WHERE room_id = p_room_id;
  DELETE FROM public.round_extensions WHERE room_id = p_room_id;

  SELECT min(coordinator_count) INTO v_min_count
  FROM public.players WHERE room_id = p_room_id AND kicked_at IS NULL;
  SELECT id INTO v_next_coordinator FROM public.players
  WHERE room_id = p_room_id AND kicked_at IS NULL AND coordinator_count = v_min_count
  ORDER BY random() LIMIT 1;

  UPDATE public.rooms
  SET status = 'choosing',
      current_round = 1,
      current_coordinator = v_next_coordinator,
      current_word_id = NULL,
      round_phase_ends_at = now() + interval '60 seconds',
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true, 'coordinator', v_next_coordinator);
END;
$function$;

CREATE OR REPLACE FUNCTION public.reset_room(p_room_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_host_id text;
  v_reason text;
BEGIN
  SELECT host_id INTO v_host_id FROM public.rooms WHERE id = p_room_id;
  IF v_host_id IS NULL THEN RETURN; END IF;
  v_reason := public.assert_actor_identity(p_room_id, v_host_id);
  IF v_reason IS NOT NULL THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  UPDATE public.players
    SET score = 0, coordinator_count = 0,
        writing_extensions = 0, voting_extensions = 0
    WHERE room_id = p_room_id;
  DELETE FROM public.definitions WHERE room_id = p_room_id;
  DELETE FROM public.votes WHERE room_id = p_room_id;
  DELETE FROM public.rounds WHERE room_id = p_room_id;
  DELETE FROM public.round_extensions WHERE room_id = p_room_id;
  UPDATE public.rooms SET
    status = 'lobby',
    current_round = 0,
    current_coordinator = NULL,
    current_word_id = NULL,
    round_phase_ends_at = NULL
  WHERE id = p_room_id;
END;
$function$;

-- send_reaction / send_room_message: valida o autor (o trigger também cobre,
-- mas aqui devolvemos um reason limpo em vez de exceção)
CREATE OR REPLACE FUNCTION public.send_reaction(p_room_id uuid, p_player_id text, p_emoji text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_last timestamptz;
  v_emoji text;
  v_reason text;
BEGIN
  IF p_room_id IS NULL OR p_player_id IS NULL OR p_emoji IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;

  -- Sanitiza emoji (limita a 8 chars para cobrir emojis compostos)
  v_emoji := substring(p_emoji from 1 for 8);
  IF char_length(v_emoji) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_emoji');
  END IF;

  -- Confirma que o jogador pertence à sala e não foi expulso
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

  -- Rate-limit: 1 reação a cada 800ms por jogador
  SELECT max(created_at) INTO v_last
    FROM public.reactions
    WHERE room_id = p_room_id AND player_id = p_player_id;

  IF v_last IS NOT NULL AND v_last > now() - interval '800 milliseconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cooldown');
  END IF;

  INSERT INTO public.reactions (room_id, player_id, emoji)
  VALUES (p_room_id, p_player_id, v_emoji);

  -- Limpa reactions antigas da sala (>30s) para evitar crescimento
  DELETE FROM public.reactions
    WHERE room_id = p_room_id AND created_at < now() - interval '30 seconds';

  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.send_room_message(p_room_id uuid, p_player_id text, p_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_clean text;
  v_last timestamptz;
  v_reason text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;

  -- Chat desativado durante a rodada (spec)
  IF v_room.status IN ('choosing', 'writing', 'shuffling', 'voting') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'chat_disabled_in_round');
  END IF;

  -- Precisa ser jogador vivo da sala
  IF NOT EXISTS (
    SELECT 1 FROM public.players p
    WHERE p.id = p_player_id AND p.room_id = p_room_id AND p.kicked_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_in_room');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, p_player_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;

  v_clean := substring(btrim(COALESCE(p_text, '')) from 1 for 200);
  IF char_length(v_clean) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty');
  END IF;

  -- Rate-limit: 1 mensagem a cada 800ms por jogador
  SELECT max(created_at) INTO v_last FROM public.room_messages
  WHERE room_id = p_room_id AND player_id = p_player_id;
  IF v_last IS NOT NULL AND v_last > now() - interval '800 milliseconds' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'rate_limited');
  END IF;

  INSERT INTO public.room_messages (room_id, player_id, text)
  VALUES (p_room_id, p_player_id, v_clean);

  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5) Higiene de grants: trigger functions não precisam de EXECUTE de clients
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.guard_no_self_vote() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.guard_writing_phase_advance() FROM PUBLIC, anon, authenticated;
