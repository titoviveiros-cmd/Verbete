import { AVATARS } from "@/lib/avatars";

/**
 * Grade de avatares — só os animais. A cor do jogador continua existindo, mas
 * é interna (sorteada/guardada); não há mais seletor de cor na interface.
 * Colunas que encolhem (minmax(0, 1fr)) e emoji proporcional à tela: nada
 * passa da borda do card, nem em telas Android estreitas (320 px).
 * Usada na Nova sala / Entrar (Home), no JoinFlow da sala e no Perfil.
 */
export function AvatarGrid({
  value,
  onChange,
  className = "",
}: {
  value: string | undefined;
  onChange: (avatar: string) => void;
  className?: string;
}) {
  return (
    <div className={`grid grid-cols-8 gap-1 ${className}`}>
      {AVATARS.map((a) => (
        <button
          key={a}
          type="button"
          onClick={() => onChange(a)}
          aria-label={`Escolher avatar ${a}`}
          aria-pressed={value === a}
          className={
            "min-w-0 aspect-square flex items-center justify-center rounded-xl leading-none text-[clamp(1rem,5.4vw,1.5rem)] transition " +
            (value === a ? "bg-pink/25 ring-2 ring-pink" : "hover:bg-white/5")
          }
        >
          {a}
        </button>
      ))}
    </div>
  );
}
