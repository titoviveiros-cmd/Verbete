// "🤖 gerar definição automática" instantânea (playtest 2026-10-22): antes
// o toque esperava a edge e só caía na reserva local depois de até 6 s —
// numa fase com contagem regressiva. Agora a sugestão começa a ser gerada
// assim que o jogador entra na escrita (enquanto lê a palavra e a cortina
// passa) e fica SÓ neste aparelho: não preenche o campo, não vai ao banco,
// não aparece para ninguém. No toque: pronta → na hora; ainda gerando →
// espera curta (AUTO_DEF_WAIT_MS) e, sem resposta, a reserva local. A
// resposta atrasada nunca troca o texto já mostrado — fica para o próximo
// toque. Cache por sala+rodada+jogador+palavra: trocou, descarta tudo.
export const AUTO_DEF_WAIT_MS = 1000;
/** Gerações por rodada (a 1ª antecipada + as seguintes a cada toque). */
export const AUTO_DEF_MAX_PER_ROUND = 3;

type Entry = {
  promise: Promise<string | null>;
  value: string | null;
  settled: boolean;
};
let currentKey: string | null = null;
let queue: Entry[] = [];
let started = 0;

export function autoDefKey(
  roomId: string,
  round: number,
  playerId: string,
  wordId: string,
) {
  return `${roomId}:${round}:${playerId}:${wordId}`;
}

/** Outra rodada/palavra/jogador: o que era da anterior é descartado. */
function enter(key: string) {
  if (currentKey === key) return;
  currentKey = key;
  queue = [];
  started = 0;
}

function start(generate: () => Promise<string>) {
  if (started >= AUTO_DEF_MAX_PER_ROUND) return;
  started++;
  const entry: Entry = {
    value: null,
    settled: false,
    promise: Promise.resolve(null),
  };
  entry.promise = generate()
    .then((t) => (typeof t === "string" && t.trim() ? t.trim() : null))
    .catch(() => null)
    .then((v) => {
      entry.value = v;
      entry.settled = true;
      return v;
    });
  queue.push(entry);
}

/** Entrou na escrita: começa a gerar UMA sugestão (se ainda não há). */
export function prefetchAutoDefinition(
  key: string,
  generate: () => Promise<string>,
) {
  enter(key);
  if (queue.length === 0) start(generate);
}

/** O toque: devolve a sugestão pronta, espera um pouco ou usa a reserva. */
export async function takeAutoDefinition(
  key: string,
  opts: {
    generate: () => Promise<string>;
    fallback: () => Promise<string>;
    /** textos que não podem voltar (campo atual, sugestões na tela) */
    exclude?: readonly string[];
    waitMs?: number;
  },
): Promise<{ text: string; source: "pronta" | "espera" | "reserva" }> {
  enter(key);
  if (queue.length === 0) start(opts.generate);
  const usable = (v: string | null | undefined): v is string =>
    !!v && !(opts.exclude ?? []).includes(v);
  const entry = queue[0];
  if (entry) {
    let value: string | null | undefined;
    let source: "pronta" | "espera" = "pronta";
    if (entry.settled) value = entry.value;
    else {
      source = "espera";
      value = await Promise.race([
        entry.promise,
        new Promise<undefined>((r) =>
          setTimeout(() => r(undefined), opts.waitMs ?? AUTO_DEF_WAIT_MS),
        ),
      ]);
    }
    if (currentKey !== key)
      return { text: await opts.fallback(), source: "reserva" };
    if (value !== undefined) {
      // usada (ou vazia): sai da fila e já começa a próxima
      queue.shift();
      if (queue.length === 0) start(opts.generate);
      if (usable(value)) return { text: value, source };
    }
  }
  return { text: await opts.fallback(), source: "reserva" };
}

/** Só para testes. */
export function resetAutoDefinitions() {
  currentKey = null;
  queue = [];
  started = 0;
}
