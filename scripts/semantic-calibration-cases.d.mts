// Tipos da bateria de calibração. Os dados ficam em JS puro (o executor roda
// em Node, sem build); os testes conferem o conteúdo em tempo de execução.
export type CalibrationExpect = "alto" | "baixo" | "muito_baixo";

export interface CalibrationCase {
  cat: string;
  word: string;
  truth: string;
  guess: string;
  expect: CalibrationExpect;
}

export declare const CASES: readonly CalibrationCase[];

export declare const BATCH: {
  word: string;
  truth: string;
  candidates: ReadonlyArray<{
    id: string;
    text: string;
    expect: CalibrationExpect;
  }>;
};
