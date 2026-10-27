-- ROLLBACK de 20261027200100_display_name_no_email.sql: handle_new_user volta
-- ao corpo de 20260510124439 (usa o trecho do e-mail antes do @ como nome).
--   npx supabase db query --linked -f supabase/rollback/display_name_no_email.sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, display_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1), 'Jogador'))
  ON CONFLICT (user_id) DO NOTHING;

  INSERT INTO public.user_stats (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
