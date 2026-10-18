# M1 — Registro do cutover de produção (passos 0–5)

> 2026-10-03 · autorizado pelo dono para os passos 0–5 do runbook (`docs/m1-preprod-report.md` §11) · passos 6–9 **não** executados (sem merge, sem limpeza de zumbis, sem AAB, sem webhook).

## Resultado por passo

| Passo | Quando (UTC) | Resultado |
|---|---|---|
| 0 · pré-voo (só leitura) | 15:20–15:28 | ✅ com divergência tratada: a métrica "partidas em andamento" deu 37, eram todas salas-zumbi (36 presas em `choosing` desde jul/ago + a sala 7397 em laço na rodada 277); 0 atividade humana. Dono aceitou o critério "0 partidas humanas ativas" e o caminho `--linked` (a senha do banco não está na máquina; a CLI logada usa um papel temporário `cli_login_postgres`) |
| 1 · edges | 16:53 | ✅ `bot-definitions` v7 → **v8**, `score-similarity` v6 → **v7** (`verify_jwt=false`); lixo na entrada recusado no formato novo |
| 2 · build web | 16:54–16:57 | ✅ build do `6138a0e` (código de produto = `d5cb048`); versão no ar anotada para rollback: `f81f22b7-8a9f-4608-8ba9-4d6b7d59cd35` (build `17bb348`) |
| checagem extra (pedida pelo dono) | 16:57–16:58 | ✅ 0 partidas humanas ativas, 0 definições de jogador na última hora, dry-run com as mesmas 5 migrations |
| 3 · migrations | 16:58:28–16:58:52 | ✅ `20261003090000`, `…100000`, `…110000`, `…120000`, `…130000` aplicadas (`db push --linked`) |
| 4 · deploy web | 16:59:19–17:00:56 | ✅ versão `3e666c04-30bb-421f-8996-388a2ee4f170`, serve `6138a0e`; og:image 200; secrets do worker preservados |
| 5 · sonda | 17:01 e 17:31 | ✅ `PRODUÇÃO M1 OK` — 17/17 (catálogo 7, recusas pela API 6, edges 2, web 2) |
| 5 · partidas reais | 17:04–17:29 | ✅ só humanos (6092), bot + coordenador humano (9025, 4533), bot coordenador (7371) — rodada completa até o placar, salas resetadas para o lobby |

## Partidas de validação

`e2e/prod-bot-round.spec.ts` (só roda com `E2E_BASE_URL`; `E2E_RESOLVE` contorna o DNS desta máquina). Tentativas que falharam e por quê:

| Sala | Falha | Causa |
|---|---|---|
| 2138 | tela do convidado presa em "Aguardando o coordenador…" com a sala já em escrita (bot coordenador) | transição animada do cliente (código não alterado pelo M1); **não se repetiu** em 4 rodadas seguintes, inclusive com bot coordenador |
| 5089 | host não viu o convidado | teste: apelido maior que o campo (corta) |
| 5311 | clique em "Sortear palavra" | teste: botão anima sem parar, nunca "estável" para o Playwright |
| 8363 | convidado eliminado | teste: dois blefes quase iguais → servidor recusou o 2º por "parecido demais" (proteção funcionando) |

Nenhuma falha atribuível às mudanças do M1 → **nenhum rollback executado**.

## Sinais de produção após a validação (eventos desde o id 97729)

- `bot_ai_success` 13 · `judge_ai_success` 5 (bônus julgado; nenhum blefe do teste era próximo da verdade) · `bot_ai_error`/`fallback` 0 · `rpc_failure` 0 · `client_error` 0 · `tick_error` 0.
- pg_net → `score-similarity`: 5 chamadas, todas HTTP 200.
- `ops_health_check` a cada 5 min: nenhum alerta (`ops_alerts` vazio); tick com heartbeat a cada minuto, 0 erros.

## Rollback (se um dia for preciso)

- Web: `npx wrangler rollback f81f22b7-8a9f-4608-8ba9-4d6b7d59cd35 --name jogo -m "rollback M1"` + `npx supabase db query --linked -f supabase/rollback/m1_compat_old_client.sql`.
- Banco (sem janela): compat → web → `npx supabase db query --linked -f supabase/rollback/m1_full_rollback.sql` → `npx supabase migration repair --status reverted 20261003130000 20261003120000 20261003110000 20261003100000 --linked`.
- Edges: republicar a partir de `dd443af` com `--workdir` (volta a IA quebrada — só emergência).

## Avisos registrados

- `dist/server/.dev.vars` (gerado pelo plugin do Cloudflare para `wrangler dev`) contém as chaves do servidor; **não é enviado no deploy** (só módulos `*.js` e `dist/client`) e é ignorado pelo git. O bundle público não contém segredo.
- `npm ci` (npm 11) não roda scripts de instalação de `esbuild`/`workerd` sem `allowScripts`; o build e o deploy funcionaram assim.
- Console dos navegadores: `<circle> attribute cx: Expected length, "undefined"` — animação do mascote "pensando" (`src/components/Mascot.tsx`, anterior ao M1); cosmético.
- Sala 7397 (laço do tick, rodada 277+) e as 36 zumbis seguem — limpeza é o passo 7, não autorizado; a regra v2 provavelmente não pega o laço (revisar antes do passo 7).
