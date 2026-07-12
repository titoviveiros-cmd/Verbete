ALTER TABLE public.rooms ALTER COLUMN win_target SET DEFAULT 2;
UPDATE public.rooms SET win_target = 2 WHERE win_condition = 'rounds' AND win_target > 5 AND status IN ('lobby','shuffling');

