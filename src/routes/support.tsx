import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/support")({
  head: () => ({
    meta: [
      { title: "Suporte — Verbete" },
      {
        name: "description",
        content:
          "Central de ajuda do Verbete: perguntas frequentes, contato e como reportar problemas.",
      },
      { property: "og:title", content: "Suporte — Verbete" },
      {
        property: "og:description",
        content: "FAQ e canal de contato para tirar dúvidas sobre o Verbete.",
      },
      { name: "robots", content: "index,follow" },
    ],
  }),
  component: SupportPage,
});

const FAQ: { q: string; a: string }[] = [
  {
    q: "Como crio uma sala?",
    a: "Na tela inicial toque em \"Criar sala\". Você recebe um código de 4 dígitos para compartilhar com os amigos.",
  },
  {
    q: "Preciso criar conta para jogar?",
    a: "Não. O modo convidado funciona sem cadastro. Mas com login (Apple ou Google) seu histórico, conquistas e estatísticas ficam salvos entre dispositivos.",
  },
  {
    q: "Quantos jogadores cabem numa sala?",
    a: "Até 8 jogadores por sala. Há também o modo vs. Bots para jogar sozinho.",
  },
  {
    q: "Como funciona a pontuação?",
    a: "Você ganha pontos acertando a definição verdadeira e ainda mais pontos quando outro jogador vota na sua definição inventada.",
  },
  {
    q: "Encontrei uma definição ofensiva. O que faço?",
    a: "Toque no 🚩 ao lado da definição na fase de votação. Nossa equipe revisa todos os reports e bane jogadores que violam as regras.",
  },
  {
    q: "Como excluo minha conta?",
    a: "Acesse seu Perfil → Zona de perigo → \"Excluir conta\". A ação é permanente: removemos seu perfil e anonimizamos seu histórico de partidas.",
  },
  {
    q: "Posso jogar offline?",
    a: "Não. O Verbete é multiplayer em tempo real e precisa de conexão com a internet.",
  },
  {
    q: "O jogo é gratuito?",
    a: "Sim, totalmente gratuito. Sem anúncios invasivos e sem mecânicas pay-to-win.",
  },
  {
    q: "Qual a classificação etária?",
    a: "12+. As definições são escritas pelos próprios jogadores e podem conter humor adulto — temos filtros e moderação ativa.",
  },
];

function SupportPage() {
  return (
    <div className="mobile-shell">
      <header className="mb-6">
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Voltar
        </Link>
        <h1 className="font-display text-3xl mt-2">Suporte</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Dúvidas, problemas ou sugestões? Estamos aqui.
        </p>
      </header>

      <section className="sticker p-4 mb-6">
        <h2 className="font-display text-lg mb-2">📧 Fale com a gente</h2>
        <p className="text-sm mb-3">
          Resposta em até 48h úteis.
        </p>
        <a
          href="mailto:contato@verbete.app?subject=Suporte%20Verbete"
          className="btn-pop bg-gradient-fun text-white inline-block"
        >
          contato@verbete.app
        </a>
      </section>

      <section className="mb-6">
        <h2 className="font-display text-xl mb-3">Perguntas frequentes</h2>
        <div className="space-y-2">
          {FAQ.map(({ q, a }, i) => (
            <details
              key={i}
              className="sticker p-3 group"
            >
              <summary className="font-display cursor-pointer list-none flex items-center justify-between gap-2">
                <span className="flex-1">{q}</span>
                <span className="text-muted-foreground group-open:rotate-90 transition">›</span>
              </summary>
              <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="sticker p-4">
        <h2 className="font-display text-lg mb-2">🐛 Reportar um bug</h2>
        <p className="text-sm text-muted-foreground">
          Inclua na mensagem: modelo do aparelho, versão do iOS, código da sala
          (se aplicável) e o que você estava fazendo quando o problema aconteceu.
          Prints ajudam muito.
        </p>
      </section>

      <footer className="mt-8 text-center text-xs text-muted-foreground">
        <Link to="/privacy" className="underline mr-3">Privacidade</Link>
        <Link to="/terms" className="underline">Termos</Link>
      </footer>
    </div>
  );
}


