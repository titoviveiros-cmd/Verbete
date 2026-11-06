# V3 mínima — guarda das Edge Functions de IA

**Estado (05/11/2026):** PR em **rascunho**, branch `seguranca/v3-edges`, base `master` `0c6476b`.
- **Sem merge, sem migration aplicada, sem deploy de Edge.** Nenhuma chamada à produção nem à IA foi feita.
- Projeto completo: `verbete-piloto-ia/PROJETO-SEGURANCA-IA-V1-V2-V3.md` (frente V3).

## Problema (auditoria de leitura, conferida no código)
- `supabase/config.toml`: `verify_jwt = false` em `bot-definitions`, `bot-definitions-v2` e `score-similarity` (necessário: convidados e o banco chamam).
- `bot-definitions` / `bot-definitions-v2`: o único gate era o `word_id` ser a palavra corrente de **alguma** sala em escrita. `rooms` é legível por anon, então qualquer um descobria um `word_id` ativo e chamava em laço — até **3 chamadas Gemini por pedido** na v2 (geração + regeneração + juiz). A v1 nem conferia se o `room_id` pedido era a sala da palavra (e gravava a memória da rodada nesse `room_id`).
- `score-similarity`: sem autenticação e sem olhar `rounds.judged_at` — repetir o pedido de uma rodada já julgada gastava **até 4 chamadas Gemini** a cada vez (o `apply_similarity_bonus` idempotente impedia só o +3 em dobro, não o custo).

## O que muda
| Arquivo | Mudança |
|---|---|
| `supabase/functions/_shared/room-guard.ts` | Lógica pura da guarda (modo, token, decisão, cota, evento). Sem Deno — testada no Vitest. |
| `supabase/functions/_shared/room-guard-deps.ts` | Acesso real (service role): `app_config`, `auth.getUser(token)`, `players`, `ai_quota_add`. Só Deno. |
| `supabase/functions/_shared/judge-guard.ts` | Lógica pura do "não julgar de novo" do `score-similarity`. |
| `supabase/functions/bot-definitions/index.ts` | `room_id` (quando enviado) precisa ser a sala com o `word_id` ativo; guarda antes de buscar a palavra e antes do Gemini. |
| `supabase/functions/bot-definitions-v2/index.ts` | Guarda antes de buscar a palavra e antes do Gemini (a v2 já filtrava a sala pelo `room_id`). |
| `supabase/functions/score-similarity/index.ts` | Lê `judged_at`, `judge_attempts`, `scored_at` na mesma consulta da rodada; rodada já julgada/desistida/velha não vai à IA. |
| `supabase/functions/_shared/ai.ts` | Só o tipo: novo `kind` de evento `ai_guard`. |
| `supabase/migrations/20261105180000_bots_auth_guard_v3.sql` | **Só configuração**: `bots_auth_mode = 'observar'` e `bots_ai_round_limit = '60'` (`ON CONFLICT DO NOTHING`) + `GRANT EXECUTE ON ai_quota_add TO service_role` (explícito; nada para anon/authenticated). |
| `supabase/rollback/bots_auth_guard_v3.sql` | Apaga as 2 chaves. |
| `src/lib/__tests__/room-guard.test.ts` | 50 testes de unidade da decisão. |
| `scripts/test-edges-e2e.mjs` | Casos V3 com as edges servidas de verdade contra o Supabase local da CI. |

**O que não muda:** client (web/APK), contrato das respostas de sucesso, pontuação, limiar 80 e +3 do juiz, memória da rodada/partida, reservas vetadas, `config.toml` (`verify_jwt` continua `false`).

### Guarda dos bots (`bot-definitions` e `-v2`), nesta ordem
1. **`room_id` obrigatório** → senão `room_required` (400). O client sempre manda (`WriteDefinition.tsx:100`, `room.ts:843`, `room.ts:987`).
2. **Sessão**: `Authorization: Bearer <jwt>` validado por `auth.getUser` (conta **ou** convidado anônimo). Sem token, chave anon, token vencido/forjado → `no_session` (401). Auth fora do ar → `auth_unavailable` (503).
3. **Membro**: linha em `players` com `room_id` = a sala da palavra, `user_id` = o usuário, `kicked_at IS NULL` → senão `not_member` (403).
4. **Cota**: `ai_quota_add('bots_round:<sala>:<rodada>', 86400)` > `bots_ai_round_limit` → `quota_exceeded` (429). Só conta quem passou de 1–3 (exatamente os pedidos que chegariam à IA em `aplicar`). Limite lido de `app_config`, limitado a [20, 1000], padrão 60 (12 jogadores × (💡 + sugestão automática + recargas) + bots do host).
5. Erro de banco na verificação → `guard_error` (503). A guarda nunca lança.

Bloqueio = corpo `{ error, definitions: [], fallbacks: [] }` com o status acima — o client já trata não-2xx (`functions.invoke` devolve `data: null`) caindo nas reservas locais, como já fazia com o 403 antigo.

### `score-similarity`
Antes de buscar palavra/verdade/candidatas, com a linha de `rounds` já lida:
- `judged_at` preenchido → `already_judged`;
- `judge_attempts >= 4` → `gave_up` (o reenvio desistiu);
- `scored_at` há mais de 30 min → `stale` (o reenvio do banco só atua nos primeiros 15 min).

Em `aplicar`: responde `{ matches: [], skipped: <motivo> }` **sem `error`** e sem IA. Para `retry_round_judgments` isso é "julgada", nunca nova tentativa. Nenhum caminho legítimo do banco chama a edge para uma rodada nesses estados (`fire_round_judge` só dispara com `judged_at` NULL; o reenvio só reenvia `judged_at` NULL, tentativas 0–3, nos primeiros 15 min). A chamada legítima do banco **continua com a chave anon** e sem usuário — o `score-similarity` não exige sessão.

## Modos (`app_config.bots_auth_mode`)
| Situação | `desligado` | `observar` (PADRÃO) | `aplicar` |
|---|---|---|---|
| Sem token / chave anon | fluxo antigo | IA chamada + evento `no_session` | **401, sem IA** |
| Jogador de outra sala | fluxo antigo | IA chamada + evento `not_member` | **403, sem IA** |
| Expulso | fluxo antigo | IA chamada + evento | **403, sem IA** |
| Sem `room_id` | fluxo antigo | IA chamada + evento `room_required` | **400, sem IA** |
| Cota da sala/rodada esgotada | fluxo antigo | IA chamada + evento `quota_exceeded` | **429, sem IA** |
| Convidado/conta da própria sala | fluxo antigo | normal | normal |
| Juiz: rodada já julgada/desistida/velha | IA chamada | IA chamada + evento | **sem IA**, `skipped` |
| Custo extra por pedido | 1 leitura | 1 leitura + `getUser` + 1 consulta + 1 RPC | idem |

- **`observar` NÃO protege**: é só observabilidade. Nada é bloqueado; os eventos mostram o que `aplicar` bloquearia.
- Valor ausente, inválido ou leitura falha = **`observar`**. Nunca vira `aplicar` sozinho.
- Mudança de modo vale no pedido seguinte (lido a cada pedido, sem cache, sem deploy).
- Exceção em `desligado`: a v1 passa a exigir que o `room_id` enviado seja a sala da palavra (a v2 já exigia). O client legítimo sempre manda a sala certa.

**Telemetria:** `ops_events.kind = 'ai_guard'` com `{ fn, mode, decision, blocked }`. Só quando a decisão não é `ok` (o `ok` já aparece no `bot_ai_*`). Sem usuário, sala, token, palavra ou texto.

Consulta para o período de observação (read-only, rodar só com autorização):
```sql
SELECT payload->>'fn' AS fn, payload->>'decision' AS decisao, payload->>'mode' AS modo, count(*)
  FROM public.ops_events
 WHERE kind = 'ai_guard' AND at > now() - interval '24 hours'
 GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

## Ordem de deploy segura (cada passo com autorização própria)
0. **Pré-requisito:** a migration da V2 (`20261105150000_daily_guard_v2.sql`) aplicada em produção — a V3 usa `public.ai_quota` e `ai_quota_add`. **NÃO VERIFICADO nesta rodada.** Sem ela a migration V3 falha no `GRANT` (função inexistente) — não aplicar fora de ordem.
1. **Migration** V3 (`supabase db push` ou SQL Editor): só cria as 2 chaves em `observar`. Sem efeito até as edges novas entrarem.
2. **Edges** (`supabase functions deploy bot-definitions bot-definitions-v2 score-similarity`), já em `observar`. O `config.toml` mantém `verify_jwt = false`.
3. **Smoke** em `observar`: uma partida com convidado + bots; conferir `bot_ai_success` normais e **nenhum** `ai_guard` com `not_member`/`no_session` vindo de jogo legítimo; uma rodada com bônus 🧠 julgada normalmente.
4. **Observar N dias** (sugestão: ≥ 3 dias com partidas reais). Critério para seguir: `ai_guard` de partidas legítimas ≈ 0 (`no_session`, `not_member`, `room_required`, `quota_exceeded`); `guard_error`/`auth_unavailable` = 0; latência dos bots sem piora perceptível no `bot_ai_*.latency_ms`.
5. **Aplicar**: `UPDATE public.app_config SET value = 'aplicar', updated_at = now() WHERE key = 'bots_auth_mode';` e repetir o smoke.

## Rollback
- **Imediato, sem deploy:** `UPDATE public.app_config SET value = 'desligado', updated_at = now() WHERE key = 'bots_auth_mode';` → as edges novas voltam ao fluxo antigo no pedido seguinte. (`observar` também já não bloqueia nada.)
- **Edges:** reimplantar as 3 functions a partir do commit anterior (`master` `0c6476b`), por exemplo num worktree desse commit.
- **Migration:** `supabase/rollback/bots_auth_guard_v3.sql` (apaga as 2 chaves) — **só depois** das edges anteriores no ar ou com o modo em `desligado`; com as edges novas e as chaves apagadas o modo vira `observar` (não bloqueia). O `GRANT` não é revogado (já vinha dos privilégios padrão do Supabase e a V2 pode depender dele). Nenhum dado de jogo é tocado.
- **Rollback da V2 com a V3 no ar:** o script da V2 apaga `ai_quota_add`. Antes, pôr a V3 em `desligado` (senão `aplicar` vira `guard_error`/503 nos bots; em `observar` só gera eventos).

## Riscos e limites
| Risco | Impacto | Evidência / prevenção | Situação |
|---|---|---|---|
| APK/web antigo sem sessão | Em `aplicar`, sugestões e bots desse client caem nas reservas locais (sem IA). Jogo segue. | Desde o M1 o servidor recusa ações de jogador sem sessão (`session_required`, `src/lib/auth-session.ts`), e o client abre sessão anônima antes de entrar na sala. `functions.invoke` envia o token da sessão. Medir em `observar` (`no_session`). | Mitigado; medir |
| Token vencido sem refresh | Mesma degradação (reservas locais) só para aquele jogador. | supabase-js renova sozinho; `observar` mede. | Aceito |
| Jogador que troca de conta no meio da partida (`players.user_id` antigo) | `not_member` → reservas locais. As ações de jogo dele já falham pela guarda de identidade do M1. | `assert_actor_identity`. | Aceito (consistente) |
| Membro malicioso esgota a cota da própria sala | Bots e 💡 daquela sala/rodada caem nas reservas locais até a rodada virar. | Cota por sala/rodada (limite de custo); por usuário fica para depois. | Aceito |
| Atacante cria salas próprias com bots | Ainda gasta IA, mas no máximo `bots_ai_round_limit` pedidos por sala/rodada e só durante a escrita de partida que ele mesmo conduz. | Próximo passo: cota por usuário/hora em `ai_quota` (mesmo padrão). | Residual |
| `score-similarity` ainda público | Pode ser chamado para rodada em julgamento (janela de segundos até `judged_at`) — no máx. as mesmas 4 chamadas que o reenvio do banco já faria. | `judged_at`/`gave_up`/`stale`. | Residual pequeno |
| Script manual de re-julgamento (`scripts/retro-pindaiba.mjs`) | Em `aplicar`, re-julgar rodada já julgada vira `skipped`. | Para uso manual: modo `desligado` temporário ou `judged_at = NULL` naquela rodada. | Documentado |
| Latência extra | `getUser` + 1 consulta + 1 RPC antes da IA (estimativa não medida). | Medir em `observar` pelo `latency_ms`. | NÃO VERIFICADO |
| Virada da janela da cota (0h UTC) | Contador da sala/rodada recomeça uma vez. | Chave já é por rodada; janela de 1 dia. | Aceito |

## Verificação
- **Local (CONFIRMADO, 05/11):** `npx tsc --noEmit` limpo; `npx eslint` no teste novo limpo (as edges ficam fora do eslint do projeto); `npx vitest run` 65 arquivos / 723 testes (50 novos em `room-guard.test.ts`); `node scripts/ci-deno-check.mjs` → DENO CHECK OK nas 3 edges.
- **Só na CI (sem Docker local):** `scripts/test-edges-e2e.mjs` (job `integration`, Supabase local) com os casos V3: sem token/chave anon → 401 sem IA; outra sala → 403 sem IA; sem `room_id` → 400; expulso → 403; cota → 429 sem IA; convidado anônimo da própria sala → 200 com IA; `observar`/modo inválido/`desligado` não bloqueiam; `score-similarity` em `aplicar` não chama a IA para rodada já julgada; **a cadeia inteira do banco (pg_net, reenvios, desistência, cenários A–G) roda em `aplicar`**; `ai_quota_add` só para `service_role`.
