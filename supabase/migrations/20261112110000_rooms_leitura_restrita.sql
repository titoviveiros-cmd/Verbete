-- =============================================================================
-- Salas: leitura restrita a participantes (12/11/2026).
--
-- PROBLEMA (CONFIRMADO em produção, 12/11 09:24): a política
-- "public read rooms" (USING (true), papel PUBLIC) deixava qualquer um, até sem
-- sessão, listar TODAS as salas com GET /rest/v1/rooms?select=code — códigos
-- de salas vivas incluídos. O limite de tentativas (PR #73) só pega
-- adivinhação; a lista saía inteira numa requisição.
--
-- O QUE MUDA
--   1. rooms: some o SELECT geral. Lê a linha da sala só quem PARTICIPA dela
--      (tem linha em players com user_id = auth.uid(), inclusive expulso, que
--      precisa ver o aviso e voltar) — papel authenticated (contas e convidados
--      anônimos). anon (sem sessão) não tem política nenhuma: 0 linhas.
--      service_role e as funções SECURITY DEFINER (dono postgres) seguem lendo
--      tudo (BYPASSRLS / dono da tabela, sem FORCE RLS).
--   2. Realtime (postgres_changes em rooms) passa pela mesma RLS: só
--      participante recebe as mudanças da sala.
--   3. get_room_state(p_code): participante recebe o estado completo (igual a
--      antes). Quem não participa recebe SÓ a linha da sala (para a tela de
--      convite / JoinFlow), sem jogadores, definições, votos nem palavra.
--      Código inexistente = NULL. Com o interruptor desligado (ver 4), sem
--      sessão = NULL e, se o PR #73 estiver aplicado, cada código inexistente
--      conta como falha no MESMO limite por identidade do rejoin_room
--      (10 falhas / 15 min; barrado = NULL, sem revelar se existe).
--      Passa de STABLE a VOLATILE (precisa gravar a falha).
--   4. COMPATIBILIDADE com o app Android vc8 e o web atual (antes do deploy
--      deste PR): o joinRoom antigo lê "rooms?select=*&code=eq.<código>" ANTES
--      de entrar. Enquanto app_config.rooms_vc8_compat = 'ligado' (valor
--      inserido aqui), uma política TRANSITÓRIA deixa uma sessão (authenticated)
--      ler a sala SOMENTE numa instrução cujo único filtro sobre rooms é
--      "code = <valor>" — a forma exata que o PostgREST gera para .eq("code").
--      Listagem, intervalo (gt/lt), in, or, like, not, filtros combinados e
--      embutir rooms a partir de outra tabela NÃO passam (falha fechada:
--      qualquer forma diferente = só participantes). No mesmo modo,
--      get_room_state devolve a linha da sala também sem sessão (o app abre a
--      sessão anônima no boot, em paralelo, e o 1º get_room_state do convite
--      pode sair antes dela).
--      EXPOSIÇÃO QUE SOBRA com 'ligado': quem tem uma sessão anônima consegue
--      confirmar UM código por requisição, sem limite (GET é transação
--      somente-leitura; não há onde contar) — varrer 1000–9999 custa ~9.000
--      requisições, em vez de 1. É o mesmo oráculo que get_room_state já era
--      antes deste PR. Desligar ('desligado', ou apagar a chave) assim que o
--      web com este PR estiver no ar e o vc9 tiver substituído o vc8:
--        UPDATE public.app_config SET value = 'desligado', updated_at = now()
--         WHERE key = 'rooms_vc8_compat';
--      Valor ausente ou diferente de 'ligado' = desligado (falha fechada).
--   5. record_match_result: sala inexistente ou de quem não participa agora
--      respondem IGUAL ({ok:false, reason:'player_not_linked'}); antes
--      "room not found" (erro) × outros motivos confirmava se o código existia
--      e se a partida tinha acabado. Para quem participa, nada muda.
--
-- NÃO MEXE: rejoin_room (PR #73), create_room_with_host / join_public_room
-- (#60, #67), gatilhos de players (#66, #69), coluna rooms.locked (#69 — a
-- leitura usa to_jsonb, então a coluna nova aparece sozinha), tabelas
-- players/votes/rounds/reactions/round_extensions/room_messages (seguem com
-- leitura pública — ver o runbook, "fase 2").
--
-- ORDEM: independe das migrations em fila (#67 20261111100000, #66
-- 20261111120000, #65 20261111130000, #69 20261111140000, #68
-- 20261111154500, #73 20261112090000, #62 20261112100000); nenhuma delas
-- redefine get_room_state, record_match_result nem as políticas de rooms. O
-- limite do #73 é chamado só se as funções dele existirem (to_regprocedure),
-- então esta migration funciona antes, depois ou sem o #73.
-- ROLLBACK: supabase/rollback/rooms_leitura_restrita.sql
-- =============================================================================

-- Interruptor da compatibilidade (só o dono do banco / service_role escreve;
-- app_config não tem política para anon/authenticated).
INSERT INTO public.app_config (key, value)
VALUES ('rooms_vc8_compat', 'ligado')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.rooms_vc8_compat_on()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((SELECT value FROM public.app_config WHERE key = 'rooms_vc8_compat'), '') = 'ligado'
$$;

-- Participa da sala = tem (ou teve, se expulso) linha em players amarrada à
-- identidade da sessão. SECURITY DEFINER: lê players sem depender da RLS dela
-- (sem recursão se players for restringida depois).
CREATE OR REPLACE FUNCTION public.is_room_participant(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.players p
        WHERE p.room_id = p_room_id
          AND p.user_id = auth.uid()
     )
$$;

-- Salas da sessão (inclui as de onde foi expulso). A política de rooms usa
-- "id IN (SELECT my_room_ids())": o Postgres calcula a lista UMA vez por
-- instrução (subplano com hash), não uma consulta por linha — listar a tabela
-- inteira custa o mesmo que ler a própria sala (medido: 9.000 salas).
CREATE OR REPLACE FUNCTION public.my_room_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p.room_id FROM public.players p WHERE p.user_id = auth.uid()
$$;

-- Política transitória do vc8: verdadeira só quando a instrução em curso lê
-- rooms EXCLUSIVAMENTE por "code = <um valor>" (forma do PostgREST para
-- .eq("code", X)). Não depende da linha: o próprio filtro da instrução limita
-- o resultado a, no máximo, 1 sala (code é UNIQUE). current_query() é o texto
-- enviado pelo cliente da API; os valores vão como parâmetros ($n), então o
-- chamador não consegue injetar texto nele.
CREATE OR REPLACE FUNCTION public.rooms_vc8_exact_code_read()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_q text;
  v_reads int;
  v_exact int;
BEGIN
  IF COALESCE(current_setting('role', true), '') <> 'authenticated' OR auth.uid() IS NULL THEN
    RETURN false;
  END IF;
  IF NOT public.rooms_vc8_compat_on() THEN
    RETURN false;
  END IF;
  v_q := regexp_replace(COALESCE(current_query(), ''), '\s+', ' ', 'g');
  IF v_q = '' OR length(v_q) > 8000 THEN
    RETURN false;
  END IF;
  -- Toda leitura de rooms na instrução (FROM/JOIN, com ou sem esquema/ONLY).
  SELECT count(*) INTO v_reads
    FROM regexp_matches(v_q, '(FROM|JOIN) (ONLY )?("public"\.)?"rooms"', 'gi');
  -- …e quantas delas são "FROM rooms WHERE rooms.code = $n" e mais nada.
  SELECT count(*) INTO v_exact
    FROM regexp_matches(v_q,
      'FROM ("public"\.)?"rooms" WHERE ("public"\.)?"rooms"\."code" = (\$[0-9]+|''[0-9]{1,12}'')(::[a-z]+)? ?(\)|ORDER BY |LIMIT |OFFSET |$)',
      'gi');
  RETURN v_reads >= 1 AND v_reads = v_exact;
END;
$$;

DROP POLICY IF EXISTS "public read rooms" ON public.rooms;
DROP POLICY IF EXISTS "rooms participantes leem" ON public.rooms;
DROP POLICY IF EXISTS "rooms vc8 leitura por codigo exato (transitoria)" ON public.rooms;

-- "(SELECT f())" = avaliado uma vez por instrução, não por linha.
CREATE POLICY "rooms participantes leem" ON public.rooms
  FOR SELECT TO authenticated
  USING (id IN (SELECT public.my_room_ids()));

CREATE POLICY "rooms vc8 leitura por codigo exato (transitoria)" ON public.rooms
  FOR SELECT TO authenticated
  USING ((SELECT public.rooms_vc8_exact_code_read()));

-- get_room_state = 20260722100000_fase1_identity_guards + o recorte por
-- participante (marcado "RL"). Participante: resposta idêntica à anterior.
CREATE OR REPLACE FUNCTION public.get_room_state(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_sync jsonb;
  v_word jsonb;
  v_uid uuid := auth.uid();
  v_hash text;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE code = p_code LIMIT 1;

  -- RL: chamada da API (anon/authenticated) de quem NÃO participa da sala.
  -- Chamadas internas (service_role, SQL do dono, cron) mantêm o contrato.
  IF COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated')
     AND (v_room.id IS NULL OR NOT public.is_room_participant(v_room.id)) THEN
    IF NOT public.rooms_vc8_compat_on() THEN
      IF v_uid IS NULL THEN
        RETURN NULL;
      END IF;
      -- Limite de tentativas do PR #73 (20261112090000), se aplicado:
      -- barrado não soma e não revela; código inexistente soma uma falha.
      IF to_regprocedure('public.room_code_uid_hash(uuid)') IS NOT NULL
         AND to_regprocedure('public.room_code_retry_after(text)') IS NOT NULL
         AND to_regprocedure('public.room_code_record_failure(text)') IS NOT NULL THEN
        v_hash := public.room_code_uid_hash(v_uid);
        PERFORM pg_advisory_xact_lock(hashtextextended('room_code:' || v_hash, 0));
        IF public.room_code_retry_after(v_hash) IS NOT NULL THEN
          RETURN NULL;
        END IF;
        IF v_room.id IS NULL THEN
          PERFORM public.room_code_record_failure(v_hash);
          RETURN NULL;
        END IF;
      END IF;
    END IF;
    IF v_room.id IS NULL THEN
      RETURN NULL;
    END IF;
    -- Só a linha da sala (o mesmo que o rejoin_room devolve a quem tem o
    -- código): a tela de convite precisa de id e status. Nada de jogadores,
    -- definições, votos ou palavra.
    RETURN jsonb_build_object(
      'room', to_jsonb(v_room),
      'players', '[]'::jsonb,
      'definitions', '[]'::jsonb,
      'votes', '[]'::jsonb,
      'word', NULL
    );
  END IF;

  IF v_room IS NULL THEN
    RETURN NULL;
  END IF;

  v_sync := public.get_round_sync(v_room.id);

  IF v_room.status IN ('reveal', 'scoreboard', 'finished') THEN
    v_word := public.get_word_reveal(v_room.id);
  ELSE
    SELECT jsonb_build_object(
      'id', w.id, 'word', w.word, 'category', w.category, 'rarity', w.rarity,
      'nivel', w.nivel, 'classe', w.classe, 'pronuncia', w.pronuncia
    ) INTO v_word
    FROM public.words w WHERE w.id = v_room.current_word_id;
    IF v_word IS NULL AND v_room.current_word_id IS NOT NULL THEN
      SELECT jsonb_build_object(
        'id', rw.id, 'word', rw.word,
        'category', COALESCE(rw.category, 'custom'), 'rarity', 2
      ) INTO v_word
      FROM public.room_words rw WHERE rw.id = v_room.current_word_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'room', to_jsonb(v_room),
    'players', COALESCE((
      SELECT jsonb_agg(to_jsonb(p) ORDER BY p.joined_at)
      FROM public.players p
      WHERE p.room_id = v_room.id AND p.kicked_at IS NULL
    ), '[]'::jsonb),
    'definitions', COALESCE(v_sync->'definitions', '[]'::jsonb),
    'votes', COALESCE(v_sync->'votes', '[]'::jsonb),
    'word', v_word
  );
END;
$function$;

-- record_match_result = 20261019030000_p2_cleanup_finish_not_rewardable + resposta única para
-- "sala não existe" e "não participo" (marcado "RL"); o resto byte a byte.
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
  -- RL: sala inexistente e sala de outros respondem igual (antes: erro "room not found"
  -- × match_not_finished/player_not_linked = oráculo de código e de fase).
  IF v_room.id IS NULL OR NOT public.is_room_participant(v_room.id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'player_not_linked');
  END IF;
  -- Só partidas encerradas geram estatísticas (anti-replay/prematuro).
  IF v_room.status <> 'finished' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'match_not_finished');
  END IF;
  -- P2: sala encerrada pela LIMPEZA (motivo gravado pelo cleanup_zombie_rooms)
  -- não é partida: sem histórico, XP, nível, vitória, sequência ou conquista.
  -- Sem motivo = fim natural ou sala histórica: tudo segue igual.
  IF v_room.finish_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'match_not_rewardable', 'xp_gained', 0);
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
$function$

;

-- Permissões: as 4 funções novas não são executáveis por PUBLIC/anon (o
-- padrão do esquema dá EXECUTE a anon). authenticated precisa de EXECUTE nas
-- duas usadas pelas políticas (a RLS avalia com o papel de quem consulta) e
-- na is_room_participant (só responde sobre a própria sessão); a do
-- interruptor é só interna. get_room_state e record_match_result mantêm as
-- permissões de antes (CREATE OR REPLACE não mexe na ACL).
REVOKE ALL ON FUNCTION public.rooms_vc8_compat_on() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_room_participant(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.my_room_ids() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rooms_vc8_exact_code_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_room_participant(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.my_room_ids() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rooms_vc8_exact_code_read() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rooms_vc8_compat_on() TO service_role;
