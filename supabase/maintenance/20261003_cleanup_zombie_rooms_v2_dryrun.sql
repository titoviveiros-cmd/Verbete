-- DRY-RUN (somente leitura) do cleanup_zombie_rooms v2: lista as salas que a
-- nova regra encerraria AGORA, sem alterar nada. Rodar antes de autorizar a
-- manutenção e anexar o resultado ao pedido de autorização.

SELECT r.code, r.status, r.created_at, r.phase_started_at, r.round_phase_ends_at,
       (SELECT count(*) FROM public.players p
         WHERE p.room_id = r.id AND p.is_bot = false AND p.kicked_at IS NULL) AS humanos,
       'fase parada 30+ min' AS motivo
FROM public.rooms r
WHERE r.status IN ('shuffling', 'choosing', 'writing', 'voting', 'reveal', 'scoreboard')
  AND COALESCE(r.phase_started_at, r.created_at) < now() - interval '30 minutes'
UNION ALL
SELECT r.code, r.status, r.created_at, r.phase_started_at, r.round_phase_ends_at,
       (SELECT count(*) FROM public.players p
         WHERE p.room_id = r.id AND p.is_bot = false AND p.kicked_at IS NULL),
       'lobby sem atividade 60+ min'
FROM public.rooms r
WHERE r.status = 'lobby'
  AND GREATEST(
        r.created_at,
        COALESCE((SELECT max(p.joined_at) FROM public.players p WHERE p.room_id = r.id), r.created_at),
        COALESCE((SELECT max(m.created_at) FROM public.room_messages m WHERE m.room_id = r.id), r.created_at)
      ) < now() - interval '60 minutes'
ORDER BY 3;
