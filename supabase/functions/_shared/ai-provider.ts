// Provedor de IA por CONFIGURAÇÃO (06/11/2026) — como trocar, envs por perfil
// e rollback: docs/provedor-ia.md.
// Um só módulo para as edges (Deno.env.get) e o Worker do Diário
// (process.env): sem APIs do Deno nem do Node. Testes Vitest em
// src/lib/__tests__/ai-provider.test.ts.
//
// Sem AI_PROVIDER (ou vazio) = perfil "gemini" = exatamente o de antes: mesma
// URL (GEMINI_CHAT_URL opcional), mesmo modelo, mesmo corpo, mesma chave.
// Configuração inválida NUNCA cai em outro provedor: o resultado é !ok e a
// contenção (ai-mode.ts) suspende a IA — falha FECHADA.
// Nada aqui registra log nem devolve o VALOR de uma variável: só nomes.

import { GEMINI_CHAT_URL, GEMINI_MODEL, type ChatTarget } from "./ai.ts";
import { EXTERNAL_AI_MODE, type ExternalAiMode } from "./external-ai.ts";

export const AI_PROVIDER_ENV = "AI_PROVIDER";
export const AI_MODEL_ENV = "AI_MODEL";
export const AI_MAX_TOKENS_ENV = "AI_MAX_TOKENS";
export const AI_RESPONSE_FORMAT_ENV = "AI_RESPONSE_FORMAT";

export type AiProviderId =
  "gemini" | "workers-ai" | "mistral" | "openai-compatible";

type Get = (k: string) => string | undefined | null;

type Profile = {
  /** Variável com a chave/token do perfil (nome, nunca valor). */
  keyEnv: string;
  /** Modelo quando AI_MODEL não vem; null = AI_MODEL obrigatório. */
  defaultModel: string | null;
  /** URL do endpoint (recebe o modelo resolvido); `missing` = envs que faltam. */
  url: (get: Get, model: string) => { url: string } | { missing: string };
  /** Formato do fio (ai.ts). Omitido = OpenAI-compatível. */
  wire?: "workers-run";
  /** max_tokens explícito no corpo; null = não envia (padrão do provedor). */
  maxTokens: number | null;
  /** Rejeita marcadores de canal e finish_reason=length (ai.ts). */
  strictOutput: boolean;
};

const str = (get: Get, k: string): string => String(get(k) ?? "").trim();

/** https em qualquer host; http só em loopback (simulador local de testes). */
function safeChatUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return u.toString();
    if (
      u.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
    )
      return u.toString();
  } catch {
    /* inválida */
  }
  return null;
}

/**
 * Tabela ÚNICA de perfis. response_format fica DESLIGADO em todos: só entra
 * com AI_RESPONSE_FORMAT=json_object, por conta de quem confirmou o suporte
 * do modelo escolhido (docs/provedor-ia.md).
 */
export const AI_PROFILES: Readonly<Record<AiProviderId, Profile>> = {
  gemini: {
    keyEnv: "GEMINI_API_KEY",
    defaultModel: GEMINI_MODEL,
    // GEMINI_CHAT_URL (opcional) = simulador dos testes de ponta a ponta
    url: (get) => ({
      url: String(get("GEMINI_CHAT_URL") ?? "") || GEMINI_CHAT_URL,
    }),
    maxTokens: null,
    strictOutput: false,
  },
  // API NATIVA (/ai/run/<modelo>) = mesma entrada do binding usado na N1-M:
  // aceita guided_json (schema do modelo). Modelo padrão = o aprovado na
  // N1-M (06/11/2026); a ativação continua barrada por AI_PROVIDERS_DISCLOSED.
  "workers-ai": {
    keyEnv: "CF_AI_TOKEN",
    defaultModel: "@cf/mistralai/mistral-small-3.1-24b-instruct",
    url: (get, model) => {
      const account = str(get, "CF_ACCOUNT_ID");
      if (!/^[A-Za-z0-9]{1,64}$/.test(account))
        return { missing: "CF_ACCOUNT_ID" };
      if (!/^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(model))
        return { missing: AI_MODEL_ENV };
      return {
        url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`,
      };
    },
    wire: "workers-run",
    // o padrão do Workers AI (256) corta o JSON dos bots
    maxTokens: 1024,
    strictOutput: true,
  },
  mistral: {
    keyEnv: "MISTRAL_API_KEY",
    defaultModel: "mistral-small-latest",
    url: () => ({ url: "https://api.mistral.ai/v1/chat/completions" }),
    maxTokens: 1024,
    strictOutput: true,
  },
  "openai-compatible": {
    keyEnv: "AI_API_KEY",
    defaultModel: null,
    url: (get) => {
      const url = safeChatUrl(str(get, "AI_CHAT_URL"));
      return url ? { url } : { missing: "AI_CHAT_URL" };
    },
    maxTokens: 1024,
    strictOutput: true,
  },
};

export type ResolvedAiProvider =
  | {
      ok: true;
      id: AiProviderId;
      apiKey: string;
      target: Required<Pick<ChatTarget, "url" | "model">> & ChatTarget;
    }
  | {
      ok: false;
      /** null = AI_PROVIDER com valor desconhecido. */
      id: AiProviderId | null;
      /** NOMES das variáveis ausentes/inválidas — nunca os valores. */
      invalid: string[];
      /** Perfil válido, mas sem texto legal publicado (AI_PROVIDERS_DISCLOSED). */
      undisclosed?: true;
    };

function isProviderId(v: string): v is AiProviderId {
  return Object.prototype.hasOwnProperty.call(AI_PROFILES, v);
}

/**
 * Provedores com TEXTO LEGAL publicado (Termos/Privacidade/Data Safety citam
 * AI_PROVIDER de src/lib/legal.ts — constante de código). Perfil fora desta
 * lista = configuração inválida → IA SUSPENSA (falha fechada): ligar outro
 * provedor só por variável de ambiente, sem o texto acompanhar, não chama a IA.
 * Trocar = incluir o id aqui + AI_PROVIDER/TERMS_VERSION em legal.ts + deploy
 * (legal-pages.test.ts amarra os dois). docs/provedor-ia.md.
 * Com EXTERNAL_AI_MODE = "desligada" (external-ai.ts) a lista fica VAZIA:
 * IA suspensa por CÓDIGO, com ou sem chave e com ou sem ai_mode.
 */
export function disclosedProvidersFor(
  mode: ExternalAiMode,
): readonly AiProviderId[] {
  return mode === "desligada" ? [] : ["gemini"];
}
export const AI_PROVIDERS_DISCLOSED: readonly AiProviderId[] =
  disclosedProvidersFor(EXTERNAL_AI_MODE);

/**
 * Perfil ativo a partir do ambiente, com a trava do texto legal. Nunca lança
 * por conta própria (um `get` que lança propaga — o leitor da contenção
 * trata). Não registra log.
 */
export function resolveAiProvider(get: Get): ResolvedAiProvider {
  const r = resolveAiProviderProfile(get);
  if (r.ok && !AI_PROVIDERS_DISCLOSED.includes(r.id))
    return { ok: false, id: r.id, invalid: [AI_PROVIDER_ENV], undisclosed: true };
  return r;
}

/**
 * Só a leitura do perfil (sem a trava do texto legal) — usada pelos testes
 * dos perfis. Código de produção usa resolveAiProvider.
 */
export function resolveAiProviderProfile(get: Get): ResolvedAiProvider {
  const rawId = str(get, AI_PROVIDER_ENV).toLowerCase() || "gemini";
  if (!isProviderId(rawId))
    return { ok: false, id: null, invalid: [AI_PROVIDER_ENV] };
  const p = AI_PROFILES[rawId];
  const invalid: string[] = [];

  // valor como veio (o cabeçalho segue idêntico ao de antes); vazio = ausente
  const apiKey = String(get(p.keyEnv) ?? "");
  if (!apiKey.trim()) invalid.push(p.keyEnv);

  const model = str(get, AI_MODEL_ENV) || p.defaultModel || "";
  if (!model) invalid.push(AI_MODEL_ENV);

  const u = p.url(get, model);
  if ("missing" in u && !invalid.includes(u.missing)) invalid.push(u.missing);

  let maxTokens = p.maxTokens;
  const rawMax = str(get, AI_MAX_TOKENS_ENV);
  if (rawMax) {
    const n = /^\d{1,6}$/.test(rawMax) ? Number(rawMax) : NaN;
    if (n >= 1 && n <= 32_768) maxTokens = n;
    else invalid.push(AI_MAX_TOKENS_ENV);
  }

  const rawFormat = str(get, AI_RESPONSE_FORMAT_ENV).toLowerCase();
  if (rawFormat && rawFormat !== "json_object")
    invalid.push(AI_RESPONSE_FORMAT_ENV);

  if (invalid.length > 0 || "missing" in u)
    return { ok: false, id: rawId, invalid };

  const extraBody: Record<string, unknown> = {};
  if (maxTokens !== null) extraBody.max_tokens = maxTokens;
  if (rawFormat === "json_object")
    extraBody.response_format = { type: "json_object" };

  return {
    ok: true,
    id: rawId,
    apiKey,
    target: {
      url: u.url,
      model,
      ...(Object.keys(extraBody).length > 0 ? { extraBody } : {}),
      ...(p.strictOutput ? { strictOutput: true } : {}),
      ...(p.wire ? { wire: p.wire } : {}),
    },
  };
}

/** Mensagem de erro segura (só nomes de variáveis) para as edges. */
export function aiConfigError(
  r: Extract<ResolvedAiProvider, { ok: false }>,
): string {
  if (r.undisclosed)
    return `AI provider config (${r.id}): sem texto legal publicado (AI_PROVIDERS_DISCLOSED)`;
  return `AI provider config (${r.id ?? "desconhecido"}): ${r.invalid.join(", ")}`;
}
