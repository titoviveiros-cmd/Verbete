-- Diagnóstico SÓ DE LEITURA (Rodada 2B, 2026-10-27): contas existentes cujo
-- nome exibido é o trecho do e-mail antes do @ (regra antiga do
-- handle_new_user / do cadastro). NÃO altera nada. Não foi rodado em
-- produção nesta rodada — rodar só com autorização do proprietário:
--   npx supabase db query --linked -f scripts/diagnose-display-name.sql
--
-- Classes (dá para separar a origem pelo que o cadastro gravou):
--   A_google_sem_nome   provedor ≠ email e metadata SEM display_name → o
--                       trecho veio do fallback do banco (certeza)
--   B_email_sem_nome    provedor email e metadata SEM display_name → idem
--   C_cliente_mandou    metadata.display_name = trecho → o formulário mandou
--                       (campo vazio no cliente antigo OU a pessoa digitou
--                       exatamente o trecho — INDISTINGUÍVEL)
-- "editado" = profiles.updated_at > created_at + 1 min (passou pelo Perfil).
WITH base AS (
  SELECT
    u.id,
    COALESCE(u.raw_app_meta_data ->> 'provider', 'email') AS provider,
    u.raw_user_meta_data ? 'display_name' AS meta_has_name,
    lower(btrim(u.raw_user_meta_data ->> 'display_name')) AS meta_name,
    lower(btrim(p.display_name)) AS shown,
    lower(split_part(u.email, '@', 1)) AS prefix,
    p.updated_at > p.created_at + interval '1 minute' AS edited
  FROM auth.users u
  JOIN public.profiles p ON p.user_id = u.id
  WHERE u.is_anonymous IS NOT TRUE AND COALESCE(u.email, '') <> ''
)
SELECT
  CASE
    WHEN NOT meta_has_name AND provider <> 'email' THEN 'A_google_sem_nome'
    WHEN NOT meta_has_name THEN 'B_email_sem_nome'
    WHEN meta_name = prefix THEN 'C_cliente_mandou'
    ELSE 'D_outro'
  END AS classe,
  provider,
  edited,
  count(*) AS contas
FROM base
WHERE shown = prefix
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

-- Total de contas reais, para dimensionar:
SELECT count(*) AS contas_reais
FROM auth.users
WHERE is_anonymous IS NOT TRUE AND COALESCE(email, '') <> '';

-- PROPOSTA (NÃO EXECUTAR sem decisão do proprietário): renomear para
-- 'Jogador' só as classes A e B NÃO editadas — as únicas em que o nome é,
-- com certeza, o fallback. A classe C fica como está (pode ter sido escolha
-- da pessoa); a alternativa para ela é avisar no Perfil, não renomear.
-- UPDATE public.profiles p SET display_name = 'Jogador', updated_at = now()
--   FROM auth.users u
--  WHERE p.user_id = u.id
--    AND u.is_anonymous IS NOT TRUE
--    AND NOT (u.raw_user_meta_data ? 'display_name')
--    AND lower(btrim(p.display_name)) = lower(split_part(u.email, '@', 1))
--    AND p.updated_at <= p.created_at + interval '1 minute';
