# Lançamento gratuito — Google Play + App Store (estado em 20/11/2026)

Documento único de lançamento (substitui `store-checklist.md` e `store-readiness.md`, que ficam como histórico).
Detalhe do iOS: `docs/ios-prontidao.md`. Data safety: `docs/google-play-data-safety-draft.md`.

## 0. Estado real (20/11/2026)

| Item | Estado | Evidência |
|---|---|---|
| master | `a66fec7` (PR #79 iOS integrado) | `git log origin/master` |
| Android 2.1.5 (9) no **Teste fechado – Alpha** | ativo desde 17/11; **teste físico aprovado pelo dono** | Console → Teste fechado; aprovação informada pelo dono em 20/11 |
| **B4** (Diário em modo escolha) | ligado em 20/11 às 11:00 (14:00Z); homologação após 24 h → **21/11 11:00** | leitura só-consulta 20/11 11:44: `daily_mode=escolha`, `ai_mode=ligado`, duplicadas 0, horas sem conjunto 0, IA no Diário 0, tentativas no juiz 0, cron 0 falhas, 0 locks |
| PR #77 (conquistas UI) / PR #78 (regras + migration) | rascunho, atualizados com a master em 20/11 | migration do #78 só depois da homologação do B4 |
| iOS | projeto na master; build sem assinatura + Simulador no CI | `.github/workflows/ios.yml` |

## 1. Checklist final

Legenda: **T** = impedimento técnico (resolvível no repositório) · **E** = exigência externa (conta, loja, dono, jurídico).

### Android / Google Play

| # | Item | Tipo | Estado |
|---|---|---|---|
| A1 | targetSdk 36 | T | ok (AAB vc9) |
| A2 | Páginas de 16 KB (prazo 01/02/2027) | T | não se aplica: AAB sem `.so` |
| A3 | Assinatura de upload + Play App Signing | T | ok (cert FA:CC:D8:6C…39:54:65, auditado em 17/11) |
| A4 | Teste físico vc9 | E | **aprovado** pelo dono (20/11) |
| A5 | Declarações (Data safety, classificação, público-alvo, exclusão de conta) | E | "Tudo em dia" (Console, 19/11) |
| A6 | **12 testadores × 14 dias** (conta pessoal) | E | **2/12 em 19/11** (20/11: não verificado, painel não carregou) — caminho crítico |
| A7 | Pedir acesso à produção (questionário do teste fechado) | E | depois de A6 |
| A8 | Capturas da ficha ≤ 2:1 | T | **preparadas** 1080×1920 (9:16) com acentos; as de `resources/store/` (1170×2532, 2,16:1) não servem |
| A9 | Texto da ficha: "4 a 12 jogadores" (não "2 a 12") | E | conferir no Console |
| A10 | B4 homologado (24 h) antes da produção | E | 21/11 11:00 |

### iOS / TestFlight / App Store

| # | Item | Tipo | Estado |
|---|---|---|---|
| I1 | Projeto Capacitor iOS, 2.1.5 (9) = Android, só iPhone, iOS 15+ | T | ok (master) |
| I2 | Xcode 26 / SDK iOS 26 (exigido desde 28/04/2026) | T | ok (CI: Xcode 26.6) |
| I3 | `PrivacyInfo.xcprivacy`, isenção de criptografia, esquema `app.verbete.game://` | T | ok |
| I4 | Diretriz 4.8: sem Google no iOS enquanto não houver "Entrar com a Apple" | T | ok (`src/lib/login-providers.ts`) |
| I5 | Exclusão de conta no app, inclusive convidado (5.1.1(v)) | T | ok |
| I6 | **Conta Apple Developer** (US$ 99/ano, pessoa física) | E | **decisão de custo do dono** — bloqueia I7–I11 |
| I7 | App no App Store Connect + chave da API (3 segredos no GitHub + Team ID) | E | depois de I6 |
| I8 | Assinar e enviar ao TestFlight pelo CI (passo novo no `ios.yml`) | T | só depois de I7 (não dá para testar antes) |
| I9 | TestFlight interno no iPhone do dono (roteiro §3) | E | depois de I8 |
| I10 | Classificação etária (questionário novo, 13+) + App Privacy | E | depois de I6 |
| I11 | Capturas 6,9" 1320×2868 | T | **preparadas** com acentos |
| I12 | Contas só-Google não entram no iOS (sem "Esqueci a senha") | T | risco aceito até "Entrar com a Apple"; ver `ios-prontidao.md` |

### Comum

| # | Item | Tipo | Estado |
|---|---|---|---|
| C1 | Política de privacidade `/privacy` e exclusão `/delete-account` | T | no ar |
| C2 | Faixa etária 13+ (IARC/ClassInd; Apple 13+) | E | Play ok; Apple em I10 |
| C3 | ECA Digital (Play Age Signals / Declared Age Range) | E | parecer jurídico (B6) |
| C4 | Sem loot box, compras ou anúncios | T | ok |

## 2. Capturas de loja (rascunho para aprovação do dono)

Telas reais com o backend simulado dos testes visuais (7 telas: Home, Diário, sala, escrita, votação, revelação,
placar), rodapé de produção `v2.1.5`, definições de exemplo **com acentuação correta** (corrigidas em 20/11):

```
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_PUBLISHABLE_KEY=e2e-visual-mock VITE_RELEASE_CHANNEL=production \
VISUAL_VIEWPORTS=440x956 VISUAL_DPR=3 SHOTS_DIR=<pasta> VISUAL_SCREENS=home,diario,lobby,writing,voting,reveal,scoreboard \
npx playwright test e2e/visual/screens.spec.ts --project=visual-screens
```

`440x956` × 3 = **1320×2868** (Apple 6,9"); `360x640` × 3 = **1080×1920** (Play 9:16, dentro do limite 2:1).
Fidelidade: mesmas telas do app (nenhuma montagem); o iOS não mostra o botão do Google, e nenhuma captura mostra a
tela de login. As conquistas (PR #77) não aparecem: só entram nas capturas depois do merge.

## 3. Testes físicos estritamente indispensáveis

Android: **feito** (vc9 aprovado pelo dono em 20/11).

iOS (quando houver TestFlight): abrir → Home com `v2.1.5`; Diário até o resultado; criar sala + entrar por
`/?join=`; **Entrar com e-mail** (o botão do Google **não** aparece) e sair; Perfil → Excluir conta de um convidado.

## 4. Achado do Simulador (iOS)

A faixa do indicador de início (rodapé do iPhone) fica fora do escurecimento dos modais (efeito do
`contentInset: "always"`). Cosmético; conferir no TestFlight antes de mexer (mudança visual = prévia do dono).
