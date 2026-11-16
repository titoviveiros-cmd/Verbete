import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { account, fakeAuth } from "@/test/fake-auth";

// B6 (ECA Digital): o interruptor "Aparecer no ranking público" começa como o
// banco disser (padrão desligado), ligar exige o aceite dos Termos da sessão
// (a caixa só aparece ao tentar ligar) e desligar é um toque.

vi.mock(
  "@/integrations/supabase/client",
  async () => (await import("@/test/fake-auth")).supabaseModule,
);

const lib = vi.hoisted(() => ({
  current: false as boolean | null,
  saved: [] as boolean[],
}));
vi.mock("@/lib/ranking-opt-in", async (orig) => ({
  ...(await orig<typeof import("@/lib/ranking-opt-in")>()),
  fetchRankingOptIn: vi.fn(async () => lib.current),
  setRankingOptIn: vi.fn(async (_u: string, v: boolean) => {
    lib.saved.push(v);
  }),
}));

import { RankingOptIn } from "../RankingOptIn";

let seq = 0;
const fresh = () =>
  `00000000-0000-4000-8000-${String(++seq + 500).padStart(12, "0")}`;
const sw = () => screen.getByRole("switch");
const flush = () => act(async () => {});

beforeEach(() => {
  lib.current = false;
  lib.saved = [];
});
afterEach(cleanup);

describe("RankingOptIn", () => {
  it("padrão desligado: mostra que ninguém vê o nome e NÃO mostra a caixa dos Termos", async () => {
    const id = fresh();
    fakeAuth.reset(account(id));
    render(<RankingOptIn userId={id} />);
    await flush();
    expect(sw()).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(/ninguém vê seu nome/)).toBeInTheDocument();
    expect(screen.queryByTestId("terms-consent")).toBeNull();
  });

  it("ligar sem o aceite: a caixa aparece e nada é gravado; marcada, grava true", async () => {
    const id = fresh();
    fakeAuth.reset(account(id));
    const onValue = vi.fn();
    render(<RankingOptIn userId={id} onValue={onValue} />);
    await flush();
    expect(onValue).toHaveBeenCalledWith(false, "load");
    fireEvent.click(sw());
    await flush();
    expect(lib.saved).toEqual([]);
    const box = screen.getByTestId("terms-consent");
    fireEvent.click(box);
    fireEvent.click(sw());
    await flush();
    expect(lib.saved).toEqual([true]);
    expect(sw()).toHaveAttribute("aria-checked", "true");
    expect(onValue).toHaveBeenLastCalledWith(true, "save");
    expect(screen.getByText(/Desligue quando quiser/)).toBeInTheDocument();
  });

  it("desligar é um toque, sem caixa nem aceite", async () => {
    const id = fresh();
    fakeAuth.reset(account(id));
    lib.current = true;
    render(<RankingOptIn userId={id} />);
    await flush();
    expect(sw()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw());
    await flush();
    expect(lib.saved).toEqual([false]);
    expect(sw()).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("terms-consent")).toBeNull();
  });

  it("sem conseguir ler a escolha: interruptor travado (não presume nada)", async () => {
    const id = fresh();
    fakeAuth.reset(account(id));
    lib.current = null;
    render(<RankingOptIn userId={id} />);
    await flush();
    expect(sw()).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(/carregar sua escolha/);
  });
});
