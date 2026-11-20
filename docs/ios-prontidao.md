# iOS — prontidão para TestFlight e App Store (19/11/2026)

Branch `feat/ios-prontidao` (base master `de554e4`). Nada enviado à Apple, nada assinado.
Requisitos conferidos em fontes oficiais da Apple em 19/11/2026 (links no fim).

## 1. O que já está pronto (no repositório)

| Item | Estado | Onde |
|---|---|---|
| Projeto nativo Capacitor 8 (SPM, sem CocoaPods), versionado como o Android | feito | `ios/` (antes ignorado no `.gitignore` desde o export do Lovable) |
| Bundle ID `app.verbete.game`, versão **2.1.5 (9)** = Android | feito | `project.pbxproj`; o CI reprova se divergir de `android/app/build.gradle` |
| Só iPhone (`TARGETED_DEVICE_FAMILY = 1`) → sem capturas de iPad | feito | `project.pbxproj` |
| iOS mínimo 15.0 (exigência do Capacitor 8; a Apple pede ≥ 13) | feito | `project.pbxproj`, `Package.swift` |
| Ícone e splash da marca (gerados de `resources/`, ícone 1024 sem transparência) | feito | `Assets.xcassets` |
| Retorno do login pelo esquema próprio `app.verbete.game://` (igual ao Android) | feito | `Info.plist` `CFBundleURLTypes` |
| Isenção de criptografia (só HTTPS do sistema) | feito | `Info.plist` `ITSAppUsesNonExemptEncryption = false` |
| Manifesto de privacidade (sem rastreamento; tipos = Data safety do Play) | feito | `ios/App/App/PrivacyInfo.xcprivacy` |
| Código no pacote (sem `server.url` remoto; diretriz 2.5.2/4.7) | feito | `capacitor.config.ts`; o CI confere |
| **Diretriz 4.8**: sem "Entrar com a Apple", o app iOS **não mostra "Entrar com Google"** (e-mail/senha e convidado seguem) | feito | `src/lib/login-providers.ts`, `src/routes/login.tsx` (web/Android inalterados) |
| Exclusão de conta no app, **inclusive convidado** (5.1.1(v)) | já existia | Perfil → Excluir (`docs/exclusao-de-conta.md`) |
| Build sem assinatura (aparelho + Simulador) e app aberto no Simulador com captura | CI | `.github/workflows/ios.yml` (macOS do GitHub, sem custo: repositório público) |

## 2. O que depende do dono (não dá para fazer sem ele)

1. **Conta Apple Developer (pessoa física)**: US$ 99/ano (valor em R$ só aparece no pagamento), conta Apple com
   2FA, nome civil (vira o "vendedor" na loja), endereço. Sem D-U-N-S. **Decisão de custo do dono.**
2. Com a conta: criar o app no App Store Connect (`app.verbete.game`), gerar **chave da API do App Store Connect**
   (papel App Manager) e cadastrar 3 segredos no GitHub (`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64`) + o
   Team ID. Com isso o CI assina (assinatura automática com `-allowProvisioningUpdates`) e envia ao TestFlight
   **sem Mac** — passo a ser acrescentado ao `ios.yml` só depois da conta existir.
3. Questionário de **classificação etária** (faixas novas 4+/9+/13+/16+/18+; perguntas de rede social desde
   set/2026; descritores novos até 12/01/2027) e o rótulo **App Privacy** (mesmos tipos do manifesto).
4. TestFlight externo passa pela revisão beta da Apple (o interno não).

## 3. Riscos conhecidos

| Risco | Impacto | Mitigação |
|---|---|---|
| 4.2 (funcionalidade mínima de app "embrulhado") | rejeição | bundle offline, gestos nativos, compartilhar nativo, deep links; descrever o multiplayer na nota ao revisor |
| 1.2 (conteúdo de usuários: definições/apelidos) | rejeição | denúncia, filtro, moderação e contato já existem (PRs ECA); chat removido em 20/10/2026 |
| Contas criadas com Google (web/Android) **não têm como entrar no iOS** (o app não tem "Esqueci a senha") | jogador perde o progresso no iPhone | definitivo = Entrar com a Apple (exige a conta Apple + provedor no Supabase); alternativa = fluxo "definir senha" por e-mail (mudança própria, não feita) |
| ECA Digital / Declared Age Range API | jurídico | a Apple não exige a API para 13+ nominalmente; decisão do parecer (B6) |
| Nunca rodou em iPhone físico | defeito só no aparelho | TestFlight interno no iPhone do dono (roteiro curto em `docs/device-test-matrix.md`) |

## 4. Como reproduzir localmente (exige Mac)

```
npx vite build --mode capacitor && npx cap sync ios && npx cap open ios
```

No Windows: `cap add/sync ios` gera o projeto, mas `Package.swift` sai com `\` — o CI (macOS) regenera.

Fontes: developer.apple.com/news/upcoming-requirements · /programs/enroll · /app-store/review/guidelines ·
/help/app-review/guideline-reference/5-1-1-account-deletion · /help/app-store-connect/reference/app-information/screenshot-specifications ·
/support/third-party-SDK-requirements · /news/?id=f5zj08ey (Brasil, faixa etária).
