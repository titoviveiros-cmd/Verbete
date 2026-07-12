import { useState } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "@tanstack/react-router";
import { getPlayerId, getStored, setStored } from "@/lib/player-id";
import { joinRoom } from "@/lib/room";
import { AVATARS, COLORS, randomAvatar, randomColor } from "@/lib/avatars";
import { sanitizeNickname } from "@/lib/text-filter";
import { Mascot } from "@/components/Mascot";
import { primeAudio, playUITap } from "@/lib/sound";

export function JoinFlow({ code, roomId, status }: { code: string; roomId: string; status: string }) {
  const nav = useNavigate();
  const playerId = typeof window !== "undefined" ? getPlayerId() : "";
  const [nick, setNick] = useState<string>(() => getStored("nick", ""));
  const [avatar, setAvatar] = useState<string>(() => getStored("avatar", randomAvatar()));
  const [color, setColor] = useState<string>(() => getStored("color", randomColor()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inGame = status !== "lobby" && status !== "finished";

  const handleJoin = async () => {
    void primeAudio();
    setError(null);
    const cleanNick = sanitizeNickname(nick);
    if (!cleanNick || cleanNick === "Anônimo") { setError("Escolha um apelido"); return; }
    setBusy(true);
    try {
      setStored("nick", cleanNick);
      setStored("avatar", avatar);
      setStored("color", color);
      // Otimismo: já injeta o jogador no estado local sem esperar o
      // round-trip do DB + echo de realtime (~500–1500ms). Se a inserção
      // falhar, o evento de remoção restaura a UI ao estado anterior.
      if (typeof window !== "undefined" && roomId) {
        window.dispatchEvent(
          new CustomEvent("player:optimistic-add", {
            detail: {
              roomId,
              player: {
                id: playerId,
                room_id: roomId,
                nickname: cleanNick,
                avatar,
                color,
                is_connected: true,
                is_bot: false,
                joined_at: new Date().toISOString(),
                score: 0,
              },
            },
          }),
        );
      }
      try {
        await joinRoom(code, playerId, cleanNick, avatar, color);
      } catch (e) {
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("player:optimistic-remove", { detail: { playerId } }),
          );
        }
        throw e;
      }
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="mobile-shell">
      <div className="text-center pt-4">
        <Mascot mood="excited" size={130} />
        <h1 className="font-display text-3xl mt-2">Você foi convidado!</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Código da Sala: <span className="font-display text-sun tracking-[0.3em]">{code}</span>
        </p>
        {inGame && (
          <p className="text-xs text-pink mt-2 font-display">
            ⚠ Partida já em andamento — você entrará no próximo lobby
          </p>
        )}
      </div>

      <div className="flex flex-col gap-4 mt-5">
        <div>
          <label className="text-xs uppercase tracking-wider text-muted-foreground font-display">Seu apelido</label>
          <input
            value={nick}
            onChange={(e) => setNick(e.target.value)}
            placeholder="Ex: Bia, Zé, Dudu..."
            maxLength={14}
            autoFocus
            className="w-full bg-input rounded-2xl px-4 py-4 text-xl font-display border border-white/10 outline-none focus:ring-4 focus:ring-pink/40"
          />
        </div>

        <div>
          <label className="text-xs uppercase tracking-wider text-muted-foreground font-display">Avatar</label>
          <div className="rounded-2xl bg-card p-3 border border-white/10 shadow-soft">
            <div className="flex justify-center mb-2">
              <motion.div
                key={avatar + color}
                initial={{ scale: 0.6, rotate: -20 }} animate={{ scale: 1, rotate: 0 }}
                className="rounded-full w-20 h-20 flex items-center justify-center text-4xl shadow-pop"
                style={{
                  background: `radial-gradient(circle at 30% 25%, ${color}cc, ${color})`,
                  border: "3px solid rgba(0,0,0,0.4)",
                }}
              >{avatar}</motion.div>
            </div>
            <div className="grid grid-cols-8 gap-1 mb-2">
              {AVATARS.map((a) => (
                <button key={a} onClick={() => setAvatar(a)}
                  aria-label={`Escolher avatar ${a}`}
                  aria-pressed={avatar === a}
                  className={"text-2xl rounded-lg p-1 transition " + (avatar === a ? "bg-pink/30 ring-2 ring-pink" : "hover:bg-white/5")}>
                  {a}
                </button>
              ))}
            </div>
            <div className="flex gap-2 justify-center">
              {COLORS.map((c) => (
                <button key={c} onClick={() => setColor(c)}
                  aria-label={`Escolher cor ${c}`}
                  aria-pressed={color === c}
                  className={"w-7 h-7 rounded-full border-2 " + (color === c ? "border-white scale-110" : "border-black/40")}
                  style={{ background: c }} />
              ))}
            </div>
          </div>
        </div>

        {error && <p className="text-destructive text-sm text-center font-display">{error}</p>}

        <div className="flex gap-2">
          <button onClick={() => { void playUITap("secondary"); nav({ to: "/" }); }} className="btn-pop bg-card flex-1">← Voltar</button>
          <button onClick={() => { void playUITap("primary"); handleJoin(); }} disabled={busy}
            className="btn-pop bg-gradient-fun text-white flex-[2] text-xl disabled:opacity-50">
            {busy ? "Entrando…" : "🎉 Entrar na sala"}
          </button>
        </div>
      </div>
    </div>
  );
}


