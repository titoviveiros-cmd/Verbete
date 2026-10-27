import { useState } from "react";
import { createPortal } from "react-dom";
import { useServerFn } from "@tanstack/react-start";
import { reportPlayer } from "@/lib/moderation.functions";
import { expectOk } from "@/lib/server-fn-transport";
import {
  PLAYER_REPORT_REASONS,
  type PlayerReportReason,
} from "@/lib/report-player-reasons";
import type { Player } from "@/lib/room";

/**
 * Denúncia de jogador (apelido ou comportamento) — política de conteúdo
 * gerado por usuários do Google Play. Discreta como a 🚩 das cédulas: um
 * link pequeno que abre o mini-modal com os OUTROS humanos da sala (nunca
 * você, nunca bots). Só o id do jogador e o motivo vão ao servidor, que acha
 * apelido e sala no banco (report-player.ts).
 */
export function ReportPlayerButton({
  players,
  meId,
  className = "",
}: {
  players: Player[];
  meId: string;
  className?: string;
}) {
  const others = players.filter((p) => p.id !== meId && !p.is_bot);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string>("");
  const [reason, setReason] = useState<PlayerReportReason>("nickname");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runReport = useServerFn(reportPlayer);

  if (others.length === 0) return null;

  const submit = async () => {
    if (!target) {
      setError("Escolha o jogador.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      expectOk(
        await runReport({ data: { playerId: target, reason } }),
        "Não foi possível enviar a denúncia.",
      );
      setDone(true);
      setTimeout(() => setOpen(false), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao denunciar.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setDone(false);
          setError(null);
          setTarget(others.length === 1 ? others[0]!.id : "");
        }}
        className={`inline-flex items-center gap-1 min-h-6 text-[11px] font-display text-muted-foreground hover:text-foreground focus-visible:text-foreground transition ${className}`}
      >
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          className="w-3 h-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 14.5V2.5M4 3h7.5l-1.8 2.75L11.5 8.5H4" />
        </svg>
        Denunciar jogador
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur p-4"
            onClick={() => !sending && setOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="report-player-title"
              className="w-full max-w-xs rounded-3xl bg-card border border-white/10 shadow-pop p-4 flex flex-col gap-3 max-h-[90dvh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-center">
                <div className="text-3xl mb-1" aria-hidden>
                  🚩
                </div>
                <h3 id="report-player-title" className="font-display text-lg">
                  Denunciar jogador
                </h3>
                <p className="text-[11px] text-muted-foreground mt-1">
                  A moderação revisa o apelido e o que aconteceu na sala.
                </p>
              </div>

              {!done ? (
                <>
                  <fieldset className="flex flex-col gap-1">
                    <legend className="text-[11px] text-muted-foreground mb-1">
                      Quem?
                    </legend>
                    {others.map((p) => (
                      <label
                        key={p.id}
                        className="flex items-center gap-2 rounded-xl bg-input/60 px-3 py-2 text-sm cursor-pointer"
                      >
                        <input
                          type="radio"
                          name="report-player-target"
                          value={p.id}
                          checked={target === p.id}
                          onChange={() => setTarget(p.id)}
                          disabled={sending}
                        />
                        <span aria-hidden>{p.avatar}</span>
                        <span className="font-display truncate">
                          {p.nickname}
                        </span>
                      </label>
                    ))}
                  </fieldset>

                  <label
                    htmlFor="report-player-reason"
                    className="text-[11px] text-muted-foreground"
                  >
                    Motivo:
                  </label>
                  <select
                    id="report-player-reason"
                    value={reason}
                    onChange={(e) =>
                      setReason(e.target.value as PlayerReportReason)
                    }
                    disabled={sending}
                    className="bg-input rounded-xl px-3 py-2 text-sm border border-white/10"
                  >
                    {Object.entries(PLAYER_REPORT_REASONS).map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>

                  {error && (
                    <p role="alert" className="text-xs text-destructive">
                      {error}
                    </p>
                  )}

                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      disabled={sending}
                      className="btn-pop btn-plain border border-white/10 flex-1 text-sm"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={submit}
                      disabled={sending}
                      className="btn-pop bg-destructive text-destructive-foreground flex-1 text-sm"
                    >
                      {sending ? "Enviando…" : "Enviar"}
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-center text-mint text-sm py-2">
                  ✅ Obrigado! Denúncia registrada.
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
