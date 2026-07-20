import { useState } from "react";
import { createPortal } from "react-dom";
import { useServerFn } from "@tanstack/react-start";
import { reportDefinition } from "@/lib/moderation.functions";
import { useAuth } from "@/hooks/use-auth";
import type { Definition, Player, Room } from "@/lib/room";

/**
 * Botão pequeno (🚩) que abre um mini-modal para denunciar uma definição.
 * Obrigatório para a Apple App Store (Guideline 1.2 — UGC moderation).
 */
export function ReportButton({
  definition,
  room,
  players,
  meId,
}: {
  definition: Definition;
  room: Room;
  players: Player[];
  meId: string;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<
    "inappropriate" | "spam" | "harassment" | "other"
  >("inappropriate");
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runReport = useServerFn(reportDefinition);

  // Não permite reportar a própria definição
  if (definition.player_id === meId) {
    return null;
  }

  // Definição verdadeira do dicionário: não pode ser reportada de verdade,
  // mas precisamos manter o comportamento visual idêntico ao das outras
  // (mesmo modal, mesmo fluxo, mesma confirmação) para não entregar qual é
  // a resposta correta.
  const isTruth = definition.is_truth || definition.player_id === "__truth__";

  const offender = players.find((p) => p.id === definition.player_id);

  const submit = async () => {
    if (!user) {
      setError("Faça login para reportar.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      if (isTruth) {
        // Simula o envio (sem chamar o servidor) para não revelar que
        // esta é a definição verdadeira.
        await new Promise((r) => setTimeout(r, 600));
      } else {
        await runReport({
          data: {
            definitionId: definition.id,
            definitionText: definition.text,
            roomId: room.id,
            roomCode: room.code,
            round: room.current_round,
            offenderPlayerId: definition.player_id,
            offenderNickname: offender?.nickname ?? null,
            reason,
          },
        });
      }

      setDone(true);
      setTimeout(() => setOpen(false), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao reportar.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
          setDone(false);
          setError(null);
        }}
        aria-label="Reportar definição"
        title="Reportar"
        className="opacity-40 hover:opacity-100 transition text-base shrink-0 px-1 py-0.5"
      >
        🚩
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur p-4"
            onClick={() => !sending && setOpen(false)}
          >
            <div
              className="w-full max-w-xs rounded-3xl bg-card border border-white/10 shadow-pop p-4 flex flex-col gap-3"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="text-center">
                <div className="text-3xl mb-1">🚩</div>
                <h3 className="font-display text-lg">Reportar definição</h3>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Nossa equipe vai revisar.
                </p>
              </div>

              <div className="rounded-xl bg-input/60 p-2 max-h-24 overflow-y-auto text-xs italic">
                "{definition.text}"
              </div>

              {!done ? (
                <>
                  <label className="text-[11px] text-muted-foreground">
                    Motivo:
                  </label>
                  <select
                    value={reason}
                    onChange={(e) => setReason(e.target.value as typeof reason)}
                    disabled={sending}
                    className="bg-input rounded-xl px-3 py-2 text-sm border border-white/10"
                  >
                    <option value="inappropriate">Conteúdo impróprio</option>
                    <option value="harassment">Assédio / ofensa pessoal</option>
                    <option value="spam">Spam / sem sentido</option>
                    <option value="other">Outro</option>
                  </select>

                  {error && <p className="text-xs text-destructive">{error}</p>}

                  <div className="flex gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => setOpen(false)}
                      disabled={sending}
                      className="btn-pop bg-card border border-white/10 flex-1 text-sm disabled:opacity-50"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={submit}
                      disabled={sending}
                      className="btn-pop bg-destructive text-destructive-foreground flex-1 text-sm disabled:opacity-50"
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
