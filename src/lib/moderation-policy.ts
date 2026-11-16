// Política de denúncia, decisão e recurso — ECA Digital (Lei 15.211/2025,
// arts. 28–30) e Lei 14.852/2024, art. 16, I–III e VIII (11/11/2026).
//
// O que a lei pede (resumo; NÃO é parecer):
//   * retorno ao denunciante "em prazo razoável" (L14852 art. 16, II);
//   * ao autor do conteúdo: aviso da retirada, motivo, se a análise foi
//     humana ou automatizada, recurso de fácil acesso e PRAZOS definidos
//     (L15211 art. 30, I–V);
//   * revisão e reversão de penalidade (L14852 art. 16, III);
//   * tudo explicado em português simples (L14852 art. 16, VIII).
//
// Os PRAZOS abaixo são ESCOLHA DE PRODUTO (a lei não fixa números): mudam
// aqui e a página /denuncias, o servidor e os testes acompanham. Dependem de
// validação do(a) advogado(a) (pergunta Q13 da proposta ECA).
//
// Este módulo é PURO (sem banco): o servidor (report-feedback.ts) busca as
// linhas e usa estas funções para decidir o que cada pessoa pode ver.

/** Prazo para a equipe analisar uma denúncia (horas). */
export const REPORT_REVIEW_HOURS = 72;
/** Prazo para o autor contestar uma medida (dias, a partir da decisão). */
export const APPEAL_WINDOW_DAYS = 15;
/** Prazo para responder ao recurso (dias, a partir do recurso). */
export const APPEAL_REVIEW_DAYS = 15;
/**
 * O resultado de uma denúncia só aparece para o denunciante 1 h depois de
 * ela ser feita. Motivo: a cédula VERDADEIRA é descartada automaticamente na
 * hora (report-definition.ts) — mostrar "descartada" durante a votação
 * revelaria a resposta certa. Com o atraso fixo, toda denúncia recente
 * aparece igual ("em análise"), verdadeira ou não.
 */
export const REPORTER_RESULT_DELAY_MINUTES = 60;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** Medida tomada na decisão (coluna reports.action). */
export const REPORT_ACTIONS = ["dismiss", "remove_content", "ban"] as const;
export type ReportAction = (typeof REPORT_ACTIONS)[number];

/** Motivo da medida, mostrado ao autor e guardado em reports.decision_reason. */
export const DECISION_REASONS = {
  ofensa: "Ofensa, palavrão ou discriminação",
  assedio: "Assédio ou intimidação (bullying)",
  dados_pessoais: "Dados pessoais ou contato (telefone, e-mail, rede social)",
  conteudo_sexual: "Conteúdo sexual",
  falsa_identidade: "Fingir ser outra pessoa",
  spam: "Spam ou propaganda",
  outro: "Outra violação dos Termos de Uso",
} as const;
export type DecisionReason = keyof typeof DECISION_REASONS;
export const DECISION_REASON_KEYS = Object.keys(
  DECISION_REASONS,
) as DecisionReason[];

export const ACTION_LABEL: Record<ReportAction, string> = {
  dismiss: "Sem violação: nada foi removido",
  remove_content: "Conteúdo removido",
  ban: "Suspensão da conta/aparelho",
};

/** Linha de reports com as colunas que estas regras usam. */
export type ReportRow = {
  id: string;
  definition_id: string | null;
  definition_text: string;
  reason: string;
  status: string; // pending | resolved | dismissed
  action: string | null;
  decision_reason: string | null;
  review_kind: string | null; // human | automated
  resolved_at: string | null;
  created_at: string;
  reporter_user_id?: string;
  offender_user_id?: string | null;
};

export type AppealRow = {
  id: string;
  report_id: string;
  user_id: string;
  text: string;
  status: string; // pending | upheld | reversed
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
};

const ms = (iso: string | null | undefined) =>
  iso ? new Date(iso).getTime() : NaN;

export function reviewDueAt(createdAt: string): string {
  return new Date(ms(createdAt) + REPORT_REVIEW_HOURS * HOUR).toISOString();
}

export function appealDeadline(resolvedAt: string): string {
  return new Date(ms(resolvedAt) + APPEAL_WINDOW_DAYS * DAY).toISOString();
}

export function appealDueAt(appealCreatedAt: string): string {
  return new Date(ms(appealCreatedAt) + APPEAL_REVIEW_DAYS * DAY).toISOString();
}

export type ReporterState = "em_analise" | "sem_violacao" | "medida_aplicada";

/** O que o DENUNCIANTE vê: nunca o autor, nunca quem decidiu. */
export type ReporterView = {
  id: string;
  kind: "definicao" | "jogador";
  createdAt: string;
  dueAt: string;
  overdue: boolean;
  state: ReporterState;
  resultLabel: string;
  reviewKind: "humana" | "automatizada" | null;
};

export function reporterView(r: ReportRow, now: number): ReporterView {
  const created = ms(r.created_at);
  const decided = r.status !== "pending" && !!r.resolved_at;
  const visible =
    decided && now >= created + REPORTER_RESULT_DELAY_MINUTES * 60 * 1000;
  const dueAt = reviewDueAt(r.created_at);
  let state: ReporterState = "em_analise";
  if (visible)
    state =
      r.action === "remove_content" ||
      r.action === "ban" ||
      r.status === "resolved"
        ? "medida_aplicada"
        : "sem_violacao";
  const resultLabel =
    state === "em_analise"
      ? `Em análise — resposta em até ${REPORT_REVIEW_HOURS} h`
      : state === "sem_violacao"
        ? "Analisada: não encontramos violação dos Termos"
        : "Analisada: aplicamos uma medida (remoção ou suspensão)";
  return {
    id: r.id,
    kind: r.definition_id ? "definicao" : "jogador",
    createdAt: r.created_at,
    dueAt,
    overdue: !visible && now > ms(dueAt),
    state,
    resultLabel,
    reviewKind: visible
      ? r.review_kind === "automated"
        ? "automatizada"
        : "humana"
      : null,
  };
}

/** O que o AUTOR do conteúdo vê quando sofre uma medida (art. 30). */
export type OffenderNotice = {
  reportId: string;
  content: string;
  action: ReportAction;
  actionLabel: string;
  reasonLabel: string;
  reviewKind: "humana" | "automatizada";
  decidedAt: string;
  appealDeadline: string;
  canAppeal: boolean;
  appeal: null | {
    status: "pending" | "upheld" | "reversed";
    statusLabel: string;
    dueAt: string;
    note: string | null;
  };
};

const APPEAL_STATUS_LABEL = {
  pending: "Recurso em análise",
  upheld: "Recurso analisado: a medida foi mantida",
  reversed: "Recurso aceito: a medida foi desfeita",
} as const;

/** Medidas que geram aviso ao autor: só remoção e suspensão. */
export function isNoticeAction(
  a: string | null,
): a is "remove_content" | "ban" {
  return a === "remove_content" || a === "ban";
}

export function offenderNotice(
  r: ReportRow,
  appeal: AppealRow | null,
  now: number,
): OffenderNotice | null {
  if (!isNoticeAction(r.action) || !r.resolved_at) return null;
  const deadline = appealDeadline(r.resolved_at);
  const reason = (r.decision_reason ?? "outro") as DecisionReason;
  const status = (appeal?.status ??
    "pending") as keyof typeof APPEAL_STATUS_LABEL;
  return {
    reportId: r.id,
    content: r.definition_text,
    action: r.action,
    actionLabel: ACTION_LABEL[r.action],
    reasonLabel: DECISION_REASONS[reason] ?? DECISION_REASONS.outro,
    reviewKind: r.review_kind === "automated" ? "automatizada" : "humana",
    decidedAt: r.resolved_at,
    appealDeadline: deadline,
    canAppeal: !appeal && now <= ms(deadline),
    appeal: appeal
      ? {
          status,
          statusLabel:
            APPEAL_STATUS_LABEL[status] ?? APPEAL_STATUS_LABEL.pending,
          dueAt: appealDueAt(appeal.created_at),
          note: appeal.status === "pending" ? null : appeal.decision_note,
        }
      : null,
  };
}

/** Motivo para recusar um recurso, ou null quando pode registrar. */
export function appealError(
  r: ReportRow | null,
  existing: AppealRow | null,
  userId: string,
  now: number,
): string | null {
  if (!r || r.offender_user_id !== userId) return "Aviso não encontrado.";
  if (!isNoticeAction(r.action) || !r.resolved_at)
    return "Esta decisão não tem recurso (nenhuma medida foi aplicada).";
  if (existing) return "Você já contestou esta decisão.";
  if (now > ms(appealDeadline(r.resolved_at)))
    return `O prazo de ${APPEAL_WINDOW_DAYS} dias para contestar terminou.`;
  return null;
}
