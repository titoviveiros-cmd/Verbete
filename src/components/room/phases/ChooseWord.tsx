import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  fetchThreeWords,
  chooseWord,
  type Player,
  type Room,
  type Word,
} from "@/lib/room";
import { Mascot } from "@/components/Mascot";
import { playUITap } from "@/lib/sound";
import {
  drawFittingWords,
  measureWordFit,
  OPTION_CHIP_CLASS,
  OPTION_CLASS,
  OPTION_GRID_CLASS,
  OPTION_ICON_CLASS,
  OPTION_LG_CLASS,
  OPTION_LG_ICON_CLASS,
  OPTION_LG_TEXT_CLASS,
  OPTION_LG_WORD_CLASS,
  OPTION_TEXT_CLASS,
  OPTION_WORD_CLASS,
} from "@/lib/word-fit";

// Candidatas por sorteio: sobra para ficar só com as que cabem inteiras.
const CANDIDATES = 9;

// O sorteio continua sendo o momento do coordenador: o dicionário folheia por
// FLIP_MIN_MS depois do toque. Mas as palavras já vêm buscadas desde que a
// fase abriu (durante a transição "Escolha da Palavra"), então o folhear não
// espera a rede. Antes: 3 s de cortina + toque + 1,8 s fixos, com a busca
// (≈0,5 s) começando só no toque (playtest 2026-10-20).
export const FLIP_MIN_MS = 650;

export function ChooseWord({
  room,
  players,
  isCoordinator,
}: {
  room: Room;
  players: Player[];
  isCoordinator: boolean;
}) {
  const [phase, setPhase] = useState<"idle" | "flipping" | "ready">("idle");
  const [words, setWords] = useState<Word[] | null>(null);
  const [scale, setScale] = useState<Record<string, number>>({});
  const [picking, setPicking] = useState<string | null>(null);
  const coord = players.find((p) => p.id === room.current_coordinator);

  // Mesmas regras de sempre (fetchThreeWords: sem as já usadas, categorias e
  // nível da sala) — a busca só começa mais cedo, uma vez por rodada.
  const roomRef = useRef(room);
  roomRef.current = room;
  const drawKey = `${room.id}:${room.current_round}`;
  const prefetch = useRef<{
    key: string;
    words: Promise<Awaited<ReturnType<typeof drawFittingWords>> | null>;
  } | null>(null);
  // As 3 opções cabem inteiras na tela (lib/word-fit.ts): sem "…". No
  // desktop elas ficam lado a lado, mais estreitas que no celular: a medida
  // também usa a largura real dessa grade.
  const rootRef = useRef<HTMLDivElement>(null);
  const draw = () => {
    const r = roomRef.current;
    const lgGridWidth =
      typeof window !== "undefined" &&
      window.matchMedia?.("(min-width: 1024px)")?.matches
        ? rootRef.current?.clientWidth
        : undefined;
    return drawFittingWords({
      measure: (ws) => measureWordFit(ws, { lgGridWidth }),
      fetch: (seen) =>
        fetchThreeWords(
          [...(r.used_word_ids ?? []), ...seen],
          r.categories ?? [],
          r.id,
          r.nivel ?? "aleatorio",
          CANDIDATES,
        ),
    });
  };
  useEffect(() => {
    if (!isCoordinator || prefetch.current?.key === drawKey) return;
    prefetch.current = { key: drawKey, words: draw().catch(() => null) };
  }, [isCoordinator, drawKey]);

  const handleDraw = async () => {
    if (phase !== "idle") return;
    setPhase("flipping");
    const startedAt = Date.now();
    try {
      const pre =
        prefetch.current?.key === drawKey ? prefetch.current.words : null;
      let drawn = pre ? await pre : null;
      // pré-busca falhou (rede): busca de novo agora
      if (!drawn || drawn.words.length === 0) drawn = await draw();
      const left = FLIP_MIN_MS - (Date.now() - startedAt);
      if (left > 0) await new Promise((r) => setTimeout(r, left));
      setWords(drawn.words);
      setScale(drawn.scale);
      setPhase("ready");
    } catch (e) {
      // sem palavras: o botão volta para o coordenador tentar de novo
      console.error("fetchThreeWords failed", e);
      prefetch.current = null;
      setPhase("idle");
    }
  };

  const handlePick = async (wordId: string) => {
    if (picking) return;
    setPicking(wordId);
    void playUITap();
    try {
      await chooseWord(room.id, wordId, 60, players.length);
    } catch (e) {
      console.error("chooseWord failed", e);
      setPicking(null);
    }
  };

  return (
    <motion.div
      ref={rootRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      // Celular deitado (short:), escolhendo entre as 3 cartas: cartas +
      // título não cabiam na altura útil e a última descia para baixo da
      // barra de reações. Só nesse estado o bloco começa no topo, fica mais
      // compacto e, se ainda faltar altura, rola dentro da área útil (que
      // termina acima da barra). "Sortear palavra" segue centralizado.
      className={
        "flex-1 flex flex-col items-center justify-center gap-4 lg:gap-6" +
        (phase === "ready"
          ? " short:justify-start short:gap-2 short:min-h-0 short:overflow-y-auto short:overflow-x-hidden no-scrollbar"
          : "")
      }
    >
      {phase !== "ready" && (
        <div className="relative short:hidden">
          <div
            aria-hidden
            className="absolute -inset-8 rounded-full pointer-events-none"
            style={{
              background:
                "radial-gradient(circle, rgb(155 108 255 / 0.35) 0%, transparent 70%)",
              filter: "blur(16px)",
            }}
          />
          <Mascot mood="thinking" size={140} className="relative" />
        </div>
      )}
      {/* Escolhendo a palavra no celular deitado, o próprio coordenador não
          precisa do cabeçalho com o nome dele: a altura vai para as cartas. */}
      <div
        className={
          "text-center flex flex-col items-center" +
          (phase === "ready" ? " short:hidden" : "")
        }
      >
        <p className="eyebrow">Coordenador da rodada</p>
        <div className="flex items-center gap-2.5 mt-1.5">
          {coord && (
            <span
              aria-hidden
              className={
                "rounded-full flex items-center justify-center shrink-0 " +
                (phase === "ready" ? "w-9 h-9 text-lg" : "w-12 h-12 text-2xl")
              }
              style={{
                background: `radial-gradient(circle at 30% 25%, ${coord.color}cc, ${coord.color})`,
                boxShadow:
                  "0 0 0 2px rgb(244 197 66 / 0.9), 0 4px 0 rgb(0 0 0 / 0.35)",
              }}
            >
              {coord.avatar}
            </span>
          )}
          <h2
            className={
              "font-display text-gold-grad leading-none " +
              (phase === "ready" ? "text-3xl" : "text-[42px] short:text-3xl")
            }
          >
            {coord?.nickname}
          </h2>
          <span
            aria-hidden
            className={phase === "ready" ? "text-2xl" : "text-3xl"}
          >
            👑
          </span>
        </div>
      </div>

      {isCoordinator ? (
        <div className="w-full flex flex-col items-center gap-4 short:gap-2">
          {phase === "idle" && (
            <motion.button
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              whileTap={{ scale: 0.95 }}
              onClick={handleDraw}
              className="btn-pop btn-gold text-2xl px-9 py-5"
            >
              📖 Sortear palavra
            </motion.button>
          )}

          {phase === "flipping" && <DictionaryFlip />}

          {phase === "ready" && words && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full flex flex-col gap-3 short:gap-2"
            >
              <p className="text-center font-display text-pink text-xl short:text-lg">
                {picking ? "Confirmando palavra…" : "Escolha uma palavra rara!"}
              </p>
              <div className={OPTION_GRID_CLASS}>
                {words.map((w, i) => (
                  <motion.button
                    key={w.id}
                    initial={{ scale: 0.6, opacity: 0, rotate: -3 }}
                    animate={{ scale: 1, opacity: 1, rotate: 0 }}
                    transition={{
                      delay: i * 0.1,
                      type: "spring",
                      stiffness: 220,
                    }}
                    whileTap={{ scale: 0.96 }}
                    disabled={!!picking}
                    onClick={() => handlePick(w.id)}
                    onCopy={(e) => e.preventDefault()}
                    onContextMenu={(e) => e.preventDefault()}
                    className={
                      `${OPTION_CLASS} ${OPTION_LG_CLASS} short:!py-2 no-copy ` +
                      (picking && picking !== w.id
                        ? "opacity-40 pointer-events-none "
                        : "") +
                      (picking === w.id ? "ring-neon " : "")
                    }
                  >
                    <span
                      aria-hidden
                      className={`${OPTION_ICON_CLASS} ${OPTION_LG_ICON_CLASS}`}
                    >
                      📖
                    </span>
                    {/* a categoria só divide a linha se couber; senão desce */}
                    <div
                      className={`${OPTION_TEXT_CLASS} ${OPTION_LG_TEXT_CLASS}`}
                    >
                      <p
                        className={`${OPTION_WORD_CLASS} ${OPTION_LG_WORD_CLASS}`}
                        // último recurso (acervo mínimo): fonte menor até caber
                        style={
                          scale[w.id] && scale[w.id]! < 1
                            ? {
                                fontSize: `${Math.max(14, 22 * scale[w.id]!)}px`,
                              }
                            : undefined
                        }
                      >
                        {w.word}
                      </p>
                      {w.category && (
                        <span className={OPTION_CHIP_CLASS}>{w.category}</span>
                      )}
                    </div>
                  </motion.button>
                ))}
              </div>
            </motion.div>
          )}
        </div>
      ) : (
        <div className="panel px-5 py-4 text-center flex flex-col items-center gap-2">
          <p className="font-display text-lg">
            {coord?.is_bot ? "🤖 " : ""}
            {coord?.nickname ?? "O coordenador"} está escolhendo a palavra…
          </p>
          <div className="flex items-center gap-1.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <motion.span
                key={i}
                className="w-2 h-2 rounded-full bg-sun"
                animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
                transition={{
                  duration: 1.1,
                  repeat: Infinity,
                  delay: i * 0.18,
                }}
              />
            ))}
          </div>
        </div>
      )}
    </motion.div>
  );
}

function DictionaryFlip() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="relative"
        style={{ width: 220, height: 150, perspective: "1200px" }}
        aria-label="Dicionário sendo folheado"
      >
        <div className="absolute inset-0 rounded-r-md rounded-l-sm bg-gradient-to-r from-[#4a2a14] via-[#6b3a1c] to-[#4a2a14] shadow-pop" />
        <div className="absolute inset-y-2 inset-x-2 rounded-sm bg-[#fdf6e3]" />
        <div className="absolute inset-y-2 left-1/2 -ml-px w-0.5 bg-black/20" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <motion.div
            key={i}
            className="absolute top-2 bottom-2 right-2 w-[calc(50%-6px)] rounded-sm bg-[#fdf6e3] shadow-md"
            style={{
              transformOrigin: "left center",
              backfaceVisibility: "hidden",
              backgroundImage:
                "repeating-linear-gradient(transparent 0 10px, rgba(0,0,0,0.06) 10px 11px)",
            }}
            initial={{ rotateY: 0 }}
            animate={{ rotateY: -170 }}
            transition={{
              duration: 0.55,
              ease: "easeIn",
              delay: i * 0.18,
              repeat: Infinity,
              repeatDelay: 6 - i * 0.18,
            }}
          />
        ))}
      </div>
      <p className="font-display text-lg text-pink animate-pulse">
        Folheando o dicionário…
      </p>
    </div>
  );
}

export default ChooseWord;
