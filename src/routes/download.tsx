import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/download")({
  head: () => ({
    meta: [
      { title: "Baixe o Verbete — Jogo de palavras multiplayer" },
      {
        name: "description",
        content:
          "Verbete: jogo de palavras multiplayer kawaii. Jogue agora no navegador ou baixe em breve na App Store.",
      },
      { property: "og:title", content: "Baixe o Verbete" },
      {
        property: "og:description",
        content: "Jogo de palavras multiplayer kawaii. Crie salas, desafie amigos.",
      },
      { name: "robots", content: "index,follow" },
    ],
  }),
  component: DownloadPage,
});

const FEATURES = [
  {
    icon: "🎮",
    title: "Salas multiplayer",
    desc: "Crie uma sala em segundos e convide a galera pelo código.",
  },
  {
    icon: "⚡",
    title: "Rodadas rápidas",
    desc: "Partidas dinâmicas, perfeitas para qualquer intervalo.",
  },
  {
    icon: "🏆",
    title: "Ranking diário",
    desc: "Compita no desafio do dia e suba no ranking nacional.",
  },
  {
    icon: "🛡️",
    title: "Comunidade segura",
    desc: "Moderação ativa, reports e bans para manter o jogo saudável.",
  },
];

function DownloadPage() {
  return (
    <div className="mobile-shell">
      <header className="mb-6">
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Voltar
        </Link>
      </header>

      <section className="flex flex-col items-center text-center gap-3 pb-8">
        <div className="text-6xl">📖✨</div>
        <h1 className="font-display text-4xl leading-tight">Verbete</h1>
        <p className="text-base text-muted-foreground max-w-sm">
          Um jogo de palavras multiplayer feito pra rir com os amigos.
        </p>

        <div className="flex flex-col gap-3 w-full max-w-xs mt-4">
          <Link
            to="/"
            className="rounded-full bg-primary text-primary-foreground font-semibold py-3 text-center shadow-md hover:opacity-90 transition"
          >
            Jogar agora no navegador
          </Link>
          {/* TODO: quando as listagens existirem, trocar por links reais
              da Play Store / App Store (guardar as URLs em app-url.ts). */}
          <button
            type="button"
            disabled
            className="rounded-full border border-border bg-card text-muted-foreground font-medium py-3 cursor-not-allowed"
            aria-label="Em breve no Google Play"
          >
            ▶ Em breve no Google Play
          </button>
          <button
            type="button"
            disabled
            className="rounded-full border border-border bg-card text-muted-foreground font-medium py-3 cursor-not-allowed"
            aria-label="Em breve na App Store"
          >
             Em breve na App Store
          </button>
        </div>
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3 pb-10">
        {FEATURES.map((f) => (
          <article
            key={f.title}
            className="rounded-2xl bg-card border border-border p-4 flex flex-col gap-1"
          >
            <div className="text-2xl">{f.icon}</div>
            <h2 className="font-display text-lg">{f.title}</h2>
            <p className="text-sm text-muted-foreground">{f.desc}</p>
          </article>
        ))}
      </section>

      <section className="rounded-2xl bg-card border border-border p-5 flex flex-col gap-2 mb-8">
        <h2 className="font-display text-xl">Quer ser beta tester no iPhone?</h2>
        <p className="text-sm text-muted-foreground">
          Em breve abriremos o TestFlight. Avise se quiser receber o convite.
        </p>
        <a
          href="mailto:contato@verbete.app?subject=Quero%20ser%20beta%20tester%20do%20Verbete"
          className="rounded-full bg-secondary text-secondary-foreground font-semibold py-2.5 text-center mt-2 hover:opacity-90 transition"
        >
          Quero ser beta tester
        </a>
      </section>

      <footer className="text-center text-xs text-muted-foreground pb-8 flex gap-3 justify-center">
        <Link to="/privacy" className="hover:text-foreground">
          Privacidade
        </Link>
        <span>·</span>
        <Link to="/terms" className="hover:text-foreground">
          Termos
        </Link>
      </footer>
    </div>
  );
}


