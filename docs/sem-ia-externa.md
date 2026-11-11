# Modo "sem IA externa" (13+) — interruptor, textos e ordem de ativação

> 10/11/2026. Motivo: os termos da Gemini API (planos grátis e pago) e da
> Vertex AI vedam app "likely to be accessed" por menores de 18; o Verbete é
> 13+. Decisão recomendada: operar **sem IA externa** (diagnóstico e plano nas
> notas de lançamento; este arquivo é só o que o código faz e a ordem).

## 1. O interruptor

`supabase/functions/_shared/external-ai.ts` → `EXTERNAL_AI_MODE`, **constante de
código** revisada em PR. Não depende de `app_config.ai_mode`, de variável de
ambiente nem de segredo.

| Valor | Backend (edges + Worker do Diário) | Páginas e textos |
|---|---|---|
| `"ligada"` (**hoje**) | `AI_PROVIDERS_DISCLOSED = ["gemini"]`: igual a antes (contenção por `ai_mode`/`AI_FORCE_SUSPEND`/chave continua valendo) | exatamente os textos publicados; Termos `2026-10-27`; sem nome do desenvolvedor |
| `"desligada"` | `AI_PROVIDERS_DISCLOSED = []`: **qualquer** perfil vira configuração inválida → IA suspensa (falha fechada), com ou sem chave e com `ai_mode='ligado'` | `/privacy`, `/terms`, `/support`, `/delete-account` e "Como jogar" sem IA e sem 🧠; nome legal do desenvolvedor; `TERMS_VERSION = NO_AI_TERMS_VERSION` (**um** novo aceite) |

Com `"ligada"`, o build de produção elimina o ramo sem IA (o bundle nem leva o
nome pendente; `verify-web-bundle` confere).

## 2. Ativação = PR de 3 linhas (só na ordem da §4)

1. `external-ai.ts`: `EXTERNAL_AI_MODE = "desligada"`.
2. `src/lib/legal.ts`: `DEVELOPER_LEGAL_NAME` = nome legal **igual ao da conta
   do Play Console** (dono).
3. `src/lib/legal.ts`: `NO_AI_TERMS_VERSION` = data da publicação
   (`AAAA-MM-DD`).

Travas (qualquer uma reprova):

- `npm run check` — `legal-sem-ia.test.tsx` ("o estado do repositório nunca
  leva pendência a um build sem IA");
- `vite build` de produção, web **e** nativo/AAB — `build/legal-guard.ts`
  chamado no `vite.config.ts`;
- `npm run build:web` — `scripts/verify-web-bundle.mjs` reprova o marcador
  `<PENDENTE` no cliente ou no SSR.

## 3. Novo aceite dos Termos

- O aceite fica no aparelho (`terms-record.ts`, por identidade). Com a versão
  nova, cada identidade aceita **uma vez** antes do próximo conteúdo (apelido,
  definição, palpite). Na web, logo após o deploy; no Android, só quando o
  bundle com o modo sem IA chegar (vc9 ou posterior).
- Nome do desenvolvedor + texto sem IA vão **juntos** para não pedir dois
  aceites. Se o parecer jurídico (ECA Digital) pedir mudança nos Termos,
  incluir **antes** da ativação, no mesmo pacote.
- A `/privacy` não tem aceite: só a data muda.

## 4. Ordem obrigatória (cada passo com autorização própria do dono)

1. Diário com alternativa funcional: R6 no ar → R6b aplicada → **≥ 168
   conjuntos aprovados jogáveis** → `daily_mode='escolha'` → observar 24–48 h.
   Com `daily_mode='juiz'` e a IA suspensa, o Diário fica em **pausa**
   (`daily-guard.ts`).
2. `ai_mode='suspenso'` → observar 24–48 h → `AI_FORCE_SUSPEND=1` (edges e
   Worker).
3. Merge do PR de ativação (§2) → deploy do Worker (Version 0% → smoke →
   100%). Edges: redeploy só se o código no ar = master; senão o corte por
   ambiente já basta.
4. Remover `GEMINI_API_KEY` (edges + Worker) e revogar no Google AI Studio.
5. Play Console: Data Safety (rascunho "sem IA externa" em
   `docs/google-play-data-safety-draft.md` §7), ficha sem menção a IA → AAB
   com o modo sem IA.

**Trava dos 168 (11/11/2026, `scripts/lib/sem-ia-prontidao.mjs`).** Portão só
de leitura: `DB_URL=... node scripts/check-sem-ia-prontidao.mjs` (sai 0 só com
`daily_mode='escolha'` **e** ≥ 168 aprovados jogáveis — mesmo critério do
painel). `scripts/set-app-config.mjs` recusa (exit 3, nada gravado)
`ai_mode suspenso` sem os dois e `daily_mode escolha` sem os 168; banco
ilegível = recusa. Contenção de emergência (chave vazada, custo):
`ai_mode suspenso --emergencia` (avisa que o Diário pausa se estiver em
`juiz`). `AI_FORCE_SUSPEND`/remoção da chave/SQL à mão **não** passam pela
trava: só depois do portão verde.

**Janela única (sem indisponibilidade).** Os textos sem IA vão ao ar **por
último**, quando a IA já está parada; o corte por código das edges não
depende de `ai_mode` (teste em execução de 11/11: com `"desligada"` as 3
edges respondem 200, sem chamar o provedor, com `ai_mode='ligado'` e com a
chave presente). Ordem: portão verde → `ai_mode suspenso` (≤ 30 s por
isolate) → `AI_FORCE_SUSPEND=1` → edges com este código → Worker (Version
sem tráfego → smoke → 100%). Detalhe, segundos de exposição e smoke: notas de
lançamento (PR63-CAMINHO-SEM-IA-11-11).

Rollback por passo: ver as notas de lançamento (FRENTE3-13PLUS-RUNTIME).
Rollback do passo 3 = Worker anterior (os aceites da versão nova ficam no
aparelho; voltar à versão antiga pede o aceite antigo de novo).

## 5. O que fica dormente (não removido)

O adaptador de IA (`_shared/ai.ts`, `ai-provider.ts`), o juiz
(`score-similarity`), o modo juiz do Diário e o selo 🧠 do placar continuam
no código, sem chamar a IA. As edges de IA **ficam no ar, suspensas**: o
banco chama `score-similarity` a cada rodada (apagar = 404 e
`judge_gave_up` por rodada) e o APK vc8 chama as edges de bots direto.
