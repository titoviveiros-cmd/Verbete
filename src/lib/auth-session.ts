import { supabase } from "@/integrations/supabase/client";

// S4: garante uma sessão (anonymous sign-in) antes das ações de sala, para
// que o servidor amarre players.user_id = auth.uid() no join/create. Desde o
// M1 o servidor RECUSA ações de jogador vindas da API sem sessão
// (session_required) — então tentamos de novo antes de desistir.
let inflight: Promise<boolean> | null = null;

export const SESSION_REQUIRED_MESSAGE =
  "Não conseguimos iniciar sua sessão de jogo. Confira a conexão e tente de novo.";

export function ensureAnonSession(): Promise<boolean> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * attempt));
        try {
          const { data } = await supabase.auth.getSession();
          if (data.session) return true;
          const { data: signed, error } =
            await supabase.auth.signInAnonymously();
          if (!error && signed.session) return true;
        } catch {
          /* rede instável: tenta de novo */
        }
      }
      return false;
    } finally {
      inflight = null; // permite nova tentativa na próxima ação
    }
  })();
  return inflight;
}
