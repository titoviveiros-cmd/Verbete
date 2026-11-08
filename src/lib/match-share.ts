// Resultado compartilhado (09/11/2026). O botão "Compartilhar resultado" do fim
// de partida mandava ${APP_URL}/ (a Home). Agora:
//  * o SERVIDOR monta o retrato do resultado (create_match_share) e devolve um
//    token aleatório; o navegador nunca informa pontos nem nomes;
//  * o link público é ${APP_URL}/?r=<token> — no APK 2.1.4 instalado (que
//    captura links do domínio e não tem a página nova) ele abre a Home, sem
//    tela de erro; no site e no app novo a Home leva a /r/<token>;
//  * quem recebe vê o resultado sem login (get_match_share), por 30 dias.
import { APP_URL } from "./app-url";
import type { ShareOutcome } from "./share";

export const MATCH_SHARE_TOKEN_RE = /^[0-9a-f]{32}$/;

/** Link público canônico (nunca localhost nem a URL temporária de versão). */
export function matchShareUrl(token: string): string {
  return `${APP_URL}/?r=${token}`;
}

/** Token do parâmetro ?r= da Home, só se tiver o formato exato. */
export function shareTokenFromSearch(search: string): string | null {
  try {
    const t = new URLSearchParams(search).get("r") ?? "";
    return MATCH_SHARE_TOKEN_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Retrato (lista FECHADA de campos; o resto que vier é descartado)
// ---------------------------------------------------------------------------
export type SharedPlayer = {
  rank: number;
  nickname: string;
  avatar: string;
  color: string;
  score: number;
  bot: boolean;
  team: string | null;
};
export type SharedTeam = {
  rank: number;
  name: string;
  emoji: string;
  color: string;
  score: number;
  members: number;
};
export type MatchShare = {
  mode: "solo" | "teams";
  rounds: number;
  finishedAt: string | null;
  expiresAt: string | null;
  players: SharedPlayer[];
  teams: SharedTeam[];
  champion: {
    name: string;
    emoji: string;
    score: number;
    kind: "player" | "team";
  } | null;
};

const str = (v: unknown, max = 40) =>
  typeof v === "string" ? v.slice(0, max) : "";
const int = (v: unknown) =>
  Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0;
const date = (v: unknown) =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;

export function sanitizeMatchShare(raw: unknown): MatchShare | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const players: SharedPlayer[] = (
    Array.isArray(r.players) ? r.players : []
  ).map((x) => {
    const p = (x ?? {}) as Record<string, unknown>;
    return {
      rank: Math.max(1, int(p.rank)),
      nickname: str(p.nickname, 24) || "Jogador",
      avatar: str(p.avatar, 16) || "🦊",
      color: str(p.color, 32),
      score: int(p.score),
      bot: p.bot === true,
      team: typeof p.team === "string" ? p.team.slice(0, 40) : null,
    };
  });
  const teams: SharedTeam[] = (Array.isArray(r.teams) ? r.teams : []).map(
    (x) => {
      const t = (x ?? {}) as Record<string, unknown>;
      return {
        rank: Math.max(1, int(t.rank)),
        name: str(t.name, 40) || "Equipe",
        emoji: str(t.emoji, 16),
        color: str(t.color, 32),
        score: int(t.score),
        members: Math.max(0, int(t.members)),
      };
    },
  );
  if (players.length === 0) return null;
  const mode = r.mode === "teams" && teams.length > 0 ? "teams" : "solo";
  const top = mode === "teams" ? teams[0] : players[0];
  return {
    mode,
    rounds: Math.max(0, int(r.rounds)),
    finishedAt: date(r.finished_at),
    expiresAt: date(r.expires_at),
    players,
    teams: mode === "teams" ? teams : [],
    champion: top
      ? mode === "teams"
        ? {
            name: (top as SharedTeam).name,
            emoji: (top as SharedTeam).emoji,
            score: top.score,
            kind: "team",
          }
        : {
            name: (top as SharedPlayer).nickname,
            emoji: (top as SharedPlayer).avatar,
            score: top.score,
            kind: "player",
          }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Botão: cria (ou reaproveita) o link e chama o compartilhamento
// ---------------------------------------------------------------------------
export const SHARE_LINK_FAILED =
  "Não foi possível gerar o link do resultado agora — tente de novo em instantes.";

export type ShareResultState =
  | { kind: "shared"; url: string; note: string }
  | { kind: "copied"; url: string; note: string }
  | { kind: "dismissed"; url: string; note: string }
  | { kind: "failed"; url: string; note: string }
  | { kind: "link_failed"; url: null; note: string };

export function shareResultNote(
  outcome: ShareOutcome,
  url: string,
): ShareResultState {
  switch (outcome) {
    case "shared":
      return { kind: "shared", url, note: "Resultado compartilhado! ✅" };
    case "copied":
      return { kind: "copied", url, note: "Link do resultado copiado! ✅" };
    case "dismissed":
      return { kind: "dismissed", url, note: "Compartilhamento cancelado." };
    default:
      return {
        kind: "failed",
        url,
        note: "Não deu para abrir o compartilhamento. Copie o link do resultado:",
      };
  }
}

/** Resposta de create_match_share → URL pública, ou null (sem link). */
export function shareUrlFromCreate(raw: unknown): string | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (
    r.ok !== true ||
    typeof r.token !== "string" ||
    !MATCH_SHARE_TOKEN_RE.test(r.token)
  )
    return null;
  return matchShareUrl(r.token);
}

export async function shareMatchResult(deps: {
  /** URL já gerada nesta tela (cliques repetidos não pedem outro link) */
  cachedUrl: string | null;
  createShare: () => Promise<unknown>;
  share: (opts: {
    title: string;
    text: string;
    url: string;
  }) => Promise<ShareOutcome>;
  champion: string;
  points: number;
}): Promise<ShareResultState> {
  let url = deps.cachedUrl;
  if (!url) {
    try {
      url = shareUrlFromCreate(await deps.createShare());
    } catch {
      url = null;
    }
  }
  if (!url) return { kind: "link_failed", url: null, note: SHARE_LINK_FAILED };
  const outcome = await deps.share({
    title: "Resultado no Verbete",
    text: `🏆 ${deps.champion} venceu no Verbete com ${deps.points} pts! Veja o resultado da partida:`,
    url,
  });
  return shareResultNote(outcome, url);
}
