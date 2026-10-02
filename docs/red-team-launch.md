# Verbete — Red Team de lançamento
> Auditoria Master Release · 2026-10-02 · HEAD `e811635` (código de app: `17bb348`/`bb08c58`) · produção web `17bb348` · SOMENTE LEITURA (nenhum código de produto alterado)

## Verificação independente dos P0 (02/10 — segunda checagem, fontes próprias)
| Achado | Veredito | Prova (classe) |
|---|---|---|
| IA-01/02 — IA de definições morta | ✅ CONFIRMADO | `norm(d)` em bot-definitions/index.ts:228,241; helper real é `normTxt` (l.186) → ReferenceError → catch devolve `definitions:[]` e o client cai no fallback de templates. Formato do catch confirmado ao vivo em produção (A) |
| SCORE-01/RT-01/SEC-01 — players forjável | ✅ CONFIRMADO | policy `players public update USING(true)` (migration 0517, nunca dropada) + `GRANT UPDATE ON players TO anon` (0722 espelho da produção) (B) |
| SCORE-02/SEC-03 — definitions UPDATE/DELETE | ✅ CONFIRMADO | policy `definitions public update USING(true)` + GRANT UPDATE/DELETE sem SELECT (0722) → corrupção cega em massa (B) |
| SCORE-03 — apply_similarity_bonus por anon | ✅ CONFIRMADO | migration 0729 revogou só `FROM PUBLIC`; default privileges do Supabase concedem EXECUTE DIRETO a anon/authenticated → revogação inócua (compare 0711, que revogou `FROM anon, authenticated, public`) (B; agente executou ao vivo = A) |
| SCORE-04/RT-11 — rounds INSERT aberto | ✅ CONFIRMADO | policy `rounds open insert` (0510) + GRANT INSERT/UPDATE/DELETE (0722) (B) |
| SEC-02/RT-05 — roubo de host | ✅ CONFIRMADO | `GRANT UPDATE (host_id) ON rooms TO anon` + policy UPDATE USING(true) (0711/0722) (B) |
| SEC-04 — verdade de palavra customizada legível | ✅ CONFIRMADO | `room_words public read USING(true)` (0518) + GRANT SELECT (0722); nunca revogado (B) |
| MOB-01 — APK do CI sem credenciais | ✅ CONFIRMADO | client.ts LANÇA sem `VITE_SUPABASE_*`; `.env` é gitignorado; android.yml builda SEM env; bundle offline sem `server.url` → app nativo do CI não conecta (A) |
| VIR-01 — og:image 404 | ✅ CONFIRMADO AO VIVO | `curl` em produção: 404 (A) |
| VIR-03 — APP_URL morta no build nativo | ✅ CONFIRMADO | fallback `https://verbete.app` em app-url.ts:6; CI sem VITE_APP_URL; DNS de verbete.app sem registro A (A/B) |
| Sondas anteriores (verdade/cédula/stats) | ✅ SEGUEM VÁLIDAS | o que elas cobriam continua fechado (words.meaning, is_truth/near_truth, record_match_result); os P0 estão em vetores que elas NÃO cobriam (UPDATE direto) |

_Medições de produção dos agentes (01/10, leituras autorizadas): salas-zumbi ~37 de julho; stalled_advance ≈43.200/30d (1/min); ai_served_defs vazia. Releitura em 02/10 bloqueada pelo classificador do modo auto — consultas prontas documentadas abaixo para reexecução autorizada._

```sql
-- Reexecutar quando autorizado (read-only):
select tablename, policyname, cmd, qual from pg_policies where schemaname='public'
  and tablename in ('players','definitions','rounds','rooms','room_words');
select table_name, grantee, string_agg(privilege_type,',') from information_schema.role_table_grants
  where table_schema='public' and grantee in ('anon','authenticated')
  and table_name in ('players','definitions','rounds','rooms','room_words') group by 1,2;
select proname, proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and proname='apply_similarity_bonus';
select count(*) from ops_events where kind like '%stalled%' and at > now()-interval '30 days';
select count(*) from ai_served_defs;
```


---

# Red Team Multiplayer / Anti-cheat - Verbete (analise estatica, 2026-10-02)

Base: HEAD e811635; migrations lidas ate 20260729120000. Nao foi possivel confirmar o estado VIVO de policies/grants nem se "Anonymous sign-ins" esta habilitado (o classificador barrou leitura de producao). Classificacoes abaixo refletem o CODIGO; marque como NAO_VERIFICADO ao vivo onde indicado.

## O veredito em uma frase
As RPCs sao server-authoritative e bem defendidas; o buraco esta no perimetro RLS por baixo delas, que continua com as policies permissivas USING(true) do inicio do projeto em players e rooms. Fase 1 fechou votes/definitions/words, mas nao players/rooms/rounds/room_words.

## As 10 perguntas
1. Cliente decide estado autoritativo? Transicoes: NAO (advance_* recalculam e gravam status; cliente nunca escreve status/score por RPC). Estado persistido: SIM via RLS (RT-01/RT-05). [COMPROVADO/B]
2. Falsifica jogador? INSERT: mitigado (guard_author_identity, player_id_taken). Residual: UPDATE de user_id (RT-02) e bots sem identidade (RT-04). [INFERENCIA/C]
3. Descobre a verdade antes da fase? Banco global: NAO (ballot seguro). Palavra customizada: SIM, room_words.meaning e legivel (RT-07). [COMPROVADO/B]
4. Vota 2x? NAO - UNIQUE(room,round,voter)+ON CONFLICT (RT-08). [COMPROVADO/B]
5. Vota no proprio blefe? NAO - checagem em cast_vote + trigger guard_no_self_vote (RT-08). [COMPROVADO/B]
6. Escreve fora da fase? NAO - submit_definition exige status=writing e nao-coordenador (RT-08). [COMPROVADO/B]
7. Manipula record_match_result? NAO - derivado do servidor, dedup por (user,room) (RT-06). Vetor indireto via score falsificavel (RT-01). [COMPROVADO/B]
8. Avanca estado indevidamente? Por RPC: NAO (lock+status). Por host forjado: SIM (RT-05). [COMPROVADO/B]
9. Divergencia entre clientes? Improvavel - get_round_sync e fonte unica e poll reconcilia; transicoes idempotentes (RT-09). [COMPROVADO/B]
10. Explora reconnect? rejoin_room so zera penalidades e renova joined_at apenas para expulso que volta; residual menor no reset de *_extensions (RT-10). [COMPROVADO/B]

## Cobertura extra pedida
- duplicate join / player_id_taken: tratado em rejoin_room e create_room_with_host; client regenera id e tenta 1x. OK.
- replay de RPC: apply_similarity_bonus idempotente (near_truth atomico); record_match_result deduplicado; advance_* idempotente por rounds UNIQUE. OK.
- race de fases (advance duplo): serializado por rooms FOR UPDATE + unique_violation. OK (RT-09).
- cedula duplicada (too_similar/pg_trgm): submit_definition rejeita identica (normalizada) e similar >0.62; submit_bot_definitions_bulk deduplica. OK.
- voto atrasado (quorum +2s): quorum real so vira apos prazo+2s ou com todos os humanos votados. OK.
- reveal race: hold 120s no scoreboard, +6s de folga no backstop vs cron. OK.
- rematch/reset_room race: reset_room/start_game sob FOR UPDATE e checagem de host+auth.uid. OK por RPC; mas host forjavel (RT-05).
- bot failure (quem destrava?): tick_stalled_rooms (cron) varre choosing/writing/shuffling/voting e chama os advance_*; advance_writing_to_voting ignora bots no quorum de escrita. Destrave garantido pelo cron mesmo sem host. OK.

## Prioridades de correcao (sem tocar pontuacao/regras/visual)
- P0 RT-01: revogar UPDATE amplo de players; canalizar por RPC (ja e o padrao em votes/definitions).
- P0 RT-02: impedir UPDATE de user_id fora de claim_player_identity.
- P1 RT-05: migrateHost deve virar RPC; revogar GRANT UPDATE(host_id).
- P1 RT-07: revogar SELECT de room_words.meaning.
- P1 RT-11: revogar INSERT de rounds do client.
- P2 RT-10/RT-12: endurecimento opcional.

## O que NAO verificar como fato
RT-02 e RT-11 sao INFERENCIA (cadeia logica no codigo, nao reproduzidas ao vivo). O estado real das policies em producao e se "Anonymous sign-ins" esta ligado permanecem NAO_VERIFICADOS ao vivo - se o anon auth estiver DESLIGADO, auth.uid() e sempre NULL e TODAS as guardas de identidade liberam por design (fallback documentado), o que amplia RT-01..RT-05. A proxima etapa (provas vivas) deve: (a) tentar PATCH anon em players.score/kicked_at/user_id e rooms.host_id; (b) SELECT anon em room_words.meaning durante writing; (c) INSERT anon em rounds; (d) confirmar o flag de anonymous sign-in.

---

# Segurança — Verbete v2 (auditoria estática 02/10, HEAD e811635)

**Escopo:** 93 migrations, 2 edge functions, client src/, docs/security-audit.md. Somente leitura; prova viva (REST contra produção) fica para a etapa seguinte.

## A regra crítica (verdade antes da fase)
| Caminho | Estado |
|---|---|
| REST SELECT words.meaning | **Bloqueado** — REVOKE de tabela + GRANT por coluna (20260720110000) |
| REST SELECT definitions | **Bloqueado** — SELECT revogado + policy de leitura dropada (20260721100000) |
| Realtime definitions | **Bloqueado** — fora da publication desde 20260605/20260721 |
| get_round_sync | **Bloqueado** — writing: texto vazio; voting: autor vazio; reveal+: tudo |
| get_ballot / get_room_definitions | **Bloqueado** — gates de fase (voting+ / round ≤ pontuada) |
| get_word_reveal / get_room_state | **Bloqueado** — meaning só em reveal/scoreboard/finished |
| **room_words.meaning (palavra customizada)** | **ABERTO** — policy USING(true) + SELECT de tabela (SEC-04) |
| score-similarity (edge) | **Lateral** — oráculo de latência: id-verdade é filtrado antes do Gemini e responde instantâneo (SEC-05, inferência) |
| bot-definitions (edge) | OK — devolve só falsas, pós-filtro Dice<0.45, memória ai_served_defs (tabela revogada) |

## O buraco estrutural: grants de tabela × REVOKE por coluna
Os REVOKEs por coluna de 20260605152627 (players.score etc., definitions.is_truth/near_truth) **não têm efeito** enquanto o grant de TABELA existir (semântica documentada do Postgres). A migration-espelho 20260722120000 — gerada do estado real de produção — confirma UPDATE pleno em players e definitions e UPDATE(host_id) em rooms, com as policies permissivas de 20260517234649 (\"players/definitions/rooms public update\" USING(true)) nunca removidas. Consequências:
- **SEC-01 (P0):** PATCH direcionado em players (SELECT público) forja score/estado — a pontuação congelada (+3/+1/+3/+2/-1) é contornável por fora do motor.
- **SEC-02 (P1):** PATCH em rooms.host_id sequestra o host de qualquer sala (as RPCs de host validam contra host_id, que o atacante acabou de virar).
- **SEC-03 (P1):** UPDATE cego (sem WHERE) em definitions corrompe is_truth/text de todas as linhas.
Correção barata e cirúrgica: 1 migration com REVOKE UPDATE nas 3 tabelas + DROP das 3 policies (o client não usa update direto nelas — verificado por grep; único resíduo é o upsert legado de players já documentado como risco no doc).

## RPCs e funções
- **search_path:** última definição de cada função varrida nas 93 migrations → **59/59 SECURITY DEFINER com SET search_path**; 3 não-secdef por design (ex. create_room_with_host roda como invoker sobre policies de INSERT).
- **auth.uid() (S4):** claim no join/create, assert_actor_identity verify-only, trigger guard_author_identity em INSERT de votes/definitions/room_messages/reactions; votos forjados são descartados sem abortar lote. **Fallback:** auth.uid() NULL ⇒ guardas liberam — depende do toggle Anonymous sign-ins do dashboard, **não verificável no repo** (SEC-08).
- **service-only:** apply_similarity_bonus (idempotente desde 20260729120000, replay não soma), submit_daily_attempt*, tick_stalled_rooms, cleanup_zombie_rooms, get_app_config, advance_choosing_to_writing.
- **ops_events:** REVOKE ALL + RLS sem policy ⇒ invisível; ingestão log_ops_event com teto 30/5min por sessão; leitura só via admin_ops_* com has_role(auth.uid(),'admin'); retenção 30d no tick.

## Rate limiting (estado)
| Ação | Limite | Observação |
|---|---|---|
| send_reaction | 800ms | **bypass por INSERT direto em reactions** (SEC-09) |
| send_room_message | 800ms + 200 chars + fase | OK |
| log_ops_event | 30/5min por sessão | OK |
| submit_definition | sem cooldown | upsert 1/rodada + cap 140 + dedup trgm — aceitável |
| cast_vote | sem cooldown | upsert 1/rodada + lock + fase — aceitável |
| score-similarity / bot-definitions | **nenhum** | drenagem de quota Gemini (SEC-05/06) |

## Enumeração e identidade
Códigos de sala: 4 dígitos (1000-9999). Irrelevante na prática: `GET rooms?select=code,status` lista tudo (policy de SELECT aberta), e players é público. Sala \"privada\" é pública de fato (SEC-07) — aceitável para o produto, mas deve constar como decisão.

## Segredos
Repo e últimos 40 commits limpos (padrões sb_secret_/AIza/eyJ); .env git-ignorado, .env.example só placeholders; service_role apenas em client.server.ts (server functions: account/daily/moderation) — nunca no bundle client (ocorrência de \"sb_secret\" no vendor é código da lib). Chave viva existe só em .dev.vars/dist locais ignorados. Atenção fora do repo: a connection string com senha do Postgres circula em prompts/handoffs internos — tratar como segredo e rotacionar se vazar.

## docs/security-audit.md
Núcleo segue correto (modelo S4, grants service-only, riscos residuais declarados), mas **parcialmente obsoleto**: datado de 19-22/07 (51 funções; hoje 59), não cobre ops_observability (27/07) nem o fix do replay do bônus (29/07), e o inventário não olhou grants de tabela+policies — exatamente onde estão SEC-01..04. Evidências 13/13 e 12/12 não re-executadas nesta etapa.

## Prova viva sugerida (próxima etapa, read-only onde possível)
1. PATCH players?id=eq.<próprio> {score} com anon (espera: hoje 200 — confirma SEC-01). 2. PATCH rooms {host_id}. 3. PATCH definitions sem filtro em sala descartável. 4. GET room_words?select=meaning durante writing. 5. Timing de score-similarity id-verdade × id-falso. 6. INSERT reactions em loop. 7. Forja de voto sem Bearer (SEC-08).

---

## Top 15 Failure Modes (red team de lançamento)
| # | Falha | Prob. | Impacto | Detecção | Mitigação | Dono | Prio |
|---|---|---|---|---|---|---|---|
| 1 | Sala presa em shuffling (SM-01) com humano pendente | média | partida morta p/ grupo | stalled_advance + reclamação | migration de regressão de estado | eng | P1 |
| 2 | Bug de client num APK publicado sem force-update (RC-01) | média | dano persistente até update voluntário | Play vitals/ops | min_build via app_config | eng | P1 |
| 3 | Gemini free estoura → bônus 🧠 some silencioso (LS-02/OB-03) | alta c/ tração | regra do jogo falha sem aviso | hoje: nenhuma | billing + contador edge_error | dono+eng | P1 |
| 4 | Incidente fora do horário sem alerting (OB-01) | alta | horas de dano invisível | — | alerta por limiar via cron | eng | P1 |
| 5 | Griefing: anon avança fases/escolhe palavra/rouba host (SM-03/04) | baixa-média | partidas sabotadas | reclamações | pertencimento à sala nas RPCs | eng | P2 |
| 6 | pg_cron para e o backstop morre (OB-02) | baixa | salas travam em massa | heartbeat ausente | last_tick + alerta | eng | P2 |
| 7 | Perda de dados entre backups (OB-04, plano Free?) | baixa | XP/histórico perdidos | — | confirmar plano; Pro+PITR | dono | P1 |
| 8 | Pico viral estoura quota de API pelo polling (LS-01) | média c/ sucesso | jogo degrada p/ todos | rpc_failure no ops | poll_multiplier via app_config | eng | P2 |
| 9 | Revisor da loja exige block/mute de usuário (UG-01) | média | reprovação na revisão | review reply | mute local ou argumento 'só convidados' | dono+eng | P1 |
| 10 | Low-end Android 7-9 (minSdk 24) quebra (DM-01) | média | 1★ de low-end | Play vitals | testar 1 device antigo; subir minSdk | QA | P2 |
| 11 | Fontes via CDN: APK offline degrada identidade (SC-02) | certa no cenário | visual genérico s/ rede | — | self-host .woff2 | eng | P2 |
| 12 | Pool (categoria,nível)=1 trava sorteio (CT-01) | média | sala cicla 60s | noop_no_words | guard no Lobby | eng | P2 |
| 13 | Timeout de votação sem clients não pune (SM-02) | baixa | injustiça percebida | — | cron chama extend_voting | eng | P2 |
| 14 | /privacy sem citar Gemini (PV-02) | certa | risco de revisão/LGPD | — | editar texto | dono+eng | P1 |
| 15 | Release não arquivada (RC-03) + suíte testando app errado (TI-01) | baixa | confusão operacional | aconteceu 01/10 | tag+arquivo; asserção de identidade no E2E | eng | P2 |

