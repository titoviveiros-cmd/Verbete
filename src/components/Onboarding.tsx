import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mascot } from "@/components/Mascot";
import { verbeteWordmarkStyle } from "@/components/VerbeteLogo";

type StaticStep = {
  kind: "static";
  emoji: string;
  title: string;
  body: string;
  joke: string;
  mood: "idle" | "excited" | "thinking" | "sad";
};

type DemoStep = {
  kind: "demo";
  title: string;
  word: string;
  truthIndex: number;
  options: string[];
  mood: "idle" | "excited" | "thinking" | "sad";
};

type Step = StaticStep | DemoStep;

const STEPS: Step[] = [
  {
    kind: "static",
    emoji: "📖",
    title: "Sorteie a palavra",
    body: 'O Coordenador 👑 toca em "Sortear palavra" e escolhe uma entre 3 palavras esquisitíssimas do dicionário. Ninguém faz ideia do que é — e essa é a graça.',
    joke: 'Spoiler: ninguém aqui sabe o que é "jacarandá-do-cerrado". Tudo bem.',
    mood: "thinking",
  },
  {
    kind: "static",
    emoji: "✍️",
    title: "Blefe ou diga a verdade",
    body: "Cada jogador escreve uma definição falsa convincente (ou tenta acertar a verdadeira). O jogo embaralha tudo e mostra as opções sem nomes. Hora de votar!",
    joke: 'Capricha no portuguesinho de dicionário, tipo: "s.f. ato ou efeito de…". Funciona sempre.',
    mood: "excited",
  },
  {
    kind: "demo",
    title: "Experimenta votar!",
    word: "borogodó",
    truthIndex: 1,
    options: [
      "tipo de instrumento musical de sopro feito de bambu",
      "atrativo pessoal, charme natural que encanta os outros",
      "doce regional feito de leite condensado e côco queimado",
    ],
    mood: "thinking",
  },
  {
    kind: "static",
    emoji: "🏆",
    title: "Pontue enganando",
    body: "+3 se você acertar a verdadeira.\n+3 se seu significado for ao menos 80% equivalente ao verdadeiro.\n+2 pro Coordenador se ninguém descobrir a verdade.\n+1 pra cada voto que SUA definição receber.",
    joke: "Tradução: enganar amigos = lucro. Ser enganado = aprendizado emocional.",
    mood: "excited",
  },
];

function DemoStepView({
  step,
  onContinue,
}: {
  step: DemoStep;
  onContinue: () => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const correct = picked === step.truthIndex;

  return (
    <motion.div
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.25 }}
      className="text-center px-1"
    >
      <h2 className="font-display text-2xl text-sun mb-1">{step.title}</h2>
      <p className="text-xs text-muted-foreground mb-2">
        Qual destas é a definição verdadeira de:
      </p>
      {/* Uniformização: palavra no tratamento canônico (branco + contorno) */}
      <div
        className="font-display font-black text-4xl mb-3 leading-tight pb-1 capitalize"
        style={verbeteWordmarkStyle(36)}
      >
        {step.word}
      </div>

      <div className="flex flex-col gap-2">
        {step.options.map((opt, idx) => {
          const isTruth = idx === step.truthIndex;
          const isPicked = picked === idx;
          const showResult = picked !== null;
          const letter = String.fromCharCode(65 + idx);

          let style = "bg-input border-white/10";
          if (showResult) {
            if (isTruth) style = "bg-mint/20 border-mint text-mint";
            else if (isPicked)
              style = "bg-destructive/20 border-destructive text-destructive";
            else style = "bg-input/40 border-white/5 opacity-60";
          }

          return (
            <button
              key={idx}
              type="button"
              disabled={picked !== null}
              onClick={() => setPicked(idx)}
              className={`text-left text-sm rounded-2xl border-2 px-3 py-2 flex items-start gap-2 transition ${style} ${
                picked === null
                  ? "hover:border-pink/50 active:scale-[0.98]"
                  : ""
              }`}
            >
              <span className="font-display text-sm shrink-0">{letter}</span>
              <span className="flex-1 leading-snug">{opt}</span>
              {showResult && isTruth && <span className="shrink-0">✅</span>}
              {showResult && isPicked && !isTruth && (
                <span className="shrink-0">❌</span>
              )}
            </button>
          );
        })}
      </div>

      <AnimatePresence>
        {picked !== null && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-3 text-xs text-pink/90 italic leading-snug"
          >
            {correct
              ? "🎉 Boa! Você teria ganhado +3 pontos. Agora imagina enganar os amigos com uma definição falsa…"
              : "😅 Tranquilo, é exatamente isso que acontece numa partida real. Agora você sabe."}
          </motion.div>
        )}
      </AnimatePresence>

      {picked !== null && (
        <button
          onClick={onContinue}
          className="btn-pop bg-gradient-fun text-white text-sm mt-3 px-5"
        >
          Continuar →
        </button>
      )}
    </motion.div>
  );
}

export function Onboarding({ onClose }: { onClose: () => void }) {
  const [i, setI] = useState(0);
  // noUncheckedIndexedAccess: i é sempre um índice válido de STEPS
  const step = STEPS[i] ?? STEPS[0]!;
  const isLast = i === STEPS.length - 1;
  const isDemo = step.kind === "demo";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-background/95 backdrop-blur-md p-4 overflow-y-auto"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, y: 20 }}
        animate={{ scale: 1, y: 0 }}
        className="w-full max-w-md my-auto rounded-3xl bg-card border border-white/10 shadow-pop p-5 flex flex-col gap-4 relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          aria-label="Fechar"
          className="absolute top-3 right-3 w-9 h-9 rounded-full bg-input text-lg flex items-center justify-center"
        >
          ×
        </button>

        {/* Progress dots */}
        <div className="flex justify-center gap-1.5 pt-2">
          {STEPS.map((_, idx) => (
            <button
              key={idx}
              onClick={() => setI(idx)}
              className={
                "h-1.5 rounded-full transition-all " +
                (idx === i ? "w-7 bg-pink" : "w-1.5 bg-white/20")
              }
              aria-label={`Passo ${idx + 1}`}
            />
          ))}
        </div>

        <div className="flex justify-center -mb-2">
          <Mascot mood={step.mood} size={isDemo ? 80 : 110} />
        </div>

        <AnimatePresence mode="wait">
          {step.kind === "static" ? (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.25 }}
              className="text-center px-1"
            >
              <div className="text-5xl mb-2">{step.emoji}</div>
              <h2 className="font-display text-2xl text-sun mb-2">
                {step.title}
              </h2>
              <p className="text-foreground/90 text-sm leading-relaxed whitespace-pre-line">
                {step.body}
              </p>
              <p className="mt-3 text-xs italic text-pink/90 leading-snug">
                💬 {step.joke}
              </p>
            </motion.div>
          ) : (
            <DemoStepView key={i} step={step} onContinue={() => setI(i + 1)} />
          )}
        </AnimatePresence>

        {!isDemo && (
          <div className="flex gap-2 pt-2">
            {i > 0 && (
              <button
                onClick={() => setI(i - 1)}
                className="btn-pop bg-card flex-1 text-sm border border-white/10"
              >
                ← Voltar
              </button>
            )}
            {!isLast ? (
              <button
                onClick={() => setI(i + 1)}
                className="btn-pop bg-gradient-fun text-white flex-[2] text-base"
              >
                Próximo →
              </button>
            ) : (
              <button
                onClick={onClose}
                className="btn-pop bg-gradient-fun text-white flex-[2] text-base"
              >
                🚀 Bora jogar!
              </button>
            )}
          </div>
        )}

        <p className="text-center text-[10px] text-muted-foreground">
          {i + 1} de {STEPS.length}
        </p>
      </motion.div>
    </motion.div>
  );
}
