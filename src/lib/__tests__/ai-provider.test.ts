// Provedor de IA por configuração (supabase/functions/_shared/ai-provider.ts,
// docs/provedor-ia.md). Só fetch SIMULADO: nenhuma chamada real a provedor.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callChat,
  GEMINI_CHAT_URL,
  GEMINI_MODEL,
} from "../../../supabase/functions/_shared/ai.ts";
import {
  AI_PROFILES,
  AI_PROVIDERS_DISCLOSED,
  aiConfigError,
  resolveAiProvider,
  resolveAiProviderProfile,
  type AiProviderId,
} from "../../../supabase/functions/_shared/ai-provider.ts";
import {
  createAiModeReader,
  forcedSuspensionFrom,
} from "../../../supabase/functions/_shared/ai-mode.ts";
import {
  judgeCandidates,
  scoreGuess,
} from "../../../supabase/functions/_shared/semantic.ts";
import { evaluateDailyGuess, runDailyEvaluation } from "../daily-evaluation";

type Env = Record<string, string | undefined>;
const env = (o: Env) => (k: string) => o[k];

const SECRET = "sk-SEGREDO-NAO-PODE-VAZAR-123";
const CF_ACCOUNT = "0123456789abcdef0123456789abcdef";

/** Configuração COMPLETA de cada perfil (chave = SECRET). */
const FULL: Record<AiProviderId, Env> = {
  gemini: { GEMINI_API_KEY: SECRET },
  "workers-ai": {
    AI_PROVIDER: "workers-ai",
    CF_AI_TOKEN: SECRET,
    CF_ACCOUNT_ID: CF_ACCOUNT,
  },
  mistral: { AI_PROVIDER: "mistral", MISTRAL_API_KEY: SECRET },
  "openai-compatible": {
    AI_PROVIDER: "openai-compatible",
    AI_API_KEY: SECRET,
    AI_CHAT_URL: "https://llm.exemplo.test/v1/chat/completions",
    AI_MODEL: "modelo-x",
  },
};
const KEY_ENV: Record<AiProviderId, string> = {
  gemini: "GEMINI_API_KEY",
  "workers-ai": "CF_AI_TOKEN",
  mistral: "MISTRAL_API_KEY",
  "openai-compatible": "AI_API_KEY",
};
const IDS = Object.keys(FULL) as AiProviderId[];

const okResponse = (content: unknown, finish_reason?: string) =>
  new Response(
    JSON.stringify({
      choices: [
        { message: { content }, ...(finish_reason ? { finish_reason } : {}) },
      ],
    }),
    { status: 200 },
  );
const messages = [{ role: "user", content: "x" }];

function fetchOk(content = "{}", finish?: string) {
  return vi.fn(async (_u: string, _i: RequestInit) =>
    okResponse(content, finish),
  );
}
const call = (f: ReturnType<typeof fetchOk>, i = 0) =>
  f.mock.calls[i] as [string, RequestInit];

function resolved(id: AiProviderId, extra: Env = {}) {
  // perfil puro (sem a trava do texto legal, testada à parte)
  const r = resolveAiProviderProfile(env({ ...FULL[id], ...extra }));
  if (!r.ok) throw new Error(`perfil ${id} não resolveu: ${r.invalid}`);
  return r;
}

describe("tabela de perfis", () => {
  it("quatro perfis, cada um com a sua chave", () => {
    expect(Object.keys(AI_PROFILES).sort()).toEqual(
      ["gemini", "mistral", "openai-compatible", "workers-ai"].sort(),
    );
    for (const id of IDS) expect(AI_PROFILES[id].keyEnv).toBe(KEY_ENV[id]);
  });

  it("response_format desligado em TODOS por padrão; só Gemini sem max_tokens", () => {
    for (const id of IDS) {
      const r = resolved(id);
      expect(r.target.extraBody?.response_format).toBeUndefined();
      expect(r.target.extraBody?.max_tokens).toBe(
        id === "gemini" ? undefined : 1024,
      );
      expect(r.target.strictOutput ?? false).toBe(id !== "gemini");
    }
  });

  it("modelo padrão por perfil; AI_MODEL troca o modelo", () => {
    expect(resolved("gemini").target.model).toBe(GEMINI_MODEL);
    expect(resolved("workers-ai").target.model).toBe(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    );
    expect(resolved("mistral").target.model).toBe("mistral-small-latest");
    expect(resolved("mistral", { AI_MODEL: " outro " }).target.model).toBe(
      "outro",
    );
  });

  it("AI_PROVIDER vazio ou com caixa/espaços diferentes", () => {
    expect(
      resolveAiProvider(env({ ...FULL.gemini, AI_PROVIDER: " " })),
    ).toMatchObject({
      ok: true,
      id: "gemini",
    });
    expect(
      resolveAiProviderProfile(
        env({ ...FULL.mistral, AI_PROVIDER: " Mistral " }),
      ),
    ).toMatchObject({ ok: true, id: "mistral" });
  });
});

describe("padrão = Gemini IDÊNTICO ao de antes", () => {
  it("sem nenhuma variável nova: mesma URL, modelo, cabeçalhos e corpo do callChat legado", async () => {
    const r = resolveAiProvider(env({ GEMINI_API_KEY: "k" }));
    expect(r).toEqual({
      ok: true,
      id: "gemini",
      apiKey: "k",
      target: { url: GEMINI_CHAT_URL, model: GEMINI_MODEL },
    });
    if (!r.ok) return;
    const legado = fetchOk();
    const novo = fetchOk();
    await callChat({ fetchFn: legado, apiKey: "k", messages, temperature: 0 });
    await callChat({
      fetchFn: novo,
      apiKey: r.apiKey,
      ...r.target,
      messages,
      temperature: 0,
    });
    const [uL, iL] = call(legado);
    const [uN, iN] = call(novo);
    expect(uN).toBe(uL);
    expect(uN).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(iN.method).toBe(iL.method);
    expect(iN.headers).toEqual(iL.headers);
    expect(iN.body).toBe(iL.body);
    expect(iN.body).toBe(
      JSON.stringify({
        model: "gemini-flash-lite-latest",
        messages,
        temperature: 0,
      }),
    );
  });

  it("GEMINI_CHAT_URL segue valendo (simulador dos testes de ponta a ponta)", () => {
    const r = resolveAiProvider(
      env({
        GEMINI_API_KEY: "k",
        GEMINI_CHAT_URL: "http://127.0.0.1:54999/chat",
      }),
    );
    expect(r.ok && r.target.url).toBe("http://127.0.0.1:54999/chat");
  });

  it("Gemini mantém a saída de sempre (sem a checagem estrita)", async () => {
    const r = resolved("gemini");
    const f = fetchOk("<|channel|>x", "length");
    const res = await callChat({
      fetchFn: f,
      apiKey: r.apiKey,
      ...r.target,
      messages,
    });
    expect(res).toEqual({ ok: true, content: "<|channel|>x", attempts: 1 });
  });

  it("juiz, Diário e scoreGuess: o destino resolvido chega ao fetch igual ao legado", async () => {
    const r = resolveAiProvider(env({ GEMINI_API_KEY: "k" }));
    if (!r.ok) throw new Error("gemini");
    const content = '{"scores":{"a":90},"score":90}';
    const fL = fetchOk(content);
    const fN = fetchOk(content);
    const base = { word: "w", truth: "t", guess: "g" };
    await scoreGuess({ fetchFn: fL, apiKey: "k", ...base });
    await scoreGuess({ fetchFn: fN, apiKey: r.apiKey, ...r.target, ...base });
    await evaluateDailyGuess({ fetchFn: fL, apiKey: "k", ...base });
    await evaluateDailyGuess({
      fetchFn: fN,
      apiKey: r.apiKey,
      ...r.target,
      ...base,
    });
    const cands = {
      word: "w",
      truth: "t",
      candidates: [{ id: "a", text: "x" }],
    };
    await judgeCandidates({ fetchFn: fL, apiKey: "k", ...cands });
    await judgeCandidates({ fetchFn: fN, apiKey: "k", ...r.target, ...cands });
    expect(fN.mock.calls.length).toBe(fL.mock.calls.length);
    fL.mock.calls.forEach((_, i) => {
      expect(call(fN, i)[0]).toBe(call(fL, i)[0]);
      expect(call(fN, i)[1].body).toBe(call(fL, i)[1].body);
      expect(call(fN, i)[1].headers).toEqual(call(fL, i)[1].headers);
    });
  });
});

describe("contenção: chave DO PERFIL ATIVO ausente = suspenso", () => {
  it.each(IDS)("%s completo = perfil válido; sem a chave = suspenso", (id) => {
    expect(resolveAiProviderProfile(env(FULL[id])).ok).toBe(true);
    expect(
      resolveAiProviderProfile(env({ ...FULL[id], [KEY_ENV[id]]: undefined }))
        .ok,
    ).toBe(false);
    // completo só segue o banco se o provedor tiver texto legal publicado
    expect(forcedSuspensionFrom(env(FULL[id]))).toBe(
      !AI_PROVIDERS_DISCLOSED.includes(id),
    );
    expect(
      forcedSuspensionFrom(env({ ...FULL[id], [KEY_ENV[id]]: undefined })),
    ).toBe(true);
    expect(
      forcedSuspensionFrom(env({ ...FULL[id], [KEY_ENV[id]]: "  " })),
    ).toBe(true);
  });

  it("GEMINI_API_KEY presente NÃO salva outro perfil sem a chave dele", () => {
    expect(
      forcedSuspensionFrom(
        env({ GEMINI_API_KEY: SECRET, AI_PROVIDER: "mistral" }),
      ),
    ).toBe(true);
  });

  it.each<[string, Env]>([
    [
      "AI_PROVIDER desconhecido",
      { GEMINI_API_KEY: SECRET, AI_PROVIDER: "openai" },
    ],
    [
      "workers-ai sem CF_ACCOUNT_ID",
      { ...FULL["workers-ai"], CF_ACCOUNT_ID: undefined },
    ],
    [
      "workers-ai com CF_ACCOUNT_ID inválido",
      { ...FULL["workers-ai"], CF_ACCOUNT_ID: "../x" },
    ],
    [
      "openai-compatible sem AI_MODEL",
      { ...FULL["openai-compatible"], AI_MODEL: undefined },
    ],
    [
      "openai-compatible sem AI_CHAT_URL",
      { ...FULL["openai-compatible"], AI_CHAT_URL: undefined },
    ],
    [
      "openai-compatible em http fora do loopback",
      {
        ...FULL["openai-compatible"],
        AI_CHAT_URL: "http://llm.exemplo.test/v1",
      },
    ],
    ["AI_MAX_TOKENS inválido", { ...FULL.mistral, AI_MAX_TOKENS: "muito" }],
    [
      "AI_RESPONSE_FORMAT desconhecido",
      { ...FULL.mistral, AI_RESPONSE_FORMAT: "xml" },
    ],
  ])("%s = suspenso (falha FECHADA, nunca outro provedor)", (_n, e) => {
    expect(resolveAiProvider(env(e)).ok).toBe(false);
    expect(forcedSuspensionFrom(env(e))).toBe(true);
  });

  it("AI_FORCE_SUSPEND preservado com qualquer perfil completo", () => {
    for (const id of IDS)
      expect(
        forcedSuspensionFrom(env({ ...FULL[id], AI_FORCE_SUSPEND: "1" })),
      ).toBe(true);
  });

  it("perfil sem chave: o leitor devolve 'suspenso' sem ler o banco", async () => {
    const load = vi.fn(async () => "ligado");
    const read = createAiModeReader({
      forced: () =>
        forcedSuspensionFrom(env({ ...FULL["workers-ai"], CF_AI_TOKEN: "" })),
    });
    expect(await read(load)).toBe("suspenso");
    expect(load).not.toHaveBeenCalled();
  });
});

describe("trava do texto legal (AI_PROVIDERS_DISCLOSED)", () => {
  it("hoje só o Gemini tem texto legal publicado", () => {
    expect(AI_PROVIDERS_DISCLOSED).toEqual(["gemini"]);
  });

  it.each(IDS.filter((id) => !AI_PROVIDERS_DISCLOSED.includes(id)))(
    "%s completo, mas sem texto legal = suspenso, sem chamar a IA",
    async (id) => {
      const r = resolveAiProvider(env(FULL[id]));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.undisclosed).toBe(true);
      expect(aiConfigError(r)).toBe(
        `AI provider config (${id}): sem texto legal publicado (AI_PROVIDERS_DISCLOSED)`,
      );
      expect(aiConfigError(r)).not.toContain(SECRET);
      expect(forcedSuspensionFrom(env(FULL[id]))).toBe(true);
      const load = vi.fn(async () => "ligado");
      const read = createAiModeReader({
        forced: () => forcedSuspensionFrom(env(FULL[id])),
      });
      expect(await read(load)).toBe("suspenso");
      expect(load).not.toHaveBeenCalled();
    },
  );

  it("Gemini (padrão) segue intacto", () => {
    expect(resolveAiProvider(env(FULL.gemini)).ok).toBe(true);
    expect(forcedSuspensionFrom(env(FULL.gemini))).toBe(false);
  });
});

describe("saída dos perfis estritos (não Gemini)", () => {
  const strict = resolved("workers-ai");

  it.each([
    "<|start|>assistant<|channel|>final<|message|>{}<|end|>",
    '{"score": 90}<|end|>',
    "<|channel|>analysis<|message|>pensando…",
    "texto <|return|>",
  ])(
    "marcador de canal %j = invalid_response, sem nova tentativa",
    async (c) => {
      const f = fetchOk(c);
      const res = await callChat({
        fetchFn: f,
        apiKey: strict.apiKey,
        ...strict.target,
        messages,
        retries: 3,
        backoffMs: 1,
      });
      expect(res).toEqual({
        ok: false,
        reason: "invalid_response",
        attempts: 1,
      });
      expect(f).toHaveBeenCalledTimes(1);
    },
  );

  it("finish_reason=length = invalid_response, sem nova tentativa", async () => {
    const f = fetchOk('{"definitions":["a", "b', "length");
    const res = await callChat({
      fetchFn: f,
      apiKey: strict.apiKey,
      ...strict.target,
      messages,
      retries: 3,
      backoffMs: 1,
    });
    expect(res).toEqual({ ok: false, reason: "invalid_response", attempts: 1 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("choices[0].message.content normal (finish_reason=stop) passa", async () => {
    const f = fetchOk('{"definitions":["a"]}', "stop");
    const res = await callChat({
      fetchFn: f,
      apiKey: strict.apiKey,
      ...strict.target,
      messages,
    });
    expect(res).toEqual({
      ok: true,
      content: '{"definitions":["a"]}',
      attempts: 1,
    });
  });

  it("Diário com marcador vira falha (tentativa não gasta), não nota", async () => {
    const f = fetchOk('<|channel|>final<|message|>{"score": 95}');
    const r = await evaluateDailyGuess({
      fetchFn: f,
      apiKey: strict.apiKey,
      ...strict.target,
      word: "w",
      truth: "t",
      guess: "g",
    });
    expect(r).toMatchObject({
      ok: false,
      reason: "invalid_response",
      attempts: 1,
    });
  });
});

describe("corpo e destino enviados por perfil", () => {
  async function send(id: AiProviderId, extra: Env = {}) {
    const r = resolved(id, extra);
    const f = fetchOk();
    await callChat({
      fetchFn: f,
      apiKey: r.apiKey,
      ...r.target,
      messages,
      temperature: 0,
    });
    const [url, init] = call(f);
    return {
      url,
      auth: (init.headers as Record<string, string>).Authorization,
      body: JSON.parse(String(init.body)),
    };
  }

  it("workers-ai: endpoint da conta, token Bearer, max_tokens explícito", async () => {
    const s = await send("workers-ai");
    expect(s.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/v1/chat/completions`,
    );
    expect(s.auth).toBe(`Bearer ${SECRET}`);
    expect(s.body).toEqual({
      max_tokens: 1024,
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      messages,
      temperature: 0,
    });
  });

  it("mistral: endpoint da Mistral e modelo padrão", async () => {
    const s = await send("mistral");
    expect(s.url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(s.body).toEqual({
      max_tokens: 1024,
      model: "mistral-small-latest",
      messages,
      temperature: 0,
    });
  });

  it("openai-compatible: AI_CHAT_URL e AI_MODEL", async () => {
    const s = await send("openai-compatible");
    expect(s.url).toBe("https://llm.exemplo.test/v1/chat/completions");
    expect(s.body).toEqual({
      max_tokens: 1024,
      model: "modelo-x",
      messages,
      temperature: 0,
    });
  });

  it("AI_MAX_TOKENS e AI_RESPONSE_FORMAT=json_object (opt-in)", async () => {
    const s = await send("mistral", {
      AI_MAX_TOKENS: "2048",
      AI_RESPONSE_FORMAT: "json_object",
    });
    expect(s.body.max_tokens).toBe(2048);
    expect(s.body.response_format).toEqual({ type: "json_object" });
  });

  it("parâmetros do perfil nunca sobrescrevem model/messages", async () => {
    const f = fetchOk();
    await callChat({
      fetchFn: f,
      apiKey: "k",
      model: "certo",
      extraBody: { model: "errado", messages: [] },
      messages,
    });
    const body = JSON.parse(String(call(f)[1].body));
    expect(body.model).toBe("certo");
    expect(body.messages).toEqual(messages);
  });
});

describe("nenhum segredo em log, erro ou evento", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolução, falhas de chamada e evento do Diário não carregam a chave", async () => {
    const logged: unknown[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        logged.push(...a);
      });

    const saidas: unknown[] = [];
    for (const id of IDS) {
      const r = resolved(id);
      for (const f of [
        vi.fn(async () => new Response(`erro ${SECRET}`, { status: 401 })),
        vi.fn(async () => {
          throw new Error("rede");
        }),
        fetchOk("<|channel|>x"),
        fetchOk("{}", "length"),
      ]) {
        saidas.push(
          await callChat({
            fetchFn: f,
            apiKey: r.apiKey,
            ...r.target,
            messages,
            backoffMs: 1,
          }),
        );
      }
      const semChave = resolveAiProvider(
        env({ ...FULL[id], [KEY_ENV[id]]: undefined, AI_MAX_TOKENS: SECRET }),
      );
      saidas.push(semChave);
      if (!semChave.ok) saidas.push(aiConfigError(semChave));
    }
    const strict = resolved("mistral");
    await expect(
      runDailyEvaluation({
        evaluate: () =>
          evaluateDailyGuess({
            fetchFn: vi.fn(async () => new Response("x", { status: 500 })),
            apiKey: strict.apiKey,
            ...strict.target,
            word: "w",
            truth: "t",
            guess: "g",
          }),
        record: async () => null,
        logEvent: async (ev) => {
          saidas.push(ev);
        },
        build: "b",
      }),
    ).rejects.toThrow();

    expect(logged.length).toBeGreaterThan(0); // o aviso do Diário foi logado
    const tudo = JSON.stringify([logged.map(String), saidas]);
    expect(tudo).not.toContain(SECRET);
  });

  it("aiConfigError só lista NOMES de variáveis", () => {
    const r = resolveAiProvider(
      env({
        AI_PROVIDER: "openai-compatible",
        AI_CHAT_URL: `https://x/${SECRET}`,
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(aiConfigError(r)).toBe(
      "AI provider config (openai-compatible): AI_API_KEY, AI_MODEL",
    );
  });

  it.each([
    "supabase/functions/bot-definitions/index.ts",
    "supabase/functions/bot-definitions-v2/index.ts",
    "supabase/functions/score-similarity/index.ts",
    "src/lib/daily.functions.ts",
  ])("%s: logs sem chave e chave só via adaptador", (f) => {
    const src = readFileSync(f, "utf8");
    for (const line of src.split("\n").filter((l) => /console\./.test(l)))
      expect(line).not.toMatch(/apiKey|chatTarget|\bai\b|_KEY|TOKEN/);
    expect(src).toMatch(/_shared\/ai-provider\.ts"/);
    expect(src).not.toMatch(
      /(?:env\.get\(|process\.env\.)"?(?:GEMINI_API_KEY|CF_AI_TOKEN|MISTRAL_API_KEY|AI_API_KEY)/,
    );
  });
});
