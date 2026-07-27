-- Memória por rodada do que a IA já serviu (playtest 2026-07-21, sala 4369):
-- uma SUGESTÃO mostrada ao jogador reapareceu como cédula de BOT — quem viu a
-- sugestão soube na hora que a alternativa era falsa. A edge bot-definitions
-- registra aqui cada texto servido (para qualquer fim/jogador) e exclui os
-- já servidos nas próximas gerações da mesma rodada.
CREATE TABLE IF NOT EXISTS public.ai_served_defs (
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  round int NOT NULL,
  norm_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, round, norm_text)
);

-- Somente o service role (edge functions) toca nesta tabela.
REVOKE ALL ON public.ai_served_defs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.ai_served_defs TO service_role;
