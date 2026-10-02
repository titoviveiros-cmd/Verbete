# Verbete — Roadmap de release (lançamento gratuito)
> Auditoria Master Release · 2026-10-02 · HEAD `e811635` (código de app: `17bb348`/`bb08c58`) · produção web `17bb348` · SOMENTE LEITURA (nenhum código de produto alterado)

## Roadmap de implementação (após autorização — NADA executado nesta auditoria)
| Marco | Conteúdo (IDs) | Esforço |
|---|---|---|
| M0 Baseline | esta auditoria + tag da release candidata (RC-03) | feito/h |
| M1 **P0 — integridade e build** | (a) migration RLS: fechar UPDATE/DELETE de players e definitions e INSERT de rounds (mover p/ RPCs existentes), revogar apply_similarity_bonus de anon/authenticated, fechar leitura de room_words.meaning fora do reveal; (b) fix `norm`→`normTxt` + redeploy bot-definitions; (c) android.yml: injetar VITE_SUPABASE_URL/KEY + VITE_APP_URL corretos; (d) subir og-verbete.jpg; (e) share nativo (VIR-02) | ~1-2 dias |
| M1b Robustez P1 | SM-01 (shuffling) · PV-02 (/privacy citar Gemini) · RC-01 (min_build/kill-switch) · OB-04 (confirmar backups) · SEC-05 (rate limit score-similarity) | ~1-2 dias |
| M2 Cobertura de teste | TI-01 (asserção de identidade no E2E) · axe nas fases (AC-01) · regressão p/ SM-01 e p/ os P0 de RLS (sondas de UPDATE direto) · 4 scripts SQL fora do CI (T-03) | ~1 dia |
| M3 Collection Alignment | CD-02: analytics anônimo (M6), min-build (M1), portão de deploy, DEC-xxx | princípios |
| M4 Game feel | achados do domínio motion/game-design (dead time da escrita etc. — ver doc) | sob prévia do dono |
| M5 Mobile | DM-01 (device low) · SC-02 (fontes no bundle) · RC-02 (build id no APK) | ~1 dia |
| M6 Analytics/Observabilidade | OB-01/02/03 (alertas+heartbeat+edge_error) · plano de analytics (docs/analytics-plan.md) | ~2-3 dias |
| M7 Conteúdo | CT-01/02 (pools e limpeza) · lotes rumo a 1.500 (decisão do dono) | editorial |
| M8 Store compliance | SC-04 (confrontar letra atual) · UG-01 (mute) · ficha completa | ~1 dia |
| M9 QA em aparelho real | checklist A+C + matriz de devices | Tito + ~2h análise |
| M10 Closed beta | 10-20 amigos, gates do roadmap de rollout | 1-2 semanas |
| M11 Lançamento público gratuito | staged 10→50→100% | 1-2 semanas |
| M12 Revisão de engajamento | KPIs do plano (D1/D7, completion, rematch) | contínuo |
| M13 Decisão de monetização | só com dados de M12 | — |


## Release Gates
| Gate | Status | Evidência/Condição |
|---|---|---|
| A — BUILD | ✅ web / ❌ nativo | Web: CI verde, produção = HEAD. Nativo: MOB-01 (APK/AAB do CI não conecta — sem env) + VIR-03 (APP_URL morta embutida); AAB candidato também EXPIROU (CI-01) |
| B — GAMEPLAY | ✅ PASS c/ ressalvas | E2E multiplayer + 49 testes SQL verdes; ressalvas SM-01 (deadlock shuffling) e IA-01 (bots 100% em fallback de template desde ~27/07 — jogo funciona, qualidade degradada) |
| C — MULTIPLAYER (integridade) | ❌ FAIL até M1 | UPDATE direto em players (score/user_id), definitions e INSERT em rounds abertos a qualquer client (verificação independente acima) |
| D — SECURITY | ❌ FAIL até M1 | Mesmos P0 de RLS + apply_similarity_bonus executável por anon + verdade de palavra customizada legível (SEC-04) |
| E — DATA/PRIVACY | ✅ PASS c/ pendência | deleção in-app existe e deleta tudo; mapa real ok; PV-02: /privacy deve citar Gemini (P1 textual) |
| F — MOBILE | ❌ FAIL | MOB-01/02/03: build nativo atual é natimorto; zero execução em aparelho real |
| G — CONTENT | ✅ PASS | 1.078 medidas, qualidade amostral 15/15; ressalva CT-01 (pools compostos) |
| H — OBSERVABILITY | ❌ FAIL p/ beta público | OB-01 zero alerting + AN-02 stalled_advance 100% poluído (sinal de backstop cego) |
| I — STORE | 🟡 NOT VERIFIED | ficha em preenchimento; letra atual das políticas não confrontada (SC-04); UG-01 sem block de usuário |
| J — REAL DEVICE QA | ⛔ BLOCKED | exige M1 (APK que conecte) antes do checklist A+C |
| K — FREE BETA | ⛔ BLOCKED | depende de C, D, F, H e J |

