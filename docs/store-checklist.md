# Checklist de publicação — Google Play (Fase 6)

> Estado do repo (atualizado em 2026-11-05, base `0c6476b`): applicationId
> `app.verbete.game`, versionCode 8 / versionName 2.1.4
> (`android/app/build.gradle`); permissões INTERNET e VIBRATE. Desde
> 2026-07-27: ícones adaptativos + monocromático e splash da marca
> gerados de `resources/` (fonte: `scripts/gen-brand-assets.mjs`), R8 ligado com
> keep-rules do Capacitor, deep links `/?join=` no manifest, botão voltar
> tratado (`src/lib/native.ts`). O CI (`.github/workflows/android.yml`) builda o
> APK de debug a cada push e a release assinada via `workflow_dispatch` quando
> os secrets do keystore existirem.

## 1. Keystore de assinatura (uma única vez — NUNCA vai para o repo)

No PC (precisa apenas do Java, já instalado):

```bash
keytool -genkeypair -v -keystore verbete-release.jks -alias verbete \
  -keyalg RSA -keysize 4096 -validity 10000
```

- Guarde `verbete-release.jks` e as senhas num cofre (perder = nunca mais
  atualizar o app na Play Store com esse pacote).
- `android/.gitignore` já ignora `*.jks` e `key.properties`.

### 1a. Secrets no GitHub (para o CI assinar)

Em Settings → Secrets and variables → Actions do repo, crie:

| Secret | Valor |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | saída de `base64 -w0 verbete-release.jks` (no PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("verbete-release.jks"))`) |
| `ANDROID_KEYSTORE_PASSWORD` | senha do keystore |
| `ANDROID_KEY_ALIAS` | `verbete` |
| `ANDROID_KEY_PASSWORD` | senha da chave |

Depois: aba Actions → workflow "Android" → Run workflow → baixe o artifact
`verbete-release-aab`. **Arquive o AAB aprovado fora do GitHub** (o artifact
expira: o candidato de agosto sumiu com 30 dias; desde o M1 a retenção é 90).

### 1a'. Configuração pública do bundle nativo (M1)

O app instalado empacota um bundle fixo, então a configuração pública vai
no próprio build: `.env.capacitor` (versionado — só URL do Supabase, chave
**publicável** e `VITE_APP_URL`, os mesmos valores que o site entrega a
qualquer visitante). `vite build --mode capacitor` **falha** sem esses
valores, com chave secreta/service_role ou com APP_URL local
(`build/native-env.ts`), e embute o `versionCode` (trava remota de versão
mínima), o `versionName` e o SHA do commit (rodapé de versão da Home).
O rodapé segue o **canal do build** (`VITE_RELEASE_CHANNEL`,
`src/lib/version-label.ts`): o bundle nativo sai como **teste interno** por
padrão (`Teste interno · v{versionName} ({versionCode}) · {sha}`); o AAB de
produção sai com `VITE_RELEASE_CHANNEL=production` (rodapé só
`v{versionName}`). Canal desconhecido bloqueia o build.
`scripts/smoke-native-bundle.mjs`
confere o bundle gerado. Antes do M1 o CI gerava APK/AAB "verde" que não
conectava ao servidor.

### 1b. Build local (alternativa, exige Android Studio)

Crie `android/key.properties` (não versionado):

```
storeFile=../verbete-release.jks
storePassword=...
keyAlias=verbete
keyPassword=...
```

E rode `cd android && ./gradlew bundleRelease`.

## 1c. Validação da trilha nativa (nota para auditorias)

A fonte de verdade da trilha nativa é o **workflow Android do GitHub
Actions** (`.github/workflows/android.yml`): a cada push ele roda
`vite build --mode capacitor` → `cap sync android` → Gradle (APK debug +
testes) e publica os artifacts; via *workflow_dispatch* gera também o
**AAB assinado**. Um run verde = trilha validada de ponta a ponta.

O passo de prerender do TanStack Start sobe um servidor `vite preview`
local e faz fetch de `127.0.0.1:<porta>` para gerar o `index.html` do
shell. Em sandboxes restritos (agentes de IA, containers sem loopback
IPv4 completo) esse fetch pode falhar com `ECONNREFUSED` mesmo com o
código íntegro — nesses ambientes, valide pelo CI e seus artifacts em
vez do build local. Pista de diagnóstico: conferir se `vite preview
--host 127.0.0.1` sobe e responde (descarta conflito de binding
IPv4/IPv6 do loopback).

## 2. Conta e ficha na Play Console

1. Conta de desenvolvedor: https://play.google.com/console (taxa única US$ 25).
2. Criar app → Jogo → Gratuito → Palavras.
3. Ficha da loja (pt-BR) — limites do Play: nome ≤ 30, descrição curta
   ≤ 80, descrição completa ≤ 4.000 caracteres:
   - Nome (27/30): **Verbete: blefe com palavras**
   - Descrição curta (77/80): "Invente definições falsas para palavras raras
     e descubra qual é a verdadeira!"
   - Descrição completa: texto pronto no pacote do lançamento (não citar
     chat, número de palavras nem "para crianças/família").
   - Recursos visuais: pasta
     `C:\Users\titov\Desktop\CLAUDE CODE\verbete-release\play-store-light-2026-10-28`
     (ordem no `LEIA-ME.txt`): `icon-512.png` 512×512 PNG 32 bits com alfa;
     `feature-1024x500.png` 1024×500 RGB sem alfa; 7 capturas
     `shot-1…7-*.png` **1080×1920** (proporção 1,78:1, tema claro, sem chat).
   - **Não usar** `resources/store/shot-*.png` (1170×2532, proporção 2,16:1,
     acima do máximo 2:1 do Play) nem `resources/store/icon-512.png` (RGB sem
     alfa). Não enviar `PREVIEW-GERAL.png`.
4. Classificação etária (questionário IARC): sem violência, sexo, drogas,
   apostas ou compras. **Os usuários interagem: Sim** — por texto
   (definições inventadas e apelidos vistos na sala, nome exibido no
   ranking público) e reações por emoji predefinidos. **Não há chat livre**
   (removido em 20/10/2026), voz nem imagem. Não compartilha localização nem
   dados pessoais com outros usuários. Aceitar a classificação resultante.
5. Segurança dos dados: rascunho completo, por tipo de dado e com o nível
   de certeza, em `docs/google-play-data-safety-draft.md` (atualizado em
   05/11/2026: Gemini no plano gratuito = **compartilhamento** do conteúdo
   gerado pelo usuário com o Google; registros de limite do Desafio
   `daily_eval_claims`/`ai_quota` por 3 dias). Permissões do app: internet e
   vibração (normal, sem prompt). Links (publicar o site antes):
   https://jogo.verbete.workers.dev/privacy e, para o campo de exclusão de
   conta, https://jogo.verbete.workers.dev/delete-account. Contato oficial:
   `titoviveiros@hotmail.com` (decisão do Tito, 26/10) — **gate: teste de
   recebimento ainda não documentado**.
6. Público-alvo pretendido: **13 anos ou mais** (decisão do Tito,
   27/10/2026; não declarar a faixa de 9–12 anos). A classificação
   indicativa será a atribuída pela IARC/ClassInd e poderá ser diferente da
   faixa de público-alvo (por exemplo, "10 anos") — responder o IARC de forma
   factual, sem buscar resultado, e aceitar a classificação resultante. As
   páginas públicas falam só do público-alvo, nunca de classificação.
7. Upload do AAB no trilho **Teste interno** primeiro → testar. Para a
   **Produção**, gerar um AAB NOVO com `VITE_RELEASE_CHANNEL=production` e
   `versionCode` maior (mesmo `versionName` quando aplicável): o AAB do teste
   interno mostra "Teste interno" no rodapé e não deve ser promovido. O
   input do canal no `android.yml` entra na rodada de produção (decisão do
   Tito, 26/10).
8. Declaração de comerciante (trader, UE/Reino Unido): status da CONTA em
   Gerenciar conta → Detalhes da conta → Sobre você; se for trader, confirmar
   também POR APP em Monitorar e melhorar → Políticas e programas → Conteúdo
   do app. Contas existentes: até 01/02/2027; exibição pública a partir de
   01/03/2027. Decisão do dono — ver
   https://support.google.com/googleplay/android-developer/answer/17594752
9. Antes de colar o Data Safety: `/privacy` publicada com o texto de
   05/11/2026 (Gemini no plano gratuito + registros de 3 dias do Desafio) e
   nome do responsável preenchido (igual ao da conta do Play Console).

## 3. App Links verificados (`/?join=` abre direto no app)

✅ FEITO (2026-07-28): keystore gerado em `C:\Users\titov\verbete-release\`
(senha em SENHAS-LEIA-ME.txt — **faça backup da pasta num cofre!**), os 4
secrets cadastrados no GitHub Actions, e o
`https://jogo.verbete.workers.dev/.well-known/assetlinks.json` publicado com
o SHA-256 do certificado.

⚠️ Se ativar o **Play App Signing** na Play Console (recomendado), o Google
re-assina o app com uma chave própria — aí é preciso ADICIONAR o SHA-256 de
Play Console → Setup → App integrity → "App signing key certificate" ao
assetlinks.json (me avise que eu adiciono).

## 4. Login Google

✅ FEITO (2026-08-02): OAuth client "Verbete Web" criado no Google Cloud
pelo Tito; provedor ativado no Supabase via Management API; botão
"Entrar com Google" no ar no /login (deploy aef02b2) — clique validado
navegando até accounts.google.com.

✅ VALIDADO (2026-08-02): login real completado pelo Tito — identidade
google vinculada à conta existente (provedores email+google, admin
intacto). Fluxo 100% funcional.

Login Apple: só quando houver conta Apple Developer (US$ 99/ano) — fica para
a versão iOS.

### 4a. Login no app Android (Google e confirmação de e-mail)

O WebView do app roda em `https://localhost` — essa origem não serve de
retorno (fora do WebView ela não existe, e o Supabase a descarta e manda o
navegador para a URL do site, deixando a sessão no navegador e não no app).
O app volta por `app.verbete.game://auth/callback` (esquema próprio =
`custom_url_scheme` do `strings.xml`, intent-filter no Manifest), em PKCE: o
retorno traz só um código, que vira sessão com o verificador guardado no
próprio app. Código: `src/lib/auth-redirect.ts` e `src/lib/native-auth.ts`.

**Configuração externa necessária (uma vez):**

- **Supabase** → Authentication → URL Configuration → *Redirect URLs*:
  adicionar `app.verbete.game://auth/callback` (manter as duas URLs do
  site que já estão lá). Sem isso o login do app volta para o site.
- **Google Cloud:** nada muda — o Google só fala com o Supabase
  (`https://<projeto>.supabase.co/auth/v1/callback`, já cadastrado).
- **Android:** nada a configurar — esquema `app.verbete.game` já no Manifest.

Teste no aparelho (depois da URL acima): instalar o APK, tocar "Entrar com
Google", escolher a conta, voltar ao Verbete já no Perfil; fechar e reabrir o
app (continua logado); "Sair" volta ao modo convidado.

## 5. iOS (futuro)

Exige Mac ou CI com macOS + conta Apple Developer. O projeto Capacitor iOS já
existe (`ios/`); ícones/splash saem do mesmo `npm run cap:icons -- --ios`.
