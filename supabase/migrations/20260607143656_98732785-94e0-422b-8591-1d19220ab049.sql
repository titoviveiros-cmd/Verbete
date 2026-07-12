ALTER TABLE public.rooms ALTER COLUMN win_condition SET DEFAULT 'score';
ALTER TABLE public.rooms ALTER COLUMN win_target SET DEFAULT 15;
UPDATE public.rooms SET win_condition = 'score', win_target = 15
  WHERE status = 'lobby' AND win_condition = 'rounds' AND win_target = 2;

