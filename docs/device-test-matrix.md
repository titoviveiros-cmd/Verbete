# Verbete — Matriz de testes em aparelhos
> Auditoria Master Release · 2026-10-02 · HEAD `e811635` (código de app: `17bb348`/`bb08c58`) · produção web `17bb348` · SOMENTE LEITURA (nenhum código de produto alterado)

## Matriz de dispositivos (mínima real)
| Aparelho | Perfil | O que valida |
|---|---|---|
| Android 9-11, 2GB (ex. Moto G7/Galaxy A20) | LOW | WebView antigo, memória, FPS do reveal, minSdk real |
| Android 13 midrange (ex. Galaxy A54) | MID | caso típico BR |
| Android 15/16 flagship | HIGH | referência |
| Tablet ou 20:9 extremo | ASPECT | safe areas, layout |

× Condições: Wi-Fi · 4G · rede ruim (throttle) · modo avião→reconnect · background/resume · lock/unlock · notificação entrante · teclado. Roteiro = docs/checklist-teste-interno.md (40 testes) por aparelho; nos LOW/MID basta A9-A19 + A25-A29.
iOS: adiado para marco próprio (Mac + conta; pasta ios/ já existe).

## Roadmap de lançamento gratuito
| Etapa | Entry gate | Exit gate | Medir | Rollback |
|---|---|---|---|---|
| INTERNAL (atual) | AAB no teste interno | Checklist A+C 100% | 40 testes | corrigir e regenerar AAB |
| CLOSED BETA (10-20 amigos) | A+C ok + alerting mínimo (OB-01) | 1-2 sem: crash-free >99%, reconnect_success alto, match_completion >80%, zero P0 novo | /admin/ops + feedback | halt do rollout |
| STAGED PÚBLICO 10→50→100% | beta ok + Gemini pago (LS-02) + min_build (RC-01) recomendado | 1 sem por degrau sem regressão | idem + Play vitals | halt + versão correção |
| PUBLIC FREE (divulgação) | 100% estável | — | KPIs do plano de analytics | min_build/kill-switch |
| iOS | decisão + Mac/conta | TestFlight→release | idem | — |

## Monetização futura (prontidão, sem implementar)
Cosméticos (avatares/temas/molduras) cabem em profiles/user_stats + tabela nova; sem anúncios/trackers hoje = ficha limpa; adicionar billing depois não reescreve o produto. Decisão correta: só após D1/D7 reais.
