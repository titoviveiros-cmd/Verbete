
-- Banco de palavras raras
CREATE TABLE public.words (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  word TEXT NOT NULL UNIQUE,
  meaning TEXT NOT NULL,
  category TEXT,
  rarity INT NOT NULL DEFAULT 2,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Salas
CREATE TABLE public.rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  host_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby', -- lobby | choosing | writing | shuffling | voting | reveal | scoreboard | finished
  win_condition TEXT NOT NULL DEFAULT 'rounds', -- rounds | score
  win_target INT NOT NULL DEFAULT 20,
  current_round INT NOT NULL DEFAULT 0,
  current_coordinator TEXT,
  current_word_id UUID REFERENCES public.words(id),
  round_phase_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Jogadores
CREATE TABLE public.players (
  id TEXT PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  nickname TEXT NOT NULL,
  avatar TEXT NOT NULL DEFAULT '🦊',
  color TEXT NOT NULL DEFAULT '#FFD166',
  score INT NOT NULL DEFAULT 0,
  is_bot BOOLEAN NOT NULL DEFAULT false,
  is_connected BOOLEAN NOT NULL DEFAULT true,
  coordinator_count INT NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Definições por rodada
CREATE TABLE public.definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  round INT NOT NULL,
  player_id TEXT NOT NULL,
  text TEXT NOT NULL,
  is_truth BOOLEAN NOT NULL DEFAULT false,
  letter TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(room_id, round, player_id)
);

-- Votos
CREATE TABLE public.votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  round INT NOT NULL,
  voter_id TEXT NOT NULL,
  definition_id UUID NOT NULL REFERENCES public.definitions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(room_id, round, voter_id)
);

-- Reactions/emojis flutuantes (efêmero)
CREATE TABLE public.reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  player_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS aberto (jogo sem login, acesso por código de sala no client)
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.words ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read rooms" ON public.rooms FOR SELECT USING (true);
CREATE POLICY "public write rooms" ON public.rooms FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "public read players" ON public.players FOR SELECT USING (true);
CREATE POLICY "public write players" ON public.players FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "public read definitions" ON public.definitions FOR SELECT USING (true);
CREATE POLICY "public write definitions" ON public.definitions FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "public read votes" ON public.votes FOR SELECT USING (true);
CREATE POLICY "public write votes" ON public.votes FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "public read reactions" ON public.reactions FOR SELECT USING (true);
CREATE POLICY "public write reactions" ON public.reactions FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "public read words" ON public.words FOR SELECT USING (true);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;
ALTER PUBLICATION supabase_realtime ADD TABLE public.players;
ALTER PUBLICATION supabase_realtime ADD TABLE public.definitions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.votes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.reactions;

ALTER TABLE public.rooms REPLICA IDENTITY FULL;
ALTER TABLE public.players REPLICA IDENTITY FULL;
ALTER TABLE public.definitions REPLICA IDENTITY FULL;
ALTER TABLE public.votes REPLICA IDENTITY FULL;


