-- =============================================================================
-- Compartilhar resultado da partida (09/11/2026)
-- Defeito: "Compartilhar resultado" mandava ${APP_URL}/ (a Home). A sala é apagada
-- 30 dias depois de encerrada, então /room/<código> não serve como link durável.
--
-- Solução: um RETRATO do resultado montado PELO SERVIDOR a partir de rooms/players
-- no momento do compartilhamento (nunca dados do navegador), guardado com um token
-- aleatório (122 bits, não enumerável) e validade de 30 dias.
--   * create_match_share(room_id): só quem JOGOU a partida até o fim (players.user_id = auth.uid(), não expulso,
--     inclusive convidado com sessão anônima) e só partida encerrada de verdade
--     (status 'finished' sem finish_reason da limpeza). Idempotente POR PARTIDA: o mesmo
--     link enquanto válido; "Nova partida" na mesma sala gera outro link e o antigo
--     continua mostrando a partida anterior.
--   * get_match_share(token): leitura pública (anon) do retrato; token inválido,
--     inexistente ou vencido devolvem a MESMA resposta (null) — sem oráculo.
--   * O retrato tem apelido, avatar, cor, pontos, posição e equipe. Nunca e-mail,
--     UUID de jogador ou de usuário, definições, votos ou código da sala.
--   * participant_user_ids (privado, nunca sai pela RPC): ao apagar a conta de um
--     participante (exclusão ou limpeza de convidado), o link some na hora.
--   * Limpeza diária dos vencidos.
-- ROLLBACK: supabase/rollback/compartilhar_resultado.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.match_shares (
  token                text        PRIMARY KEY CHECK (token ~ '^[0-9a-f]{32}$'),
  room_id              uuid        NOT NULL,          -- sem FK: o retrato sobrevive à sala apagada
  -- a PARTIDA: "Nova partida" na mesma sala zera e refaz rooms.finished_at
  -- (rooms_track_finished_at), então cada partida encerrada tem o seu link
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

-- Retrato oficial da partida (servidor). Equipes: soma dos pontos dos membros,
-- igual a computeTeamScores no cliente. Posição: 1 + quantos fizeram mais pontos.
CREATE OR REPLACE FUNCTION public.match_share_snapshot(p_room_id uuid)
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
     WHERE pl.room_id = p_room_id AND pl.kicked_at IS NULL
  ),
  t AS (
    SELECT tm ->> 'id' AS id, tm ->> 'name' AS name, tm ->> 'emoji' AS emoji, tm ->> 'color' AS color,
           coalesce((SELECT sum(p.score) FROM p WHERE p.team_id = tm ->> 'id'), 0)::int AS score,
           (SELECT count(*) FROM p WHERE p.team_id = tm ->> 'id')::int AS members
      FROM r, jsonb_array_elements(CASE WHEN r.mode = 'teams' AND jsonb_typeof(r.teams) = 'array' THEN r.teams ELSE '[]'::jsonb END) AS tm
  )
  SELECT jsonb_build_object(
    'v', 1,
    'mode', CASE WHEN EXISTS (SELECT 1 FROM t) THEN 'teams' ELSE 'solo' END,
    'rounds', (SELECT current_round FROM r),
    'finished_at', (SELECT coalesce(finished_at, now()) FROM r),
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
        FROM t), '[]'::jsonb)
  )
$$;

-- Cria (ou devolve) o link do resultado. Respostas:
--   {ok:true, token, expires_at}
--   {ok:false, reason:'unauthorized'|'not_found'|'not_finished'|'not_shareable'|'not_participant'}
CREATE OR REPLACE FUNCTION public.create_match_share(p_room_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_room  public.rooms;
  v_share public.match_shares;
  v_token text;
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
  IF NOT EXISTS (SELECT 1 FROM public.players
                  WHERE room_id = p_room_id AND user_id = v_uid AND is_bot = false AND kicked_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_participant');
  END IF;

  v_fin := coalesce(v_room.finished_at, '-infinity'::timestamptz);
  PERFORM pg_advisory_xact_lock(hashtextextended('match_share|' || p_room_id::text, 0));

  SELECT * INTO v_share FROM public.match_shares WHERE room_id = p_room_id AND room_finished_at = v_fin;
  IF FOUND AND v_share.expires_at > now() THEN
    RETURN jsonb_build_object('ok', true, 'token', v_share.token, 'expires_at', v_share.expires_at);
  END IF;

  v_token := replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.match_shares (token, room_id, room_finished_at, snapshot, participant_user_ids, expires_at)
  VALUES (v_token, p_room_id, v_fin, public.match_share_snapshot(p_room_id),
          coalesce((SELECT array_agg(DISTINCT user_id) FROM public.players
                     WHERE room_id = p_room_id AND user_id IS NOT NULL), ARRAY[]::uuid[]),
          now() + interval '30 days')
  ON CONFLICT (room_id, room_finished_at) DO UPDATE   -- o anterior venceu: link novo, retrato novo
     SET token = EXCLUDED.token, snapshot = EXCLUDED.snapshot,
         participant_user_ids = EXCLUDED.participant_user_ids,
         created_at = now(), expires_at = EXCLUDED.expires_at
  RETURNING * INTO v_share;
  RETURN jsonb_build_object('ok', true, 'token', v_share.token, 'expires_at', v_share.expires_at);
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
REVOKE ALL ON FUNCTION public.match_share_snapshot(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_match_share(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_match_share(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_shares_forget_user() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.match_shares_cleanup() FROM PUBLIC, anon, authenticated;
-- criar: quem tem sessão (convidado anônimo ou conta) — a função confere se jogou
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
