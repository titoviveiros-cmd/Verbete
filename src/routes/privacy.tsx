import { createFileRoute, Link } from "@tanstack/react-router";
import { APP_HOST } from "@/lib/app-url";

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
        <Link
          to="/"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Voltar
        </Link>
        <h1 className="font-display text-3xl mt-2">Política de Privacidade</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Última atualização: 3 de outubro de 2026
        </p>
      </header>

      <article className="prose-sm flex flex-col gap-4 pb-8 text-sm leading-relaxed text-foreground/90">
        <section>
          <h2 className="font-display text-lg mb-1">Quem somos</h2>
          <p>
            Verbete é um jogo multiplayer de palavras. Esta política descreve
            como tratamos os dados de quem joga em <strong>{APP_HOST}</strong> e
            no app Verbete para Android.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">O que coletamos</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Sem conta:</strong> apelido, avatar e cor escolhidos por
              você, mais o que você faz na partida: significados inventados,
              votos, mensagens do chat da sala e reações. Para identificar seu
              aparelho na sala criamos uma sessão anônima (um identificador
              aleatório, sem nome nem e-mail).
            </li>
            <li>
              <strong>Com conta:</strong> e-mail, identificador de autenticação,
              estatísticas e histórico de partidas, conquistas e os palpites do
              desafio diário. Se você entrar com o Google, recebemos do Google
              seu nome e e-mail.
            </li>
            <li>
              <strong>Técnico:</strong> dados mínimos para a partida funcionar
              em tempo real (id de sala, horários dos eventos) e registros de
              erro e de saúde do jogo com identificadores embaralhados (sem
              nome, e-mail ou IP), guardados por 30 dias.
            </li>
          </ul>
          <p className="mt-2">
            Não coletamos localização, contatos, fotos, câmera ou microfone. O
            app pede só acesso à internet e à vibração do aparelho.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Como usamos</h2>
          <p>
            Para rodar a partida em tempo real, exibir placares, manter ranking,
            gerar as definições dos bots, avaliar por inteligência artificial a
            semelhança entre definições (bônus 🧠 e desafio diário) e prevenir
            abuso. Não vendemos seus dados. Não exibimos anúncios nem usamos
            publicidade comportamental.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Quem processa os dados</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Supabase:</strong> banco de dados, contas, tempo real e
              funções do servidor.
            </li>
            <li>
              <strong>Cloudflare:</strong> hospedagem do site e do servidor web.
            </li>
            <li>
              <strong>Google (Gemini):</strong> recebe a palavra da rodada, a
              definição verdadeira e os textos escritos pelos jogadores
              (definições inventadas e palpites do desafio diário) para gerar as
              definições dos bots e avaliar semelhanças. Não enviamos nome,
              e-mail nem identificadores de conta.
            </li>
            <li>
              <strong>Google (login e fontes):</strong> o login com Google, se
              você escolher; e as fontes do jogo, carregadas dos servidores do
              Google (que recebem o endereço IP do seu aparelho).
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Conteúdo de jogo</h2>
          <p>
            Os significados que você inventa e as mensagens do chat são
            mostrados aos outros jogadores da sua sala e ficam guardados com o
            registro da sala. Não publicamos esse conteúdo fora do jogo.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Crianças</h2>
          <p>
            Verbete é indicado para 13+. Não criamos perfis publicitários e não
            pedimos dados pessoais sensíveis.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Seus direitos (LGPD)</h2>
          <p>
            Você pode pedir acesso, correção, exportação ou exclusão dos seus
            dados a qualquer momento entrando em contato pelo e-mail{" "}
            <a className="underline" href="mailto:privacy@verbete.app">
              privacy@verbete.app
            </a>
            . Você também pode excluir a conta direto no jogo (Perfil → Zona de
            perigo → Excluir conta): apagamos sua conta, e-mail, perfil,
            estatísticas, conquistas, histórico de partidas e tentativas do
            desafio diário. Nas salas em que você jogou fica só o apelido usado
            naquela partida, sem vínculo com a conta.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Contato</h2>
          <p>
            Dúvidas?{" "}
            <a className="underline" href="mailto:privacy@verbete.app">
              privacy@verbete.app
            </a>
            .
          </p>
        </section>
      </article>
    </div>
  );
}
