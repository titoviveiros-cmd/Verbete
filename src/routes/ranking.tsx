import { APP_URL } from "@/lib/app-url";
import {
  createFileRoute,
  Link,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Mascot } from "@/components/Mascot";
import { useAuth } from "@/hooks/use-auth";

export const Route = createFileRoute("/ranking")({
  head: () => ({
    meta: [
      { title: "Ranking — Verbete" },
      {
        name: "description",
        content:
          "Veja os melhores jogadores do Verbete: pontuação total, partidas jogadas e vitórias.",
      },
      { property: "og:title", content: "Ranking — Verbete" },
      {
        property: "og:description",
        content: "Os melhores blefadores e adivinhadores do Verbete.",
      },
      { property: "og:url", content: `${APP_URL}/ranking` },
    ],
    links: [{ rel: "canonical", href: `${APP_URL}/ranking` }],
  }),
  component: RankingPage,
});

type Row = {
  user_id: string;
  total_score: number;
  games_played: number;
  games_won: number;
  best_match_score: number;
  profile?: { display_name: string; avatar: string; color: string } | null;
};

function RankingPage() {
  const nav = useNavigate();
  const search = useSearch({ strict: false }) as { from?: string };
  const fromProfile = search.from === "profile";
  const { user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      nav({ to: "/login" });
      return;
    }
    (async () => {
      const { data, error } = await supabase.rpc("get_ranking_top", {
        p_limit: 50,
      });
      if (error) {
        console.error("ranking error", error);
        setRows([]);
      } else {
        setRows(
          (data ?? []).map((r: any) => ({
            user_id: r.user_id,
            total_score: r.total_score,
            games_played: r.games_played,
            games_won: r.games_won,
            best_match_score: r.best_match_score,
            profile: {
              display_name: r.display_name,
              avatar: r.avatar,
              color: r.color,
            },
          })),
        );
      }
      setLoading(false);
    })();
  }, [user, authLoading, nav]);

  return (
    <div className="mobile-shell pt-4 gap-3 overflow-y-auto pb-8">
      <div className="flex items-center justify-between gap-2">
        <Link
          to={fromProfile ? "/profile" : "/"}
          className="btn-pop bg-card text-xs px-3 py-2 font-display flex items-center gap-1"
        >
          <span>←</span> {fromProfile ? "Voltar" : "Início"}
        </Link>
        <Link
          to="/profile"
          className="btn-pop bg-gradient-sun text-primary-foreground text-xs px-3 py-2 font-display flex items-center gap-1"
        >
          <span>👤</span> Meu perfil
        </Link>
      </div>
      <div className="text-center mt-2">
        <h1 className="font-display text-3xl mt-2 flex items-center justify-center gap-2">
          <span aria-hidden>🏆</span>
          <span>Ranking</span>
        </h1>
        <p className="font-display text-sm text-pink uppercase tracking-wider mt-1">
          Top 50
        </p>
        <p className="text-xs text-muted-foreground italic">
          pontos totais acumulados
        </p>
        <p className="text-[11px] text-muted-foreground mt-2 max-w-xs mx-auto leading-snug">
          ℹ️ Só jogadores com{" "}
          <span className="font-display text-foreground">conta</span> aparecem
          aqui. Quem joga como convidado pontua na partida, mas não acumula no
          ranking global.
        </p>
      </div>

      {loading ? (
        <div className="flex justify-center pt-8">
          <Mascot mood="thinking" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-8">
          Ninguém pontuou ainda. Seja o primeiro!
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r, i) => (
            <li
              key={r.user_id}
              className="sticker py-2 px-3 flex items-center gap-3 text-sm"
            >
              <span className="font-display w-8 text-center opacity-70">
                {i + 1}º
              </span>
              <span className="text-xl">{r.profile?.avatar ?? "🦊"}</span>
              <span className="font-display flex-1 truncate">
                {r.profile?.display_name ?? "Jogador"}
              </span>
              <div className="text-right">
                <div className="font-display text-primary">
                  {r.total_score} pts
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {r.games_won}V / {r.games_played}P
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
