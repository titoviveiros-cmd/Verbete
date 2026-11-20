# Conquistas — regras alinhadas ao catálogo (proposta, 19/11/2026)

Branch `feat/conquistas-regras` (local). Migration `supabase/migrations/20261119120000_conquistas_regras.sql`
(**preparada, não aplicada**), rollback `supabase/rollback/conquistas_regras.sql`, gerador
`scripts/gerar-conquistas-regras.mjs` (parte dos corpos reais de produção — o md5 do corpo original
extraído de `submit_daily_attempt_scored` confere com o fixado de produção, `e41b8c87`), testes
`scripts/test-conquistas-regras.mjs` (PGlite isolado, sessão em UTC como o Supabase).

## 1. Matriz das 15 conquistas

| Código           | Descrição (catálogo)                            | Condição real hoje                                                                     | Rotina que concede                                                                                                              | Correção                                                                                                  |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| first_win        | Vença sua primeira partida.                     | `games_won >= 1`                                                                       | `record_match_result`                                                                                                           | nenhuma                                                                                                   |
| partidas_10      | Jogue 10 partidas multiplayer.                  | `games_played >= 10`                                                                   | `record_match_result`                                                                                                           | nenhuma                                                                                                   |
| acertos_100      | Acerte a definição verdadeira 100 vezes.        | `total_truth_hits >= 100`                                                              | `record_match_result`                                                                                                           | nenhuma                                                                                                   |
| bluffs_100       | Engane jogadores 100 vezes com suas definições. | `total_fooled >= 100` (votos recebidos em definições falsas)                           | `record_match_result`                                                                                                           | nenhuma                                                                                                   |
| invicto_3        | Vença 3 partidas seguidas.                      | `win_streak >= 3`                                                                      | `record_match_result`                                                                                                           | nenhuma                                                                                                   |
| maior_enganador  | Engane 5 ou mais jogadores numa única partida.  | ≥ 5 **votos** de outros nas suas falsas na partida (mesma pessoa em 2 rodadas conta 2) | `record_match_result`                                                                                                           | manter critério; descrição → "Receba pelo menos 5 votos nas suas definições falsas em uma única partida." |
| truth_seeker     | Acerte a definição verdadeira 10 vezes.         | **nenhuma regra** (inalcançável)                                                       | —                                                                                                                               | `total_truth_hits >= 10` em `record_match_result`                                                         |
| coordinator_5    | Coordene 5 rodadas.                             | **nenhuma regra**                                                                      | —                                                                                                                               | `rounds_coordinated >= 5` em `record_match_result`                                                        |
| big_score        | Faça 30+ pontos em uma única partida.           | **nenhuma regra**                                                                      | —                                                                                                                               | pontuação final da partida `>= 30` em `record_match_result`                                               |
| bluff_master     | Receba 5+ votos em uma única definição falsa.   | **nenhuma regra**                                                                      | —                                                                                                                               | maior nº de votos (de outros) numa **única** definição falsa sua na partida `>= 5`                        |
| social_butterfly | Jogue com 10 oponentes diferentes.              | **nenhuma regra**                                                                      | —                                                                                                                               | **proposta (§3), sem implementação**: exige armazenamento novo                                            |
| first_daily      | Complete seu primeiro desafio diário.           | 1ª participação no Diário                                                              | `submit_daily_attempt_scored` (juiz, via `daily_finish_ok`) e `daily_record_participation` (escolha, via `daily_choice_finish`) | concessão idempotente                                                                                     |
| streak_3         | Jogue 3 dias seguidos.                          | 3 **horas** seguidas                                                                   | idem                                                                                                                            | 3 **dias** (Brasília)                                                                                     |
| streak_7         | Jogue 7 dias seguidos.                          | 7 **horas** seguidas                                                                   | idem                                                                                                                            | 7 dias                                                                                                    |
| streak_30        | Jogue 30 dias seguidos.                         | 30 **horas** seguidas                                                                  | idem                                                                                                                            | 30 dias                                                                                                   |

Produção (leitura de 18/11): catálogo = migrations; streak_3/7/30, truth_seeker, coordinator_5,
big_score, bluff_master, social_butterfly, partidas_10, acertos_100, bluffs_100 com 0 concessões.

## 2. Regras propostas (implementadas na migration)

- **Sequência do Diário**: conta **dias de calendário no horário de Brasília (`America/Sao_Paulo`)**, a
  partir da hora do desafio **no servidor** (o relógio do cliente não decide). Uma participação
  concluída conta, acertando ou não; várias no mesmo dia não somam; o dia seguinte soma 1; um dia
  sem participação recomeça em 1. O **mesmo trecho** (byte a byte, conferido em teste) nos dois
  caminhos ativos: juiz e escolha. Fuso: o projeto já usa `America/Bahia` (mesmo UTC−3) só para
  exibir horários de operação; a regra usa o fuso oficial `America/Sao_Paulo`.
- **Concessões do Diário idempotentes**: `INSERT … ON CONFLICT (user_id, achievement_code) DO NOTHING`
  (a tabela já é única): repetição ou concorrência não abortam a jogada nem duplicam, e só entram
  em `unlocked` as conquistas realmente novas.
- **Partida**: 4 metas novas no mesmo laço de `record_match_result` (já protegido por trava por
  usuário+sala e por dedupe em `match_history`).
- **Nada muda** em pontuação, XP, `total_score`, demais estatísticas, permissões e conquistas já
  concedidas (testado, inclusive XP/estatísticas iguais às da função original).

## 3. Borboleta Social — proposta (não implementada)

- Identidade comprovável: `players.user_id` (conta autenticada, inclusive convidado anônimo) com
  `is_bot = false` e `user_id <> eu`. **Bots não contam** ("oponentes" = pessoas). Apelido e
  quantidade de participantes **não** servem.
- As salas (com `players`) são apagadas 30 dias depois → precisa de registro próprio. Opção A
  (recomendada): tabela `user_opponents(user_id, opponent_hash, primeiro_em)` com
  `opponent_hash = hmac(user_id do oponente)` (não guarda quem é, só que é distinto), PK
  `(user_id, opponent_hash)`, preenchida em `record_match_result`; concede com `count(*) >= 10`.
  Opção B: só um contador, sem distinguir pessoas — **não** atende "diferentes".
- Retroativo: só o que estiver nas salas ainda guardadas (últimos 30 dias).
- Decisões: aprovar a opção A, se convidados anônimos contam e a retenção/expurgo da tabela (LGPD/ECA).

## 4. Conversão dos contadores (horas → dias)

- Antes de mudar, cópia de `current_streak/best_streak/last_played_*` em
  `public.conquistas_streak_horas_bkp` (RLS ligada, sem acesso de cliente; usada pelo rollback).
- Quem tem histórico em `daily_attempts`: `current/best/last_played_date` **recalculados em dias**
  (Brasília) a partir do histórico — não é "horas viram dias".
- Quem não tem histórico no Diário: sequência zerada (o valor em horas não prova dias).

## 5. Concessão retroativa (proposta, NÃO incluída na migration)

| Conquista                                                                                      | Prova disponível                                      | Proposta                                                                 |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| streak_3/7/30                                                                                  | `daily_attempts` (mantido para contas registradas)    | conceder a quem a maior sequência **recalculada em dias** atingir 3/7/30 |
| truth_seeker                                                                                   | contador `total_truth_hits`                           | conceder com `>= 10`                                                     |
| coordinator_5                                                                                  | contador `rounds_coordinated`                         | conceder com `>= 5`                                                      |
| big_score                                                                                      | `best_match_score`                                    | conceder com `>= 30`                                                     |
| bluff_master                                                                                   | votos/definições só das salas dos **últimos 30 dias** | só os casos comprováveis nesse período                                   |
| social_butterfly                                                                               | —                                                     | depende do §3                                                            |
| Antes de aplicar: rodar uma contagem **só de leitura** (quantos ganhariam cada uma) e decidir. |

## 6. Testes

### 6a. Isolados — `node scripts/test-conquistas-regras.mjs --pglite <pasta>` → 25/25

Mesmo dia (várias jogadas), virada do dia em Brasília (02:00Z × 03:00Z), dia perdido, limites
exatos (3º, 7º, 30º dia; 10 acertos; 5 rodadas; 30 pontos; 5 votos numa única definição × 4+4),
repetição e "concorrente que já concedeu" sem duplicar nem abortar, partida repetida (dedupe),
pontuação/XP/estatísticas iguais às da função original, conversão pelo histórico, backup,
permissões preservadas e rollback (corpos de produção byte a byte, descrição e contadores
restaurados, conquistas mantidas). Mutações pegas: fuso em UTC, sem `ON CONFLICT`, Mestre do Blefe
pelo total da partida. Limite: PGlite tem 1 conexão; corrida real só no Postgres do CI.
Ciclo do rollback: migration → Diário e partida **depois** dela → rollback → conferência (XP,
pontuação, estatísticas, conquistas e tentativas idênticos; sequência em horas continuada) → jogada
com a função antiga (+1 sem quebra). Mutação pega: o rollback antigo (só restaurava o backup) falha 2.

### 6b. Postgres real (CI) — `scripts/test-conquistas-corrida.mjs` (em `run-integration.mjs`)

- Corrida: 2 conexões, a 2ª **bloqueada** enquanto a 1ª segura a transação (simultaneidade
  comprovada); escolha × escolha, escolha × juiz, rajada de 8 conexões e Em Chamas sob corrida →
  1 linha, 0 erros, só uma chamada relata a conquista.
- Controle: o mesmo arranjo derruba uma concessão **sem** `ON CONFLICT` (unique_violation 23505) e
  passa com ela — a janela de corrida é real e o teste a enxerga.
- Rollback ensaiado dentro de uma transação desfeita no fim: progresso preservado, sequência em horas
  continuada, corpo de produção da pontuação devolvido (md5 `e41b8c87`) e o banco do CI intacto depois.
- Achado: nas funções reais do Diário, a trava da linha de `user_stats` (UPDATE) já serializa duas
  jogadas do mesmo usuário antes da concessão; o `ON CONFLICT` é a segunda barreira.

Ajustes em testes existentes: `scripts/test-daily-choice.mjs` fixa o md5 do corpo da pontuação do juiz
(`e41b8c87`); com esta migration o corpo muda (só sequência e concessões) → `a6242f5b`.
`test-daily-guard.mjs` (12) e `test-daily-choice.mjs` (11/17, 10/13): cenários "jogou na hora
anterior" → "jogou no dia anterior" (mesmas asserções); o PGlite carrega os corpos vigentes.

## 7. Implantação (janela SEPARADA da observação do B4)

1. PR com CI (integração em Postgres real, inclusive corrida). 2. Backup cifrado + restauração.
2. Dry-run = só `20261119120000`. 4. Aplicar fora das 24 h de observação do B4 (a migration
   mexe nas duas funções do Diário). 5. Smoke: Diário juiz/escolha numa conta de teste, partida com
   bots, perfil. 6. Retroativo (§5) em passo próprio, com contagem prévia e autorização.
   Rollback: `supabase/rollback/conquistas_regras.sql` + `migration repair --status reverted 20261119120000`.
   O rollback devolve os corpos e a descrição; a sequência volta ao backup **mais** o Diário jogado
   depois (recontado em horas pela regra antiga); XP, pontuação, estatísticas de partida e conquistas
   não são tocados. Condição: só depois de concluída e homologada a observação de 24 h do B4.

## Revanche e código reaproveitado (20/11/2026)

Auditoria P1: `record_match_result` deduplicava por (usuário, código da sala). A "Nova partida" (mesmo código) e uma
sala nova que recebesse um código já usado voltavam `deduped`, sem XP, histórico, estatísticas nem conquistas.
Agora o dedup é por **partida**: `played_at >= rooms.finished_at` (refeito a cada fim pelo gatilho
`rooms_track_finished_at`, a mesma identidade de partida do `match_shares`). Sala antiga sem `finished_at` segue a regra
antiga. Testes: `scripts/test-conquistas-regras.mjs` (revanche rende; repetir deduplica; legado) — mutante sem a
condição reprova.
