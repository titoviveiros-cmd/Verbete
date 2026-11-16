-- =============================================================================
-- G3 do PR #62 (bots sem IA externa), OPÇÃO C — reserva atômica das
-- definições servidas na rodada (12/11/2026). RASCUNHO/EXPERIMENTO: só é usada
-- pelas edges com BOTS_OFFLINE_GENERATOR ligado (e ai_mode = 'suspenso').
--
-- Problema: no pior caso simultâneo (bots, 🤖 e 💡 de vários jogadores pedindo
-- ao mesmo tempo), nenhuma chamada vê a gravação da outra; a gravação de hoje
-- (upsert ON CONFLICT DO NOTHING em ai_served_defs) só barra o texto IGUAL.
-- Duas frases PARECIDAS (Dice de trigramas > 0,5) apareciam na mesma rodada
-- em 17,65% das rodadas (simulador, 600 partidas).
--
-- Solução: UMA função, UMA transação por chamada da edge:
--   1. pg_advisory_xact_lock(sala, rodada): as reservas da mesma sala+rodada
--      ficam em fila (no máximo ~1 + 2 × jogadores por rodada); salas
--      diferentes não se esperam. Uma trava só por transação = reservas não
--      entram em deadlock entre si.
--   2. lê o que a rodada JÁ GRAVOU (as chamadas anteriores da fila já
--      commitaram) e, para cada candidata, NA ORDEM, recusa se for igual ou
--      parecida (Dice > 0,5, exatamente o critério de logic.ts/dice:
--      trigramas de " texto ") com a rodada ou com o que esta chamada já
--      aceitou. A perdedora de uma disputa segue para a próxima candidata
--      (laço limitado: 24 candidatas, 20 aceitas; sem ida e volta extra);
--   3. grava as aceitas em ai_served_defs num INSERT só (ordenado, ON
--      CONFLICT DO NOTHING) e devolve os índices (base 1) das que ESTA
--      chamada gravou. A edge devolve SÓ esses.
-- Sem tabela nova: a memória da rodada já existe (ai_served_defs, PK
-- (room_id, round, norm_text), CASCADE de rooms, limpa pela retenção).
--
-- Segurança: SECURITY INVOKER (roda com os direitos de quem chama); EXECUTE só
-- para service_role (as edges). anon/authenticated não executam e já não
-- tocam ai_served_defs (REVOKE ALL na migration 20260723110000).
-- Banco lento: lock_timeout de 1,5 s na espera da trava → erro → a edge segue
-- o caminho de antes (opção B: releitura + upsert + keepClaimed).
--
-- Rollback: supabase/rollback/offline_claim_defs.sql (DROP FUNCTION; a tabela
-- e os dados ficam intactos; as edges voltam sozinhas ao caminho B).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.offline_claim_defs(
  p_room uuid,
  p_round integer,
  p_norms text[],
  p_want integer
)
RETURNS integer[]
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
SET lock_timeout TO '1500ms'
AS $$
DECLARE
  v_n integer := COALESCE(array_length(p_norms, 1), 0);
  v_out integer[] := '{}';   -- índices aceitos (base 1), na ordem da lista
  v_new text[] := '{}';      -- textos aceitos, na mesma ordem
  v_ins text[];
  v_st text[];               -- textos da rodada (gravados + aceitos agora)
  v_sk integer[] := '{}';    -- trigramas da rodada, achatados: dono (índice em v_st)…
  v_sg text[] := '{}';       -- …e o trigrama
  v_sn integer[] := '{}';    -- nº de trigramas de cada texto de v_st
  v_i integer;
  v_t text;
  v_g text[];
BEGIN
  IF p_room IS NULL OR p_round IS NULL OR p_want IS NULL THEN
    RAISE EXCEPTION 'offline_claim_defs: argumento nulo' USING ERRCODE = '22004';
  END IF;
  IF v_n > 24 OR p_want < 0 OR p_want > 20 OR p_round < 0 THEN
    RAISE EXCEPTION 'offline_claim_defs: fora dos limites' USING ERRCODE = '22023';
  END IF;
  IF v_n = 0 OR p_want = 0 THEN
    RETURN v_out;
  END IF;

  -- fila por sala+rodada (as outras salas não esperam); 1 trava por transação
  PERFORM pg_advisory_xact_lock(hashtext('verbete:offline-claim:' || p_room::text), p_round);

  -- o que a rodada já gravou (commitado antes de pegarmos a trava)
  SELECT COALESCE(array_agg(s.norm_text), '{}')
    INTO v_st
    FROM public.ai_served_defs s
   WHERE s.room_id = p_room AND s.round = p_round;
  FOR v_i IN 1..COALESCE(array_length(v_st, 1), 0) LOOP
    -- trigramas de " texto " (= trigrams() de logic.ts)
    SELECT COALESCE(array_agg(DISTINCT substr(' ' || v_st[v_i] || ' ', j, 3)), '{}')
      INTO v_g
      FROM generate_series(1, length(v_st[v_i])) AS j;
    v_sk := v_sk || array_fill(v_i, ARRAY[cardinality(v_g)]);
    v_sg := v_sg || v_g;
    v_sn := v_sn || cardinality(v_g);
  END LOOP;

  FOR v_i IN 1..v_n LOOP
    EXIT WHEN cardinality(v_out) >= p_want;
    v_t := p_norms[v_i];
    -- só o texto normalizado da edge (normTxt: [a-z0-9] e espaço simples)
    CONTINUE WHEN v_t IS NULL OR length(v_t) = 0 OR length(v_t) > 200
      OR v_t !~ '^[a-z0-9]+( [a-z0-9]+)*$';
    CONTINUE WHEN v_t = ANY (v_st);
    SELECT COALESCE(array_agg(DISTINCT substr(' ' || v_t || ' ', j, 3)), '{}')
      INTO v_g
      FROM generate_series(1, length(v_t)) AS j;
    -- Dice > 0,5  ⇔  4·|A∩B| > |A| + |B|  (inteiro, sem arredondar)
    CONTINUE WHEN EXISTS (
      SELECT 1
        FROM (
          SELECT s.k, count(*) AS c
            FROM unnest(v_sk, v_sg) AS s(k, g)
           WHERE s.g = ANY (v_g)
           GROUP BY s.k
        ) x
       WHERE 4 * x.c > v_sn[x.k] + cardinality(v_g)
    );
    v_out := v_out || v_i;
    v_new := v_new || v_t;
    v_st := v_st || v_t;
    v_sk := v_sk || array_fill(cardinality(v_st), ARRAY[cardinality(v_g)]);
    v_sg := v_sg || v_g;
    v_sn := v_sn || cardinality(v_g);
  END LOOP;

  IF cardinality(v_new) > 0 THEN
    -- UMA gravação, em ordem (sem trava de linha durante o laço). Quem grava
    -- sem a trava (caminho antigo) pode ter gravado o mesmo texto: aí ele não
    -- volta no RETURNING e a candidata NÃO é desta chamada.
    WITH ins AS (
      INSERT INTO public.ai_served_defs (room_id, round, norm_text)
      SELECT p_room, p_round, x.t
        FROM unnest(v_new) AS x(t)
       ORDER BY x.t
      ON CONFLICT (room_id, round, norm_text) DO NOTHING
      RETURNING norm_text
    )
    SELECT COALESCE(array_agg(ins.norm_text), '{}') INTO v_ins FROM ins;
    SELECT COALESCE(array_agg(u.i ORDER BY u.o), '{}')
      INTO v_out
      FROM unnest(v_out, v_new) WITH ORDINALITY AS u(i, t, o)
     WHERE u.t = ANY (v_ins);
  END IF;

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.offline_claim_defs(uuid, integer, text[], integer) IS
  'G3 opção C (PR #62): reserva atômica na memória da rodada (ai_served_defs), recusando igual ou Dice > 0,5; só service_role.';

REVOKE ALL ON FUNCTION public.offline_claim_defs(uuid, integer, text[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.offline_claim_defs(uuid, integer, text[], integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.offline_claim_defs(uuid, integer, text[], integer) TO service_role;
