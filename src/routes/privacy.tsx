import { createFileRoute, Link } from "@tanstack/react-router";
import { APP_HOST } from "@/lib/app-url";
import { CONTACT_EMAIL } from "@/lib/legal";

// Só o comportamento COMPROVADO no código (auditoria da rodada 2A,
// 27/10/2026 — docs/exclusao-de-conta.md e
// docs/google-play-data-safety-draft.md). Pendente do proprietário e por isso
// fora daqui: identidade formal do controlador, prazo de retenção das salas,
// plano da API Gemini e prazo de atendimento dos pedidos.
export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Política de Privacidade — Verbete" },
      {
        name: "description",
        content:
          "Política de privacidade do Verbete: quais dados coletamos, como usamos, por quanto tempo guardamos e como pedir a exclusão.",
      },
      { name: "robots", content: "index,follow" },
    ],
  }),
  component: PrivacyPage,
});

function Mail() {
  return (
    <a className="underline break-all" href={`mailto:${CONTACT_EMAIL}`}>
      {CONTACT_EMAIL}
    </a>
  );
}

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
          Última atualização: 27 de outubro de 2026
        </p>
      </header>

      <article className="prose-sm flex flex-col gap-4 pb-8 text-sm leading-relaxed text-foreground/90">
        <section>
          <h2 className="font-display text-lg mb-1">Quem somos</h2>
          <p>
            Verbete é um jogo multiplayer de palavras. Esta política descreve
            como tratamos os dados de quem joga em <strong>{APP_HOST}</strong> e
            no app Verbete para Android. Para qualquer assunto sobre seus dados,
            escreva para <Mail />.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">O que coletamos</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Sessão (todos, com ou sem conta):</strong> ao abrir o
              jogo, criamos uma sessão anônima — um identificador aleatório, sem
              nome nem e-mail — guardada no aparelho para reconhecer você nas
              próximas visitas, mais um código de jogador gerado no aparelho.
              Junto com a sessão, o servidor cria um perfil e estatísticas em
              branco.
            </li>
            <li>
              <strong>Na sala:</strong> o apelido, o avatar e a cor que você
              escolhe, as definições que inventa, seus votos, reações e
              pontuação.
            </li>
            <li>
              <strong>Progresso:</strong> nome exibido, estatísticas, XP, nível,
              conquistas, histórico de partidas e os palpites do Desafio Diário
              ficam ligados à sua sessão de convidado ou à sua conta.
            </li>
            <li>
              <strong>Conta (opcional):</strong> e-mail e senha, ou o login com
              Google — nesse caso o Google nos informa seu nome, e-mail e foto
              de perfil, que ficam no serviço de contas (o jogo não exibe a
              foto). O nome exibido começa com o nome informado no cadastro ou,
              se não houver, com a parte do e-mail antes do @; você pode
              trocá-lo no Perfil.
            </li>
            <li>
              <strong>No aparelho:</strong> apelido, avatar, cor, tema e o
              registro de que você aceitou os Termos ficam salvos só no aparelho
              ou navegador.
            </li>
            <li>
              <strong>Técnico:</strong> dados para a partida funcionar em tempo
              real (sala, horários dos eventos, presença na mesa) e registros de
              erro e de saúde do jogo (mensagem do erro, página e versão do
              app), sem nome, e-mail ou IP.
            </li>
          </ul>
          <p className="mt-2">
            Não coletamos localização, contatos, fotos, câmera ou microfone. O
            app pede só acesso à internet e à vibração do aparelho. Não há
            anúncios, nem ferramentas de publicidade ou de análise de terceiros.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Quem vê o quê</h2>
          <p>
            Os jogadores da sua sala veem seu apelido, avatar, cor, pontuação,
            definições e reações. O ranking é público: quem tem pontos aparece
            nele com o nome exibido, o avatar, a cor e as estatísticas. Outros
            jogadores também conseguem ler o nome exibido, o avatar e a cor do
            seu perfil. E-mail, palpites do Desafio Diário e denúncias não são
            mostrados a outros jogadores.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Como usamos</h2>
          <p>
            Para rodar a partida em tempo real, calcular placares, manter o
            ranking e o progresso, gerar as definições dos bots, avaliar por
            inteligência artificial a semelhança entre definições (bônus 🧠 e
            Desafio Diário), moderar denúncias e corrigir erros. Não vendemos
            seus dados.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">
            Inteligência artificial (Google Gemini)
          </h2>
          <p>
            Enviamos ao Gemini, do Google: a palavra da rodada, a definição
            verdadeira e os textos das definições da rodada, inclusive as
            escritas pelos jogadores, para avaliar quais chegaram perto da
            verdadeira; o seu palpite do Desafio Diário, para avaliá-lo; e, para
            criar as definições dos bots, a palavra, a definição verdadeira e
            definições anteriores dos próprios bots. Não enviamos nome, apelido,
            e-mail nem identificadores de conta, sessão ou jogador. Não escreva
            dados pessoais nas definições e nos palpites.
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
              <strong>Google:</strong> o Gemini (acima); o login com Google, se
              você escolher; e as fontes do jogo, carregadas dos servidores do
              Google, que recebem o endereço IP do seu aparelho.
            </li>
          </ul>
          <p className="mt-2">
            Esses provedores podem tratar dados em servidores fora do Brasil e
            mantêm registros próprios de acesso (que podem incluir o IP), pelos
            prazos de cada um. Todo o tráfego entre o jogo e eles é
            criptografado (HTTPS).
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Conteúdo das salas</h2>
          <p>
            Apelidos, definições, votos e reações ficam guardados com o registro
            da sala. Quando uma sala começa uma nova partida, as definições e os
            votos da anterior são apagados; os da última partida continuam
            guardados, e hoje os registros das salas não são apagados
            automaticamente. O chat das salas foi desativado em outubro de 2026;
            mensagens enviadas antes disso continuam guardadas com as salas. Não
            publicamos esse conteúdo fora do jogo.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Denúncias e moderação</h2>
          <p>
            Uma denúncia guarda o trecho ou o apelido denunciado, a sala, a
            rodada e os identificadores de quem denunciou e de quem foi
            denunciado. Um banimento guarda o identificador do aparelho e/ou da
            conta, o motivo e o prazo. Só a moderação tem acesso, e esses
            registros não são apagados automaticamente.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Por quanto tempo</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Sessão, conta, perfil e progresso: até você excluir. Sessões de
              convidado sem uso não são apagadas automaticamente.
            </li>
            <li>
              Salas, denúncias e banimentos: sem apagamento automático hoje.
            </li>
            <li>
              Presença na mesa: 2 dias. Registros de erro e saúde: 30 dias.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Exclusão da conta</h2>
          <p>
            No jogo: Perfil → Zona de perigo → Excluir. Apagamos a conta e o
            acesso a ela (e-mail, senha ou vínculo com o Google), o perfil, as
            estatísticas, as conquistas, o histórico de partidas e os palpites
            do Desafio Diário. Permanecem os registros das salas (apelido,
            definições, votos e identificadores técnicos), as denúncias e os
            banimentos, e os registros técnicos acima. Sem o app, peça por{" "}
            <Mail /> — detalhes em{" "}
            <Link to="/delete-account" className="underline">
              Excluir conta
            </Link>
            .
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Crianças</h2>
          <p>
            O Verbete é destinado a pessoas com 13 anos ou mais. Não criamos
            perfis publicitários e não pedimos dados pessoais sensíveis.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Seus direitos (LGPD)</h2>
          <p>
            Você pode pedir confirmação do tratamento, acesso, correção,
            exportação ou exclusão dos seus dados e informações sobre com quem
            eles são compartilhados, escrevendo para <Mail />.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Mudanças</h2>
          <p>
            Quando esta política mudar, a data no topo da página muda junto.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Contato</h2>
          <p>
            Dúvidas? <Mail />.
          </p>
        </section>
      </article>
    </div>
  );
}
