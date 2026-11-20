// Fixtures da ficha "SEM IA" (11/11/2026) — derivadas das mesmas fixtures dos
// testes visuais (e2e/visual/fixtures.ts), sem alterá-las:
//  1) Operação sem IA externa: nenhuma definição "chegou perto" (near_truth_ids
//     vazio) e os placares são recalculados SEM o bônus 🧠 (+3), com as mesmas
//     regras do app (+3 por acertar a verdade, +1 por jogador enganado, +2 ao
//     coordenador se ninguém acertar). Conta feita à mão a partir dos votos de
//     fixtures.ts: Zé perde +3 na rodada 2 (d204) e Nina +3 na rodada 3 (d305).
//  2) O servidor guarda TODA definição em minúsculas e sem acento (inclusive a
//     verdadeira: `lower(unaccent(...))` em advance_writing_to_voting) — é
//     regra do jogo, para a verdadeira não se destacar. Para a captura não
//     parecer erro de digitação ("bajulacao", "sertao"), os textos fictícios
//     foram trocados por frases que não precisam de acento.
import type { Json, MockBackend } from "../../e2e/visual/supabase-mock";
import { roomBackend, type Phase } from "../../e2e/visual/fixtures";

export const TEXT_SEM_ACENTO: Record<string, string> = {
  "peixe pequeno de agua doce": "peixe pequeno de rio",
  "chapeu de palha dos vaqueiros": "abrigo de palha dos vaqueiros",
  "danca de roda do interior paulista": "roda de viola do interior paulista",
  "doce de abobora com cravo": "doce de leite com cravo e canela",
  "cumprimento exagerado, cheio de mesuras; bajulacao":
    "cumprimento exagerado, cheio de mesuras e salamaleques",
  "pequeno tambor de couro usado nas festas juninas do sertao":
    "pequeno tambor de couro usado nas festas juninas do interior",
  "elogio cheio de reverencias para agradar alguem importante":
    "elogio caprichado para agradar uma pessoa importante",
  "passo de danca em que se bate o pe tres vezes no chao":
    "passo de quadrilha em que os pares giram juntos",
};

// Placar sem 🧠 (ids de fixtures.ts)
const ZE = "p_ze004";
const NINA = "p_nina5";
const SCORE_FIX_R2: Record<string, number> = { [ZE]: 4 }; // era 7
const SCORE_FIX_R3: Record<string, number> = { [ZE]: 7, [NINA]: 3 }; // eram 10 e 6

function walk(v: Json, fix: Record<string, number> | null): Json {
  if (Array.isArray(v)) return v.map((x) => walk(x, fix));
  if (v && typeof v === "object") {
    const o: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v)) o[k] = walk(x as Json, fix);
    if (
      fix &&
      typeof o.id === "string" &&
      typeof o.score === "number" &&
      "nickname" in o &&
      o.id in fix
    )
      o.score = fix[o.id as string];
    if (typeof o.text === "string" && o.text in TEXT_SEM_ACENTO)
      o.text = TEXT_SEM_ACENTO[o.text as string];
    if ("near_truth_ids" in o) o.near_truth_ids = [];
    return o;
  }
  return v;
}

export function roomBackendSemIa(
  phase: Phase,
  opts: Parameters<typeof roomBackend>[1] = {},
): MockBackend {
  const b = roomBackend(phase, opts);
  const fix =
    phase === "lobby"
      ? null
      : phase === "writing" || phase === "shuffling" || phase === "voting"
        ? SCORE_FIX_R2
        : SCORE_FIX_R3;
  return walk(b as unknown as Json, fix) as unknown as MockBackend;
}
