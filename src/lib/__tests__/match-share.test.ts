// Resultado compartilhado: link do RESULTADO (não da Home), retrato saneado,
// desfechos do botão distintos e reaproveitamento do link.
import { describe, expect, it, vi } from "vitest";
import {
  MATCH_SHARE_TOKEN_RE,
  SHARE_LINK_FAILED,
  matchShareUrl,
  sanitizeMatchShare,
  shareMatchResult,
  shareResultNote,
  shareTokenFromSearch,
  shareUrlFromCreate,
} from "../match-share";
import { APP_URL, CANONICAL_APP_URL } from "../app-url";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("link público do resultado", () => {
  it("é específico da partida e usa o domínio canônico (nunca a Home, localhost ou URL de versão)", () => {
    const url = matchShareUrl(TOKEN);
    expect(url).toBe(`${APP_URL}/?r=${TOKEN}`);
    expect(url).not.toBe(`${APP_URL}/`);
    expect(APP_URL).toBe(CANONICAL_APP_URL);
    expect(url).not.toMatch(
      /localhost|127\.0\.0\.1|-jogo\.verbete\.workers\.dev/,
    );
  });
  it("token: exatamente 32 hex minúsculos", () => {
    expect(MATCH_SHARE_TOKEN_RE.test(TOKEN)).toBe(true);
    for (const bad of [
      "",
      TOKEN.toUpperCase(),
      TOKEN + "0",
      "1234",
      "../x",
      `${TOKEN.slice(0, 31)}g`,
    ])
      expect(MATCH_SHARE_TOKEN_RE.test(bad)).toBe(false);
  });
  it("Home: ?r= só vira redirecionamento com token válido", () => {
    expect(shareTokenFromSearch(`?r=${TOKEN}`)).toBe(TOKEN);
    expect(shareTokenFromSearch(`?join=1234&r=${TOKEN}`)).toBe(TOKEN);
    expect(shareTokenFromSearch("?r=1234")).toBeNull();
    expect(shareTokenFromSearch("?join=1234")).toBeNull();
    expect(shareTokenFromSearch("")).toBeNull();
  });
  it("resposta do servidor → URL só com ok:true e token válido", () => {
    expect(shareUrlFromCreate({ ok: true, token: TOKEN })).toBe(
      matchShareUrl(TOKEN),
    );
    expect(
      shareUrlFromCreate({ ok: false, reason: "not_participant" }),
    ).toBeNull();
    expect(shareUrlFromCreate({ ok: true, token: "x" })).toBeNull();
    expect(shareUrlFromCreate(null)).toBeNull();
  });
});

describe("retrato saneado (lista fechada de campos)", () => {
  const RAW = {
    v: 1,
    mode: "solo",
    rounds: 3,
    finished_at: "2026-11-08T19:00:00Z",
    expires_at: "2026-12-08T19:00:00Z",
    players: [
      {
        rank: 1,
        nickname: "Zé",
        avatar: "🐸",
        color: "#06D6A0",
        score: 15,
        bot: false,
        team: null,
        user_id: "u-1",
        email: "x@y.z",
      },
      {
        rank: 2,
        nickname: "Robô Lu",
        avatar: "🤖",
        color: "#111",
        score: 12,
        bot: true,
        team: null,
      },
    ],
    teams: [],
    room_code: "1234",
  };
  it("só os campos previstos; nada de e-mail, user_id ou código", () => {
    const s = sanitizeMatchShare(RAW)!;
    expect(s.champion).toEqual({
      name: "Zé",
      emoji: "🐸",
      score: 15,
      kind: "player",
    });
    expect(Object.keys(s.players[0]!).sort()).toEqual([
      "avatar",
      "bot",
      "color",
      "nickname",
      "rank",
      "score",
      "team",
    ]);
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/user_id|email|x@y\.z|room_code|1234/);
  });
  it("equipes: campeã é a equipe", () => {
    const s = sanitizeMatchShare({
      ...RAW,
      mode: "teams",
      teams: [
        {
          rank: 1,
          name: "Corujas",
          emoji: "🦉",
          color: "#111",
          score: 13,
          members: 2,
        },
        {
          rank: 2,
          name: "Raposas",
          emoji: "🦊",
          color: "#222",
          score: 11,
          members: 2,
        },
      ],
    })!;
    expect(s.mode).toBe("teams");
    expect(s.champion).toEqual({
      name: "Corujas",
      emoji: "🦉",
      score: 13,
      kind: "team",
    });
  });
  it("vazio/inválido = indisponível", () => {
    expect(sanitizeMatchShare(null)).toBeNull();
    expect(sanitizeMatchShare({ players: [] })).toBeNull();
    expect(sanitizeMatchShare("x")).toBeNull();
  });
});

describe("botão Compartilhar resultado", () => {
  const base = () => ({
    cachedUrl: null as string | null,
    createShare: vi.fn(async () => ({ ok: true, token: TOKEN })),
    share: vi.fn(async () => "shared" as const),
    champion: "Zé",
    points: 15,
  });
  it("envia o link DO RESULTADO com o texto do campeão", async () => {
    const d = base();
    const r = await shareMatchResult(d);
    expect(d.share).toHaveBeenCalledWith({
      title: "Resultado no Verbete",
      text: "🏆 Zé venceu no Verbete com 15 pts! Veja o resultado da partida:",
      url: matchShareUrl(TOKEN),
    });
    expect(r).toEqual({
      kind: "shared",
      url: matchShareUrl(TOKEN),
      note: "Resultado compartilhado! ✅",
    });
  });
  it.each([
    ["shared", "shared", "Resultado compartilhado! ✅"],
    ["copied", "copied", "Link do resultado copiado! ✅"],
    ["dismissed", "dismissed", "Compartilhamento cancelado."],
    [
      "failed",
      "failed",
      "Não deu para abrir o compartilhamento. Copie o link do resultado:",
    ],
  ] as const)("desfecho %s é distinto", (outcome, kind, note) => {
    expect(shareResultNote(outcome, "u")).toEqual({ kind, url: "u", note });
  });
  it("cliques repetidos reaproveitam o link (não pedem outro)", async () => {
    const d = { ...base(), cachedUrl: matchShareUrl(TOKEN) };
    await shareMatchResult(d);
    expect(d.createShare).not.toHaveBeenCalled();
  });
  it("servidor recusou ou caiu: NÃO compartilha a Home; mensagem de falha do link", async () => {
    for (const createShare of [
      vi.fn(async () => ({ ok: false, reason: "not_participant" })),
      vi.fn(async () => {
        throw new Error("rede");
      }),
    ]) {
      const d = { ...base(), createShare };
      const r = await shareMatchResult(d);
      expect(r).toEqual({
        kind: "link_failed",
        url: null,
        note: SHARE_LINK_FAILED,
      });
      expect(d.share).not.toHaveBeenCalled();
    }
  });
});
