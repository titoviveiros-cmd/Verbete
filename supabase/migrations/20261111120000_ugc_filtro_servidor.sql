-- =============================================================================
-- ECA Digital (Lei 15.211/2025) — filtro de conteúdo de jogador NO SERVIDOR
-- (11/11/2026). Antes: palavrão e link na definição eram barrados só no
-- cliente (src/lib/text-filter.ts); apelido e nome exibido não tinham filtro
-- nenhum. Uma chamada direta à API (ou cliente antigo) passava por cima.
--
-- Agora a mesma regra do cliente (ugcTextIssue) vale no banco, por GATILHO —
-- cobre todos os caminhos de escrita sem reescrever as RPCs (submit_definition,
-- create_room_with_host, join_public_room, rejoin_room, update direto em
-- profiles):
--   * definitions (texto de jogador humano, is_truth = false): RECUSA com
--     erro "ugc_rejected:<motivo>" — o app mostra a mesma mensagem do cliente;
--   * players.nickname e profiles.display_name: TROCA por 'Jogador' (recusar
--     travaria a entrada na sala com erro genérico; o app atual já recusa
--     antes de enviar, com mensagem).
--   * players.avatar, profiles.avatar e reactions.emoji: só símbolo (emoji);
--     texto vira o avatar padrão / a reação é descartada.
-- Motivos: 'link' | 'blocked_word' | 'contact' (telefone, e-mail, @usuario,
-- rede social). Bots e a definição verdadeira (dicionário) ficam de fora.
-- Listas idênticas às de src/lib/text-filter.ts (UGC_BLOCKED,
-- UGC_CONTACT_WORDS) — conferido por src/lib/__tests__/ugc-filter-parity.test.ts.
-- Nada de histórico é alterado: linhas já gravadas só são conferidas se o
-- texto mudar.
-- ROLLBACK: supabase/rollback/ugc_filtro_servidor.sql
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ugc_text_issue(p_text text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_blocked text[] := ARRAY['porra', 'merda', 'caralho', 'puta', 'fdp', 'viado', 'viad0', 'cuzao', 'buceta', 'bct', 'arrombado', 'filhodaputa', 'foda', 'foder', 'fodido', 'punheta', 'boquete', 'siririca', 'piroca', 'xoxota', 'traveco', 'sapatao', 'vadia', 'babaca', 'otario', 'pqp', 'vsf', 'vtnc', 'tnc', 'krl'];
  v_contact text[] := ARRAY['whatsapp', 'whatsap', 'wpp', 'zapzap', 'telegram', 'instagram', 'discord', 'tiktok', 'snapchat', 'gmail', 'hotmail', 'outlook'];
  v_plain text;
  v_w text;
BEGIN
  -- Igual a normalizeForGame (minúsculas, sem acento) sem os invisíveis.
  v_plain := lower(unaccent(regexp_replace(coalesce(p_text, ''),
    '[​-‏‪-‮⁠-⁤﻿­]', '', 'g')));
  IF v_plain = '' THEN RETURN NULL; END IF;

  IF v_plain ~ 'https?://\S' OR v_plain ~ '\mwww\.' THEN
    RETURN 'link';
  END IF;
  FOREACH v_w IN ARRAY v_blocked LOOP
    IF v_plain ~ ('\m' || v_w) THEN RETURN 'blocked_word'; END IF;
  END LOOP;
  -- Telefone (8+ dígitos, mesmo separados) e @usuario/e-mail.
  IF v_plain ~ '\d(?:[\s().-]*\d){7,}' OR v_plain ~ '@[a-z0-9_]{2}' THEN
    RETURN 'contact';
  END IF;
  FOREACH v_w IN ARRAY v_contact LOOP
    IF v_plain ~ ('\m' || v_w) THEN RETURN 'contact'; END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

-- definitions: recusa texto de jogador humano com problema.
CREATE OR REPLACE FUNCTION public.definitions_ugc_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_issue text;
BEGIN
  IF NEW.is_truth THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.text IS NOT DISTINCT FROM OLD.text THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.players p
     WHERE p.id = NEW.player_id AND p.room_id = NEW.room_id AND p.is_bot
  ) THEN
    RETURN NEW;
  END IF;
  v_issue := public.ugc_text_issue(NEW.text);
  IF v_issue IS NOT NULL THEN
    RAISE EXCEPTION 'ugc_rejected:%', v_issue
      USING ERRCODE = 'P0001', HINT = 'definition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS definitions_ugc_guard ON public.definitions;
CREATE TRIGGER definitions_ugc_guard
  BEFORE INSERT OR UPDATE OF text ON public.definitions
  FOR EACH ROW EXECUTE FUNCTION public.definitions_ugc_guard();

-- Avatar e reação são SÍMBOLOS (emoji de lista fixa no app: src/lib/avatars.ts,
-- ReactionsLayer). O servidor só cortava o tamanho (avatar 16, reação 8
-- caracteres): pela API dava para mandar texto curto ("zap 11987654321" cabe
-- em 16) visto por toda a sala. Letra/dígito ASCII ou "@" = não é símbolo.
CREATE OR REPLACE FUNCTION public.ugc_symbol_issue(p_text text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$ SELECT coalesce(p_text, '') ~ '[A-Za-z0-9@]' $$;

-- players.nickname: troca apelido com problema por 'Jogador'; avatar com
-- texto vira o avatar padrão.
CREATE OR REPLACE FUNCTION public.players_nickname_ugc_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  IF NEW.is_bot THEN RETURN NEW; END IF;
  IF (TG_OP = 'INSERT' OR NEW.nickname IS DISTINCT FROM OLD.nickname)
     AND public.ugc_text_issue(NEW.nickname) IS NOT NULL THEN
    NEW.nickname := 'Jogador';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.avatar IS DISTINCT FROM OLD.avatar)
     AND public.ugc_symbol_issue(NEW.avatar) THEN
    NEW.avatar := '🦊';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS players_nickname_ugc_guard ON public.players;
CREATE TRIGGER players_nickname_ugc_guard
  BEFORE INSERT OR UPDATE OF nickname, avatar ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.players_nickname_ugc_guard();

-- reactions: reação com texto é descartada em silêncio (send_reaction segue
-- respondendo; nada chega à sala).
CREATE OR REPLACE FUNCTION public.reactions_ugc_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  IF public.ugc_symbol_issue(NEW.emoji) THEN RETURN NULL; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reactions_ugc_guard ON public.reactions;
CREATE TRIGGER reactions_ugc_guard
  BEFORE INSERT ON public.reactions
  FOR EACH ROW EXECUTE FUNCTION public.reactions_ugc_guard();

-- profiles.display_name (ranking, perfil): troca por 'Jogador'. Cobre o
-- UPDATE direto do app (política "profiles self update") e o
-- handle_new_user no cadastro.
CREATE OR REPLACE FUNCTION public.profiles_display_name_ugc_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.display_name IS DISTINCT FROM OLD.display_name)
     AND public.ugc_text_issue(NEW.display_name) IS NOT NULL THEN
    NEW.display_name := 'Jogador';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.avatar IS DISTINCT FROM OLD.avatar)
     AND public.ugc_symbol_issue(NEW.avatar) THEN
    NEW.avatar := '🦊';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_display_name_ugc_guard ON public.profiles;
CREATE TRIGGER profiles_display_name_ugc_guard
  BEFORE INSERT OR UPDATE OF display_name, avatar ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_display_name_ugc_guard();

-- Internas: ninguém chama pela API.
REVOKE ALL ON FUNCTION public.ugc_text_issue(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ugc_symbol_issue(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reactions_ugc_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.definitions_ugc_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.players_nickname_ugc_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.profiles_display_name_ugc_guard() FROM PUBLIC, anon, authenticated;

-- Diagnóstico (NÃO executado aqui; só leitura, para o dono decidir uma
-- limpeza à parte):
--   SELECT user_id, display_name FROM public.profiles
--    WHERE public.ugc_text_issue(display_name) IS NOT NULL;
