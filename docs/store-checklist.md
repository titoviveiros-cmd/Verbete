# Checklist de publicação — Google Play (Fase 6)

> Estado do repo (2026-07-27): applicationId `app.verbete.game`, versionCode 2 /
> versionName 2.0.0, ícones adaptativos + monocromático e splash da marca
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
3. Ficha da loja (pt-BR):
   - Nome: **Verbete — jogo de blefe com palavras**
   - Descrição curta (80): "Invente significados falsos, engane seus amigos e
     descubra a definição verdadeira!"
   - Ícone 512×512: exporte de `resources/icon-only.png` (redimensionar).
   - Feature graphic 1024×500: montar com o tile + wordmark (posso gerar).
   - Screenshots: mínimo 2 de celular (tirar do jogo real; posso gerar via
     Playwright nas telas de votação/revelação/pódio).
4. Classificação etária (questionário IARC): sem violência; interação entre
   usuários ON (chat) → provavelmente L/Everyone 10+ por "interação".
5. Segurança dos dados: coleta e-mail (opcional, login), identificadores
   anônimos (sessão anônima), conteúdo do jogo (definições, chat, palpites
   do diário — compartilhados com o Google Gemini para bots e julgamento de
   semelhança), registros de erro anônimos; dados criptografados em
   trânsito; exclusão de conta no próprio app; sem anúncios. Permissões do
   app: internet e vibração (normal, sem prompt). Link da política (texto
   alinhado em 03/10): https://jogo.verbete.workers.dev/privacy
   — **pendente: e-mail de contato real** (os `@verbete.app` da política
   não existem).
6. Público-alvo: 13+ (evita exigências de apps infantis).
7. Upload do AAB no trilho **Teste interno** primeiro → testar. Para a
   **Produção**, gerar um AAB NOVO com `VITE_RELEASE_CHANNEL=production` e
   `versionCode` maior (mesmo `versionName` quando aplicável): o AAB do teste
   interno mostra "Teste interno" no rodapé e não deve ser promovido. O
   input do canal no `android.yml` entra na rodada de produção (decisão do
   Tito, 26/10).

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
