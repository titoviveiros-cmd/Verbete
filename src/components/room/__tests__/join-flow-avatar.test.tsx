import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Entrar na sala (playtest 2026-10-22): só os avatares na tela — as bolinhas
// de cor saíram. A cor segue existindo por dentro (anel do avatar, lobby…):
// a salva é preservada e o jogador novo ganha uma aleatória válida.
const room = vi.hoisted(() => ({ joinRoom: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/room", () => room);
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@/components/Mascot", () => ({ Mascot: () => <div /> }));
vi.mock("@/lib/sound", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn() : v,
    ]),
  );
});

import { JoinFlow } from "../JoinFlow";
import { AVATARS, COLORS } from "@/lib/avatars";

const join = async () => {
  render(<JoinFlow code="1234" roomId="sala" status="lobby" />);
  fireEvent.change(screen.getByPlaceholderText("Ex: Bia, Zé, Dudu..."), {
    target: { value: "Bia" },
  });
  // aceite dos Termos (aparelho novo: localStorage limpo no beforeEach)
  fireEvent.click(screen.getByRole("checkbox", { name: /Termos de Uso/ }));
  fireEvent.click(screen.getByText(/Entrar na sala/));
  await vi.waitFor(() => expect(room.joinRoom).toHaveBeenCalled());
  return (room.joinRoom.mock.calls[0] as unknown[])[4] as string;
};

beforeEach(() => {
  localStorage.clear();
  room.joinRoom.mockClear();
});
afterEach(() => cleanup());

describe("JoinFlow — escolha só de avatar", () => {
  it("mostra os avatares e NENHUMA bolinha de cor", () => {
    render(<JoinFlow code="1234" roomId="sala" status="lobby" />);
    expect(screen.queryAllByLabelText(/Escolher cor/)).toHaveLength(0);
    expect(screen.getAllByLabelText(/Escolher avatar/)).toHaveLength(
      AVATARS.length,
    );
  });

  it("jogador que já tinha cor salva entra com ELA (compatível)", async () => {
    localStorage.setItem("verbete:color", JSON.stringify("#06D6A0"));
    expect(await join()).toBe("#06D6A0");
  });

  it("jogador novo entra com uma cor válida sorteada", async () => {
    expect(COLORS).toContain(await join());
  });
});
