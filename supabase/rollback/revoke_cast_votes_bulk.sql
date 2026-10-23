-- Desfaz 20261023120000_revoke_cast_votes_bulk: devolve cast_votes_bulk a
-- anon/authenticated (o host volta a poder escolher os votos dos bots).
-- Só em emergência — ex.: um cliente antigo que precise do caminho legado.
GRANT EXECUTE ON FUNCTION public.cast_votes_bulk(uuid, integer, jsonb)
  TO anon, authenticated;
