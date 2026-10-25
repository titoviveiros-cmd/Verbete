// Escolha da palavra: só entram opções que aparecem INTEIRAS em todo lugar
// onde a palavra é mostrada, no pior caso de largura suportado — tela de
// 320 px, 288 px úteis no .mobile-shell (16 px de cada lado):
//  1. o cartão da opção (22 px). A categoria só divide a linha com a palavra
//     se sobrar espaço; senão desce para a linha de baixo — nunca aperta a
//     palavra (antes, 150 das 151 excluídas eram só por causa do chip);
//  2. o cartão grande da escrita (WordCard, 34 px) — a palavra numa linha;
//  3. o cabeçalho da votação (24 px, dividindo a linha com o relógio).
// No desktop (lg), o coordenador vê as 3 opções lado a lado: o cartão da
// opção também é medido na largura REAL dessa grade. A medida é o layout
// real (as mesmas classes, a fonte Fredoka carregada), não contagem de letras.
// Antes, palavras longas viravam "Gastroenterol…" (truncate).
import type { Word } from "@/lib/room";

export const WORST_CASE_OPTION_WIDTH = 288;

// Cartão da opção no celular (ChooseWord usa estas MESMAS strings e só
// acrescenta variantes de estado e de tela deitada).
export const OPTION_CLASS =
  "w-full sticker text-left transition !px-4 !py-3 flex items-center gap-3";
export const OPTION_ICON_CLASS = "text-2xl leading-none";
// palavra + categoria: na mesma linha só se couberem as duas
export const OPTION_TEXT_CLASS =
  "flex-1 min-w-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-1";
// flex-auto (base = largura da palavra), não flex-1 (base 0): com base 0 a
// quebra de linha "achava" que a palavra não ocupa nada e a categoria nunca
// descia — a palavra continuava espremida (medido: 151 → 151).
export const OPTION_WORD_CLASS =
  "font-display text-[22px] leading-tight flex-auto min-w-0 truncate capitalize";
export const OPTION_CHIP_CLASS =
  "chip text-muted-foreground uppercase tracking-wider !text-[10px] shrink-0";
// Desktop: ícone, palavra e categoria empilhados (como sempre foi), em 3 colunas
export const OPTION_GRID_CLASS =
  "flex flex-col gap-3 short:gap-2 lg:grid lg:grid-cols-3";
export const OPTION_LG_CLASS = "lg:flex-col lg:items-start lg:!py-5";
export const OPTION_LG_ICON_CLASS = "lg:text-3xl";
export const OPTION_LG_TEXT_CLASS =
  "lg:w-full lg:flex-col lg:flex-nowrap lg:items-start lg:justify-start lg:gap-y-3";
export const OPTION_LG_WORD_CLASS = "lg:text-[26px]";

// As outras vitrines da palavra, no celular (sem as variantes lg:). O teste
// src/lib/__tests__/word-fit-parity.test.ts confere que WordCard
// (components/room/shared.tsx) e Voting.tsx usam exatamente estas classes.
export const HERO_CLASS = "word-hero text-center no-copy px-4 py-3";
export const HERO_WORD_CLASS =
  "font-display text-stroke capitalize text-white mt-0.5 leading-tight text-[34px]";
export const VOTE_BAR_CLASS =
  "word-hero shrink-0 flex items-center gap-3 px-4 py-2 w-full max-w-full";
export const VOTE_TEXT_CLASS = "flex-1 min-w-0 no-copy";
export const VOTE_WORD_CLASS =
  "font-display text-stroke text-2xl text-white leading-tight truncate capitalize";
export const VOTE_TIMER_CLASS =
  "font-display tabular-nums text-4xl leading-none shrink-0";

export const PROBE_CLASSES = {
  option: OPTION_CLASS,
  icon: OPTION_ICON_CLASS,
  text: OPTION_TEXT_CLASS,
  word: OPTION_WORD_CLASS,
  chip: OPTION_CHIP_CLASS,
  grid: OPTION_GRID_CLASS,
  lgOption: OPTION_LG_CLASS,
  lgIcon: OPTION_LG_ICON_CLASS,
  lgText: OPTION_LG_TEXT_CLASS,
  lgWord: OPTION_LG_WORD_CLASS,
  hero: HERO_CLASS,
  heroWord: HERO_WORD_CLASS,
  voteBar: VOTE_BAR_CLASS,
  voteText: VOTE_TEXT_CLASS,
  voteWord: VOTE_WORD_CLASS,
  voteTimer: VOTE_TIMER_CLASS,
};

type Fit = { need: number; avail: number; ok: boolean };
export type ProbeArg = {
  words: Array<{ id: string; word: string; category: string | null }>;
  /** largura útil do celular (tela − 32 px do .mobile-shell) */
  width: number;
  /** desktop: largura real da grade das 3 opções do coordenador */
  lgGridWidth?: number;
  C: typeof PROBE_CLASSES;
};
export type ProbeResult = {
  id: string;
  /** palavra inteira, categoria inteira e nada transbordando o cartão */
  option: Fit;
  hero: Fit;
  vote: Fit;
  lg?: Fit;
};

/**
 * Monta, escondidas, as vitrines da palavra com as classes reais e mede.
 * AUTOCONTIDA (usa só o argumento e o DOM): o e2e roda esta MESMA função no
 * navegador via page.evaluate — o teste mede o que o app mede.
 */
export function probeLayouts({
  words,
  width,
  lgGridWidth,
  C,
}: ProbeArg): ProbeResult[] {
  const el = (tag: string, cls: string, text?: string) => {
    const e = document.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const hide = (e: HTMLElement, w: number) => {
    e.setAttribute("aria-hidden", "true");
    e.style.cssText = `position:fixed;left:-20000px;top:0;visibility:hidden;pointer-events:none;width:${w}px`;
  };
  const card = (w: ProbeArg["words"][number], lg: boolean) => {
    const row = el("div", lg ? `${C.option} ${C.lgOption}` : C.option);
    row.append(el("span", lg ? `${C.icon} ${C.lgIcon}` : C.icon, "📖"));
    const text = el("div", lg ? `${C.text} ${C.lgText}` : C.text);
    const p = el("p", lg ? `${C.word} ${C.lgWord}` : C.word, w.word);
    text.append(p);
    const chip = w.category ? el("span", C.chip, w.category) : null;
    if (chip) text.append(chip);
    row.append(text);
    return { row, text, p, chip };
  };
  const box = el("div", "");
  hide(box, width);
  const lgBox = lgGridWidth ? el("div", C.grid) : null;
  if (lgBox && lgGridWidth) hide(lgBox, lgGridWidth);
  const rows = words.map((w) => {
    const opt = card(w, false);
    box.append(opt.row);
    // cartão grande: a palavra numa linha só (sem quebrar no hífen)
    const hero = el("div", C.hero);
    const h = el(
      "h2",
      `${C.heroWord} whitespace-nowrap overflow-hidden`,
      w.word,
    );
    hero.append(h);
    box.append(hero);
    // votação: palavra + relógio ("60s") na mesma linha
    const bar = el("div", C.voteBar);
    const vt = el("div", C.voteText);
    const vh = el("h2", C.voteWord, w.word);
    vt.append(vh);
    const timer = el("div", C.voteTimer, "60");
    timer.append(el("span", "text-sm opacity-70", "s"));
    bar.append(vt, timer);
    box.append(bar);
    const lg = lgBox ? card(w, true) : null;
    if (lgBox && lg) lgBox.append(lg.row);
    return { id: w.id, opt, h, vh, lg };
  });
  document.body.append(box);
  if (lgBox) document.body.append(lgBox);
  const fit = (e: HTMLElement): Fit => ({
    need: e.scrollWidth,
    avail: e.clientWidth,
    ok: e.scrollWidth <= e.clientWidth,
  });
  const cardFit = (c: ReturnType<typeof card>): Fit => {
    const word = fit(c.p);
    const chipOk =
      !c.chip ||
      (c.chip.scrollWidth <= c.chip.clientWidth &&
        c.chip.getBoundingClientRect().right <=
          c.text.getBoundingClientRect().right + 0.5);
    const noOverflow = c.row.scrollWidth <= c.row.clientWidth;
    return { ...word, ok: word.ok && chipOk && noOverflow };
  };
  const out = rows.map((r) => ({
    id: r.id,
    option: cardFit(r.opt),
    hero: fit(r.h),
    vote: fit(r.vh),
    ...(r.lg ? { lg: cardFit(r.lg) } : {}),
  }));
  box.remove();
  lgBox?.remove();
  return out;
}

export type WordFit = {
  fits: boolean;
  /** cartão da opção no celular (o último recurso escala por aqui) */
  need: number;
  avail: number;
  /** onde não coube: "opção", "cartão grande", "votação", "opção desktop" */
  fails?: string[];
};

/** Mede, no layout real, se cada palavra aparece inteira em todas as vitrines. */
export async function measureWordFit(
  words: Word[],
  opts: { lgGridWidth?: number } = {},
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
  const res = probeLayouts({
    words: words.map((w) => ({ id: w.id, word: w.word, category: w.category })),
    width: WORST_CASE_OPTION_WIDTH,
    lgGridWidth: opts.lgGridWidth,
    C: PROBE_CLASSES,
  });
  for (const r of res) {
    const fails = [
      ...(r.option.ok ? [] : ["opção"]),
      ...(r.hero.ok ? [] : ["cartão grande"]),
      ...(r.vote.ok ? [] : ["votação"]),
      ...(r.lg && !r.lg.ok ? ["opção desktop"] : []),
    ];
    out.set(r.id, {
      fits: fails.length === 0,
      need: r.option.need,
      avail: r.option.avail,
      ...(fails.length ? { fails } : {}),
    });
  }
  return out;
}

/**
 * Sorteia `n` palavras que cabem inteiras: pede candidatas a mais e, se não
 * bastarem, sorteia de novo sem as já vistas (no máximo `attempts` vezes).
 * Fica com as PRIMEIRAS que cabem, na ordem do `fetch` (fetchThreeWords já
 * entrega em ordem de prioridade: da sala, filtros da sala, complemento).
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
