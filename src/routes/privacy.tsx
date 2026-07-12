import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Política de Privacidade — Verbete" },
      {
        name: "description",
        content:
          "Política de privacidade do Verbete: quais dados coletamos, como usamos e como você pode pedir remoção.",
      },
      { name: "robots", content: "index,follow" },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <div className="mobile-shell">
      <header className="mb-4">
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Voltar
        </Link>
        <h1 className="font-display text-3xl mt-2">Política de Privacidade</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Última atualização: 18 de maio de 2026
        </p>
      </header>

      <article className="prose-sm flex flex-col gap-4 pb-8 text-sm leading-relaxed text-foreground/90">
        <section>
          <h2 className="font-display text-lg mb-1">Quem somos</h2>
          <p>
            Verbete é um jogo multiplayer de palavras. Esta política descreve como tratamos os
            dados de quem joga em <strong>verbete.lovable.app</strong>.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">O que coletamos</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Sem conta:</strong> apelido, avatar e cor escolhidos por você, mais o conteúdo
              que você escreve durante a partida (significados inventados, votos).
            </li>
            <li>
              <strong>Com conta:</strong> e-mail, identificador de autenticação e estatísticas de
              jogo (partidas, pontos, conquistas).
            </li>
            <li>
              <strong>Técnico:</strong> dados mínimos para a partida funcionar em tempo real
              (id de sala, timestamps de eventos).
            </li>
          </ul>
          <p className="mt-2">
            Não coletamos localização precisa, contatos, fotos ou microfone.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Como usamos</h2>
          <p>
            Para rodar a partida em tempo real, exibir placares, manter ranking e prevenir abuso.
            Não vendemos seus dados. Não usamos publicidade comportamental.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Conteúdo de jogo</h2>
          <p>
            Os significados que você inventa são mostrados aos outros jogadores da sua sala e podem
            aparecer em histórico de partida. Não publicamos esse conteúdo fora do jogo.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Crianças</h2>
          <p>
            Verbete é indicado para 13+. Não criamos perfis publicitários e não pedimos dados
            pessoais sensíveis.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Seus direitos (LGPD)</h2>
          <p>
            Você pode pedir acesso, correção, exportação ou exclusão dos seus dados a qualquer
            momento entrando em contato pelo e-mail{" "}
            <a className="underline" href="mailto:privacy@verbete.app">privacy@verbete.app</a>.
            Apagar a conta remove suas estatísticas e e-mail; partidas anônimas antigas continuam
            existindo de forma agregada.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Contato</h2>
          <p>
            Dúvidas?{" "}
            <a className="underline" href="mailto:privacy@verbete.app">privacy@verbete.app</a>.
          </p>
        </section>
      </article>
    </div>
  );
}


