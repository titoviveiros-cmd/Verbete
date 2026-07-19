-- Sala nova nascia com win_condition='score' e win_target=10 — abaixo do
-- mínimo jogável do modo pontuação (15, menor alvo oferecido na UI).
-- Default vira 15 e salas ainda no lobby com o valor incoerente são
-- corrigidas. Modo 'rounds' segue usando 5/10/15/20 normalmente via UI.
-- ROLLBACK: ALTER TABLE public.rooms ALTER COLUMN win_target SET DEFAULT 10;
ALTER TABLE public.rooms ALTER COLUMN win_target SET DEFAULT 15;
UPDATE public.rooms SET win_target = 15
WHERE status = 'lobby' AND win_condition = 'score' AND win_target < 15;
