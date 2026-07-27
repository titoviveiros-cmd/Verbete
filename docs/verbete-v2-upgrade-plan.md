# Verbete 2.0 — Plano de Upgrade

> Documento vivo. Cada fase executada atualiza a seção de status.
> Regra de ouro: commits pequenos e temáticos; nenhuma migration antiga é editada; nenhuma funcionalidade é removida para simplificar.

## 1. Diagnóstico do estado atual (auditado no código e no banco de produção)

### 1.1 Mapa do sistema

**Rotas** (`src/routes/`): `/` (home), `/login`, `/profile`, `/ranking`, `/daily`, `/download`, `/privacy`, `/terms`, `/support`, `/admin/reports`, `/room/$code`, `/sitemap.xml`, `__root`.

**Fases da partida** (`src/components/room/phases/`): Lobby → ChooseWord → WriteDefinition → Shuffling → Voting → Reveal → Scoreboard → Finished. Extras: `PhaseAnnouncer`, `RevealPhase` (legado parcialmente sobreposto por `phases/Reveal`), `TopBar`, `JoinFlow`, `ReportButton`, `RoomChat`, `ReactionsLayer`.

**Hooks**: `use-room` (≈600 linhas: load + realtime + presence + 2 polls + otimismo + toasts — alvo da Fase 10), `use-auth`, `use-theme`, `use-mobile`.

**Tabelas**: rooms, players, words, definitions, votes, rounds, round_extensions, reactions, room_words, room_messages, profiles, user_stats, match_history, achievements, user_achievements, daily_challenges, daily_attempts, reports, banned_players, user_roles, app_config.

**RPCs** (todas `SECURITY DEFINER` salvo leitura): ciclo de fases (`start_game`, `choose_word`, `advance_choosing_to_writing`, `start_shuffling`, `advance_writing_to_voting`, `advance_voting_to_reveal`, `advance_reveal_to_scoreboard`, `finish_reveal`, `advance_scoreboard_to_next_round_or_finished`, `extend_writing_or_advance`, `extend_voting_or_advance`, `tick_stalled_rooms`, `cleanup_zombie_rooms`); ações (`submit_definition`, `insert_truth_definition`, `submit_bot_definitions_bulk`, `cast_vote`, `cast_votes_bulk`, `send_reaction`, `send_room_message`); sala (`create_room_with_host`, `rejoin_room`, `leave_room`, `kick_player`, `host_update_room_config`, `assign_player_team`, `join_public_room`, `reset_room`); dados (`get_room_state`, `get_random_words`, `get_round_reveal`, `get_room_reveal`, `get_daily_leaderboard`, `get_app_config`); progressão (`record_match_result`, `xp_to_level`, `submit_daily_attempt_scored`, `apply_similarity_bonus`); moderação (`is_player_banned`, `has_role`).

**Edge functions**: `bot-definitions`, `score-similarity` (Gemini via `GEMINI_API_KEY`; **ainda não deployadas no projeto atual** — fallbacks locais ativos).

**Cron**: `verbete-tick-stalled-rooms` (pg_cron, 1/min) — backstop server-side de TODAS as fases (validado E2E: partida completa sem nenhum client).

**Realtime**: 1 canal por sala (postgres_changes em rooms/players/definitions/votes/round_extensions + presence + broadcast `room-sync`); canal separado para chat (`room_messages`).

**Mobile**: Capacitor 8, iOS config ok, Android scaffoldado (`android/`), build SPA offline via `vite build --mode capacitor`. PWA manifest presente.

### 1.2 Problemas conhecidos (em ordem de gravidade)

| # | Problema | Gravidade |
|---|---|---|
| S1 | **A verdade é identificável durante a votação**: o ballot chega via SELECT em `definitions` e a linha verdadeira tem `player_id='__truth__'` visível no payload de rede. Qualquer jogador com DevTools vence sempre. | CRÍTICA |
| S2 | **`words.meaning` (e curiosidade/exemplo/origem) legíveis pelo client** a qualquer momento — o coordenador (ou qualquer um) pode consultar o significado da palavra da rodada. | CRÍTICA |
| S3 | **`record_match_result` confia em valores do client** (score, posição, acertos, blefes) — leaderboard inflável por chamada direta. Caps de sanidade são o único freio. | ALTA |
| S4 | **`player_id` é um id de dispositivo não autenticado** — qualquer RPC de ação (`submit_definition`, `cast_vote`) aceita agir em nome de qualquer jogador. Impersonação trivial entre estranhos (salas públicas). | ALTA |
| S5 | Textos residuais em inglês; inconsistências claro/escuro; PWA theme-color desalinhado do Capacitor. | MÉDIA |
| S6 | Zero testes automatizados; sem CI. | ALTA (processo) |
| S7 | `use-room` monolítico; `any` espalhado nos calls de RPC; tipos do Supabase desatualizados (`room_messages` com cast). | MÉDIA |
| S8 | Banco de palavras: 116 aprovadas (meta beta: 1.500); sem pipeline editorial. | MÉDIA (conteúdo) |
| S9 | Android: package de testes `com.getcapacitor.myapp`, versionCode/Name default, ícones genéricos, sem keystore/documentação de release. | MÉDIA |
| S10 | Sem observabilidade (crash reporting, métricas de sala travada, funil). | MÉDIA |

## 2. Ajuste fundamental (pré-Fase 1): reverter pontuação à regra original

Reverter **integralmente** os valores v2 (centenas) para a regra original:

| Evento | Valor original (restaurar) |
|---|---|
| Acertar a definição verdadeira | **+3** |
| Cada voto recebido no seu blefe | **+1** |
| Blefe ≥80% equivalente à verdade (IA) | **+3** |
| Coordenador quando ninguém acha a verdade | **+2** |
| Penalidade de prorrogação | **-1** (piso 0) |

Arquivos: nova migration (`advance_voting_to_reveal`, `apply_similarity_bonus`, `extend_*_or_advance`, trigger `guard_writing_phase_advance`); client (`Scoreboard` breakdown, `GameTip`, `Onboarding`, avisos em `WriteDefinition`/`Voting`/`use-room`, alvos de pontuação do Lobby de volta a 15/20/30/50). Mantém-se: rodadas fixas, timers, XP (sistema paralelo, não é pontuação de partida). **Depois disso a fórmula fica congelada** (critério de aceite 17).

## 3. Plano por fases

### Fase 1 — Segurança e servidor autoritativo
1. **Migration `words_secure`**: revogar SELECT das colunas sensíveis de `words` (`meaning`, `curiosidade`, `origem`, `exemplo`, `sinonimos`) via grants por coluna; `get_random_words` passa a devolver shape seguro (`get_word_prompt`) sem meaning; fluxos que precisam do meaning (verdade, bots, daily) já são server-side.
2. **Migration `ballot_secure`**: revogar SELECT direto em `definitions`; criar `get_ballot(room_id)` (id, letter, text — **sem player_id/is_truth**, só em fase voting) e consolidar `get_round_reveal` (payload completo com autores/verdade/near_truth, só em reveal+). Realtime de `definitions` deixa de chegar ao client → `use-room` troca a fonte por `get_ballot`/`get_room_state` (poll existente) + broadcast.
3. **Migration `stats_server_side`**: `record_match_result(p_room_code)` reescrita para calcular score/posição/acertos/blefes/coordenações **a partir de rooms/players/definitions/votes/rounds**, vinculando `auth.uid()`→jogador via nova coluna `players.user_id` (preenchida no join quando logado). Client passa apenas o código da sala.
4. **Auditoria SECURITY DEFINER** (planilha em `docs/security-audit.md`): para cada RPC — search_path, validações (sala/fase/rodada/autoria/host), idempotência, concorrência (FOR UPDATE), grants mínimos. Corrigir gaps em migrations novas.
5. **Identidade de jogador (S4)**: adotar Supabase **anonymous sign-in** para convidados; `players.user_id = auth.uid()` sempre; RPCs de ação derivam o jogador de `auth.uid()` (param `p_player_id` vira ignorado/validado). Fallback documentado se anonymous auth estiver desativado no projeto.
6. Constraints/índices: já existem UNIQUEs de votos/definições; adicionar índices de suporte às novas RPCs conforme EXPLAIN.

*Riscos*: quebrar realtime de definições (mitigado pelo poll de assinatura já existente + broadcast); quebrar modo diário (usa meaning server-side — não afetado); Reveal/Scoreboard dependem de SELECT de definitions → migrar para `get_round_reveal`/`get_room_reveal`. *Rollback*: cada migration tem contraparte de rollback documentada no próprio arquivo (GRANTs/policies restauráveis; RPCs antigas preservadas até o fim da fase).

### Fase 2 — Testes
Vitest + RTL (unit: text-filter, sanitização, timers, XP/nível, avatars, estados derivados, reconexão), pgTAP-style SQL via Supabase local (`supabase start`, requer Docker — documentar dependência) cobrindo a lista da spec (sala, votos duplicados, self-vote, fases concorrentes, idempotência da revelação, proteção da verdade), Playwright multi-contexto (host + 3 jogadores, ciclo completo, refresh, reconexão, host off, bot, sala pública, viewport mobile). Scripts: `test`, `test:unit`, `test:integration`, `test:e2e`, `test:coverage`, `typecheck`, `check`. GitHub Actions: install → lint → typecheck → unit → integration (supabase local) → build web → build capacitor → E2E.
*Risco*: Docker indisponível na máquina atual — integração roda no CI; localmente documentar `--filter`.

### Fase 3 — Design system
Tokens semânticos em `src/styles.css` (@theme) + `src/design/tokens.ts` (velocidades/easing/z-index/breakpoints); componentes `Game*` em `src/components/game/` (lista da spec); migração gradual — nenhum big-bang. Referência: gradiente magenta→roxo→azul da Home atual. Corrigir mensagens EN, theme-color PWA (#1a0f2e escuro), estados de erro/offline.

**DIRETRIZ MESTRA (2026-07-20): a identidade visual atual está APROVADA pelo usuário.** A Fase 3 é **uniformização** (aplicar o padrão existente de forma consistente em todas as telas), não redesign. Qualquer alteração visual significativa (estilo novo de componente, mudança perceptível de paleta/tipografia/layout) deve ser apresentada ANTES como prévia comparativa (atual vs proposto) e só aplicada com aprovação explícita — as opções são sempre "aplicar" ou "manter o atual". Uniformizações fiéis ao padrão vigente seguem em commits pequenos e reversíveis, com captura no relatório para validação a posteriori.

**Diretrizes do usuário (2026-07-19):**
- `VerbeteLogo`: a REFERÊNCIA canônica é o "Verbete" da PRIMEIRA TELA (Home) — ícone "V" com livro + wordmark bubbly branca com contorno/sombra sobre o gradiente. Todas as demais ocorrências da marca (formulário de criar sala, lobby, erros, splash) passam a usar exatamente esse tratamento; eliminar a variante "texto com gradiente" da tela de criar sala.
- Fase de EMBARALHAMENTO (Shuffling): o VERSO das cédulas/cartas da animação deve exibir o logotipo do jogo (hoje mostra o ícone `/icon-192.png` genérico dentro da carta — trocar pelo `VerbeteLogo`/marca oficial como padronagem de verso de baralho).

### Fase 4 — Coreografia
Uma fase por commit, na ordem: Lobby → Escolha → Escrita → Embaralhamento → Votação → Revelação (clímax: sequência 8 passos da spec) → Placar (animação de posições) → Final (pódio + revanche). 60 FPS: transform/opacity apenas; `prefers-reduced-motion` corta partículas e loops.

### Fase 5 — Som e haptics
`src/lib/sound.ts` já tem base — consolidar em manifesto de eventos, pré-carga, mute persistente (já existe), dedupe de sons simultâneos. `@capacitor/haptics` para toque/confirmação/erro/revelação/vitória, opcional em Configurações.

### Fase 6 — Mobile e lojas
Android: package de testes, applicationId ok (`app.verbete.game`), versionCode/Name, adaptive/monochrome icons (`cap:icons` a partir de logo vetorial novo), splash alinhado (#0f0a1f), R8 com keep-rules Capacitor, keystore documentado (NUNCA no repo), back button, deep links (`/?join=`), checklist `docs/store-checklist.md`.

### Fase 7 — A11y e performance
Auditoria WCAG AA por fase (foco, aria-live no announcer/timer, focus-trap nos modais Radix já ok, contraste dos tokens); perf: memo nas listas de 12 jogadores, revisar re-renders do use-room, bundle report, Web Vitals.

### Fase 8 — Observabilidade
ErrorBoundary com visual Verbete (já há error-capture SSR); Sentry (ou GlitchTip) com consentimento; logs estruturados por room_id (hash); métricas: falha de RPC, reconexões, duração de fase, salas travadas (query no cron + tabela `ops_metrics`), funil.

### Fase 9 — Banco de palavras
Migration `words_editorial`: coluna `status` (draft|ai_generated|reviewed|approved|rejected|published) + `review_notes`; `get_random_words` filtra `status='published'`; rota `/admin/words` (role admin) para revisão em lote; pipeline: gerar lotes por IA → draft → revisão humana → published. Meta beta 1.500.

### Fase 10 — Qualidade
`supabase gen types` no CI (fim dos casts `as any` de RPC); wrapper tipado `rpc<T>()`; split do `use-room` em `use-room-data` / `use-room-realtime` / `use-room-presence` / `use-room-polling` / `use-room-actions` / `use-room-optimistic` (um por commit, com E2E verde entre cada); `tsconfig` strict extra (`noUncheckedIndexedAccess`); remover código morto (`RevealPhase` legado se confirmado órfão).

## 4. Critérios de aceite (cópia executável)
Os 18 itens da spec. Verificação: `npm run check` (lint+typecheck+unit), suíte SQL, E2E Playwright, teste manual guiado (`docs/manual-checklist.md`), tentativa de leitura da verdade via REST anon durante voting (deve falhar), `record_match_result` com valores forjados (deve ignorar/recalcular).

## 5. Estratégia de rollback
- **Banco**: migrations nunca editadas; cada migration nova inclui bloco comentado `-- ROLLBACK:` com os comandos inversos; RPCs legadas mantidas (revogadas, não dropadas) por uma versão.
- **Client**: commits temáticos pequenos → `git revert` cirúrgico; flags simples (`app_config`) para os cutovers arriscados (ballot seguro) permitindo voltar o caminho antigo sem deploy de banco.
- **Ordem de cutover Fase 1**: deploy das RPCs novas → client passa a usá-las → observação → só então REVOKE dos SELECTs antigos (mesma receita usada com sucesso no motor server-authoritative).

## 6. Status de execução
- [x] Plano escrito
- [x] Ajuste fundamental: pontuação revertida à regra original (+3/+1/+3/+2/-1) — migration aplicada e verificada em produção (`scripts/verify-scoring.mjs`)
- [x] Fase 1 · parte 1: words blindada (grants por coluna + get_random_word_prompts + get_word_reveal), RPCs get_ballot/get_room_definitions criadas, bugfix da verdade em palavras customizadas — verificada por sonda REST (`scripts/probe-security.mjs`)
- [x] Fase 1 · parte 2: ballot seguro — `get_round_sync` phase-aware como fonte única, `get_room_state` sem vazamentos, dedup de texto no servidor, REVOKE de SELECT em definitions. Verificada por sonda (`scripts/probe-ballot.mjs`: SELECT 401, sem is_truth/meaning no payload). **Pendente: teste manual de uma partida completa pelo usuário** (mudança no núcleo de sync)
- [x] Fase 1 · parte 3: record_match_result server-side — client informa só o código da sala; score/posição/acertos/blefes/XP/conquistas derivados das tabelas oficiais via `players.user_id` + `claim_player_identity`. Verificada por sonda de ataque (`scripts/probe-stats.mjs`: assinatura forjada 404, sem sessão Unauthorized)
- [x] Fase 1 · parte 4: identidade anônima (auth.uid) — claim no join/create, guardas verify-only (triggers em votes/definitions/room_messages/reactions + assert nas RPCs de ator/host), bloqueio de sequestro de player_id, client com `ensureAnonSession` + auto-recuperação em `player_id_taken`. Auditoria formal em `docs/security-audit.md` (51 fns). Verificada: `scripts/test-identity.mjs` 13/13 + regressão `scripts/test-e2e-round.mjs` 12/12. **Pendente (ação do usuário): habilitar Authentication → Sign In/Up → Anonymous sign-ins no dashboard — as guardas ligam sozinhas.**
- [x] Fase 2 · parte 1: Vitest+RTL (30 testes unit da lógica pura: text-filter/anti-cola, scores de equipe, player-id, scrollbarClip, bots, smoke RTL), scripts `test`/`check`/`test:integration` (suítes de identidade + rodada E2E contra o Supabase), workflow GitHub Actions (typecheck+unit+build sempre; integração se houver segredos). Lint NO gate (ignores de gerados/vendorados: >10min → ~19s; Prettier aplicado no codebase; 0 erros, avisos = débito da Fase 10)
- [x] Fase 2 · parte 2a: integração HERMÉTICA no CI — Supabase local (Docker) no runner, 86 migrations do zero, suítes de identidade (13) + rodada E2E (12) verdes sem segredos/produção. Achados corrigidos no caminho: (a) teste acoplado a GRANTs via SET ROLE removido; (b) drift de GRANTs do dump da Fase 0 espelhado da produção em migration no-op (20260722120000). Primeiro E2E Playwright local verde (home → criar sala → lobby, retry de hidratação SSR)
- [x] Fase 2 · parte 2b: Playwright multi-contexto — partida multiplayer completa com 2 navegadores reais (criar → entrar por código → lobby → sorteio adaptativo do coordenador → escolha → blefe → votação dupla → revelação → placar com "+3 acertou a verdade" assertado). Playwright no CI contra o Supabase local (anonymous sign-ins habilitado no config.toml — o caminho de identidade S4 roda no E2E de cada push). **FASE 2 CONCLUÍDA.** Deploy público ativo: https://jogo.verbete.workers.dev
- [x] Fase 3 (uniformização): VerbeteLogo canônico em todas as telas (Home idêntica; formulário sem variante gradiente; verso das cédulas com a marca; /download), telas de erro em PT-BR, 🔄 → ConnectionState (pílula "reconectar" só com conexão degradada), auto-atualização de bundle velho (meta verbete-build + reloadIfOutdated + reload >15min; versão visível no rodapé da Home)
- [x] Fase 4 (coreografia, TODAS aprovadas por prévia em 2026-07-20): 1/3 clímax da revelação (blefes eliminados um a um de baixo p/ cima, verdade coroando o TOPO, chuva de pontos, "ninguém acertou → coordenador +2"); 2/3 placar com ultrapassagem (ordem anterior → desliza p/ nova, contador rolante, pulso em quem subiu); 3/3 pódio na tela final (degraus 1º/2º/3º, campeão maior com coroa). **VALIDADO pelo usuário em 2026-07-21 ("mantém") — FASES 3–4 CONCLUÍDAS.** Extras pós-validação: badges 🧠 na revelação, chat com lista de conectados, juiz/gerador de IA recalibrados (teste sintético 3/3), botão voltar no lobby
- [x] Extra (playtests 2026-07-20): quórum real na votação (migration 20260722130000 — humano sem voto + prazo válido = advance no-op; causa raiz do voto perdido), rejoin sem renovar joined_at (só expulsos), barreira de similaridade nas definições (servidor pg_trgm + client textSimilarity em bots/sugestões), correções mobile (sync na retomada, música religa, margens, FAB do chat, sugestões instantâneas, teto de 6s na IA)
- [x] Fase 9 · parte 1 (banco editorial): migration status/review_notes (180 curadas → published), get_random_words só sorteia published, RPCs admin (list/review com has_role), pipeline generate-words.mjs (dupla passada de IA: gerar palavras REAIS + verificar existência/correção; 15 categorias do seletor). **Primeiro lote: 180 → 533 publicadas** (+355; 80 reprovadas na verificação; 2 circulares despublicadas p/ revisão). Tela /admin/words (tabs por status, editar significado, publicar/rejeitar). Pendente: usuário logar em /login p/ receber role admin; lotes futuros até 1.500
- [x] Fase 5 (som & haptics, 2026-07-27): biblioteca sonora + trilhas por humor já eram ricas (auditadas — sem lacunas); o gap era tátil. Adicionados haptics semânticos via `navigator.vibrate` (respeitam mute): `hapticTick` nos últimos 3s do timer e na cortina de fase, vibração curta ao confirmar voto, stingers pessoais da revelação pareados com vibração (rodada perfeita/savage = forte; enganou alguém ou acertou a verdade = sucesso; foi enganado = falha), sucesso ao subir de posição no placar, pódio (vencedor forte, demais leve). Deploy `5fb122c`. **Pendente: validação do usuário no celular (vibração não existe em desktop)**
- [ ] Fases 6, 7, 8, 10 (pendentes) + Fase 9 lotes adicionais

**Decisão (2026-07-19):** o botão 🔄 "Atualizar sala" permanece até a Fase 2 validar reconexão com testes; na Fase 3–4 migra para o componente `ConnectionState` (visível só com conexão degradada).
