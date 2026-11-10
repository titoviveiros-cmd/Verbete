// D1 — R6: o painel principal só aprova pelo hash do que está NA TELA.
// Antes, "✅ Aprovar" mandava só os ids e o servidor aprovava sem hash
// (inclusive um REPROVADO, de uma vez). Agora:
//  * aprovar envia { expected: id → hash(definição exibida + alternativas exibidas), source: "painel" };
//  * uma edição aberta e não salva é "o que está na tela": o hash dela não bate com
//    o gravado, e o banco não aprova (ver daily-choice-r6.test.ts);
//  * na aba de reprovados não há "Aprovar": primeiro "↩ Voltar a rascunho" (sem hash,
//    não é aprovação); reprovar continua sem hash.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import { setHash } from "@/lib/daily-choice-manifest";

const fns = vi.hoisted(() => ({
  listDailyChoices: vi.fn(),
  getDailyChoicePool: vi.fn(),
  addDailyChoiceDrafts: vi.fn(),
  reviewDailyChoices: vi.fn(),
  editDailyChoice: vi.fn(),
  getDailyChoicesByIds: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: unknown) => fn,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: Record<string, unknown>) => ({ options: opts }),
  Link: ({ children }: { children: unknown }) => children,
  useNavigate: () => vi.fn(),
}));
vi.mock("@/lib/daily-choice.functions", () => fns);
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "admin-1" }, loading: false }),
}));
vi.mock("@/integrations/supabase/client", () => {
  const q = {
    select: () => q,
    eq: () => q,
    maybeSingle: async () => ({ data: { role: "admin" } }),
  };
  return { supabase: { from: () => q } };
});
vi.mock("@/components/Mascot", () => ({ Mascot: () => null }));
vi.mock("@/components/DailyChoiceManifest", () => ({
  DailyChoiceManifest: () => null,
}));

import { Route } from "@/routes/admin.daily-choices";
const Page = (Route as unknown as { options: { component: ComponentType } })
  .options.component;

const ID1 = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";
const TRUTH = "Perda ou diminuição da capacidade de movimento";
const ALTS = [
  "Inflamação da mucosa que reveste o estômago",
  "Medo exagerado de lugares altos",
  "Falta de apetite prolongada",
];
const row = (id: string, word: string, status: string) => ({
  word_id: id,
  word,
  truth: TRUTH,
  category: null,
  classe: null,
  distractors: [...ALTS],
  status,
  truth_changed: false,
  published: true,
  validacao: { ok: true, issues: [] },
});
const lista = (status: string) => ({
  counts: {},
  total: 2,
  items: [row(ID1, "acinesia", status), row(ID2, "abulia", status)],
});

beforeEach(() => {
  fns.listDailyChoices.mockImplementation(
    async ({ data }: { data: { status: string } }) => lista(data.status),
  );
  fns.reviewDailyChoices.mockResolvedValue({
    updated: 1,
    skipped: 0,
    problems: [],
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("R6 — painel principal aprova só pelo hash do que está na tela", () => {
  it("✅ Aprovar (um) envia o hash da definição e das alternativas exibidas", async () => {
    render(<Page />);
    const aprovar = await screen.findAllByRole("button", {
      name: "✅ Aprovar",
    });
    fireEvent.click(aprovar[0]!);
    await waitFor(() => expect(fns.reviewDailyChoices).toHaveBeenCalled());
    expect(fns.reviewDailyChoices).toHaveBeenCalledWith({
      data: {
        wordIds: [ID1],
        status: "aprovado",
        expected: { [ID1]: await setHash(ID1, TRUTH, ALTS) },
        source: "painel",
      },
    });
  });

  it("lote selecionado: um hash por item, cada um do seu próprio conteúdo", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByLabelText("selecionar acinesia"));
    fireEvent.click(screen.getByLabelText("selecionar abulia"));
    fireEvent.click(
      screen.getByRole("button", { name: "✅ Aprovar selecionados (2)" }),
    );
    await waitFor(() => expect(fns.reviewDailyChoices).toHaveBeenCalled());
    const { data } = fns.reviewDailyChoices.mock.calls[0]![0];
    expect(data.source).toBe("painel");
    expect(data.expected).toEqual({
      [ID1]: await setHash(ID1, TRUTH, ALTS),
      [ID2]: await setHash(ID2, TRUTH, ALTS),
    });
  });

  it("edição aberta e não salva: o hash é do que está na tela (não do gravado)", async () => {
    render(<Page />);
    const lapis = await screen.findAllByRole("button", { name: "✏️" });
    fireEvent.click(lapis[0]!);
    const campo = screen.getAllByLabelText("distrator 1")[0]!;
    fireEvent.change(campo, { target: { value: "Ave pequena dos rios" } });
    fireEvent.click(screen.getByLabelText("selecionar acinesia"));
    fireEvent.click(
      screen.getByRole("button", { name: "✅ Aprovar selecionados (1)" }),
    );
    await waitFor(() => expect(fns.reviewDailyChoices).toHaveBeenCalled());
    const { data } = fns.reviewDailyChoices.mock.calls[0]![0];
    const naTela = await setHash(ID1, TRUTH, [
      "Ave pequena dos rios",
      ALTS[1]!,
      ALTS[2]!,
    ]);
    expect(data.expected).toEqual({ [ID1]: naTela });
    // o gravado tem outro hash: o banco recalcula e não aprova o que não foi visto
    expect(naTela).not.toBe(await setHash(ID1, TRUTH, ALTS));
  });

  it("reprovar continua sem hash (não é aprovação)", async () => {
    render(<Page />);
    const reprovar = await screen.findAllByRole("button", {
      name: "🗑 Reprovar",
    });
    fireEvent.click(reprovar[1]!);
    await waitFor(() => expect(fns.reviewDailyChoices).toHaveBeenCalled());
    expect(fns.reviewDailyChoices).toHaveBeenCalledWith({
      data: { wordIds: [ID2], status: "reprovado" },
    });
  });

  it("aba reprovados: sem 'Aprovar'; só '↩ Voltar a rascunho' (sem hash)", async () => {
    render(<Page />);
    fireEvent.click(
      await screen.findByRole("button", { name: "🗑 reprovados" }),
    );
    const voltar = await screen.findAllByRole("button", {
      name: "↩ Voltar a rascunho",
    });
    expect(screen.queryByRole("button", { name: "✅ Aprovar" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Aprovar selecionados/ }),
    ).toBeNull();
    fireEvent.click(voltar[0]!);
    await waitFor(() => expect(fns.reviewDailyChoices).toHaveBeenCalled());
    expect(fns.reviewDailyChoices).toHaveBeenCalledWith({
      data: { wordIds: [ID1], status: "rascunho" },
    });
  });

  it("aba aprovados: nenhum botão de aprovar", async () => {
    render(<Page />);
    fireEvent.click(
      await screen.findByRole("button", { name: "✅ aprovados" }),
    );
    await screen.findAllByRole("button", { name: "🗑 Reprovar" });
    expect(screen.queryByRole("button", { name: "✅ Aprovar" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Voltar a rascunho/ }),
    ).toBeNull();
  });
});
