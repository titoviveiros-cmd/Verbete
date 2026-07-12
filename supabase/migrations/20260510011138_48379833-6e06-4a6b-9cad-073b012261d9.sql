ALTER TABLE public.rooms
ADD COLUMN IF NOT EXISTS used_word_ids uuid[] NOT NULL DEFAULT '{}';

