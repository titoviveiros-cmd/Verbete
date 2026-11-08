-- =============================================================================
-- Compartilhar resultado da partida (09/11/2026)
-- Defeito: "Compartilhar resultado" mandava ${APP_URL}/ (a Home). A sala é apagada
-- 30 dias depois de encerrada, então /room/<código> não serve como link durável.
--
-- Solução: o RETRATO do resultado é CONGELADO PELO SERVIDOR NO FIM DA PARTIDA
-- (gatilho em rooms, na mesma transação que encerra o jogo) e guardado com um
-- token aleatório (122 bits, não enumerável). O clique só devolve o link pronto.
-- Red Team 08/11 (A): tirar o retrato no clique deixava o resultado mudar depois do
-- fim (vencedor que sai é apagado de players; anfitrião expulsa; quem entra pelo
-- código depois do fim; apelido trocado). Congelado no fim, nada disso altera o link.
--   * gatilho match_share_on_finish: status → 'finished' de verdade (sem finish_reason
--     da limpeza) grava o retrato + os participantes (humanos com sessão) daquele
--     momento. NUNCA trava o fim do jogo (erro vira aviso).
--   * create_match_share(room_id): devolve o link da partida ATUAL da sala, só para
--     quem estava no retrato (participant_user_ids). Idempotente por partida;
--     "Nova partida" na mesma sala tem outro link e o antigo segue mostrando a anterior.
--     Partida encerrada antes desta migration: retrato na hora, só com quem já estava
--     antes do fim e não foi expulso antes do fim (transição).
--   * get_match_share(token): leitura pública (anon); inválido, inexistente e vencido
--     devolvem a MESMA resposta (null) — sem oráculo.
--   * Retrato: apelido, avatar, cor, pontos, posição (empate = mesma posição), equipes
--     (soma dos membros), robô marcado e os campeões (empate = todos). Nunca e-mail,
--     UUID, definições, votos ou código da sala.
--   * Validade: 30 dias depois do FIM DA PARTIDA (= retenção das salas); limpeza diária;
--     e o link some se um participante apagar a conta (gatilho em auth.users).
-- ROLLBACK: supabase/rollback/compartilhar_resultado.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.match_shares (
  token                text        PRIMARY KEY CHECK (token ~ '^[0-9a-f]{32}$'),
  room_id              uuid        NOT NULL,          -- sem FK: o retrato sobrevive à sala apagada
  -- a PARTIDA: "Nova partida" na mesma sala zera e refaz rooms.finished_at
  room_finished_at     timestamptz NOT NULL,
  snapshot             jsonb       NOT NULL,
  participant_user_ids uuid[]      NOT NULL DEFAULT ARRAY[]::uuid[],
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  UNIQUE (room_id, room_finished_at)
);
CREATE INDEX IF NOT EXISTS match_shares_expires_idx ON public.match_shares (expires_at);
CREATE INDEX IF NOT EXISTS match_shares_participants_idx ON public.match_shares USING gin (participant_user_ids);
ALTER TABLE public.match_shares ENABLE ROW LEVEL SECURITY;   -- sem policies: só as funções abaixo
REVOKE ALL ON public.match_shares FROM PUBLIC, anon, authenticated;

-- Jogadores que CONTAM no resultado da partida encerrada em p_fin: já estavam antes do
-- fim e não foram expulsos antes do fim (no gatilho, é exatamente a mesa final).
CREATE OR REPLACE FUNCTION public.match_share_snapshot(p_room_id uuid, p_fin timestamptz)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  WITH r AS (
    SELECT * FROM public.rooms WHERE id = p_room_id
  ),
  p AS (
    SELECT pl.nickname, pl.avatar, pl.color, pl.score, pl.is_bot, pl.team_id
      FROM public.players pl
     WHERE pl.room_id = p_room_id
       AND (pl.joined_at IS NULL OR pl.joined_at <= p_fin)
       AND (pl.kicked_at IS NULL OR pl.kicked_at > p_fin)
  ),
  t AS (
    SELECT tm ->> 'id' AS id, tm ->> 'name' AS name, tm ->> 'emoji' AS emoji, tm ->> 'color' AS color,
           coalesce((SELECT sum(p.score) FROM p WHERE p.team_id = tm ->> 'id'), 0)::int AS score,
           (SELECT count(*) FROM p WHERE p.team_id = tm ->> 'id')::int AS members
      FROM r, jsonb_array_elements(CASE WHEN r.mode = 'teams' AND jsonb_typeof(r.teams) = 'array' THEN r.teams ELSE '[]'::jsonb END) AS tm
  ),
  modo AS (
    SELECT CASE WHEN EXISTS (SELECT 1 FROM t) THEN 'teams' ELSE 'solo' END AS m
  )
  SELECT jsonb_build_object(
    'v', 2,
    'mode', (SELECT m FROM modo),
    'rounds', (SELECT current_round FROM r),
    'finished_at', p_fin,
    'players', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'rank', 1 + (SELECT count(*) FROM p p2 WHERE p2.score > p.score),
               'nickname', left(p.nickname, 24), 'avatar', left(p.avatar, 16), 'color', left(p.color, 32),
               'score', p.score, 'bot', p.is_bot,
               'team', (SELECT t.name FROM t WHERE t.id = p.team_id))
             ORDER BY p.score DESC, p.nickname)
        FROM p), '[]'::jsonb),
    'teams', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'rank', 1 + (SELECT count(*) FROM t t2 WHERE t2.score > t.score),
               'name', left(t.name, 40), 'emoji', left(t.emoji, 16), 'color', left(t.color, 32),
               'score', t.score, 'members', t.members)
             ORDER BY t.score DESC, t.name)
        FROM t), '[]'::jsonb),
    -- campeões decididos AQUI (empate = todos); o texto do compartilhamento usa isto
    'champions', CASE WHEN (SELECT m FROM modo) = 'teams'
      THEN coalesce((SELECT jsonb_agg(jsonb_build_object('name', left(t.name, 40), 'emoji', left(t.emoji, 16), 'score', t.score) ORDER BY t.name)
                       FROM t WHERE t.score = (SELECT max(score) FROM t)), '[]'::jsonb)
      ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('name', left(p.nickname, 24), 'emoji', left(p.avatar, 16), 'score', p.score) ORDER BY p.nickname)
                       FROM p WHERE p.score = (SELECT max(score) FROM p)), '[]'::jsonb)
    END
  )
$$;

CREATE OR REPLACE FUNCTION public.match_share_participants(p_room_id uuid, p_fin timestamptz)
RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT coalesce(array_agg(DISTINCT pl.user_id), ARRAY[]::uuid[])
    FROM public.players pl
   WHERE pl.room_id = p_room_id AND pl.user_id IS NOT NULL AND pl.is_bot = false
     AND (pl.joined_at IS NULL OR pl.joined_at <= p_fin)
     AND (pl.kicked_at IS NULL OR pl.kicked_at > p_fin)
$$;

CREATE OR REPLACE FUNCTION public.match_share_store(p_room_id uuid, p_fin timestamptz)
RETURNS public.match_shares
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_share public.match_shares;
BEGIN
  INSERT INTO public.match_shares (token, room_id, room_finished_at, snapshot, participant_user_ids, expires_at)
  VALUES (replace(gen_random_uuid()::text, '-', ''), p_room_id, p_fin,
          public.match_share_snapshot(p_room_id, p_fin), public.match_share_participants(p_room_id, p_fin),
          CASE WHEN p_fin = '-infinity'::timestamptz THEN now() ELSE p_fin END + interval '30 days')
  ON CONFLICT (room_id, room_finished_at) DO NOTHING
  RETURNING * INTO v_share;
  IF v_share.token IS NULL THEN
    SELECT * INTO v_share FROM public.match_shares WHERE room_id = p_room_id AND room_finished_at = p_fin;
  END IF;
  RETURN v_share;
END $$;

-- Fim da partida: congela o retrato (nunca trava o encerramento).
CREATE OR REPLACE FUNCTION public.match_share_on_finish()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.status = 'finished' AND OLD.status IS DISTINCT FROM 'finished'
     AND NEW.finish_reason IS NULL AND NEW.finished_at IS NOT NULL THEN
    BEGIN
      PERFORM public.match_share_store(NEW.id, NEW.finished_at);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'match_share_on_finish: retrato não gravado (%)', SQLSTATE;  -- o jogo termina mesmo assim
    END;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS match_share_on_finish ON public.rooms;
CREATE TRIGGER match_share_on_finish AFTER UPDATE OF status ON public.rooms
  FOR EACH ROW EXECUTE FUNCTION public.match_share_on_finish();

-- Link da partida atual da sala. Respostas:
--   {ok:true, token, expires_at, champions}
--   {ok:false, reason:'unauthorized'|'not_found'|'not_finished'|'not_shareable'|'not_participant'|'expired'}
CREATE OR REPLACE FUNCTION public.create_match_share(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_room  public.rooms;
  v_share public.match_shares;
  v_fin   timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unauthorized');
  END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;
  IF v_room.status <> 'finished' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_finished');
  END IF;
  -- sala encerrada pela LIMPEZA não é partida (mesma regra de record_match_result)
  IF v_room.finish_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_shareable');
  END IF;
  v_fin := coalesce(v_room.finished_at, '-infinity'::timestamptz);

  SELECT * INTO v_share FROM public.match_shares WHERE room_id = p_room_id AND room_finished_at = v_fin;
  IF NOT FOUND THEN
    -- partida encerrada antes desta migration (ou gatilho falhou): retrato agora, só com a mesa do fim
    PERFORM pg_advisory_xact_lock(hashtextextended('match_share|' || p_room_id::text, 0));
    v_share := public.match_share_store(p_room_id, v_fin);
  END IF;

  -- só quem estava no RETRATO (entrar pelo código depois do fim não dá direito ao link)
  IF NOT (v_uid = ANY (v_share.participant_user_ids)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_participant');
  END IF;
  IF v_share.expires_at <= now() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;
  RETURN jsonb_build_object('ok', true, 'token', v_share.token, 'expires_at', v_share.expires_at,
                            'champions', v_share.snapshot -> 'champions');
END $$;

-- Leitura pública. Inválido, inexistente e vencido = null (sem distinguir).
CREATE OR REPLACE FUNCTION public.get_match_share(p_token text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT s.snapshot || jsonb_build_object('expires_at', s.expires_at)
    FROM public.match_shares s
   WHERE p_token ~ '^[0-9a-f]{32}$' AND s.token = p_token AND s.expires_at > now()
$$;

-- Conta apagada (exclusão pelo jogador ou limpeza de convidado): some todo
-- resultado compartilhado em que ela jogou.
CREATE OR REPLACE FUNCTION public.match_shares_forget_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  DELETE FROM public.match_shares WHERE participant_user_ids @> ARRAY[OLD.id];
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS match_shares_forget_user ON auth.users;
CREATE TRIGGER match_shares_forget_user AFTER DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.match_shares_forget_user();

CREATE OR REPLACE FUNCTION public.match_shares_cleanup()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM public.match_shares WHERE expires_at <= now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- Permissões
REVOKE ALL ON FUNCTION public.match_share_snapshot(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_share_participants(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_share_store(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_share_on_finish() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_match_share(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_match_share(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_shares_forget_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_shares_cleanup() FROM PUBLIC, anon, authenticated;
-- obter o link: quem tem sessão (convidado anônimo ou conta) — a função confere se jogou
GRANT EXECUTE ON FUNCTION public.create_match_share(uuid) TO authenticated, service_role;
-- ler: qualquer um com o token (sem login)
GRANT EXECUTE ON FUNCTION public.get_match_share(text) TO anon, authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-match-shares-cleanup') THEN
      PERFORM cron.unschedule('verbete-match-shares-cleanup');
    END IF;
    PERFORM cron.schedule('verbete-match-shares-cleanup', '41 4 * * *', 'SELECT public.match_shares_cleanup();');
  END IF;
END $$;
