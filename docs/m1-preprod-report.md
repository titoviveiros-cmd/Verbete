# M1 PRE-PRODUCTION REPORT — Verbete 2.0

> 2026-10-03 · branch `m1-hardening` · PR [#1](https://github.com/titoviveiros-cmd/Verbete/pull/1) (rascunho) · **produção inalterada** (nenhuma migration aplicada, nenhuma edge publicada, nenhum deploy web, nenhum AAB gerado).

## Identificação

| Item | Valor |
|---|---|
| SHA inicial | `dd443af` (= origin/master = commit da auditoria; árvore limpa) |
| SHA final de código | `d139fd2` — CI **verde** (run 37126307660 do PR #1; ver seção "CI"); o commit seguinte é só documentação |
| Commit local não publicado | `ci: deno check, Android build on PRs, native bundle smoke, 90-day AAB` (branch `m1-workflows`) — o token desta máquina não tem escopo `workflow` |
| Produção web | segue em `17bb348` |

## Commits (temáticos)

| Commit | Lote | Conteúdo |
|---|---|---|
| `security: server authority over game tables` | A | migration 20261003100000 + client sem escrita direta + suíte REST |
| `fix: prevent shuffling deadlock` | E | migration 20261003110000 + regressão |
| `fix: restore bot AI definitions and make AI failures visible` | B | edges bot-definitions/score-similarity, módulo compartilhado, diário |
| `ops: restore meaningful health signals and minimal alerting` | F | migration 20261003120000, painel, manutenção separada, executor de suítes |
| `feat: remote min-build and maintenance switch` | H | migration 20261003130000 + RemoteGate |
| `ci: inject native runtime config and fail closed` | C | .env.capacitor, trava do build nativo, smoke |
| `fix: native share, deep links and public app url` | D | share nativo, cold deep link, og:image, VIBRATE, guarda do Playwright |
| `docs: align privacy policy and account texts with real data flows` | G | /privacy, /support, deleteAccount |
| `test: align M1 suites with real schema constraints` | — | ajuste de premissas após o 1º run do CI |

## Migrations, edges, dependências

- **Migrations novas** (não aplicadas): `20261003100000_m1_server_authority`, `20261003110000_m1_shuffling_deadlock`, `20261003120000_m1_ops_health`, `20261003130000_m1_client_config`. Todas aplicaram limpas no Supabase local do CI (do zero, sobre as 93 anteriores).
- **Manutenção separada** (NÃO é migration automática): `supabase/maintenance/20261003_cleanup_zombie_rooms_v2.sql` + `..._dryrun.sql`.
- **Edge functions alteradas** (não publicadas): `bot-definitions`, `score-similarity`, novo `_shared/ai.ts`.
- **Dependência adicionada**: `@capacitor/share` 8.0.3 (compatível com Capacitor 8; registrado no projeto Android via `cap sync`). Nenhuma outra. `npm audit` inalterado (17 na cadeia de build/teste, nada no bundle de produção — SC-01 segue aberto).

## Testes antes → depois

| Suíte | Antes (dd443af) | Depois |
|---|---|---|
| Unitários (Vitest) | 36 | **104** (IA da edge, deep link, share, URL canônica, trava nativa, og:image, versão mínima) |
| Integração SQL no CI | 2 suítes (identidade, rodada) | **8 suítes** — + segurança REST (100 checagens), shuffling (17), saúde/alertas (20), bônus (6), tempos (10), ops (6) |
| E2E Playwright | 2 specs | 3 specs + guarda de identidade do servidor |
| Edge (Deno) | sem checagem | `deno check` limpo (e acusa `norm` na versão de produção) |
| Build nativo | sem trava | trava + smoke (provados positivo e negativo localmente) |

## CI (PR #1, SHA `d139fd2`)

| Job / suíte | Resultado |
|---|---|
| build-and-test: lint · typecheck · unitários · build web | ✅ (15 arquivos, 104 testes) |
| Supabase local: 93 migrations antigas + 4 do M1, do zero | ✅ aplicaram limpas |
| test-identity | ✅ 13/13 |
| test-e2e-round (adaptado: sessão + verdade só do servidor) | ✅ 15/15 |
| test-security-rest (negativos REST + partida legítima + privilégios + allowlist de 45 funções) | ✅ 100/100 |
| test-shuffling-deadlock | ✅ 17/17 |
| test-similarity-bonus · test-phase-secs · test-ops (voltaram ao CI) | ✅ 6/6 · 10/10 · 6/6 |
| test-ops-health (tick real, heartbeat, alertas, client config, manutenção) | ✅ 20/20 |
| Playwright: smoke + partida multiplayer em 2 navegadores + og:image (2) | ✅ 4/4 |
| Android (Gradle) | ⛔ **não rodou neste PR**: o android.yml atual só dispara em push no master/dispatch e o commit que o liga em PRs exige escopo `workflow`. Trava do build nativo e smoke provados localmente (positivo e negativo) |

1º run (`5f4dbc5`) falhou por duas premissas dos testes (FK de `current_word_id`; fallback de `get_random_words`) — corrigidas em `d139fd2`; nenhum código de produto mudou entre os runs.

## P0 (11 na auditoria)

| ID | Situação |
|---|---|
| IA-01, IA-02 | **Resolvido no código** (edge) — pendente deploy da edge |
| SCORE-01, SCORE-02, RT-01, RT-02, SEC-01 | **Resolvido no código** (migration A) — pendente aplicar |
| MOB-01, VIR-03 | **Resolvido no código** (.env.capacitor + trava + smoke) — pendente regenerar AAB |
| VIR-01, VIR-02 | **Resolvido no código** — pendente deploy web / AAB |

**P0 abertos no código: 0. Em produção: os 11 até o deploy.** Novos achados de classe P0 encontrados e corrigidos nesta rodada: `insert_truth_definition` aberta (plantar/trocar a verdade) e guardas de identidade que liberavam chamadas sem sessão (sobrescrever voto/definição alheios, comandar bots).

## P1 (43 na auditoria)

- **Resolvidos no código (24):** SM-01, ONB-01, M-01, AUD-01, IA-04, SCORE-03, SCORE-04, SCORE-05, T-03, MOB-02, MOB-03, RT-03, RT-04, RT-05, RT-07, RT-11, SEC-02, SEC-03, SEC-04, AN-02 (lógica; resíduo na manutenção), PV-02, RC-01, OB-01 (canal externo depende de configuração), VIR-06.
- **Parciais (6):** IA-03 (nova tentativa + alerta; sem reprocessamento), SEC-05 (oráculo de tempo fechado; sem rate limit), CI-01 (retenção 90 dias no commit de workflows + rotina de arquivar), T-07 (SQL cobre revanche/fim/3 humanos/expulsão/host; E2E de navegador não), ONB-02 (correção pronta na manutenção separada), CD-02 (versão mínima feita; analytics/portões não).
- **Abertos (13):** GD-01 e GD-02 (UX/regra de tempo — exigem decisão), AUD-02 (iOS), SC-01, VIR-04, VIR-05, VIR-09 (produto), DL-02 (aparelho + Play App Signing), AN-01 (informativo), AN-03 (economia de XP), UG-01 (bloquear jogador), OB-04 (backups — dono), LS-01 (escala).

## Achados novos desta rodada

| Achado | Situação |
|---|---|
| `insert_truth_definition` executável por qualquer um: inserir/trocar a verdade | corrigido (revogada) |
| Guardas liberavam chamadas sem sessão | corrigido (sessão obrigatória na API pública) |
| `join_public_room` movia de sala e zerava o placar de qualquer jogador | corrigido |
| `leave_room` tirava qualquer jogador | corrigido |
| Lotes dos bots abertos a qualquer sessão (+1 por bot no próprio blefe) | corrigido (só o host) |
| `create_room_with_host` era SECURITY INVOKER (quebraria com o bloqueio) | corrigido |
| Secrets `VITE_SUPABASE_*` nunca existiram no repo (raiz do MOB-01) | contornado com `.env.capacitor` público |
| `rooms.current_word_id` tem FK para `words`: palavra customizada nunca vira rodada (SEC-04 sem efeito prático; recurso morto) | documentado |
| Login Google no app nativo redireciona para `https://localhost` | **aberto (M2)** — afeta o teste A/C de login no aparelho |
| Prorrogação do gatilho de escrita (20 s) não escala com n/6 | aberto (P3 — regra de tempo, não tocada) |
| E-mails `@verbete.app` da política/suporte não existem | **aberto — dono** |

## Regressões / mudanças de comportamento

Nenhuma regressão conhecida nas suítes. Mudanças deliberadas:
- Ações de jogador pela API **sem sessão** passam a ser recusadas (o app sempre abre sessão; se o login anônimo falhar 3x, mostra aviso).
- `add_bot`/`migrate_host` via RPC; lotes dos bots exigem a sessão do host (o client já só os disparava no host).
- `start_shuffling` responde `ok:false` quando ainda há humano pendente (antes `ok:true` com a sala em writing).
- O client não envia mais a definição verdadeira (ramificação já morta).
- Desafio diário: Gemini fora não grava mais "errado" — mostra aviso e preserva a tentativa.

## Ordem de produção (cada passo exige autorização)

Ver comandos exatos na seção seguinte. Janela crítica: entre (1) e (3) o client antigo não consegue adicionar bot nem migrar host — manter (1)→(3) em sequência imediata.

1. Aplicar as 4 migrations (dry-run antes).
2. Publicar as 2 edges.
3. Deploy web do SHA final da branch.
4. Sondas pós-deploy.
5. Mergear o PR (master = produção).
6. (separado) Manutenção das salas-zumbi, com dry-run.
7. Publicar o commit de workflows (exige escopo) e regenerar o AAB.
8. (opcional) Canal de alertas e ping externo.

## Comandos (NÃO executados)

```bash
# 1) migrations — da branch m1-hardening
npx supabase db push --db-url "postgresql://postgres:<SENHA>@db.wspztmimctgbjcmyzexn.supabase.co:5432/postgres" --dry-run
npx supabase db push --db-url "postgresql://postgres:<SENHA>@db.wspztmimctgbjcmyzexn.supabase.co:5432/postgres" --include-all --yes

# 2) edges
SUPABASE_ACCESS_TOKEN=<token> npx supabase functions deploy bot-definitions --project-ref wspztmimctgbjcmyzexn --no-verify-jwt
SUPABASE_ACCESS_TOKEN=<token> npx supabase functions deploy score-similarity --project-ref wspztmimctgbjcmyzexn --no-verify-jwt
```

```powershell
# 3) web (anotar antes a versão atual para rollback: npx wrangler deployments list --name jogo)
$env:NODE_ENV="production"; $env:VITE_APP_URL="https://jogo.verbete.workers.dev"; $env:VITE_BUILD_ID=(git rev-parse HEAD); npm run build; npx wrangler deploy -c dist/server/wrangler.json

# 4) sondas (somente leitura + tentativas que devem ser recusadas)
$env:SUPA_URL="https://wspztmimctgbjcmyzexn.supabase.co"; $env:ANON="<chave publicável>"; $env:DB_URL="<DB_URL>"; node scripts/probe-m1-prod.mjs
#    + jogar 1 rodada com 1 bot e conferir no /admin/ops: bot_ai_success ≥ 1, último tick < 1 min

# 6) manutenção separada — primeiro o dry-run (READ ONLY), depois promover a migration
$env:DB_URL="<DB_URL>"; node scripts/sql-readonly.mjs supabase/maintenance/20261003_cleanup_zombie_rooms_v2_dryrun.sql
Copy-Item supabase/maintenance/20261003_cleanup_zombie_rooms_v2.sql supabase/migrations/20261004000000_cleanup_zombie_rooms_v2.sql
npx supabase db push --db-url "<DB_URL>" --include-all --yes
```

```text
7) AAB: após publicar o commit de workflows → GitHub → Actions → Android → Run workflow (master)
   → baixar o artifact verbete-release-aab → arquivar fora do GitHub → Play Console (teste interno).
   Com Play App Signing aceito: adicionar o SHA-256 do Google ao /.well-known/assetlinks.json.
8) Alertas (opcional, escolha do canal pelo dono):
   INSERT INTO public.app_config (key, value) VALUES ('ops_alert_webhook_url', '<webhook Discord/Slack>')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
   INSERT INTO public.app_config (key, value) VALUES ('ops_heartbeat_ping_url', '<URL de ping, ex. healthchecks.io>')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
```

**Rollback:** web → `npx wrangler rollback <versão anterior> --name jogo`; edges → republicar a versão de `dd443af` (restaura a IA quebrada; só em emergência); migrations → blocos `ROLLBACK` no cabeçalho de cada arquivo.
