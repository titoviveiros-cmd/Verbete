// Edge function: avalia se cada definição "falsa" do jogador é semanticamente
// equivalente (>= 80%) à definição verdadeira. Usa Gemini Flash via Lovable AI.
// Recebe { room_id, round, candidates: [{id, text}] } e devolve { matches: [id, ...] }.
// IMPORTANTE: palavra e verdade são buscadas AQUI (service role); o cliente nunca
// envia a resposta, evitando que ela seja interceptada / usada para cheating.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Sem gate de autenticação: a palavra e a definição verdadeira são buscadas
  // server-side (service role); o cliente não envia nada explorável. Jogadores
  // anônimos (convidados) precisam poder ganhar o bônus de equivalência ≥80%.


  try {
    const body = await req.json();
    const roomId = typeof body?.room_id === "string" ? body.room_id : "";
    const round = Number(body?.round);
    const candidatesRaw = body?.candidates;
    if (!roomId || !Number.isFinite(round) || !Array.isArray(candidatesRaw) || candidatesRaw.length === 0) {
      return new Response(JSON.stringify({ matches: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const MAX_CANDIDATES = 20;
    const MAX_TEXT_LEN = 300;
    const candidates = candidatesRaw
      .slice(0, MAX_CANDIDATES)
      .map((c: { id: unknown; text: unknown }) => ({
        id: String(c?.id ?? "").slice(0, 64),
        text: String(c?.text ?? "").slice(0, MAX_TEXT_LEN),
      }));

    // Busca a palavra atual da sala e a definição verdadeira (server-side, service role)
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: room } = await admin
      .from("rooms")
      .select("current_word_id, status")
      .eq("id", roomId)
      .maybeSingle();
    if (!room || !(room as any).current_word_id) {
      return new Response(JSON.stringify({ matches: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const wid = (room as any).current_word_id;
    let word = "";
    const { data: w1 } = await admin.from("words").select("word").eq("id", wid).maybeSingle();
    if (w1) word = String((w1 as any).word ?? "");
    else {
      const { data: w2 } = await admin.from("room_words").select("word").eq("id", wid).maybeSingle();
      if (w2) word = String((w2 as any).word ?? "");
    }

    const { data: truthDef } = await admin
      .from("definitions")
      .select("text")
      .eq("room_id", roomId)
      .eq("round", round)
      .eq("is_truth", true)
      .maybeSingle();
    const truth = String((truthDef as any)?.text ?? "").slice(0, 400);
    if (!word || !truth) {
      return new Response(JSON.stringify({ matches: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) throw new Error("LOVABLE_API_KEY missing");

    const list = candidates
      .map((c: { id: string; text: string }, i: number) => `${i + 1}. [id=${c.id}] "${c.text}"`)
      .join("\n");

    const system = `Você avalia proximidade semântica entre definições do jogo "Verbete". Seja GENEROSO: aceite a candidata quando ela aponta para a MESMA ideia geral da verdadeira, ainda que com palavras diferentes, sinônimos coloquiais, conotação aproximada, paráfrase mais ampla ou mais estreita, ou foco parcial em um dos sentidos. Considere equivalentes definições que um falante comum interpretaria como "praticamente a mesma coisa" no contexto da palavra. Ignore estilo, ordem, formalidade e completude. Só rejeite quando o sentido for claramente diferente, não relacionado, ou se referir a outro conceito. Devolva APENAS JSON {"matches": ["<id>", ...]} com os ids aprovados, sem markdown.`;
    const user = `Palavra: ${word}\nDefinição verdadeira: ${truth}\n\nCandidatas:\n${list}\n\nRetorne os ids semanticamente próximos (seja generoso com sinônimos e paráfrases).`;

    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      console.error("AI gateway error", r.status, t);
      return new Response(JSON.stringify({ matches: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await r.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    let matches: string[] = [];
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : content);
      matches = Array.isArray(parsed.matches) ? parsed.matches.map(String) : [];
    } catch (e) {
      console.error("parse failed", e, content);
    }

    return new Response(JSON.stringify({ matches }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("score-similarity error", e);
    return new Response(JSON.stringify({ matches: [], error: String(e) }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});


