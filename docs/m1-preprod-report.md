# M1 PRE-PRODUCTION REPORT — Verbete 2.0

> 2026-10-03 · branch `m1-hardening` · PR [titoviveiros-cmd/Verbete#1](https://github.com/titoviveiros-cmd/Verbete/pull/1) (rascunho) · **produção inalterada**: nenhuma migration aplicada, nenhuma edge publicada, nenhum deploy web, nenhum AAB gerado, nenhum secret alterado, nenhuma sala limpa.

## 1. Veredito

**M1 concluído em pré-produção.** As 18 provas exigidas estão em verde no CI do HEAD (seção 3). Produção só muda com a sua autorização, na ordem da seção 11, cada passo com rollback testado.

O teste de ponta a ponta das edges, criado nesta rodada, achou um problema que a auditoria não via: num banco montado só pelas migrations (o do CI), a chave de serviço usada pelas edges não tinha permissão de leitura em `rooms`/`rounds` — a IA dos bots e o bônus 🧠 continuariam mortos. Em produção o padrão do Supabase já dá essa permissão, mas o M1 agora não depende disso: uma migration espelha o padrão (inócua em produção), e o pré-voo da seção 11 confere o estado real antes de qualquer mudança.

## 2. Identificação

| Item | Valor |
|---|---|
| SHA inicial | `dd443af` (= origin/master = commit da auditoria) |
| SHA final de código | `d5cb048` — CI verde: run [37131431289](https://github.com/titoviveiros-cmd/Verbete/actions/runs/37131431289). Os commits seguintes só alteram documentação (este relatório e a seção M1 de `docs/security-audit.md`) |
| Produção web | `17bb348` (inalterada) |
| Commit local não publicado | `ci: deno check, Android build on PRs, native bundle smoke, 90-day AAB` (branch local `m1-workflows`, rebaseada no SHA final) — o token desta máquina não tem o escopo `workflow`. O mesmo efeito já roda no CI do PR via `ci-deno-check.mjs` e `ci-android.mjs` |

## 3. As 18 provas

| # | Exigência | Resultado | Evidência |
|---|---|---|---|
| 1 | CI totalmente verde no HEAD | ✅ | run 37131431289 em `d5cb048`: `build-and-test` ✅ e `integration` ✅ (13 suítes + Playwright) |
| 2 | lint + typecheck | ✅ | lint **0 erros**; 60 avisos, todos dívida anterior (30 `exhaustive-deps`, 20 `any` explícito, 10 `react-refresh`) — nenhum novo: os 5 que caem em linhas tocadas pelo M1 são casts `as any` antigos de `submitDefinition` que só mudaram de indentação; `tsc --noEmit` limpo; `deno check` das 2 edges limpo |
| 3 | unitários | ✅ | 107/107 (16 arquivos) (Vitest) |
| 4 | SQL / integração | ✅ | Supabase local do zero (93 migrations antigas + 5 do M1) + suítes da seção 6 |
| 5 | segurança (negativos) | ✅ | `test-security-rest` 100/100: escrita direta recusada em 10 tabelas, verdade/bônus/funções internas fechadas, sessão obrigatória, allowlist de 45 funções; `test-identity` 13/13; rollback não reabre furos |
| 6 | E2E multiplayer completo | ✅ | Playwright: partida inteira com 2 navegadores (+ smoke, og:image, compartilhar) 5/5; `test-e2e-round` 15/15 (rodada pelo motor real) |
| 7 | build web | ✅ | `vite build` no job `build-and-test` |
| 8 | build Capacitor | ✅ | `vite build --mode capacitor` + smoke do bundle nativo + `cap sync android` (`ci-android`) |
| 9 | Gradle Android | ✅ | `assembleDebug testDebugUnitTest`; no APK: plugin de compartilhar, INTERNET + VIBRATE, build id do commit (`ci-android` 9/9 (+10 checagens do smoke do bundle)) |
| 10 | nenhuma regressão funcional conhecida | ✅ | todas as suítes anteriores ao M1 seguem verdes; mudanças deliberadas na seção 9 |
| 11 | nenhum P0 novo | ✅ | 0 P0 aberto no código; achados de classe P0 desta rodada já corrigidos (seção 8) |
| 12 | pontuação e regras inalteradas | ✅ | `node scripts/m1-function-diff.mjs`: **0 linhas** que pontuam ou fixam prazo mudaram; das 16 funções que pontuam ou fixam prazo, 13 estão intocadas e 3 ganharam só guarda de identidade, trava contra corrida ou o destravamento do shuffling, sem tocar nas linhas de pontuação/prazo; `test-phase-secs` 10/10 |
| 13 | bônus 🧠 funciona após a correção | ✅ | `test-edges-e2e`: +3 e `near_truth` no blefe próximo, texto do chamador ignorado, replay não soma, e a **cadeia real** fim da votação → pg_net → edge → `apply_similarity_bonus` (+3); `test-similarity-bonus` 6/6 |
| 14 | bug `norm`/`normTxt` coberto | ✅ | prova de mutação: com `norm(d)` de volta, 4 testes unitários falham (`ReferenceError: norm is not defined`) e o `deno check` falha (TS2304); no e2e, "memória da rodada gravada" exercita o caminho exato |
| 15 | shuffling sem deadlock | ✅ | `test-shuffling-deadlock` 17/17: shuffling prematuro recusado, expulso que volta no shuffling, sala legada presa destravada (também pelo tick) |
| 16 | AAB não sai sem as variáveis públicas | ✅ | `ci-android`: build nativo com a chave vazia **falha** ("Build nativo bloqueado"); o `android.yml` gera o AAB com o mesmo `vite build --mode capacitor` antes do `bundleRelease`; testes unitários da trava |
| 17 | APP_URL e compartilhar com URL pública | ✅ | Playwright: servido de localhost, "Compartilhar" copia `https://jogo.verbete.workers.dev/?join=<sala>`; unitários de URL canônica, share nativo, deep link; og:image 1200×630 servida pelo build (Playwright) |
| 18 | nada aplicado em produção | ✅ | sondas públicas, só leitura, 03/10 14:32 UTC: web em `17bb348`; `room_words.meaning` ainda legível (HTTP 200 = migration A ausente); `get_client_config` e `migrate_host` inexistentes (PGRST202); edge responde no formato antigo (`SyntaxError`); `og-verbete.jpg` 404 |

## 4. Commits (temáticos, em ordem)

| Commit | Tema | Conteúdo |
|---|---|---|
| `c39e705` | lote A | autoridade do servidor: tabelas de jogo só leitura para os clients, sessão obrigatória, `add_bot`/`migrate_host` |
| `d892df2` | lote E | shuffling sem deadlock |
| `de00281` | lote B | IA dos bots restaurada (`normTxt`), falhas de IA visíveis |
| `33efe04` | lote F | tick sem ruído, heartbeat, alertas mínimos, manutenção separada |
| `89dc005` | lote H | versão mínima e modo manutenção remotos |
| `87f4af6` | lote C | configuração pública do build nativo + trava + smoke |
| `23d7213` | lote D | share nativo, deep link a frio, URL pública, og:image |
| `5f4dbc5` | lote G | política de privacidade e textos de conta fiéis aos dados reais |
| `d139fd2` | testes | suítes alinhadas às restrições reais do schema |
| `d341a69` | docs | 1ª versão deste relatório, modelo de segurança, runbook |
| `e868265` | testes | edges de ponta a ponta com Gemini simulado e cadeia pg_net |
| `6f16e71` | ops | scripts de rollback testados |
| `f681b19` | testes | compartilhar copia a URL pública mesmo servido de localhost |
| `b394197` | CI | Gradle Android no CI do PR + novas suítes no executor |
| `32541cb` | correção | edges não mascaram falha de banco |
| `1d7a0c5` | testes | e2e das edges com coordenador real, pré-voo REST e limpeza |
| `3ce7631` | correção | edges recusam entrada malformada antes de tocar o banco |
| `ca5fc3a` | prova | script de evidência: pontuação e prazos intocados |
| `06cf28e` | correção | espelho dos privilégios da chave de serviço (migration `20261003090000`) |
| `7f6a073` | correção | edges registram falha do insert de telemetria |
| `e7319a3` | ops | ferramentas do runbook testadas no CI (ensaio, pré-voo, sonda) |
| `1ae8af9` | CI | `deno check` das edges no CI do PR |
| `0f2e431` | ops | ferramenta segura para alerta, versão mínima e manutenção |
| `d5cb048` | testes | a sonda de produção validada contra o banco M1 no CI |
| `2d5f42f` | docs | relatório final com as 18 provas (só documentação) |
| (este) | docs | precisão do item 2 (lint) e da contagem da sonda |

## 5. Arquivos e migrations

82 arquivos alterados desde `dd443af`.

- **Migrations novas (NÃO aplicadas):**
  - `20261003090000_m1_service_role_grants_mirror` — privilégios padrão da chave de serviço (no-op em produção);
  - `20261003100000_m1_server_authority` — lote A (autoridade do servidor);
  - `20261003110000_m1_shuffling_deadlock` — lote E;
  - `20261003120000_m1_ops_health` — lote F (heartbeat, alertas, tick sem ruído);
  - `20261003130000_m1_client_config` — lote H (versão mínima / manutenção).
- **Manutenção separada (NÃO é migration):** `supabase/maintenance/20261003_cleanup_zombie_rooms_v2.sql` + dry-run; pré-voo `m1_preflight_readonly.sql`.
- **Rollback testado:** `supabase/rollback/m1_compat_old_client.sql`, `m1_full_rollback.sql`, `cleanup_zombie_rooms_v1.sql`.
- **Edges alteradas (NÃO publicadas):** `bot-definitions`, `score-similarity`, `_shared/ai.ts`, `_shared/input.ts`.
- **Ferramentas do runbook (testadas no CI):** `sql-readonly.mjs`, `sql-apply.mjs` (ensaio por padrão), `set-app-config.mjs`, `probe-m1-prod.mjs` (validada contra o banco M1 por `test-probe-local.mjs`), `m1-function-diff.mjs`.
- **Dependência nova:** `@capacitor/share` 8.0.3. Nenhuma outra.

## 6. Testes — PASS/FAIL no SHA final

| Suíte | Antes (`dd443af`) | Depois — PASS/total | FAIL |
|---|---|---|---|
| Unitários (Vitest) | 36 | 107/107 (16 arquivos) | 0 |
| `deno check` das edges | — | 2/2 edges | 0 |
| `test-identity` | 13/13 | 13/13 | 0 |
| `test-e2e-round` (adaptado: sessão + verdade só do servidor) | 12/12 | 15/15 | 0 |
| `test-security-rest` (negativos REST, partida legítima, privilégios, allowlist) | — | 100/100 | 0 |
| `test-shuffling-deadlock` | — | 17/17 | 0 |
| `test-similarity-bonus` | fora do CI | 6/6 | 0 |
| `test-edges-e2e` (as 2 edges servidas em Deno + cadeia pg_net) | — | 23/23 | 0 |
| `test-phase-secs` | fora do CI | 10/10 | 0 |
| `test-ops` | fora do CI | 6/6 | 0 |
| `test-ops-health` (tick, heartbeat, alertas, config remota, manutenção) | — | 20/20 | 0 |
| `test-rollback` (3 rollbacks + ferramentas do runbook) | — | 20/20 | 0 |
| `test-probe-local` (a sonda de produção contra o banco M1 do CI, incluindo as edges servidas pelo Supabase local) | — | 1/1 (sonda: 15/15 checagens, "PRODUÇÃO M1 OK") | 0 |
| `ci-android` (trava negativa, build, smoke, Gradle, APK) | — | 9/9 (+10 checagens do smoke do bundle) | 0 |
| Playwright (smoke, partida multiplayer, og:image ×2, compartilhar) | 2 | 5/5 | 0 |

**Histórico honesto do CI desta rodada** (só o último conta; os anteriores mostram o que os testes pegaram):

| SHA | Resultado | Motivo |
|---|---|---|
| `5f4dbc5` | ❌ | premissas dos testes (FK de `current_word_id`; fallback de `get_random_words`) — corrigidas em `d139fd2` |
| `d139fd2`, `d341a69` | ✅ | — |
| `b394197` | ❌ | o e2e novo das edges montou a rodada sem coordenador (`rounds.coordinator_id` é NOT NULL) e a sala largada quebrou o tick das suítes seguintes; Android já 9/9 |
| `1d7a0c5`, `ca5fc3a` | ❌ | o pré-voo novo mostrou a chave de serviço sem privilégio de tabela (42501) — corrigido com a migration espelho em `06cf28e` |
| `e7319a3` | ✅ | 11/11 suítes, Playwright 5/5 |
| `1ae8af9`, `0f2e431` | ✅ | 12/12 suítes, Playwright 5/5 |
| `d5cb048` | ✅ | 13/13 suítes (+ validação da sonda de produção), Playwright 5/5 — SHA final de código |
| `2d5f42f` | ✅ | 1ª versão deste relatório (só documentação) |

Alguns logs do CI mostram avisos de limite de download do Docker Hub (`toomanyrequests`) ao subir o Supabase local; o `supabase start` se recuperou — é instabilidade da infraestrutura do CI, não do produto, e pode um dia derrubar um run sem relação com o código (basta rodar de novo).

## 7. P0 e P1 — antes → depois

**P0 (11 na auditoria) → 0 aberto no código.** Em produção continuam os 11 até o deploy.

| ID | Situação |
|---|---|
| IA-01, IA-02 | resolvido no código (edges) — pendente publicar as edges |
| SCORE-01, SCORE-02, RT-01, RT-02, SEC-01 | resolvido no código (migration A) — pendente aplicar |
| MOB-01, VIR-03 | resolvido no código (`.env.capacitor` + trava + smoke + Gradle no CI) — pendente regenerar o AAB |
| VIR-01, VIR-02 | resolvido no código — pendente deploy web / AAB |

**P1 (43 na auditoria) → 24 resolvidos · 6 parciais · 13 abertos.**
- **Resolvidos (24):** SM-01, ONB-01, M-01, AUD-01, IA-04, SCORE-03, SCORE-04, SCORE-05, T-03, MOB-02, MOB-03, RT-03, RT-04, RT-05, RT-07, RT-11, SEC-02, SEC-03, SEC-04, AN-02 (resíduo na manutenção), PV-02, RC-01, OB-01 (canal externo depende de configuração), VIR-06.
- **Parciais (6):** IA-03 (nova tentativa + alerta; sem reprocessamento), SEC-05 (oráculo de tempo fechado; sem rate limit), CI-01 (retenção de 90 dias no commit de workflows), T-07 (SQL cobre revanche/fim/expulsão/host; navegador não), ONB-02 (correção pronta na manutenção separada), CD-02 (versão mínima pronta; analytics não).
- **Abertos (13):** GD-01 e GD-02 (regra de tempo/UX — exigem decisão sua), AUD-02 (iOS), SC-01, VIR-04, VIR-05, VIR-09 (produto), DL-02 (aparelho + Play App Signing), AN-01, AN-03 (economia de XP), UG-01 (bloquear jogador), OB-04 (backups — dono), LS-01 (escala).

## 8. Achados novos desta rodada (todos corrigidos, salvo indicação)

| Achado | Situação |
|---|---|
| `insert_truth_definition` executável por qualquer um (plantar/trocar a verdade) | corrigido (revogada) |
| Guardas de identidade liberavam chamadas sem sessão | corrigido (sessão obrigatória na API pública) |
| `join_public_room` movia de sala e zerava o placar de qualquer jogador | corrigido |
| `leave_room` tirava qualquer jogador | corrigido |
| Lotes dos bots abertos a qualquer sessão (+1 por bot no próprio blefe) | corrigido (só o host) |
| `create_room_with_host` era SECURITY INVOKER (quebraria com o bloqueio) | corrigido |
| **Chave de serviço sem leitura de `rooms`/`rounds` no banco do CI** — as edges do M1 não funcionariam num banco montado só pelas migrations | corrigido (migration espelho; em produção o pré-voo confirma) |
| Edges transformavam falha de banco em "palavra fora de rodada"/"rodada não pontuada" — bônus 🧠 sumia em silêncio | corrigido (vira exceção, log e evento) |
| Lixo na entrada das edges públicas viraria "erro de IA" e dispararia alerta | corrigido (validação antes de tocar o banco; 400) |
| Insert de telemetria das edges falhava em silêncio | corrigido (log) |
| Secrets `VITE_SUPABASE_*` nunca existiram no repo (raiz do MOB-01) | contornado com `.env.capacitor` público |
| `rooms.current_word_id` tem FK para `words`: palavra customizada nunca vira rodada | documentado |
| Login Google no app nativo volta para `https://localhost` | **aberto (M2)** |
| Prorrogação de 20 s do gatilho de escrita não escala com n/6 | aberto (P3 — regra de tempo, não tocada) |
| E-mails `@verbete.app` da política/suporte não existem | **aberto — seu** |

## 9. Mudanças de comportamento deliberadas

- Ação de jogador pela API **sem sessão** é recusada (o app sempre abre sessão anônima; após 3 falhas mostra aviso).
- `add_bot`/`migrate_host` viram RPC; lotes de bots exigem a sessão do host.
- `start_shuffling` responde `ok:false` quando ainda há humano pendente.
- O client não envia mais a definição verdadeira (ramo morto).
- Desafio diário: Gemini fora não grava "errado" — mostra aviso e preserva a tentativa.
- Edges: entrada malformada → 400 sem consultar banco/IA; falha de banco → `internal_error` + evento.

## 10. Riscos restantes

1. **Janela migration → web (~1 min):** com o banco no M1 e o web antigo, adicionar bot e migrar host falham. Mitigação: o build web fica pronto ANTES da migration; rollback de compatibilidade testado.
2. **Limite de login anônimo por IP do Supabase:** com sessão obrigatória, um grupo grande atrás do mesmo IP (escola, evento) pode esbarrar no limite. Mitigação: subir em Authentication → Rate Limits antes de um evento grande.
3. **Privilégios da chave de serviço em produção:** esperados pelo padrão do Supabase (e a edge já leu `definitions` em produção em 29/07); o pré-voo confere, e a migration espelho concede o que faltar.
4. **Conexão direta ao banco:** `db.<ref>.supabase.co:5432` pode exigir IPv6; se falhar, usar a URL do pooler (modo Session) do painel.
5. **Alertas sem canal externo** até configurar o webhook (passo 9); até lá, só no painel `/admin/ops`.
6. Abertos conhecidos: login Google nativo (M2), e-mails `@verbete.app`, SC-01 (17 avisos de `npm audit` só na cadeia de build/teste), prorrogação de 20 s (P3).
7. **Commit de workflows** depende de token com escopo `workflow`; sem ele o AAB ainda pode ser gerado pelo `android.yml` atual (a trava e o `.env.capacitor` estão no código), só sem retenção de 90 dias.

## 11. Ações de produção — ordem, comando exato e rollback

Todas exigem sua autorização. PowerShell, na pasta do projeto. Trocar `<SENHA_DO_BANCO>` (com caracteres especiais codificados para URL) e `<SUPABASE_ACCESS_TOKEN>`.

```powershell
cd "C:\Users\titov\Desktop\CLAUDE CODE\verbete"
git switch m1-hardening; git pull
$env:DB_URL = "postgresql://postgres:<SENHA_DO_BANCO>@db.wspztmimctgbjcmyzexn.supabase.co:5432/postgres"
$env:SUPABASE_ACCESS_TOKEN = "<SUPABASE_ACCESS_TOKEN>"
$env:SUPA_URL = "https://wspztmimctgbjcmyzexn.supabase.co"
$env:ANON = (Select-String -Path .env.capacitor -Pattern '^VITE_SUPABASE_PUBLISHABLE_KEY=(.+)$').Matches[0].Groups[1].Value
```

**0 · Pré-voo (somente leitura)**
```powershell
node scripts/sql-readonly.mjs supabase/maintenance/m1_preflight_readonly.sql
npx supabase db push --db-url $env:DB_URL --dry-run
```
Seguir só se: 0 partidas em andamento; "migrations do M1 já aplicadas" = 0; o dry-run lista **exatamente** `20261003090000`, `20261003100000`, `20261003110000`, `20261003120000`, `20261003130000`. A linha da chave de serviço é informativa (esperado `nenhum`; se listar algo, a migration espelho concede — e confirma que ela era necessária). Rollback: não se aplica.

**1 · Edges** (independem do banco: funcionam com o banco atual e com o M1)
```powershell
npx supabase functions deploy bot-definitions --project-ref wspztmimctgbjcmyzexn --no-verify-jwt --use-api
npx supabase functions deploy score-similarity --project-ref wspztmimctgbjcmyzexn --no-verify-jwt --use-api
curl.exe -s -X POST "$env:SUPA_URL/functions/v1/bot-definitions" -H "Content-Type: application/json" -d "lixo"
```
Esperado na última linha: `{"error":"word_id required"}`. Rollback (volta a IA quebrada; só emergência):
```powershell
git worktree add ..\verbete-pre-m1 dd443af
npx supabase functions deploy bot-definitions --project-ref wspztmimctgbjcmyzexn --no-verify-jwt --use-api --workdir ..\verbete-pre-m1
npx supabase functions deploy score-similarity --project-ref wspztmimctgbjcmyzexn --no-verify-jwt --use-api --workdir ..\verbete-pre-m1
```

**2 · Build web (sem publicar) e anotar a versão atual**
```powershell
npm ci
$env:NODE_ENV = "production"; $env:VITE_APP_URL = "https://jogo.verbete.workers.dev"; $env:VITE_BUILD_ID = (git rev-parse --short HEAD)
npm run build
npx wrangler deployments list --name jogo
```
Anotar o Version ID da implantação mais recente da lista (a que está no ar, build `17bb348`) = `<VERSAO_ANTERIOR>`. Rollback: não se aplica (nada publicado).

**3 · Migrations** — e o passo 4 logo em seguida
```powershell
npx supabase db push --db-url $env:DB_URL --yes
```
Cada migration é aplicada numa transação própria. Se o push parar no meio com erro: rodar `node scripts/sql-apply.mjs supabase/rollback/m1_compat_old_client.sql --commit` (o web atual volta a adicionar bot e migrar host em qualquer estado) e parar — não publicar o web.

Rollback sem janela, nesta ordem:
```powershell
node scripts/sql-apply.mjs supabase/rollback/m1_compat_old_client.sql --commit
npx wrangler rollback <VERSAO_ANTERIOR> --name jogo -m "rollback M1"
node scripts/sql-apply.mjs supabase/rollback/m1_full_rollback.sql --commit
npx supabase migration repair --status reverted 20261003130000 20261003120000 20261003110000 20261003100000 --db-url $env:DB_URL
```
(Sem `--commit`, `sql-apply` só ensaia e desfaz. O espelho `20261003090000` fica — é o padrão do Supabase.)

**4 · Deploy web**
```powershell
npx wrangler deploy -c dist/server/wrangler.json
```
Rollback (banco segue no M1):
```powershell
npx wrangler rollback <VERSAO_ANTERIOR> --name jogo -m "rollback M1"
node scripts/sql-apply.mjs supabase/rollback/m1_compat_old_client.sql --commit
```

**5 · Sondas pós-deploy + 1 partida real**
```powershell
$env:EXPECT_BUILD = (git rev-parse --short HEAD); node scripts/probe-m1-prod.mjs
```
Esperado: `PRODUÇÃO M1 OK`. Depois, 1 partida com 1 bot (sugestões da IA aparecem; 🧠 quando um blefe for quase a verdade) e, no `/admin/ops`: `bot_ai_success` ≥ 1, último tick < 1 min, sem alerta crítico. Rollback: não se aplica; se algo falhar, voltar pelo passo correspondente.

**6 · Mergear o PR** (master = produção)
```powershell
gh pr ready 1; gh pr merge 1 --merge
```
Rollback: `git revert -m 1 <commit do merge>` + push.

**7 · Manutenção das salas-zumbi** (separada; depois de 24 h de observação)
```powershell
node scripts/sql-readonly.mjs supabase/maintenance/20261003_cleanup_zombie_rooms_v2_dryrun.sql
Copy-Item supabase/maintenance/20261003_cleanup_zombie_rooms_v2.sql supabase/migrations/20261004000000_cleanup_zombie_rooms_v2.sql
git add supabase/migrations/20261004000000_cleanup_zombie_rooms_v2.sql; git commit -m "ops: promote zombie room cleanup v2"; git push
npx supabase db push --db-url $env:DB_URL --dry-run
npx supabase db push --db-url $env:DB_URL --yes
```
O segundo dry-run deve listar só `20261004000000`. Rollback (salas já encerradas não reabrem — eram zumbis):
```powershell
node scripts/sql-apply.mjs supabase/rollback/cleanup_zombie_rooms_v1.sql --commit
npx supabase migration repair --status reverted 20261004000000 --db-url $env:DB_URL
```

**8 · Workflows e AAB**
```powershell
gh auth refresh -h github.com -s workflow
git switch m1-workflows; git rebase master; git push -u origin m1-workflows
gh pr create --base master --head m1-workflows --fill
```
Mergear com o CI verde → GitHub → Actions → Android → Run workflow (master) → baixar `verbete-release-aab` → Play Console, teste interno. Rollback: revert do commit de workflows; o AAB só vale ao ser enviado à loja.

**9 · Canal de alertas e ping externo (opcional)**
```powershell
node scripts/set-app-config.mjs ops_alert_webhook_url "<URL do webhook Discord/Slack>"
node scripts/set-app-config.mjs ops_heartbeat_ping_url "<URL de ping, ex. healthchecks.io>"
```
Rollback: `node scripts/set-app-config.mjs ops_alert_webhook_url --delete` (idem para o ping). O mesmo script liga a manutenção (`client.maintenance on`/`off`) e a versão mínima (`client.min_native_build <n>`).
