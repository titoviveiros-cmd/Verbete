// Desafio Diário D1 — tela do modo ESCOLHA (múltipla escolha, sem IA).
// O D1 não simula avaliação de texto: mede reconhecimento da definição certa
// entre 4 alternativas, e a tela diz isso. Sem medidor, nota ou porcentagem.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Mascot } from "@/components/Mascot";
import { TimerBar } from "@/components/room/shared";
import {
  CHOICE_HOUR_CHANGED,
  CHOICE_MODE_CHANGED,
  CHOICE_NO_SESSION,
  CHOICE_TIME_LIMIT_S,
  type ChoiceOption,
  type ChoiceResultView,
  type ChoiceStartView,
} from "@/lib/daily-choice";

const LETTERS = ["A", "B", "C", "D"];

export type ChoiceFlowProps = {
  /** abre (ou reabre) as alternativas no servidor */
  start: () => Promise<ChoiceStartView>;
  /** envia a posição escolhida; o servidor mede o tempo e decide o acerto */
  submit: (pos: number, hour: string) => Promise<ChoiceResultView>;
  /** a palavra chega JUNTO com as alternativas (o relógio começa aqui): a tela mostra esta */
  onStarted?: (v: { word: string; category: string | null }) => void;
  /** aceite dos Termos antes de abrir (o resultado entra no ranking) */
  confirmTerms: () => boolean;
  assertTerms?: () => Promise<void>;
  /** caixa de aceite (TermsConsent) */
  consent?: ReactNode;
  onFinished: (r: ChoiceResultView) => void;
  /** o servidor disse que já jogou ou que o modo mudou: recarregar a revisão */
  onReload: () => void;
  now?: () => number;
};

export function DailyChoiceFlow(props: ChoiceFlowProps) {
  const now = props.now ?? Date.now;
  const [options, setOptions] = useState<ChoiceOption[] | null>(null);
  const [hour, setHour] = useState<string>("");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(() => now());
  const sent = useRef(false);

  useEffect(() => {
    if (startedAt === null) return;
    const iv = setInterval(() => setTick(now()), 250);
    return () => clearInterval(iv);
  }, [startedAt, now]);

  const remaining =
    startedAt === null
      ? CHOICE_TIME_LIMIT_S
      : Math.max(
          0,
          CHOICE_TIME_LIMIT_S - Math.floor((tick - startedAt) / 1000),
        );

  const open = async () => {
    if (busy) return;
    if (!props.confirmTerms()) return;
    setBusy(true);
    setError(null);
    try {
      await props.assertTerms?.();
      const r = await props.start();
      if (r.status === "ok") {
        setOptions(r.options);
        setHour(r.hour);
        setPicked(null);
        props.onStarted?.({ word: r.word, category: r.category });
        setStartedAt(now() - r.elapsedS * 1000);
        setTick(now());
      } else props.onReload();
    } catch (e) {
      setError(
        e instanceof Error && e.message
          ? e.message
          : "Não foi possível abrir agora — tente de novo.",
      );
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (busy || picked === null || sent.current) return;
    sent.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await props.submit(picked, hour);
      if (r.already_played) props.onReload();
      else props.onFinished(r);
    } catch (e) {
      sent.current = false;
      const msg = e instanceof Error ? e.message : "";
      // Red Team A2: hora virou / sessão perdida / modo mudou → as alternativas na tela
      // não valem mais. Volta ao início (nada foi gasto) para reabrir as da hora atual.
      if (
        msg === CHOICE_HOUR_CHANGED ||
        msg === CHOICE_NO_SESSION ||
        msg === CHOICE_MODE_CHANGED
      ) {
        setOptions(null);
        setPicked(null);
        setStartedAt(null);
        setHour("");
        if (msg === CHOICE_MODE_CHANGED) props.onReload();
      }
      setError(
        e instanceof Error && e.message
          ? e.message
          : "Não foi possível enviar agora — tente de novo.",
      );
    } finally {
      setBusy(false);
    }
  };

  // Tempo da barra acabou com uma alternativa marcada: envia (como o palpite
  // escrito no modo juiz). Sem marcação, nada sai e a tentativa segue aberta.
  useEffect(() => {
    if (remaining === 0 && picked !== null && !busy && !error && !sent.current)
      void confirm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remaining, picked, busy, error]);

  if (!options) {
    return (
      <div
        className="flex flex-col gap-3 pt-3"
        data-testid="daily-choice-intro"
      >
        <p className="eyebrow px-1">Escolha a definição correta</p>
        <p className="text-[15px] leading-snug px-1">
          Você verá 4 definições para a palavra — só uma é a verdadeira. Quanto
          mais rápido acertar, mais pontos.
        </p>
        {props.consent}
        <button
          onClick={() => void open()}
          disabled={busy}
          className="btn-pop btn-gold text-xl py-4"
        >
          {busy ? "Abrindo..." : "Ver alternativas ▶"}
        </button>
        {error && (
          <p
            role="alert"
            className="text-xs text-destructive font-display text-center"
          >
            {error}
          </p>
        )}
        <p className="text-[12px] text-muted-foreground text-center">
          Uma tentativa por hora!
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 pt-3" data-testid="daily-choice-play">
      <TimerBar
        remaining={remaining}
        max={CHOICE_TIME_LIMIT_S}
        tickStartAt={10}
      />
      <p id="daily-choice-label" className="eyebrow px-1">
        Escolha a definição correta
      </p>
      <div
        role="radiogroup"
        aria-labelledby="daily-choice-label"
        className="flex flex-col gap-2"
      >
        {options.map((o) => {
          const on = picked === o.pos;
          return (
            <button
              key={o.pos}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={busy}
              onClick={() => setPicked(o.pos)}
              className={
                "sticker !rounded-2xl !py-3 !px-3.5 text-left flex items-start gap-3 text-[15px] leading-snug " +
                (on ? "ring-gold !border-sun/70" : "")
              }
            >
              <span
                className={
                  "font-display text-lg w-6 shrink-0 " +
                  (on ? "text-sun" : "text-muted-foreground")
                }
              >
                {LETTERS[o.pos]}
              </span>
              <span className="flex-1">{o.text}</span>
            </button>
          );
        })}
      </div>
      <button
        onClick={() => void confirm()}
        disabled={busy || picked === null}
        className="btn-pop btn-gold text-xl py-4"
      >
        {busy ? "Enviando..." : "Confirmar resposta 🎯"}
      </button>
      {error && (
        <p
          role="alert"
          className="text-xs text-destructive font-display text-center"
        >
          {error}
        </p>
      )}
      <p className="text-[12px] text-muted-foreground text-center">
        Quanto mais rápido acertar, mais pontos. Uma tentativa por hora!
      </p>
    </div>
  );
}

export function ChoiceResultCard(props: {
  correct: boolean;
  score: number;
  truth: string;
  chosen: string;
  streak?: number;
}) {
  const { correct, score, truth, chosen, streak } = props;
  return (
    <motion.div
      key="choice-result"
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: "spring", stiffness: 220, damping: 18 }}
      className={
        "sticker !px-4 !py-5 mt-3 text-center flex flex-col gap-4 " +
        (correct ? "ring-gold" : "")
      }
      data-testid="daily-choice-result"
    >
      <div className="flex flex-col items-center">
        <Mascot mood={correct ? "excited" : "sad"} size={84} />
        <p className="font-display text-2xl mt-1">
          {correct ? "Acertou!" : "Não foi dessa vez"}
        </p>
        <p
          className={
            "font-display text-[52px] leading-none mt-1 tabular-nums " +
            (correct ? "text-gold-grad" : "text-muted-foreground")
          }
        >
          +{score}
          <span className="text-2xl"> pts</span>
        </p>
        {streak ? (
          <span className="chip mt-2 !text-sun !border-sun/50 text-sm">
            🔥 Streak: {streak} dia{streak > 1 ? "s" : ""}
          </span>
        ) : null}
      </div>
      <div className="grid gap-2.5 text-left lg:grid-cols-2">
        {!correct && chosen && (
          <div className="rounded-2xl p-3 border border-pink/35 bg-pink/[0.08]">
            <p className="eyebrow !text-pink mb-1">✗ Sua escolha</p>
            <p className="text-[15px] text-foreground leading-snug">
              “{chosen}”
            </p>
          </div>
        )}
        {truth && (
          <div className="rounded-2xl p-3 border border-mint/40 bg-mint/[0.1]">
            <p className="eyebrow !text-mint mb-1">
              {correct ? "✓ Sua escolha — a definição correta" : "✓ Era esta"}
            </p>
            <p className="text-[15px] leading-snug">“{truth}”</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function DailyPausePanel({ message }: { message: string }) {
  return (
    <div
      className="sticker !px-4 !py-5 mt-3 text-center flex flex-col items-center gap-2"
      role="status"
    >
      <Mascot mood="thinking" size={72} />
      <p className="font-display text-lg">Desafio em pausa</p>
      <p className="text-[14px] text-muted-foreground leading-snug">
        {message}
      </p>
    </div>
  );
}
