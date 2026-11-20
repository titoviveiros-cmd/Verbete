# Verbete 2.1.6 (10) — proposta de congelamento (FREEZE GO/NO-GO)

Preparado em 20/11/2026 no branch `release/2.1.6-rc1` (master `a66fec7` + PRs abaixo). Nada foi integrado na master,
publicado ou aplicado em produção.

## Veredito: **NO-GO hoje** → GO quando os 5 passos da §5 estiverem feitos

Motivo: a auditoria de 20/11 achou P1 reais. As correções estão prontas e testadas, mas ainda não estão na master nem
em produção.

## 1. Versões identificadas (estado de produção, só leitura em 20/11)

| Parte | Em produção | Fonte |
|---|---|---|
| Web (Worker `jogo.verbete.workers.dev`) | versão `14885331`, build da master `de554e4` (rollback `bb6c8cc7`) | `wrangler deployments list` |
| Android | 2.1.5 (9), AAB `de554e4`, no Teste fechado (Alpha), teste físico aprovado | Play Console |
| Banco | 131 migrations = as 131 da master `a66fec7` (nenhuma divergência) | `supabase migration list` |
| Edge functions | bot-definitions v11, bot-definitions-v2 v7, score-similarity v12 (deploy 07/11; último commit nelas 06/11) | `supabase functions list` |
| Config | `daily_mode=escolha` (B4 desde 20/11 11:00), `ai_mode=ligado`, `bots_auth_mode=observar`, `rooms_vc8_compat=ligado` | `app_config` |
| iOS | 2.1.5 (9) compila no CI; nunca assinado/enviado | `ios.yml` |

## 2. Achados P0/P1 (auditoria de 20/11, código atual) e destino

| # | Severidade | Achado | Correção | Onde |
|---|---|---|---|---|
| 1 | P1 | App nativo: link `https://jogo.verbete.workers.dev/_capacitor_http_interceptor_?…` abre o app e carrega conteúdo de terceiros na origem do app (GHSA-rvm3-566m-v7fv) | Capacitor 8.4.3 + lista de rotas em `appPathFromLink` | PR #82 (exige build 2.1.6) |
| 2 | P1 | Web: XSS refletido sem login nas funções de servidor (TanStack Start, GHSA-qx66-fv34-fjm8) + seroval | react-start 1.168.61, seroval 1.8.2 | PR #82 (exige deploy web) |
| 3 | P1 | Verdade identificável cruzando ids de `get_round_sync` (escrita × votação) | id nulo na escrita | PR #83 (migration) |
| 4 | P1 | Banco editorial baixável: `choose_word` aceita palavra não publicada; `review_notes` na revelação | só publicada/da sala; sem `review_notes` | PR #83 (migration) |
| 5 | P1 | Revanche/código reaproveitado não rende XP, histórico nem conquistas | dedup por partida (`finished_at`) | PR #78 (migration, depois do B4) |
| 6 | P1 | IA sem bloqueio: `bots_auth_mode=observar` não barra chamada de fora da sala; cota só por sala/rodada | `bots_auth_mode=aplicar` (7 dias: 0 eventos `ai_guard`, 51 chamadas legítimas → nenhum jogo legítimo seria barrado) | **config, decisão do dono** |
| 7 | P1 latente | Diário modo juiz: tempo vem do cliente (pontuação) | nenhuma enquanto `daily_mode=escolha`; volta a valer se houver rollback do B4 | risco aceito |

Nenhum P0 encontrado. Abaixo de P1 (registrados, não bloqueiam): Diário sem `catch` no carregamento, laço de re-render
dos votos de bot, CORS `*` nas edges, XP em sala só com bots, varredura de códigos com `rooms_vc8_compat=ligado`.
Residual de produto: palavras publicadas podem ser vistas jogando salas (Diário exclusivo exigiria tirar do sorteio).

## 3. Consolidação dos PRs

| PR | Conteúdo | Classificação | Ordem |
|---|---|---|---|
| #81 | teste intermitente (janela 12 s) | **incorporar** | 1 |
| #80 | checklist/capturas/TestFlight inerte | **incorporar** | 2 |
| #82 | segurança cliente + deps + 2.1.6 (10) | **incorporar** | 3 |
| #83 | migration P1 servidor | **incorporar** | 4 (independente do B4) |
| #77 | conquistas consultáveis (UI) | **incorporar** (vai no mesmo build 2.1.6: sem teste físico extra) | 5 |
| #78 | regras de conquistas + revanche (migration) | **incorporar depois do B4 GO** (21/11 11:00) | 6 |
| #62 | bots sem IA externa | **adiar**: exige revisão editorial do banco offline + deploy de edges; 75 commits atrás | pós-lançamento |
| #63 | 13+ sem IA externa | **adiar**: nome legal do desenvolvedor pendente + decisão de desligar a IA; 70 commits atrás | pós-lançamento |
| #72 | integração experimental | **preservar, sem merge** | — |

Os 6 PRs incorporados se juntam sem conflito (`release/2.1.6-rc1`).

## 4. Gates técnicos (evidência)

- `npm run check` (lint 0 erros, typecheck, vitest) nos PRs; CI por PR: build-and-test, android, integration,
  e2e-visual ×2; iOS (build aparelho + Simulador) quando muda app nativo.
- `npm audit --omit=dev`: críticos 8 → 0 com #82. Altos restantes: ferramentas de build (vite, wrangler, miniflare,
  nitro) e `zod` 3 (DoS de memória; correção só no major 4) — pós-lançamento.
- Acessibilidade: axe (WCAG 2.1 AA) nos testes visuais; capturas de loja 29/29 por tamanho.
- Rollback: web = versão anterior do Worker; banco = `supabase/rollback/p1_seguranca_lancamento.sql` e
  `supabase/rollback/conquistas_regras.sql`; Android = manter 2.1.5 (9) no Alpha / interromper o lançamento; B4 =
  `B4-R-ROLLBACK-juiz.sql`.

## 5. Caminho para GO (cada passo com autorização própria do dono)

1. B4: rodar `B4-3-HOMOLOGAR.sql` (só leitura) a partir de 21/11 11:00 → veredito GO/NO-GO calculado.
2. Merge na master, na ordem da §3 (#81, #80, #82, #83, #77; #78 só com B4 GO).
3. Produção: migration #83 → deploy web → `bots_auth_mode=aplicar` → (B4 GO) migration #78.
4. AAB 2.1.6 (10) pelo `android.yml` (assinado) → Alpha → teste físico curto: convite por link `/?join=`, entrar
   com Google, abrir conquistas no perfil, revanche rende XP.
5. Depois do 2.1.6 no Alpha: subir `client.min_native_build` para 10 (vc9 tem a falha do item 1).

## 6. Exigências externas (não técnicas)

- Play: 12 testadores × 14 dias (responsabilidade do dono) → pedido de acesso à produção.
- Apple: conta Apple Developer (US$ 99/ano) → segredos do `ios-testflight.yml` → TestFlight → revisão.
- Jurídico: ECA Digital (parecer B6).
- Capturas de loja: aprovação visual do dono (pacote pronto).
