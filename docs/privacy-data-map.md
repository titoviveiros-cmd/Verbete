# Verbete — Mapa de dados e privacidade

> Atualizado em 05/11/2026 · base `0c6476b` (master; PR de privacidade
> `docs/privacidade-loja`). Substitui o mapa de 02/10 (HEAD `e811635`) e as
> atualizações M1/2A, que tinham linhas superadas (chat ativo, salas sem
> prazo, exclusão "só pelo /support", contato pendente).
> Fontes: migrations em `supabase/migrations/`, `src/lib/account-deletion.ts`,
> `src/lib/ops.ts`, `supabase/functions/_shared/{ai,semantic}.ts`,
> `src/lib/daily.functions.ts`. Detalhe da exclusão tabela a tabela:
> `docs/exclusao-de-conta.md`. Formulário do Play:
> `docs/google-play-data-safety-draft.md`. **Nenhuma consulta à produção** —
> que as migrations citadas estejam aplicadas é informação do dono (NÃO
> VERIFICADO aqui).

## Mapa de dados (código atual)

| Dado | Fonte | Armazenado | Quem vê / recebe | Opcional | Finalidade | Processador | Retenção | Na exclusão de conta |
|---|---|---|---|---|---|---|---|---|
| E-mail (e senha) | cadastro / Google | Supabase Auth | ninguém no jogo | sim (conta opcional) | login | Supabase | até excluir | apagado |
| Nome, e-mail e foto do Google | OAuth | metadados do Supabase Auth | ninguém no jogo (a foto não é exibida) | sim (só login Google) | login | Google, Supabase | até excluir | apagado |
| `user_id` (sessão anônima ou conta) | Auth (sessão anônima no boot) | Postgres | outros jogadores via `players`/`profiles` (UUID) | não | vínculo de dados, autoria, abuso | Supabase | convidado: 30 dias sem uso | conta apagada; UUID residual em salas/denúncias |
| Código de jogador (aparelho) | `localStorage` | aparelho + `players`, `banned_players`, `reports` | jogadores da sala | não | identidade na sala, banimento por aparelho | Supabase | salas 30 d após encerrar; banimento sem prazo | fica (pseudônimo) |
| Apelido, avatar, cor | usuário | `players` / `profiles` | sala; ranking público (nome exibido) | apelido obrigatório | jogo | Supabase | salas 30 d; perfil até excluir | perfil apagado; salas ficam até expirar |
| Definições, votos, reações, pontuação | usuário | tabelas da sala | sala; definições → Google Gemini | não | jogo, bônus 🧠 | Supabase + Google | última partida de cada sala, 30 d após encerrar | ficam até expirar |
| Palpites do Desafio Diário | usuário | `daily_attempts` | ninguém; texto → Google Gemini | não (para jogar o Desafio) | Desafio | Supabase + Google | até excluir (convidado: 30 d sem uso) | apagados |
| Limite de uso do Desafio (V2) | servidor | `daily_eval_claims` (user_id + hora + estado), `ai_quota` (chave `daily_user:<uid>`, contador) | ninguém (só `service_role`) | não | evitar avaliação duplicada e abuso da IA | Supabase | **3 dias** (`daily_guard_cleanup`, cron horário `verbete-daily-guard-cleanup`) | **não apagado na hora**; expira em 3 dias |
| Progresso (XP, stats, conquistas, histórico) | jogo | `user_stats`, `user_achievements`, `match_history` | ranking público (stats) | não | progressão | Supabase | até excluir (convidado: 30 d sem uso) | apagado |
| Denúncias | usuário | `reports` | moderação | — | moderação | Supabase | 180 d após resolução; pendente até análise | fica |
| Banimentos | moderação | `banned_players` | moderação | — | segurança | Supabase | sem apagamento automático | fica |
| Chat (desativado em 20/10/2026) | — | `room_messages` antigas | — | — | — | Supabase | saem com a sala (30 d) | ficam até expirar |
| Telemetria de erro/saúde | `ops.ts`, Edges, Worker | `ops_events` (hash de sessão/sala; sem nome, e-mail, IP, palpite) | equipe | não | estabilidade | Supabase | 30 dias | fica até expirar |
| Presença na mesa | jogo | `room_presence` | sala | não | tempo real | Supabase | 2 dias | fica até expirar |
| IP / logs de infraestrutura | provedores | logs de Supabase, Cloudflare, Google Fonts | provedores | — | operação | Supabase, Cloudflare, Google | prazos dos provedores (NÃO VERIFICADO) | não controlado pelo app |

## Google Gemini (único provedor de IA)

- Envia: palavra, definição verdadeira e textos das definições da rodada
  (inclusive humanas) para o juiz 🧠 (`score-similarity`); palavra,
  verdadeira e palpite para o Desafio (Worker); palavra, verdadeira e
  definições anteriores **dos bots** para gerar bots. Corpo = `model`,
  `messages`, `temperature` (`_shared/ai.ts`). **Sem** nome, apelido, e-mail,
  `user_id` ou código de jogador.
- **Plano gratuito** da API (informação do dono). Pelos termos adicionais da
  Gemini API (vigência 23/03/2026, https://ai.google.dev/gemini-api/terms), no
  plano gratuito o Google usa o conteúdo enviado e as respostas para
  fornecer, melhorar e desenvolver produtos, e revisores humanos podem ler
  esse conteúdo. Consequências: a `/privacy` diz isso (05/11/2026) e o Data
  Safety declara **compartilhamento** do "Outro conteúdo gerado pelo usuário"
  com o Google.
- Os mesmos termos exigem 18+ e vedam uso em serviço direcionado a ou
  provavelmente acessado por menores de 18. O público-alvo do Verbete é 13+.
  **Decisão pendente do dono** — este mapa não a resolve; os textos públicos
  não afirmam conformidade com essa cláusula.

## Contato

`titoviveiros@hotmail.com` (constante `CONTACT_EMAIL` em `src/lib/legal.ts`),
usado em `/privacy`, `/terms`, `/support`, `/download` e `/delete-account`.
Gate pendente: teste de recebimento documentado.

## Lacunas conhecidas

- Identidade do responsável (controlador) não aparece na `/privacy`:
  depende do nome do desenvolvedor exatamente como na conta do Play Console.
- `daily_eval_claims`/`ai_quota` não saem em `deleteAccountData` (expiram em
  3 dias). Incluir os dois DELETEs é opção futura (sem migration).
- `android:allowBackup="true"` (P2): backup do Android pode copiar sessão e
  código de jogador para o backup do próprio usuário.
