import { useEffect, useState } from "react";
import { AGE_DECLARED_EVENT, declaredAgeBand, type AgeBand } from "@/lib/age";

/**
 * Faixa etária DECLARADA neste aparelho (autodeclaração — não comprova
 * idade). "unknown" no SSR e antes de declarar; atualiza quando a pessoa
 * responde ao AgeGate com a tela aberta.
 */
export function useDeclaredAgeBand(): AgeBand {
  const [band, setBand] = useState<AgeBand>("unknown");
  useEffect(() => {
    const read = () => setBand(declaredAgeBand());
    read();
    window.addEventListener(AGE_DECLARED_EVENT, read);
    return () => window.removeEventListener(AGE_DECLARED_EVENT, read);
  }, []);
  return band;
}
