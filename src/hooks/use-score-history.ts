import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  buildScoreHistory,
  fetchScoreHistory,
  HISTORY_ATTEMPT_TIMEOUT_MS,
  HISTORY_RETRY_DELAYS_MS,
  type ScoreHistory,
} from "@/lib/score-history";

/** Pontos mudando em sequência (realtime de vários jogadores) = 1 leitura. */
const SCORE_CHANGE_COALESCE_MS = 150;

/**
 * Histórico do placar com nova tentativa curta (lib/score-history). Só
 * devolve um retrato CONSISTENTE da rodada pedida — até lá, `history` é null
 * e o placar mostra "carregando os detalhes…" em vez de linhas falsas.
 * Sem laço: cada carga faz no máximo 3 tentativas; depois disso, só um
 * gatilho relê (pontos mudaram, aparelho voltou ao foco/à rede). Uma carga
 * nova cancela a anterior e resposta velha nunca sobrescreve a nova.
 */
export function useScoreHistory({
  roomId,
  round,
  requireRound,
  scoreSig,
}: {
  roomId: string;
  round: number;
  /** placar da rodada: a rodada corrente tem de vir pontuada */
  requireRound: boolean;
  /** muda quando players.score muda (ex.: bônus 🧠 que chega depois) */
  scoreSig: string;
}): { history: ScoreHistory | null; failed: boolean } {
  const key = `${roomId}:${round}:${requireRound ? 1 : 0}`;
  const [snap, setSnap] = useState<{
    key: string;
    history: ScoreHistory;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const runRef = useRef<() => void>(() => {});
  const readyRef = useRef(false);
  readyRef.current = snap?.key === key;

  useEffect(() => {
    let gen = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
    };
    // Carga substituída NÃO é cancelada (o fetch instrumentado contaria como
    // falha de rede): termina e a resposta é descartada pelo `gen`. Só o
    // prazo cancela — aí é leitura presa de verdade.
    const stop = () => {
      gen++;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
    const run = () => {
      stop();
      const mine = gen;
      const attempt = async (n: number) => {
        if (mine !== gen) return;
        const c = new AbortController();
        const deadline = setTimeout(
          () => c.abort(),
          HISTORY_ATTEMPT_TIMEOUT_MS,
        );
        let res: ReturnType<typeof buildScoreHistory>;
        try {
          res = buildScoreHistory(
            await fetchScoreHistory(supabase, roomId, c.signal),
            { round, requireRound },
          );
        } catch {
          res = { ok: false, reason: "excecao" };
        } finally {
          clearTimeout(deadline);
        }
        if (mine !== gen) return; // carga mais nova em curso: esta não vale
        if (res.ok) {
          setSnap({ key, history: res.history });
          setFailed(false);
          return;
        }
        const wait = HISTORY_RETRY_DELAYS_MS[n];
        if (wait === undefined) {
          setFailed(true); // esgotou: só um gatilho relê
          return;
        }
        later(() => void attempt(n + 1), wait);
      };
      void attempt(0);
    };
    runRef.current = run;
    setFailed(false);
    run();
    // aparelho voltou (foco, tela visível, rede): relê só se ainda falta
    const onBack = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      )
        return;
      if (!readyRef.current) run();
    };
    window.addEventListener("focus", onBack);
    window.addEventListener("online", onBack);
    document.addEventListener("visibilitychange", onBack);
    return () => {
      stop();
      runRef.current = () => {};
      window.removeEventListener("focus", onBack);
      window.removeEventListener("online", onBack);
      document.removeEventListener("visibilitychange", onBack);
    };
  }, [roomId, round, requireRound, key]);

  // Pontos mudaram depois de montar (ex.: bônus 🧠 tardio): relê, agrupando
  // mudanças em sequência; o retrato atual fica na tela até o novo chegar.
  const firstSig = useRef(true);
  useEffect(() => {
    if (firstSig.current) {
      firstSig.current = false;
      return;
    }
    const t = setTimeout(() => runRef.current(), SCORE_CHANGE_COALESCE_MS);
    return () => clearTimeout(t);
  }, [scoreSig]);

  return { history: snap?.key === key ? snap.history : null, failed };
}
