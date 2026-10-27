# Google Play — Segurança dos dados (Data safety): RASCUNHO

> Rodada 2A · 27/10/2026 · base `7413031`. **Rascunho para o proprietário — o
> Play Console NÃO foi preenchido.** Estar só no teste interno não dispensa o
> formulário: ele é exigido para teste fechado/aberto e produção.
> Legenda de certeza: **COMPROVADO** (código/migrations desta base) ·
> **NÃO VERIFICADO** (depende de configuração de produção ou de provedor) ·
> **DEPENDE DO PROPRIETÁRIO** (decisão ou informação que só o Tito tem).
> Detalhe da exclusão e das tabelas: `docs/exclusao-de-conta.md`.

## 1. Visão geral (respostas de topo do formulário)

| Pergunta | Resposta proposta | Certeza |
|---|---|---|
| O app coleta ou compartilha algum dos tipos de dados exigidos? | Sim | COMPROVADO |
| Todos os dados são criptografados em trânsito? | Sim — HTTPS/WSS para Supabase, Worker (Cloudflare), Gemini e fontes | COMPROVADO (URLs `https://` / `wss://`; nenhum `http://` em produção) |
| Há como pedir a exclusão dos dados? | Sim — no app (Perfil → Zona de perigo), no site e por e-mail; URL web: `https://jogo.verbete.workers.dev/delete-account` (**publicar o site antes de informar a URL**) | COMPROVADO no código; página ainda NÃO publicada |
| Dados de conta: o app permite criar conta? | Sim (e-mail/senha e Google); conta é opcional | COMPROVADO |
| Compartilhamento com terceiros | Nenhum, se Supabase, Cloudflare e Google (Gemini) contarem como **prestadores de serviço**; o Gemini depende do plano (ver §4) | DEPENDE DO PROPRIETÁRIO |
| Revisão de segurança independente | Não | COMPROVADO (nenhuma registrada) |
| Política de Famílias | Não se aplica: público-alvo pretendido = 13 anos ou mais (decisão de 27/10/2026), sem a faixa de 9–12; a classificação indicativa virá do IARC/ClassInd e pode diferir | DECIDIDO (preencher só na rodada do Console) |

## 2. Por tipo de dado

| Tipo (categoria do Play) | Coletado? | Compartilhado? | Obrigatório? | Finalidade | Processamento / retenção conhecida | Exclusão | Evidência | Certeza |
|---|---|---|---|---|---|---|---|---|
| **Info pessoal → Nome** (apelido; nome exibido; nome do Google) | Sim | Não (exibição aos jogadores da sala e no ranking é a função do app) | Apelido: obrigatório para jogar; nome do Google: opcional | Funcionalidade, gestão da conta | apelido nas salas até 30 dias após o encerramento da sala; perfil até excluir (convidado: 30 dias sem uso) | perfil sim; apelido nas salas **não** (pedido por e-mail) | `players.nickname`, `profiles.display_name`, `handle_new_user` | COMPROVADO (classificação da exibição pública: DEPENDE DO PROPRIETÁRIO) |
| **Info pessoal → E-mail** | Sim, só com conta | Não | Opcional | Gestão da conta, login | até excluir a conta | sim | `login.tsx` (signUp/OAuth), Supabase Auth | COMPROVADO |
| **Info pessoal → IDs de usuário** (UUID da sessão/conta) | Sim — sessão anônima criada no boot | Não | Obrigatório | Funcionalidade, segurança (autoria das ações), prevenção de abuso | sessão anônima apagada após 30 dias sem uso; UUID fica em `players.user_id` (até a sala sair) e nas denúncias (até 180 dias após a resolução) | conta sim; UUID residual nas salas/denúncias não | `__root.tsx:268-272`, `20260720120000:25` | COMPROVADO |
| **Info pessoal → Outras** (foto de perfil do Google, em metadados do login) | Provável, só com login Google | Não | Opcional | Login | junto da conta | sim (com a conta) | padrão do provedor Google no Supabase Auth; o app não lê a foto | NÃO VERIFICADO |
| **Atividade no app → Interações** (partidas, votos, pontuação, XP, conquistas, histórico) | Sim | Não | Obrigatório para jogar | Funcionalidade, ranking | progresso até excluir (convidado: 30 dias sem uso); votos/pontuação nas salas até 30 dias após o encerramento | progresso sim; salas não | `user_stats`, `match_history`, `votes`, `players.score` | COMPROVADO |
| **Atividade no app → Outro conteúdo gerado pelo usuário** (definições, palpites do Desafio) | Sim | Enviado ao Google Gemini para julgamento — prestador de serviço **ou** compartilhamento, conforme o plano | Obrigatório para jogar | Funcionalidade (bônus 🧠, Desafio), moderação | definições da última partida por sala até 30 dias após o encerramento; palpites até excluir (convidado: 30 dias sem uso) | palpites sim; definições não | `score-similarity`, `daily.functions.ts`, `_shared/semantic.ts` | COMPROVADO (classificação: DEPENDE DO PROPRIETÁRIO §4) |
| **Mensagens → Outras mensagens no app** (chat) | **Não desde 20/10/2026** (chat removido); mensagens anteriores guardadas | Não | — | — | antigas: saem com a sala (30 dias após o encerramento) | não (pedido por e-mail) | `room.ts` (chat removido), `room_messages` | COMPROVADO |
| **Info e desempenho do app → Registros de falhas / Diagnóstico** | Sim (mensagem, stack, rota e versão; hashes de sessão/sala) | Não | Obrigatório (automático) | Análise/estabilidade | **30 dias** (limpeza automática) | automática | `src/lib/ops.ts`, `ops_events` | COMPROVADO |
| **IDs do dispositivo ou outros** (código de jogador gerado na instalação) | Sim | Não | Obrigatório | Funcionalidade, prevenção de abuso (banimento por aparelho) | salas: 30 dias após o encerramento; denúncias: 180 dias após a resolução (pendentes ficam); banimentos: sem prazo | não automaticamente | `src/lib/player-id.ts`, `banned_players` | COMPROVADO |
| Localização (aprox./precisa) | Não (o app não deriva localização; provedores registram IP nos próprios logs) | — | — | — | logs dos provedores: prazos deles | — | permissões só INTERNET e VIBRATE | COMPROVADO (logs de IP dos provedores: NÃO VERIFICADO) |
| Financeiro, saúde, fotos/vídeos, áudio, arquivos, agenda, contatos, navegação, apps instalados, histórico de busca | Não | — | — | — | — | — | `AndroidManifest.xml`; nenhum SDK que colete | COMPROVADO |

## 3. SDKs e terceiros

| Componente | Onde roda | Dados | Observação | Certeza |
|---|---|---|---|---|
| `@supabase/supabase-js` | app/site | sessão, conteúdo do jogo, conta | é o backend (prestador) | COMPROVADO |
| Capacitor (`core`, `app`, `share`, `splash-screen`, `status-bar`) | app Android | nenhum envio próprio | `share` só abre a folha de compartilhar do sistema | COMPROVADO |
| AndroidX (appcompat, coordinatorlayout, core-splashscreen) | app Android | nenhum | — | COMPROVADO |
| Google Services / Firebase | — | — | plugin só aplicaria com `google-services.json`, que **não existe** | COMPROVADO |
| Google Fonts (`fonts.googleapis.com`) | app e site | IP e user agent chegam ao Google | recomendação técnica: hospedar as fontes no app elimina o envio | COMPROVADO |
| Google Gemini (`generativelanguage.googleapis.com`) | só no servidor (edge functions e Worker) | ver §4 | — | COMPROVADO |
| Login com Google (OAuth via Supabase) | navegador externo | nome, e-mail, foto (padrão do provedor) | opcional | COMPROVADO (campos exatos: NÃO VERIFICADO) |
| Cloudflare Workers | servidor web | requisições (IP nos logs do provedor) | sem Workers Logs configurado no `wrangler.jsonc` | NÃO VERIFICADO (configuração da conta) |
| Anúncios, analytics, crash reporting de terceiros | — | — | nenhum SDK | COMPROVADO |

## 4. Gemini — o que vai, de onde, e o que falta

| Fluxo | Onde | Envia | Não envia |
|---|---|---|---|
| Julgamento 🧠 (multiplayer) | edge `score-similarity` | palavra, definição verdadeira, `{id da definição, texto}` de cada definição da rodada (inclusive as humanas) | nome, apelido, e-mail, user_id, player_id |
| Desafio Diário | Worker, `src/lib/daily.functions.ts` | palavra, verdadeira, palpite (id fixo `DAILY_ID`) | idem |
| Definições dos bots | edges `bot-definitions` e `bot-definitions-v2` | palavra, verdadeira, categoria, estilos e definições anteriores **dos próprios bots** | nenhum texto humano |

- Corpo da requisição: só `model`, `messages`, `temperature`; cabeçalho só a
  chave da API (`supabase/functions/_shared/ai.ts:41-53`). COMPROVADO.
- Logs próprios: `console.error` só com motivo/status; `ops_events` com
  contagens, latência, motivo e `room_id` (no erro do juiz) — **sem texto de
  jogo**. COMPROVADO.
- **DECISÃO/VERIFICAÇÃO DO PROPRIETÁRIO:** confirmar o **plano/faturamento da
  API Gemini** do projeto. Sem faturamento (gratuito), os termos do Google
  permitem usar o conteúdo para melhorar produtos — isso pode tornar o envio
  das definições um **compartilhamento** no formulário e exige ajuste na
  Política. Com faturamento, o Google atua como prestador.

## 5. Pendências antes de preencher

1. Publicar o site com `/delete-account` (deploy autorizado) e só então usar a
   URL no campo de exclusão.
2. Confirmar o plano da API Gemini (§4).
3. Retenção DECIDIDA e implementada na Rodada 2B
   (`docs/retencao-e-privacidade-tecnica.md`) — **só vale depois de aplicar a
   migration `20261027200000` em produção**; até lá, os prazos novos não são
   verdade.
4. Idade: público-alvo pretendido decidido (13 anos ou mais); responder o
   IARC de forma factual e aceitar a classificação resultante, que pode ser
   diferente do público-alvo.
5. Teste de recebimento do e-mail oficial (gate do contato).
6. `android:allowBackup="true"`: o backup automático do Android pode copiar o
   armazenamento do WebView (código de jogador, sessão) para o backup do
   usuário — avaliar `false` ou regras de backup (P2, não muda o formulário).
