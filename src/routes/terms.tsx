import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Termos de Uso — Verbete" },
      {
        name: "description",
        content:
          "Termos de uso do Verbete: regras de convivência, conteúdo permitido e limites de responsabilidade.",
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
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Voltar
        </Link>
        <h1 className="font-display text-3xl mt-2">Termos de Uso</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Última atualização: 18 de maio de 2026
        </p>
      </header>

      <article className="flex flex-col gap-4 pb-8 text-sm leading-relaxed text-foreground/90">
        <section>
          <h2 className="font-display text-lg mb-1">1. Aceitação</h2>
          <p>
            Ao usar o Verbete você concorda com estes termos. Se não concorda, por favor não use
            o serviço.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">2. Conta e idade</h2>
          <p>
            Recomendado para 13 anos ou mais. Conta é opcional — você pode jogar como convidado.
            Você é responsável pelas credenciais da sua conta.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">3. Conduta esperada</h2>
          <p>É proibido:</p>
          <ul className="list-disc pl-5 space-y-1 mt-1">
            <li>Conteúdo discriminatório, sexual envolvendo menores, ameaças ou assédio.</li>
            <li>Spam, automação ou exploração de bugs para vantagem indevida.</li>
            <li>Tentar acessar contas ou salas de outras pessoas sem permissão.</li>
          </ul>
          <p className="mt-2">
            Aplicamos filtros automáticos e podemos remover conteúdo ou banir contas que violem
            estas regras.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">4. Conteúdo gerado por usuários</h2>
          <p>
            Você mantém os direitos do que escreve. Ao enviar conteúdo dentro do jogo, concede ao
            Verbete licença não exclusiva e gratuita para exibi-lo aos demais jogadores da sua
            sala enquanto a partida ocorre.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">5. Disponibilidade</h2>
          <p>
            O serviço é oferecido "como está". Não garantimos disponibilidade ininterrupta nem
            isenção de bugs. Podemos fazer manutenção sem aviso prévio.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">6. Limitação de responsabilidade</h2>
          <p>
            Na máxima extensão permitida pela lei aplicável, o Verbete não responde por danos
            indiretos, lucros cessantes ou perda de dados decorrentes do uso ou impossibilidade
            de uso do serviço.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">7. Mudanças</h2>
          <p>
            Podemos atualizar estes termos. Mudanças relevantes serão sinalizadas no aplicativo.
            O uso contínuo após a atualização significa concordância.
          </p>
        </section>

        <section>
          <h2 className="font-display text-lg mb-1">8. Contato</h2>
          <p>
            <a className="underline" href="mailto:hello@verbete.app">hello@verbete.app</a>
          </p>
        </section>
      </article>
    </div>
  );
}


