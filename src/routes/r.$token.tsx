import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Mascot } from "@/components/Mascot";
import { APP_URL } from "@/lib/app-url";
import {
  MATCH_SHARE_TOKEN_RE,
  joinNames,
  sanitizeMatchShare,
  type MatchShare,
  type SharedPlayer,
} from "@/lib/match-share";

// Resultado compartilhado de uma partida (09/11/2026): página pública, só
// leitura, sem login. O retrato foi montado pelo servidor no fim da partida;
// a sala pode já ter sido apagada. Nada de e-mail, ids ou código da sala.
export const Route = createFileRoute("/r/$token")({
  head: () => ({
    meta: [
      { title: "Resultado da partida — Verbete" },
      { name: "robots", content: "noindex,nofollow" },
      {
        name: "description",
        content:
          "Veja quem venceu esta partida de Verbete — o jogo de blefe com palavras raras.",
      },
      { property: "og:title", content: "Resultado de uma partida no Verbete" },
      {
        property: "og:description",
        content:
          "Veja o pódio e a pontuação final. Blefe, vote e descubra palavras raras.",
      },
      { property: "og:url", content: `${APP_URL}/` },
    ],
  }),
  component: SharedResultPage,
});

type Estado =
  | { kind: "loading" }
  | { kind: "ok"; data: MatchShare }
  | { kind: "missing" }
  | { kind: "error" };

const PODIUM = [
  {
    place: 2,
    idx: 1,
    h: 78,
    medal: "🥈",
    tone: "#C0C0C0",
    block: "podium-silver",
  },
  {
    place: 1,
    idx: 0,
    h: 124,
    medal: "👑",
    tone: "#f4c542",
    block: "podium-gold",
  },
  {
    place: 3,
    idx: 2,
    h: 58,
    medal: "🥉",
    tone: "#CD7F32",
    block: "podium-bronze",
  },
];

function SharedResultPage() {
  const { token } = Route.useParams();
  const [estado, setEstado] = useState<Estado>({ kind: "loading" });

  useEffect(() => {
    if (!MATCH_SHARE_TOKEN_RE.test(token)) {
      setEstado({ kind: "missing" });
      return;
    }
    let vivo = true;
    (async () => {
      try {
        const { supabase } = await import("@/integrations/supabase/client");
        const { data, error } = await supabase.rpc("get_match_share", {
          p_token: token,
        });
        if (!vivo) return;
        if (error) return setEstado({ kind: "error" });
        const s = sanitizeMatchShare(data);
        setEstado(s ? { kind: "ok", data: s } : { kind: "missing" });
      } catch {
        if (vivo) setEstado({ kind: "error" });
      }
    })();
    return () => {
      vivo = false;
    };
  }, [token]);

  if (estado.kind === "loading") {
    return (
      <div className="mobile-shell items-center justify-center">
        <Mascot mood="thinking" />
      </div>
    );
  }
  if (estado.kind !== "ok") {
    return (
      <div className="mobile-shell items-center justify-center gap-3 text-center px-6">
        <Mascot mood="sad" size={84} />
        <h1 className="font-display text-2xl">
          {estado.kind === "missing"
            ? "Resultado indisponível"
            : "Não foi possível carregar"}
        </h1>
        <p className="text-sm text-muted-foreground max-w-xs">
          {estado.kind === "missing"
            ? "Este link não existe ou já expirou — os resultados compartilhados ficam disponíveis por 30 dias."
            : "Tente de novo em instantes."}
        </p>
        <Link to="/" className="btn-pop btn-gold text-base px-6 py-3">
          Jogar Verbete 🎉
        </Link>
      </div>
    );
  }

  const d = estado.data;
  const ranking = d.players;
  const top: Array<SharedPlayer | undefined> = [
    ranking[0],
    ranking[1],
    ranking[2],
  ];
  const validade = d.expiresAt
    ? new Date(d.expiresAt).toLocaleDateString("pt-BR")
    : null;

  return (
    <div
      className="mobile-shell stage-wide pt-4 gap-4 overflow-y-auto pb-8"
      data-testid="shared-result"
    >
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[1.1fr_0.9fr] lg:gap-8 lg:items-start">
        <div className="flex flex-col gap-3 min-w-0">
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: -6 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 220, damping: 16 }}
            className="relative flex flex-col items-center text-center pt-1"
          >
            <Mascot mood="excited" size={64} className="relative -mb-1" />
            <p className="eyebrow">
              Resultado da partida
              {d.rounds > 0
                ? ` · ${d.rounds} ${d.rounds === 1 ? "rodada" : "rodadas"}`
                : ""}
            </p>
            {d.champions.length > 0 && (
              <h1 className="font-display text-[34px] lg:text-[44px] leading-tight mt-1">
                {d.mode === "teams" && !d.tie && d.champions[0]!.emoji ? (
                  <span className="mr-1">{d.champions[0]!.emoji}</span>
                ) : null}
                <span className="text-gold-grad">
                  {d.tie
                    ? `Empate! ${joinNames(d.champions.map((c) => c.name))}`
                    : `${d.champions[0]!.name} venceu!`}
                </span>
              </h1>
            )}
            {d.champions.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {d.champions[0]!.score} pts
                {d.mode === "teams" ? " somando a equipe" : ""}
                {d.tie ? " cada" : ""}
              </p>
            )}
          </motion.div>

          <div className="flex items-end justify-center gap-2.5 px-4 mt-1 border-b-2 border-[var(--c-line)]">
            {PODIUM.filter((x) => !!top[x.idx]).map(
              ({ place, idx, h, medal, tone, block }) => {
                const p = top[idx]!;
                return (
                  <div
                    key={place}
                    className="flex flex-col items-center flex-1 max-w-[132px] lg:max-w-[160px] min-w-0"
                  >
                    <span
                      className={
                        "leading-none mb-1 " +
                        (place === 1 ? "text-4xl" : "text-2xl")
                      }
                      aria-hidden
                    >
                      {medal}
                    </span>
                    <span
                      className={
                        "rounded-full flex items-center justify-center " +
                        (place === 1
                          ? "w-[72px] h-[72px] text-4xl"
                          : "w-14 h-14 text-3xl")
                      }
                      style={{
                        background: p.color
                          ? `radial-gradient(circle at 30% 25%, ${p.color}cc, ${p.color})`
                          : undefined,
                        boxShadow: `0 0 0 3px ${tone}, 0 0 22px -2px ${tone}aa, 0 4px 0 rgb(0 0 0 / 0.35)`,
                      }}
                    >
                      {p.avatar}
                    </span>
                    <span
                      className="font-display text-sm mt-1.5 w-full text-center truncate"
                      style={{ color: tone }}
                    >
                      {p.nickname}
                    </span>
                    <span className="font-display text-xl tabular-nums leading-none">
                      {p.score}
                      <span className="text-xs text-muted-foreground">
                        {" "}
                        pts
                      </span>
                    </span>
                    <div
                      className={
                        "podium-block w-full mt-2 flex items-start justify-center pt-1.5 " +
                        block
                      }
                      style={{ height: h }}
                    >
                      <span className="font-display text-xl">{p.rank}º</span>
                    </div>
                  </div>
                );
              },
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3 min-w-0">
          {d.mode === "teams" && (
            <div className="sticker !py-2.5">
              <p className="eyebrow text-center mb-1.5">Ranking por equipe</p>
              <ul className="space-y-1">
                {d.teams.map((t, i) => (
                  <li
                    key={`${t.name}-${i}`}
                    className="flex items-center gap-2 px-2"
                  >
                    <span className="font-display text-sm w-5 text-center text-sun">
                      {t.rank}
                    </span>
                    <span className="text-base">{t.emoji}</span>
                    <span
                      className="font-display text-sm flex-1 truncate"
                      style={{ color: t.color || undefined }}
                    >
                      {t.name}
                    </span>
                    <span className="font-display text-sm tabular-nums">
                      {t.score} pts
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="sticker !py-2.5">
            <p className="eyebrow text-center mb-1.5">Pontuação final</p>
            <ul className="space-y-1.5">
              {ranking.map((p, i) => (
                <li
                  key={`${p.nickname}-${i}`}
                  className="flex items-center gap-2.5 px-2 text-sm"
                >
                  <span className="font-display w-6 text-center tabular-nums text-muted-foreground">
                    {p.rank}º
                  </span>
                  <span className="text-xl">{p.avatar}</span>
                  <span className="flex-1 truncate font-display">
                    {p.nickname}
                    {p.bot ? (
                      <span className="text-muted-foreground text-xs">
                        {" "}
                        🤖 robô
                      </span>
                    ) : null}
                    {p.team ? (
                      <span className="text-muted-foreground text-xs">
                        {" "}
                        · {p.team}
                      </span>
                    ) : null}
                  </span>
                  <span className="font-display text-lg tabular-nums">
                    {p.score}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <Link to="/" className="btn-pop btn-gold text-lg py-3 text-center">
            Jogar Verbete 🎉
          </Link>
          {validade && (
            <p className="text-[11px] text-muted-foreground text-center">
              Resultado compartilhado — disponível até {validade}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
