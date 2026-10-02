# Verbete — Mapa de dados e privacidade
> Auditoria Master Release · 2026-10-02 · HEAD `e811635` (código de app: `17bb348`/`bb08c58`) · produção web `17bb348` · SOMENTE LEITURA (nenhum código de produto alterado)

## Mapa de dados (real, 02/10/2026)

| Dado | Fonte | Coletado | Armazenado | Compartilhado | Opcional | Finalidade | Processador | Retenção | Exclusão |
|---|---|---|---|---|---|---|---|---|---|
| Email | Auth | Sim | Supabase auth | Não | SIM (jogo sem conta) | login/conta | Supabase | conta ativa | deleteAccount |
| user_id | Auth | Sim | Postgres | Não | — | vínculo de dados | Supabase | conta ativa | deleteAccount |
| player_id (device) | localStorage | Sim | device+Postgres(players) | Não | — | identidade de sala | Supabase | sala/limpeza | regenerável |
| Nickname/avatar/cor | usuário | Sim | players/profiles | outros jogadores da sala | — | jogo | Supabase | sala/conta | deleteAccount |
| Partidas/XP | jogo | Sim | match_history/user_stats | Não | — | progressão | Supabase | conta ativa | deleteAccount |
| Chat/blefes | usuário | Sim | room_messages/definitions | sala; blefes→Gemini | — | jogo + juiz IA | Supabase + Google | sem TTL (gap) | com a sala |
| Telemetria | ops.ts | Sim | ops_events (hashes) | Não | — | saúde | Supabase | 30 dias | automática |
| IP/logs | infra | implícito | logs Supabase/CF | Não | — | operação | Supabase/Cloudflare | padrão dos provedores (N/V) | N/V |
| Login Google | OAuth | Sim | auth.identities | Google | SIM | login | Google | conta | deleteAccount |

**Data Safety (Play) derivada:** coleta email (opcional, conta) + IDs de dispositivo (funcionalidade); criptografia em trânsito SIM; exclusão solicitável SIM (in-app + /support). **[NÃO VERIFICADO]**: retenção exata de logs de infra dos provedores.
