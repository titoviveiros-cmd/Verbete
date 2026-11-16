-- =============================================================================
-- ECA Digital (Lei 15.211/2025, arts. 28–30) + Lei 14.852/2024 art. 16 I–III:
-- denúncia com RETORNO ao denunciante, DECISÃO FUNDAMENTADA, AVISO ao autor,
-- RECURSO e PRAZOS (11/11/2026).
--
-- Antes: o painel só descartava ou banía; ninguém recebia retorno; não havia
-- "remover conteúdo", motivo, indicação humano/automático nem recurso (só
-- e-mail). Agora:
--   * reports.action          — medida: dismiss | remove_content | ban
--   * reports.decision_reason — motivo (código; o texto fica no app)
--   * reports.review_kind     — human | automated (art. 30, II)
--   * banned_players.report_id — liga a suspensão à denúncia (reverter no recurso)
--   * moderation_appeals      — 1 recurso por decisão, com status e resposta
-- Prazos (72 h análise; 15 dias para recorrer; 15 dias para responder) ficam
-- no código (src/lib/moderation-policy.ts) — escolha de produto, não lei.
-- Tudo continua SÓ pelo servidor (service role), como reports desde
-- 20261023190000: nenhuma tabela nova é legível ou gravável pelo cliente.
-- Nada de histórico é alterado: linhas antigas ficam com action/decision_reason
-- nulos (o app trata como "sem aviso ao autor").
-- Retenção: recursos saem junto com a denúncia (ON DELETE CASCADE) no
-- expurgo de 180 dias de 20261027200000_data_retention.
-- ROLLBACK: supabase/rollback/denuncia_retorno_recurso.sql
-- =============================================================================

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS action text,
  ADD COLUMN IF NOT EXISTS decision_reason text,
  ADD COLUMN IF NOT EXISTS review_kind text NOT NULL DEFAULT 'human';

ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_action_chk;
ALTER TABLE public.reports ADD CONSTRAINT reports_action_chk
  CHECK (action IS NULL OR action IN ('dismiss', 'remove_content', 'ban'));
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_decision_reason_chk;
ALTER TABLE public.reports ADD CONSTRAINT reports_decision_reason_chk
  CHECK (decision_reason IS NULL OR decision_reason IN
    ('ofensa', 'assedio', 'dados_pessoais', 'conteudo_sexual', 'falsa_identidade', 'spam', 'outro'));
ALTER TABLE public.reports DROP CONSTRAINT IF EXISTS reports_review_kind_chk;
ALTER TABLE public.reports ADD CONSTRAINT reports_review_kind_chk
  CHECK (review_kind IN ('human', 'automated'));

-- "Minhas denúncias" (denunciante) e "Avisos" (autor) leem por usuário.
CREATE INDEX IF NOT EXISTS reports_reporter_idx
  ON public.reports (reporter_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_offender_user_action_idx
  ON public.reports (offender_user_id, resolved_at DESC)
  WHERE action IN ('remove_content', 'ban');

ALTER TABLE public.banned_players
  ADD COLUMN IF NOT EXISTS report_id uuid
  REFERENCES public.reports(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS banned_report_idx
  ON public.banned_players (report_id) WHERE report_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.moderation_appeals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL UNIQUE REFERENCES public.reports(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,                 -- autor que contesta (conta da sessão, inclusive anônima)
  text text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  decision_note text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT moderation_appeals_text_chk CHECK (char_length(text) BETWEEN 1 AND 1000),
  CONSTRAINT moderation_appeals_status_chk CHECK (status IN ('pending', 'upheld', 'reversed')),
  CONSTRAINT moderation_appeals_note_chk CHECK (decision_note IS NULL OR char_length(decision_note) BETWEEN 1 AND 500)
);
CREATE INDEX IF NOT EXISTS moderation_appeals_status_idx
  ON public.moderation_appeals (status, created_at);
CREATE INDEX IF NOT EXISTS moderation_appeals_user_idx
  ON public.moderation_appeals (user_id);

ALTER TABLE public.moderation_appeals ENABLE ROW LEVEL SECURITY;
-- Sem política: só o service role (servidor) lê e grava.
REVOKE ALL ON public.moderation_appeals FROM PUBLIC, anon, authenticated;
