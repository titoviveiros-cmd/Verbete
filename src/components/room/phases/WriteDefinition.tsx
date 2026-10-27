import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  botSubmitDefinitions,
  BOT_AI_GRACE_MS,
  generateAiDefinitionForPlayer,
  startShuffling,
  submitDefinition,
  applyWritingTimeoutOrAdvance,
  DuplicateDefinitionError,
  type Definition,
  type Player,
  type Room,
  type Word,
} from "@/lib/room";
import { supabase } from "@/integrations/supabase/client";
import { Mascot } from "@/components/Mascot";
import { playSubmit, playUITap } from "@/lib/sound";
import { writingTimerMax } from "@/lib/game-times";
import { shuffleAdvanceDelayMs } from "@/lib/transition-floor";
import { PHASE_ANNOUNCER_TOTAL_MS } from "@/components/room/PhaseAnnouncer";
import {
  WordCard,
  ProgressBar,
  PendingList,
  pendingSentence,
  TimerBar,
} from "@/components/room/shared";
import type { RoundExtension } from "@/hooks/use-room";
import { scrollbarClip } from "@/lib/utils";
import { TermsConsent } from "@/components/TermsConsent";
import { useTermsGate } from "@/hooks/use-terms-gate";
import { TermsRequiredError } from "@/lib/terms-consent";
import {
  AUTO_DEF_WAIT_MS,
  autoDefKey,
  prefetchAutoDefinition,
  takeAutoDefinition,
} from "@/lib/auto-definition";

export function WriteDefinition({
  room,
  players,
  word,
  me,
  isCoordinator,
  definitions,
  roundExtensions,
  isHost,
  isDeputy,
}: {
  room: Room;
  players: Player[];
  word: Word;
  me: Player;
  isCoordinator: boolean;
  definitions: Definition[];
  roundExtensions: RoundExtension[];
  isHost: boolean;
  isDeputy: boolean;
}) {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  // Frases prontas (2 sugestões por rodada — playtest mobile: com 3, a dica
  // de "letras minúsculas" saía da tela). Latência (playtest 5G): o pool
  // local aparece INSTANTANEAMENTE; a IA responde em background e troca as
  // sugestões quando chegar — a tela nunca fica vazia esperando.
  const [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => {
    if (isCoordinator) return;
    let alive = true;
    (async () => {
      // Só texto bem formado vira 💡 (forma, palavra da rodada, sem máscara):
      // a sugestão quebrada da IA é pulada e a local fica no lugar.
      const { wellFormedDefinition } = await import("@/lib/text-filter");
      const { BOT_FAKE_DEFINITIONS_TEMPLATES } =
        await import("@/lib/bot-names");
      // 1) Pool local imediato
      const local: string[] = [];
      const pool = [...BOT_FAKE_DEFINITIONS_TEMPLATES].sort(
        () => Math.random() - 0.5,
      );
      for (const fb of pool) {
        if (local.length >= 2) break;
        const s = wellFormedDefinition(fb, word.word);
        if (s && !local.includes(s)) local.push(s);
      }
      if (alive) setSuggestions(local);
      // 2) IA em background — quando responder, assume o lugar
      try {
        const { supabase } = await import("@/integrations/supabase/client");
        const { data } = await supabase.functions.invoke("bot-definitions", {
          body: {
            word_id: word.id,
            count: 2,
            personas: ["conciso", "contextual"],
            // memória por rodada: o servidor não repete textos já servidos
            room_id: room.id,
            round: room.current_round,
          },
        });
        const arr =
          (data as { definitions?: unknown[] } | null)?.definitions ?? [];
        const { textSimilarity } = await import("@/lib/text-filter");
        const ai: string[] = [];
        for (const raw of arr) {
          if (typeof raw !== "string" || raw.length <= 5) continue;
          const s = wellFormedDefinition(raw, word.word);
          if (!s) continue;
          // Sugestões precisam ser DIFERENTES entre si (playtest: a IA
          // convergia em frases quase iguais para personas distintas).
          if (ai.some((t) => t === s || textSimilarity(t, s) > 0.6)) continue;
          ai.push(s);
          if (ai.length >= 2) break;
        }
        if (alive && ai.length > 0) {
          setSuggestions((cur) => {
            const merged = [...ai];
            for (const s of cur) {
              if (merged.length >= 2) break;
              if (!merged.includes(s)) merged.push(s);
            }
            return merged;
          });
        }
      } catch {
        /* fica com as locais */
      }
    })();
    return () => {
      alive = false;
    };
  }, [room.id, room.current_round, isCoordinator, word.id]);
  const myDef = useMemo(
    () => definitions.find((d) => d.player_id === me?.id),
    [definitions, me?.id],
  );
  // 🤖 sugestão automática ANTECIPADA (2026-10-22): começa a gerar ao
  // entrar na escrita (enquanto o jogador lê a palavra), só neste aparelho.
  const autoKey = me?.id
    ? autoDefKey(room.id, room.current_round, me.id, word.id)
    : null;
  const autoKeyRef = useRef(autoKey);
  autoKeyRef.current = autoKey;
  // Quem está na sala sem o aceite deste aparelho (entrou antes do aceite
  // existir, revanche, outro aparelho) aceita aqui antes de enviar.
  const terms = useTermsGate();
  const textRef = useRef(text);
  textRef.current = text;
  const sentRef = useRef(false);
  sentRef.current = submitted || !!myDef;
  const generateAuto = useMemo(
    () => () =>
      generateAiDefinitionForPlayer(word, room.id, room.current_round),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [word.id, room.id, room.current_round],
  );
  useEffect(() => {
    // já ao entrar na escrita (medido 22/10: começar 0,5–1,2 s depois fazia
    // o toque logo após a cortina esperar a IA, sem ganho medido para os
    // bots — a corrida com eles quem resolve é a memória relida no fim da
    // v2); quem já enviou (ex.: recarregou a página) não gasta IA
    if (!autoKey || isCoordinator || sentRef.current) return;
    prefetchAutoDefinition(autoKey, generateAuto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoKey, isCoordinator]);
  const writers = useMemo(
    () =>
      players.filter((p) => p.id !== room.current_coordinator && !p.kicked_at),
    [players, room.current_coordinator],
  );
  const submittedIds = useMemo(
    () => new Set(definitions.map((d) => d.player_id)),
    [definitions],
  );
  const submittedCount = useMemo(
    () => writers.reduce((n, w) => n + (submittedIds.has(w.id) ? 1 : 0), 0),
    [writers, submittedIds],
  );
  const pending = useMemo(
    () => writers.filter((p) => !submittedIds.has(p.id)),
    [writers, submittedIds],
  );
  const allSubmitted = submittedCount >= writers.length;

  // Prazo da IA dos bots: com todos os humanos já escritos, a IA tem no
  // máximo BOT_AI_GRACE_MS a mais; depois os bots seguem com o reserva
  // local. Medido em 2026-10-20: a IA levou até ~19 s (timeout + nova
  // tentativa) e a mesa ficava parada esperando os bots.
  const hurry = useRef<{ promise: Promise<void>; resolve: () => void }>(null);
  if (!hurry.current) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    hurry.current = { promise, resolve };
  }
  const humansWriting = pending.some((p) => !p.is_bot);
  useEffect(() => {
    if (humansWriting) return;
    const t = setTimeout(() => hurry.current?.resolve(), BOT_AI_GRACE_MS);
    return () => clearTimeout(t);
  }, [humansWriting]);

  const botsTriggeredRef = useRef(false);
  useEffect(() => {
    if (!isHost) return;
    if (botsTriggeredRef.current) return;
    const bots = writers.filter((p) => p.is_bot);
    if (bots.length) {
      botsTriggeredRef.current = true;
      botSubmitDefinitions(room.id, room.current_round, bots, word, {
        hurry: hurry.current?.promise,
      });
    }
  }, [isHost, room.id, room.current_round, writers]);

  // Instante em que ESTE aparelho viu a escrita desta rodada começar.
  const writingSeenRef = useRef<{ round: number; at: number } | null>(null);
  if (writingSeenRef.current?.round !== room.current_round)
    writingSeenRef.current = { round: room.current_round, at: Date.now() };
  useEffect(() => {
    if (allSubmitted) {
      // Qualquer cliente pode disparar — startShuffling tem guarda atômica
      // (`eq status writing`). Host dispara mais rápido para evitar latência,
      // mas se ele cair, os demais cobrem em ~1.8s. Piso (2026-10-22): a
      // cortina "Hora de Inventar" sai e a escrita fica ~2,5 s à vista antes
      // do embaralhamento (só bots escrevendo encadeava as telas).
      const delay = shuffleAdvanceDelayMs(
        isHost,
        writingSeenRef.current?.at ?? Date.now(),
        Date.now(),
        PHASE_ANNOUNCER_TOTAL_MS,
      );
      const expectedDefs = writers.length;
      const roundAtCheck = room.current_round;
      const t = setTimeout(async () => {
        // Reverifica no banco antes de avançar. O estado local de `players`
        // pode ficar momentaneamente desatualizado (realtime atrasado, jogador
        // sumindo por um tick, etc.) e fazer `allSubmitted` virar `true` mesmo
        // com alguém faltando. Avançar nesse caso pula a penalidade/prorrogação
        // do timeout — o que é o bug que esta verificação previne.
        try {
          // S1: recontagem via RPC phase-aware (SELECT direto foi revogado).
          const { data: sync } = await supabase.rpc(
            "get_round_sync" as never,
            { p_room_id: room.id } as never,
          );
          const serverDefs =
            (sync as { definitions?: { round: number }[] } | null)
              ?.definitions ?? [];
          const count = serverDefs.filter(
            (d) => d.round === roundAtCheck,
          ).length;
          if (count < expectedDefs) return; // alguém ainda falta — deixa o timer/RPC cuidar
        } catch (e) {
          console.warn(
            "allSubmitted recount failed, falling back to advance",
            e,
          );
        }
        startShuffling(room.id);
      }, delay);
      return () => clearTimeout(t);
    }
  }, [allSubmitted, isHost, room.id, room.current_round, writers.length]);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remaining = room.round_phase_ends_at
    ? Math.max(
        0,
        Math.floor((new Date(room.round_phase_ends_at).getTime() - now) / 1000),
      )
    : 0;

  const timeoutHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isHost && !isDeputy) return;
    if (room.paused_at) return; // pausada: o prazo não vale até retomar
    if (remaining === 0 && room.round_phase_ends_at) {
      const key = `${room.id}:${room.current_round}:${room.round_phase_ends_at}`;
      if (timeoutHandledRef.current === key) return;
      // Depois da carência de 2 s do servidor (como na votação): antes, o
      // host chamava aos 0,6 s, levava "noop_grace" e caía no embaralhamento,
      // cujo gatilho prorrogava/expulsava sem olhar a pausa (Red Team).
      const phaseEndsAt = room.round_phase_ends_at;
      const delay = Math.max(
        isHost ? 600 : 6000,
        new Date(phaseEndsAt).getTime() + 2300 - Date.now(),
      );
      const t = setTimeout(async () => {
        if (timeoutHandledRef.current === key) return;
        timeoutHandledRef.current = key;
        try {
          const { action } = await applyWritingTimeoutOrAdvance(room.id);
          // Só segue para o embaralhamento quando o servidor não prorrogou,
          // não pausou e não pediu para esperar a carência.
          if (action === "advanced" || action === "noop")
            await startShuffling(room.id);
          else if (action === "noop_grace") timeoutHandledRef.current = null;
        } catch (e) {
          console.error("writing timeout handler failed", e);
          timeoutHandledRef.current = null;
        }
      }, delay);
      return () => clearTimeout(t);
    }
  }, [
    remaining,
    isHost,
    isDeputy,
    room.id,
    room.current_round,
    room.round_phase_ends_at,
    room.paused_at,
  ]);

  // Fonte de verdade do banner: round_extensions (assinado em tempo real).
  // Não dependemos do contador acumulado players.writing_extensions porque ele
  // pode chegar com atraso no realtime do próprio jogador penalizado.
  const roundExtMap = useMemo(() => {
    const m = new Map<string, number>(); // player_id -> maior attempt nesta rodada (apenas fase writing)
    for (const ext of roundExtensions) {
      if (ext.round !== room.current_round) continue;
      // Penalidades de votação não devem aparecer no banner da escrita.
      if (ext.phase && ext.phase !== "writing") continue;
      const prev = m.get(ext.player_id) ?? 0;
      if (ext.attempt > prev) m.set(ext.player_id, ext.attempt);
    }
    return m;
  }, [roundExtensions, room.current_round]);
  const extensionAlerts = useMemo(
    () =>
      pending
        .map((p) => ({ player: p, attempt: roundExtMap.get(p.id) ?? 0 }))
        .filter((x) => x.attempt > 0),
    [pending, roundExtMap],
  );
  const activeExtension = useMemo(
    () => Math.max(0, ...Array.from(roundExtMap.values())),
    [roundExtMap],
  );
  // Escrita não escala com a sala (2026-10-25): base + 10 s; prorrogação fixa.
  const timerMax = writingTimerMax(activeExtension);

  const handleSubmit = async ({ keyboard = false } = {}) => {
    if (!text.trim()) return;
    if (!me || !word) return;
    // Enter: o aviso aparece sem tirar o foco do campo (um espaço digitado
    // em seguida marcaria a caixa sem querer); no botão, o foco vai à caixa.
    if (!terms.confirm({ focus: !keyboard })) return;
    void playSubmit();
    setSubmitted(true);
    try {
      await submitDefinition(
        room.id,
        room.current_round,
        me.id,
        text,
        word.word,
      );
    } catch (e) {
      console.error("submitDefinition failed", e);
      setSubmitted(false);
      // TermsRequiredError: a identidade da sessão não aceitou (trocou de
      // conta entre a tela e o envio, ou ainda carregava no clique)
      if (
        e instanceof DuplicateDefinitionError ||
        e instanceof TermsRequiredError
      ) {
        toast.error(e.message);
      } else {
        toast.error("Não foi possível enviar sua definição. Tente novamente.");
      }
    }
  };

  const handleAiGenerate = async () => {
    if (!word || !autoKey || aiLoading || submitted || myDef) return;
    setAiLoading(true);
    try {
      // Reserva local: a sugestão antecipada não chegou nem na espera curta
      const localFallback = async (): Promise<string> => {
        const { BOT_FAKE_DEFINITIONS_TEMPLATES } =
          await import("@/lib/bot-names");
        const { wellFormedDefinition } = await import("@/lib/text-filter");
        const pool = [...BOT_FAKE_DEFINITIONS_TEMPLATES]
          .sort(() => Math.random() - 0.5)
          .map((p) => wellFormedDefinition(p, word.word))
          .filter((s): s is string => !!s);
        const pick = pool.find((s) => s !== text && !suggestions.includes(s));
        return pick ?? pool[0] ?? "";
      };
      const key = autoKey;
      const before = text;
      const got = await takeAutoDefinition(key, {
        generate: generateAuto,
        fallback: localFallback,
        exclude: [text, ...suggestions],
        waitMs: AUTO_DEF_WAIT_MS,
      });
      // trocou de rodada no meio: o texto velho não entra no campo novo
      if (autoKeyRef.current !== key) return;
      // digitou ou tocou num 💡 durante a espera: não apaga o que ele fez
      if (textRef.current !== before) return;
      // nenhuma bem formada: não mexe no campo
      if (!got.text) return;
      setText(got.text.slice(0, 140));
    } catch (e) {
      console.error("generateAiDefinitionForPlayer failed", e);
      toast.error("Não foi possível gerar uma definição. Tente novamente.");
    } finally {
      setAiLoading(false);
    }
  };

  if (isCoordinator) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="flex-1 min-h-0 flex flex-col items-center gap-5 pt-4 overflow-y-auto overflow-x-hidden no-scrollbar pb-3 lg:max-w-[560px] lg:mx-auto lg:w-full"
        style={scrollbarClip()}
      >
        <div className="w-full">
          <WordCard word={word} />
        </div>
        <Mascot mood="excited" size={100} />
        <div className="text-center">
          <p className="font-display text-mint text-2xl">
            Você é o coordenador! 👑
          </p>
          <p className="text-base text-muted-foreground mt-1">
            Os jogadores estão escrevendo suas definições…
          </p>
        </div>
        <ProgressBar current={submittedCount} total={writers.length} />
        <PendingList pending={pending} />
        <TimerBar remaining={remaining} max={timerMax} tickStartAt={10} />
        {extensionAlerts.map(({ player: p, attempt }) => {
          const seconds = attempt >= 2 ? 15 : 20;
          const pointsLost = attempt;
          return (
            <div
              key={p.id}
              className={
                "rounded-xl px-3 py-2 text-center font-display text-xs border " +
                (attempt >= 2
                  ? "bg-destructive/15 border-destructive text-destructive"
                  : "bg-sun/15 border-sun text-sun")
              }
            >
              ⏰ {p.avatar} <b>{p.nickname}</b> perdeu{" "}
              <b>
                {pointsLost} {pointsLost === 1 ? "ponto" : "pontos"}
              </b>
              .{" "}
              {attempt >= 2
                ? `Última prorrogação: ${seconds}s para enviar ou será eliminado(a) da partida.`
                : `Nova oportunidade: +${seconds}s para enviar. Se perder novamente na próxima prorrogação, será eliminado(a) da partida.`}
            </div>
          );
        })}
      </motion.div>
    );
  }

  // "Enviar" é o único botão fixo no rodapé do celular em pé (sempre à vista
  // acima do teclado). "Gerar automática" e o aviso de minúsculas rolam com
  // o formulário — o rodapé de 3 peças (~130px) comia a tela (playtest
  // 2026-10-20, 2ª rodada de ajustes).
  const sendButton = (
    <button
      type="button"
      onPointerDown={(e) => {
        e.preventDefault();
      }}
      onClick={() => {
        void playUITap("primary");
        handleSubmit();
      }}
      disabled={text.trim().length < 1}
      className="btn-pop btn-gold w-full text-lg !py-2.5"
    >
      ✍️ Enviar definição
    </button>
  );
  const extras = (
    <>
      <button
        type="button"
        onPointerDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          void playUITap("secondary");
          handleAiGenerate();
        }}
        disabled={aiLoading}
        className="btn-pop btn-turq self-center text-xs !px-3.5 !py-1.5"
      >
        {aiLoading ? "🤖 gerando…" : "🤖 gerar definição automática"}
      </button>
      <p className="text-center text-[11px] text-muted-foreground font-semibold">
        ✏️ tudo será exibido em <b>letras minúsculas e sem acentos</b>
      </p>
    </>
  );
  const editing = !(submitted || myDef);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="flex-1 min-h-0 flex flex-col"
    >
      <div
        // Rolagem própria (playtest mobile: barra de navegação do Safari cobria
        // o rodapé e não dava para ver todo o conteúdo). Barra clipada fora do shell.
        className="flex-1 min-h-0 flex flex-col gap-4 pt-2 overflow-y-auto overflow-x-hidden no-scrollbar pb-3 lg:grid lg:grid-cols-[0.95fr_1.05fr] lg:gap-6 lg:content-center"
        style={scrollbarClip()}
      >
        <div className="flex flex-col gap-4 min-w-0">
          <WordCard word={word} />
          <TimerBar remaining={remaining} max={timerMax} tickStartAt={10} />
          {extensionAlerts.map(({ player: p, attempt }) => {
            const seconds = attempt >= 2 ? 15 : 20;
            const isSelf = p.id === me?.id;
            const finalChance = attempt >= 2;
            const pointsLost = attempt;
            return (
              <div
                key={p.id}
                className={
                  "rounded-xl px-3 py-2 text-center font-display text-xs border " +
                  (isSelf
                    ? finalChance
                      ? "bg-destructive/15 border-destructive text-destructive"
                      : "bg-pink/15 border-pink text-pink"
                    : "bg-sun/15 border-sun text-sun")
                }
              >
                ⏰{" "}
                {isSelf ? (
                  "Você"
                ) : (
                  <>
                    {p.avatar} <b>{p.nickname}</b>
                  </>
                )}{" "}
                perdeu{" "}
                <b>
                  {pointsLost} {pointsLost === 1 ? "ponto" : "pontos"}
                </b>
                .{" "}
                {finalChance
                  ? `Última prorrogação: ${seconds}s para enviar${isSelf ? " ou você será eliminado(a) da partida" : " ou será eliminado(a) da partida"}.`
                  : `Nova oportunidade: +${seconds}s para enviar. Se ${isSelf ? "você perder" : "perder"} novamente na próxima prorrogação, será eliminado(a) da partida.`}
              </div>
            );
          })}
          {/* Desktop: o Livro dá a dica no espaço livre da coluna */}
          <div className="hidden lg:flex items-center gap-3 panel p-4 mt-1">
            <Mascot mood="thinking" size={84} />
            <p className="text-sm text-muted-foreground leading-snug">
              <span className="font-display text-base text-foreground block">
                Dica de blefe
              </span>
              Definição boa parece verbete de dicionário: curta, específica e
              com cara de verdade.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 min-w-0">
          {submitted || myDef ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center panel px-4 py-6">
              <Mascot mood="thinking" size={110} />
              <p className="font-display text-2xl text-mint">
                Definição enviada! ✓
              </p>
              <p className="text-sm text-muted-foreground">
                Aguardando os outros…
              </p>
              <ProgressBar current={submittedCount} total={writers.length} />
              <PendingList pending={pending} />
            </div>
          ) : (
            <>
              {/* Sem -mx-4: no celular a margem negativa colava "0/140", chips e
              "faltam:" na borda esquerda da tela (playtest 5G). */}
              <div className="-mt-2 lg:mt-0 flex flex-col gap-2.5">
                <label
                  htmlFor="definition"
                  className="eyebrow px-1 sr-only lg:not-sr-only lg:block"
                >
                  Sua definição (a mais convincente vence)
                </label>
                <textarea
                  id="definition"
                  value={text}
                  onChange={(e) => setText(e.target.value.slice(0, 140))}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      if (text.trim().length >= 1)
                        handleSubmit({ keyboard: true });
                    }
                  }}
                  rows={3}
                  placeholder="escreva sua definicao mirabolante..."
                  className="field w-full min-h-[118px] lg:min-h-[150px] px-4 py-4 font-body text-base lg:text-lg leading-relaxed resize-none"
                />

                <div className="flex justify-between text-xs font-bold text-muted-foreground tabular-nums px-1">
                  <span
                    className={
                      text.length > 120
                        ? "text-pink"
                        : text.length > 90
                          ? "text-sun"
                          : ""
                    }
                  >
                    {text.length}/140
                  </span>
                  <span>
                    {submittedCount}/{writers.length} enviaram
                  </span>
                </div>

                {/* Frases prontas: um toque preenche o campo (pedido de playtest —
                dá opção a quem não quer digitar; ainda dá pra editar antes de enviar). */}
                {suggestions.length > 0 && !submitted && (
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => {
                          void playUITap();
                          setText(s.slice(0, 140));
                        }}
                        className="glass-tile text-left text-[13px] leading-snug px-3 py-2 rounded-xl hover:border-pink/60 active:translate-y-px transition"
                      >
                        💡 {s}
                      </button>
                    ))}
                  </div>
                )}
                {pending.length > 0 && (
                  <p className="text-xs text-muted-foreground font-display leading-snug px-1">
                    {pendingSentence(pending)}
                  </p>
                )}
                <TermsConsent gate={terms} />
                {/* desktop e celular deitado: o Enviar segue no formulário */}
                <div className="hidden lg:flex short:flex flex-col">
                  {sendButton}
                </div>
                {extras}
              </div>
            </>
          )}
        </div>
      </div>
      {editing && (
        <div className="shrink-0 pt-1.5 lg:hidden short:hidden">
          {sendButton}
        </div>
      )}
    </motion.div>
  );
}

export default WriteDefinition;
