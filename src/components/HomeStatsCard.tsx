// Card compacto exibido na home quando o usuário está logado.
// Mostra streak, partidas, vitórias e recorde — só informação.
// ECA Digital (B6, 11/11/2026; Lei 15.211 art. 8º IV, D12880 art. 9º p.ú.):
// saíram o alerta "Sua streak está em risco!" (pressão por perda, com botão
// "Salvar") e o pulso infinito do 🔥. A sequência continua contando, sem
// cobrar volta.
import { useEffect, useState } from "react";
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

export function HomeStatsCard() {
  const { user, loading } = useAuth();
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    if (loading || !user) return;
    (async () => {
      const { data: s } = await supabase
        .from("user_stats")
        .select(
          "games_played, games_won, current_streak, best_streak, last_played_date",
        )
        .eq("user_id", user.id)
        .maybeSingle();
      setStats(s as Stats);
    })();
  }, [user, loading]);

  if (loading || !user) return null;
  // Quem acabou de chegar (sessão anônima, nada jogado) não vê um painel
  // de zeros: o cartão aparece a partir da 1ª partida ou streak.
  if (
    !stats ||
    ((stats.games_played ?? 0) === 0 && (stats.current_streak ?? 0) === 0)
  )
    return null;

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
          <div
            className="text-center min-w-[3rem] relative shrink-0"
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
          </div>
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
    </motion.div>
  );
}
