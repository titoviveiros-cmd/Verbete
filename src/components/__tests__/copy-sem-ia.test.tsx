import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Onboarding } from "@/components/Onboarding";

// Multiplayer sem IA (app_config.ai_mode = 'suspenso', 08/11/2026): com a IA
// suspensa o juiz marca a rodada sem bônus 🧠 (docs/contencao-ia.md). Nenhum
// texto ao jogador pode PROMETER a avaliação de proximidade como certa: o
// bônus 🧠 só é descrito como condicional ("quando ... estiver ativa").

vi.mock("@/lib/player-id", () => ({
  getStored: () => "",
  setStored: vi.fn(),
}));

afterEach(cleanup);

const ROOT = resolve(__dirname, "../../..");
const read = (p: string) =>
  readFileSync(resolve(ROOT, p), "utf8").replace(/\s+/g, " ");

describe("textos sem promessa de avaliação semântica (IA suspensa)", () => {
  it("Como jogar: bônus 🧠 condicional e sem 'nota de 80'", async () => {
    render(<Onboarding onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Passo 4" }));
    await screen.findByRole("heading", { name: "Como ganhar pontos" });
    expect(
      screen.getByText(
        /bônus 🧠\) se sua definição ficar muito próxima da correta, quando a avaliação automática de proximidade estiver ativa/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/nota de 80/i)).not.toBeInTheDocument();
  });

  it("Suporte: bônus 🧠 só 'quando a avaliação ... está ativa'", () => {
    const s = read("src/routes/support.tsx");
    expect(s).toMatch(
      /Quando a avaliação automática de proximidade está ativa, uma inventada que chega muito perto da verdadeira ganha o bônus 🧠/,
    );
    expect(s).not.toMatch(/\. Uma inventada que chega muito perto/);
  });

  it("nenhum texto ao jogador garante o bônus 🧠 sem condição", () => {
    for (const p of [
      "src/components/Onboarding.tsx",
      "src/routes/support.tsx",
    ]) {
      expect(read(p)).not.toMatch(/com nota de 80 ou mais/);
    }
  });
});
