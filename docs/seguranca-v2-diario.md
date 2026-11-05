# V2 — Desafio Diário: reserva atômica antes da IA

**Estado:** implementação LOCAL (05/11/2026) na branch `seguranca/v2-diario`, a partir de `master` `b7ee8d1`. Nada foi aplicado em banco, nada foi publicado, não há commit nem push. Projeto completo: `verbete-piloto-ia/PROJETO-SEGURANCA-IA-V1-V2-V3.md` (frente V2).

## O que muda
- `supabase/migrations/20261105150000_daily_guard_v2.sql`:
  - tabelas `daily_eval_claims` e `ai_quota`;
  - funções `daily_claim`, `daily_finish_ok` e `daily_finish_fail`;
  - modo `daily_guard_mode` (`desligado` | `observar` | `aplicar`), começando em **`observar`**.
- `src/lib/daily-guard.ts`: orquestração. Banco fora na reserva = **nenhuma IA** (fail-closed).
- `src/lib/daily.functions.ts`: reserva **antes** da IA; palavra e definição só são lidas quando a IA vai mesmo ser chamada.
- `src/lib/daily-input.ts`: o schema de entrada (sem identidade: o usuário vem da sessão).
- `src/integrations/supabase/types.ts`: tipos das 3 funções novas.

**O que não muda:**
- `submit_daily_attempt_scored` (pontuação, streak e conquistas), chamada na mesma transação de `daily_finish_ok`;
- a rubrica, o corte de 80 e as mensagens antigas.

**Mensagens novas** (só no modo `aplicar`):
- "em andamento";
- "muitas avaliações";
- "o desafio virou de hora";
- "avaliação descartada";
- "não foi possível registrar".

Todas dizem que a tentativa **não** foi gasta.

## Comportamento por modo
| Situação | `desligado` | `observar` (padrão) | `aplicar` |
|---|---|---|---|
| Primeira tentativa | fluxo antigo | reserva → IA → grava pelo claim | idem |
| Já jogou na hora | IA + `already_played` (antigo) | idem, com evento `would_block` | **sem IA**, `already_played` no formato atual |
| Duplo clique / outra aba | 2 IAs (antigo) | a 2ª segue o fluxo antigo, com evento | **sem IA** ("em andamento") |
| IA falha | tentativa não gasta | idem + contador de falhas | idem; depois de 3 falhas, pausa de 2 min; disjuntor global |
| Banco fora | IA chamada, gravação falha (antigo) | **sem IA** | **sem IA** |
| Hora vira durante a avaliação | grava na hora nova (antigo) | idem, com evento | **não grava**, tentativa não gasta |

## Ativação gradual (cada passo com autorização expressa)
1. **CI:**
   - testes de unidade;
   - `node scripts/test-daily-guard.mjs --pg` contra o Supabase local da CI, com **corrida real entre 10 conexões**;
   - registrar em `scripts/run-integration.mjs`.
2. **Migration** em produção (o modo já nasce `observar`). Conferir: tabelas com RLS e sem privilégios para anon/authenticated, funções só para `service_role`, cron de limpeza.
3. **Worker** (deploy).
4. **Observar por pelo menos 7 dias** (ou volume mínimo combinado). Relatório dos eventos `daily_guard`:
   - decisões e `would_block`;
   - **nenhum bloqueio que atingiria um jogador legítimo**.
5. **`aplicar`:**
   ```sql
   UPDATE public.app_config SET value = 'aplicar', updated_at = now() WHERE key = 'daily_guard_mode';
   ```
6. Acompanhar por 48 h. Ajustar limites só com autorização.

## Rollback
| Nível | Como | Efeito |
|---|---|---|
| Instantâneo | `UPDATE public.app_config SET value = 'desligado' … WHERE key = 'daily_guard_mode'` | O Worker novo volta ao fluxo antigo, idêntico |
| Worker | `npx wrangler rollback <versão anterior> --name jogo` | Código antigo |
| Banco | `supabase/rollback/daily_guard_v2.sql`, **depois** do Worker antigo (ou com o modo `desligado`) | Remove tabelas, funções, configuração e cron da V2. `daily_attempts`, `user_stats` e `user_achievements` intactos (testado) |

**Ordem de deploy obrigatória:** migration **antes** do Worker. Se o Worker for publicado sem a migration, `daily_claim` não existe e o Diário recusa por segurança (sem IA, tentativa não gasta) até a migration entrar ou o Worker voltar.

## Testes
- `npx vitest run src/lib/__tests__/daily-guard.test.ts` (orquestração, sem rede).
- `node scripts/test-daily-guard.mjs --pglite <pasta do @electric-sql/pglite>`: SQL real, offline, uma conexão.
- `DATABASE_URL=… node scripts/test-daily-guard.mjs --pg`: SQL real com corrida entre conexões. **Ainda não executado.**

## Revisão Red Team (05/11/2026) e situação
| Achado | Gravidade | Situação |
|---|---|---|
| A1: o rollback documentado derrubava o Diário | Alto | **Corrigido.** O script exige o Worker anterior; 'desligado' é a alternativa ao script |
| A2: Worker publicado antes da migration = Diário fora (fail-closed) | Alto | **Documentado** (ordem obrigatória). Antes do Worker, conferir no banco real `has_function_privilege('service_role', 'public.daily_claim(uuid,timestamptz,text)', 'EXECUTE')` e fazer uma chamada RPC de teste |
| A3: disjuntor abusável (resposta inválida induzida, várias falhas do mesmo jogador) | Alto | **Corrigido.** `invalid` não conta no disjuntor; só a 1ª falha transitória do jogador na hora conta. Meia-abertura fica pendente (antes de 'aplicar') |
| M1: brecha de tempo entre checagem e reserva sem linha; 'done' renovável | Médio | **Corrigido.** Trava consultiva por usuário/hora em `daily_claim` e `daily_finish_ok`; 'done' nunca é renovada |
| M2: `linha IS NOT NULL` falso com campo NULL | Médio | **Corrigido** (`FOUND`) |
| M3: sem limite por origem; contas anônimas multiplicam o teto | Médio | **Pendente** (precisa de hash com sal = segredo novo; decidir com a V3) |
| B1: hora do Worker × hora do banco | Baixo | **Corrigido.** A hora vem do banco |
| B2: 30 avaliações por dia contavam sucessos | Baixo | **Ajustado** para 48 (proposta) |
| B3: pausa, disjuntor ou reserva presa podem custar a hora e o streak por hora | Baixo | **Documentado.** Calibrar no período 'observar' |
| B4: mensagem quando a resposta da gravação se perde | Baixo | **Corrigido** (mensagem neutra) |
| B5: valores de configuração perigosos | Baixo | **Corrigido.** Mínimos seguros: TTL ≥ 20 s, limiar ≥ 1, limites ≥ 1, janela ≥ 60 s |
| B6: leituras do banco dentro do prazo da reserva | Baixo | **Documentado.** TTL de 45 s, folgado para 15 s de IA |
| B7: identificador do usuário em `ai_quota` e `daily_eval_claims` | Baixo | **Documentado.** Limpeza em 3 dias (cron). Incluir na exclusão de conta numa próxima rodada |
| B8: eventos recusados sem limite de ritmo | Baixo | **Documentado** |
| I1: função `ai_quota_window` morta | Info | **Removida** |
| I2: `search_path` sem `pg_temp` | Info | **Corrigido** |
| I3: fuso da sessão em UTC | Info | **NÃO VERIFICADO** no projeto |
| I4: `types.ts` editado à mão | Info | Regenerar com `supabase gen types` depois da migration |

**Antes de 'aplicar':**
- rodar `--pg` (corrida real, inclusive a brecha M1 com `pg_sleep`);
- meia-abertura do disjuntor;
- decidir o limite por origem;
- calibrar os limites com os eventos do período 'observar'.

## Respostas do Gate 1 (pré-PR)
- **O modo 'observar' NÃO protege.** É só observabilidade. Um desafio já respondido, ou um envio duplicado, devolve `pass_no_claim` e segue o **fluxo antigo**, que **chama a IA de novo**, exatamente como antes da V2. Os eventos `daily_guard` registram o que **seria** bloqueado. A proteção efetiva só existe em `'aplicar'`: já jogou, em andamento, pausa, disjuntor e limites recusam **sem IA**. A única mudança de comportamento em 'observar' é o fail-closed: banco fora = sem IA.
- **A reserva vale 45 s, não 30 s.** As leituras antes da IA têm prazo de 8 s (`DAILY_PREP_TIMEOUT_MS`) e a IA tem prazo de 15 s (`DAILY_BUDGET`). A 1ª avaliação termina em cerca de 23 s, antes de a reserva vencer, então uma 2ª avaliação paga **não começa com a 1ª ainda rodando**. Caso residual: se a **gravação** demorar mais de cerca de 20 s depois da IA, a reserva pode vencer e uma 2ª avaliação pode começar **depois** da 1ª IA (nunca simultânea); a 1ª vira 'stale' e não grava.
- **Gemini fora:**
  - a tentativa nunca é gasta;
  - o jogador entra em pausa de 2 min depois de 3 falhas seguidas na hora;
  - o disjuntor global recusa por até 5 min, e só conta 5xx/429/timeout/rede, no máximo 1 por jogador por hora;
  - **custo para o jogador:** espera. Se a pausa atravessar a virada da hora, ele perde aquela hora e o streak por hora. Calibrar no período 'observar'.
