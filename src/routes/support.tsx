import { createFileRoute, Link } from "@tanstack/react-router";
import { CONTACT_EMAIL, contactMailto } from "@/lib/legal";

export const Route = createFileRoute("/support")({
  head: () => ({
    meta: [
      { title: "Suporte — Verbete" },
      {
        name: "description",
        content:
          "Central de ajuda do Verbete: perguntas frequentes, contato, exclusão de conta e como reportar problemas.",
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

// Fatos conferidos no código (27/10/2026): 4 a 12 jogadores contando bots
// (start_game_min_4_players; Lobby "n/12"), login só por e-mail ou Google
// (/login), um palpite por hora no Desafio, sem anúncios nem compras.
const FAQ: { q: string; a: string }[] = [
  {
    q: "Como crio uma sala?",
    a: 'Na tela inicial toque em "Criar sala". Você recebe um código de 4 dígitos para compartilhar com os amigos.',
  },
  {
    q: "Preciso criar conta para jogar?",
    a: "Não. Dá para jogar como convidado, sem cadastro. Com uma conta (e-mail ou Google), seu histórico, conquistas e estatísticas ficam salvos e você pode entrar em outros aparelhos.",
  },
  {
    q: "Quantos jogadores cabem numa sala?",
    a: "De 4 a 12 por sala, contando os bots: o dono da sala pode completar a mesa com bots — e até jogar só com eles.",
  },
  {
    q: "Como funciona a pontuação?",
    a: "Você ganha pontos votando na definição verdadeira e a cada jogador que cai na definição que você inventou. Uma inventada que chega muito perto da verdadeira ganha o bônus 🧠.",
  },
  {
    q: "O que é o Desafio Diário?",
    a: "Uma palavra rara para você adivinhar o significado. Vale um palpite por hora; a inteligência artificial avalia o quanto o palpite chegou perto.",
  },
  {
    q: "Encontrei uma definição ofensiva. O que faço?",
    a: "Toque na bandeira 🚩 no canto da cédula, na votação. A moderação revisa as denúncias e pode banir quem viola os Termos de Uso.",
  },
  {
    q: "Como denuncio um apelido ou um jogador?",
    a: 'Na sala de espera ou no fim da partida, toque em "Denunciar jogador", escolha quem e o motivo. O dono da sala também pode remover jogadores.',
  },
  {
    q: "Como excluo minha conta?",
    a: 'No Perfil → Zona de perigo → "Excluir". A ação é permanente: apagamos a conta, o perfil, as estatísticas, as conquistas, o histórico de partidas e os palpites do Desafio. Nas salas em que você jogou ficam o apelido, as definições da partida e identificadores técnicos. Sem o app, veja a página Excluir conta (link abaixo).',
  },
  {
    q: "Posso jogar offline?",
    a: "Não. O Verbete é multiplayer em tempo real e precisa de conexão com a internet.",
  },
  {
    q: "O jogo é gratuito?",
    a: "Sim, totalmente gratuito, sem anúncios e sem compras no app.",
  },
  {
    q: "Qual a idade indicada?",
    a: "O Verbete é indicado para maiores de 13 anos. As definições são escritas pelos próprios jogadores; há filtros automáticos, denúncia e moderação.",
  },
];

function SupportPage() {
  return (
    <div className="mobile-shell">
      <header className="mb-6">
        <Link
          to="/"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
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
          Escreva para o e-mail abaixo; a resposta chega por ele.
        </p>
        <a
          href={contactMailto("Suporte Verbete")}
          className="btn-pop btn-gold inline-block max-w-full break-all"
        >
          {CONTACT_EMAIL}
        </a>
      </section>

      <section className="sticker p-4 mb-6">
        <h2 className="font-display text-lg mb-2">🗑️ Excluir conta</h2>
        <p className="text-sm text-muted-foreground">
          Pelo Perfil do app ou do site, ou por e-mail, sem precisar do app. O
          que é apagado e o que fica:{" "}
          <Link to="/delete-account" className="underline text-foreground">
            Excluir conta
          </Link>
          .
        </p>
      </section>

      <section className="mb-6">
        <h2 className="font-display text-xl mb-3">Perguntas frequentes</h2>
        <div className="space-y-2">
          {FAQ.map(({ q, a }, i) => (
            <details key={i} className="sticker p-3 group">
              <summary className="font-display cursor-pointer list-none flex items-center justify-between gap-2">
                <span className="flex-1">{q}</span>
                <span className="text-muted-foreground group-open:rotate-90 transition">
                  ›
                </span>
              </summary>
              <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                {a}
              </p>
            </details>
          ))}
        </div>
      </section>

      <section className="sticker p-4">
        <h2 className="font-display text-lg mb-2">🐛 Reportar um bug</h2>
        <p className="text-sm text-muted-foreground">
          Inclua na mensagem: modelo do aparelho, versão do sistema (Android ou
          o navegador que você usa), código da sala (se aplicável) e o que você
          estava fazendo quando o problema aconteceu. Prints ajudam muito.
        </p>
      </section>

      <footer className="mt-8 text-center text-xs text-muted-foreground">
        <Link to="/privacy" className="underline mr-3">
          Privacidade
        </Link>
        <Link to="/terms" className="underline mr-3">
          Termos
        </Link>
        <Link to="/delete-account" className="underline">
          Excluir conta
        </Link>
      </footer>
    </div>
  );
}
