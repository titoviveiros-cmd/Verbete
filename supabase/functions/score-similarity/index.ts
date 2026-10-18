// Edge function: avalia se cada definição "falsa" do jogador é semanticamente
// equivalente (>= 80%) à definição verdadeira. Usa Gemini Flash (Google AI).
// Recebe { room_id, round, candidates: [{id, text}] } e devolve { matches: [id, ...] }.
// IMPORTANTE: palavra e verdade são buscadas AQUI (service role); o cliente nunca
// envia a resposta, evitando que ela seja interceptada / usada para cheating.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { callChat, exceptionEvent, parseJsonObject, type OpsEvent } from "../_shared/ai.ts";
import { isUuid, readJsonObject } from "../_shared/input.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Telemetria nunca derruba o pedido.
async function logEvent(admin: SupabaseClient, ev: OpsEvent) {
  try {
    const { error } = await admin.from("ops_events").insert({ kind: ev.kind, payload: ev.payload });
    if (error) console.warn("ops_events insert failed", error.code, error.message);
  } catch (e) {
    console.warn("ops_events insert failed", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Sem gate de autenticação: a palavra e a definição verdadeira são buscadas
  // server-side (service role); o cliente não envia nada explorável. Jogadores
  // anônimos (convidados) precisam poder ganhar o bônus de equivalência ≥80%.
  const t0 = Date.now();
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const body = await readJsonObject(req);
    const roomId = isUuid(body?.room_id) ? body.room_id : "";
    const round = Number(body?.round);
    const candidatesRaw = body?.candidates;
    if (!roomId || !Number.isInteger(round) || !Array.isArray(candidatesRaw) || candidatesRaw.length === 0) {
      return json({ matches: [] });
    }
    const MAX_CANDIDATES = 20;
    // Auditoria 2026-07-29: o texto do chamador é IGNORADO — aceitamos só os
    // ids e buscamos o texto real no banco (service role). Antes, um jogador
    // podia enviar o próprio id com o texto da verdade copiado após a
    // revelação e ganhar +3 forjado.
    const candidateIds = candidatesRaw
      .slice(0, MAX_CANDIDATES)
      .map((c: { id: unknown } | string) =>
        String(typeof c === "object" && c !== null ? (c as { id: unknown }).id : c).slice(0, 64),
      )
      .filter(isUuid);

    // Só julga rodada JÁ PONTUADA (linha em rounds, inserida por
    // advance_voting_to_reveal antes de chamar esta função). Durante a
    // votação a função respondia na hora quando o id era o da verdade
    // (filtrada antes da IA) e devagar para os falsos — um oráculo de tempo
    // que entregava a resposta (SEC-05). A palavra vem da rodada julgada:
    // usar a palavra "atual" da sala quebrava quando ela já tinha avançado.
    const { data: roundRow, error: roundError } = await admin
      .from("rounds")
      .select("word_id")
      .eq("room_id", roomId)
      .eq("round", round)
      .maybeSingle();
    // Falha do banco não pode se passar por "rodada não pontuada" (bônus
    // perdido em silêncio): vira exceção, evento judge_ai_error e log.
    if (roundError) throw new Error(`rounds lookup failed: ${roundError.code ?? ""} ${roundError.message}`);
    const wid: string | null = (roundRow as { word_id?: string } | null)?.word_id ?? null;
    if (!wid) return json({ matches: [], error: "round_not_scored" });

    let word = "";
    const { data: w1 } = await admin.from("words").select("word").eq("id", wid).maybeSingle();
    if (w1) word = String((w1 as { word?: string }).word ?? "");
    else {
      const { data: w2 } = await admin.from("room_words").select("word").eq("id", wid).maybeSingle();
      if (w2) word = String((w2 as { word?: string }).word ?? "");
    }

    const { data: truthDef } = await admin
      .from("definitions")
      .select("text")
      .eq("room_id", roomId)
      .eq("round", round)
      .eq("is_truth", true)
      .maybeSingle();
    const truth = String((truthDef as { text?: string } | null)?.text ?? "").slice(0, 400);
    if (!word || !truth) return json({ matches: [] });

    // Textos REAIS das candidatas, restritos à sala/rodada e nunca a verdade.
    const { data: candRows } = await admin
      .from("definitions")
      .select("id,text")
      .in("id", candidateIds)
      .eq("room_id", roomId)
      .eq("round", round)
      .eq("is_truth", false)
      .neq("player_id", "__truth__");
    const candidates = (candRows ?? []).map(
      (r: { id: string; text: string }) => ({
        id: String(r.id),
        text: String(r.text ?? "").slice(0, 300),
      }),
    );
    if (candidates.length === 0) return json({ matches: [] });

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");

    const list = candidates
      .map((c: { id: string; text: string }, i: number) => `${i + 1}. [id=${c.id}] "${c.text}"`)
      .join("\n");

    const system = `Você avalia proximidade semântica entre definições do jogo "Verbete". Seja MUITO GENEROSO: aceite a candidata quando ela aponta para a MESMA ideia geral da verdadeira, ainda que com palavras diferentes, sinônimos, hiperônimos próximos, paráfrase mais ampla ou mais estreita, ou versão resumida. Uma única palavra sinônima CONTA como equivalente. Ignore estilo, ordem, formalidade e completude. Só rejeite quando o sentido for claramente diferente ou se referir a outro conceito.

Exemplos calibrados:
- verdadeira "falta completa de dinheiro" vs candidata "pobreza" -> APROVA (sinônimo direto)
- verdadeira "dito espirituoso, gracejo" vs candidata "comentario engracado" -> APROVA (mesma ideia)
- verdadeira "desse modo, assim sendo" vs candidata "por conseguinte" -> APROVA (conectivos sinônimos — apontam para a mesma função)
- verdadeira "conversa fiada, papo furado" vs candidata "conversa informal, inutil" -> APROVA (mesma ideia com adjetivos diferentes)
- verdadeira "grande confusao" vs candidata "tipo de dança do interior" -> REJEITA (conceito diferente)

Devolva APENAS JSON {"matches": ["<id>", ...]} com os ids aprovados, sem markdown.`;
    const user = `Palavra: ${word}\nDefinição verdadeira: ${truth}\n\nCandidatas:\n${list}\n\nRetorne os ids semanticamente próximos (seja generoso com sinônimos e paráfrases).`;

    // flash-lite: pool de quota gratuita separado e maior — o flash comum
    // estourou o free tier no playtest e TODAS as rodadas perderam o bônus
    // silenciosamente (429 -> matches vazio). Agora: timeout de 8s por
    // tentativa, 1 nova tentativa em falha transitória e evento de erro
    // (alerta no /admin/ops e no webhook) quando o julgamento não acontece.
    const chat = await callChat({
      fetchFn: fetch,
      apiKey,
      url: Deno.env.get("GEMINI_CHAT_URL"),
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    if (!chat.ok) {
      console.error("AI gateway error", chat.reason, chat.status ?? "");
      await logEvent(admin, {
        kind: "judge_ai_error",
        payload: {
          fn: "score-similarity",
          reason: chat.reason,
          ...(chat.status ? { status: chat.status } : {}),
          candidates: candidates.length,
          attempts: chat.attempts,
          latency_ms: Date.now() - t0,
        },
      });
      return json({ matches: [], error: chat.status ? `ai_${chat.status}` : `ai_${chat.reason}` });
    }

    const parsed = parseJsonObject(chat.content);
    const rawMatches = parsed?.matches;
    if (!Array.isArray(rawMatches)) {
      await logEvent(admin, {
        kind: "judge_ai_error",
        payload: {
          fn: "score-similarity",
          reason: "invalid_response",
          candidates: candidates.length,
          attempts: chat.attempts,
          latency_ms: Date.now() - t0,
        },
      });
      return json({ matches: [], error: "ai_invalid_response" });
    }
    const validIds = new Set(candidates.map((c: { id: string }) => c.id));
    const matches = rawMatches.map(String).filter((id) => validIds.has(id));

    // Aplica o bônus (near_truth=true + score+3) direto no banco via RPC
    // SECURITY DEFINER, service-role only. Idempotente e presa à sala/rodada
    // (auditoria 2026-07-29): replay não soma de novo.
    if (matches.length > 0) {
      const { error: bonusError } = await admin.rpc("apply_similarity_bonus", {
        p_room_id: roomId,
        p_round: round,
        p_definition_ids: matches,
      });
      if (bonusError) console.error("apply_similarity_bonus failed", bonusError);
    }

    await logEvent(admin, {
      kind: "judge_ai_success",
      payload: {
        fn: "score-similarity",
        candidates: candidates.length,
        matched: matches.length,
        attempts: chat.attempts,
        latency_ms: Date.now() - t0,
      },
    });
    return json({ matches });
  } catch (e) {
    console.error("score-similarity error", e);
    await logEvent(admin, exceptionEvent("judge_ai_error", "score-similarity", e, Date.now() - t0));
    return json({ matches: [], error: "internal_error" });
  }
});
