-- ============================================================
-- Moderação de conteúdo gerado por usuários (Apple Guideline 1.2)
-- ============================================================

-- 1) Enum de roles (mantemos só admin/moderator/user por enquanto)
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'moderator', 'user');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 2) Tabela user_roles + has_role() — padrão Lovable para evitar recursão em RLS
CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
$$;

-- Cada usuário enxerga apenas suas próprias roles; admins enxergam tudo
DROP POLICY IF EXISTS "user_roles self read" ON public.user_roles;
CREATE POLICY "user_roles self read" ON public.user_roles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "user_roles admin write" ON public.user_roles;
CREATE POLICY "user_roles admin write" ON public.user_roles
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 3) Reports de definições inadequadas
CREATE TABLE IF NOT EXISTS public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id uuid,                            -- pode ficar nulo se definição for limpa
  definition_text text NOT NULL,                 -- snapshot p/ revisão posterior
  room_id uuid,
  room_code text,
  round integer,
  offender_player_id text NOT NULL,              -- id do jogador (device-level)
  offender_user_id uuid,                         -- auth.uid() se logado
  offender_nickname text,
  reporter_user_id uuid NOT NULL,                -- sempre logado
  reason text NOT NULL DEFAULT 'inappropriate',
  status text NOT NULL DEFAULT 'pending',        -- pending | resolved | dismissed
  resolution_note text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reports_status_chk CHECK (status IN ('pending','resolved','dismissed')),
  CONSTRAINT reports_reason_chk CHECK (char_length(reason) BETWEEN 1 AND 64),
  CONSTRAINT reports_text_chk   CHECK (char_length(definition_text) BETWEEN 1 AND 500)
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON public.reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_offender_idx ON public.reports (offender_player_id);

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

-- Qualquer usuário autenticado pode reportar uma definição
DROP POLICY IF EXISTS "reports authenticated insert" ON public.reports;
CREATE POLICY "reports authenticated insert" ON public.reports
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = reporter_user_id);

-- Reporter vê os próprios reports; admins veem tudo
DROP POLICY IF EXISTS "reports owner or admin select" ON public.reports;
CREATE POLICY "reports owner or admin select" ON public.reports
  FOR SELECT TO authenticated
  USING (auth.uid() = reporter_user_id OR public.has_role(auth.uid(), 'admin'));

-- Só admin atualiza/resolve
DROP POLICY IF EXISTS "reports admin update" ON public.reports;
CREATE POLICY "reports admin update" ON public.reports
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 4) Banidos
CREATE TABLE IF NOT EXISTS public.banned_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id text,                                -- pode banir por device id
  user_id uuid,                                  -- e/ou por auth uid
  reason text NOT NULL DEFAULT 'violation',
  banned_by uuid NOT NULL,
  banned_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,                        -- NULL = perma
  CONSTRAINT banned_target_chk CHECK (player_id IS NOT NULL OR user_id IS NOT NULL),
  CONSTRAINT banned_reason_chk CHECK (char_length(reason) BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS banned_player_idx ON public.banned_players (player_id) WHERE player_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS banned_user_idx   ON public.banned_players (user_id)   WHERE user_id   IS NOT NULL;

ALTER TABLE public.banned_players ENABLE ROW LEVEL SECURITY;

-- Só admin pode ler/escrever a tabela diretamente
DROP POLICY IF EXISTS "banned admin all" ON public.banned_players;
CREATE POLICY "banned admin all" ON public.banned_players
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- 5) Função pública (security definer) para o cliente checar ban no join
CREATE OR REPLACE FUNCTION public.is_player_banned(_player_id text, _user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.banned_players
    WHERE (expires_at IS NULL OR expires_at > now())
      AND (
        (_player_id IS NOT NULL AND player_id = _player_id)
        OR (_user_id IS NOT NULL AND user_id = _user_id)
      )
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_player_banned(text, uuid) TO anon, authenticated;

