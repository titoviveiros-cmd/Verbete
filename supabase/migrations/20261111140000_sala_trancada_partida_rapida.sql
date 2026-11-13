-- =============================================================================
-- ECA Digital (Lei 15.211/2025, art. 21 p.ú.; Lei 14.852/2024 art. 16 VII):
-- interação limitada POR PADRÃO (11/11/2026, proposta B4).
--
-- (a) OBRIGAÇÃO EXPRESSA: jogo com interação deve, por padrão, "limitar as
--     funcionalidades de interação a usuários" (art. 21 p.ú.) e oferecer
--     proteção contra contato indesejado, inclusive desativar a interação
--     (L14852 art. 16 VII).
-- (b) INTERPRETAÇÃO (confiança moderada): sala que só se acha com o código ou
--     o link de convite, que o dono pode TRANCAR, e partida rápida fechada,
--     cumprem o "limitar por padrão"; se isso basta SEM consentimento dos pais
--     é dúvida do parecer (Q2) — este arquivo NÃO implementa consentimento.
-- (c) PRODUTO: o dono tranca/destranca a sala; "jogar só com bots" = trancar
--     + bots; partida rápida (sala pública) fechada para quem usa o app até
--     decisão expressa (reabrir = ligar verbete.public_rooms_open no banco).
--
-- Feito por GATILHO e coluna nova — sem reescrever create_room_with_host,
-- rejoin_room nem join_public_room (o PR #60 e fix/limite-salas-por-jogador
-- mexem nessas funções):
--   * rooms.locked (padrão false): sala trancada não aceita jogador NOVO nem a
--     volta de expulso; quem já está (reconexão, UPDATE) continua; bots entram.
--   * set_room_locked: só o dono (host + identidade da sessão); só
--     authenticated (sessões anônimas do app incluídas), nunca anon.
--   * sala pública: jogador humano chamado pelo app (auth.uid() presente) não
--     entra nem cria — fecha join_public_room sem mexer na função nem nos
--     grants (os testes de identidade dela continuam válidos).
-- ROLLBACK: supabase/rollback/sala_trancada_partida_rapida.sql
-- =============================================================================

ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;

-- Decisão de produto num só lugar: partida rápida FECHADA, a menos que o
-- parâmetro verbete.public_rooms_open = 'on' (só o dono do banco liga, com
-- ALTER DATABASE … SET, ou um teste com SET LOCAL; o cliente da API não
-- consegue definir parâmetros "verbete.*"). Reabrir exige parecer + gate de
-- idade no app (src/lib/room-access.ts → publicMatchAllowed).
CREATE OR REPLACE FUNCTION public.public_rooms_open()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$ SELECT coalesce(current_setting('verbete.public_rooms_open', true), '') = 'on' $$;

CREATE OR REPLACE FUNCTION public.players_room_access_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_locked boolean;
  v_visibility text;
BEGIN
  IF NEW.is_bot THEN RETURN NEW; END IF;
  SELECT r.locked, r.visibility INTO v_locked, v_visibility
    FROM public.rooms r WHERE r.id = NEW.room_id;
  IF TG_OP = 'INSERT' THEN
    IF v_locked THEN
      RAISE EXCEPTION 'room_locked' USING ERRCODE = 'P0001';
    END IF;
    IF v_visibility = 'public' AND auth.uid() IS NOT NULL
       AND NOT public.public_rooms_open() THEN
      RAISE EXCEPTION 'public_rooms_closed' USING ERRCODE = 'P0001';
    END IF;
  ELSIF OLD.kicked_at IS NOT NULL AND NEW.kicked_at IS NULL AND v_locked THEN
    -- Expulso não volta para sala trancada.
    RAISE EXCEPTION 'room_locked' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS players_room_access_guard ON public.players;
CREATE TRIGGER players_room_access_guard
  BEFORE INSERT OR UPDATE OF kicked_at ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.players_room_access_guard();

CREATE OR REPLACE FUNCTION public.set_room_locked(p_room_id uuid, p_actor_id text, p_locked boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_room public.rooms;
  v_reason text;
BEGIN
  IF public.is_sessionless_api_call() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'session_required');
  END IF;
  IF p_room_id IS NULL OR p_actor_id IS NULL OR p_locked IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_input');
  END IF;
  SELECT * INTO v_room FROM public.rooms WHERE id = p_room_id;
  IF v_room IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'room_not_found');
  END IF;
  IF v_room.host_id <> p_actor_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_host');
  END IF;
  v_reason := public.assert_actor_identity(p_room_id, p_actor_id);
  IF v_reason IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', v_reason);
  END IF;
  UPDATE public.rooms SET locked = p_locked WHERE id = p_room_id;
  RETURN jsonb_build_object('ok', true, 'locked', p_locked);
END;
$function$;

REVOKE ALL ON FUNCTION public.public_rooms_open() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.players_room_access_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_room_locked(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_room_locked(uuid, text, boolean) TO authenticated;
