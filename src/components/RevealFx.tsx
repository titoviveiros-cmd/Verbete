// Efeitos teatrais de revelação: screen-shake + flash branco.
// Uso: <RevealFx trigger={someBoolean} strong /> — ao virar true, dispara uma vez.
import { useEffect, useRef, useState } from "react";

export function RevealFx({ trigger, strong = false }: { trigger: boolean; strong?: boolean }) {
  const [on, setOn] = useState(false);
  const fired = useRef(false);
  useEffect(() => {
    if (!trigger || fired.current) return;
    fired.current = true;
    setOn(true);
    // Aplica shake no body por ~600ms
    const shakeClass = strong ? "shake-strong" : "shake";
    document.body.classList.add(shakeClass);
    const t1 = setTimeout(() => document.body.classList.remove(shakeClass), strong ? 720 : 540);
    const t2 = setTimeout(() => setOn(false), 700);
    return () => { clearTimeout(t1); clearTimeout(t2); document.body.classList.remove(shakeClass); };
  }, [trigger, strong]);
  return <div className={"flash-overlay" + (on ? " on" : "")} aria-hidden />;
}


