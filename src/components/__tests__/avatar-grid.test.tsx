import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AvatarGrid } from "@/components/AvatarGrid";
import { AVATARS } from "@/lib/avatars";

// Escolha de avatar (2.1.1): só os animais — a linha de bolinhas de cor saiu
// da interface (a cor do jogador é interna). Nova sala/Entrar, JoinFlow e
// Perfil usam a MESMA grade.
afterEach(cleanup);

describe("AvatarGrid", () => {
  it("mostra só os animais, marca o escolhido e avisa a troca", () => {
    const onChange = vi.fn();
    render(<AvatarGrid value={AVATARS[2]} onChange={onChange} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(AVATARS.length);
    expect(screen.queryAllByLabelText(/Escolher cor/)).toHaveLength(0);
    expect(
      screen.getByLabelText(`Escolher avatar ${AVATARS[2]}`),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByLabelText(`Escolher avatar ${AVATARS[5]}`));
    expect(onChange).toHaveBeenCalledWith(AVATARS[5]);
  });

  it("colunas que encolhem e emoji proporcional (nada de largura mínima fixa)", () => {
    render(<AvatarGrid value={undefined} onChange={() => {}} />);
    const grid = screen.getAllByRole("button")[0]!.parentElement!;
    expect(grid.className).toContain("grid-cols-8"); // repeat(8, minmax(0,1fr))
    for (const b of screen.getAllByRole("button")) {
      expect(b.className).toContain("min-w-0");
      expect(b.className).not.toMatch(/\bp-1\b|\btext-2xl\b/);
    }
  });
});

describe("nenhum seletor de cor na interface", () => {
  const SRC = join(__dirname, "..", "..");
  const files: string[] = [];
  (function walk(d: string) {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) {
        if (f !== "__tests__" && f !== "node_modules") walk(p);
      } else if (/\.tsx$/.test(f)) files.push(p);
    }
  })(SRC);

  it("varre as telas (sanidade do instrumento)", () => {
    expect(files.some((f) => f.endsWith(join("routes", "profile.tsx")))).toBe(
      true,
    );
  });

  it("nenhuma tela renderiza 'Escolher cor'", () => {
    const offenders = files.filter((f) =>
      readFileSync(f, "utf8").includes("Escolher cor"),
    );
    expect(offenders).toEqual([]);
  });
});
