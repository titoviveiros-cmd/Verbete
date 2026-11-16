-- =============================================================================
-- Privacidade das salas — FASE 2 (12/11/2026): players, tabelas ligadas,
-- RPCs de leitura por id e canais Realtime privados.
--
-- DEPENDE de 20261112110000_rooms_leitura_restrita (PR #74): usa as funções
-- public.is_room_participant(uuid) e public.my_room_ids() criadas lá.
--
-- PROBLEMA (catálogo de produção de 12/11, CONFIRMADO): players, votes,
-- reactions, round_extensions, rounds, room_messages e room_words têm
-- "FOR SELECT USING (true)" para PUBLIC — sem sessão, qualquer um lista
-- apelidos, user_id e room_id de TODAS as salas. Com um room_id, as RPCs
-- SECURITY DEFINER get_round_sync, get_ballot, get_room_definitions,
-- get_room_reveal, get_round_reveal e get_word_reveal mostram a partida sem
-- entrar. E os canais Realtime broadcast/presence "room:<id>" são públicos
-- (qualquer um que saiba o id ouve e fala).
--
-- O QUE MUDA
--   1. As 7 tabelas: some o SELECT geral. Lê a linha só quem PARTICIPA da
--      sala dela (players com user_id = auth.uid(), inclusive expulso —
--      mesma regra do #74), papel authenticated. anon (sem sessão) = 0
--      linhas. service_role e funções SECURITY DEFINER seguem lendo tudo.
--      Realtime postgres_changes dessas tabelas passa pela mesma RLS.
--   2. As 6 RPCs de leitura por id: quem não participa recebe a MESMA
--      resposta de sala inexistente. Chamadas internas (service_role, cron,
--      SQL do dono, e o get_room_state do participante) não mudam.
--      Corpos = os de produção + 4 linhas de guarda (marcadas "PF2").
--   3. Realtime Authorization (canais PRIVADOS): políticas em
--      realtime.messages deixam receber/enviar broadcast e presença só em
--        room:<id da sala>  e  reactions:<id da sala>  → participante
--        latency:<auth.uid()>                          → a própria sessão
--      O app novo assina os canais com { private: true }. Canais PÚBLICOS
--      (o app Android vc8) não passam por estas políticas — seguem abertos
--      até a opção "Allow public access" do Realtime ser desligada no painel
--      (decisão do dono, depois do vc9; ver o runbook).
--
-- NÃO MEXE: rooms (#74), get_room_state/record_match_result (#74),
-- rejoin_room (#73), RPCs de escrita, definitions (já fechada), service_role.
-- ROLLBACK: supabase/rollback/privacidade_fase2.sql (ANTES do rollback do #74,
-- que apaga is_room_participant/my_room_ids usadas aqui).
-- =============================================================================

-- Pode ler a sala? Chamada da API (anon/authenticated) só se participa;
-- qualquer outro papel (service_role, postgres/cron, supabase_admin) segue
-- como antes. Interna: não é executável por anon/authenticated (as RPCs
-- SECURITY DEFINER a chamam como dono).
CREATE OR REPLACE FUNCTION public.room_read_allowed(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(current_setting('role', true), '') NOT IN ('anon', 'authenticated')
      OR public.is_room_participant(p_room_id)
$$;

-- Tópico Realtime autorizado para a sessão (usado pelas políticas de
-- realtime.messages, que rodam com o papel de quem assina o canal).
CREATE OR REPLACE FUNCTION public.realtime_topic_allowed(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id text;
BEGIN
  IF v_uid IS NULL OR p_topic IS NULL OR length(p_topic) > 64 THEN
    RETURN false;
  END IF;
  IF p_topic = 'latency:' || v_uid::text THEN
    RETURN true;
  END IF;
  v_id := substring(p_topic FROM '^(?:room|reactions):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$');
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.is_room_participant(v_id::uuid);
END;
$$;

-- 1. Tabelas ligadas: leitura só de participante ---------------------------
-- "(SELECT my_room_ids())" = lista calculada uma vez por instrução (#74).
DROP POLICY IF EXISTS "public read players" ON public.players;
DROP POLICY IF EXISTS "players participantes leem" ON public.players;
CREATE POLICY "players participantes leem" ON public.players
  FOR SELECT TO authenticated
  USING (room_id IN (SELECT public.my_room_ids()));

DROP POLICY IF EXISTS "public read votes" ON public.votes;
DROP POLICY IF EXISTS "votes participantes leem" ON public.votes;
CREATE POLICY "votes participantes leem" ON public.votes
  FOR SELECT TO authenticated
  USING (room_id IN (SELECT public.my_room_ids()));

DROP POLICY IF EXISTS "public read reactions" ON public.reactions;
DROP POLICY IF EXISTS "reactions participantes leem" ON public.reactions;
CREATE POLICY "reactions participantes leem" ON public.reactions
  FOR SELECT TO authenticated
  USING (room_id IN (SELECT public.my_room_ids()));

DROP POLICY IF EXISTS "round_extensions public read" ON public.round_extensions;
DROP POLICY IF EXISTS "round_extensions participantes leem" ON public.round_extensions;
CREATE POLICY "round_extensions participantes leem" ON public.round_extensions
  FOR SELECT TO authenticated
  USING (room_id IN (SELECT public.my_room_ids()));

DROP POLICY IF EXISTS "rounds open select" ON public.rounds;
DROP POLICY IF EXISTS "rounds participantes leem" ON public.rounds;
CREATE POLICY "rounds participantes leem" ON public.rounds
  FOR SELECT TO authenticated
  USING (room_id IN (SELECT public.my_room_ids()));

DROP POLICY IF EXISTS "room_messages public read" ON public.room_messages;
DROP POLICY IF EXISTS "room_messages participantes leem" ON public.room_messages;
CREATE POLICY "room_messages participantes leem" ON public.room_messages
  FOR SELECT TO authenticated
  USING (room_id IN (SELECT public.my_room_ids()));

DROP POLICY IF EXISTS "room_words public read" ON public.room_words;
DROP POLICY IF EXISTS "room_words participantes leem" ON public.room_words;
CREATE POLICY "room_words participantes leem" ON public.room_words
  FOR SELECT TO authenticated
  USING (room_id IN (SELECT public.my_room_ids()));

-- 3. Canais Realtime privados ------------------------------------------------
-- realtime.topic() = tópico do canal em autorização (definido pelo Realtime).
DROP POLICY IF EXISTS "verbete canais: participante recebe" ON realtime.messages;
DROP POLICY IF EXISTS "verbete canais: participante envia" ON realtime.messages;
CREATE POLICY "verbete canais: participante recebe" ON realtime.messages
  FOR SELECT TO authenticated
  USING (
    realtime.messages.extension IN ('broadcast', 'presence')
    AND (SELECT public.realtime_topic_allowed(realtime.topic()))
  );
CREATE POLICY "verbete canais: participante envia" ON realtime.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    realtime.messages.extension IN ('broadcast', 'presence')
    AND (SELECT public.realtime_topic_allowed(realtime.topic()))
  );

-- 2. RPCs de leitura por id: guarda de participante --------------------------
CREATE OR REPLACE FUNCTION public.get_ballot(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
BEGIN
  -- PF2: só quem participa da sala (ou chamada interna: service_role, cron,
  -- SQL do dono) lê; de fora = a mesma resposta de sala inexistente.
  IF NOT public.room_read_allowed(p_room_id) THEN
    RETURN '[]'::jsonb;
  END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL OR v_room.status NOT IN ('voting', 'reveal', 'scoreboard', 'finished') THEN
    RETURN '[]'::jsonb;
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', d.id, 'letter', d.letter, 'text', d.text) ORDER BY d.letter)
    FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round AND d.letter IS NOT NULL
  ), '[]'::jsonb);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_room_definitions(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_max_round int;
BEGIN
  -- PF2: só quem participa da sala (ou chamada interna: service_role, cron,
  -- SQL do dono) lê; de fora = a mesma resposta de sala inexistente.
  IF NOT public.room_read_allowed(p_room_id) THEN
    RETURN '[]'::jsonb;
  END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN RETURN '[]'::jsonb; END IF;
  v_max_round := CASE
    WHEN v_room.status IN ('reveal', 'scoreboard', 'finished') THEN v_room.current_round
    ELSE v_room.current_round - 1
  END;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', d.id, 'room_id', d.room_id, 'round', d.round,
      'player_id', d.player_id, 'letter', d.letter, 'text', d.text
    ) ORDER BY d.round, d.letter)
    FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round <= v_max_round
  ), '[]'::jsonb);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_room_reveal(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
BEGIN
  -- PF2: só quem participa da sala (ou chamada interna: service_role, cron,
  -- SQL do dono) lê; de fora = a mesma resposta de sala inexistente.
  IF NOT public.room_read_allowed(p_room_id) THEN
    RETURN jsonb_build_object('available', false);
  END IF;
  SELECT status INTO v_status FROM public.rooms WHERE id = p_room_id;
  IF v_status IS NULL OR v_status NOT IN ('reveal','scoreboard','finished') THEN
    RETURN jsonb_build_object('available', false);
  END IF;

  RETURN jsonb_build_object(
    'available', true,
    'truth_def_ids', COALESCE((
      SELECT array_agg(id) FROM public.definitions
       WHERE room_id = p_room_id AND is_truth = true
    ), ARRAY[]::uuid[]),
    'near_truth_ids', COALESCE((
      SELECT array_agg(id) FROM public.definitions
       WHERE room_id = p_room_id AND near_truth = true
    ), ARRAY[]::uuid[])
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_round_reveal(p_room_id uuid, p_round integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_status text;
  v_truth_id uuid;
  v_near_ids uuid[];
BEGIN
  -- PF2: só quem participa da sala (ou chamada interna: service_role, cron,
  -- SQL do dono) lê; de fora = a mesma resposta de sala inexistente.
  IF NOT public.room_read_allowed(p_room_id) THEN
    RETURN jsonb_build_object('available', false);
  END IF;
  SELECT status INTO v_status FROM public.rooms WHERE id = p_room_id;
  IF v_status IS NULL OR v_status NOT IN ('reveal','scoreboard','finished') THEN
    RETURN jsonb_build_object('available', false);
  END IF;

  SELECT id INTO v_truth_id FROM public.definitions
   WHERE room_id = p_room_id AND round = p_round AND is_truth = true LIMIT 1;

  SELECT COALESCE(array_agg(id), ARRAY[]::uuid[]) INTO v_near_ids
   FROM public.definitions
   WHERE room_id = p_room_id AND round = p_round AND near_truth = true;

  RETURN jsonb_build_object(
    'available', true,
    'truth_def_id', v_truth_id,
    'near_truth_ids', v_near_ids
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_round_sync(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_defs jsonb;
BEGIN
  -- PF2: só quem participa da sala (ou chamada interna: service_role, cron,
  -- SQL do dono) lê; de fora = a mesma resposta de sala inexistente.
  IF NOT public.room_read_allowed(p_room_id) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN RETURN NULL; END IF;

  IF v_room.status IN ('writing', 'shuffling') THEN
    -- Progresso: quem já enviou (sem expor texto nem a verdade)
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', d.id, 'room_id', d.room_id, 'round', d.round,
      'player_id', d.player_id, 'text', '', 'letter', NULL
    ) ORDER BY d.created_at), '[]'::jsonb) INTO v_defs
    FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.is_truth = false AND d.player_id <> '__truth__';
  ELSIF v_room.status = 'voting' THEN
    -- Cédulas: texto e letra, SEM autor (a verdade fica indistinguível)
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', d.id, 'room_id', d.room_id, 'round', d.round,
      'player_id', '', 'text', d.text, 'letter', d.letter
    ) ORDER BY d.letter), '[]'::jsonb) INTO v_defs
    FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round
      AND d.letter IS NOT NULL;
  ELSIF v_room.status IN ('reveal', 'scoreboard', 'finished') THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', d.id, 'room_id', d.room_id, 'round', d.round,
      'player_id', d.player_id, 'text', d.text, 'letter', d.letter
    ) ORDER BY d.letter), '[]'::jsonb) INTO v_defs
    FROM public.definitions d
    WHERE d.room_id = p_room_id AND d.round = v_room.current_round;
  ELSE
    v_defs := '[]'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'definitions', v_defs,
    'votes', COALESCE((
      SELECT jsonb_agg(to_jsonb(v))
      FROM public.votes v
      WHERE v.room_id = p_room_id AND v.round = v_room.current_round
    ), '[]'::jsonb)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_word_reveal(p_room_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_out jsonb;
BEGIN
  -- PF2: só quem participa da sala (ou chamada interna: service_role, cron,
  -- SQL do dono) lê; de fora = a mesma resposta de sala inexistente.
  IF NOT public.room_read_allowed(p_room_id) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL OR v_room.current_word_id IS NULL THEN RETURN NULL; END IF;
  -- Gate de fase: metadados reveladores só depois que a rodada foi pontuada.
  IF v_room.status NOT IN ('reveal', 'scoreboard', 'finished') THEN RETURN NULL; END IF;

  SELECT to_jsonb(w) INTO v_out FROM public.words w WHERE w.id = v_room.current_word_id;
  IF v_out IS NULL THEN
    SELECT jsonb_build_object(
      'id', rw.id, 'word', rw.word, 'meaning', rw.meaning,
      'category', COALESCE(rw.category, 'custom'), 'rarity', 2,
      'nivel', NULL, 'classe', NULL, 'pronuncia', NULL,
      'origem', NULL, 'curiosidade', NULL, 'exemplo', NULL, 'sinonimos', NULL
    ) INTO v_out
    FROM public.room_words rw WHERE rw.id = v_room.current_word_id;
  END IF;
  RETURN v_out;
END;
$function$
;

-- Permissões: room_read_allowed é interna (só as RPCs DEFINER a chamam);
-- realtime_topic_allowed precisa de EXECUTE para authenticated (a RLS de
-- realtime.messages avalia com o papel de quem assina) e responde só sobre a
-- própria sessão. Nenhuma das duas para anon/PUBLIC. As 6 RPCs mantêm a ACL
-- de antes (CREATE OR REPLACE não mexe na ACL).
REVOKE ALL ON FUNCTION public.room_read_allowed(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.realtime_topic_allowed(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.room_read_allowed(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.realtime_topic_allowed(text) TO authenticated, service_role;
