// D1 — painel do manifesto (regressão do PR #52): resultado e botões pertencem
// SÓ ao manifesto conferido por último. Antes, depois de conferir o arquivo novo,
// o painel reconferia o anterior (estado antigo do React) e voltava a mostrar
// "pronto para importar" com o botão Importar. Cobre a sequência
// válido → adulterado → inválido, edição que invalida o resultado e respostas
// assíncronas fora de ordem.
//
// Espera determinística: cada comparação (SHA-256, assíncrono de verdade) é
// registrada e `settle()` só volta quando TODAS terminaram, sem timeout nem
// nova tentativa. A suíte roda duas vezes: com o hash normal e com o hash
// artificialmente lento (como numa máquina de CI ocupada), que foi o cenário
// que derrubou a 1ª versão destes testes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { SET_HASH_VERSION, setHash } from "@/lib/daily-choice-manifest";
import type { AdminItem } from "@/lib/daily-choice-admin";

const fns = vi.hoisted(() => ({
  getDailyChoicesByIds: vi.fn(),
  addDailyChoiceDrafts: vi.fn(),
  reviewDailyChoices: vi.fn(),
  editDailyChoice: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@/lib/daily-choice.functions", () => fns);
const pend = vi.hoisted(() => ({ list: [] as Promise<unknown>[] }));
vi.mock("@/lib/daily-choice-manifest", async (orig) => {
  const actual = await orig<typeof import("@/lib/daily-choice-manifest")>();
  return {
    ...actual,
    compareManifest: (...args: Parameters<typeof actual.compareManifest>) => {
      const p = actual.compareManifest(...args);
      pend.list.push(p);
      return p;
    },
  };
});

import { DailyChoiceManifest } from "@/components/DailyChoiceManifest";

const ID = "00000000-0000-4000-8000-000000000001";
const TRUTH = "Perda ou diminuição da capacidade de movimento";
const ALTS = [
  "Inflamação da mucosa que reveste o estômago",
  "Medo exagerado de lugares altos",
  "Falta de apetite prolongada",
];
const ITEM: AdminItem = {
  word_id: ID,
  word: "acinesia",
  truth: TRUTH,
  published: true,
  distractors: null,
  status: null,
  truth_changed: false,
};

let VALIDO = "";
let ADULTERADO = "";
const INVALIDO = JSON.stringify({
  versao_hash: SET_HASH_VERSION,
  lote: "TESTE-INVALIDO",
  itens: [{ word_id: ID, palavra: "acinesia", distractors: ALTS, hash: "123" }],
});

beforeEach(async () => {
  const hash = await setHash(ID, TRUTH, ALTS);
  VALIDO = JSON.stringify({
    versao_hash: SET_HASH_VERSION,
    lote: "TESTE",
    itens: [{ word_id: ID, palavra: "acinesia", distractors: ALTS, hash }],
  });
  // última letra da 1ª alternativa trocada, hash mantido (= 2-adulterado.json)
  ADULTERADO = JSON.stringify({
    versao_hash: SET_HASH_VERSION,
    lote: "TESTE-ADULTERADO",
    itens: [
      {
        word_id: ID,
        palavra: "acinesia",
        distractors: [ALTS[0]!.slice(0, -1) + "X", ALTS[1], ALTS[2]],
        hash,
      },
    ],
  });
  for (const f of Object.values(fns)) f.mockReset();
  fns.getDailyChoicesByIds.mockResolvedValue([ITEM]);
});

const onChanged = vi.fn();
function setup() {
  onChanged.mockReset();
  render(<DailyChoiceManifest onChanged={onChanged} />);
  return screen.getByLabelText("manifesto do lote") as HTMLTextAreaElement;
}
const colar = (ta: HTMLTextAreaElement, v: string) =>
  fireEvent.change(ta, { target: { value: v } });
const conferir = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Conferir/ }));
  });
  await settle();
};
const importar = () => screen.queryByRole("button", { name: /Importar/ });
const tick = () => new Promise((r) => setTimeout(r, 0));
/** Volta só quando não há mais comparação em andamento (sem polling por tempo). */
const settle = () =>
  act(async () => {
    await tick();
    while (pend.list.length > 0) {
      await Promise.allSettled(pend.list.splice(0));
      await tick();
    }
  });

/** Promessa controlada pelo teste, para inverter a ordem das respostas. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe.each([
  ["hash normal", 0],
  ["hash lento, como na CI", 25],
])("painel do manifesto D1 — estado do resultado (%s)", (_nome, atraso) => {
  let digestSpy: { mockRestore: () => void } | null = null;
  beforeEach(() => {
    pend.list.length = 0;
    if (atraso > 0) {
      const subtle = globalThis.crypto.subtle;
      const real = subtle.digest.bind(subtle);
      digestSpy = vi
        .spyOn(subtle, "digest")
        .mockImplementation(async (alg, data) => {
          await new Promise((r) => setTimeout(r, atraso));
          return real(alg, data);
        });
    }
  });
  afterEach(async () => {
    // nada do teste pode continuar rodando e vazar para o próximo
    await settle();
    expect(pend.list.length).toBe(0);
    cleanup();
    digestSpy?.mockRestore();
    digestSpy = null;
  });

  it("válido → adulterado → inválido: cada resultado é só do manifesto atual", async () => {
    const ta = setup();

    colar(ta, VALIDO);
    await conferir();
    expect(screen.getByText(/lote TESTE: 1 conjunto/)).toBeTruthy();
    expect(screen.getAllByText("pronto para importar").length).toBeGreaterThan(
      0,
    );
    expect(importar()).toBeTruthy();

    // colar outro texto já apaga o resultado e o botão, antes de conferir
    colar(ta, ADULTERADO);
    expect(screen.queryByText("pronto para importar")).toBeNull();
    expect(importar()).toBeNull();

    await conferir();
    expect(screen.getByText(/lote TESTE-ADULTERADO: 1 conjunto/)).toBeTruthy();
    expect(
      screen.getAllByText("definição mudou — revisar de novo").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("pronto para importar")).toBeNull();
    expect(importar()).toBeNull();
    expect(screen.queryByRole("button", { name: /Aprovar/ })).toBeNull();
    // regressão: 1 consulta por conferência (o bug fazia uma 2ª com o manifesto ANTERIOR)
    expect(fns.getDailyChoicesByIds).toHaveBeenCalledTimes(2);

    colar(ta, INVALIDO);
    await conferir();
    expect(screen.getByText(/Manifesto inválido: itens\.0\.hash/)).toBeTruthy();
    expect(screen.queryByText(/definição mudou/)).toBeNull();
    expect(screen.queryByText("pronto para importar")).toBeNull();
    expect(importar()).toBeNull();
    // inválido não chama o servidor
    expect(fns.getDailyChoicesByIds).toHaveBeenCalledTimes(2);

    // texto que nem é JSON
    colar(ta, "abc");
    await conferir();
    expect(screen.getByText("Não é um JSON válido.")).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled(); // conferir não dispara gravação nem recarga
    expect(fns.addDailyChoiceDrafts).not.toHaveBeenCalled();
    expect(fns.reviewDailyChoices).not.toHaveBeenCalled();
    expect(fns.editDailyChoice).not.toHaveBeenCalled();
  });

  it("resposta atrasada do válido chegando DEPOIS da do adulterado é descartada", async () => {
    const ta = setup();
    const a = deferred<AdminItem[]>();
    const b = deferred<AdminItem[]>();
    fns.getDailyChoicesByIds
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise);

    colar(ta, VALIDO);
    await conferir(); // A em voo
    colar(ta, ADULTERADO);
    await conferir(); // B em voo
    await act(async () => b.resolve([ITEM]));
    await settle();
    expect(screen.getByText(/lote TESTE-ADULTERADO: 1 conjunto/)).toBeTruthy();
    await act(async () => a.resolve([ITEM])); // chega por último, fora de ordem
    await settle();

    expect(screen.getByText(/lote TESTE-ADULTERADO/)).toBeTruthy();
    expect(screen.queryByText(/lote TESTE:/)).toBeNull();
    expect(
      screen.getAllByText("definição mudou — revisar de novo").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("pronto para importar")).toBeNull();
    expect(importar()).toBeNull();
  });

  it("resposta do válido chegando depois de colar o inválido não ressuscita o resultado", async () => {
    const ta = setup();
    const a = deferred<AdminItem[]>();
    fns.getDailyChoicesByIds.mockReturnValueOnce(a.promise);

    colar(ta, VALIDO);
    await conferir(); // A em voo
    colar(ta, INVALIDO);
    await conferir();
    expect(screen.getByText(/Manifesto inválido/)).toBeTruthy();
    await act(async () => a.resolve([ITEM]));
    await settle();

    expect(screen.getByText(/Manifesto inválido/)).toBeTruthy();
    expect(screen.queryByText(/conferido/)).toBeNull();
    expect(screen.queryByText("pronto para importar")).toBeNull();
    expect(importar()).toBeNull();
  });

  it("editar o texto com a conferência em voo descarta a resposta e libera o botão", async () => {
    const ta = setup();
    const a = deferred<AdminItem[]>();
    fns.getDailyChoicesByIds.mockReturnValueOnce(a.promise);

    colar(ta, VALIDO);
    await conferir();
    expect(screen.getByRole("button", { name: /Conferindo/ })).toBeTruthy();
    colar(ta, VALIDO + " ");
    await act(async () => a.resolve([ITEM]));
    await settle();

    expect(screen.queryByText(/conferido/)).toBeNull();
    expect(importar()).toBeNull();
    const btn = screen.getByRole("button", { name: /Conferir/ });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("Importar grava e reconfere o MESMO manifesto da tela (texto travado durante a gravação)", async () => {
    const ta = setup();
    colar(ta, VALIDO);
    await conferir();
    expect(screen.getByText(/lote TESTE: 1 conjunto/)).toBeTruthy();

    const w = deferred<{
      inserted: number;
      divergent: number;
      invalid: number;
    }>();
    fns.addDailyChoiceDrafts.mockReturnValueOnce(w.promise);
    await act(async () => {
      fireEvent.click(importar()!);
    });
    expect(ta.readOnly).toBe(true);
    expect(
      (screen.getByRole("button", { name: /Conferir/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(onChanged).not.toHaveBeenCalled(); // ainda gravando
    await act(async () => w.resolve({ inserted: 1, divergent: 0, invalid: 0 }));
    await settle();

    const sent = fns.addDailyChoiceDrafts.mock.calls[0]![0].data.rows;
    expect(sent).toEqual([
      { wordId: ID, distractors: ALTS, hash: JSON.parse(VALIDO).itens[0].hash },
    ]);
    // a reconferência usou os ids do manifesto gravado
    expect(fns.getDailyChoicesByIds).toHaveBeenLastCalledWith({
      data: { wordIds: [ID] },
    });
    expect(fns.getDailyChoicesByIds).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledTimes(1);
    // a lista do painel só recarrega DEPOIS da reconferência
    expect(onChanged.mock.invocationCallOrder[0]).toBeGreaterThan(
      fns.getDailyChoicesByIds.mock.invocationCallOrder[1]!,
    );
    expect(screen.getByText(/Importados como RASCUNHO: 1/)).toBeTruthy();
    expect(ta.readOnly).toBe(false);
  });

  it("gravou mas a reconferência falhou: resultado antigo e botões somem", async () => {
    const ta = setup();
    colar(ta, VALIDO);
    await conferir();
    expect(screen.getByText(/lote TESTE: 1 conjunto/)).toBeTruthy();

    fns.addDailyChoiceDrafts.mockResolvedValueOnce({
      inserted: 1,
      divergent: 0,
      invalid: 0,
    });
    fns.getDailyChoicesByIds.mockRejectedValueOnce(new Error("rede caiu"));
    await act(async () => {
      fireEvent.click(importar()!);
    });
    await settle();

    expect(screen.getByText(/Importados como RASCUNHO: 1/)).toBeTruthy();
    expect(screen.getByText(/Não foi possível reconferir/)).toBeTruthy();
    expect(screen.queryByText("pronto para importar")).toBeNull();
    expect(importar()).toBeNull();
    expect(ta.readOnly).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("Substituir falha no meio: resultado e botões somem e a lista do painel recarrega", async () => {
    const ta = setup();
    const gravado = {
      ...ITEM,
      distractors: ["a", "b", "c"],
      status: "rascunho",
    };
    fns.getDailyChoicesByIds.mockResolvedValue([gravado]);
    colar(ta, VALIDO);
    await conferir();
    const sub = screen.getByRole("button", { name: /Substituir 1/ });

    fns.editDailyChoice.mockRejectedValueOnce(new Error("falhou no meio"));
    await act(async () => {
      fireEvent.click(sub);
    });
    await settle();

    expect(screen.getByText(/falhou no meio/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Substituir/ })).toBeNull();
    expect(screen.queryByText(/DIVERGENTE/)).toBeNull();
    expect(ta.readOnly).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(fns.editDailyChoice).toHaveBeenCalledWith({
      data: { wordId: ID, distractors: ALTS },
    });
  });

  it("Aprovar envia os hashes do manifesto conferido (o servidor confere)", async () => {
    const ta = setup();
    fns.getDailyChoicesByIds.mockResolvedValue([
      { ...ITEM, distractors: ALTS, status: "rascunho" },
    ]);
    colar(ta, VALIDO);
    await conferir();
    const ok = screen.getByRole("button", { name: /Aprovar 1/ });
    fns.reviewDailyChoices.mockResolvedValueOnce({
      updated: 1,
      skipped: 0,
      problems: [],
    });
    await act(async () => {
      fireEvent.click(ok);
    });
    await settle();

    expect(fns.reviewDailyChoices).toHaveBeenCalledWith({
      data: {
        wordIds: [ID],
        status: "aprovado",
        expected: { [ID]: JSON.parse(VALIDO).itens[0].hash },
      },
    });
    expect(screen.getByText(/1 aprovado\(s\)/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("o campo do manifesto é o único marcado para aceitar colar", () => {
    const ta = setup();
    expect(ta.getAttribute("data-allow-paste")).toBe("admin-manifest");
  });
});
