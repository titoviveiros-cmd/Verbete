# Provedor de IA por configuração

> **10/11/2026 — modo sem IA externa preparado.** Os termos da Gemini API e
> da Vertex AI vedam app provavelmente acessado por menores de 18 (o Verbete
> é 13+), e as validações N2 de outros provedores reprovaram (N2-M em 06/11,
> N2-H em 08/11). O interruptor de código `EXTERNAL_AI_MODE`
> (`_shared/external-ai.ts`) esvazia `AI_PROVIDERS_DISCLOSED` quando
> `"desligada"`: nenhum perfil abaixo chama a IA, com ou sem chave. Hoje o
> valor é `"ligada"` (nada mudou). Ordem de ativação: `docs/sem-ia-externa.md`.

Troca o provedor de IA das edges (`bot-definitions`, `bot-definitions-v2`, `score-similarity`) e do Worker do Desafio Diário **só com variáveis de ambiente**, sem mudar código. **Sem nada novo configurado, tudo segue idêntico ao Gemini de hoje** (mesma URL, modelo, cabeçalhos e corpo — coberto por teste).

Código: `supabase/functions/_shared/ai-provider.ts` — **um único módulo** com a tabela de perfis, usado pelas edges (Deno, `Deno.env.get`) e pelo Worker (Node, `process.env`); sem APIs de nenhum dos dois. A chamada continua em `_shared/ai.ts` (`callChat`). Testes: `src/lib/__tests__/ai-provider.test.ts` (só `fetch` simulado).

> Rubrica, prompt, notas e cortes (`_shared/semantic.ts`) **não mudam** com o provedor. Mas a nota é do MODELO: outro modelo pode dar notas diferentes para o mesmo palpite. Antes de trocar em produção, calibrar o modelo novo com a bateria de `scripts/semantic-calibration-cases.mjs` — o `scripts/test-semantic-calibration.mjs` de hoje só fala com o Gemini (não usa este adaptador) e precisaria passar o destino resolvido a `scoreGuess`/`judgeCandidates`. Isso chama a IA de verdade e exige autorização.

## Perfis

| `AI_PROVIDER` | Endpoint | Chave | Outras obrigatórias | Modelo padrão (`AI_MODEL` troca) | `max_tokens` | Saída estrita |
|---|---|---|---|---|---|---|
| *(ausente/vazio)* ou `gemini` | `GEMINI_CHAT_URL` (opcional) ou o endpoint OpenAI-compatível do Google | `GEMINI_API_KEY` | — | `gemini-flash-lite-latest` | não envia | não (idêntico ao atual) |
| `workers-ai` | API **nativa** `https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/ai/run/{AI_MODEL}` (fio `workers-run`) | `CF_AI_TOKEN` | `CF_ACCOUNT_ID` | `@cf/mistralai/mistral-small-3.1-24b-instruct` (aprovado na N1-M de 06/11/2026) | 1024 | sim |
| `mistral` | `https://api.mistral.ai/v1/chat/completions` | `MISTRAL_API_KEY` | — | `mistral-small-latest` | 1024 | sim |
| `openai-compatible` | `AI_CHAT_URL` (https; http só em localhost/127.0.0.1) | `AI_API_KEY` | `AI_CHAT_URL`, `AI_MODEL` | *(nenhum: AI_MODEL obrigatório)* | 1024 | sim |

Os modelos padrão de `mistral` e `openai-compatible` são **pontos de partida não avaliados**; o de `workers-ai` é o Mistral Small 3.1 24B, aprovado na N1-M (5 chamadas), mas REPROVADO na N2-M (06/11/2026, NO-GO no semântico). Definir `AI_MODEL` explicitamente ao trocar.

**JSON guiado do juiz (fio `workers-run`, 06/11/2026):** no perfil `workers-ai` a chamada vai à API nativa do modelo (a mesma entrada do binding usado na N1-M): modelo na URL, sem `model` no corpo, resposta no envelope `{ result, success }` (aceita `choices[0]` e `response`). As chamadas do **juiz** (multiplayer, gate dos bots v2 e Diário) enviam `guided_json` = `JUDGE_SCORES_SCHEMA` (`_shared/semantic.ts`), o mesmo formato que o prompt já pede; a geração dos bots não envia esquema. No Gemini nada muda (sem `guided_json`).

Opcionais para qualquer perfil:

- `AI_MODEL` — modelo.
- `AI_MAX_TOKENS` — inteiro de 1 a 32768; substitui o `max_tokens` do perfil (no Gemini, passa a enviar). Modelos que "pensam" (ex.: gpt-oss) gastam tokens no raciocínio: limite baixo vira `finish_reason=length` → falha.
- `AI_RESPONSE_FORMAT=json_object` — envia `response_format: {"type":"json_object"}`. **Desligado em todos os perfis por padrão**: só ligar depois de confirmar na documentação do provedor que o MODELO escolhido aceita (no Workers AI, depende do modelo). Outro valor = configuração inválida.

## Saída

- Aceita `choices[0].message.content` (texto não vazio), como antes.
- **Perfis estritos** (todos menos `gemini`): conteúdo com marcadores de canal (`<|start|>`, `<|end|>`, `<|channel|>`, `<|message|>`, `<|return|>`, `<|call|>`, `<|constrain|>` — achado da N1b com gpt-oss) ou `finish_reason = "length"` (resposta cortada) é **falha** `invalid_response`, **sem nova tentativa**. O efeito é o mesmo de uma resposta inválida hoje: bot cai nas reservas, juiz registra `judge_ai_error`, Diário não gasta a tentativa.
- O perfil `gemini` não tem essa checagem, para manter o comportamento idêntico.

## Contenção (`docs/contencao-ia.md`)

"Chave ausente" passou a ser a chave **do perfil ativo**: sem `AI_PROVIDER`, continua sendo `GEMINI_API_KEY`. Também suspendem (falha fechada, nunca cai em outro provedor): `AI_PROVIDER` desconhecido, variável obrigatória do perfil faltando ou inválida (`CF_ACCOUNT_ID`, `AI_CHAT_URL`, `AI_MODEL` no genérico), `AI_MAX_TOKENS`/`AI_RESPONSE_FORMAT` inválidos. `AI_FORCE_SUSPEND` continua valendo acima de tudo.

Logs e eventos levam só NOMES de variáveis (ex.: `AI provider config (mistral): MISTRAL_API_KEY`), nunca valores.

## Como trocar (cada passo exige autorização do Tito)

As variáveis precisam ir para **os dois lugares**, com os mesmos valores:

1. **Edges (Supabase secrets):** `AI_PROVIDER`, a chave do perfil e as obrigatórias. Ex. Workers AI: `AI_PROVIDER=workers-ai`, `CF_ACCOUNT_ID`, `CF_AI_TOKEN`, `AI_MODEL`.
2. **Worker do Diário (Cloudflare secrets/vars):** as mesmas.
3. Conferir com uma rodada de teste e o `/admin/ops` (`judge_ai_*`, `bot_ai_*`).

Configurar só um dos lados deixa edges e Diário em provedores diferentes (ou um deles suspenso, se faltar a chave). Os segredos só mudam pelo painel/CLI com autorização; nada disso é feito pelo código.

**Antes de trocar:** confirmar que `AI_PROVIDER`, `AI_MODEL`, `AI_MAX_TOKENS` e `AI_RESPONSE_FORMAT` **não existem hoje** nos secrets das edges e do Worker (listar só os nomes) — se existirem com outro propósito, o comportamento muda.

**Textos legais (trava de código, 06/11/2026):** as páginas de Termos/Privacidade citam o provedor (`AI_PROVIDER` em `src/lib/legal.ts`, PR #41 — constante de código, não esta variável de ambiente). Para o texto nunca ficar para trás, `AI_PROVIDERS_DISCLOSED` em `_shared/ai-provider.ts` lista os provedores **com texto publicado** (hoje só `gemini`). Perfil válido fora da lista = **IA suspensa** (falha fechada; erro `AI provider config (<id>): sem texto legal publicado`), mesmo com todas as variáveis certas. Trocar de provedor, portanto, exige **código + deploy** antes dos segredos: incluir o id na lista, atualizar `AI_PROVIDER`/`ownUseNotice` e `TERMS_VERSION` (novo aceite), Data Safety e ficha da loja — `legal-pages.test.ts` falha se a lista e o texto divergirem. Só então configurar os segredos (passos 1–3).

## Rollback

Remover `AI_PROVIDER` (e, se definidas, `AI_MODEL`, `AI_MAX_TOKENS`, `AI_RESPONSE_FORMAT`) dos dois lugares. Volta ao Gemini com `GEMINI_API_KEY`, exatamente como antes. Efeito na próxima requisição de cada isolate (o ambiente não tem cache). Para parar a IA de vez: `AI_FORCE_SUSPEND=1` (`docs/contencao-ia.md`).
