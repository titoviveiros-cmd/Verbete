// Tipos de scripts/lib/d1-lote.mjs (conferência offline de lotes do D1).
export const SET_HASH_VERSION: "verbete-d1-v1";
export function setHash(
  wordId: string,
  truth: string,
  distractors: readonly string[],
): Promise<string>;

export type Nivel = "BLOQUEIA" | "REVISAR" | "INFO";
export const ALERTAS: Record<string, [Nivel, string]>;
export const STATUS_PENDENTE: "PENDENTE";
export const STATUS_ALERTA: "ALERTA";

export type PalavraAcervo = {
  id: string;
  word: string;
  meaning: string;
  classe: string | null;
  category: string | null;
  rarity: number | null;
};
export type Extras = {
  sinonimos: Map<string, string[]>;
  diario30: Set<string>;
};
export type Conjunto = {
  word_id: string;
  word: string | null;
  truth: string | null;
  distractors: string[];
  hash: string | null;
  fontes: string[] | null;
  lote: string;
  n: number | null;
};
export type Alerta = {
  codigo: string;
  nivel: Nivel;
  texto: string;
  detalhe: string;
  alternativa: number | null;
};
export type ConjuntoConferido = {
  lote: string;
  n: number;
  word_id: string;
  palavra: string;
  classe: string | null;
  categoria: string | null;
  definicao: string;
  alternativas: string[];
  tela: string[];
  fontes: string[];
  hash: string | null;
  status: "PENDENTE" | "ALERTA";
  bloqueia: number;
  revisar: number;
  alertas: Alerta[];
};
export type Resumo = {
  total: number;
  por_status: Record<string, number>;
  com_bloqueio: number;
  alertas_por_codigo: Record<string, number>;
  conjuntos_por_codigo: Record<string, number>;
  por_lote: Record<
    string,
    { total: number; PENDENTE: number; ALERTA: number; com_bloqueio: number }
  >;
};
export type Relatorio = { conjuntos: ConjuntoConferido[]; resumo: Resumo };

export function formatoTela(s: string): string;
export function lerAcervo(raw: unknown): PalavraAcervo[];
export function lerExtras(raw: unknown): Extras;
export function lerConjuntos(raw: unknown, loteFixo?: string): Conjunto[];
export function temaSensivel(s: string): string[];
export function marcasPtPt(s: string): string[];
export function grafiaAntiga(s: string): string[];
export function conferirLote(
  conjuntos: Conjunto[],
  opts: {
    acervo: PalavraAcervo[];
    extras?: Extras;
    duvidas?: Record<string, unknown>;
    repetidaGlobalMin?: number;
  },
): Promise<Relatorio>;
export function resumir(cs: ConjuntoConferido[]): Resumo;
export function csvCampo(v: unknown): string;
export function paraCsv(cabecalho: unknown[], linhas: unknown[][]): string;
export function lerCsv(texto: string): Array<Record<string, string>>;
export const COLUNAS_REVISAO: string[];
export function linhasRevisao(cs: ConjuntoConferido[]): unknown[][];
export function normalizarDecisao(s: unknown): string | null;
export type Decisao = {
  word_id: string;
  palavra: string;
  decisao: string | null;
  hash: string;
  nota: string;
};
export function lerDecisoes(texto: string): Decisao[];
export function montarManifesto(
  relatorio: { conjuntos: ConjuntoConferido[] },
  decisoes: Decisao[],
  lote: string | number,
): Promise<{
  manifesto: {
    versao_hash: "verbete-d1-v1";
    lote: string | number;
    itens: Array<{
      word_id: string;
      palavra: string;
      distractors: string[];
      hash: string;
    }>;
  };
  fora: Array<{ palavra: string; motivo: string }>;
}>;
