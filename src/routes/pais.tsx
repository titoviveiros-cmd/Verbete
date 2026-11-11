import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { APP_HOST } from "@/lib/app-url";
import { CONTACT_EMAIL, contactMailto } from "@/lib/legal";
import { PARENTS_DEVELOPER_NAME, REPORTS_PAGE_PATH } from "@/lib/parents-page";
import { READING_VIEWPORT } from "@/lib/viewport";

// B7 — ECA Digital (Lei 15.211/2025 art. 16; Lei 14.852/2024 art. 16 VI e
// VIII), 11/11/2026: página estática, em linguagem simples, para pais e
// responsáveis. Regras desta página:
//  * só fatos conferidos no código do master 5fd54d4 (as mesmas fontes de
//    /privacy, /support e /delete-account); nada de recurso que não existe;
//  * NÃO há consentimento parental, PIN, modo protegido nem limite de tempo —
//    a página diz isso com todas as letras;
//  * "Não há chat" vale para a interface; a RPC antiga ainda aceita mensagem
//    pela API até o PR #60 (B3) entrar, e a reação aceita texto curto pela
//    API até o PR #66 (B1) — publicar SÓ depois do #60 e do #66;
//  * o nome legal do desenvolvedor é PENDENTE (lib/parents-page.ts) e a trava
//    de build do PR #63 reprova o marcador no bundle de produção;
//  * a página /denuncias é do PR #65: o link só aparece se a rota existir no
//    build; sem ela, fica o texto com o caminho dentro do jogo.
// Texto a validar com advogado(a) antes de publicar.
export const Route = createFileRoute("/pais")({
  head: () => ({
    meta: [
      { title: "Para pais e responsáveis — Verbete" },
      // Página de leitura: zoom livre (ver lib/viewport.ts).
      READING_VIEWPORT,
      {
        name: "description",
        content:
          "Para pais e responsáveis: o que é o Verbete, com quem se joga, o que é coletado, como denunciar, como excluir a conta e quais controles existem.",
      },
      { name: "robots", content: "index,follow" },
    ],
  }),
  component: ParentsPage,
});

function Mail() {
  return (
    <a
      className="underline break-all"
      href={contactMailto("Pais e responsáveis — Verbete")}
    >
      {CONTACT_EMAIL}
    </a>
  );
}

/** Link para /denuncias só se a rota existir neste build (PR #65). */
export function ReportsPageLink() {
  const router = useRouter();
  const exists = Boolean(
    (router.routesByPath as Record<string, unknown>)[REPORTS_PAGE_PATH],
  );
  if (!exists) return null;
  return (
    <>
      {" "}
      Prazos de análise, o resultado das suas denúncias e como contestar uma
      decisão estão na página{" "}
      <Link to={REPORTS_PAGE_PATH as never} className="underline">
        Denúncias
      </Link>
      .
    </>
  );
}

function ParentsPage() {
  return (
    <div className="mobile-shell">
      <header className="mb-4">
        <Link
          to="/"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Voltar
        </Link>
        <h1 className="font-display text-3xl mt-2">Para pais e responsáveis</h1>
        <p className="text-sm text-muted-foreground mt-1">
          O que é o Verbete, com quem se joga e o que você pode fazer.
        </p>
      </header>
      <article className="prose-sm flex flex-col gap-4 pb-8 text-sm leading-relaxed text-foreground/90">
        <section>
          <h2 className="font-display text-lg mb-1">O que é o jogo</h2>
          <p>
            Verbete é um jogo de palavras para jogar em grupo, em{" "}
            <strong>{APP_HOST}</strong> e no app para Android. A cada rodada
            aparece uma palavra rara: cada jogador inventa uma definição falsa e
            depois todos votam em qual acham que é a verdadeira. Há também o
            Desafio Diário, para jogar sozinho. É gratuito, sem anúncios e sem
            compras no app. É indicado para <strong>13 anos ou mais</strong>.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">
            Com quem a criança ou o adolescente interage
          </h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Só com quem está <strong>na mesma sala</strong>. Para entrar numa
              sala é preciso o código de 4 dígitos que o dono da sala
              compartilha. Quem tiver o código consegue entrar — por isso,
              combine que o código só vai para pessoas conhecidas.
            </li>
            <li>
              Na sala, os outros veem o <strong>apelido</strong>, o avatar, a
              cor, os pontos e as reações com emojis. As definições aparecem na
              votação sem o nome de quem escreveu.
            </li>
            <li>
              Não há chat, mensagens privadas, áudio, vídeo, envio de fotos nem
              lista de amigos.
            </li>
            <li>
              Dá para jogar só com <strong>bots</strong> (jogadores
              automáticos): o dono da sala completa a mesa com eles.
            </li>
            <li>
              Com conta, o nome exibido, o avatar e os pontos podem aparecer no
              ranking do jogo, que outros jogadores veem.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">O que é coletado</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Sem conta:</strong> um identificador aleatório da sessão,
              sem nome nem e-mail, e o que acontece na partida (apelido, avatar,
              definições, votos, reações e pontos).
            </li>
            <li>
              <strong>Com conta (opcional):</strong> também o e-mail (no login
              com Google, o Google nos informa nome, e-mail e foto, e o jogo não
              exibe a foto), o nome exibido escolhido no cadastro, estatísticas,
              conquistas, histórico de partidas e os palpites do Desafio Diário.
            </li>
            <li>
              Registros técnicos para o jogo funcionar e para corrigir erros,
              sem nome, e-mail ou endereço IP.
            </li>
          </ul>
          <p className="mt-2">
            Não coletamos localização, contatos, fotos, câmera ou microfone. Não
            há anúncios nem ferramentas de publicidade ou de análise de
            terceiros. Sessões sem conta são apagadas depois de 30 dias sem uso.
            Os detalhes (inclusive o uso de inteligência artificial e por quanto
            tempo guardamos cada dado) estão na{" "}
            <Link to="/privacy" className="underline">
              Política de Privacidade
            </Link>
            .
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Como denunciar</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              Definição ofensiva: toque na bandeira 🚩 da definição, na votação.
            </li>
            <li>
              Apelido ou comportamento: toque em{" "}
              <strong>Denunciar jogador</strong>, na sala de espera ou no fim da
              partida.
            </li>
            <li>O dono da sala também pode remover jogadores da sala.</li>
            <li>
              Fora do jogo, ou se algo grave aconteceu, escreva para <Mail />.
            </li>
          </ul>
          <p className="mt-2">
            A moderação analisa as denúncias e pode remover conteúdo e banir
            quem desrespeitar os{" "}
            <Link to="/terms" className="underline">
              Termos de Uso
            </Link>
            .
            <ReportsPageLink />
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Como excluir a conta</h2>
          <p>
            No jogo: <strong>Perfil → Zona de perigo → Excluir</strong>. A
            exclusão apaga a conta, o perfil, as estatísticas, as conquistas, o
            histórico de partidas e os palpites do Desafio Diário. Sem acesso ao
            app, peça por <Mail />. O que é apagado e o que fica está em{" "}
            <Link to="/delete-account" className="underline">
              Excluir conta
            </Link>
            .
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Controles disponíveis</h2>
          <p>Hoje, no próprio Verbete, existem estes controles:</p>
          <ul className="list-disc pl-5 space-y-1 mt-1">
            <li>Jogar sem conta e sem e-mail.</li>
            <li>
              Usar um apelido que não seja o nome verdadeiro; o nome exibido da
              conta pode ser trocado no Perfil.
            </li>
            <li>Jogar só com bots ou só com pessoas conhecidas.</li>
            <li>Denunciar e, como dono da sala, remover jogadores.</li>
            <li>Excluir a conta a qualquer momento.</li>
          </ul>
          <p className="mt-2">
            <strong>
              O Verbete ainda não tem modo para pais, senha dos responsáveis,
              limite de tempo nem verificação de idade, e não pede autorização
              dos pais para jogar.
            </strong>{" "}
            Para limitar o tempo de tela ou a instalação de apps, use os
            controles parentais do próprio celular ou da loja de apps.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">Contato</h2>
          <p>
            Responsável pelo jogo: {PARENTS_DEVELOPER_NAME}. Dúvidas, pedidos
            sobre os dados de um filho ou filha e denúncias: <Mail />.
          </p>
        </section>
      </article>
    </div>
  );
}
