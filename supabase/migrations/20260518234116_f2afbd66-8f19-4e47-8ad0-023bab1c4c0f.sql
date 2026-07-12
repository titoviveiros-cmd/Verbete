create table public.room_words (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null,
  word text not null,
  meaning text not null,
  category text not null default 'custom',
  created_by text,
  created_at timestamptz not null default now()
);

create index room_words_room_id_idx on public.room_words(room_id);

alter table public.room_words enable row level security;

create policy "room_words public read"
  on public.room_words for select using (true);

create policy "room_words public insert"
  on public.room_words for insert with check (true);

create policy "room_words public delete"
  on public.room_words for delete using (true);

