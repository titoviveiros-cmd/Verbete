# Verbete — Prontidão de loja
> Auditoria Master Release · 2026-10-02 · HEAD `e811635` (código de app: `17bb348`/`bb08c58`) · produção web `17bb348` · SOMENTE LEITURA (nenhum código de produto alterado)

## Claims × Realidade

| Claim da ficha | Veredito | Evidência |
|---|---|---|
| Mais de 1.000 palavras raras | ✅ COMPROVADO | 1.078 publicadas (SELECT 02/10) |
| 2 a 12 jogadores | ✅ COMPROVADO | canStart>=2; 12 slots (Lobby.tsx:85-86) |
| Sem anúncios | ✅ COMPROVADO | zero SDK/código de ads |
| Grátis | ✅ COMPROVADO | sem billing |
| Multiplayer | ✅ COMPROVADO | E2E 2 navegadores verde |
| Juiz de IA | ✅ COMPROVADO | score-similarity em produção |
| Conta opcional | ✅ COMPROVADO | anônimo joga (provado) |
| Bots | ✅ COMPROVADO | addBot + fallbacks |

## Inventário de IP
| Asset | Situação |
|---|---|
| Fredoka/Nunito | OSS (OFL) — self-host recomendado p/ offline |
| Tile/troféu/mascote/ícones/splash | OWNED (SVG/código próprios) |
| Sons/música | OWNED (síntese WebAudio) |
| Screenshots | OWNED (partidas reais) |
| Emojis (avatares/reações) | fonte do device (padrão de mercado; ok) |
| Nome 'Verbete' | UNKNOWN (sem clearance INPI) |
| Deps npm | MIT/ISC/Apache (sem copyleft viral nas diretas) |

---

## Controles de release (resumo)
## Controles de release
| Controle | Web | APK |
|---|---|---|
| Build id | ✅ meta verbete-build | ❌ 'v dev' (RC-02) |
| Auto/force update | ✅ 60s/15min | ❌ inexistente (RC-01) |
| Min supported build | n/d | ❌ |
| Kill switch | redeploy | ❌ (app_config sem consumo no client) |
| Rollback | wrangler/redeploy; DB com blocos ROLLBACK | Play: halt rollout + nova versão |
| Compat RPC velha | ✅ no-op deprecado (padrão provado) | idem |
| Rastreio release→commit | ✅ sha no rodapé | ❌ |

---

## Mobile (resumo)
# Auditoria Mobile/Capacitor — Verbete (HEAD e811635, 2026-10-01)

## 1. Inventário da camada nativa

| Item | Estado | Evidência |
|---|---|---|
| Capacitor | 8.x (core 8.3.4, android 8.4.2) | package.json |
| appId / versão | app.verbete.game · versionCode 2 · versionName 2.0.0 | android/app/build.gradle |
| SDKs | min 24 · compile/target 36 (Android 16 — edge-to-edge compulsório) | android/variables.gradle |
| Plugins sincronizados | @capacitor/app, splash-screen, status-bar (capacitor.plugins.json) — **sem** Share, Browser, Keyboard, Filesystem | android/app/src/main/assets |
| webDir | dist/client, bundle SPA offline (`vite build --mode capacitor`, prerender do shell) — sem server.url (correto p/ review de loja) | capacitor.config.ts, vite.config.ts |
| capacitor.config.json sincronizado | idêntico ao .ts (sem drift) | android/app/src/main/assets |
| Permissões | só INTERNET — mínimo correto | AndroidManifest.xml |
| iOS | **pasta ios/ NÃO existe** (gitignored, ausente na máquina); só config preparada | .gitignore:6 |

## 2. Ciclo de vida — o que cada estado dispara (src/hooks/room/use-room-polling.ts)

| Estado | Gatilho | Ação no código |
|---|---|---|
| Vai p/ background / tela bloqueia | `visibilitychange: hidden` | marca `hiddenAt`; polls de 2,5s/8s pausam (guarda `visibilityState !== 'visible'`); OS congela timers (iOS agressivamente) |
| Volta (<60s fora) | `visibilitychange: visible` + `focus` + `pageshow` | reload de estado incondicional via `reloadRef`; `lastEventAtRef = 0` acorda rede adaptativa; Voting.tsx segura toques por 1,2s (anti-voto-fantasma); áudio/música retomam (music.ts, sound.ts) |
| Volta (60s–15min) | idem | + `reloadIfOutdated()` (app-version.ts): fetch `/` no-store, compara meta `verbete-build` com BUILD_ID, recarrega se saiu deploy. No **nativo** BUILD_ID='dev' → no-op (correto: bundle é fixo no APK) |
| Volta (>15min) | idem | `window.location.reload()` duro — bundle+estado zerados |
| Canal realtime mudo >25s | interval 8s | reload completo (rede adaptativa) |
| Divergência de fase | poll de assinatura 2,5s (status\|round\|word + players + extensões) | patch de campos secundários sem re-render, ou reload se a fase mudou |
| Rede cai / troca wifi↔5G | `offline`/`online` | `offline` liga ConnectionState degradado; `online` desliga e força reload; poll `get_round_sync` (700ms–1,2s nas fases ativas) é o batimento que liga/desliga `degraded` |
| Kill → relaunch | cold start | abre na home; identidade (verbete:player-id, nick) persiste em localStorage; **deep link do intent é perdido (MOB-04)**; reentrada na sala = digitar código |
| Botão voltar (Android) | `App.backButton` (native.ts) | `history.back()` se há histórico; `minimizeApp()` na raiz (nunca mata o app) — mas sai da partida sem confirmação (MOB-09) |
| Deep link warm | `App.appUrlOpen` | `location.href = pathname+search` → SPA recarrega com `?join=` (index.tsx valida `^\d{4}$` e abre fluxo de join) |

## 3. Achados críticos (ordem de prioridade)

1. **P0 MOB-01 — AAB do CI sem Supabase embutido.** `.github/workflows/android.yml` builda o bundle Capacitor sem `env:` (ci.yml injeta os secrets no build web; android.yml não); `.env` é gitignored. `client.ts` lança erro na primeira chamada. O build passa verde porque o client é lazy — **build verde ≠ app funcional**. Regenerar o AAB expirado sem este fix reproduz o binário quebrado. Fix: 3 linhas de env no workflow (+ `VITE_APP_URL=https://jogo.verbete.workers.dev`).
2. **P1 MOB-02 — Compartilhar do lobby morto no nativo.** `buildShareUrl()` trata `host==='localhost'` (origem Capacitor) como preview Lovable → botão mostra aviso obsoleto "clique em Publish" e não compartilha. Usar `APP_URL` em vez de `location.origin`.
3. **P1 MOB-03 — APP_URL errada em builds nativos** (localhost:5173 local; fallback verbete.app no CI). Produção web confirmada correta via curl (og:url e build 17bb348).
4. **P2 MOB-04 — Deep link cold start perdido.** Comprovado na fonte do plugin: `appUrlOpen` só em `onNewIntent`; falta `App.getLaunchUrl()` no boot.
5. **P2 MOB-05/06 — Share de replay (blob download no-op no WebView) e login Google (403 disallowed_useragent + redirect https://localhost)** — inferências fortes, exigem device para comprovar.

## 4. O que está bem (não mexer)

- **Manifest Android**: singleTask + configChanges completo (rotação não recria activity), App Links autoVerify com `assetlinks.json` **publicado e conferido byte a byte via curl (evidência A)**, esquema custom de fallback, FileProvider, INTERNET só.
- **Assinatura/CI**: keystore em secrets, APK debug por push, AAB assinado via workflow_dispatch, R8+shrinkResources com keep-rules do Capacitor comentadas.
- **Safe areas**: `viewport-fit=cover` + `env(safe-area-inset-*)` com `max(mínimo, env())` e fallback `0px` em todas as superfícies (shell, sala, chat, reações, banner offline). Ressalva: no Android WebView antigo `env()`=0 (degradação cosmética — MOB-11).
- **Splash**: 26 variantes (port/land × densidades × noite) + ícones adaptativos/monocromático; fundo #0f0a1f em config, tema e webview — sem flash branco.
- **Teclado**: `interactive-widget=resizes-content` no viewport (verificado em produção), textarea no topo de container rolável; falta apenas smoke em device Android 15 (MOB-12).
- **Resumo do ciclo de vida**: redundância deliberada em 6 camadas, comentada com playtests datados — acima da média da categoria.

## 5. Pendências que dependem de device/dono

| Ação | Dono? |
|---|---|
| Corrigir android.yml (MOB-01) e regenerar AAB | código (rápido) |
| Smoke em device Android real: teclado, safe areas, share, deep links frio/quente, voltar | precisa de celular Android |
| Travar portrait (MOB-10) e confirmação no voltar (MOB-09) | decisão do dono |
| iOS: Mac + conta Apple Developer; corrigir docs obsoletas (MOB-07); testar contentInset 'always' vs 'never' | dono/hardware |
| Play App Signing: adicionar SHA-256 do Google ao assetlinks.json quando ativar | quando publicar |
