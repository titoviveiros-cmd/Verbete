import { createFileRoute, Link } from "@tanstack/react-router";
import { CONTACT_EMAIL } from "@/lib/legal";
import { READING_VIEWPORT } from "@/lib/viewport";

// A data de "Última atualização" É a versão aceita (TERMS_VERSION em
// src/lib/terms-record.ts; terms-consent.test.ts exige as duas juntas).
// Mudou a data = todo aparelho aceita de novo antes do próximo conteúdo.
// Sem prazo de retenção no texto: a licença vale enquanto o conteúdo
// estiver guardado (prazos na Política; mudar só a Política não muda
// TERMS_VERSION).
export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Termos de Uso — Verbete" },
      // Página de leitura: zoom livre (ver lib/viewport.ts).
      READING_VIEWPORT,
      {
        name: "description",
        content:
          "Termos de uso do Verbete: aceite, conteúdo proibido, denúncia e moderação, inteligência artificial e limites de responsabilidade.",
      },
      { name: "robots", content: "index,follow" },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <div className="mobile-shell">
      <header className="mb-4">
        <Link
          to="/"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Voltar
        </Link>
        <h1 className="font-display text-3xl mt-2">Termos de Uso</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Última atualização: 27 de outubro de 2026
        </p>
      </header>

      <article className="flex flex-col gap-4 pb-8 text-sm leading-relaxed text-foreground/90">
        <section>
          <h2 className="font-display text-lg mb-1">1. Aceitação</h2>
          <p>
            Para criar conteúdo no Verbete — apelido, definições, nome no
            ranking ou palpites do Desafio Diário — você precisa marcar que leu
            e aceita estes Termos. Quando eles mudarem de forma relevante, a
            data acima muda e pedimos um novo aceite antes do próximo conteúdo.
            Se não concorda, não use o serviço.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">2. Conta e idade</h2>
          <p>
            Recomendado para 13 anos ou mais. Conta é opcional — você pode jogar
            como convidado. Você é responsável pelas credenciais da sua conta e
            pode excluí-la quando quiser (veja{" "}
            <Link to="/delete-account" className="underline">
              Excluir conta
            </Link>
            ).
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">
            3. Conteúdo e conduta proibidos
          </h2>
          <p>
            Vale para apelidos, definições, nome no ranking, palpites e qualquer
            outro texto que você envie. É proibido:
          </p>
          <ul className="list-disc pl-5 space-y-1 mt-1">
            <li>
              Conteúdo sexual explícito ou pornográfico, e qualquer conteúdo
              sexual envolvendo menores de idade.
            </li>
            <li>
              Discurso de ódio ou discriminação por raça, cor, etnia, origem,
              religião, gênero, orientação sexual, deficiência, idade ou
              condição social.
            </li>
            <li>Ameaças, assédio, intimidação ou perseguição.</li>
            <li>Violência gráfica, ou apologia ou incitação à violência.</li>
            <li>
              Incentivo a automutilação, suicídio ou transtornos alimentares.
            </li>
            <li>Promover ou ensinar atividades ilícitas.</li>
            <li>
              Expor dados pessoais de outras pessoas (nome completo, endereço,
              telefone, documentos) ou informações privadas.
            </li>
            <li>
              Se passar por outra pessoa, marca, moderador ou pelo Verbete.
            </li>
            <li>Golpes, ou pedidos de dinheiro, senhas ou dados pessoais.</li>
            <li>Spam, propaganda ou conteúdo repetitivo.</li>
            <li>Links, inclusive maliciosos.</li>
            <li>
              Explorar bugs, trapacear ou usar automação para obter vantagem
              indevida.
            </li>
            <li>
              Tentar acessar contas, salas ou sistemas sem permissão, ou burlar
              banimentos e proteções do jogo.
            </li>
          </ul>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">4. Denúncia e moderação</h2>
          <p>
            Toda definição pode ser denunciada pela bandeira 🚩 da cédula,
            inclusive as dos bots. Apelidos e comportamento podem ser
            denunciados em <strong>Denunciar jogador</strong>, na sala de espera
            e no fim da partida. O app aplica filtros automáticos (palavras
            bloqueadas e links) e o dono da sala pode remover jogadores. A
            moderação analisa as denúncias e pode remover conteúdo e banir, por
            um prazo ou definitivamente, o aparelho e/ou a conta de quem violar
            estes Termos, tirando-o da partida em andamento. Para contestar uma
            decisão, escreva para o contato abaixo.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">
            5. Inteligência artificial
          </h2>
          <p>
            As definições dos bots são criadas por inteligência artificial
            (Google Gemini), que também avalia a semelhança entre as definições
            e a verdadeira (bônus 🧠) e os palpites do Desafio Diário. Para
            isso, as definições e os palpites que você escreve são enviados ao
            Gemini, sem seu nome, e-mail ou identificadores. A IA pode errar, e
            o conteúdo gerado por ela também pode ser denunciado. Não escreva
            dados pessoais nas definições e nos palpites.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">6. Seu conteúdo</h2>
          <p>
            Você mantém os direitos do que escreve. Ao enviar conteúdo, você
            concede ao Verbete licença gratuita e não exclusiva para guardá-lo,
            exibi-lo aos jogadores da sala, processá-lo — inclusive pela
            inteligência artificial, como descrito acima — e usá-lo na moderação
            e no funcionamento do jogo, enquanto ele estiver guardado (veja a{" "}
            <Link to="/privacy" className="underline">
              Política de Privacidade
            </Link>
            ). Não publicamos seu conteúdo fora do jogo.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">7. Disponibilidade</h2>
          <p>
            O serviço é oferecido "como está". Não garantimos disponibilidade
            ininterrupta nem isenção de bugs. Podemos fazer manutenção sem aviso
            prévio.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">
            8. Limitação de responsabilidade
          </h2>
          <p>
            Na máxima extensão permitida pela lei aplicável, o Verbete não
            responde por danos indiretos, lucros cessantes ou perda de dados
            decorrentes do uso ou impossibilidade de uso do serviço.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">9. Mudanças</h2>
          <p>
            Podemos atualizar estes termos. Mudanças relevantes mudam a data no
            topo da página e pedem um novo aceite antes do próximo conteúdo.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">10. Contato</h2>
          <p>
            <a className="underline break-all" href={`mailto:${CONTACT_EMAIL}`}>
              {CONTACT_EMAIL}
            </a>
          </p>
        </section>
      </article>
    </div>
  );
}
