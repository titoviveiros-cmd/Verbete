# Google Play — Segurança dos dados (Data safety): RASCUNHO

> Atualizado em 05/11/2026 · base `0c6476b` (substitui o rascunho da rodada
> 2A, 27/10, base `7413031`). **Rascunho para o proprietário — o Play
> Console NÃO foi preenchido.** O formulário é exigido para teste
> fechado/aberto e produção.
> Legenda: **COMPROVADO** (código/migrations desta base) · **NÃO
> VERIFICADO** (depende de produção ou de provedor) · **DEPENDE DO
> PROPRIETÁRIO**. Detalhe da exclusão: `docs/exclusao-de-conta.md`; mapa:
> `docs/privacy-data-map.md`.

## 1. Visão geral (respostas de topo do formulário)

| Pergunta | Resposta proposta | Certeza |
|---|---|---|
| O app coleta ou compartilha algum dos tipos de dados exigidos? | **Sim** | COMPROVADO |
| Todos os dados são criptografados em trânsito? | **Sim** — HTTPS/WSS para Supabase, Worker (Cloudflare), Gemini e fontes; `allowMixedContent: false` | COMPROVADO |
| O app permite criar conta? | **Sim** — "Nome de usuário e senha" (e-mail) e "OAuth" (Google); conta opcional (convidado joga sem conta) | COMPROVADO |
| URL de exclusão de conta | `https://jogo.verbete.workers.dev/delete-account` (rota em `0c6476b`; abrir no navegador antes de colar) | COMPROVADO no código; no ar: NÃO VERIFICADO |
| Pode pedir exclusão de alguns dados sem excluir a conta? | **Sim** — por e-mail e "zerar estatísticas" no Perfil | COMPROVADO |
| Revisão de segurança independente (MASA) | **Não** | COMPROVADO |
| Política de Famílias | Não participa (público-alvo 13+) | DECIDIDO (27/10) |

**Compartilhamento:** Supabase e Cloudflare = prestadores de serviço (não
contam). Exibir apelido/definições na sala e nome no ranking = ação
iniciada pelo usuário (isenta). **Google Gemini no plano gratuito =
compartilhamento** do "Outro conteúdo gerado pelo usuário", porque o
Google usa o conteúdo para os próprios fins (melhorar produtos, revisão
humana). Se o faturamento for ativado e o Google passar a atuar só como
prestador, mudar para "Não" — junto com a `/privacy`.

## 2. Por tipo de dado

| Categoria → tipo | Coletado | Compartilhado | Efêmero? | Obrigatório | Finalidades | Retenção | Evidência |
|---|---|---|---|---|---|---|---|
| Informações pessoais → **Nome** (apelido, nome exibido, nome do Google) | Sim | Não | Não | Obrigatório (apelido) | Funcionalidade do app; Gerenciamento da conta | salas: 30 d após encerrar; perfil: até excluir (convidado 30 d sem uso) | `players.nickname`, `profiles.display_name` |
| Informações pessoais → **Endereço de e-mail** | Sim | Não | Não | Opcional | Gerenciamento da conta | até excluir | `login.tsx`, Supabase Auth |
| Informações pessoais → **IDs do usuário** (UUID da sessão/conta) | Sim | Não | Não | Obrigatório | Funcionalidade do app; Prevenção de fraudes, segurança e conformidade | convidado 30 d sem uso; UUID residual em salas (30 d) e denúncias (180 d após resolução); **registros de limite do Desafio: 3 d** | `auth-session.ts`, `players.user_id`, `daily_eval_claims`, `ai_quota` |
| Fotos e vídeos → **Fotos** (foto do Google nos metadados do login; não exibida) | Sim (conservador) | Não | Não | Opcional | Gerenciamento da conta | com a conta | padrão do Supabase Auth — NÃO VERIFICADO |
| Atividade no app → **Interações no app** (partidas, votos, pontuação, XP, conquistas, reações) | Sim | Não | Não | Obrigatório | Funcionalidade do app | progresso até excluir; salas 30 d | `user_stats`, `match_history`, `votes` |
| Atividade no app → **Outro conteúdo gerado pelo usuário** (definições, palpites do Desafio) | Sim | **Sim — Google (Gemini API, plano gratuito)** | Não | Obrigatório | Funcionalidade do app | definições: última partida da sala, 30 d após encerrar; palpites: até excluir | `score-similarity`, `daily.functions.ts`, `_shared/semantic.ts` |
| Mensagens → Outras mensagens no app | **Não** (chat removido em 20/10/2026) | — | — | — | — | mensagens antigas saem com a sala | `room.ts` |
| Informações e desempenho → **Registros de falhas** | Sim | Não | Não | Obrigatório (automático) | Análise | 30 dias | `src/lib/ops.ts`, `ops_events` |
| Informações e desempenho → **Diagnóstico** | Sim | Não | Não | Obrigatório | Análise | 30 dias | idem |
| IDs do dispositivo ou outros → **IDs do dispositivo ou outros** (código de jogador da instalação) | Sim | Não | Não | Obrigatório | Funcionalidade do app; Prevenção de fraudes, segurança e conformidade | salas 30 d; denúncias 180 d; banimentos sem prazo | `player-id.ts`, `banned_players` |
| Local, Financeiro, Saúde, Áudio, Arquivos, Agenda, Contatos, Apps instalados, Navegação, Histórico de pesquisa | **Não** | — | — | — | — | — | manifesto: só INTERNET e VIBRATE |

**Finalidade do compartilhamento com o Google:** "Funcionalidade do app"
(o envio existe para avaliar definições/palpites e gerar bots). O uso
pelo Google para melhorar os próprios produtos é descrito na `/privacy`.

## 3. SDKs e terceiros

| Componente | Onde roda | Dados | Observação | Certeza |
|---|---|---|---|---|
| `@supabase/supabase-js` | app/site | sessão, conteúdo do jogo, conta | backend (prestador) | COMPROVADO |
| Capacitor (`core`, `app`, `share`, `splash-screen`, `status-bar`) | app Android | nenhum envio próprio | `share` só abre a folha do sistema | COMPROVADO |
| AndroidX | app Android | nenhum | — | COMPROVADO |
| Google Services / Firebase | — | — | não aplicado (sem `google-services.json`) | COMPROVADO |
| Google Fonts | app e site | IP e user agent chegam ao Google | — | COMPROVADO |
| Google Gemini (`generativelanguage.googleapis.com`) | só servidor (Edges e Worker) | ver §4 | único provedor de IA | COMPROVADO |
| Login com Google (OAuth via Supabase) | navegador externo | nome, e-mail, foto | opcional | COMPROVADO (campos exatos: NÃO VERIFICADO) |
| Cloudflare Workers | servidor web | requisições (IP nos logs do provedor) | — | NÃO VERIFICADO (configuração da conta) |
| Anúncios, analytics, crash reporting de terceiros | — | — | nenhum SDK | COMPROVADO |

## 4. Gemini — o que vai e como o Google trata

| Fluxo | Onde | Envia | Não envia |
|---|---|---|---|
| Julgamento 🧠 | edge `score-similarity` | palavra, verdadeira, `{id, texto}` das definições da rodada (inclusive humanas) | nome, apelido, e-mail, user_id, player_id |
| Desafio Diário | Worker, `daily.functions.ts` | palavra, verdadeira, palpite | idem |
| Bots | edges `bot-definitions` e `-v2` | palavra, verdadeira, categoria, estilos, definições anteriores **dos bots** | nenhum texto humano |

- Corpo = `model`, `messages`, `temperature`; cabeçalho = só a chave
  (`_shared/ai.ts`). COMPROVADO.
- **Plano gratuito** (informação do dono). Termos adicionais da Gemini API
  (vigência 23/03/2026, https://ai.google.dev/gemini-api/terms): no plano
  gratuito o Google usa o conteúdo e as respostas para fornecer, melhorar e
  desenvolver produtos; revisores humanos podem ler. → compartilhamento no
  formulário; `/privacy` atualizada em 05/11/2026 com link para os termos e a
  Política de Privacidade do Google, e orientação para não escrever dados
  pessoais.
- Os mesmos termos exigem 18+ e vedam uso em serviço direcionado a ou
  provavelmente acessado por menores de 18. **Decisão pendente do dono**
  (público-alvo 13+); este rascunho não a resolve.
- Ponto único nas páginas: `AI_PROVIDER` em `src/lib/legal.ts`
  (`ownUseNotice` não-nulo = "compartilhado" aqui). Trocar o provedor (ex.:
  Workers AI, que não usa o conteúdo para treinar) ou suspender a IA muda
  esta seção e a linha "Outro conteúdo gerado pelo usuário" — revisar junto
  com o objeto, os testes e a data de `/terms`.

## 5. V2 do Diário — registros de limite de uso

| Tabela | Conteúdo | Ligado a | Retenção | Na exclusão de conta |
|---|---|---|---|---|
| `daily_eval_claims` | hora do desafio, `claim_id`, estado, falhas | `user_id` | 3 dias após `updated_at` (cron horário) | não apagada na hora; expira |
| `ai_quota` | contador por janela (`daily_user:<uid>`, `daily_origin:…`, `daily_provider_fail`) | `user_id` na chave | 3 dias após `window_start` | idem |

Fonte: `supabase/migrations/20261105150000_daily_guard_v2.sql` (§8 limpeza,
§10 cron). Sem palpite, palavra ou definição. Entra no formulário dentro de
"IDs do usuário" (Prevenção de fraudes, segurança e conformidade).

## 6. Pendências antes de preencher

1. Nome do responsável na `/privacy` (igual ao da conta do Play Console) —
   DEPENDE DO PROPRIETÁRIO.
2. Decisão sobre a cláusula 18+ dos termos da Gemini API × público 13+ —
   DEPENDE DO PROPRIETÁRIO.
3. Publicar o site com a `/privacy` nova (deploy autorizado) antes de colar
   o formulário, para os dois dizerem a mesma coisa.
4. Teste de recebimento do e-mail oficial.
5. `android:allowBackup="true"` (P2, não muda o formulário).

## 7. Variante "sem IA externa" (rascunho de 10/11/2026 — NÃO aplicar ainda)

> Vale **só depois** de: PR de ativação no ar (`EXTERNAL_AI_MODE =
> "desligada"`, `docs/sem-ia-externa.md`) **e** `GEMINI_API_KEY` removida e
> revogada. Antes disso o formulário acima (com compartilhamento) é o
> verdadeiro. Mudar o Console e o site no mesmo dia.

| Item do formulário | Hoje (§1–§2) | Sem IA externa |
|---|---|---|
| Criptografia em trânsito | Supabase, Worker, Gemini e fontes | Supabase, Worker (Cloudflare) e fontes — **sem Gemini** |
| Atividade no app → Outro conteúdo gerado pelo usuário | Coletado: Sim · **Compartilhado: Sim (Google Gemini)** | Coletado: Sim · **Compartilhado: Não** (exibir na sala = ação do usuário; Supabase/Cloudflare = prestadores) |
| Finalidade do conteúdo gerado | Funcionalidade do app | Funcionalidade do app (moderação incluída) |
| IDs do usuário — evidência dos registros de limite | `daily_eval_claims`, `ai_quota` (3 d) | `daily_choice_sessions` (3 d, apagada com a conta) + resíduos de `daily_eval_claims`/`ai_quota` até expirarem (3 d) |
| SDKs e terceiros | inclui Google Gemini | **remover** a linha do Gemini |
| Demais tipos (nome, e-mail, IDs do dispositivo, interações, falhas, diagnóstico, fotos do login Google) | — | **sem mudança** |
| Política de Famílias | Não participa (13+) | **sem mudança** (13+ não inclui menores de 13) |

Resultado esperado no resumo público: "Nenhum dado compartilhado com
terceiros". Conferir também a ficha da loja (nenhuma menção a "inteligência
artificial"/"Gemini") e o questionário IARC (se houver pergunta sobre IA
generativa, responder "não").
