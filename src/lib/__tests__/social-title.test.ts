import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Título do link compartilhado (prévia do WhatsApp/redes): "Verbete: blefe
// com palavras raras" — dois-pontos no lugar do travessão (2.1.1, pedido do
// dono). O mesmo texto em <title>, og:title e twitter:title da raiz e da Home.
const TITLE = "Verbete: blefe com palavras raras";
const ROUTES = join(__dirname, "..", "..", "routes");
const src = (f: string) => readFileSync(join(ROUTES, f), "utf8");
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe("título da prévia de compartilhamento", () => {
  it("raiz: <title>, og:title e twitter:title com o título novo", () => {
    const root = src("__root.tsx");
    expect(count(root, `title: "${TITLE}"`)).toBe(1);
    expect(root).toMatch(
      new RegExp(`property: "og:title",\\s*content: "${TITLE}"`),
    );
    expect(root).toMatch(
      new RegExp(`name: "twitter:title",\\s*content: "${TITLE}"`),
    );
  });

  it("Home (links /?join=…): <title> e og:title com o título novo", () => {
    const home = src("index.tsx");
    expect(count(home, `title: "${TITLE}"`)).toBe(1);
    expect(home).toMatch(
      new RegExp(`property: "og:title",\\s*content: "${TITLE}"`),
    );
  });

  it("nenhum resto do título antigo (com travessão)", () => {
    for (const f of ["__root.tsx", "index.tsx"])
      expect(src(f)).not.toMatch(/Verbete [—–-] blefe com palavras raras/);
  });
});
