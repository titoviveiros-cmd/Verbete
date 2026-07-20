# Auditoria de Segurança — RPCs SECURITY DEFINER e Identidade (Fase 1 · parte 4)

**Data:** 2026-07-19 · **Banco auditado:** produção (`wspztmimctgbjcmyzexn`) · **Funções auditadas:** 51 SECURITY DEFINER em `public`

## Metodologia

1. Inventário vivo via `scripts/audit-secdef.mjs` (pg_proc + routine_privileges): search_path, grants, locks, checagens de fase, uso de `auth.uid()`.
2. Leitura do corpo (`pg_get_functiondef`) das funções de ação e de join/create.
3. Enforcement testado contra produção com JWTs simulados (`SET LOCAL request.jwt.claims`) — `scripts/test-identity.mjs`, **13/13**.
4. Regressão do motor com rodada completa via REST anônimo sem sessão — `scripts/test-e2e-round.mjs`, **12/12**.

## Resultado do inventário (agregado)

| Propriedade | Situação |
|---|---|
| `SET search_path` fixado | **51/51** ✅ (nenhuma vulnerável a hijack de schema) |
| `FOR UPDATE` nas transições de fase | ✅ todas (`advance_*`, `cast_vote*`, `choose_word`, `start_game`, `extend_*`, `finish_reveal`, `host_update_room_config`) |
| Checagem de fase/status | ✅ em todas as funções de ação de jogo |
| Grants restritos a service (`postgres,service_role`) | `apply_similarity_bonus`, `get_app_config`, `submit_daily_attempt*`, `cleanup_zombie_rooms`, `tick_stalled_rooms`, `handle_new_user`, `advance_choosing_to_writing` ✅ |
| Trigger functions sem EXECUTE de clients | corrigido nesta parte (`guard_*`, `assert_actor_identity`, `guard_author_identity`) |

## Modelo de identidade (S4) — implementado em `20260722100000` + `20260722110000`

**Princípio:** a linha de `players` é **reivindicada no join/create** (`user_id = auth.uid()`), nunca "na primeira ação" — os `player_id`s são visíveis a toda a sala via `get_room_state`, então claim tardio permitiria roubar a linha do host.

| Camada | Mecanismo |
|---|---|
| Join/create | `rejoin_room`, `create_room_with_host`, `join_public_room` gravam `user_id = auth.uid()`; id já reivindicado por outro uid → `player_id_taken` (client gera novo id e tenta 1×) |
| Autoria (defesa em profundidade) | Trigger `guard_author_identity` BEFORE INSERT em `votes`, `definitions`, `room_messages`, `reactions` — cobre RPCs **e** qualquer caminho direto via RLS. Em `votes`, linha forjada é **descartada** (não aborta `cast_votes_bulk`); nas demais, exceção `identity_mismatch` |
| Ações com ator | `kick_player`, `assign_player_team`, `host_update_room_config`, `send_reaction`, `send_room_message` validam `p_actor/p_player` via `assert_actor_identity` (verify-only) |
| Ações de host sem ator | `start_game`, `reset_room` validam `auth.uid()` contra o `user_id` do host da sala |
| Client | `ensureAnonSession()` no boot e antes de create/join; `claim_player_identity` após entrar; auto-recuperação em `player_id_taken` |

**Fallback documentado:** `auth.uid() IS NULL` (anonymous sign-in desativado, cron `tick_stalled_rooms`, edge functions com service key, clients antigos) → todas as guardas liberam; comportamento idêntico ao pré-parte-4. **A proteção liga sozinha ao habilitar Authentication → Sign In/Up → Anonymous sign-ins no dashboard.**

## Bug encontrado e corrigido pela suíte

`guard_author_identity` v1 usava `CASE WHEN TG_TABLE_NAME='votes' THEN NEW.voter_id ELSE NEW.player_id END`. Em PL/pgSQL os campos de `NEW` são resolvidos na preparação da expressão inteira (mesmo no ramo morto) → `record "new" has no field "voter_id"` em **qualquer** insert de definitions/messages/reactions. Corrigido em `20260722110000` com `to_jsonb(NEW)->>'...'`.

## Riscos residuais aceitos (com plano)

| Risco | Severidade | Mitigação futura |
|---|---|---|
| Linhas legadas com `user_id NULL` seguem sem enforcement até o próximo rejoin | baixa | expira naturalmente; salas são efêmeras |
| Bots são orquestrados pelo client do host (sem identidade própria); qualquer sessão pode escrever como bot da sala | baixa | mover orquestração de bots para o servidor (Fase 2+) |
| `choose_word`, `extend_*`, `advance_*` (nudges) sem checagem de ator — gated só por sala+fase+lock | baixa | por design: são idempotentes e o cron faria o mesmo |
| Login (e-mail/Google) no meio da sala troca o uid → ações bloqueadas até re-join | baixa | usar `linkIdentity` para converter anônimo→conta preservando o uid (Fase 2) |
| Fallback direto `players.upsert` no client quando `rejoin_room` falha por outro motivo | baixa | remover fallback legado após período de observação |
| `user_id` é uuid livre (sem FK a `auth.users`) | info | claim só grava `auth.uid()` real; FK opcional em migration futura |

## Evidências

- `scripts/test-identity.mjs` — 13/13 (forja de mensagem/definição/voto, sequestro de id no rejoin/create, reset/start/kick por não-host, fallbacks sem sessão e legado, claim no rejoin).
- `scripts/test-e2e-round.mjs` — 12/12 (rodada completa REST anônimo: pontuação original +3/+1 exata, fases corretas).
- Probes anteriores da Fase 1 (partes 1–3): `scripts/probe-security.mjs`, `probe-stats.mjs`, `probe-ballot.mjs` — colunas sensíveis de `words` e leitura de `definitions` seguem revogadas.
