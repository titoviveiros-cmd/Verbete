// Escolha da palavra: só entram opções que cabem INTEIRAS no pior caso de
// largura suportado — tela de 320 px, onde o cartão da opção mede 288 px
// (.mobile-shell com 16 px de cada lado). Antes, palavras longas viravam
// "Gastroenterol…" (truncate). A medida é o layout REAL: as mesmas classes do
// cartão, a fonte Fredoka carregada e o chip da categoria — não a contagem de
// letras. Quem cabe a 320 px cabe em qualquer tela maior (e no cartão grande
// da palavra das fases seguintes).
import type { Word } from "@/lib/room";

export const WORST_CASE_OPTION_WIDTH = 288;

// Classes do cartão da opção no celular (ChooseWord usa estas MESMAS strings
// e só acrescenta variantes de estado/desktop).
export const OPTION_CLASS =
  "w-full sticker text-left transition !px-4 !py-3 flex items-center gap-3";
export const OPTION_ICON_CLASS = "text-2xl leading-none";
export const OPTION_WORD_CLASS =
  "font-display text-[22px] leading-tight flex-1 min-w-0 truncate capitalize";
export const OPTION_CHIP_CLASS =
  "chip text-muted-foreground uppercase tracking-wider !text-[10px] shrink-0";

export type WordFit = { fits: boolean; need: number; avail: number };

/** Mede, no layout real de 288 px, se cada palavra cabe sem reticências. */
export async function measureWordFit(
  words: Word[],
): Promise<Map<string, WordFit>> {
  const out = new Map<string, WordFit>();
  if (typeof document === "undefined") {
    for (const w of words) out.set(w.id, { fits: true, need: 0, avail: 0 });
    return out;
  }
  try {
    await document.fonts?.load?.("700 22px Fredoka");
    await document.fonts?.ready;
  } catch {
    /* sem a API de fontes: mede com o que houver */
  }
  const box = document.createElement("div");
  box.setAttribute("aria-hidden", "true");
  box.style.cssText = `position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;width:${WORST_CASE_OPTION_WIDTH}px`;
  const rows = words.map((w) => {
    const row = document.createElement("div");
    row.className = OPTION_CLASS;
    const icon = document.createElement("span");
    icon.className = OPTION_ICON_CLASS;
    icon.textContent = "📖";
    const p = document.createElement("p");
    p.className = OPTION_WORD_CLASS;
    p.textContent = w.word;
    row.append(icon, p);
    if (w.category) {
      const chip = document.createElement("span");
      chip.className = OPTION_CHIP_CLASS;
      chip.textContent = w.category;
      row.append(chip);
    }
    box.append(row);
    return { w, p };
  });
  document.body.append(box);
  for (const { w, p } of rows)
    out.set(w.id, {
      fits: p.scrollWidth <= p.clientWidth,
      need: p.scrollWidth,
      avail: p.clientWidth,
    });
  box.remove();
  return out;
}

/**
 * Sorteia `n` palavras que cabem inteiras: pede candidatas a mais e, se não
 * bastarem, sorteia de novo sem as já vistas (no máximo `attempts` vezes).
 * Último recurso (acervo mínimo, ex.: palavras próprias longas): completa com
 * as mais curtas, cada uma com a escala de fonte que a faz caber — nunca "…".
 */
export async function drawFittingWords({
  fetch,
  measure = measureWordFit,
  n = 3,
  attempts = 3,
}: {
  fetch: (excludeExtra: string[]) => Promise<Word[]>;
  measure?: (words: Word[]) => Promise<Map<string, WordFit>>;
  n?: number;
  attempts?: number;
}): Promise<{ words: Word[]; scale: Record<string, number> }> {
  const seen: string[] = [];
  const picked: Word[] = [];
  const rest: { w: Word; fit: WordFit }[] = [];
  for (let i = 0; i < attempts && picked.length < n; i++) {
    const fresh: Word[] = [];
    for (const w of await fetch([...seen]))
      if (!seen.includes(w.id) && !fresh.some((f) => f.id === w.id))
        fresh.push(w);
    if (fresh.length === 0) break;
    seen.push(...fresh.map((w) => w.id));
    const fits = await measure(fresh);
    for (const w of fresh) {
      const fit = fits.get(w.id) ?? { fits: false, need: 0, avail: 0 };
      if (fit.fits && picked.length < n) picked.push(w);
      else if (!fit.fits) rest.push({ w, fit });
    }
  }
  const scale: Record<string, number> = {};
  for (const { w, fit } of rest.sort((a, b) => a.fit.need - b.fit.need)) {
    if (picked.length >= n) break;
    picked.push(w);
    scale[w.id] = fit.need > 0 ? Math.min(1, fit.avail / fit.need) : 1;
  }
  return { words: picked, scale };
}
