-- =============================================================================
-- Desafio Diário D1 — modo ESCOLHA (múltipla escolha, sem IA). 08/11/2026.
-- Aprovação consolidada do dono (D-a … D-f). Critérios: CRITERIOS-ACEITE-DIARIO-D1.md.
--
-- ADITIVA E INERTE AO SER APLICADA: grava app_config.daily_mode = 'juiz' (o
-- fluxo atual). O modo escolha só liga com daily_mode = 'escolha', por decisão
-- expressa do dono (D-a: FIXO; não volta ao juiz sozinho quando ai_mode muda).
--
-- O que NÃO muda: submit_daily_attempt_scored (pontuação do juiz, md5
-- e41b8c87…), daily_claim/daily_finish_ok/daily_finish_fail (V2), a regra da
-- sequência e das conquistas, nenhum ponto histórico.
-- O que muda para todos (escopo aprovado): o sorteio do Diário passa a exigir
-- words.status = 'published' (antes podia sortear palavra não publicada).
--
-- Peças:
--   * daily_mode()                     'juiz' | 'escolha' | 'pausa' (inválido = 'juiz')
--   * daily_attempts.mode              'juiz' (padrão) | 'escolha'
--   * daily_choice_sets                conjuntos editoriais (só service_role)
--   * daily_choice_sessions            alternativas emitidas + início do relógio (só service_role)
--   * daily_choice_start/finish        jogo (só service_role, pelo Worker)
--   * daily_record_participation       sequência/total/conquistas — CÓPIA FIEL do bloco de
--                                      submit_daily_attempt_scored (teste de paridade)
--   * get_or_create_daily_challenge    no modo escolha sorteia só conjuntos APROVADOS
--   * get_my_daily_review              + modo da tentativa e modo vigente
--   * get_daily_leaderboard            + coluna mode; padrão = placar do modo vigente
--   * daily_choice_admin_*             revisão em /admin/daily-choices (só service_role)
-- ROLLBACK: daily_mode = 'juiz' (sem migration). Remoção total: supabase/rollback/diario_d1_escolha.sql.
-- =============================================================================

-- 1) Interruptor -----------------------------------------------------------------
INSERT INTO public.app_config (key, value) VALUES ('daily_mode', 'juiz')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.daily_mode()
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v text := public.get_app_config('daily_mode');
BEGIN
  IF v IN ('juiz', 'escolha', 'pausa') THEN RETURN v; END IF;
  RETURN 'juiz';  -- ausente ou inválido nunca liga a escolha
END $$;

-- 2) Modo da tentativa (metadado; padrão constante não reescreve a tabela) --------
ALTER TABLE public.daily_attempts
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'juiz';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_attempts_mode_check') THEN
    ALTER TABLE public.daily_attempts
      ADD CONSTRAINT daily_attempts_mode_check CHECK (mode IN ('juiz', 'escolha'));
  END IF;
END $$;

-- 3) Conjuntos editoriais -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.daily_choice_sets (
  word_id        uuid        PRIMARY KEY REFERENCES public.words(id) ON DELETE CASCADE,
  distractors    text[]      NOT NULL CHECK (array_length(distractors, 1) = 3),
  -- a definição certa no momento da revisão: se a palavra for editada depois,
  -- o conjunto sai do jogo até ser revisto (nunca joga com verdade trocada)
  truth_snapshot text        NOT NULL,
  status         text        NOT NULL DEFAULT 'rascunho'
                             CHECK (status IN ('rascunho', 'aprovado', 'reprovado')),
  origem         text        NOT NULL DEFAULT 'acervo',
  validacao      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by    uuid,
  reviewed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS daily_choice_sets_status_idx ON public.daily_choice_sets (status);
ALTER TABLE public.daily_choice_sets ENABLE ROW LEVEL SECURITY;   -- sem policies: só service_role
REVOKE ALL ON public.daily_choice_sets FROM PUBLIC, anon, authenticated;

-- 4) Sessões: alternativas na ordem mostrada + início do relógio do servidor -------
CREATE TABLE IF NOT EXISTS public.daily_choice_sessions (
  user_id        uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  challenge_hour timestamptz NOT NULL,
  word_id        uuid        NOT NULL,
  options        text[]      NOT NULL CHECK (array_length(options, 1) = 4),
  correct_pos    smallint    NOT NULL CHECK (correct_pos BETWEEN 0 AND 3),
  issued_at      timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  PRIMARY KEY (user_id, challenge_hour),
  CONSTRAINT daily_choice_sessions_hour_trunc CHECK (challenge_hour = date_trunc('hour', challenge_hour))
);
CREATE INDEX IF NOT EXISTS daily_choice_sessions_hour_idx ON public.daily_choice_sessions (challenge_hour);
ALTER TABLE public.daily_choice_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.daily_choice_sessions FROM PUBLIC, anon, authenticated;

-- 5) Permutação aleatória do servidor (posição da correta imprevisível) ------------
CREATE OR REPLACE FUNCTION public.daily_choice_new_perm()
RETURNS smallint[]
LANGUAGE sql VOLATILE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT array_agg(i::smallint ORDER BY random()) FROM generate_series(0, 3) AS i
$$;

-- 5b) Forma uniforme das 4 alternativas na tela: 1ª letra maiúscula, sem pontuação no fim.
--     Sem isso a correta se denunciaria pela forma (ex.: minúscula entre maiúsculas, ponto final).
CREATE OR REPLACE FUNCTION public.daily_choice_fmt(p text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT upper(left(x, 1)) || substr(x, 2)
    FROM (SELECT regexp_replace(btrim(coalesce(p, '')), '[[:space:].;,:]+$', '') AS x) s
$$;

-- 6) Sequência, total e conquistas — CÓPIA FIEL do bloco de submit_daily_attempt_scored
--    (que fica intocada). Mesma regra para os dois modos; teste de paridade na CI.
CREATE OR REPLACE FUNCTION public.daily_record_participation(p_user_id uuid, p_hour timestamptz, p_score integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_hour timestamptz := p_hour;
  v_prev_hour timestamptz := p_hour - INTERVAL '1 hour';
  v_score integer := COALESCE(p_score, 0);
  v_stats public.user_stats;
  v_new_streak integer := 1;
  v_unlocked_codes text[] := ARRAY[]::text[];
BEGIN
  INSERT INTO public.user_stats (user_id) VALUES (p_user_id) ON CONFLICT DO NOTHING;
  SELECT * INTO v_stats FROM public.user_stats WHERE user_id = p_user_id;

  IF v_stats.last_played_hour = v_prev_hour THEN
    v_new_streak := v_stats.current_streak + 1;
  ELSIF v_stats.last_played_hour = v_hour THEN
    v_new_streak := v_stats.current_streak;
  ELSE
    v_new_streak := 1;
  END IF;

  UPDATE public.user_stats SET
    current_streak = v_new_streak,
    best_streak = GREATEST(best_streak, v_new_streak),
    last_played_date = v_hour::date,
    last_played_hour = v_hour,
    total_score = total_score + v_score,
    updated_at = now()
  WHERE user_id = p_user_id;

  IF NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'first_daily') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'first_daily');
    v_unlocked_codes := array_append(v_unlocked_codes, 'first_daily');
  END IF;
  IF v_new_streak >= 3 AND NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'streak_3') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_3');
    v_unlocked_codes := array_append(v_unlocked_codes, 'streak_3');
  END IF;
  IF v_new_streak >= 7 AND NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'streak_7') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_7');
    v_unlocked_codes := array_append(v_unlocked_codes, 'streak_7');
  END IF;
  IF v_new_streak >= 30 AND NOT EXISTS (SELECT 1 FROM public.user_achievements WHERE user_id = p_user_id AND achievement_code = 'streak_30') THEN
    INSERT INTO public.user_achievements (user_id, achievement_code) VALUES (p_user_id, 'streak_30');
    v_unlocked_codes := array_append(v_unlocked_codes, 'streak_30');
  END IF;

  RETURN jsonb_build_object('current_streak', v_new_streak, 'unlocked', to_jsonb(v_unlocked_codes));
END $$;

-- 7) Sorteio da hora: published nos dois modos; no modo escolha, só conjuntos APROVADOS
--    (com a definição igual à revisada), o menos usado primeiro (sem repetir em 7 dias
--    enquanto houver ≥ 168 aprovados). Mesma assinatura e mesmo retorno de antes.
CREATE OR REPLACE FUNCTION public.get_or_create_daily_challenge(p_date date DEFAULT CURRENT_DATE)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hour timestamptz := date_trunc('hour', now());
  v_challenge public.daily_challenges;
  v_word public.words;
BEGIN
  SELECT * INTO v_challenge FROM public.daily_challenges WHERE challenge_hour = v_hour;

  IF v_challenge.id IS NULL THEN
    IF public.daily_mode() = 'escolha' THEN
      -- Red Team H1 (08/11): sorteio ALEATÓRIO entre os 24 aprovados menos usados — a palavra
      -- da próxima hora não é previsível (com o "menos usado" puro, depois de um ciclo ela
      -- seria). Com N aprovados, uma palavra não repete antes de N − 24 horas (168 → 6 dias).
      SELECT w.* INTO v_word FROM public.words w
       WHERE w.id = (
         SELECT q.id FROM (
           SELECT w2.id
             FROM public.daily_choice_sets s
             JOIN public.words w2 ON w2.id = s.word_id
            WHERE s.status = 'aprovado' AND w2.status = 'published' AND w2.meaning = s.truth_snapshot
            ORDER BY (SELECT max(c.challenge_hour) FROM public.daily_challenges c WHERE c.word_id = w2.id) ASC NULLS FIRST,
                     random()
            LIMIT 24) q
          ORDER BY random() LIMIT 1);
    END IF;

    IF v_word.id IS NULL THEN
      SELECT * INTO v_word FROM public.words
      WHERE rarity >= 3 AND char_length(meaning) <= 80 AND status = 'published'
      ORDER BY random() LIMIT 1;
    END IF;
    IF v_word.id IS NULL THEN
      SELECT * INTO v_word FROM public.words WHERE status = 'published' ORDER BY random() LIMIT 1;
    END IF;
    IF v_word.id IS NULL THEN
      SELECT * INTO v_word FROM public.words ORDER BY random() LIMIT 1;
    END IF;

    INSERT INTO public.daily_challenges (challenge_date, challenge_hour, word_id)
    VALUES (v_hour::date, v_hour, v_word.id)
    ON CONFLICT (challenge_hour) DO NOTHING
    RETURNING * INTO v_challenge;

    IF v_challenge.id IS NULL THEN
      SELECT * INTO v_challenge FROM public.daily_challenges WHERE challenge_hour = v_hour;
    END IF;
  END IF;

  SELECT * INTO v_word FROM public.words WHERE id = v_challenge.word_id;

  -- Red Team A1 (08/11): no modo escolha a palavra só sai JUNTO com as alternativas
  -- (daily_choice_start, quando o relógio do servidor começa). Aqui volta "?" — o APK
  -- 2.1.4 mostra "?" e, ao enviar, recebe "agora é de múltipla escolha" (nada gasto).
  IF public.daily_mode() = 'escolha' THEN
    RETURN jsonb_build_object(
      'challenge', jsonb_build_object(
        'id', v_challenge.id,
        'challenge_date', v_challenge.challenge_date,
        'challenge_hour', v_challenge.challenge_hour
      ),
      'word', jsonb_build_object('id', NULL, 'word', '?', 'category', NULL)
    );
  END IF;

  RETURN jsonb_build_object(
    'challenge', jsonb_build_object(
      'id', v_challenge.id,
      'challenge_date', v_challenge.challenge_date,
      'challenge_hour', v_challenge.challenge_hour
    ),
    'word', jsonb_build_object('id', v_word.id, 'word', v_word.word, 'category', v_word.category)
  );
END;
$function$;

-- 7b) Red Team A1/H1 (08/11): a palavra da hora CORRENTE não sai por leitura direta nem pelo
--     multiplayer. (i) daily_challenges legível só para horas já encerradas (nenhum cliente lê a
--     tabela: o app usa a RPC; o servidor usa service_role). (ii) choose_word recusa a palavra da
--     hora do Diário (escolher qualquer word_id numa sala e ver a revelação entregava a definição
--     exata) e ela sai das opções sorteadas para o coordenador. Corpo de choose_word = o de
--     20261025140000 + a guarda.
CREATE OR REPLACE FUNCTION public.daily_current_word_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT word_id FROM public.daily_challenges WHERE challenge_hour = date_trunc('hour', now())
$$;

-- A política vigente é "public read daily_challenges" USING (true) (20260520100117; a antiga
-- "past read" foi removida em 20260520004732). Políticas de SELECT se SOMAM: é preciso trocar
-- a liberal, não só criar outra.
DROP POLICY IF EXISTS "public read daily_challenges" ON public.daily_challenges;
DROP POLICY IF EXISTS "daily_challenges past read" ON public.daily_challenges;
CREATE POLICY "daily_challenges past read" ON public.daily_challenges
  FOR SELECT TO anon, authenticated USING (challenge_hour < date_trunc('hour', now()));

CREATE OR REPLACE FUNCTION public.choose_word(p_room_id uuid, p_word_id uuid, p_duration_sec integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
BEGIN
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id FOR UPDATE;
  IF v_room IS NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found'); END IF;
  IF v_room.status <> 'choosing' THEN RETURN jsonb_build_object('ok', false, 'reason', 'invalid_state'); END IF;
  IF v_room.current_word_id IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'already_chosen'); END IF;
  -- Diário D1: a palavra da hora do Desafio Diário não pode ser escolhida numa sala
  IF p_word_id IS NOT DISTINCT FROM public.daily_current_word_id() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'word_unavailable');
  END IF;

  UPDATE public.rooms
  SET status = 'writing',
      current_word_id = p_word_id,
      used_word_ids = CASE
        WHEN p_word_id = ANY(used_word_ids) THEN used_word_ids
        ELSE array_append(used_word_ids, p_word_id)
      END,
      -- escrita: base + 10 s, sem escalar com a sala (2026-10-25)
      round_phase_ends_at = now() + make_interval(secs => public.writing_phase_secs(p_duration_sec)),
      phase_started_at = now()
  WHERE id = p_room_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_random_word_prompts(
  exclude_ids uuid[] DEFAULT ARRAY[]::uuid[],
  min_rarity integer DEFAULT 2,
  lim integer DEFAULT 3,
  p_categories text[] DEFAULT ARRAY[]::text[],
  p_nivel text DEFAULT NULL
)
RETURNS TABLE(id uuid, word text, category text, rarity int, nivel text, classe text, pronuncia text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT w.id, w.word, w.category, w.rarity, w.nivel, w.classe, w.pronuncia
  FROM public.get_random_words(
    -- sem NULL no array: "id = ANY({…,NULL})" excluiria TUDO
    CASE WHEN public.daily_current_word_id() IS NULL THEN exclude_ids
         ELSE array_append(coalesce(exclude_ids, ARRAY[]::uuid[]), public.daily_current_word_id()) END,
    min_rarity, lim, p_categories, p_nivel) AS w;
$function$;

-- 8) Início do modo escolha ------------------------------------------------------------
-- {status:'mode', mode}         modo vigente não é 'escolha' (o cliente usa o fluxo do modo)
-- {status:'already_played'}     já jogou nesta hora (em QUALQUER modo)
-- {status:'sem_estoque'}        palavra da hora sem conjunto aprovado: pausa, nada gasto
-- {status:'ok', word, category, options:[{pos,text}×4], elapsed_s, hour}
--    Idempotente: reabrir na mesma hora devolve a MESMA ordem e o MESMO relógio.
--    Nunca devolve a posição da correta, ids ou hash.
CREATE OR REPLACE FUNCTION public.daily_choice_start(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_mode  text := public.daily_mode();
  v_hour  timestamptz := date_trunc('hour', now());
  v_sess  public.daily_choice_sessions;
  v_word  public.words;
  v_set   public.daily_choice_sets;
  v_perm  smallint[];
  v_canon text[];
  v_opts  text[];
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'daily_choice_start: usuário ausente' USING ERRCODE = '22023';
  END IF;
  IF v_mode <> 'escolha' THEN
    RETURN jsonb_build_object('status', 'mode', 'mode', v_mode);
  END IF;

  -- mesma trava da V2 (daily_claim/daily_finish_ok): serializa tudo do usuário/hora
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || '|' || v_hour::text, 0));

  IF EXISTS (SELECT 1 FROM public.daily_attempts WHERE user_id = p_user_id AND challenge_hour = v_hour) THEN
    RETURN jsonb_build_object('status', 'already_played');
  END IF;

  SELECT * INTO v_sess FROM public.daily_choice_sessions
   WHERE user_id = p_user_id AND challenge_hour = v_hour;
  IF NOT FOUND THEN
    PERFORM public.get_or_create_daily_challenge();
    SELECT w.* INTO v_word
      FROM public.daily_challenges c JOIN public.words w ON w.id = c.word_id
     WHERE c.challenge_hour = v_hour;
    SELECT * INTO v_set FROM public.daily_choice_sets
     WHERE word_id = v_word.id AND status = 'aprovado';
    IF NOT FOUND OR v_word.status IS DISTINCT FROM 'published' OR v_word.meaning IS DISTINCT FROM v_set.truth_snapshot THEN
      RETURN jsonb_build_object('status', 'sem_estoque');
    END IF;

    v_perm  := public.daily_choice_new_perm();
    v_canon := ARRAY[public.daily_choice_fmt(v_word.meaning), public.daily_choice_fmt(v_set.distractors[1]),
                     public.daily_choice_fmt(v_set.distractors[2]), public.daily_choice_fmt(v_set.distractors[3])];
    v_opts  := ARRAY[v_canon[v_perm[1] + 1], v_canon[v_perm[2] + 1], v_canon[v_perm[3] + 1], v_canon[v_perm[4] + 1]];
    INSERT INTO public.daily_choice_sessions (user_id, challenge_hour, word_id, options, correct_pos)
    VALUES (p_user_id, v_hour, v_word.id, v_opts, (array_position(v_perm, 0::smallint) - 1)::smallint)
    RETURNING * INTO v_sess;
  ELSE
    SELECT * INTO v_word FROM public.words WHERE id = v_sess.word_id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'word', v_word.word,
    'category', v_word.category,
    'options', (SELECT jsonb_agg(jsonb_build_object('pos', k.n - 1, 'text', v_sess.options[k.n]) ORDER BY k.n)
                  FROM generate_series(1, 4) AS k(n)),
    'elapsed_s', LEAST(600, GREATEST(0, floor(extract(epoch FROM now() - v_sess.issued_at))))::int,
    -- a hora das alternativas mostradas: volta no envio (Red Team A4)
    'hour', v_sess.challenge_hour
  );
END $$;

-- 9) Fim do modo escolha ---------------------------------------------------------------
-- {status:'recorded', result:{already_played:false, is_correct, score, truth, chosen,
--                             correct_pos, chosen_pos, time_seconds, word, current_streak, unlocked, mode}}
-- {status:'already_played'} · {status:'mode_changed'} · {status:'no_session'} · {status:'hour_changed'}
-- Nada é gravado (tentativa NÃO gasta) fora de 'recorded'.
-- D-c: acerto = max(round(max(100 − t, 20) × 0,5), 10); erro = 0; t = agora − issued_at (servidor, ≤ 600).
CREATE OR REPLACE FUNCTION public.daily_choice_finish(p_user_id uuid, p_pos integer, p_hour timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_hour    timestamptz := date_trunc('hour', now());
  v_sess    public.daily_choice_sessions;
  v_word    public.words;
  v_t       integer;
  v_correct boolean;
  v_score   integer := 0;
  v_part    jsonb;
BEGIN
  IF p_user_id IS NULL OR p_pos IS NULL OR p_pos < 0 OR p_pos > 3 THEN
    RAISE EXCEPTION 'daily_choice_finish: entrada inválida' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || '|' || v_hour::text, 0));

  IF public.daily_mode() <> 'escolha' THEN
    RETURN jsonb_build_object('status', 'mode_changed');
  END IF;
  -- Red Team A4: a resposta vale só para as alternativas da hora que o jogador VIU
  -- (aba antiga aberta na hora anterior não responde pela sessão da hora nova)
  IF p_hour IS NOT NULL AND p_hour <> v_hour THEN
    RETURN jsonb_build_object('status', 'hour_changed');
  END IF;
  IF EXISTS (SELECT 1 FROM public.daily_attempts WHERE user_id = p_user_id AND challenge_hour = v_hour) THEN
    RETURN jsonb_build_object('status', 'already_played');
  END IF;

  SELECT * INTO v_sess FROM public.daily_choice_sessions
   WHERE user_id = p_user_id AND challenge_hour = v_hour AND finished_at IS NULL;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.daily_choice_sessions
                WHERE user_id = p_user_id AND challenge_hour = v_hour - interval '1 hour' AND finished_at IS NULL) THEN
      RETURN jsonb_build_object('status', 'hour_changed');
    END IF;
    RETURN jsonb_build_object('status', 'no_session');
  END IF;

  v_t := LEAST(600, GREATEST(0, floor(extract(epoch FROM now() - v_sess.issued_at))))::int;
  v_correct := (p_pos = v_sess.correct_pos);
  IF v_correct THEN
    v_score := GREATEST(ROUND(GREATEST(100 - v_t, 20) * 0.5)::int, 10);
  END IF;

  BEGIN
    INSERT INTO public.daily_attempts
      (user_id, challenge_date, challenge_hour, guess, is_correct, score, time_seconds, similarity, mode)
    VALUES (p_user_id, v_hour::date, v_hour, v_sess.options[p_pos + 1], v_correct, v_score, v_t, 0, 'escolha');
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('status', 'already_played');
  END;

  v_part := public.daily_record_participation(p_user_id, v_hour, v_score);
  UPDATE public.daily_choice_sessions SET finished_at = now()
   WHERE user_id = p_user_id AND challenge_hour = v_hour;
  SELECT * INTO v_word FROM public.words WHERE id = v_sess.word_id;

  RETURN jsonb_build_object('status', 'recorded', 'result', jsonb_build_object(
    'already_played', false,
    'is_correct', v_correct,
    'score', v_score,
    'truth', v_sess.options[v_sess.correct_pos + 1],
    'chosen', v_sess.options[p_pos + 1],
    'correct_pos', v_sess.correct_pos,
    'chosen_pos', p_pos,
    'time_seconds', v_t,
    'word', v_word.word,
    'current_streak', (v_part ->> 'current_streak')::int,
    'unlocked', v_part -> 'unlocked',
    'mode', 'escolha'));
END $$;

-- 10) Revisão do jogador: + modo da tentativa e modo vigente (campos novos; o resto igual)
CREATE OR REPLACE FUNCTION public.get_my_daily_review()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $function$
DECLARE
  v_hour timestamptz := date_trunc('hour', now());
  v_attempt public.daily_attempts;
  v_challenge public.daily_challenges;
  v_word public.words;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  SELECT * INTO v_attempt FROM public.daily_attempts
  WHERE user_id = auth.uid() AND challenge_hour = v_hour;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('played', false, 'daily_mode', public.daily_mode());
  END IF;

  SELECT * INTO v_challenge FROM public.daily_challenges WHERE challenge_hour = v_hour;
  SELECT * INTO v_word FROM public.words WHERE id = v_challenge.word_id;

  RETURN jsonb_build_object(
    'played', true,
    'attempt', jsonb_build_object(
      'guess', v_attempt.guess,
      'is_correct', v_attempt.is_correct,
      'score', v_attempt.score,
      'time_seconds', v_attempt.time_seconds,
      'similarity', v_attempt.similarity,
      'challenge_hour', v_attempt.challenge_hour,
      'mode', v_attempt.mode
    ),
    'truth', v_word.meaning,
    'word', v_word.word,
    'daily_mode', public.daily_mode()
  );
END;
$function$;

-- 11) Placar do Diário com o modo: não mistura os modos. Sem p_mode = modo vigente
--     ('pausa' = todos). Cliente antigo chama só com p_limit e ignora a coluna nova.
DROP FUNCTION IF EXISTS public.get_daily_leaderboard(integer);
CREATE OR REPLACE FUNCTION public.get_daily_leaderboard(p_limit integer DEFAULT 20, p_mode text DEFAULT NULL)
RETURNS TABLE (user_id uuid, score integer, is_correct boolean, time_seconds integer, mode text)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path TO 'public'
AS $$
  WITH m AS (
    SELECT CASE WHEN p_mode IN ('juiz', 'escolha') THEN p_mode
                WHEN p_mode IS NULL AND public.daily_mode() IN ('juiz', 'escolha') THEN public.daily_mode()
           END AS mode
  )
  SELECT a.user_id, a.score, a.is_correct, a.time_seconds, a.mode
  FROM public.daily_attempts a, m
  WHERE a.challenge_hour = date_trunc('hour', now())
    AND (m.mode IS NULL OR a.mode = m.mode)
  ORDER BY a.score DESC, a.time_seconds ASC
  LIMIT GREATEST(1, LEAST(p_limit, 100));
$$;

-- 12) Revisão editorial (só service_role; o Worker confere o papel admin) ----------------
-- Elegível ao Diário = a regra atual (rarity >= 3, definição ≤ 80) + publicada.
CREATE OR REPLACE FUNCTION public.daily_choice_admin_list(p_status text DEFAULT 'rascunho', p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT jsonb_build_object(
    'counts', jsonb_build_object(
      'rascunho',  (SELECT count(*) FROM public.daily_choice_sets WHERE status = 'rascunho'),
      'aprovado',  (SELECT count(*) FROM public.daily_choice_sets WHERE status = 'aprovado'),
      'reprovado', (SELECT count(*) FROM public.daily_choice_sets WHERE status = 'reprovado'),
      'aprovado_jogavel', (SELECT count(*) FROM public.daily_choice_sets s JOIN public.words w ON w.id = s.word_id
                            WHERE s.status = 'aprovado' AND w.status = 'published' AND w.meaning = s.truth_snapshot),
      'sem_conjunto', (SELECT count(*) FROM public.words w
                        WHERE w.status = 'published' AND w.rarity >= 3 AND char_length(w.meaning) <= 80
                          AND NOT EXISTS (SELECT 1 FROM public.daily_choice_sets s WHERE s.word_id = w.id))),
    'total', (SELECT count(*) FROM public.daily_choice_sets WHERE status = p_status),
    'items', coalesce((
      SELECT jsonb_agg(x ORDER BY x->>'word') FROM (
        SELECT jsonb_build_object(
          'word_id', s.word_id, 'word', w.word, 'truth', w.meaning, 'category', w.category, 'classe', w.classe,
          'distractors', to_jsonb(s.distractors), 'status', s.status, 'validacao', s.validacao,
          'truth_changed', w.meaning IS DISTINCT FROM s.truth_snapshot,
          'published', w.status = 'published', 'reviewed_at', s.reviewed_at) AS x
          FROM public.daily_choice_sets s JOIN public.words w ON w.id = s.word_id
         WHERE s.status = p_status
         ORDER BY w.word
         LIMIT GREATEST(1, LEAST(coalesce(p_limit, 50), 200)) OFFSET GREATEST(0, coalesce(p_offset, 0))
      ) q), '[]'::jsonb)
  )
$$;

CREATE OR REPLACE FUNCTION public.daily_choice_admin_get(p_word_ids uuid[])
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'word_id', w.id, 'word', w.word, 'truth', w.meaning, 'published', w.status = 'published',
           'distractors', to_jsonb(s.distractors), 'status', s.status,
           'truth_changed', s.word_id IS NOT NULL AND w.meaning IS DISTINCT FROM s.truth_snapshot)), '[]'::jsonb)
    FROM public.words w LEFT JOIN public.daily_choice_sets s ON s.word_id = w.id
   WHERE w.id = ANY (p_word_ids[1:200])
$$;

-- palavras elegíveis SEM conjunto (alvos) + todas as publicadas (fonte de distratores)
CREATE OR REPLACE FUNCTION public.daily_choice_admin_pool(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT jsonb_build_object(
    'targets', coalesce((SELECT jsonb_agg(t ORDER BY t->>'word') FROM (
        SELECT jsonb_build_object('id', w.id, 'word', w.word, 'meaning', w.meaning, 'classe', w.classe, 'category', w.category) AS t
          FROM public.words w
         WHERE w.status = 'published' AND w.rarity >= 3 AND char_length(w.meaning) <= 80
           AND NOT EXISTS (SELECT 1 FROM public.daily_choice_sets s WHERE s.word_id = w.id)
         ORDER BY w.word
         LIMIT GREATEST(1, LEAST(coalesce(p_limit, 200), 1000))) q), '[]'::jsonb),
    'pool', coalesce((SELECT jsonb_agg(jsonb_build_object('id', w.id, 'word', w.word, 'meaning', w.meaning,
                                                         'classe', w.classe, 'category', w.category))
                        FROM public.words w WHERE w.status = 'published'), '[]'::jsonb)
  )
$$;

-- grava RASCUNHOS (nunca aprovados): [{word_id, distractors[3], validacao}]
CREATE OR REPLACE FUNCTION public.daily_choice_admin_add_drafts(p_rows jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n integer;
BEGIN
  INSERT INTO public.daily_choice_sets (word_id, distractors, truth_snapshot, status, origem, validacao)
  SELECT w.id, ARRAY(SELECT jsonb_array_elements_text(r.distractors)), w.meaning, 'rascunho', 'acervo',
         coalesce(r.validacao, '{}'::jsonb)
    FROM jsonb_to_recordset(p_rows) AS r(word_id uuid, distractors jsonb, validacao jsonb)
    JOIN public.words w ON w.id = r.word_id AND w.status = 'published'
   WHERE jsonb_array_length(r.distractors) = 3
  ON CONFLICT (word_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- edição de distratores: volta a RASCUNHO e atualiza a verdade revisada
CREATE OR REPLACE FUNCTION public.daily_choice_admin_edit(p_word_id uuid, p_distractors text[], p_validacao jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n integer;
BEGIN
  IF array_length(p_distractors, 1) IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'daily_choice_admin_edit: são precisos 3 distratores' USING ERRCODE = '22023';
  END IF;
  UPDATE public.daily_choice_sets s
     SET distractors = p_distractors, validacao = coalesce(p_validacao, '{}'::jsonb),
         truth_snapshot = w.meaning, status = 'rascunho', reviewed_by = NULL, reviewed_at = NULL, updated_at = now()
    FROM public.words w
   WHERE s.word_id = p_word_id AND w.id = s.word_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_n);
END $$;

-- aprovação/reprovação SÓ dos ids escolhidos pelo revisor (individual ou lote selecionado).
-- Aprovar exige: validador OK, palavra publicada e a definição igual à revisada.
CREATE OR REPLACE FUNCTION public.daily_choice_admin_review(p_word_ids uuid[], p_status text, p_reviewer uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_n integer; v_req integer := coalesce(array_length(p_word_ids, 1), 0);
BEGIN
  IF p_status NOT IN ('aprovado', 'reprovado', 'rascunho') OR p_reviewer IS NULL OR v_req = 0 OR v_req > 200 THEN
    RAISE EXCEPTION 'daily_choice_admin_review: entrada inválida' USING ERRCODE = '22023';
  END IF;
  UPDATE public.daily_choice_sets s
     SET status = p_status,
         reviewed_by = CASE WHEN p_status = 'rascunho' THEN NULL ELSE p_reviewer END,
         reviewed_at = CASE WHEN p_status = 'rascunho' THEN NULL ELSE now() END,
         updated_at = now()
    FROM public.words w
   WHERE s.word_id = ANY (p_word_ids) AND w.id = s.word_id
     AND (p_status <> 'aprovado'
          OR (w.status = 'published' AND w.meaning = s.truth_snapshot AND (s.validacao ->> 'ok') = 'true'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_n, 'skipped', v_req - v_n);
END $$;

-- 13) Limpeza das sessões (dado operacional; a tentativa fica em daily_attempts) -----------
CREATE OR REPLACE FUNCTION public.daily_choice_cleanup()
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  DELETE FROM public.daily_choice_sessions WHERE challenge_hour < now() - interval '3 days';
$$;

-- 14) Permissões ------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.daily_mode() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_current_word_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_new_perm() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_fmt(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_record_participation(uuid, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_start(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_finish(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_admin_list(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_admin_get(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_admin_pool(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_admin_add_drafts(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_admin_edit(uuid, text[], jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_admin_review(uuid[], text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.daily_choice_cleanup() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.daily_choice_start(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_choice_finish(uuid, integer, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_mode() TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_choice_admin_list(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_choice_admin_get(uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_choice_admin_pool(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_choice_admin_add_drafts(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_choice_admin_edit(uuid, text[], jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_choice_admin_review(uuid[], text, uuid) TO service_role;
-- o placar foi recriado: mesmas permissões de antes (authenticated, nunca anon)
REVOKE ALL ON FUNCTION public.get_daily_leaderboard(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_daily_leaderboard(integer, text) TO authenticated, service_role;

-- 15) Cron de limpeza (só se o pg_cron existir) ---------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'verbete-daily-choice-cleanup') THEN
      PERFORM cron.unschedule('verbete-daily-choice-cleanup');
    END IF;
    PERFORM cron.schedule('verbete-daily-choice-cleanup', '23 * * * *', 'SELECT public.daily_choice_cleanup();');
  END IF;
END $$;
