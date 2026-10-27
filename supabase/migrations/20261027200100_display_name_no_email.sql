-- =============================================================================
-- Nome exibido sem a parte do e-mail (Rodada 2B, 2026-10-27).
--
-- Antes: handle_new_user usava COALESCE(display_name, split_part(email,'@',1),
-- 'Jogador') — cadastro sem nome e TODO login com Google (o Google manda
-- name/full_name, não display_name) recebiam como nome público (ranking,
-- profiles legível por qualquer sessão) o trecho do e-mail antes do @. E o
-- cliente em produção (login.tsx) ainda manda display_name = esse trecho
-- quando o campo fica vazio.
--
-- Agora: só o nome que a pessoa digitou; vazio, igual ao e-mail, igual ao
-- trecho antes do @ (sem diferenciar maiúsculas) ou com "@" → 'Jogador'. O
-- nome do Google NÃO é usado: é o nome civil completo, e virar nome público
-- sem a pessoa escolher expõe mais do que o necessário (troca no Perfil).
-- Contas existentes: nada muda aqui (diagnóstico só local em
-- scripts/diagnose-display-name.sql).
-- ROLLBACK: supabase/rollback/display_name_no_email.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text := lower(btrim(COALESCE(NEW.email, '')));
  v_name text := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'display_name', '')), '');
BEGIN
  IF v_name IS NOT NULL AND (
       position('@' IN v_name) > 0
       OR (v_email <> '' AND lower(v_name) IN (v_email, split_part(v_email, '@', 1)))
     ) THEN
    v_name := NULL;
  END IF;

  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(left(v_name, 24), 'Jogador'))
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.user_stats (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
