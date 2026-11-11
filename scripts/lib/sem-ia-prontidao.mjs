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
