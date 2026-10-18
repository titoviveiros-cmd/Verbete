// Instrumentos de "botão escondido" para a fumaça visual.
//
// blockedButtons: todo botão/link visível precisa caber na largura da tela e
// ser o elemento do topo no próprio centro depois de rolado até o meio — nada
// flutuando por cima (barra de reações, chat, rodapé fixo). Roda depois da
// captura, porque rola a página.
//
// floatingConflicts: versão estrita para alvos conhecidos (🚩 da votação,
// cartas de palavra): o alvo inteiro na tela, a pelo menos `gap` px do chat,
// do ▾ e da barra de reações, e cinco pontos dele respondendo ao toque.
import type { Page } from "@playwright/test";

export async function blockedButtons(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const vw = window.innerWidth;
    const label = (el: Element) =>
      (
        (el.getAttribute("aria-label") ||
          (el as HTMLElement).innerText ||
          el.getAttribute("title") ||
          el.tagName) + ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
    const describe = (el: Element | null) =>
      el
        ? `${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 3).join(".")} «${label(el)}»`
        : "nada";
    const nodes = Array.from(
      document.querySelectorAll('button, a[href], [role="button"]'),
    ) as HTMLElement[];
    for (const b of nodes) {
      if (b.closest('[aria-hidden="true"], [inert]')) continue;
      const cs = getComputedStyle(b);
      if (
        cs.visibility === "hidden" ||
        cs.display === "none" ||
        Number(cs.opacity) < 0.05
      )
        continue;
      let r = b.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      b.scrollIntoView({ block: "center", inline: "nearest" });
      r = b.getBoundingClientRect();
      if (r.left < -1 || r.right > vw + 1) {
        out.push(
          `CORTADO ${label(b)} [${Math.round(r.left)}→${Math.round(r.right)} de ${vw}]`,
        );
        continue;
      }
      const cy = r.top + r.height / 2;
      if (cy < 0 || cy > window.innerHeight) continue;
      const top = document.elementFromPoint(r.left + r.width / 2, cy);
      if (top && (b === top || b.contains(top))) continue;
      out.push(`COBERTO ${label(b)} por ${describe(top)}`);
    }
    window.scrollTo(0, 0);
    return out;
  });
}

export async function floatingConflicts(
  page: Page,
  selector: string,
  gap = 6,
): Promise<string[]> {
  return page.evaluate(
    ([sel, gap]) => {
      const out: string[] = [];
      const floats = [
        ["chat", document.querySelector('[aria-label="Abrir chat"]')],
        [
          "▾ das reações",
          document.querySelector(
            '[aria-label="Esconder reações"], [aria-label="Mostrar reações"]',
          ),
        ],
        [
          "barra de reações",
          document.querySelector('[aria-label="Enviar 😂"]')?.parentElement ??
            null,
        ],
      ] as const;
      const targets = Array.from(
        document.querySelectorAll(sel),
      ) as HTMLElement[];
      if (targets.length === 0) out.push(`nenhum alvo: ${sel}`);
      for (const t of targets) {
        t.scrollIntoView({ block: "center", inline: "nearest" });
        const r = t.getBoundingClientRect();
        const name = (t.getAttribute("aria-label") || t.innerText || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 30);
        const where = `${name} [${Math.round(r.left)},${Math.round(r.top)}→${Math.round(r.right)},${Math.round(r.bottom)}]`;
        if (
          r.left < 0 ||
          r.top < 0 ||
          r.right > window.innerWidth ||
          r.bottom > window.innerHeight
        )
          out.push(`FORA DA TELA ${where}`);
        for (const [fname, el] of floats) {
          if (!el) continue;
          const f = el.getBoundingClientRect();
          const near =
            r.left - gap < f.right &&
            r.right + gap > f.left &&
            r.top - gap < f.bottom &&
            r.bottom + gap > f.top;
          if (near)
            out.push(
              `${where} a menos de ${gap}px do ${fname} [${Math.round(f.left)},${Math.round(f.top)}→${Math.round(f.right)},${Math.round(f.bottom)}]`,
            );
        }
        const points: Array<[number, number]> = [
          [0.5, 0.5],
          [0.15, 0.2],
          [0.85, 0.2],
          [0.15, 0.8],
          [0.85, 0.8],
        ];
        for (const [fx, fy] of points) {
          const top = document.elementFromPoint(
            r.left + r.width * fx,
            r.top + r.height * fy,
          );
          if (!top || !(t === top || t.contains(top))) {
            out.push(
              `${where}: ponto (${fx}, ${fy}) coberto por ${top?.tagName ?? "nada"}`,
            );
            break;
          }
        }
      }
      window.scrollTo(0, 0);
      return out;
    },
    [selector, gap] as const,
  );
}
