// Fontes LOCAIS para as capturas de loja (21/11/2026): Fredoka e Nunito, os mesmos
// arquivos do Google Fonts empacotados pelo @fontsource 5.3.0 (SIL OFL 1.1 — licenças
// em fonts/OFL-*.txt). Nenhuma requisição a fonts.googleapis.com / fonts.gstatic.com.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fonts");
const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
const PESOS = { Fredoka: [500, 600, 700], Nunito: [400, 600, 700, 800, 900] };

export const FONT_FILES = Object.entries(PESOS).flatMap(([fam, ws]) =>
  ws.flatMap((w) => ["latin", "latin-ext"].map((sub) => `${fam.toLowerCase()}-${sub}-${w}-normal.woff2`)),
);

export const fontBytes = (file) => readFileSync(join(DIR, file));

/** CSS @font-face com `url(prefix + arquivo)` (ex.: rota interceptada) ou data: URI (prefix = null). */
export function fontFaceCss(prefix = null) {
  return Object.entries(PESOS)
    .flatMap(([fam, ws]) =>
      ws.flatMap((w) =>
        [
          ["latin", LATIN],
          ["latin-ext", LATIN_EXT],
        ].map(([sub, range]) => {
          const file = `${fam.toLowerCase()}-${sub}-${w}-normal.woff2`;
          const src = prefix
            ? `${prefix}${file}`
            : `data:font/woff2;base64,${fontBytes(file).toString("base64")}`;
          return `@font-face{font-family:'${fam}';font-style:normal;font-display:block;font-weight:${w};src:url(${src}) format('woff2');unicode-range:${range};}`;
        }),
      ),
    )
    .join("\n");
}
