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
  /** campeões do servidor; empate = todos */
  champions: Champion[];
  tie: boolean;
};

const str = (v: unknown, max = 40) =>
  typeof v === "string" ? v.slice(0, max) : "";
const int = (v: unknown) =>
  Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0;
const date = (v: unknown) =>
  typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;

export type Champion = { name: string; emoji: string; score: number };

/** Campeões decididos pelo SERVIDOR (empate = todos), lista fechada de campos. */
export function sanitizeChampions(v: unknown): Champion[] {
  return (Array.isArray(v) ? v : [])
    .map((x) => {
      const c = (x ?? {}) as Record<string, unknown>;
      return {
        name: str(c.name, 40),
        emoji: str(c.emoji, 16),
        score: int(c.score),
      };
    })
    .filter((c) => c.name.length > 0);
}

/** "Zé" · "Bia e Zé" · "Ana, Bia e Zé" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`;
}

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
  let champions = sanitizeChampions(r.champions);
  if (champions.length === 0)
    // retrato sem a lista: os 1º lugares do próprio retrato (também do servidor)
    champions =
      mode === "teams"
        ? teams
            .filter((t) => t.rank === 1)
            .map((t) => ({ name: t.name, emoji: t.emoji, score: t.score }))
        : players
            .filter((p) => p.rank === 1)
            .map((p) => ({
              name: p.nickname,
              emoji: p.avatar,
              score: p.score,
            }));
  return {
    mode,
    rounds: Math.max(0, int(r.rounds)),
    finishedAt: date(r.finished_at),
    expiresAt: date(r.expires_at),
    players,
    teams: mode === "teams" ? teams : [],
    champions,
    tie: champions.length > 1,
  };
}

// ---------------------------------------------------------------------------
// Botão: link preparado ao abrir a tela final; o clique só compartilha
// ---------------------------------------------------------------------------
export const SHARE_LINK_FAILED =
  "Não foi possível gerar o link do resultado agora — tente de novo em instantes.";
const REASON_NOTE: Record<string, string> = {
  not_shareable:
    "Esta partida foi encerrada automaticamente — não há resultado para compartilhar.",
  not_participant:
    "Só quem jogou esta partida até o fim pode compartilhar o resultado.",
  expired: "O link deste resultado já expirou.",
};

export type PreparedShare =
  | { ok: true; url: string; text: string }
  | { ok: false; note: string; retry: boolean };

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

/** Texto do compartilhamento SÓ com o que o servidor decidiu (empate incluso). */
export function shareTextFromChampions(champions: Champion[]): string {
  if (champions.length === 0)
    return "🏆 Veja o resultado da partida no Verbete:";
  const pts = champions[0]!.score;
  const quem = joinNames(champions.map((c) => c.name));
  return champions.length > 1
    ? `🤝 ${quem} empataram no Verbete com ${pts} pts! Veja o resultado da partida:`
    : `🏆 ${quem} venceu no Verbete com ${pts} pts! Veja o resultado da partida:`;
}

/** Resposta de create_match_share → link pronto (URL + texto do servidor) ou o motivo. */
export function prepareFromCreate(raw: unknown): PreparedShare {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (
    r.ok === true &&
    typeof r.token === "string" &&
    MATCH_SHARE_TOKEN_RE.test(r.token)
  )
    return {
      ok: true,
      url: matchShareUrl(r.token),
      text: shareTextFromChampions(sanitizeChampions(r.champions)),
    };
  const reason = typeof r.reason === "string" ? r.reason : "";
  const note = REASON_NOTE[reason];
  return note
    ? { ok: false, note, retry: false }
    : { ok: false, note: SHARE_LINK_FAILED, retry: true };
}

export async function prepareMatchShare(
  createShare: () => Promise<unknown>,
): Promise<PreparedShare> {
  try {
    return prepareFromCreate(await createShare());
  } catch {
    return { ok: false, note: SHARE_LINK_FAILED, retry: true };
  }
}

/**
 * Clique: com o link já preparado, chama o compartilhamento SEM esperar a rede
 * antes (o Safari/iOS exige o gesto do toque). Sem link preparado, prepara agora.
 */
export async function shareMatchResult(deps: {
  prepared: PreparedShare | null;
  createShare: () => Promise<unknown>;
  share: (opts: {
    title: string;
    text: string;
    url: string;
  }) => Promise<ShareOutcome>;
  onPrepared?: (p: PreparedShare) => void;
}): Promise<ShareResultState> {
  let p = deps.prepared;
  if (!p || (!p.ok && p.retry)) {
    p = await prepareMatchShare(deps.createShare);
    deps.onPrepared?.(p);
  }
  if (!p.ok) return { kind: "link_failed", url: null, note: p.note };
  const outcome = await deps.share({
    title: "Resultado no Verbete",
    text: p.text,
    url: p.url,
  });
  return shareResultNote(outcome, p.url);
}
