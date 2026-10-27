# Exclusão de conta e retenção — auditoria do comportamento real

> Rodada 2A da conformidade Google Play · 27/10/2026 · base `7413031`
> (master após o PR #26) · branch `compliance/play-legal-data`.
> Fontes: migrations em `supabase/migrations/`, `src/lib/account-deletion.ts`
> (antes `src/lib/account.functions.ts`), `src/routes/profile.tsx`. **Nenhuma
> consulta ao banco de produção** — volumes reais NÃO VERIFICADOS.

## 1. Como a exclusão roda

- **Caminho no app/site:** Perfil → Zona de perigo → **Excluir** → digitar o
  nome exibido → **Excluir tudo** → server function `deleteAccount`
  (`requireSupabaseAuth`) → `deleteAccountData` → o app faz `signOut` e volta
  à Home **só depois** de o servidor confirmar.
- **Quem pode:** qualquer sessão, inclusive a **anônima** (convidado): a Home
  mostra "Perfil" sempre que há sessão (`useAuth` não filtra `is_anonymous`,
  `src/routes/index.tsx:431`), e toda visita abre uma sessão anônima no boot
  (`src/routes/__root.tsx:268-272`).
- **Ordem (depois desta rodada):** `match_history` → (`daily_attempts`,
  `user_achievements`, `user_stats`, `profiles`) → `auth.admin.deleteUser`.
  Qualquer erro interrompe **antes** de apagar o login.

## 2. Mapa: o que cada tabela guarda e o que acontece

| Dado (tabela) | Identificador | FK para a conta | Na exclusão | Depois | Evidência |
|---|---|---|---|---|---|
| Conta (`auth.users`) | id (UUID) | — | apagada (`deleteUser`) | — | account-deletion.ts |
| Identidades de login (Google), sessões | user_id | interna do Supabase | apagadas junto (padrão do Supabase Auth) | — | **NÃO VERIFICADO em produção** |
| `profiles` (nome exibido, avatar, cor) | user_id | CASCADE | apagada | — | 20260510124439:4 |
| `user_stats` (XP, nível, vitórias) | user_id | CASCADE | apagada | — | 20260510124439:20 |
| `match_history` | user_id | CASCADE | apagada | — | 20260510124439:36 |
| `daily_attempts` (palpites) | user_id | **nenhuma** | apagada | (antes: podia sobrar órfã) | 20260517134408:20-30 |
| `user_achievements` | user_id | **nenhuma** | apagada | (antes: podia sobrar órfã) | 20260517134408:63-69 |
| `user_roles` (só admin) | user_id | nenhuma | **fica** | papel de conta inexistente | 20260518221956:11-17 |
| `players` (apelido, avatar, cor, pontuação) | `id` = player_id; `user_id` | **nenhuma** | **fica** | apelido + `user_id` da conta apagada + player_id | 20260720120000:25 |
| `definitions` (textos) | player_id | → rooms (CASCADE) | **fica** | só os da última partida de cada sala | 20260510003432:42-52 |
| `votes` | voter_id | → rooms | **fica** | idem | 20260510003432:55-63 |
| `reactions` | player_id | → rooms | **fica** | não é apagada nem na revanche | 20260510003432:66-72 |
| `rounds.coordinator_id`, `round_extensions` | player_id | → rooms / nenhuma | **fica** | até a sala começar outra partida | 20260510020212, 20260517204253 |
| `rooms.host_id`, `current_coordinator` | player_id | — | **fica** | — | 20260510003432:13-25 |
| `room_messages` (chat, desativado em 20/10) | player_id + texto | → rooms | **fica** | mensagens antigas guardadas | 20260713130000:19-25 |
| `room_presence` | player_id | nenhuma | fica | **apagada após 2 dias** | 20261021180000:928-930 |
| `room_words` (palavra própria, recurso morto) | created_by | nenhuma | fica | linhas antigas (UI removida 19/07; sem escrita desde o M1) | 20260518234116 |
| `reports` (denúncias) | reporter_user_id, offender_user_id, offender_player_id, offender_nickname, trecho | **nenhuma** | **fica** | registro de moderação | 20260518221956:46-66 |
| `banned_players` | player_id e/ou user_id | nenhuma | **fica** | banimento por aparelho segue valendo | 20260518221956:92-102 |
| `ops_events` (telemetria) | hash de sessão/sala | — | fica | **apagada após 30 dias** | 20261021180000:786 |
| Sessões anônimas anteriores da mesma pessoa | outro UUID | — | **não são tocadas** | cada uma com perfil + stats próprios | `handle_new_user` 20260510124439:51-71 |
| Aparelho (`localStorage`) | player-id, apelido, avatar, cor, tema, aceite | — | fica no aparelho | não é dado do servidor | src/lib/player-id.ts |

## 3. Respostas objetivas

- **A) O que é apagado:** conta de login (e, pelo padrão do Supabase, as
  identidades e sessões), perfil, estatísticas/XP/nível (e a posição no
  ranking), conquistas, histórico de partidas, palpites do Desafio.
- **B) O que permanece:** tudo o que é da sala (`players`, `definitions`,
  `votes`, `reactions`, `rounds`, `round_extensions`, `rooms.host_id`,
  `room_messages` antigas), denúncias e banimentos, `user_roles` (admin),
  sessões anônimas anteriores, telemetria por até 30 dias, presença por até
  2 dias.
- **C) Com `user_id`:** `players.user_id`, `reports.reporter_user_id`,
  `reports.offender_user_id`, `banned_players.user_id`, `user_roles.user_id`.
- **D) Com `player_id`:** `players.id`, `definitions.player_id`,
  `votes.voter_id`, `reactions.player_id`, `rounds.coordinator_id`,
  `round_extensions.player_id`, `rooms.host_id/current_coordinator`,
  `room_messages.player_id`, `room_presence` (2 dias), `room_words.created_by`,
  `reports.offender_player_id`, `banned_players.player_id`.
- **E) Identificável por apelido:** `players.nickname` (+ avatar/cor) em cada
  sala e `reports.offender_nickname`; as definições, votos e reações ligam-se ao
  apelido pelo player_id dentro da sala.
- **F) Definições permanecem?** **Sim** — as da última partida de cada sala
  (`start_game` e `reset_room` apagam as da partida anterior na MESMA sala:
  20261020220000:41-44, 20260722100000:442-445). Sem prazo.
- **G) Denúncias permanecem?** **Sim**, sem FK e sem limpeza.
- **H) ON DELETE:** CASCADE só em `profiles`/`user_stats`/`match_history`
  (→ `auth.users`) e nas tabelas de sala (→ `rooms`, que nunca são apagadas).
  **Nenhum SET NULL.** Sem FK: `players.user_id`, `daily_attempts`,
  `user_achievements`, `reports`, `banned_players`, `user_roles`,
  `room_presence`, `room_words`, `round_extensions`.
- **I) Limpeza automática:** só `ops_events` (30 d), `ops_alerts` (90 d) e
  `room_presence` (2 d). `cleanup_zombie_rooms` (cron de 1 min via
  `tick_stalled_rooms`) só marca salas como `finished` — **nunca apaga**
  (20261021180000:816-947). Cron jobs existentes: `verbete-tick-stalled-rooms`,
  `verbete-ops-health`, `verbete-judge-retry`.
- **J) Prazo real de retenção:** nenhum para salas, denúncias, banimentos e
  sessões anônimas; 30 dias para telemetria; 2 dias para presença.
- **K) Exclusão parcial:** **antes** desta rodada os erros das etapas 1–2
  eram ignorados (o login era apagado mesmo assim; `daily_attempts` e
  `user_achievements` podiam sobrar órfãs com o `user_id`) e, se o
  `deleteUser` falhasse depois de apagar os dados, o app dizia "nada foi
  apagado" (falso). **Agora:** fail-closed (`src/lib/account-deletion.ts`),
  repetível, mensagem honesta. Resta: não há transação entre as etapas — uma
  falha no meio deixa parte apagada, mas a conta continua e o pedido pode ser
  repetido.

## 4. Divergência com o texto anterior

- **Política, Suporte e comentário do `deleteAccount` diziam:** "nas salas
  fica só o apelido, sem vínculo com a conta".
- **Real:** ficam apelido, avatar, cor, pontuação, definições, votos, reações,
  o player_id e o **UUID da conta apagada** em `players.user_id` (não aponta
  mais para conta nenhuma, mas liga as linhas da mesma pessoa entre salas e às
  denúncias) — dado **pseudonimizado, não anônimo**.
- **Classificação:** divergência material (P1). **Corrigida nos textos**
  (`/privacy`, `/support`, `/delete-account`). O código não foi mudado: zerar
  `players.user_id` tem efeito colateral — `rejoin_room` e
  `assert_actor_identity` tratam `user_id` nulo como lugar "não reivindicado",
  e qualquer sessão com o player_id (público na sala) assumiria o lugar ou o
  host numa sala reaberta. Decidir junto com a retenção (seção 6).

## 5. Riscos

| Nível | Risco | Situação |
|---|---|---|
| P1 | Textos prometiam "só o apelido" | corrigido nos textos |
| P1 | Exclusão parcial silenciosa (erros ignorados) | corrigido em código + 8 testes |
| P1 | Cadastro sem nome (e, pelo código, todo cadastro via Google) recebe como nome exibido a parte do e-mail antes do @ (`handle_new_user`), que aparece no ranking público e é legível por qualquer sessão (`profiles authenticated read`) | **PARADO: exige migration** (trigger usar "Jogador" ou o nome do Google). Divulgado na Política. Comportamento do Google em produção NÃO VERIFICADO |
| P2 | Sessões anônimas (auth.users + perfil + stats) nunca expiram; cada navegador/limpeza cria outra; abrir `/privacy` ou `/delete-account` também cria | decisão de retenção (migration/cron) |
| P2 | Salas sem prazo | seção 6 |
| P2 | `user_roles` do admin não é apagado | só afeta o administrador |
| P2 | Servidor não confere avatar contra a lista (corta em 16 caracteres) nem filtra apelido (corta em 24) | denúncia de jogador desta rodada cobre o apelido |

## 6. Retenção das salas — opções (NÃO implementado; decisão do proprietário)

**Estado real:** salas nunca são apagadas; terminam como `finished`. Junto
ficam `players`, `definitions` e `votes` da última partida, todas as
`reactions`, `rounds`, `round_extensions`, `room_messages` antigas e
`ai_served_defs`. Denúncias guardam o próprio retrato (texto, apelido, código
da sala) e não dependem da sala.

| | A — curta (7 dias após `finished`) | B — intermediária (30 dias) | C — longa (180 dias) |
|---|---|---|---|
| Técnico | função de limpeza + cron (ou estender `cleanup_zombie_rooms`); `DELETE FROM rooms` leva por CASCADE `players`, `definitions`, `votes`, `reactions`, `rounds`, `room_messages`, `ai_served_defs`; apagar à parte `round_extensions`, `room_words`, `room_presence` (sem FK) | igual a A | igual a A |
| Moderação | denúncia só nasce durante a partida; o painel precisa revisar em até 7 dias para ver a sala (o retrato na denúncia continua) | folga confortável para revisar | máxima |
| Histórico/debug | investigar partida antiga só até 7 dias | igual à telemetria (30 dias) — coerente | investigação longa |
| Privacidade | melhor | boa | fraca |
| Custo | menor banco | baixo | cresce com o uso |
| Migration/cron | sim | sim | sim |

**Recomendação técnica:** **B (30 dias)**, coerente com a telemetria; aplicar
a todas as tabelas de sala; tratar à parte (decisão própria) a retenção de
`reports`/`banned_players` e a limpeza de sessões anônimas inativas. Depois de
decidir, atualizar `/privacy`, `/delete-account` e a licença dos Termos com o
prazo real.
