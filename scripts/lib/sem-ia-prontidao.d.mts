export const META_APROVADOS_JOGAVEIS: number;
export const SQL_PRONTIDAO_SEM_IA: string;

export type Prontidao = {
  ok: boolean;
  aprovadoJogavel: number | null;
  dailyMode: string | null;
  motivos: string[];
};

type Query = (sql: string) => Promise<{ rows?: Array<Record<string, unknown>> } | undefined>;

export function avaliarProntidaoSemIa(
  row: { daily_mode?: unknown; aprovado_jogavel?: unknown } | null | undefined,
  meta?: number,
): Prontidao;

export function checarProntidaoSemIa(query: Query, meta?: number): Promise<Prontidao>;

export function travaAppConfig(o: {
  key: string;
  value: unknown;
  emergencia?: boolean;
  query: Query;
}): Promise<{ ok: boolean; prontidao?: Prontidao; erro?: string; aviso?: string }>;

export const FASES: readonly ["escolha", "suspender", "textos", "revogar"];
export const EVENTOS_IA: readonly string[];
export const SQL_FASES_SEM_IA: string;

export type FaseResultado = {
  ok: boolean;
  fase: string;
  bloqueios: string[];
  avisos: string[];
  manuais: string[];
  dados?: Record<string, unknown>;
};

export function avaliarFaseSemIa(
  fase: string,
  row: Record<string, unknown> | null | undefined,
  meta?: number,
): FaseResultado;

export function checarFaseSemIa(query: Query, fase: string, meta?: number): Promise<FaseResultado>;
