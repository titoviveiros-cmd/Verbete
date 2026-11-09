// Anti-trapaça: colar/arrastar bloqueados em todo campo de texto, com UMA exceção
// (colar no manifesto D1 do painel admin, marcado e em /admin/…).
import { describe, expect, it } from "vitest";
import {
  ADMIN_PASTE_MARK,
  isAdminPath,
  shouldBlockEditEvent,
} from "../paste-guard";

const el = (tag: string, mark?: string) => {
  const e = document.createElement(tag);
  if (mark) e.setAttribute("data-allow-paste", mark);
  return e;
};

describe("paste-guard", () => {
  it("bloqueia colar e arrastar nos campos das partidas", () => {
    for (const path of ["/", "/daily", "/room/ABCD", "/play"]) {
      for (const type of ["paste", "drop"]) {
        expect(shouldBlockEditEvent(type, el("input"), path)).toBe(true);
        expect(shouldBlockEditEvent(type, el("textarea"), path)).toBe(true);
      }
    }
  });

  it("bloqueia em elemento contentEditable", () => {
    const d = el("div");
    Object.defineProperty(d, "isContentEditable", { value: true });
    expect(shouldBlockEditEvent("paste", d, "/daily")).toBe(true);
  });

  it("libera SÓ colar no campo marcado, e só em /admin/…", () => {
    const ta = el("textarea", ADMIN_PASTE_MARK);
    expect(shouldBlockEditEvent("paste", ta, "/admin/daily-choices")).toBe(
      false,
    );
    // arrastar continua bloqueado mesmo no campo marcado
    expect(shouldBlockEditEvent("drop", ta, "/admin/daily-choices")).toBe(true);
    // a marca fora do admin não libera nada
    expect(shouldBlockEditEvent("paste", ta, "/daily")).toBe(true);
    expect(shouldBlockEditEvent("paste", ta, "/administrador")).toBe(true);
    // campo sem marca, ou com outra marca, no admin: bloqueado
    expect(
      shouldBlockEditEvent("paste", el("textarea"), "/admin/daily-choices"),
    ).toBe(true);
    expect(
      shouldBlockEditEvent("paste", el("input", "x"), "/admin/daily-choices"),
    ).toBe(true);
  });

  it("não mexe em elementos que não são de texto", () => {
    expect(shouldBlockEditEvent("paste", el("div"), "/daily")).toBe(false);
    expect(shouldBlockEditEvent("paste", null, "/daily")).toBe(false);
  });

  it("rota de admin exata", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/daily-choices")).toBe(true);
    expect(isAdminPath("/administrador")).toBe(false);
    expect(isAdminPath("/daily")).toBe(false);
  });
});
