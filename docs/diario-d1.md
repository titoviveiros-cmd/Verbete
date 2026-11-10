# Desafio Diário D1 — modo escolha (múltipla escolha, sem IA)

> Aprovação consolidada do dono em 08/11/2026 (D-a … D-f). Implementação **INATIVA**: a migration grava
> `app_config.daily_mode = 'juiz'` (o fluxo atual) e nada muda para o jogador até a ativação autorizada.

## 1. Decisões aprovadas

| # | Decisão |
|---|---|
| D-a | `daily_mode = 'escolha'` é **fixo** quando ligado: não volta ao juiz sozinho quando `ai_mode` muda. `'juiz'` = fluxo atual (padrão); `'pausa'` = Diário pausado. Valor ausente ou inválido = `'juiz'`. |
| D-b | 4 alternativas: a verdadeira + 3 distratores. |
| D-c | Acerto = `max(round(max(100 − t, 20) × 0,5), 10)` → **10 a 50**; erro = **0**; `t` = segundos medidos **no servidor** (abertura das alternativas → resposta), limitado a 600. |
| D-d | Os pontos entram **uma vez** no total do ranking global (`user_stats.total_score`), sem fator extra. Nenhum ponto histórico muda. |
| D-e | ≥ 168 conjuntos aprovados antes de ligar; distratores = **definições reais de outras palavras publicadas** do acervo (sem IA); aprovação humana individual ou em lote **selecionado** em `/admin/daily-choices`; nunca automática. |
| D-f | Web + Android vc9 (mesmo bundle). O APK 2.1.4 (vc8) instalado recebe uma mensagem segura ("agora é de múltipla escolha… tentativa NÃO foi gasta"). |

## 2. Como funciona

- **Abrir** (`startDailyChoice` → `daily_choice_start`): cria a sessão da hora (ordem embaralhada pelo servidor, início do relógio). Reabrir na mesma hora devolve a **mesma ordem e o mesmo relógio**. A resposta leva só `word`, `category`, `options[{pos,text}]` e `elapsed_s`: nunca a posição da correta, ids ou hash.
- **Responder** (`submitDailyChoice({pos})` → `daily_choice_finish`): o cliente manda só a posição (o schema rejeita `timeSeconds`). O servidor calcula o tempo, o acerto e os pontos, grava `daily_attempts(mode='escolha', similarity=0)` e atualiza sequência/total/conquistas por `daily_record_participation` — **cópia fiel** do bloco de `submit_daily_attempt_scored` (que fica intocada; md5 `e41b8c87…`), com teste de paridade em 36 estados.
- **Uma tentativa por hora nos dois modos:** a mesma trava consultiva da V2 (`pg_advisory_xact_lock(usuário|hora)`) + `UNIQUE(user_id, challenge_hour)`.
- **Sorteio:** no modo escolha, só palavras com conjunto **aprovado**, palavra **publicada** e definição igual à revisada; **aleatório entre as 24 menos usadas** (a próxima palavra não é previsível; com N aprovados não repete antes de N − 24 horas: 168 → 6 dias). Nos dois modos o sorteio passou a exigir `status = 'published'`.
- **Palavra só junto com as alternativas (Red Team 08/11):** no modo escolha `get_or_create_daily_challenge` devolve `"?"`; a palavra chega em `daily_choice_start`, quando o relógio começa. `daily_challenges` só é legível para horas encerradas. No multiplayer, `choose_word` recusa a palavra da hora do Diário (`word_unavailable`) e ela sai das opções do coordenador — escolher qualquer palavra numa sala e ver a revelação entregava a definição exata.
- **Resposta presa à hora vista:** o envio leva a hora das alternativas; outra hora = `hour_changed` (nada gasto) e a tela volta ao início.
- **Modo ilegível = recusa:** se a leitura de `daily_mode` falhar (fora "função ausente"), o envio do juiz é recusado sem gastar a tentativa.
- **Forma uniforme:** as 4 alternativas aparecem com maiúscula inicial e sem pontuação final (a correta não se denuncia pela forma).
- **Telemetria:** `ops_events` `daily_choice_start` / `daily_choice_finish` com `{mode, result, latency_ms}`. Nunca palavra, alternativas, escolha ou jogador.
- **Aprovação só por hash (R1/R6):** toda aprovação leva o hash v1 (`verbete-d1-v1`, id, definição, 3 alternativas) do que o revisor viu: no painel principal, o que está **na tela** (com uma edição aberta, o painel não aprova: salvar ou cancelar antes); no manifesto, o que foi revisado fora. O servidor confere e explica; o banco recalcula na mesma transação do UPDATE (`daily_choice_admin_review_hashed`, trava a linha, só aprova **rascunho** cujo conteúdo atual tem aquele hash). O Worker não aprova sem hash: chama `daily_choice_admin_review` (a função antiga) só para reprovar ou voltar a rascunho (`oldReviewStatus`). **Limite conhecido:** a função antiga, no banco, ainda aceita `'aprovado'` sem hash; um rollback do Worker para uma Version anterior à R6 (ex.: bc4a1cf5) volta a aprovar sem hash. Fechado no banco pela **R6b** (`20261110180000_d1_r6b_aprovar_so_por_hash.sql`): a função antiga recusa `'aprovado'` com erro 42501 (nada é gravado) e só reprova ou volta a rascunho; rollback em `supabase/rollback/d1_r6b_aprovar_so_por_hash.sql` (devolve o corpo anterior byte a byte). Até a R6b ser aplicada, o limite acima vale. Ordem: publicar o Worker do R6 antes da R6b (um Worker anterior passaria a mostrar erro no "✅ Aprovar" do painel principal, sem gravar nada). Um **reprovado** não é aprovado de uma vez: no painel, "↩ Voltar a rascunho" (com confirmação, porque ele volta a ser aprovável, inclusive por manifesto) e depois aprovar.
- **Segurança:** tabelas `daily_choice_sets` e `daily_choice_sessions` com RLS e sem acesso para `anon`/`authenticated`; todas as funções novas só para `service_role` (o Worker); a revisão confere o papel admin no servidor.

## 3. Procedimento de ativação (cada passo exige autorização própria)

| # | Passo | Verificação | Rollback |
|---|---|---|---|
| 1 | Merge do PR do D1 | CI 5/5 verde | revert |
| 2 | Migration `20261108120000_diario_d1_escolha.sql` em produção | `daily_mode = 'juiz'`; md5 de `submit_daily_attempt_scored` = `e41b8c87…`; Diário igual | inerte (aditiva) |
| 3 | Worker novo **sem tráfego** (`wrangler versions upload`) e smoke na Version URL | Diário no modo juiz igual ao atual; `/admin/daily-choices` abre | não promover |
| 4 | Promover o Worker para 100% | 7/7 páginas, console limpo | `wrangler rollback` para a versão anterior |
| 5 | `/admin/daily-choices` → **Gerar rascunhos** (repetir até cobrir as elegíveis) e **revisar** | contador "aprovados jogáveis" ≥ **168** | reprovar/editar |
| 6 | **Lançamento:** `daily_mode = 'escolha'` (autorização expressa) e 1 rodada numa conta de teste | `ops_events daily_choice_*` com `result=ok`/`correct`/`wrong`; 0 `judge_ai_*` do Diário | `daily_mode = 'juiz'` |
| 7 | Observar 24–48 h | 0 tentativas duplicadas; `sem_estoque` = 0; nenhuma reclamação | idem |
| 8 | Só depois: suspensão do Gemini (sequência própria, `RUNBOOK-CONTENCAO-GEMINI.md`) e AAB vc9 | — | — |

Comando do passo 6 (só com autorização): `DB_URL=... node scripts/set-app-config.mjs daily_mode escolha` (ou o SQL
`UPDATE public.app_config SET value = 'escolha', updated_at = now() WHERE key = 'daily_mode';`).

## 4. Rollback (do mais leve ao mais pesado)

1. `daily_mode = 'juiz'` — volta ao fluxo atual no envio seguinte, sem migration de volta. Uma sessão aberta no modo escolha recebe "modo mudou, recarregue" e **não gasta** a tentativa.
2. `daily_mode = 'pausa'` — Diário pausado nos dois modos, nada gasto.
3. Worker anterior (`wrangler rollback`). O Worker D1 sem a migration também funciona (lê `daily_mode` com falha = `'juiz'`).
4. Remoção total: `supabase/rollback/diario_d1_escolha.sql` (depois do passo 1 e com o Worker anterior). Mantém tentativas, pontos, sequências e conquistas; apaga os conjuntos e as sessões; tira a coluna `mode`.

## 5. Observação (consultas só de leitura)

```sql
SELECT payload->>'result' AS resultado, count(*), round(avg((payload->>'latency_ms')::int)) AS ms
  FROM public.ops_events
 WHERE kind LIKE 'daily_choice_%' AND at > now() - interval '24 hours'
 GROUP BY 1 ORDER BY 2 DESC;

SELECT mode, count(*), round(avg(score), 1) AS pontos_medios, count(*) FILTER (WHERE is_correct) AS acertos
  FROM public.daily_attempts WHERE challenge_hour > now() - interval '24 hours' GROUP BY 1;

SELECT count(*) AS duplicadas FROM (SELECT user_id, challenge_hour FROM public.daily_attempts
  GROUP BY 1, 2 HAVING count(*) > 1) d;
```

## 6. Testes

| Arquivo | Tipo | Critérios |
|---|---|---|
| `src/lib/__tests__/daily-choice.test.ts` | unitário | 1, 4, 8, 9, 17, 21, 22, D-a |
| `src/lib/__tests__/daily-choice-content.test.ts` | unitário | 19 + gerador |
| `src/lib/__tests__/daily-choice-admin.test.ts` | unitário | D-e (rascunho, aprovação só humana) |
| `src/components/__tests__/daily-choice-view.test.tsx` | componente | 1, 2, 3 |
| `src/lib/__tests__/daily-choice-r6.test.ts` | unitário | R6: sem hash = recusa; hash do exibido; reprovado/aprovado; corrida servidor × banco |
| `src/components/__tests__/admin-daily-choices-r6.test.tsx` | componente | R6: o painel envia o hash do que está na tela; reprovados só voltam a rascunho |
| `scripts/test-daily-choice-hash.mjs` | Postgres real (CI) e PGlite (offline) | R1–R4, R6 no banco + corridas (edição, reprovação e 2 aprovações simultâneas) |
| `scripts/test-daily-choice-r6b.mjs` | Postgres real (CI) e PGlite (offline) | R6b: função antiga não aprova (42501); reprovar/rascunho iguais; permissões; rollback byte a byte; corrida aprovação × reprovação |
| `e2e/visual/daily-choice.spec.ts` | navegador (Supabase simulado) | 1, 2, 3, pausa, juiz intacto |
| `scripts/test-daily-choice.mjs` | Postgres real (CI) e PGlite (offline) | 5, 6, 7, 8, 9, 10–16, 18, 21, rollback, Red Team (palavra antes da hora, multiplayer, sorteio imprevisível, hora da resposta) |
| `scripts/test-security-rest.mjs` | Postgres real (CI) | 5 (allowlist) |

Manual na ativação: critério 16 (md5 em produção), 20 (APK 2.1.4 instalado recebe a mensagem segura) e o smoke do passo 6.
