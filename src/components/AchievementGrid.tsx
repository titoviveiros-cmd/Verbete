// Grade de conquistas do perfil com "como desbloquear" consultável (18/11/2026).
// Antes só havia `title` (hover do navegador): no celular não abria nada.
//
// Um cartão por vez, sempre com nome completo, estado e a condição — a MESMA
// `description` do catálogo `achievements` (nada inventado: sem quantidades
// nem progresso que o banco não informa). Interação:
//   * mouse: passar por cima abre (o cartão continua aberto com o ponteiro
//     sobre ele); clicar FIXA o cartão aberto;
//   * teclado: foco abre; Enter/Espaço fixa ou solta; Escape fecha;
//   * toque: um toque abre e fixa (sem toque longo); tocar fora fecha;
//   * botão "Fechar" acessível dentro do cartão.
// O cartão vai num portal (Radix Popover): não herda a transparência dos
// ícones bloqueados e se reposiciona para não sair da tela.
// Só leitura: nenhuma chamada ao servidor, nada muda em pontos ou desbloqueios.
import { useEffect, useRef, useState } from "react";
import type { Achievement } from "@/lib/daily";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

export const ACHIEVEMENT_HINT =
  "Toque em uma conquista para saber como desbloqueá-la.";
export const ACHIEVEMENT_GOT = "Conquistada";
export const ACHIEVEMENT_LOCKED = "Ainda não conquistada";

type Aberto = { code: string; fixo: boolean } | null;

/** Atraso para fechar ao sair com o mouse (dá tempo de ir do ícone ao cartão). */
const FECHAR_MS = 180;

export function AchievementGrid({
  achievements,
  unlocked,
}: {
  achievements: Achievement[];
  unlocked: ReadonlySet<string>;
}) {
  const [aberto, setAberto] = useState<Aberto>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Foco só abre o cartão quando veio do teclado (no toque/clique o foco
  // também acontece, mas quem decide é o clique).
  const teclado = useRef(false);

  const cancelarFechamento = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const agendarFechamento = () => {
    cancelarFechamento();
    timer.current = setTimeout(() => {
      setAberto((o) => (o && !o.fixo ? null : o));
    }, FECHAR_MS);
  };

  useEffect(() => {
    const kb = (e: KeyboardEvent) => {
      teclado.current = true;
      // Escape sempre fecha o cartão aberto. O do Radix vai para a camada mais
      // alta — que, nos ~150 ms da animação de saída de um cartão anterior, é
      // a dele (e aí o aberto não fecharia).
      if (e.key === "Escape") setAberto(null);
    };
    const ptr = () => {
      teclado.current = false;
    };
    document.addEventListener("keydown", kb, true);
    document.addEventListener("pointerdown", ptr, true);
    document.addEventListener("mousedown", ptr, true);
    return () => {
      document.removeEventListener("keydown", kb, true);
      document.removeEventListener("pointerdown", ptr, true);
      document.removeEventListener("mousedown", ptr, true);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  return (
    <>
      <p className="text-xs text-muted-foreground -mt-1">{ACHIEVEMENT_HINT}</p>
      <ul className="grid grid-cols-5 gap-2" aria-label="Conquistas">
        {achievements.map((a) => {
          const got = unlocked.has(a.code);
          const estado = got ? ACHIEVEMENT_GOT : ACHIEVEMENT_LOCKED;
          const isOpen = aberto?.code === a.code;
          const tituloId = `conquista-${a.code}-titulo`;
          return (
            <li key={a.code}>
              <Popover
                open={isOpen}
                onOpenChange={(v) => {
                  // só fechamentos chegam aqui (fora, Escape, foco fora); abrir
                  // é decidido pelos manipuladores abaixo
                  if (!v) setAberto((o) => (o?.code === a.code ? null : o));
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-testid={`conquista-${a.code}`}
                    aria-label={`${a.name}: ${estado.toLowerCase()}`}
                    className={
                      "sticker w-full py-2 text-center transition cursor-pointer " +
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary " +
                      (isOpen ? "ring-2 ring-primary/70" : "")
                    }
                    onClick={(e) => {
                      e.preventDefault(); // o Radix não alterna sozinho
                      cancelarFechamento();
                      setAberto((o) =>
                        o?.code === a.code && o.fixo
                          ? null
                          : { code: a.code, fixo: true },
                      );
                    }}
                    onPointerEnter={(e) => {
                      if (e.pointerType !== "mouse") return;
                      cancelarFechamento();
                      setAberto((o) =>
                        o?.fixo ? o : { code: a.code, fixo: false },
                      );
                    }}
                    onPointerLeave={(e) => {
                      if (e.pointerType === "mouse") agendarFechamento();
                    }}
                    onFocus={() => {
                      if (!teclado.current) return;
                      cancelarFechamento();
                      setAberto((o) =>
                        o?.fixo && o.code !== a.code
                          ? o
                          : o?.code === a.code
                            ? o
                            : { code: a.code, fixo: false },
                      );
                    }}
                    onBlur={() => {
                      setAberto((o) =>
                        o?.code === a.code && !o.fixo ? null : o,
                      );
                    }}
                  >
                    {/* a transparência fica no conteúdo do ícone, não no botão
                        (o contorno de foco continua visível) */}
                    <span
                      className={"block " + (got ? "" : "opacity-30 grayscale")}
                    >
                      <span className="block text-2xl" aria-hidden="true">
                        {a.emoji}
                      </span>
                      <span className="block text-[9px] font-display leading-tight mt-1 truncate">
                        {a.name}
                      </span>
                    </span>
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  sideOffset={6}
                  collisionPadding={12}
                  aria-labelledby={tituloId}
                  className="w-64 max-w-[calc(100vw-1.5rem)] p-3 text-left"
                  onOpenAutoFocus={(e) => e.preventDefault()}
                  onCloseAutoFocus={(e) => e.preventDefault()}
                  onPointerEnter={(e) => {
                    if (e.pointerType === "mouse") cancelarFechamento();
                  }}
                  onPointerLeave={(e) => {
                    if (e.pointerType === "mouse") agendarFechamento();
                  }}
                >
                  <div className="flex items-start gap-2">
                    <span className="text-2xl leading-none" aria-hidden="true">
                      {a.emoji}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        id={tituloId}
                        className="font-display text-sm leading-snug break-words"
                      >
                        {a.name}
                      </p>
                      <p
                        className={
                          "mt-0.5 text-[11px] font-semibold " +
                          (got ? "text-mint" : "text-muted-foreground")
                        }
                      >
                        {got ? "✓ " : "🔒 "}
                        {estado}
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label="Fechar"
                      className="-mr-1 -mt-1 rounded-md px-2 py-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                      onClick={() => {
                        cancelarFechamento();
                        setAberto(null);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Como desbloquear
                  </p>
                  <p className="text-sm leading-snug break-words">
                    {a.description}
                  </p>
                </PopoverContent>
              </Popover>
            </li>
          );
        })}
      </ul>
    </>
  );
}
