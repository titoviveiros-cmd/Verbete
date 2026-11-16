import { createFileRoute, Link } from "@tanstack/react-router";
import { CONTACT_EMAIL, contactMailto } from "@/lib/legal";
import { PARENTS_DEVELOPER_NAME, PARENTS_PAGE_PATH } from "@/lib/parents-page";
import { READING_VIEWPORT } from "@/lib/viewport";
import { ReportsPageLink } from "./pais";

// Transparência (Lei 14.852/2024 art. 16 IV; item 18 do B6, 16/11/2026):
// como o Verbete modera, que salvaguardas existem, que sanções aplica, como
// trata a reincidência, que ações educativas oferece e o compromisso de
// publicar números a cada seis meses. Regras desta página (iguais às da /pais):
//  * só fatos conferidos no código; cada controle citado é amarrado por teste
//    (transparency-page.test.tsx) — se o código sair, o teste cai;
//  * números: só o COMPROMISSO de publicar; nenhum número inventado;
//  * prazos de análise e recurso ficam na página /denuncias (PR #65), cujo
//    link só aparece se a rota existir no build.
// Texto a validar com advogado(a) antes de publicar.
export const Route = createFileRoute("/transparencia")({
  head: () => ({
    meta: [
      { title: "Transparência — Verbete" },
      READING_VIEWPORT,
      {
        name: "description",
        content:
          "Como o Verbete modera o conteúdo, que proteções existem, que medidas aplica e o compromisso de publicar números de denúncias e moderação a cada seis meses.",
      },
      { name: "robots", content: "index,follow" },
    ],
  }),
  component: TransparencyPage,
});

function Mail() {
  return (
    <a
      className="underline break-all"
      href={contactMailto("Transparência — Verbete")}
    >
      {CONTACT_EMAIL}
    </a>
  );
}

function TransparencyPage() {
  return (
    <div className="mobile-shell">
      <header className="mb-4">
        <Link
          to="/"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Voltar
        </Link>
        <h1 className="font-display text-3xl mt-2">Transparência</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Como cuidamos do que acontece nas salas do Verbete.
        </p>
      </header>
      <article className="prose-sm flex flex-col gap-4 pb-8 text-sm leading-relaxed text-foreground/90">
        <section>
          <h2 className="font-display text-lg mb-1">Como moderamos</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Filtro automático no servidor:</strong> definições com
              palavrão, links ou contatos (telefone, e-mail, perfil de rede
              social) são recusadas; apelidos assim viram “Jogador”; reações e
              avatares só aceitam emojis; nomes de times e categorias só da
              lista do jogo. O filtro usa uma lista de palavras e não pega tudo.
            </li>
            <li>
              <strong>Denúncia:</strong> a bandeira 🚩 em cada definição e{" "}
              <strong>Denunciar jogador</strong> na sala de espera e no fim da
              partida. Fora do jogo, por <Mail />.
            </li>
            <li>
              <strong>Análise humana:</strong> as denúncias são lidas por uma
              pessoa da moderação, que decide se há violação dos{" "}
              <Link to="/terms" className="underline">
                Termos de Uso
              </Link>
              .
              <ReportsPageLink />
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">
            Proteções que já existem
          </h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Toda sala é privada: só entra quem tem o código ou o link. Não há
              sala aberta para desconhecidos, e o dono pode trancar a sala.
            </li>
            <li>
              Dá para jogar só com bots (<strong>Jogar só com bots</strong>).
              Quem declara menos de 13 anos joga só com bots, na própria sala.
            </li>
            <li>
              O ranking público vem desligado: só aparece quem tem conta e liga
              “Aparecer no ranking público”.
            </li>
            <li>
              Não há chat, mensagens privadas, áudio, vídeo, envio de fotos,
              lista de amigos, anúncios, caixas de recompensa nem compras.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Medidas e reincidência</h2>
          <p>
            Quando há violação, a moderação pode remover o conteúdo e banir o
            aparelho e/ou a conta, por um prazo ou de forma definitiva, tirando
            a pessoa da partida em andamento. Voltar com outro apelido, conta ou
            aparelho para escapar de um banimento é tratado como nova violação e
            pode levar a novo banimento.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Dicas de segurança</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>Use um apelido que não seja o seu nome verdadeiro.</li>
            <li>
              Não escreva telefone, endereço, escola ou redes sociais nas
              definições.
            </li>
            <li>Passe o código da sala só para pessoas conhecidas.</li>
            <li>
              Viu algo ofensivo ou estranho? Denuncie e saia da sala; se for
              grave, conte para um adulto de confiança.
            </li>
          </ul>
          <p className="mt-2">
            Para pais e responsáveis, há uma página com explicações simples:{" "}
            <Link to={PARENTS_PAGE_PATH as never} className="underline">
              Para pais e responsáveis
            </Link>
            .
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">
            Números a cada seis meses
          </h2>
          <p>
            Vamos publicar aqui, a cada seis meses, quantas denúncias recebemos,
            quantos conteúdos foram removidos (pelo filtro e pela moderação),
            quantos banimentos aplicamos e quantos recursos foram aceitos ou
            negados. O primeiro relatório cobre o primeiro semestre depois do
            lançamento na Google Play.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Contato</h2>
          <p>
            Responsável pelo jogo: {PARENTS_DEVELOPER_NAME}. Dúvidas sobre
            moderação: <Mail />.
          </p>
        </section>
      </article>
    </div>
  );
}
