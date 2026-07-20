// Chat da sala (spec): lobby livre, desativado durante a rodada, liberado
// após o resultado. A regra de fase é validada server-side pela RPC
// send_room_message — aqui só refletimos o estado na UI. Mantém o próprio
// canal realtime (INSERTs de room_messages filtrados por room_id) para não
// mexer no canal principal do use-room.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import {
  CHAT_ENABLED_STATUSES,
  fetchRoomMessages,
  sendRoomMessage,
  type Player,
  type RoomMessage,
  type RoomStatus,
} from "@/lib/room";
import { playUITap } from "@/lib/sound";
import { scrollbarClip } from "@/lib/utils";

export function RoomChat({
  roomId,
  status,
  playerId,
  players,
}: {
  roomId: string;
  status: RoomStatus;
  playerId: string;
  players: Player[];
}) {
  const enabled = CHAT_ENABLED_STATUSES.includes(status);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [unread, setUnread] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
    if (open) setUnread(0);
  }, [open]);

  useEffect(() => {
    let alive = true;
    void fetchRoomMessages(roomId).then((ms) => {
      if (alive) setMessages(ms);
    });
    const ch = supabase
      .channel(`room-chat:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "room_messages",
          filter: `room_id=eq.${roomId}`,
        },
        (p) => {
          const msg = p.new as RoomMessage;
          setMessages((cur) =>
            cur.some((m) => m.id === msg.id) ? cur : [...cur, msg],
          );
          if (!openRef.current && msg.player_id !== playerId)
            setUnread((n) => n + 1);
        },
      )
      .subscribe();
    return () => {
      alive = false;
      void supabase.removeChannel(ch);
    };
  }, [roomId, playerId]);

  // Auto-scroll para a última mensagem
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setDraft("");
    const res = await sendRoomMessage(roomId, playerId, text);
    if (!res.ok && res.reason !== "rate_limited") setDraft(text);
    setSending(false);
  };

  const playerFor = (id: string) => players.find((p) => p.id === id);

  return (
    <>
      {/* Botão flutuante */}
      <button
        onClick={() => {
          void playUITap();
          setOpen((o) => !o);
        }}
        aria-label={open ? "Fechar chat" : "Abrir chat"}
        className="fixed z-[60] w-10 h-10 rounded-full bg-gradient-fun text-white text-base shadow-pop border-2 border-white/25 flex items-center justify-center"
        style={{
          // Playtest 5G: em 168px o balão cobria "Enviar definição". Menor
          // (40px) e no vão entre o toggle de reações (76px) e os CTAs.
          bottom: "calc(env(safe-area-inset-bottom, 0px) + 120px)",
          right: "calc(env(safe-area-inset-right, 0px) + 10px)",
        }}
      >
        💬
        {unread > 0 && !open && (
          <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-sun text-secondary-foreground text-[10px] font-display flex items-center justify-center border border-black/20">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            className="fixed z-[59] flex flex-col rounded-2xl bg-card/95 backdrop-blur-md border border-white/15 shadow-pop overflow-hidden"
            style={{
              // Logo acima do balão (que agora fica em 120–160px).
              bottom: "calc(env(safe-area-inset-bottom, 0px) + 168px)",
              right: "calc(env(safe-area-inset-right, 0px) + 12px)",
              width: "min(320px, calc(100vw - 24px))",
              height: "min(380px, 55vh)",
            }}
          >
            <div className="shrink-0 px-3 py-2 border-b border-white/10 flex items-center justify-between">
              <span className="font-display text-sm">💬 Chat da sala</span>
              <span className="text-[10px] text-muted-foreground font-display uppercase tracking-wider">
                {enabled ? "ao vivo" : "pausado na rodada"}
              </span>
            </div>

            <div
              ref={listRef}
              className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-3 py-2 space-y-1.5"
              style={scrollbarClip("0.75rem")}
            >
              {messages.length === 0 && (
                <p className="text-center text-xs text-muted-foreground italic pt-6">
                  Nenhuma mensagem ainda — puxa assunto! 😄
                </p>
              )}
              {messages.map((m) => {
                const p = playerFor(m.player_id);
                const mine = m.player_id === playerId;
                const avatar = (
                  <span
                    className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-base border border-white/20"
                    style={{
                      background: p?.color
                        ? `${p.color}33`
                        : "rgba(255,255,255,0.08)",
                    }}
                    title={p?.nickname}
                  >
                    {p?.avatar ?? "👤"}
                  </span>
                );
                return (
                  <div
                    key={m.id}
                    className={
                      "flex items-end gap-1.5 " +
                      (mine ? "justify-end" : "justify-start")
                    }
                  >
                    {!mine && avatar}
                    <div
                      className={
                        "max-w-[78%] rounded-2xl px-2.5 py-1.5 text-sm leading-snug " +
                        (mine
                          ? "bg-pink/25 border border-pink/30"
                          : "bg-white/8 border border-white/10")
                      }
                    >
                      {!mine && (
                        <span className="block text-[10px] font-display text-sun leading-none mb-0.5">
                          {p?.nickname ?? "Jogador"}
                        </span>
                      )}
                      <span className="break-words">{m.text}</span>
                    </div>
                    {mine && avatar}
                  </div>
                );
              })}
            </div>

            <div className="shrink-0 p-2 border-t border-white/10">
              {enabled ? (
                <form
                  className="flex gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                  }}
                >
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    maxLength={200}
                    placeholder="Mensagem…"
                    className="flex-1 min-w-0 bg-input rounded-xl px-3 py-2 text-sm border border-white/10 outline-none focus:ring-2 focus:ring-pink/40"
                  />
                  <button
                    type="submit"
                    disabled={sending || !draft.trim()}
                    className="shrink-0 w-10 h-10 rounded-xl bg-gradient-fun text-white font-display disabled:opacity-40"
                    aria-label="Enviar mensagem"
                  >
                    ➤
                  </button>
                </form>
              ) : (
                <p className="text-center text-[11px] text-muted-foreground font-display py-1.5">
                  🤫 Chat pausado durante a rodada — volta na revelação!
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default RoomChat;
