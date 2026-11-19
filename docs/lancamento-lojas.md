# Lançamento gratuito — Google Play + App Store (estado em 19/11/2026)

Fonte: Play Console lido em 19/11/2026 (só leitura), repositório e requisitos oficiais consultados no mesmo dia.
Detalhe do iOS: `docs/ios-prontidao.md`. Data safety: `docs/google-play-data-safety-draft.md`.

## 1. Google Play

| Item | Estado | Evidência |
|---|---|---|
| Versão 2.1.5 (9) no **Teste fechado – Alpha** | ativa desde 17/11 | Console → Teste fechado |
| targetSdk 36 (exigido desde 31/08/2026) | ok | manifesto do AAB vc9 |
| Páginas de 16 KB (prazo 01/02/2027) | não se aplica: AAB sem nenhuma biblioteca nativa `.so` | `unzip -l` do AAB vc9 = 0 `.so` |
| Declarações de conteúdo (Data safety, classificação, público-alvo, exclusão de conta…) | "Tudo em dia" | Console → Conteúdo do app |
| **12 testadores × 14 dias** (conta pessoal) | **2 de 12**, contagem não começou | Console → Painel |
| Acesso à produção | bloqueado pelo item acima | — |
| Capturas da ficha | as de `resources/store/` (1170×2532) **passam do limite 2:1 do Play** (2,16:1) | refazer em 9:16 (ex.: 1080×1920) se forem essas as usadas |

Caminho crítico do Play = recrutar **10 testadores** (adicionar os e-mails ao grupo do teste fechado) e esperar
14 dias corridos com 12+ inscritos. Nada técnico bloqueia.

## 2. App Store

Ver `docs/ios-prontidao.md`. Bloqueio único para avançar: **conta Apple Developer** (US$ 99/ano, decisão do dono).
Capturas: obrigatório iPhone 1320×2868 (6,9") ou 1206×2622/1179×2556; as atuais (1170×2532) não servem.

## 3. Fichas, privacidade, idade

| Item | Play | Apple |
|---|---|---|
| Política de privacidade | `/privacy` | mesma URL (obrigatória) |
| Exclusão de conta | no app (Perfil) + `/delete-account` | no app, inclusive convidado |
| Faixa etária | 13+ (IARC/ClassInd) | questionário novo (13+); descritores novos até 12/01/2027 |
| ECA Digital | apps com acesso provável de adolescentes devem receber faixa etária da loja (Play Age Signals) | Declared Age Range API oferecida; obrigação = parecer jurídico (B6) |
| Loot box / compras | não há | não há |

## 4. Testes físicos estritamente indispensáveis

Android (vc9, aparelho do dono, instalado pela Play no Alpha):
1. Abrir → Home com rodapé `v2.1.5`.
2. Diário (modo vigente) até o resultado; reabrir = "já jogou".
3. Criar sala + entrar por link `/?join=` de outro aparelho; 1 rodada completa com bots.
4. Entrar com Google (navegador externo → volta logado) e sair.
5. Perfil → Excluir conta de um convidado novo.

iOS (quando houver TestFlight): os mesmos 5, trocando o item 4 por "Entrar com e-mail" e conferindo que o botão do
Google **não** aparece.

## 5. Capturas de loja (rascunho para aprovação do dono)

Geradas das telas reais com o backend simulado dos testes visuais (7 telas: Home, Diário, sala, escrita,
votação, revelação, placar), rodapé de produção `v2.1.5`:

```
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_PUBLISHABLE_KEY=e2e-visual-mock VITE_RELEASE_CHANNEL=production \
VISUAL_VIEWPORTS=440x956 VISUAL_DPR=3 SHOTS_DIR=<pasta> VISUAL_SCREENS=home,diario,lobby,writing,voting,reveal,scoreboard \
npx playwright test e2e/visual/screens.spec.ts --project=visual-screens
```

`440x956` × 3 = **1320×2868** (Apple 6,9"); `360x640` × 3 = **1080×1920** (Play 9:16). Ressalva: os textos das
definições de exemplo (fixtures) estão sem acento ("bajulacao", "danca") — trocar o exemplo antes de publicar.

## 6. Achado do Simulador (iOS)

A faixa do indicador de início (rodapé do iPhone) fica fora do escurecimento dos modais (efeito do
`contentInset: "always"`). Cosmético; conferir no TestFlight antes de mexer (mudança visual = prévia do dono).
