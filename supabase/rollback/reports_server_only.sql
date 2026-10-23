-- Desfaz 20261023190000_reports_server_only: devolve as políticas e os grants
-- originais de reports (migration 20260518221956 + espelho 20260722120000).
-- Só em emergência e SÓ com o Worker anterior a report-definition.ts JÁ no
-- ar (com ele, ler reports revela a definição verdadeira durante a votação).
-- As denúncias contra a verdadeira (já descartadas) são ruído e entregariam a
-- resposta de uma votação em andamento: saem antes de reabrir a leitura.
DELETE FROM public.reports WHERE offender_player_id = '__truth__';
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
  ON public.reports TO anon, authenticated;
CREATE POLICY "reports authenticated insert" ON public.reports
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = reporter_user_id);
CREATE POLICY "reports owner or admin select" ON public.reports
  FOR SELECT TO authenticated
  USING (auth.uid() = reporter_user_id OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "reports admin update" ON public.reports
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
