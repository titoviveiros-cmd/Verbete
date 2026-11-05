# V2 — Desafio Diário: reserva atômica antes da IA

**Estado (05/11/2026):** PR em **rascunho** [titoviveiros-cmd/Verbete#36](https://github.com/titoviveiros-cmd/Verbete/pull/36), branch `seguranca/v2-diario`, base `master` `b7ee8d1`.
- Implementação no commit `d12c1a1`.
- **Sem merge, sem migration aplicada, sem deploy.**
- Projeto completo: `verbete-piloto-ia/PROJETO-SEGURANCA-IA-V1-V2-V3.md` (frente V2).

## O que muda
- `supabase/migrations/20261105150000_daily_guard_v2.sql`:
  - tabelas `daily_eval_claims` e `ai_quota`;
  - funções `daily_claim`, `daily_finish_ok` e `daily_finish_fail`;
  - modo `daily_guard_mode` (`desligado` | `observar` | `aplicar`), começando em **`observar`**.
- `src/lib/daily-guard.ts`: orquestração. Banco fora na reserva = **nenhuma IA** (fail-closed). Prazo de 8 s nas leituras antes da IA.
- `src/lib/daily.functions.ts`: reserva **antes** da IA; palavra e definição só são lidas quando a IA vai mesmo ser chamada; a hora do desafio vem do banco.
- `src/lib/daily-input.ts`: o schema de entrada (sem identidade: o usuário vem da sessão).
- `src/integrations/supabase/types.ts`: tipos das 3 funções novas, escritos à mão. O workflow `gen-types` os regenera depois do merge.

**O que não muda:**
- `submit_daily_attempt_scored` (pontuação, streak e conquistas), chamada na mesma transação de `daily_finish_ok`;
- a rubrica, o corte de 80 e as mensagens antigas.

**Mensagens novas** (só no modo `aplicar`):
- "em andamento";
- "muitas avaliações";
- "o desafio virou de hora";
- "avaliação descartada";
- "não foi possível confirmar o registro".

Todas avisam que a tentativa não foi gasta (ou mandam conferir o resultado).

## ⚠️ O modo `observar` NÃO protege
`observar` é **só observabilidade**: nada é bloqueado.
- Um desafio **já respondido** ou um **envio duplicado** devolve `pass_no_claim` e segue o **fluxo antigo**, que **chama a IA de novo**, exatamente como antes da V2.
- Os eventos `daily_guard` registram o que **seria** bloqueado (`would_block`).
- A proteção efetiva contra chamadas repetidas, simultâneas ou abusivas **só existe em `aplicar`**.
- Diferenças reais em `observar` (sem efeito em pontuação, streak ou convidados):
  - banco fora = sem IA;
  - banco lento por mais de 8 s antes da IA = falha sem IA;
  - mensagem neutra se a gravação não for confirmada;
  - hora vinda do banco;
  - 1 ou 2 chamadas a mais ao banco por tentativa.

## Comportamento por modo
| Situação | `desligado` | `observar` (padrão) | `aplicar` |
|---|---|---|---|
| Primeira tentativa | fluxo antigo | reserva → IA → grava pelo claim | idem |
| Já jogou na hora | IA + `already_played` (antigo) | **idem: chama a IA**, com evento `would_block` | **sem IA**, `already_played` no formato atual |
| Duplo clique / outra aba | 2 IAs (antigo) | **idem: a 2ª chama a IA**, com evento | **sem IA** ("em andamento") |
| IA falha | tentativa não gasta | idem + contador de falhas | idem; depois de 3 falhas, pausa de 2 min; disjuntor global |
| Banco fora | IA chamada, gravação falha (antigo) | **sem IA** | **sem IA** |
| Hora vira durante a avaliação | grava na hora nova (antigo) | idem, com evento | **não grava**, tentativa não gasta |

## Resultados (CONFIRMADOS)
**Local:**
- unidade: **654/654**;
- SQL offline (PGlite): **25/25**;
- `tsc` e `eslint` limpos;
- 3 mutações detectadas.

**CI do commit `d12c1a1`** (execução [42064148582](https://github.com/titoviveiros-cmd/Verbete/actions/runs/42064148582)): **5/5 jobs PASS**.
- android 4 min 20 s · build-and-test 1 min 39 s · e2e-visual (visual) 9 min 29 s · e2e-visual (visual-screens) 5 min 12 s · integration 6 min 36 s.
- **Suíte SQL `test-daily-guard.mjs` no Postgres REAL** (Supabase local do runner): **31/31 PASS**, com os **6 cenários de conexões independentes** executados:
  - 4b: 10 conexões simultâneas → 1 reserva e 1 gravação;
  - 4c: trava entre 2 conexões;
  - 4d: tentativa concluída + 6 conexões → 0 IA;
  - 4e: finalizações concorrentes, atrasada × vigente;
  - 4f: falha de transação + reserva concorrente;
  - 4g: modo observar concorrente.
- Integração: **22/22 suítes**.

## Ativação gradual (cada passo com autorização expressa)
1. **Merge** do PR #36. Bloqueado até a confirmação das integrações externas (ver "Deploy automático no merge").
2. **Migration** em produção (o modo já nasce `observar`), com o **Worker anterior** ainda no ar:
   - `npx supabase db push --linked --dry-run` deve listar só `20261105150000_daily_guard_v2`;
   - depois, `npx supabase db push --linked --yes`.
3. **Validação pós-migration** (só leitura, mais uma chamada desfeita):
   - tabelas existem e têm RLS;
   - `anon`/`authenticated` sem privilégio em **todas as 10 funções** e nas 2 tabelas;
   - `service_role` executa `daily_claim`, `daily_finish_ok` e `daily_finish_fail`;
   - `daily_guard_mode = observar`;
   - cron `verbete-daily-guard-cleanup` existe;
   - `SHOW timezone` = UTC;
   - smoke `BEGIN; SELECT public.daily_claim(gen_random_uuid()); ROLLBACK;` retorna `claimed`.
4. **Worker** (deploy, gate próprio).
5. **Observar por pelo menos 7 dias** (ou volume mínimo combinado). Relatório dos eventos `daily_guard`:
   - decisões e `would_block`;
   - **nenhum bloqueio que atingiria um jogador legítimo**.
6. **`aplicar`**, só depois dos pendentes abaixo:
   ```sql
   UPDATE public.app_config SET value = 'aplicar', updated_at = now() WHERE key = 'daily_guard_mode';
   ```
7. Acompanhar por 48 h. Ajustar limites só com autorização.

## Rollback
| Situação | Como | Efeito |
|---|---|---|
| Worker V2 **ainda não** publicado | `supabase/rollback/daily_guard_v2.sql` direto | Seguro: o Worker antigo não usa nada da V2 |
| Worker V2 publicado: desligar já | `UPDATE public.app_config SET value = 'desligado' … WHERE key = 'daily_guard_mode'` | O Worker novo volta ao fluxo antigo, idêntico. **Não** rodar o script de rollback nesse estado |
| Worker V2 publicado: remover a V2 | 1) `npx wrangler rollback <versão anterior> --name jogo`; 2) conferir; 3) **só então** o script de rollback | O Worker novo chama `daily_claim` mesmo em 'desligado': rodar o script com ele no ar derruba o Diário |

O script remove tabelas, funções, configuração e cron da V2. `daily_attempts`, `user_stats` e `user_achievements` ficam intactos (testado).

**Ordem de deploy obrigatória:** migration **antes** do Worker. Se o Worker for publicado sem a migration, `daily_claim` não existe e o Diário recusa por segurança (sem IA, tentativa não gasta) até a migration entrar ou o Worker voltar.

## Deploy automático no merge (verificado em 05/11, só leitura)
- **Workflows do repositório:**
  - `ci.yml` e `android.yml` (push no `master`) só testam e geram APK debug; o AAB só sai em `workflow_dispatch`;
  - `gen-types.yml` (push no `master` com mudança em `supabase/migrations/**`) sobe um Supabase **local**, regenera `types.ts` e pode fazer **um commit automático** no `master` (`[skip ci]`).
  - **Nenhum** passo de `wrangler deploy`, `supabase db push` ou `functions deploy`.
- **GitHub:**
  - nenhum webhook;
  - nenhum environment;
  - nenhum registro de deployment;
  - os check-suites do `master` (`b7ee8d1`) e do PR (`d12c1a1`) vêm só de `github-actions` e `claude` (nenhum app da Cloudflare, Supabase ou Vercel).
- **NÃO VERIFICADO:** a lista de GitHub Apps instalados (a API responde 403 com o token disponível) e as integrações configuradas fora do GitHub:
  - Cloudflare Workers Builds no Worker `jogo`;
  - integração GitHub do Supabase;
  - sincronização do Lovable.

  **Isto bloqueia o merge até o dono confirmar nos painéis.**

## Testes
- `npx vitest run src/lib/__tests__/daily-guard.test.ts`: orquestração, sem rede.
- `node scripts/test-daily-guard.mjs --pglite <pasta do @electric-sql/pglite>`: SQL real, offline, uma conexão.
- `DB_URL=<Postgres LOCAL> node scripts/test-daily-guard.mjs`: SQL real com conexões independentes. **Roda na CI** pelo `scripts/run-integration.mjs`. Falha sem `DB_URL` e recusa banco que não seja local.

## Revisão Red Team (05/11/2026) e situação
| Achado | Gravidade | Situação |
|---|---|---|
| A1: o rollback documentado derrubava o Diário | Alto | **Corrigido** (script e esta documentação) |
| A2: Worker publicado antes da migration = Diário fora (fail-closed) | Alto | **Documentado** (ordem obrigatória + validação pós-migration) |
| A3: disjuntor abusável (resposta inválida induzida, várias falhas do mesmo jogador) | Alto | **Corrigido.** `invalid` não conta no disjuntor; só a 1ª falha transitória do jogador na hora conta |
| M1: brecha de tempo entre checagem e reserva sem linha; 'done' renovável | Médio | **Corrigido** (trava consultiva; provado na CI pelo 4c) |
| M2: `linha IS NOT NULL` falso com campo NULL | Médio | **Corrigido** (`FOUND`) |
| M3: sem limite por origem; contas anônimas multiplicam o teto | Médio | **Pendente antes de 'aplicar'** (precisa de hash com sal = segredo novo; decidir com a V3) |
| Privilégios das 7 funções auxiliares não conferidos num Supabase real | Médio | **Pendente:** validação pós-migration |
| Limpeza de `ai_quota` apaga toda janela com mais de 3 dias | Médio | Correta para a V2. **Antes de qualquer orçamento mensal**, restringir a limpeza por prefixo de chave ou usar tabela própria (`ai_ledger`) |
| B1: hora do Worker × hora do banco | Baixo | **Corrigido.** A hora vem do banco |
| B2: 30 avaliações por dia contavam sucessos | Baixo | **Ajustado** para 48 (proposta) |
| B3: pausa, disjuntor ou reserva presa podem custar a hora e o streak por hora | Baixo | **Documentado.** Calibrar no período 'observar' |
| B4: mensagem quando a resposta da gravação se perde | Baixo | **Corrigido** (mensagem neutra) |
| B5: valores de configuração perigosos | Baixo | **Corrigido.** Mínimos seguros |
| B6: leituras do banco dentro do prazo da reserva | Baixo | **Corrigido** (prazo de 8 s antes da IA) |
| B7: identificador do usuário em `ai_quota` e `daily_eval_claims` | Baixo | **Documentado.** Limpeza em 3 dias; incluir na exclusão de conta numa próxima rodada |
| B8: eventos recusados sem limite de ritmo | Baixo | **Documentado** |
| I1 / I2 | Info | **Corrigidos** |
| I3: fuso da sessão em UTC | Info | **NÃO VERIFICADO:** validação pós-migration |
| I4: `types.ts` editado à mão | Info | Regenerado pelo `gen-types` depois do merge |

**Pendentes antes de 'aplicar' (não bloqueiam o modo `observar`):**
- meia-abertura do disjuntor;
- limite por origem (M3);
- calibrar os limites com os eventos do período 'observar';
- conferir privilégios e fuso na validação pós-migration.

## Reserva vencida com operação pendente
- A reserva vale 45 s.
- As leituras antes da IA têm prazo de 8 s (`DAILY_PREP_TIMEOUT_MS`) e a IA, de 15 s (`DAILY_BUDGET`). A 1ª avaliação termina em cerca de 23 s, e uma 2ª avaliação **não começa com a 1ª ainda rodando**.
- **Caso residual:** gravação mais lenta que cerca de 20 s depois da IA. A reserva pode vencer e uma 2ª avaliação pode começar **depois** da 1ª IA:
  - em `aplicar`, a 1ª vira `stale` e não grava;
  - em `observar`, a 2ª recebe `already_played`.

  **Nunca há gravação dupla.** O custo do pior caso é uma 2ª chamada à IA.

## Gemini fora
- A tentativa nunca é gasta.
- Pausa de 2 min depois de 3 falhas seguidas do jogador na hora.
- Disjuntor global por até 5 min: conta só 5xx/429/timeout/rede, no máximo 1 por jogador por hora.
- **Custo para o jogador:** espera. Se a pausa atravessar a virada da hora, ele perde aquela hora e o streak por hora.
