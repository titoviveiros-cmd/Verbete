// Trava dos 168 (11/11/2026): a IA só pode ser suspensa de forma PLANEJADA
// (ai_mode='suspenso', passo da janela do modo sem IA — docs/sem-ia-externa.md)
// com o Desafio Diário já em 'escolha' e com ≥ 168 conjuntos APROVADOS
// JOGÁVEIS. Abaixo disso o Diário entra em pausa ('juiz' + IA suspensa) ou em
// 'sem_estoque' ('escolha' sem conjunto da hora).
//
// Falha FECHADA: sem resposta do banco, contagem ilegível ou modo desconhecido
// = recusa. A única exceção é a CONTENÇÃO de emergência (chave vazada, custo
// fora de controle — docs/contencao-ia.md): flag explícita --emergencia, que
// avisa que o Diário vai pausar.
//
// "Aprovado jogável" = o MESMO critério do painel (daily_choice_admin_list,
// migration 20261108120000) e do sorteio (get_or_create_daily_challenge):
// conjunto 'aprovado', palavra 'published' e verdade igual ao snapshot.

export const META_APROVADOS_JOGAVEIS = 168;

export const SQL_PRONTIDAO_SEM_IA = `
SELECT
  (SELECT value FROM public.app_config WHERE key = 'daily_mode') AS daily_mode,
  (SELECT count(*) FROM public.daily_choice_sets s
     JOIN public.words w ON w.id = s.word_id
    WHERE s.status = 'aprovado'
      AND w.status = 'published'
      AND w.meaning = s.truth_snapshot)::int AS aprovado_jogavel`;

/**
 * Decisão pura (testada no Vitest). `daily_mode` ausente no banco = 'juiz'
 * (padrão da função public.daily_mode()).
 */
export function avaliarProntidaoSemIa(row, meta = META_APROVADOS_JOGAVEIS) {
  const motivos = [];
  const n = Number(row?.aprovado_jogavel);
  if (!Number.isInteger(n) || n < 0) {
    motivos.push("contagem de aprovados jogáveis ilegível");
  } else if (n < meta) {
    motivos.push(`aprovados jogáveis = ${n} (< ${meta})`);
  }
  const raw = row?.daily_mode;
  const modo =
    raw == null ? "juiz" : typeof raw === "string" ? raw.trim().toLowerCase() : "?";
  if (modo !== "escolha") {
    motivos.push(`daily_mode = '${modo}' (precisa ser 'escolha')`);
  }
  return {
    ok: motivos.length === 0,
    aprovadoJogavel: Number.isInteger(n) ? n : null,
    dailyMode: modo,
    motivos,
  };
}

/** Lê o banco e decide. Qualquer erro = recusa (falha fechada). */
export async function checarProntidaoSemIa(query, meta = META_APROVADOS_JOGAVEIS) {
  try {
    const res = await query(SQL_PRONTIDAO_SEM_IA);
    const row = res?.rows?.[0];
    if (!row) {
      return { ok: false, aprovadoJogavel: null, dailyMode: null, motivos: ["consulta sem linha"] };
    }
    return avaliarProntidaoSemIa(row, meta);
  } catch (e) {
    return {
      ok: false,
      aprovadoJogavel: null,
      dailyMode: null,
      motivos: [`falha ao ler o banco (${e?.code ?? "erro"})`],
    };
  }
}

/**
 * Trava das trocas de app_config que dependem do estoque do Diário:
 *  - ai_mode='suspenso'   → exige 'escolha' + ≥ 168 (ou --emergencia);
 *  - daily_mode='escolha' → exige ≥ 168 (o modo em si é o que está mudando).
 * Outras chaves/valores (inclusive os ROLLBACKS ai_mode='ligado' e
 * daily_mode='juiz') passam sem consulta.
 */
export async function travaAppConfig({ key, value, emergencia = false, query }) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : value;
  if (key === "ai_mode" && v === "suspenso") {
    if (emergencia) {
      return {
        ok: true,
        aviso:
          "EMERGÊNCIA: trava dos 168 ignorada. Com daily_mode='juiz' o Desafio Diário entra em pausa; " +
          "com 'escolha' e estoque baixo, horas sem conjunto aprovado ficam em 'sem_estoque'.",
      };
    }
    const r = await checarProntidaoSemIa(query);
    return r.ok
      ? { ok: true, prontidao: r }
      : { ok: false, prontidao: r, erro: `ai_mode='suspenso' recusado: ${r.motivos.join("; ")}` };
  }
  if (key === "daily_mode" && v === "escolha") {
    const r = await checarProntidaoSemIa(query);
    // aqui o daily_mode ainda é o antigo: só o estoque conta
    const motivos = r.motivos.filter((m) => !m.startsWith("daily_mode"));
    return motivos.length === 0
      ? { ok: true, prontidao: r }
      : { ok: false, prontidao: r, erro: `daily_mode='escolha' recusado: ${motivos.join("; ")}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Portões por FASE da transição (11/11/2026, R3) — só leitura, falha fechada.
// Ordem: escolha → suspender → textos → revogar (docs/sem-ia-externa.md §4).
// Cada fase lista o que o banco PROVA; o que o banco não vê (segredos
// BOTS_OFFLINE_GENERATOR/AI_FORCE_SUSPEND, versão das edges/Worker) sai em
// `manuais`, para o operador conferir antes de seguir.
// ---------------------------------------------------------------------------

export const FASES = ["escolha", "suspender", "textos", "revogar"];

/** Eventos que só existem quando o provedor de IA foi chamado. */
export const EVENTOS_IA = [
  "judge_ai_success",
  "judge_ai_error",
  "bot_ai_success",
  "bot_ai_error",
  "bot_ai_fallback",
];

const IA_IN = EVENTOS_IA.map((k) => `'${k}'`).join(", ");

export const SQL_FASES_SEM_IA = `
SELECT
  (SELECT value FROM public.app_config WHERE key = 'daily_mode') AS daily_mode,
  (SELECT extract(epoch FROM now() - updated_at) / 3600 FROM public.app_config WHERE key = 'daily_mode')::float8 AS h_desde_daily_mode,
  (SELECT value FROM public.app_config WHERE key = 'ai_mode') AS ai_mode,
  (SELECT extract(epoch FROM now() - updated_at) / 60 FROM public.app_config WHERE key = 'ai_mode')::float8 AS min_desde_ai_mode,
  (SELECT count(*) FROM public.daily_choice_sets s
     JOIN public.words w ON w.id = s.word_id
    WHERE s.status = 'aprovado'
      AND w.status = 'published'
      AND w.meaning = s.truth_snapshot)::int AS aprovado_jogavel,
  (SELECT count(*) FROM public.ops_events
    WHERE kind = 'daily_choice_finish' AND payload->>'result' IN ('correct', 'wrong')
      AND at > now() - interval '24 hours')::int AS escolha_jogadas_24h,
  (SELECT count(*) FROM public.ops_events
    WHERE kind = 'daily_choice_start' AND payload->>'result' = 'sem_estoque'
      AND at > now() - interval '24 hours')::int AS sem_estoque_24h,
  (SELECT count(*) FROM public.ops_events
    WHERE kind IN (${IA_IN})
      AND at > (SELECT updated_at FROM public.app_config WHERE key = 'ai_mode') + interval '60 seconds')::int AS ia_desde_ai_mode,
  (SELECT count(*) FROM public.ops_events
    WHERE kind IN (${IA_IN}) AND at > now() - interval '24 hours')::int AS ia_24h,
  (SELECT coalesce(array_agg(DISTINCT payload->>'fn'), '{}') FROM public.ops_events
    WHERE kind = 'ai_suspended' AND at > now() - interval '1 hour') AS fns_suspensas_1h`;

const num = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const txt = (v) => (typeof v === "string" ? v.trim().toLowerCase() : null);

/**
 * Decisão pura de uma fase. `bloqueios` vazios = pode seguir; `avisos` não
 * bloqueiam; `manuais` = conferir fora do banco. Valor ilegível = bloqueio.
 */
export function avaliarFaseSemIa(fase, row, meta = META_APROVADOS_JOGAVEIS) {
  const bloqueios = [];
  const avisos = [];
  const manuais = [];
  if (!FASES.includes(fase)) return { ok: false, fase, bloqueios: [`fase desconhecida: ${fase}`], avisos, manuais };
  const r = row ?? {};
  const n = num(r.aprovado_jogavel);
  const dm = r.daily_mode == null ? "juiz" : txt(r.daily_mode);
  const am = r.ai_mode == null ? "ligado" : txt(r.ai_mode);
  const hDm = num(r.h_desde_daily_mode);
  const minAm = num(r.min_desde_ai_mode);
  const jogadas = num(r.escolha_jogadas_24h);
  const semEstoque = num(r.sem_estoque_24h);
  const iaDesde = num(r.ia_desde_ai_mode);
  const ia24 = num(r.ia_24h);
  const fns = Array.isArray(r.fns_suspensas_1h) ? r.fns_suspensas_1h : [];

  if (n == null || !Number.isInteger(n)) bloqueios.push("contagem de aprovados jogáveis ilegível");
  else if (n < meta) bloqueios.push(`aprovados jogáveis = ${n} (< ${meta})`);
  if (fase === "escolha") {
    manuais.push("conta de teste: Diário em escolha só depois desta troca (passo seguinte)");
    return { ok: bloqueios.length === 0, fase, bloqueios, avisos, manuais };
  }

  // suspender, textos, revogar: Diário em escolha, jogado e sem falta de estoque
  if (dm !== "escolha") bloqueios.push(`daily_mode = '${dm}' (precisa ser 'escolha')`);
  if (hDm == null) bloqueios.push("hora da troca do daily_mode ilegível");
  else if (fase === "suspender" && hDm < 24) bloqueios.push(`Diário em escolha há ${hDm.toFixed(1)} h (< 24 h de observação)`);
  if (jogadas == null) bloqueios.push("jogadas do Diário ilegíveis");
  else if (jogadas < 1) bloqueios.push("nenhuma jogada concluída do Diário em escolha nas últimas 24 h");
  if (semEstoque == null) bloqueios.push("contagem de sem_estoque ilegível");
  else if (semEstoque > 0) bloqueios.push(`${semEstoque} 'sem_estoque' nas últimas 24 h`);

  if (fase === "suspender") {
    if (am !== "ligado") avisos.push(`ai_mode já é '${am}'`);
    manuais.push("npx supabase secrets list → BOTS_OFFLINE_GENERATOR presente (só o NOME) e edges do #62 no ar (sem ele, bots usam as 62 frases fixas)");
    return { ok: bloqueios.length === 0, fase, bloqueios, avisos, manuais };
  }

  // textos, revogar: IA de fato parada desde a suspensão
  if (am !== "suspenso") bloqueios.push(`ai_mode = '${am}' (precisa ser 'suspenso')`);
  if (minAm == null) bloqueios.push("hora da troca do ai_mode ilegível");
  else if (fase === "textos" && minAm < 5) bloqueios.push(`ai_mode suspenso há ${minAm.toFixed(1)} min (< 5 min: caches de 30 s e reenvios do juiz)`);
  else if (fase === "revogar" && minAm < 24 * 60) bloqueios.push(`ai_mode suspenso há ${(minAm / 60).toFixed(1)} h (< 24 h)`);
  if (iaDesde == null) bloqueios.push("eventos de IA desde a suspensão ilegíveis");
  else if (iaDesde > 0) bloqueios.push(`${iaDesde} evento(s) de chamada à IA depois da suspensão`);
  if (fase === "revogar") {
    if (ia24 == null) bloqueios.push("eventos de IA em 24 h ilegíveis");
    else if (ia24 > 0) bloqueios.push(`${ia24} evento(s) de chamada à IA nas últimas 24 h`);
  }
  for (const fn of ["score-similarity", "bot-definitions-v2"])
    if (!fns.includes(fn)) avisos.push(`sem 'ai_suspended' de ${fn} na última hora (sem tráfego? jogar 1 partida com bots)`);
  manuais.push("npx supabase secrets list → AI_FORCE_SUSPEND presente (só o NOME)");
  if (fase === "textos")
    manuais.push("anotar Version do Worker (npx wrangler deployments list) e SHA das edges no ar ANTES do deploy");
  if (fase === "revogar")
    manuais.push("Worker e edges com o #63 'desligada' no ar (smoke §5.2 verde) antes de remover/revogar a chave");
  return { ok: bloqueios.length === 0, fase, bloqueios, avisos, manuais };
}

/** Lê o banco e avalia a fase. Erro = bloqueio (falha fechada). */
export async function checarFaseSemIa(query, fase, meta = META_APROVADOS_JOGAVEIS) {
  try {
    const res = await query(SQL_FASES_SEM_IA);
    const row = res?.rows?.[0];
    if (!row) return { ok: false, fase, bloqueios: ["consulta sem linha"], avisos: [], manuais: [] };
    return { ...avaliarFaseSemIa(fase, row, meta), dados: row };
  } catch (e) {
    return { ok: false, fase, bloqueios: [`falha ao ler o banco (${e?.code ?? "erro"})`], avisos: [], manuais: [] };
  }
}
