# Retenção, nome exibido, zoom e auditorias técnicas — Rodada 2B

> Conformidade Google Play · 27/10/2026 · base `482e9a9` (master após o PR #27)
> · branch `compliance/play-data-retention`. **Nada foi aplicado em
> produção**: as migrations estão só no repositório; nenhuma consulta ao
> banco de produção foi feita (volumes reais NÃO VERIFICADOS).

## 1. Retenção implementada (migration `20261027200000_data_retention.sql`)

| Dado | Regra | Nunca entra | Como |
|---|---|---|---|
| Salas encerradas (`rooms` + `players`, `definitions`, `votes`, `reactions`, `rounds`, `room_messages`, `ai_served_defs` por CASCADE; `round_extensions`, `room_words`, `room_presence` à parte) | `status = 'finished'` **e** `finished_at` há > 30 dias **e** última atividade humana há > 30 dias | sala em qualquer outro status; sala com revanche (volta a `lobby` zera `finished_at`) | `retention_purge_rooms` |
| Sessões de convidado (`auth.users` + `profiles`, `user_stats`, `match_history` por CASCADE; `daily_attempts`, `user_achievements` à parte) | `is_anonymous` **e** sem nenhum sinal de uso há > 30 dias: login, sessão, refresh do token, entrada em sala, perfil, estatísticas (`updated_at`, `last_played_hour`), partidas, palpites, conquistas | conta com e-mail/telefone (ou troca pendente), identidade de provedor real (Google/e-mail), papel em `user_roles`, lugar em sala viva | `retention_purge_anon_users` |
| Denúncias | `status` `resolved`/`dismissed` **e** `resolved_at` há > 180 dias | pendente (qualquer idade); fechada sem `resolved_at` (só contada) | `retention_purge_reports` |
| Banimentos | **não tocados** — temporário vale até `expires_at`; permanente nunca é apagado | — | — |

- **`rooms.finished_at`** (novo): gravado por trigger em qualquer caminho que
  ponha `finished` (fim natural, limpeza de zumbis, pausa abandonada) e zerado
  quando a sala volta (revanche). `CHECK`: sala viva não tem `finished_at`.
  Salas já encerradas antes da migration: estimativa conservadora = última
  atividade conhecida + 12 h (o maior prazo de encerramento automático),
  limitada a `now()` — nunca antes do encerramento real.
- **Mecanismo:** `run_data_retention()` num job pg_cron **próprio**,
  `verbete-data-retention`, de hora em hora no minuto 17 — fora do tick de
  1 min (uma falha aqui nunca atrasa as partidas). Limites por execução: 500
  salas, 500 convidados, 1000 denúncias.
- **Idempotente e sem corrida:** cada item é travado com `FOR UPDATE SKIP
  LOCKED` e o critério é reconferido com a linha travada (revanche, login ou
  conversão em andamento → pula e tenta na próxima hora).
- **Observável:** `ops_heartbeat` job `data_retention` (sempre, com as
  contagens); `ops_events` `data_retention` (quando apaga) e `retention_error`
  (quando falha, com o primeiro erro). Fail-safe: erro num item conta e segue.
- **Denúncias sobrevivem à sala:** `reports` não tem FK; guarda texto,
  apelido, player_id, user_id, código e rodada (retrato).
- **Permissão em produção — NÃO VERIFICADO:** o job apaga de `auth.users`
  como o dono da função (`postgres`). Local e CI permitem; se o Supabase
  hospedado negar, o erro aparece em `retention_error` e o resto segue.
- **Ordem de publicação:** aplicar a migration **antes** de publicar o site
  com os textos novos (os prazos só passam a ser verdade depois dela).
- **Rollback:** `supabase/rollback/data_retention.sql` (para a limpeza; o que
  já foi apagado não volta).

Provas: `scripts/test-data-retention.mjs` (job `integration` do CI; casos
A–O, idempotência, limite, cron único, funções fechadas para os clients),
validada também localmente num Postgres em WASM (PGlite) com mutações — cada
guarda removida derruba pelo menos uma verificação.

## 2. Nome exibido (migration `20261027200100_display_name_no_email.sql`)

- **Contas novas:** só o nome digitado; vazio, igual ao e-mail, igual ao
  trecho antes do @ (sem diferenciar maiúsculas) ou com "@" → **Jogador**
  (servidor e `src/lib/display-name.ts` no cliente). Protege também contra o
  cliente antigo, que manda o trecho do e-mail quando o campo fica vazio.
- **Google:** o nome do Google (`name`/`full_name`) **não é usado**: é o nome
  civil completo e viraria nome público (ranking, `profiles` legível por
  qualquer sessão) sem a pessoa escolher. Fica "Jogador"; a troca é no Perfil.
- **Contas existentes:** nada muda. Diagnóstico só de leitura em
  `scripts/diagnose-display-name.sql` (NÃO rodado em produção). Ele separa:
  A/B = metadata sem `display_name` (o trecho veio com certeza do fallback do
  banco) × C = o formulário mandou o trecho (campo vazio **ou** a pessoa
  digitou exatamente isso — indistinguível). Proposta conservadora: renomear
  só A/B não editadas no Perfil, com autorização; C fica.

## 3. Zoom só nas páginas de leitura

- `/privacy`, `/terms`, `/support`, `/delete-account` declaram
  `READING_VIEWPORT` (sem `maximum-scale`/`user-scalable`) — o HeadContent fica
  com a meta da rota mais profunda — e montam `allowPageZoom()`: o atributo
  `data-page-zoom` no `<html>` libera `touch-action` (styles.css) e a pinça do
  iOS (`blockIosPinchZoom` ignora o gesto com o atributo).
- Ao sair, a meta da raiz volta e o atributo sai: o jogo segue em escala fixa
  (`e2e/visual/zoom.spec.ts` intacto).
- **App Android:** `capacitor.config.ts` passa a ter `android.zoomEnabled:
  true` (sem isso o WebView não tem pinça em página nenhuma —
  `Bridge.java:612`). Nas páginas de jogo quem barra é o viewport
  `user-scalable=no` + `touch-action`. **Validar no aparelho** no próximo AAB.
- Provas: `e2e/visual/legal-zoom.spec.ts` (pinça amplia nas 4; voltar ao jogo
  restaura meta, atributo e escala 1; navegar entre legais mantém; Home direta
  segue fixa) + unitários em `final-adjustments.test.ts`.

## 4. Auditorias (sem alteração nesta rodada)

### 4.1 `android:allowBackup="true"` (AndroidManifest.xml:4)

- targetSdk 36: o backup automático do Android (nuvem do Google e
  transferência entre aparelhos) copia o armazenamento do app, inclusive o
  `localStorage` do WebView. Lá ficam: a **sessão do Supabase**
  (`storage: localStorage`, `persistSession: true` — token de acesso e de
  refresh), `verbete:player-id` (código de jogador, base do banimento por
  aparelho), apelido/avatar/cor, `verbete:terms-accepted`, tema e áudio.
- Efeito: restaurar num aparelho novo traz a sessão e o código de jogador (o
  convidado "continua" — conveniente) e também carrega o identificador do
  banimento por aparelho para o aparelho novo (bom para a moderação). Risco:
  token de sessão em backup de nuvem (protegido pela conta Google do usuário;
  refresh token pode estar revogado quando restaurar).
- **Recomendação (P2):** manter o backup, mas excluir a sessão: regras
  `android:dataExtractionRules`/`fullBackupContent` excluindo o diretório do
  WebView, ou `allowBackup="false"` se a continuidade do convidado não importar.
  Não muda o formulário de Data safety.

### 4.2 Google Fonts (`src/routes/__root.tsx:183/187`)

- Fredoka 500/600/700 + Nunito 400/600/700/800 de `fonts.googleapis.com` /
  `fonts.gstatic.com`, no site **e** no app (o bundle offline do Capacitor
  busca as fontes na rede).
- Privacidade: IP e user agent de todo jogador chegam ao Google ao abrir o
  jogo (declarado na Política). App offline/sem rede: cai na fonte do sistema.
- Empacotar é possível (`@fontsource-variable/fredoka` e
  `@fontsource-variable/nunito`, ou os woff2 em `public/fonts`): elimina o envio
  ao Google e o atraso da primeira pintura. Tamanho aproximado (NÃO MEDIDO):
  ~150–250 kB de woff2 nos subconjuntos latin + latin-ext.
- **Recomendação (P2):** empacotar numa rodada própria (mexe no visual; exige
  conferir as telas).

### 4.3 Copy do Desafio

- Regra real: **uma palavra por hora e um palpite por hora**
  (`daily_challenges.challenge_hour` único; `src/lib/daily.ts`,
  `daily.functions.ts`). A tela (`daily.tsx:342`) e o Suporte dizem "um
  palpite por hora" — certo.
- Divergentes: meta description `daily.tsx:42` "Uma nova palavra rara a cada
  dia" e og:description `daily.tsx:47` "Uma palavra rara por dia".
- **Correção mínima proposta (não aplicada):** "Uma nova palavra rara a cada
  hora. Um palpite por hora: acerte o significado, mantenha sua sequência e
  suba no ranking." / og: "Uma palavra rara por hora. Mantenha sua sequência
  🔥". O nome "Desafio Diário" pode ficar (marca).

## 5. Riscos restantes

| Nível | Risco | Situação |
|---|---|---|
| P2 | Ban permanente cuja denúncia de origem (`reason = report:<id>`) é apagada após 180 dias: o ban continua valendo, mas a evidência some | decisão do proprietário: guardar a denúncia enquanto o ban dela durar (uma cláusula) ou escrever o motivo no ban |
| P2 | Permissão de `DELETE` em `auth.users` pelo job no Supabase hospedado | NÃO VERIFICADO; falha aparece em `retention_error` |
| P2 | Convidado apagado com a página aberta há > 30 dias: no próximo uso o refresh falha e o app abre outra sessão de convidado (XP de convidado perdido) | esperado pela regra |
| P2 | `players.user_id` de conta apagada segue nas salas até a sala sair (≤ 30 dias depois do fim) | coberto pela retenção das salas |
| P2 | Volume da primeira execução em produção desconhecido (limites por hora seguram) | acompanhar `ops_heartbeat`/`ops_events` |
| P2 | `zoomEnabled: true` no WebView: o jogo depende do viewport + `touch-action` para não ampliar (provado no Chromium, não no aparelho) | validar no próximo AAB (pinça e duplo toque numa partida; pinça na Política) |
| corrigido | CASCADE `definitions → votes` sem índice em `votes.definition_id` (varredura de `votes` por definição apagada) | índice `idx_votes_definition_id` na mesma migration |
