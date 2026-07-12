import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { toast } from "sonner";
import {
  botSubmitDefinitions, generateAiDefinitionForPlayer, startShuffling, submitDefinition, applyWritingTimeoutOrAdvance,
  DuplicateDefinitionError,
  type Definition, type Player, type Room, type Word,
} from "@/lib/room";
import { supabase } from "@/integrations/supabase/client";
import { Mascot } from "@/components/Mascot";
import { playSubmit, playUITap } from "@/lib/sound";
import { WordCard, ProgressBar, PendingList, TimerBar } from "@/components/room/shared";
import type { RoundExtension } from "@/hooks/use-room";

export function WriteDefinition({ room, players, word, me, isCoordinator, definitions, roundExtensions, isHost, isDeputy }: {
  room: Room; players: Player[]; word: Word; me: Player; isCoordinator: boolean; definitions: Definition[]; roundExtensions: RoundExtension[]; isHost: boolean; isDeputy: boolean;
}) {
  const [text, setText] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const myDef = useMemo(() => definitions.find((d) => d.player_id === me?.id), [definitions, me?.id]);
  const writers = useMemo(
    () => players.filter((p) => p.id !== room.current_coordinator && !p.kicked_at),
    [players, room.current_coordinator],
  );
  const submittedIds = useMemo(() => new Set(definitions.map((d) => d.player_id)), [definitions]);
  const submittedCount = useMemo(
    () => writers.reduce((n, w) => n + (submittedIds.has(w.id) ? 1 : 0), 0),
    [writers, submittedIds],
  );
  const pending = useMemo(() => writers.filter((p) => !submittedIds.has(p.id)), [writers, submittedIds]);
  const allSubmitted = submittedCount >= writers.length;

  const botsTriggeredRef = useRef(false);
  useEffect(() => {
    if (!isHost) return;
    if (botsTriggeredRef.current) return;
    const bots = writers.filter((p) => p.is_bot);
    if (bots.length) {
      botsTriggeredRef.current = true;
      botSubmitDefinitions(room.id, room.current_round, bots, word);
    }
  }, [isHost, room.id, room.current_round, writers]);

  useEffect(() => {
    if (allSubmitted) {
      // Qualquer cliente pode disparar — startShuffling tem guarda atômica
      // (`eq status writing`). Host dispara mais rápido para evitar latência,
      // mas se ele cair, os demais cobrem em ~1.8s.
      const delay = isHost ? 600 : 1800;
      const expectedDefs = writers.length;
      const roundAtCheck = room.current_round;
      const t = setTimeout(async () => {
        // Reverifica no banco antes de avançar. O estado local de `players`
        // pode ficar momentaneamente desatualizado (realtime atrasado, jogador
        // sumindo por um tick, etc.) e fazer `allSubmitted` virar `true` mesmo
        // com alguém faltando. Avançar nesse caso pula a penalidade/prorrogação
        // do timeout — o que é o bug que esta verificação previne.
        try {
          const { count } = await supabase
            .from("definitions")
            .select("id", { count: "exact", head: true })
            .eq("room_id", room.id)
            .eq("round", roundAtCheck)
            .neq("player_id", "__truth__");
          if ((count ?? 0) < expectedDefs) return; // alguém ainda falta — deixa o timer/RPC cuidar
        } catch (e) {
          console.warn("allSubmitted recount failed, falling back to advance", e);
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
  const remaining = room.round_phase_ends_at ? Math.max(0, Math.floor((new Date(room.round_phase_ends_at).getTime() - now) / 1000)) : 0;

  const timeoutHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isHost && !isDeputy) return;
    if (remaining === 0 && room.round_phase_ends_at) {
      const key = `${room.id}:${room.current_round}:${room.round_phase_ends_at}`;
      if (timeoutHandledRef.current === key) return;
      const delay = isHost ? 600 : 6000;
      const t = setTimeout(async () => {
        if (timeoutHandledRef.current === key) return;
        timeoutHandledRef.current = key;
        try {
          const { extended } = await applyWritingTimeoutOrAdvance(room.id);
          if (!extended) await startShuffling(room.id);
        } catch (e) {
          console.error("writing timeout handler failed", e);
          timeoutHandledRef.current = null;
        }
      }, delay);
      return () => clearTimeout(t);
    }
  }, [remaining, isHost, isDeputy, room.id, room.current_round, room.round_phase_ends_at]);

  
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
    () => pending
      .map((p) => ({ player: p, attempt: roundExtMap.get(p.id) ?? 0 }))
      .filter((x) => x.attempt > 0),
    [pending, roundExtMap],
  );
  const activeExtension = useMemo(
    () => Math.max(0, ...Array.from(roundExtMap.values())),
    [roundExtMap],
  );
  const timerMax = activeExtension >= 2 ? 15 : activeExtension === 1 ? 20 : 60;

  const handleSubmit = async () => {
    if (!text.trim()) return;
    if (!me || !word) return;
    void playSubmit();
    setSubmitted(true);
    try {
      await submitDefinition(room.id, room.current_round, me.id, text, false, word.word);
    } catch (e) {
      console.error("submitDefinition failed", e);
      setSubmitted(false);
      if (e instanceof DuplicateDefinitionError) {
        toast.error(e.message);
      } else {
        toast.error("Não foi possível enviar sua definição. Tente novamente.");
      }
    }
  };

  const handleAiGenerate = async () => {
    if (!word || aiLoading || submitted || myDef) return;
    setAiLoading(true);
    try {
      const generated = await generateAiDefinitionForPlayer(word);
      setText(generated.slice(0, 140));
    } catch (e) {
      console.error("generateAiDefinitionForPlayer failed", e);
      toast.error("Não foi possível gerar uma definição. Tente novamente.");
    } finally {
      setAiLoading(false);
    }
  };

  if (isCoordinator) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 flex flex-col items-center gap-5 pt-4">
        <WordCard word={word} />
        <Mascot mood="excited" size={100} />
        <p className="text-center font-display text-mint text-xl">Você é o coordenador!</p>
        <p className="text-center text-base text-muted-foreground">Os jogadores estão escrevendo suas definições…</p>
        <ProgressBar current={submittedCount} total={writers.length} />
        <PendingList pending={pending} />
        <TimerBar remaining={remaining} max={timerMax} tickStartAt={10} />
        {extensionAlerts.map(({ player: p, attempt }) => {
          const seconds = attempt >= 2 ? 15 : 20;
          const pointsLost = attempt;
          return (
            <div key={p.id} className={"rounded-xl px-3 py-2 text-center font-display text-xs border " + (attempt >= 2 ? "bg-destructive/15 border-destructive text-destructive" : "bg-sun/15 border-sun text-sun")}>
              ⏰ {p.avatar} <b>{p.nickname}</b> perdeu <b>{pointsLost} {pointsLost === 1 ? "ponto" : "pontos"}</b>. {attempt >= 2 ? `Última prorrogação: ${seconds}s para enviar ou será eliminado(a) da partida.` : `Nova oportunidade: +${seconds}s para enviar. Se perder novamente na próxima prorrogação, será eliminado(a) da partida.`}
            </div>
          );
        })}
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex-1 flex flex-col gap-4 pt-2">
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
            ⏰ {isSelf ? "Você" : <>{p.avatar} <b>{p.nickname}</b></>} perdeu <b>{pointsLost} {pointsLost === 1 ? "ponto" : "pontos"}</b>.{" "}
            {finalChance
              ? `Última prorrogação: ${seconds}s para enviar${isSelf ? " ou você será eliminado(a) da partida" : " ou será eliminado(a) da partida"}.`
              : `Nova oportunidade: +${seconds}s para enviar. Se ${isSelf ? "você perder" : "perder"} novamente na próxima prorrogação, será eliminado(a) da partida.`}
          </div>
        );
      })}

      {submitted || myDef ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center">
          <Mascot mood="thinking" size={110} />
          <p className="font-display text-lg">Definição enviada!</p>
          <p className="text-sm text-muted-foreground">Aguardando os outros…</p>
          <ProgressBar current={submittedCount} total={writers.length} />
          <PendingList pending={pending} />
        </div>
      ) : (
        <>
          <div className="-mt-2 -mx-4 flex flex-col gap-2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 140))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (text.trim().length >= 1) handleSubmit();
                }
              }}
              rows={3}
              placeholder="escreva sua definicao mirabolante..."
              className="w-full min-h-[118px] bg-input rounded-2xl px-4 py-4 font-body text-base leading-relaxed border border-white/10 outline-none focus:ring-4 focus:ring-pink/40 resize-none"
            />


            <div className="flex justify-between text-xs text-muted-foreground">
              <span className={text.length > 120 ? "text-pink" : text.length > 90 ? "text-sun" : ""}>{text.length}/140</span>
              <span>{submittedCount}/{writers.length} enviaram</span>
            </div>
            {pending.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-display mr-1">faltam:</span>
                {pending.map((p) => (
                  <span key={p.id} className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card/60 border border-white/10">
                    <span className="text-sm leading-none">{p.avatar}</span>
                    <span className="text-[11px] text-foreground/80 max-w-[80px] truncate">{p.nickname}</span>
                  </span>
                ))}
              </div>
            )}
            <button
              type="button"
              onPointerDown={(e) => { e.preventDefault(); }}
              onClick={() => { void playUITap("primary"); handleSubmit(); }}
              disabled={text.trim().length < 1}
              className="btn-pop bg-gradient-fun text-white text-lg !py-2.5 disabled:opacity-50">
              ✍️ Enviar definição
            </button>
            <button
              type="button"
              onPointerDown={(e) => { e.preventDefault(); }}
              onClick={() => { void playUITap("secondary"); handleAiGenerate(); }}
              disabled={aiLoading}
              className="btn-pop bg-card border border-pink/40 text-pink text-sm !py-2 disabled:opacity-50">
              {aiLoading ? "🤖 gerando…" : "🤖 gerar definição automática"}
            </button>
            <p className="text-center text-[11px] text-mint font-display bg-mint/10 rounded-xl py-1.5 px-3 border border-mint/30">
              ✏️ tudo será exibido em <b>letras minúsculas e sem acentos</b>
            </p>
          </div>
        </>
      )}
    </motion.div>
  );
}

export default WriteDefinition;


