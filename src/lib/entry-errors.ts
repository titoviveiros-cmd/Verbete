import { SESSION_REQUIRED_MESSAGE } from "@/lib/auth-session";

// Erro ao criar ou entrar numa sala → texto para o jogador. No playtest de
// 2026-10-21 o erro cru do banco ("duplicate key value violates unique
// constraint players_pkey") chegou à tela. Mensagem do banco NUNCA aparece:
// só textos nossos, por lista de motivos conhecidos.
const BANNED =
  "Esta conta ou dispositivo foi banido por violar as regras da comunidade.";

const KNOWN: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /room_not_found|Sala não encontrada/i,
    "Sala não encontrada. Confira o código.",
  ],
  [/player_banned|banido/i, BANNED],
  [/session_required|sessão de jogo/i, SESSION_REQUIRED_MESSAGE],
  [/sala pública/i, "Não foi possível encontrar uma sala pública."],
  [
    /failed to fetch|networkerror|network request failed|load failed/i,
    "Sem conexão. Confira a internet e tente de novo.",
  ],
];

const FALLBACK = {
  create: "Não deu para criar a sala agora. Tente de novo.",
  join: "Não deu para entrar na sala agora. Tente de novo.",
} as const;

export function friendlyEntryError(
  e: unknown,
  action: keyof typeof FALLBACK,
): string {
  const msg =
    e && typeof e === "object" && "message" in e
      ? String((e as { message: unknown }).message ?? "")
      : String(e ?? "");
  for (const [re, text] of KNOWN) if (re.test(msg)) return text;
  return FALLBACK[action];
}
