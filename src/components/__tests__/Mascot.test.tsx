import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Mascot } from "@/components/Mascot";

// Smoke de RTL: prova que o harness renderiza componentes com framer-motion
// em jsdom (base para os testes de fase da parte 2).
describe("Mascot", () => {
  it("renderiza o SVG no tamanho pedido", () => {
    const { container } = render(<Mascot mood="thinking" size={80} />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute("width", "80");
  });
});
