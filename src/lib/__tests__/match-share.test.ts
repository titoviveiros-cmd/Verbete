// Resultado compartilhado: link do RESULTADO (não da Home), retrato saneado,
// campeões/empate do SERVIDOR, desfechos do botão distintos e link preparado.
import { describe, expect, it, vi } from "vitest";
import {
  MATCH_SHARE_TOKEN_RE,
  SHARE_LINK_FAILED,
  joinNames,
  matchShareUrl,
  prepareFromCreate,
  sanitizeMatchShare,
  shareMatchResult,
  shareResultNote,
  shareTextFromChampions,
  shareTokenFromSearch,
  type PreparedShare,
} from "../match-share";
import { APP_URL, CANONICAL_APP_URL } from "../app-url";

const TOKEN = "0123456789abcdef0123456789abcdef";
const ZE = { name: "Zé", emoji: "🐸", score: 15 };

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
});

describe("texto do compartilhamento: SÓ com o que o servidor decidiu (Red Team B)", () => {
  it("campeão único, empate e sem dados", () => {
    expect(shareTextFromChampions([ZE])).toBe(
      "🏆 Zé venceu no Verbete com 15 pts! Veja o resultado da partida:",
    );
    expect(shareTextFromChampions([{ ...ZE, name: "Bia" }, ZE])).toBe(
      "🤝 Bia e Zé empataram no Verbete com 15 pts! Veja o resultado da partida:",
    );
    expect(shareTextFromChampions([])).toBe(
      "🏆 Veja o resultado da partida no Verbete:",
    );
    expect(joinNames(["Ana", "Bia", "Zé"])).toBe("Ana, Bia e Zé");
  });
  it("resposta do servidor → link pronto com o texto; motivos com mensagem própria (Red Team E)", () => {
    expect(
      prepareFromCreate({ ok: true, token: TOKEN, champions: [ZE] }),
    ).toEqual({
      ok: true,
      url: matchShareUrl(TOKEN),
      text: "🏆 Zé venceu no Verbete com 15 pts! Veja o resultado da partida:",
    });
    expect(prepareFromCreate({ ok: false, reason: "not_shareable" })).toEqual({
      ok: false,
      retry: false,
      note: "Esta partida foi encerrada automaticamente — não há resultado para compartilhar.",
    });
    expect(
      prepareFromCreate({ ok: false, reason: "not_participant" }),
    ).toMatchObject({ ok: false, retry: false });
    expect(prepareFromCreate({ ok: false, reason: "expired" })).toMatchObject({
      ok: false,
      retry: false,
    });
    expect(prepareFromCreate({ ok: true, token: "x" })).toEqual({
      ok: false,
      retry: true,
      note: SHARE_LINK_FAILED,
    });
    expect(prepareFromCreate(null)).toEqual({
      ok: false,
      retry: true,
      note: SHARE_LINK_FAILED,
    });
  });
});

describe("retrato saneado (lista fechada de campos)", () => {
  const RAW = {
    v: 2,
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
    champions: [{ name: "Zé", emoji: "🐸", score: 15, user_id: "u-1" }],
    room_code: "1234",
  };
  it("só os campos previstos; nada de e-mail, user_id ou código", () => {
    const s = sanitizeMatchShare(RAW)!;
    expect(s.champions).toEqual([ZE]);
    expect(s.tie).toBe(false);
    expect(Object.keys(s.players[0]!).sort()).toEqual([
      "avatar",
      "bot",
      "color",
      "nickname",
      "rank",
      "score",
      "team",
    ]);
    expect(JSON.stringify(s)).not.toMatch(
      /user_id|email|x@y\.z|room_code|1234/,
    );
  });
  it("empate: todos os campeões do servidor", () => {
    const s = sanitizeMatchShare({
      ...RAW,
      champions: [{ name: "Bia", emoji: "🦊", score: 15 }, ZE],
    })!;
    expect(s.tie).toBe(true);
    expect(s.champions.map((c) => c.name)).toEqual(["Bia", "Zé"]);
  });
  it("equipes", () => {
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
      champions: [{ name: "Corujas", emoji: "🦉", score: 13 }],
    })!;
    expect(s.mode).toBe("teams");
    expect(s.champions).toEqual([{ name: "Corujas", emoji: "🦉", score: 13 }]);
  });
  it("vazio/inválido = indisponível", () => {
    expect(sanitizeMatchShare(null)).toBeNull();
    expect(sanitizeMatchShare({ players: [] })).toBeNull();
    expect(sanitizeMatchShare("x")).toBeNull();
  });
});

describe("botão Compartilhar resultado", () => {
  const PRONTO: PreparedShare = {
    ok: true,
    url: matchShareUrl(TOKEN),
    text: shareTextFromChampions([ZE]),
  };
  it("link já preparado: compartilha SEM chamar o servidor antes (gesto do Safari/iOS — Red Team D)", async () => {
    const createShare = vi.fn();
    const share = vi.fn(async () => "shared" as const);
    const r = await shareMatchResult({ prepared: PRONTO, createShare, share });
    expect(createShare).not.toHaveBeenCalled();
    expect(share).toHaveBeenCalledWith({
      title: "Resultado no Verbete",
      text: PRONTO.text,
      url: PRONTO.url,
    });
    expect(r).toEqual({
      kind: "shared",
      url: PRONTO.url,
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
  it("sem link preparado (ou falha temporária): prepara no clique e guarda", async () => {
    const onPrepared = vi.fn();
    const share = vi.fn(async () => "copied" as const);
    const r = await shareMatchResult({
      prepared: { ok: false, retry: true, note: SHARE_LINK_FAILED },
      createShare: async () => ({ ok: true, token: TOKEN, champions: [ZE] }),
      share,
      onPrepared,
    });
    expect(onPrepared).toHaveBeenCalledWith(PRONTO);
    expect(r.kind).toBe("copied");
  });
  it("recusa definitiva (limpeza, não jogou): não insiste no servidor e NÃO compartilha a Home", async () => {
    const createShare = vi.fn();
    const share = vi.fn();
    const note =
      "Só quem jogou esta partida até o fim pode compartilhar o resultado.";
    const r = await shareMatchResult({
      prepared: { ok: false, retry: false, note },
      createShare,
      share,
    });
    expect(r).toEqual({ kind: "link_failed", url: null, note });
    expect(createShare).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });
  it("servidor caiu: mensagem de falha do link, sem compartilhar", async () => {
    const share = vi.fn();
    const r = await shareMatchResult({
      prepared: null,
      createShare: async () => {
        throw new Error("rede");
      },
      share,
    });
    expect(r).toEqual({
      kind: "link_failed",
      url: null,
      note: SHARE_LINK_FAILED,
    });
    expect(share).not.toHaveBeenCalled();
  });
});
