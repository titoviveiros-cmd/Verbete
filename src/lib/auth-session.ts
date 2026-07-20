import { supabase } from "@/integrations/supabase/client";

// S4: garante uma sessão (anonymous sign-in) antes das ações de sala, para
// que o servidor amarre players.user_id = auth.uid() no join/create.
// Se o anonymous sign-in estiver desativado no projeto (ou sem rede), falha
// em silêncio — as guardas do servidor liberam quando auth.uid() é NULL
// (fallback documentado em docs/security-audit.md).
let inflight: Promise<void> | null = null;

export function ensureAnonSession(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      if (data.session) return;
      await supabase.auth.signInAnonymously();
    } catch {
      // segue como convidado sem sessão
    } finally {
      inflight = null; // permite nova tentativa na próxima ação
    }
  })();
  return inflight;
}
