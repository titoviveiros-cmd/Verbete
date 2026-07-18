# Verbete — Setup do projeto próprio

Guia passo a passo para colocar o Verbete no ar de forma independente
(sem Lovable): Supabase próprio + GitHub + deploy web + apps mobile.

A ordem importa. Os passos 1–3 são pré-requisitos que **só você pode
fazer** (criar contas e instalar programas); a partir daí o assistente
consegue executar tudo desta máquina.

---

## 1. Instalar ferramentas nesta máquina (Windows)

1. **Node.js LTS** — baixe em <https://nodejs.org> (versão LTS, instalador
   `.msi`). Confirme depois num terminal novo: `node --version` e `npm --version`.
2. **Supabase CLI** (depois do Node): `npm install -g supabase`.
3. (Fase Android, pode deixar pra depois) **Android Studio** —
   <https://developer.android.com/studio>.

## 2. Criar o projeto Supabase

1. Crie conta em <https://supabase.com> (plano Free serve para começar).
2. Crie um projeto (ex.: `verbete`), região `South America (São Paulo)`.
3. Anote em **Project Settings → API**:
   - `Project URL` (ex.: `https://abcd1234.supabase.co`)
   - `anon public` key
   - `service_role` key (secreta — nunca no frontend)

### 2.1 Aplicar as migrations

Com o CLI (recomendado — aplica as ~70 migrations na ordem certa):

```sh
cd verbete
supabase login
supabase link --project-ref <project-ref>   # o trecho antes de .supabase.co
supabase db push
```

### 2.2 Configurações manuais no banco (SQL Editor)

```sql
-- pg_cron já é criado pela migration; confirme que o job existe:
SELECT * FROM cron.job;

-- URL/key para o bônus de similaridade disparado via pg_net:
ALTER DATABASE postgres SET app.settings.supabase_url = 'https://<project-ref>.supabase.co';
ALTER DATABASE postgres SET app.settings.supabase_anon_key = '<anon-key>';
```

### 2.3 Edge functions + secret de IA

1. Gere uma chave do Gemini em <https://aistudio.google.com/apikey> (grátis).
2. Deploy e secret:

```sh
supabase functions deploy bot-definitions score-similarity
supabase secrets set GEMINI_API_KEY=<sua-chave-gemini>
```

### 2.4 Auth

- **Email/senha**: já funciona por padrão.
- **Google/Apple** (opcional): Authentication → Providers → habilite e
  preencha com credenciais OAuth próprias (Google Cloud Console / Apple
  Developer). Sem isso os botões sociais do login retornam erro — pode
  lançar só com email/senha primeiro.

## 3. GitHub

1. Crie um repositório (ex.: `verbete`) em <https://github.com/new>, privado.
2. Nesta pasta: 

```sh
git remote add origin https://github.com/<seu-usuario>/verbete.git
git push -u origin master
```

## 4. Deploy web (Cloudflare Pages/Workers)

O projeto já tem `wrangler.jsonc` (build para Cloudflare). Caminho:

1. Conta em <https://dash.cloudflare.com> (grátis).
2. Workers & Pages → Create → conecte o repo GitHub.
3. Build command `npm run build`; variáveis de ambiente:
   - `VITE_SUPABASE_URL` = Project URL do passo 2
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = anon key
   - `VITE_APP_URL` = URL pública final (ex.: `https://verbete.pages.dev`
     ou seu domínio próprio)
4. Coloque uma imagem `public/og-verbete.jpg` (1200×630) para os cards de
   compartilhamento — a antiga era um asset hospedado no CDN do Lovable.

Local, antes do deploy, o ciclo de teste é:

```sh
npm install
cp .env.example .env   # e preencha (arquivo de exemplo abaixo)
npm run dev            # http://localhost:5173
```

`.env` local:

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<anon-key>
VITE_APP_URL=http://localhost:5173
# Server-side (SSR/server functions):
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
GEMINI_API_KEY=<chave-gemini>
```

## 5. Apps mobile (Capacitor)

Android (requer Android Studio):

```sh
npm install @capacitor/android
npx cap add android
npm run cap:android
```

Depois: keystore de assinatura + conta Google Play Console (US$ 25 única)
para publicar. iOS requer um Mac com Xcode (ou CI na nuvem tipo
Codemagic) + conta Apple Developer (US$ 99/ano) — o projeto iOS já está
configurado em `capacitor.config.ts`.

## 6. Verificação pós-setup (roteiro de teste)

1. `npm run dev`, abra duas abas anônimas → criar sala numa, entrar com o
   código na outra (mín. 2 jogadores).
2. Jogue uma rodada completa: escolher palavra → escrever → votar →
   revelação (deve mostrar o card "📖 Sobre a palavra") → placar com
   +100/+50 → próxima rodada automática após 8s.
3. Deixe o timer estourar numa fase → confirme prorrogação com -25 pts e,
   na 3ª falta, remoção.
4. Fim de partida: pódio + "Destaques da partida" + banner de XP (logado).
5. Chat: mande mensagem no lobby, confirme que bloqueia durante a rodada
   e libera na revelação.
6. Home → "🎲 Partida rápida" em duas abas → ambas devem cair na MESMA
   sala pública.
7. Bots: adicione um bot no lobby e confira definições geradas por IA
   (se a GEMINI_API_KEY estiver ok; sem ela, usa fallback local).

## Problemas conhecidos / dívidas

- `words.meaning` é legível pelo client (herdado do design original);
  um jogador técnico consegue consultar o significado. Mitigação futura:
  grants por coluna + RPCs. Não bloqueia o lançamento.
- A meta de 10.000+ palavras: o seed traz ~110 curadas; gere lotes por IA
  usando `supabase/migrations/20260713111000_words_seed_v2.sql` como
  gabarito e revise antes de aplicar.
- Push notifications, referral e Android nas lojas: próximas fases.
