// D1 — manifesto de um lote REVISADO fora do painel (lista de IDs + alternativas + hash).
// Garante correspondência EXATA entre o que o dono revisou e o que é gravado/aprovado:
// hash v1 = SHA-256 (hex) de ["verbete-d1-v1", word_id, definição atual da palavra,
// alt1, alt2, alt3].join("\n"), alternativas com trim(). O servidor recalcula o hash
// na importação e na aprovação e recusa o que divergir (ver daily-choice-admin.ts).
// O manifesto é colado pelo admin na hora: nunca vai para o bundle nem para o repositório.
import { z } from "zod";
import type { AdminItem } from "./daily-choice-admin";

export const SET_HASH_VERSION = "verbete-d1-v1";
export const HASH_RE = /^[0-9a-f]{64}$/;
export const MAX_MANIFEST = 200;

/**
 * R2: o hash junta os campos com "\n". Com a definição livre e exatamente 3
 * alternativas SEM quebra de linha, a junção é inequívoca (as 3 últimas linhas
 * são as alternativas). Por isso nenhuma alternativa pode ter quebra de linha
 * nem caractere de controle. O formato do hash NÃO muda (os hashes já revisados
 * continuam valendo; nenhum dos 192 tem esses caracteres).
 */
// eslint-disable-next-line no-control-regex -- de propósito: são justamente os caracteres proibidos
export const ALT_PROIBIDO = /[\u0000-\u001f\u007f\u2028\u2029]/;
export const altText = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !ALT_PROIBIDO.test(s), {
    message: "alternativa com quebra de linha ou caractere de controle",
  });

/** Hash de um conjunto (definição exata + 3 alternativas na ordem gravada). */
export async function setHash(
  wordId: string,
  truth: string,
  distractors: readonly string[],
): Promise<string> {
  const text = [
    SET_HASH_VERSION,
    wordId,
    truth,
    ...distractors.map((d) => d.trim()),
  ].join("\n");
  const buf = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(buf), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export const manifestSchema = z.object({
  versao_hash: z.literal(SET_HASH_VERSION),
  lote: z.union([z.string().max(40), z.number().int()]).optional(),
  itens: z
    .array(
      z.object({
        word_id: z.string().uuid(),
        palavra: z.string().max(80).optional(),
        distractors: z.array(altText).length(3),
        hash: z.string().regex(HASH_RE),
      }),
    )
    .min(1)
    .max(MAX_MANIFEST)
    .refine((xs) => new Set(xs.map((x) => x.word_id)).size === xs.length, {
      message: "word_id repetido no manifesto",
    }),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** Lê o texto colado pelo admin; erro legível em vez de exceção crua. */
export function parseManifest(
  text: string,
): { ok: true; manifest: Manifest } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "Não é um JSON válido." };
  }
  const r = manifestSchema.safeParse(raw);
  if (!r.success)
    return {
      ok: false,
      error:
        "Manifesto inválido: " +
        r.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".") || "raiz"}: ${i.message}`)
          .join("; "),
    };
  return { ok: true, manifest: r.data };
}

export type ManifestStatus =
  | "importar" // sem conjunto no banco e o hash bate com a definição atual
  | "identico" // conjunto gravado = exatamente o revisado
  | "divergente" // conjunto gravado difere do revisado
  // R5: o hash do manifesto não bate com (definição ATUAL + alternativas do
  // manifesto). Ou o manifesto foi alterado, ou a definição mudou desde a
  // revisão: daqui não dá para saber qual (o manifesto não traz a definição).
  | "nao_confere"
  | "nao_publicada"
  | "inexistente";

export type ManifestRow = {
  word_id: string;
  palavra: string;
  status: ManifestStatus;
  estado: string | null; // rascunho / aprovado / reprovado / null
};

/** Compara o manifesto com o estado ATUAL do banco (itens de daily_choice_admin_get). */
export async function compareManifest(
  manifest: Manifest,
  items: AdminItem[],
): Promise<ManifestRow[]> {
  const byId = new Map(items.map((it) => [it.word_id, it]));
  const out: ManifestRow[] = [];
  for (const m of manifest.itens) {
    const it = byId.get(m.word_id);
    const palavra = it?.word ?? m.palavra ?? "?";
    if (!it) {
      out.push({
        word_id: m.word_id,
        palavra,
        status: "inexistente",
        estado: null,
      });
      continue;
    }
    const estado = it.status ?? null;
    if (!it.published) {
      out.push({
        word_id: m.word_id,
        palavra,
        status: "nao_publicada",
        estado,
      });
      continue;
    }
    // o hash revisado tem de se reproduzir com a definição de hoje + as alternativas do manifesto
    const revisadoHoje = await setHash(it.word_id, it.truth, m.distractors);
    if (revisadoHoje !== m.hash) {
      out.push({
        word_id: m.word_id,
        palavra,
        status: "nao_confere",
        estado,
      });
      continue;
    }
    if (!it.distractors || !it.status) {
      out.push({
        word_id: m.word_id,
        palavra,
        status: "importar",
        estado: null,
      });
      continue;
    }
    const gravado = await setHash(it.word_id, it.truth, it.distractors);
    out.push({
      word_id: m.word_id,
      palavra,
      status:
        gravado === m.hash && !it.truth_changed ? "identico" : "divergente",
      estado,
    });
  }
  return out;
}
