// Leitura com "segunda via" (playtest 2026-10-20). Na medição real de uma
// partida, algumas requisições ao Supabase ficaram presas de 10 a 26 s —
// a busca das palavras da sala levou 25,9 s — enquanto outras, feitas no
// mesmo instante, voltavam em ~250 ms. Se a 1ª tentativa não responder em
// `afterMs`, sai uma 2ª IGUAL e vale a que chegar primeiro: mesma consulta,
// mesmos filtros, mesmo resultado possível — só sem a cauda da travada.
//
// SÓ para leituras sem efeito colateral (SELECT, RPC de consulta). Nunca
// para escrita: duas escritas iguais não são uma escrita.
export const HEDGE_AFTER_MS = 1500;

export function hedged<T>(
  run: () => PromiseLike<T>,
  afterMs = HEDGE_AFTER_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let launched = 0;
    let failed = 0;
    const fire = () => {
      launched++;
      Promise.resolve()
        .then(run)
        .then(
          (value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(value);
          },
          (error: unknown) => {
            failed++;
            if (done) return;
            // a 1ª falhou antes da hora: a 2ª sai já
            if (launched < 2) {
              clearTimeout(timer);
              fire();
              return;
            }
            if (failed >= launched) {
              done = true;
              reject(error);
            }
          },
        );
    };
    const timer = setTimeout(() => {
      if (!done && launched < 2) fire();
    }, afterMs);
    fire();
  });
}
