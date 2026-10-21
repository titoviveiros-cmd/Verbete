import { useState } from "react";
import { resumeRoom } from "@/lib/presence";

// Partida pausada (playtest 2026-10-21): todos os humanos saíram durante a
// escrita/votação, e a partida esperou em vez de punir e seguir sozinha.
// Qualquer jogador ativo da mesa retoma; ela também volta sozinha quando
// todos voltam ao app.
export function PausedBanner({
  roomId,
  playerId,
  canResume,
}: {
  roomId: string;
  playerId: string;
  canResume: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const onResume = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await resumeRoom(roomId, playerId);
      if (!res.ok) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    // No fluxo, logo abaixo da barra do topo: empurra a fase para baixo em
    // vez de cobrir a palavra da rodada (a fase rola; a pausa é passageira).
    <div role="status" data-paused-banner className="shrink-0 mt-2">
      <div className="panel mx-auto w-full max-w-md px-3.5 py-2.5 flex items-center gap-3">
        <span aria-hidden className="text-2xl leading-none">
          ⏸️
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-display text-base leading-tight">
            Partida pausada
          </p>
          <p className="text-xs text-muted-foreground leading-snug">
            {failed
              ? "Não deu para retomar agora. Tente de novo."
              : "Ninguém estava jogando. Placar e rodada estão guardados."}
          </p>
        </div>
        {canResume && (
          <button
            onClick={onResume}
            disabled={busy}
            className="btn-pop btn-gold !rounded-full !px-3.5 !py-2 text-sm shrink-0"
          >
            ▶ Continuar
          </button>
        )}
      </div>
    </div>
  );
}
