# Verbete × KING × TITOKO — Compatibilidade de coleção
> Auditoria Master Release · 2026-10-02 · HEAD `e811635` (código de app: `17bb348`/`bb08c58`) · produção web `17bb348` · SOMENTE LEITURA (nenhum código de produto alterado)

## Compatibilidade de coleção (KING · TITOKO · Verbete)

**Fonte:** inspeção direta dos repos no disco + docs/VERBETE-GAME-DNA.md (KING) — DNA RATIFICADO pelo dono: 'irmãos, não gêmeos'.

### A. DNA compartilhado (comprovável)
| Dimensão | Verbete | KING | TITOKO | Veredito |
|---|---|---|---|---|
| Estética pseudo-3D 'candy' | origem (styles.css) | herdou adaptado | n/d (protótipo) | ✅ coerente |
| Botão com aresta dura + translate no toque | origem | reúso aprovado | n/d | ✅ |
| Cor semântica (menta=positivo, ouro=vitória) | origem | ratificado §13 | n/d | ✅ |
| Mascote com estados | livro (origem) | 'O Rei' (próprio, mesma engenharia) | n/d | ✅ |
| Áudio/haptics por evento | origem (síntese) | reúso técnico aprovado | n/d | ✅ |
| Analytics anônimo + página de privacidade | ❌ só saúde | ✅ PostHog prod, IP off | ❌ ainda não | ⚠️ Verbete deve absorver |
| Versão/protocolo mínimo | ⚠️ só web | ✅ PROTOCOL_VERSION | n/d | ⚠️ absorver p/ APK |
| Portão de deploy multi-cliente | CI forte, sem portão manual | ✅ 28 checagens + rollback | gates humanos (30s/5 pessoas) | ⚠️ absorver como princípio |
| Decisões registradas (DEC-xxx) | plano vivo (informal) | docs formais | DEC-034 etc. | ⚠️ adotar numeração |

### B. DNA exclusivo do Verbete (preservar)
Palavras raras + blefe + humor de festa + chat LIVRE + juiz de IA + identidade roxa/Fredoka + revelação coreografada. **Não importar:** landscape, cartas/mesas, mensagens fechadas, Gabarito.

### C. Veredito
O usuário já percebe 'mesmo estúdio' (ponte estética e de mascote em via dupla). O delta de maturidade é operacional: analytics, versão mínima e portões — endereçados nos marcos M6/M8 do roadmap.
