// Edge function v2 dos bots (playtest 2026-10-20). Mesmo contrato da v1
// ({ word_id, count, personas, room_id, round } → { definitions }) e mais:
//  1. MEMÓRIA DA PARTIDA: nenhuma definição igual/parecida com o que um bot
//     já disse em rodada anterior DESTA partida. A partida = as definições da
//     sala — start_game e reset_room apagam todas, então partida nova começa
//     sem memória, sem estrutura nova no banco.
//  2. GATE SEMÂNTICO: as candidatas passam pelo MESMO juiz do bônus 🧠
//     (_shared/semantic.ts, limiar humano 80 intocado) e só fica quem tira
//     menos de BOT_GATE_MAX_SCORE. Juiz fora do ar ou lento = nenhuma
//     candidata da IA sem verificação; o client usa as reservas.
//  3. RESERVAS VETADAS: o SERVIDOR sorteia 12 reservas (reserves.ts) e elas
//     passam pelos mesmos filtros e pelo mesmo juiz, na mesma chamada. Texto
//     vindo do client nunca vai ao juiz (não há oráculo da verdade).
//  4. ORÇAMENTO: geração 6 s sem nova tentativa + juiz até 3,5 s; o client
//     ainda corta em 6 s depois que a mesa escreveu (BOT_AI_GRACE_MS).
//  5. FORMA (2026-10-24): texto quebrado do modelo ("tecido tecido…", "min
//     mineral…") sai ANTES de tudo — não vai ao juiz nem à memória da rodada.
//     Faltando candidata, no máximo UMA regeneração curta antes do juiz
//     (logic.ts/gatherCandidates); se ainda faltar, saem menos definições e o
//     client cai nas reservas vetadas → templates locais → bot não envia.
// A v1 (bot-definitions) segue em produção; ganhou só o filtro de forma.
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { callChat, exceptionEvent, type OpsEvent } from "../_shared/ai.ts";
import { isUuid, readJsonObject } from "../_shared/input.ts";
import { judgeCandidates } from "../_shared/semantic.ts";
import {
  BOT_GATE_MAX_SCORE,
  dropAlreadyServed,
  dropMalformed,
  dropMatchRepeats,
  dropNearTruth,
  gatherCandidates,
  gateByScores,
  outcomeEvent,
  regenEventFields,
  servedRows,
} from "../bot-definitions/logic.ts";
import { buildMessages, choosePersonas } from "./prompts.ts";
import { pickReserves } from "./reserves.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
/** Geração: uma tentativa só, para não somar 8 s + 8 s como a v1. */
const GEN_TIMEOUT_MS = 6000;
/** Juiz: orçamento máximo; nunca passa do teto total do pedido. */
const GATE_TIMEOUT_MS = 3500;
/** Teto do pedido inteiro (o client corta antes, se a mesa já escreveu). */
const TOTAL_BUDGET_MS = 9500;
/** Pede algumas candidatas a mais: filtros e juiz podem descartar. */
const EXTRA_CANDIDATES = 3;

async function logEvent(admin: SupabaseClient, ev: OpsEvent) {
  try {
    const { error } = await admin
      .from("ops_events")
      .insert({ kind: ev.kind, payload: ev.payload });
    if (error)
      console.warn("ops_events insert failed", error.code, error.message);
  } catch (e) {
    console.warn("ops_events insert failed", e);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });

  // Mesmo gate da v1: só gera para a palavra CORRENTE de uma sala em
  // escrita/embaralhamento (convidados são o público principal, sem login).
  const t0 = Date.now();
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  try {
    const body = await readJsonObject(req);
    const wordId = isUuid(body?.word_id) ? body.word_id : "";
    if (!wordId) return json({ error: "word_id required" }, 400);
    const count = Math.min(Math.max(1, Number(body?.count) || 3), 10);
    const askRoomId = isUuid(body?.room_id) ? body.room_id : "";
    // Reservas SEMPRE do servidor: textos do client nunca passam pelo juiz
    // (senão a edge viraria um oráculo da verdade durante a escrita).
    const fallbacksIn = pickReserves(12);

    let roomQuery = admin
      .from("rooms")
      .select("id, current_round")
      .eq("current_word_id", wordId)
      .in("status", ["writing", "shuffling"]);
    if (askRoomId) roomQuery = roomQuery.eq("id", askRoomId);
    const { data: activeRoom, error: roomError } = await roomQuery
      .limit(1)
      .maybeSingle();
    if (roomError)
      throw new Error(
        `rooms lookup failed: ${roomError.code ?? ""} ${roomError.message}`,
      );
    if (!activeRoom)
      return json(
        { error: "no_active_round_for_word", definitions: [], fallbacks: [] },
        403,
      );
    const roomId = String((activeRoom as { id: string }).id);
    const round = Number(
      (activeRoom as { current_round: number }).current_round,
    );

    let word = "";
    let meaning = "";
    let category = "";
    const { data: w1 } = await admin
      .from("words")
      .select("word, meaning, category")
      .eq("id", wordId)
      .maybeSingle();
    const w =
      w1 ??
      (
        await admin
          .from("room_words")
          .select("word, meaning, category")
          .eq("id", wordId)
          .maybeSingle()
      ).data;
    if (w) {
      word = String((w as { word?: unknown }).word ?? "").slice(0, 200);
      meaning = String((w as { meaning?: unknown }).meaning ?? "").slice(
        0,
        400,
      );
      category = String((w as { category?: unknown }).category ?? "")
        .slice(0, 40)
        .toLowerCase();
    }
    if (!word)
      return json(
        { error: "word not found", definitions: [], fallbacks: [] },
        404,
      );

    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");
    const url = Deno.env.get("GEMINI_CHAT_URL") ?? undefined;

    // Memória da PARTIDA (rodadas anteriores, só bots) e da RODADA (servidos).
    const [{ data: botRows }, { data: served }] = await Promise.all([
      admin
        .from("players")
        .select("id")
        .eq("room_id", roomId)
        .eq("is_bot", true),
      admin
        .from("ai_served_defs")
        .select("norm_text")
        .eq("room_id", roomId)
        .eq("round", round),
    ]);
    const botIds = (botRows ?? []).map((r: { id: string }) => r.id);
    let previous: string[] = [];
    if (botIds.length > 0 && round > 1) {
      const { data: prevDefs } = await admin
        .from("definitions")
        .select("text")
        .eq("room_id", roomId)
        .lt("round", round)
        .in("player_id", botIds)
        .limit(80);
      previous = (prevDefs ?? []).map((r: { text: string }) =>
        String(r.text ?? ""),
      );
    }
    const servedNorms: string[] = (served ?? []).map(
      (r: { norm_text: string }) => r.norm_text,
    );

    // 1) Geração (uma tentativa, com o que a partida já usou no prompt) e
    // 2) filtros baratos — FORMA primeiro (texto cru do modelo), depois
    // vazamento lexical, servidos na rodada, partida e entre si. Faltando
    // candidata: no máximo UMA regeneração curta, ainda antes do juiz.
    const personas = choosePersonas(
      Math.min(10, count + EXTRA_CANDIDATES),
      body?.personas,
    );
    const gen = await gatherCandidates({
      count,
      word,
      meaning,
      previous,
      servedNorms,
      personas,
      // continua o rodízio de estilos depois dos da 1ª chamada
      morePersonas: (n) =>
        choosePersonas(personas.length + n, body?.personas).slice(
          personas.length,
        ),
      genTimeoutMs: GEN_TIMEOUT_MS,
      totalBudgetMs: TOTAL_BUDGET_MS,
      t0,
      now: Date.now,
      generate: (r) =>
        callChat({
          fetchFn: fetch,
          apiKey,
          url,
          timeoutMs: r.timeoutMs,
          retries: r.retries,
          messages: buildMessages({
            word,
            meaning,
            category,
            personas: r.personas,
            avoid: r.avoid,
          }),
        }),
    });
    if (!gen.chat.ok)
      console.error("AI gateway error", gen.chat.reason, gen.chat.status ?? "");
    // Reservas: mesma forma (a palavra da rodada pode estar numa delas —
    // rejeitar em vez de mascarar) e os mesmos filtros.
    const fbShape = dropMalformed(fallbacksIn, word);
    const fbLeak = dropNearTruth(fbShape.kept, meaning);
    const fbMatch = dropMatchRepeats(fbLeak.kept, previous);
    const fbFresh = dropAlreadyServed(fbMatch.kept, servedNorms);

    // 3) Gate semântico com o juiz oficial — candidatas e reservas juntas.
    const items = [
      ...gen.candidates.map((text, i) => ({ id: `c${i}`, text })),
      ...fbFresh.kept.map((text, i) => ({ id: `r${i}`, text })),
    ];
    let gate: "ok" | "failed" | "skipped" = "skipped";
    let gateMs = 0;
    let passed: string[] = [];
    let fallbacks: string[] = fbFresh.kept;
    let droppedGate = 0;
    const left = TOTAL_BUDGET_MS - (Date.now() - t0);
    if (items.length > 0 && left > 800) {
      const g0 = Date.now();
      const judged = await judgeCandidates({
        fetchFn: fetch,
        apiKey,
        url,
        word,
        truth: meaning,
        candidates: items,
        timeoutMs: Math.min(GATE_TIMEOUT_MS, left),
        retries: 0,
      });
      gateMs = Date.now() - g0;
      if (judged.ok) {
        gate = "ok";
        const pass = gateByScores(items, judged.scores, BOT_GATE_MAX_SCORE);
        droppedGate = pass.dropped;
        passed = pass.kept
          .filter((it) => it.id.startsWith("c"))
          .map((it) => it.text);
        fallbacks = pass.kept
          .filter((it) => it.id.startsWith("r"))
          .map((it) => it.text);
      } else {
        // Juiz indisponível/lento: nenhuma candidata da IA sem verificação.
        // As reservas (templates genéricos, já sem vazamento lexical e sem
        // repetição) seguem como "reserva segura".
        gate = "failed";
        console.warn("bot gate unavailable", judged.reason);
      }
    } else if (items.length > 0) {
      gate = "failed"; // sem tempo para o juiz: mesma regra
    }

    // 4) Memória da rodada RELIDA no fim (Red Team 2026-10-22): a sugestão
    // antecipada do jogador, os chips e os bots geram AO MESMO TEMPO — a
    // leitura do início não via o texto das outras chamadas e saíam frases
    // quase iguais (cédula "denunciada", too_similar no envio). Relida aqui,
    // a janela de corrida cai para milissegundos, nos dois sentidos.
    let droppedLate = 0;
    let definitions: string[] = [];
    if (passed.length > 0) {
      const { data: servedNow } = await admin
        .from("ai_served_defs")
        .select("norm_text")
        .eq("room_id", roomId)
        .eq("round", round);
      const nowNorms: string[] = (servedNow ?? []).map(
        (r: { norm_text: string }) => r.norm_text,
      );
      const late = dropAlreadyServed(passed, nowNorms);
      droppedLate = late.dropped;
      definitions = late.kept.slice(0, count);
      fallbacks = dropAlreadyServed(fallbacks, nowNorms).kept;
    }

    if (definitions.length > 0) {
      await admin
        .from("ai_served_defs")
        .upsert(servedRows(definitions, roomId, round), {
          onConflict: "room_id,round,norm_text",
          ignoreDuplicates: true,
        });
    }

    // Só contagens e motivos (dropped_shape + shape_<regra>, regen_*): nunca
    // palavra, verdade ou texto gerado.
    const ev = outcomeEvent({
      chat: gen.chat,
      parsedCount: gen.parsedCount,
      requested: count,
      returned: definitions.length,
      droppedLeak: gen.dropped.leak,
      droppedServed: gen.dropped.served,
      droppedShape: gen.dropped.shape,
      latencyMs: Date.now() - t0,
    });
    await logEvent(admin, {
      kind: ev.kind,
      payload: {
        ...ev.payload,
        fn: "bot-definitions-v2",
        dropped_match: gen.dropped.match,
        dropped_self: gen.dropped.self,
        dropped_gate: droppedGate,
        dropped_late: droppedLate,
        gate,
        gate_ms: gateMs,
        fallbacks_ok: fallbacks.length,
        ...regenEventFields(gen.regen),
      },
    });

    return json({
      definitions,
      fallbacks,
      personas: personas.slice(0, count),
      gate,
    });
  } catch (e) {
    console.error("bot-definitions-v2 error", e);
    await logEvent(
      admin,
      exceptionEvent("bot_ai_error", "bot-definitions-v2", e, Date.now() - t0),
    );
    return json({ error: "internal_error", definitions: [], fallbacks: [] });
  }
});
