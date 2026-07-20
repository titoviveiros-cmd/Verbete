-- Fix: guard_author_identity quebrava com `record "new" has no field "voter_id"`.
-- Em PL/pgSQL, campos de NEW referenciados numa expressão CASE são resolvidos
-- na preparação da expressão inteira — mesmo no ramo não executado. Em tabelas
-- sem voter_id (definitions/room_messages/reactions) o trigger explodia em
-- QUALQUER insert. Descoberto pela suíte scripts/test-identity.mjs.
-- Solução: extrair o autor via to_jsonb(NEW), que não exige o campo no tipo.
CREATE OR REPLACE FUNCTION public.guard_author_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_pid text;
  v_user_id uuid;
  v_is_bot boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;  -- cron/service/sem sessão
  v_pid := COALESCE(to_jsonb(NEW)->>'voter_id', to_jsonb(NEW)->>'player_id');
  IF v_pid IS NULL OR v_pid = '__truth__' THEN RETURN NEW; END IF;
  SELECT user_id, is_bot INTO v_user_id, v_is_bot FROM public.players WHERE id = v_pid;
  -- bot (orquestrado pelo host) ou linha inexistente (FK decide): libera
  IF v_is_bot IS DISTINCT FROM false THEN RETURN NEW; END IF;
  IF v_user_id IS NULL OR v_user_id = v_uid THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'votes' THEN
    RETURN NULL;  -- descarta a linha forjada sem abortar o lote (cast_votes_bulk)
  END IF;
  RAISE EXCEPTION 'identity_mismatch: % em %', v_pid, TG_TABLE_NAME;
END;
$$;
