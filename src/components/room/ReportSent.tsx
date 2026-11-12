import { REPORT_REVIEW_HOURS } from "@/lib/moderation-policy";

/**
 * Confirmação da denúncia com o PRAZO e onde acompanhar (ECA Digital art. 28;
 * L14852 art. 16 II e VIII: retorno ao denunciante, em linguagem simples).
 * Sem link: no meio da partida, sair da sala atrapalharia o jogo.
 */
export function ReportSent() {
  return (
    <div className="text-center py-2 flex flex-col gap-1">
      <p className="text-mint text-sm">✅ Obrigado! Denúncia registrada.</p>
      <p className="text-[11px] text-muted-foreground">
        Uma pessoa da equipe analisa em até {REPORT_REVIEW_HOURS} h. Acompanhe o
        resultado na página Denúncias (rodapé da tela inicial).
      </p>
    </div>
  );
}
