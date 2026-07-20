// Card compacto exibido na home quando o usuário está logado.
// Mostra streak (animado), partidas, vitórias e alerta de "perca hoje"
// quando o jogador tem streak ativa mas ainda não jogou o desafio desta hora.
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";

type Stats = {
  games_played: number;
  games_won: number;
  current_streak: number;
  best_streak: number;
  last_played_date: string | null;
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function HomeStatsCard() {
  const { user, loading } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);
  const [playedThisHour, setPlayedThisHour] = useState(false);

  useEffect(() => {
    if (loading || !user) return;
    const hour = (() => {
      const d = new Date();
      d.setMinutes(0, 0, 0);
      return d.toISOString();
    })();
    (async () => {
      const [{ data: s }, { data: a }] = await Promise.all([
        supabase
          .from("user_stats")
          .select(
            "games_played, games_won, current_streak, best_streak, last_played_date",
          )
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase
          .from("daily_attempts")
          .select("id")
          .eq("user_id", user.id)
          .eq("challenge_hour", hour)
          .maybeSingle(),
      ]);
      setStats(s as Stats);
      setPlayedThisHour(!!a);
    })();
  }, [user, loading]);

  // Streak em risco: tem streak > 0, último jogo foi antes de hoje e ainda
  // não jogou nesta hora. Mostramos um alerta amigável e CTA forte.
  const atRisk = useMemo(() => {
    if (!stats) return false;
    if ((stats.current_streak ?? 0) <= 0) return false;
    if (playedThisHour) return false;
    const last = stats.last_played_date;
    if (!last) return true;
    return last < todayISO();
  }, [stats, playedThisHour]);

  if (loading || !user) return null;

  const streak = stats?.current_streak ?? 0;
  const games = stats?.games_played ?? 0;
  const wins = stats?.games_won ?? 0;
  const best = stats?.best_streak ?? 0;

  return (
    <motion.div
      initial={{ y: 12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="flex flex-col gap-2"
    >
      <div className="sticker bg-card/80 backdrop-blur py-3 px-3 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <motion.div
            className="text-center min-w-[3rem] relative shrink-0"
            animate={streak > 0 ? { scale: [1, 1.08, 1] } : {}}
            transition={{
              duration: 1.6,
              repeat: streak > 0 ? Infinity : 0,
              ease: "easeInOut",
            }}
            aria-label={`Streak atual ${streak} dias`}
          >
            {streak > 0 && (
              <span
                aria-hidden
                className="absolute inset-0 -m-1 rounded-full blur-md opacity-60"
                style={{
                  background:
                    "radial-gradient(circle, rgba(255,140,40,0.7) 0%, transparent 70%)",
                }}
              />
            )}
            <div className="relative text-2xl leading-none">🔥</div>
            <div className="relative font-display text-xl leading-tight text-sun">
              {streak}
            </div>
            <div className="relative text-[9px] uppercase tracking-wider text-muted-foreground">
              streak
            </div>
          </motion.div>
          <div className="flex-1 grid grid-cols-3 gap-1 text-center min-w-0">
            <div className="min-w-0">
              <div className="font-display text-lg leading-none text-primary">
                {games}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground truncate">
                jogos
              </div>
            </div>
            <div className="min-w-0">
              <div className="font-display text-lg leading-none text-mint">
                {wins}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground truncate">
                vitórias
              </div>
            </div>
            <div className="min-w-0">
              <div className="font-display text-lg leading-none text-pink">
                {best}
              </div>
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground truncate">
                recorde
              </div>
            </div>
          </div>
        </div>
      </div>

      {atRisk && (
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          role="alert"
          className="sticker bg-gradient-to-r from-red-500/20 to-orange-500/20 border border-red-500/40 py-2 px-3 flex items-center gap-2"
        >
          <motion.span
            aria-hidden
            animate={{ rotate: [-8, 8, -8] }}
            transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
            className="text-xl"
          >
            ⚠️
          </motion.span>
          <div className="flex-1 text-xs leading-tight">
            <p className="font-display text-sm text-foreground">
              Sua streak está em risco!
            </p>
            <p className="text-muted-foreground">
              Jogue uma rodada hoje para manter os {streak} 🔥
            </p>
          </div>
          <Link
            to="/daily"
            className="btn-pop bg-gradient-fun text-white text-xs py-1.5 px-3"
            aria-label="Manter streak jogando agora"
          >
            Salvar
          </Link>
        </motion.div>
      )}
    </motion.div>
  );
}
