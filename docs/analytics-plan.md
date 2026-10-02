# Verbete — Plano de Analytics da fase gratuita
> Auditoria Master Release · 2026-10-02 · HEAD `e811635` (código de app: `17bb348`/`bb08c58`) · produção web `17bb348` · SOMENTE LEITURA (nenhum código de produto alterado)

# Verbete — Plano de Analytics do Lançamento (auditoria 02/10/2026)

Lançamento gratuito, objetivo = APRENDER. Este documento define o que medir, como, e que decisão cada número sustenta. Nada daqui foi implementado — é plano. Pontuação e visual do jogo são congelados e este plano não toca neles.

## 1. Estado atual (medido em produção, SELECT read-only em 02/10)

| Fonte | O que tem | Volume medido |
|---|---|---|
| auth.users (anônima no boot) | identidade persistente por device, created_at = proxy de first_open | 172 users (170 anon, 2 nomeados); 4 novos na última semana |
| players.user_id | vínculo jogador↔device | 129/131 humanos vinculados (98,5%) |
| match_history | partidas concluídas por usuário | 20 linhas, 14 users, 11 salas (últ. 02/08) |
| user_stats | agregados por usuário (CUIDADO: 1 linha por signup, não por ativo) | 172 linhas, 14 jogaram, 2 com 2+ partidas |
| daily_attempts | desafio diário por usuário/dia | 5 linhas, 3 users |
| rooms / rounds | funil derivado (admin_ops_summary) | 108 salas; 36 zumbis em 'choosing' desde julho |
| ops_events | saúde: client_error, boundary_crash, rpc_failure, reconnect, stalled_advance | 43.200 linhas em 30d — 100% stalled_advance (ruído, ver AN-02); zero erros de client |
| players.is_bot | uso de bot | 45% dos players são bots; 35% das salas têm bot |

**O que NÃO existe:** first_open/app_open, origem do join (link vs código), share/invite, rematch (invisível por design do dedup — AN-03), chat/reação (broadcast sem persistência), duração de sessão, denominador de crash-free, qualquer agregação de retorno.

## 2. Decisão de arquitetura: expandir banco próprio vs PostHog (como no KING)

| Critério | product_events (tabela própria) | PostHog anônimo (modelo KING) |
|---|---|---|
| Privacidade/LGPD | total: dado fica no Supabase, hash/uuid anônimo, sem terceiro, sem banner | bom (modo anônimo), mas é terceiro recebendo IP no ingest |
| Adblock/perda | ~0 (mesma origem do jogo via REST Supabase) | perda típica de 15-30% dos clients web |
| **JOIN com identidade do jogo** | **user_id/match_history/user_stats no mesmo SQL — retenção e funil exatos por device** | impossível juntar com o banco; retention só sobre o que o SDK viu |
| Dashboards | precisa construir (estender /admin/ops ou SQL) | prontos: funil, retention, paths — custo zero de construção |
| Custo de implementação | 1 migration + lib client (~60 linhas, espelho de ops.ts) + SQLs | 1 SDK + eventos; dashboards grátis |
| Risco | nenhum novo; rate-limit próprio | dependência externa, consentimento a reavaliar no Android |

**Recomendação: product_events no banco.** O ativo diferencial do Verbete é a identidade anônima JÁ dentro do Postgres — retenção e funil saem exatos e cruzáveis com match_history, coisa que PostHog nunca dará. O custo de dashboards é mitigado porque o /admin/ops já existe e os KPIs abaixo são ~12 consultas SQL. PostHog é alternativa aceitável se o tempo de construção de dashboard pesar mais que a precisão; NÃO recomendado rodar os dois (duas fontes = dois números diferentes para a mesma pergunta).

**Regras da tabela nova (espelhando ops_events):** allow-list de kinds no RPC; rate-limit ~60 eventos/5min por device; retenção 180 dias (D30 precisa de >30d!); colunas: at, kind, user_id uuid (auth.uid()), device_key (hash djb2 do player-id, já existe em ops.ts), room_hash, build, platform, props jsonb. RLS: INSERT via RPC, SELECT só admin. **Proibido em qualquer evento: texto de chat, texto de definição, nickname, palavra da rodada, e-mail, IP.**

## 3. Taxonomia de eventos

Fontes: `client` = chamada do app via RPC; `derived` = já existe no banco, só consultar; `server` = emitido dentro de função PL/pgSQL existente (mais confiável que client).

| EVENT | TRIGGER | PROPERTIES | PII? | SOURCE | PURPOSE |
|---|---|---|---|---|---|
| **ACQUISITION** |
| first_open | 1ª execução no device (flag localStorage ausente) | platform(web/android), build, entry(organic/invite/daily) | não | client | topo do funil; base de cohorte junto com auth.users.created_at |
| app_open | boot do app, máx. 1/30min por device | platform, build, days_since_first | não | client | DAU real, denominador de Crash-Free, insumo de D1/D7/D30 |
| invite_opened | index.tsx detecta ?join=NNNN válido | room_hash | não | client | numerador de Invite Conversion |
| **ACTIVATION** |
| room_created | sucesso de createRoom | platform | não | client (ou derived: rooms) | já derivável; evento só acrescenta platform |
| room_joined | sucesso de joinRoom | origin(link/code), players_count, has_bots | não | client | Room Join Success + atribuição de convite |
| room_join_failed | erro em joinRoom | reason(not_found/full/started/other) | não | client | diagnóstico do funil de entrada |
| match_started | lobby→choosing com current_round=1 | players, bots | não | server (start_game) | denominador de Completion; Activation |
| **ENGAGEMENT** |
| definition_submitted | INSERT em definitions (humano) | round | não | derived* | profundidade de participação. *Caveat: reset_room apaga definitions — se quiser série histórica, emitir server-side no submit |
| vote_cast | INSERT em votes | round | não | derived* (mesmo caveat) | idem |
| round_completed | rounds.scored_at | round | não | derived* | Avg Rounds; caveat do reset |
| match_completed | record_match_result ok | rounds, players, duration_s(derivável round1→fim), position | não | server | coração do funil; EXIGE fix AN-03 (match_number) para contar rematch |
| rematch_started | reset_room chamado | players, prev_rounds | não | server (reset_room) | numerador do Rematch Rate |
| reaction_sent / chat_sent | clique no client (contagem, NUNCA texto) | — | não | client, throttle agressivo | % de salas com uso social; P3, pode ficar p/ depois |
| daily_attempted | INSERT em daily_attempts | is_correct | não | derived (já existe) | engajamento do modo diário |
| **VIRALITY** |
| invite_share_clicked | handleShare no Lobby | method(webshare/clipboard) | não | client | Invite Share Rate |
| replay_shared | shareReplayCard resolve | result(shared/downloaded/error) | não | client | viralidade do replay-card |
| (invite_joined) | = room_joined com origin=link | — | não | client | Invite Conversion (não precisa de evento próprio) |
| **RETENTION** |
| (nenhum evento novo) | retenção é CONSULTA: cohorte = min(first_open, auth.users.created_at); retorno no dia N = existe app_open/match/daily daquele user_id naquele dia | — | — | SQL | D1/D7/D30 |

Esboço do SQL de retenção (ilustrativo, roda hoje com match+daily; fica completo com app_open):
```sql
WITH cohort AS (SELECT id, created_at::date AS d0 FROM auth.users),
act AS (
  SELECT user_id, played_at::date AS d FROM match_history
  UNION SELECT user_id, created_at::date FROM daily_attempts
  -- UNION SELECT user_id, at::date FROM product_events WHERE kind='app_open'
)
SELECT d0, count(*) AS devices,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM act a WHERE a.user_id=c.id AND a.d=c.d0+1))  AS d1,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM act a WHERE a.user_id=c.id AND a.d BETWEEN c.d0+5  AND c.d0+9))  AS d7,
  count(*) FILTER (WHERE EXISTS (SELECT 1 FROM act a WHERE a.user_id=c.id AND a.d BETWEEN c.d0+25 AND c.d0+35)) AS d30
FROM cohort c GROUP BY d0 ORDER BY d0;
```
Viés documentado (AN-10): web e Android são devices distintos; limpeza de navegador zera identidade → D30 anônimo é PISO.

## 4. KPI Framework

| KPI | DEFINIÇÃO | FÓRMULA | EVENTOS/FONTES | INTERPRETAÇÃO | DECISÃO QUE SUSTENTA |
|---|---|---|---|---|---|
| Activation Rate | % de devices novos que chegam a uma partida iniciada em 24h | devices com match_started ≤24h de first_open ÷ first_open | first_open + match_started | <30% = atrito antes do jogo (onboarding/sala); jogo social exige grupo, então não comparar com single-player | onde investir: landing/onboarding vs gameplay |
| Room Join Success | % de tentativas de entrar que viram jogador na sala | room_joined ÷ (room_joined + room_join_failed) | room_joined, room_join_failed | <90% = códigos errados/salas cheias/expiradas; cortar por reason | melhorar fluxo de código vs link direto |
| Match Start Rate | % de salas criadas que iniciam partida | match_started ÷ rooms_created | derived (hoje já existe, com subcontagem AN-03) | baixo = anfitrião não consegue reunir gente → bots/convite melhores | prioridade de bot vs convite |
| Match Completion | % de partidas iniciadas que terminam | match_completed ÷ match_started | server events (pós fix AN-03) | <70% = partidas longas demais ou travamentos; cruzar com reconnect/stalled | duração padrão de partida; estabilidade |
| Avg Rounds / Match | média de rodadas por partida concluída | sum(rounds) ÷ match_completed | match_completed.rounds (prop) | compara com win_target configurado; queda = abandono no meio | calibragem de ritmo (sem mexer em pontuação) |
| Session Duration | proxy: p50 de (última ação − primeira ação do device no dia); exato: heartbeat opcional | SQL sobre eventos datados por user_id | todos os eventos | jogo de sala: esperar 15-40min; <5min = sessões que não viram jogo | vale investir em modo rápido/diário? |
| Rematch Rate | % de partidas concluídas seguidas de Nova partida na mesma sala | rematch_started ÷ match_completed | rematch_started (server) | É O KPI de diversão de um jogo de festa; >40% = produto diverte | o sinal nº1 de product-market fit familiar |
| D1 / D7 / D30 | % da cohorte ativa N dias após o 1º dia | SQL §3 | auth.users + app_open/match/daily | jogo social casual: D1 10-25% já é bom; tratar como piso (AN-10) | continuar investindo vs pivotar modo de jogo |
| Invite Share Rate | % de salas cujo host clicou compartilhar | salas com invite_share_clicked ÷ rooms_created | invite_share_clicked | baixo = botão invisível ou jogo local (mesma sala física — comum em família!) | UX do convite |
| Invite Conversion | % de links abertos que viram jogador | room_joined{origin:link} ÷ invite_opened | invite_opened, room_joined | <50% = fricção no join pós-link (nickname? sala já começou?) | simplificar entrada pós-link |
| Reconnect Success | % de reconexões que voltam à partida | reconnect sem boundary_crash/saída nos 2min seguintes ÷ reconnect | ops_events (existe) | precisa de tráfego para baseline; hoje 0 eventos | robustez de rede (celular) |
| Crash-Free Sessions | % de sessões sem client_error/boundary_crash | 1 − sessions_with_errors ÷ sessões app_open | ops_events + app_open (denominador NOVO) | meta ≥99%; cortar por build (VITE_BUILD_ID já flui) | gate de release do APK/web |
| Bot Usage | % de salas com bot e % de players bot | SQL sobre players.is_bot (JÁ MEDÍVEL: 35% das salas, 45% dos players) | derived | alto = gente jogando sozinha/grupo pequeno → sinal de demanda por multiplayer assíncrono ou matchmaking | prioridade do Bot vs convite; leitura do caso de uso real |

## 5. Pré-requisitos e ordem de implementação (NÃO executado — aguarda autorização)

1. **Higiene (bloqueia a confiabilidade de tudo):** encerrar as ~37 salas-zumbi e corrigir cleanup_zombie_rooms + contagem do tick (AN-02). Sem isso, stalled_advance e o funil ficam poluídos no dia do lançamento.
2. **match_number no rematch (AN-03):** sem isso, Rematch Rate, Completion e games_finished mentem; efeito colateral positivo: XP na revanche volta a funcionar.
3. **Migration product_events + lib client** (AN-06) com first_open, app_open, invite_opened, room_joined(origin), room_join_failed, invite_share_clicked, replay_shared; eventos server (match_started, match_completed, rematch_started) dentro das funções existentes.
4. **Prova de ingestão** de ops_events no lançamento (scripts/test-ops.mjs, 1 evento sentinela — AN-05).
5. **Consultas de KPI** salvas (arquivo .sql no repo ou aba no /admin/ops): as 13 acima + retenção.
6. Opcional/P3: reaction_sent/chat_sent (count-only), heartbeat de sessão.

## 6. Experimentos (prontidão)

Hoje: zero flags, zero variantes, amostra ~4 devices/semana → A/B formal é inviável e NÃO deve ser prometido. O desenho honesto para este lançamento: **comparação sequencial por build** — VITE_BUILD_ID já viaja em ops_events.build e deve viajar em product_events.build; cada mudança de produto vira um corte antes/depois nos KPIs acima, com a ressalva de sazonalidade (fim de semana ≫ semana, para jogo de família). Reavaliar flags/A-B só se DAU passar de ~200.

## 7. Privacidade (postura mantida e estendida)

Sem SDK de terceiro, sem IP, sem fingerprint. user_id = uuid anônimo do Supabase (pseudônimo; não exportar). device_key/room_hash = hash djb2 não reversível (padrão já em ops.ts). Nenhum evento carrega texto de chat, definição, palavra da rodada ou nickname. Retenção: product_events 180d, ops_events 30d (atual). Exclusão de conta já apaga match_history/user_stats (account.functions.ts) — incluir product_events do user_id na mesma rotina quando a tabela existir.
