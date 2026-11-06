# Contenção da IA — `app_config.ai_mode`

Interruptor mínimo e reversível para desligar **todas** as chamadas ao provedor de IA (Gemini) sem derrubar o jogo e sem gerar erro visível. Origem: `PARECER-IA-13PLUS.md` §5 (nível 1).

| Valor | Efeito |
|---|---|
| `ligado` (padrão da migration) | Comportamento de sempre. |
| `suspenso` | Nenhuma chamada ao Gemini em lugar nenhum (detalhes abaixo). |
| ausente / qualquer outro valor | Igual a `ligado` (falha aberta: o interruptor nunca derruba o jogo sozinho). |

Código: `supabase/functions/_shared/ai-mode.ts` (lógica pura, compartilhada pelas edges e pelo Worker). Migration: `supabase/migrations/20261105231500_ai_mode_contencao.sql` (só configuração: insere `ai_mode = 'ligado'` com `ON CONFLICT DO NOTHING` e explicita o `GRANT SELECT` de `app_config` à `service_role`).

## Efeito por funcionalidade com `suspenso`

| Funcionalidade | O que acontece | O que o jogador vê |
|---|---|---|
| **Juiz do bônus 🧠** (`score-similarity`, chamado pelo banco via pg_net) | Não chama a IA. Marca `rounds.judged_at` e responde `200 {matches: [], skipped: "ai_suspended"}`, **sem** `error`. Se a marca falhar, o `retry_round_judgments` (cron `verbete-judge-retry`) lê o 200 sem erro e marca. Nenhum reenvio, nenhum `judge_gave_up`. | A rodada segue normal; sem +3 do 🧠 e sem "🤏 Quase lá". Pontuação normal (votos, verdade, coordenador) intacta. |
| **Bots** (`bot-definitions-v2`, anfitrião) | Não gera nem chama o juiz. Devolve `{definitions: [], fallbacks: [...], personas, gate: "skipped"}` — as reservas do servidor pelos mesmos filtros lexicais de sempre (forma, vazamento da verdade, repetição da partida, já servidas). | Bots enviam definições das reservas (mais genéricas). Sem erro. |
| **🤖 gerar definição** (`bot-definitions-v2`, count=1) | Igual aos bots. | Sugestão vinda das reservas vetadas. |
| **💡 sugestões** (`bot-definitions`, v1) | Não chama a IA. Devolve `200 {definitions: []}`. | Ficam as 2 sugestões locais (já aparecem antes da resposta). |
| **Desafio Diário** (server function no Worker) | Antes de qualquer reserva (`daily_claim`), leitura de palavra ou IA: lança a mensagem de pausa com **HTTP 200** (erro serializado do TanStack, não 5xx). | "O Desafio Diário está em pausa para manutenção — sua tentativa NÃO foi gasta. Volte mais tarde!" no mesmo lugar dos outros avisos (`submitError`). Nada é gasto nem gravado. |
| **Observabilidade** | 1 evento `ops_events` `kind = 'ai_suspended'`, `payload = {fn, mode}` por função, no máximo 1 a cada 10 min (throttle em memória + consulta ao banco). Sem sala, jogador, palavra ou texto. Nenhum `bot_ai_*` / `judge_ai_*` é gerado. | — |

**Compatibilidade com o APK instalado (2.1.4/vc8):** só o servidor muda. As edges mantêm os mesmos campos de resposta (`definitions`, `fallbacks`, `personas`, `gate`; `matches`) e o Diário usa o mesmo canal de erro que o cliente já trata (`e.message`).

**Tempo de efeito:** cada isolate (edge ou Worker) guarda o valor por até **30 s**. Contar até ~1 min para tudo convergir. Uma edge que já estava respondendo pode concluir a chamada em andamento.

## Ordem de deploy (cada passo exige autorização)

1. **Migration** `20261105231500_ai_mode_contencao.sql` (não muda comportamento: grava `ligado`).
2. **Edges**: `score-similarity`, `bot-definitions`, `bot-definitions-v2` (`--no-verify-jwt`, como hoje).
3. **Worker** (Diário).

Sem a migration, as edges e o Worker leem "ausente" = `ligado`: a ordem errada não quebra nada, só deixa o interruptor sem efeito até a chave existir.

## Como ativar (exige autorização do Tito)

```sql
UPDATE public.app_config SET value = 'suspenso', updated_at = now() WHERE key = 'ai_mode';
```

Ou, sem SQL na mão: `DB_URL=... node scripts/set-app-config.mjs ai_mode suspenso`.

Conferência (só leitura, depois de ~1 min e de algum uso): um evento `ai_suspended` por função ativa em `ops_events`, e nenhum `judge_ai_*` / `bot_ai_*` novo.

```sql
SELECT at, payload FROM public.ops_events WHERE kind = 'ai_suspended' ORDER BY at DESC LIMIT 10;
```

## Rollback

```sql
UPDATE public.app_config SET value = 'ligado', updated_at = now() WHERE key = 'ai_mode';
```

(ou `node scripts/set-app-config.mjs ai_mode ligado`). Volta em até ~30 s por isolate. Rodadas julgadas durante a suspensão **não** são rejulgadas (o bônus delas não volta). Rollback do código: reimplantar as edges/Worker anteriores; a chave sobrando no banco é inofensiva (`DELETE FROM public.app_config WHERE key = 'ai_mode'` = `ligado`).

## Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| Falha aberta: erro ao ler `app_config` num isolate novo → `ligado` | Aquele isolate pode chamar a IA enquanto o banco estiver com problema | O isolate mantém o último valor lido; para corte garantido na origem, complementar com o nível 0 (revogar a chave / remover `GEMINI_API_KEY`) |
| Atraso de até 30 s (cache por isolate) | Algumas chamadas logo após a ativação | Esperar ~1 min antes de conferir |
| `service_role` sem `SELECT` em `app_config` em produção | O interruptor não teria efeito (lê "ausente") | A migration faz o `GRANT` explícito; a suíte de integração confere o privilégio; conferir o evento `ai_suspended` após ativar |
| Diário pausado por completo | Perda temporária da funcionalidade | Mensagem clara, nada é gasto; streak: o jogador não consegue jogar na pausa (avaliar comunicação se a pausa for longa) |
| Bots/sugestões mais genéricos (reservas) | Qualidade menor da partida | Esperado; o núcleo (escrever, votar, pontuar) não muda |
| O banco ainda chama a edge do juiz via pg_net a cada rodada | Uma invocação de edge por rodada (sem IA) | Custo desprezível; a edge marca e responde rápido |
