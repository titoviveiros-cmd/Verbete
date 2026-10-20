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

// ---------------------------------------------------------------------------
// Playtest 2026-10-20 (aparelho real): "Chame a ga…" com reticências, o
// "Avançar agora" e o "Próxima rodada" cortados na lateral, a borda rosa da
// cédula escolhida aparada e o 💬 em cima das cartas da Revelação. Nenhum dos
// instrumentos acima via isso: o corte vinha de um ANCESTRAL com overflow
// escondido (não da borda da tela) e o chat cobria conteúdo que não era botão.

/** Texto com reticências do CSS ou maior que a própria caixa (overflow escondido). */
export async function truncatedTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const all = Array.from(
      document.body.querySelectorAll("*"),
    ) as HTMLElement[];
    for (const el of all) {
      if (el.closest('[aria-hidden="true"], [inert], .sr-only')) continue;
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent ?? "")
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (!own) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const text = (el.innerText || own)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      const clipsX =
        cs.overflowX !== "visible" || cs.textOverflow === "ellipsis";
      if (clipsX && el.scrollWidth > el.clientWidth + 1) {
        out.push(`TRUNCADO «${text}» [${el.scrollWidth}>${el.clientWidth}]`);
        continue;
      }
      const clamp = cs.getPropertyValue("-webkit-line-clamp").trim();
      if (clamp && clamp !== "none" && el.scrollHeight > el.clientHeight + 1)
        out.push(`TRUNCADO (linhas) «${text}»`);
    }
    return out;
  });
}

/**
 * Alvo (botão, cédula, carta, anel rosa) cortado por um ANCESTRAL que esconde
 * o excesso. O anel `box-shadow: 0 0 0 Npx` conta como parte do alvo. Na
 * vertical, contêiner que rola é permitido (o alvo rola até aparecer).
 */
export async function clippedByAncestors(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const label = (el: Element) =>
      (
        (el.getAttribute("aria-label") ||
          (el as HTMLElement).innerText ||
          el.tagName) + ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
    const ringSpread = (shadow: string) => {
      let max = 0;
      // "rgb(…) 0px 0px 0px 3px, …": anel = sombra sem deslocamento nem desfoque.
      for (const m of shadow.matchAll(/0px 0px 0px (\d+(?:\.\d+)?)px/g))
        max = Math.max(max, Number(m[1]));
      return max;
    };
    const targets = Array.from(
      document.querySelectorAll(
        'button, a[href], [role="button"], .ring-neon, .sticker',
      ),
    ) as HTMLElement[];
    for (const el of targets) {
      if (el.closest('[aria-hidden="true"], [inert]')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r0 = el.getBoundingClientRect();
      if (r0.width < 4 || r0.height < 4) continue;
      const s = ringSpread(cs.boxShadow);
      const r = {
        left: r0.left - s,
        right: r0.right + s,
        top: r0.top - s,
        bottom: r0.bottom + s,
      };
      // Dentro de uma lista que rola, o alvo fora da área visível não está
      // cortado — basta rolar. A partir do 1º ancestral que rola num eixo,
      // os ancestrais de fora não contam mais naquele eixo.
      let checkX = true;
      let checkY = true;
      for (
        let a = el.parentElement;
        a && a !== document.body && a !== document.documentElement;
        a = a.parentElement
      ) {
        const acs = getComputedStyle(a);
        const ox = acs.overflowX;
        const oy = acs.overflowY;
        if (ox === "visible" && oy === "visible") continue;
        const ar = a.getBoundingClientRect();
        const left = ar.left + (parseFloat(acs.borderLeftWidth) || 0);
        const right = ar.right - (parseFloat(acs.borderRightWidth) || 0);
        const top = ar.top + (parseFloat(acs.borderTopWidth) || 0);
        const bottom = ar.bottom - (parseFloat(acs.borderBottomWidth) || 0);
        const scrollerX =
          (ox === "auto" || ox === "scroll") &&
          a.scrollWidth > a.clientWidth + 1;
        const scrollerY =
          (oy === "auto" || oy === "scroll") &&
          a.scrollHeight > a.clientHeight + 1;
        const where = `${a.tagName.toLowerCase()}.${String(a.className).split(" ").slice(0, 3).join(".")}`;
        if (
          checkX &&
          !scrollerX &&
          (r.left < left - 0.5 || r.right > right + 0.5)
        ) {
          out.push(
            `CORTADO NA LATERAL «${label(el)}» [${Math.round(r.left)}→${Math.round(r.right)}] por ${where} [${Math.round(left)}→${Math.round(right)}]`,
          );
          break;
        }
        if (scrollerX) checkX = false;
        if (scrollerY) checkY = false;
        if (
          checkY &&
          (oy === "hidden" || oy === "clip") &&
          (r.top < top - 0.5 || r.bottom > bottom + 0.5)
        ) {
          out.push(
            `CORTADO NA VERTICAL «${label(el)}» [${Math.round(r.top)}→${Math.round(r.bottom)}] por ${where} [${Math.round(top)}→${Math.round(bottom)}]`,
          );
          break;
        }
      }
    }
    return out;
  });
}

/**
 * Zona de exclusão dos controles flutuantes (💬 chat e ▾ das reações): nenhum
 * texto, botão, carta ou ficha visível sob eles (com `gap` px de folga), e
 * nenhuma lista rolável cujo conteúdo passe por baixo deles ao rolar.
 */
export async function floatingZoneIntrusions(
  page: Page,
  gap = 4,
): Promise<string[]> {
  return page.evaluate((gap) => {
    const out: string[] = [];
    const floats = (
      [
        [
          "💬 chat",
          document.querySelector(
            '[aria-label="Abrir chat"], [aria-label="Fechar chat"]',
          ),
        ],
        [
          "▾ das reações",
          document.querySelector(
            '[aria-label="Esconder reações"], [aria-label="Mostrar reações"]',
          ),
        ],
      ] as Array<[string, Element | null]>
    ).filter((f): f is [string, Element] => !!f[1]);
    if (floats.length === 0) return out;
    const zone = floats.map(([name, el]) => {
      const f = el.getBoundingClientRect();
      return {
        name,
        left: f.left - gap,
        right: f.right + gap,
        top: f.top - gap,
        bottom: f.bottom + gap,
      };
    });
    type Box = { left: number; right: number; top: number; bottom: number };
    const hit = (a: Box, b: Box) =>
      a.left < b.right &&
      a.right > b.left &&
      a.top < b.bottom &&
      a.bottom > b.top;
    const bar =
      document.querySelector('[aria-label="Enviar 😂"]')?.parentElement ?? null;
    const skip = (n: Element) =>
      !!n.closest('[aria-hidden="true"], [inert], .sr-only') ||
      floats.some(([, f]) => f.contains(n)) ||
      // a barra de reações tem a própria reserva (.room-shell)
      !!bar?.contains(n);
    const shown = (n: Element) => {
      for (let a: Element | null = n; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.display === "none" || cs.visibility === "hidden") return false;
        if (Number(cs.opacity) < 0.05) return false;
      }
      return true;
    };
    const seen = new Set<string>();
    const report = (msg: string) => {
      if (!seen.has(msg)) {
        seen.add(msg);
        out.push(msg);
      }
    };
    // Só a parte VISÍVEL conta: o que a lista que rola esconde (abaixo da
    // área visível dela) não está sob o botão — a geometria crua do item
    // diria que sim.
    const visible = (n: Element, r: Box): Box | null => {
      let v = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      for (let a = n.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        const clipX = cs.overflowX !== "visible";
        const clipY = cs.overflowY !== "visible";
        if (!clipX && !clipY) continue;
        const ar = a.getBoundingClientRect();
        if (clipX)
          v = {
            ...v,
            left: Math.max(v.left, ar.left),
            right: Math.min(v.right, ar.right),
          };
        if (clipY)
          v = {
            ...v,
            top: Math.max(v.top, ar.top),
            bottom: Math.min(v.bottom, ar.bottom),
          };
        if (v.right - v.left < 1 || v.bottom - v.top < 1) return null;
      }
      return v;
    };
    // 1) Texto visível agora sob um controle.
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    const range = document.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.textContent ?? "").replace(/\s+/g, " ").trim();
      const parent = n.parentElement;
      if (!text || !parent || skip(parent) || !shown(parent)) continue;
      range.selectNodeContents(n);
      for (const raw of Array.from(range.getClientRects())) {
        const rect = visible(parent, raw);
        if (!rect) continue;
        for (const z of zone)
          if (hit(rect, z))
            report(`TEXTO SOB ${z.name}: «${text.slice(0, 40)}»`);
      }
    }
    // 2) Alvos e peças (botão, campo, cédula, ficha) sob um controle.
    const pieces = Array.from(
      document.querySelectorAll(
        'button, a[href], [role="button"], input, textarea, .sticker, .panel, .chip, .token',
      ),
    );
    for (const p of pieces) {
      if (skip(p) || !shown(p)) continue;
      const raw = p.getBoundingClientRect();
      if (raw.width < 4 || raw.height < 4) continue;
      const r = visible(p, raw);
      if (!r) continue;
      const name = (
        (p as HTMLElement).innerText ||
        p.getAttribute("aria-label") ||
        p.tagName
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      for (const z of zone)
        if (hit(r, z))
          report(`PEÇA SOB ${z.name}: ${p.tagName.toLowerCase()} «${name}»`);
    }
    // 3) Lista rolável cuja área visível alcança um controle e cujo conteúdo
    //    ocupa a coluna dele: ao rolar, algo passa por baixo.
    for (const el of Array.from(
      document.querySelectorAll("*"),
    ) as HTMLElement[]) {
      const cs = getComputedStyle(el);
      if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") continue;
      if (el.scrollHeight <= el.clientHeight + 1 || skip(el) || !shown(el))
        continue;
      const box = el.getBoundingClientRect();
      for (const z of zone) {
        if (!hit(box, z)) continue;
        let right = -Infinity;
        let left = Infinity;
        for (const c of Array.from(el.querySelectorAll("*"))) {
          const r = c.getBoundingClientRect();
          if (r.width < 1 || r.height < 1 || skip(c)) continue;
          right = Math.max(right, r.right);
          left = Math.min(left, r.left);
        }
        if (right > z.left && left < z.right)
          report(
            `LISTA ROLA SOB ${z.name}: ${el.tagName.toLowerCase()}.${String(el.className).split(" ").slice(0, 3).join(".")}`,
          );
      }
    }
    return out;
  }, gap);
}
