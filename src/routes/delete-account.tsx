import { createFileRoute, Link } from "@tanstack/react-router";
import { APP_HOST, APP_URL } from "@/lib/app-url";
import {
  ANDROID_PACKAGE,
  CONTACT_EMAIL,
  DELETE_ACCOUNT_PATH,
  contactMailto,
} from "@/lib/legal";
import { READING_VIEWPORT } from "@/lib/viewport";

// Página pública de exclusão de conta (Google Play: recurso web para pedir a
// exclusão sem reinstalar o app). Sem login e sem JavaScript obrigatório: o
// conteúdo sai no HTML do servidor. O que é apagado e o que fica segue o
// comportamento REAL (src/lib/account-deletion.ts, docs/exclusao-de-conta.md)
// — mudar um sem o outro é mentir para o jogador. Prazos de retenção = os da
// migration 20261027200000 (provados em scripts/test-data-retention.mjs);
// prazo de atendimento dos pedidos: nenhum definido.
export const Route = createFileRoute("/delete-account")({
  head: () => ({
    meta: [
      { title: "Excluir conta — Verbete" },
      // Página de leitura: zoom livre (ver lib/viewport.ts).
      READING_VIEWPORT,
      {
        name: "description",
        content:
          "Como excluir sua conta do Verbete pelo app, pelo site ou por e-mail, e o que é apagado.",
      },
      { name: "robots", content: "index,follow" },
    ],
    links: [{ rel: "canonical", href: `${APP_URL}${DELETE_ACCOUNT_PATH}` }],
  }),
  component: DeleteAccountPage,
});

const MAIL_SUBJECT = "Excluir minha conta do Verbete";
const MAIL_BODY = [
  "Quero excluir minha conta do Verbete e os dados ligados a ela.",
  "",
  "E-mail da conta:",
  "Forma de entrar (e-mail e senha, ou Google):",
  "Apelido no perfil (se lembrar):",
].join("\n");

function DeleteAccountPage() {
  return (
    <div className="mobile-shell">
      <header className="mb-4">
        <Link
          to="/"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Voltar
        </Link>
        <h1 className="font-display text-3xl mt-2">Excluir conta</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Verbete — jogo de palavras (site <strong>{APP_HOST}</strong> e app
          Android <code className="text-xs">{ANDROID_PACKAGE}</code>).
        </p>
      </header>

      <article className="flex flex-col gap-4 pb-8 text-sm leading-relaxed text-foreground/90">
        <section aria-labelledby="no-app">
          <h2 id="no-app" className="font-display text-lg mb-1">
            Pelo app ou pelo site
          </h2>
          <ol className="list-decimal pl-5 space-y-1">
            <li>
              Abra o app Verbete ou o site <strong>{APP_HOST}</strong> — não é
              preciso reinstalar o app: o site usa a mesma conta.
            </li>
            <li>Entre na conta (e-mail e senha, ou Google).</li>
            <li>
              Toque em <strong>Perfil</strong> → <strong>Zona de perigo</strong>{" "}
              → <strong>Excluir</strong>.
            </li>
            <li>
              Digite o apelido mostrado na tela para confirmar e toque em{" "}
              <strong>Excluir tudo</strong>.
            </li>
          </ol>
          <p className="mt-2">
            Joga como convidado, sem conta? A sessão de convidado também pode
            ser excluída no Perfil, no mesmo aparelho ou navegador, com os
            mesmos efeitos. Sem isso, ela é apagada automaticamente depois de 30
            dias sem uso.
          </p>
        </section>

        <section aria-labelledby="por-email" className="sticker p-4">
          <h2 id="por-email" className="font-display text-lg mb-1">
            Por e-mail, sem o app
          </h2>
          <p>
            Envie o pedido para{" "}
            <a className="underline break-all" href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>{" "}
            a partir do e-mail da conta (ou informe esse e-mail na mensagem): é
            ele que permite localizar a conta. Sessões de convidado não têm
            e-mail — para elas, use o Perfil no aparelho.
          </p>
          <a
            href={contactMailto(MAIL_SUBJECT, MAIL_BODY)}
            className="btn-pop btn-gold inline-block mt-3"
          >
            Pedir exclusão por e-mail
          </a>
        </section>

        <section aria-labelledby="apagado">
          <h2 id="apagado" className="font-display text-lg mb-1">
            O que é apagado
          </h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              A conta e o acesso a ela: e-mail e senha ou o vínculo com o
              Google.
            </li>
            <li>O perfil: nome exibido no ranking, avatar e cor.</li>
            <li>Estatísticas, XP, nível e a posição no ranking.</li>
            <li>Conquistas e histórico de partidas.</li>
            <li>Palpites e pontuação do Desafio Diário.</li>
          </ul>
        </section>

        <section aria-labelledby="permanece">
          <h2 id="permanece" className="font-display text-lg mb-1">
            O que permanece
          </h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>
              <strong>Nas salas em que você jogou:</strong> o apelido, o avatar
              e a cor usados ali, a pontuação, as definições, os votos e as
              reações da última partida de cada sala, com identificadores
              técnicos — o código de jogador do aparelho e o código interno da
              sessão ou da conta, que deixa de corresponder a uma conta. Esses
              registros são apagados automaticamente 30 dias depois que a sala é
              encerrada.
            </li>
            <li>
              <strong>Moderação:</strong> denúncias feitas por você ou sobre
              você continuam no registro de moderação (com o trecho denunciado,
              o apelido e esses identificadores); a resolvida ou descartada é
              apagada 180 dias depois da resolução. Um banimento continua
              valendo para o aparelho, conferido a cada entrada em sala.
            </li>
            <li>
              <strong>Registros técnicos:</strong> eventos de erro e de saúde do
              jogo, sem nome, e-mail ou IP, apagados automaticamente após 30
              dias; e os registros dos provedores de infraestrutura (Supabase e
              Cloudflare), pelos prazos de cada um.
            </li>
          </ul>
          <p className="mt-2">
            Você também pode pedir pelo mesmo e-mail a exclusão de outros dados,
            como os registros das salas, ou tirar dúvidas sobre eles.
          </p>
        </section>

        <p className="text-xs text-muted-foreground">
          Mais detalhes na{" "}
          <Link to="/privacy" className="underline">
            Política de Privacidade
          </Link>{" "}
          e no{" "}
          <Link to="/support" className="underline">
            Suporte
          </Link>
          .
        </p>
      </article>
    </div>
  );
}
