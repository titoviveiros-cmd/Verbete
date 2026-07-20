import { describe, it, expect } from "vitest";
import { cn, scrollbarClip } from "@/lib/utils";

describe("cn", () => {
  it("mescla classes com tailwind-merge (última vence)", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
    const oculto: boolean = [].length > 0;
    expect(cn("text-red-500", oculto && "hidden", "font-bold")).toBe(
      "text-red-500 font-bold",
    );
  });
});

describe("scrollbarClip", () => {
  it("margem negativa espelha o padding (conteúdo não se move)", () => {
    const s = scrollbarClip("0.75rem");
    expect(s.marginRight).toBe("calc(-1 * (0.75rem + 24px))");
    expect(s.paddingRight).toBe("calc((0.75rem + 24px))");
    expect(s.width).toBe("calc(100% + (0.75rem + 24px))");
    expect(s.maxWidth).toBe(s.width);
  });
  it("default usa o padding do shell (1rem + safe-area)", () => {
    const s = scrollbarClip();
    expect(s.marginRight).toContain(
      "max(1rem, env(safe-area-inset-right, 0px))",
    );
  });
});
