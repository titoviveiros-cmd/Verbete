import { describe, expect, it } from "vitest";
import {
  isUuid,
  readJsonObject,
} from "../../../supabase/functions/_shared/input.ts";

const post = (body: string) =>
  new Request("http://edge.local/", { method: "POST", body });

describe("entrada das edges públicas", () => {
  it("isUuid aceita só UUID", () => {
    expect(isUuid("3a9ffb5a-19a0-4c8b-9797-2a44d74eaa6a")).toBe(true);
    expect(isUuid("3A9FFB5A-19A0-4C8B-9797-2A44D74EAA6A")).toBe(true);
    for (const v of ["", "x", "w1", "1; drop table", 42, null, undefined, {}])
      expect(isUuid(v)).toBe(false);
  });

  it("readJsonObject devolve o objeto, ou null para lixo (sem exceção)", async () => {
    expect(await readJsonObject(post('{"word_id":"a"}'))).toEqual({
      word_id: "a",
    });
    expect(await readJsonObject(post("x"))).toBeNull();
    expect(await readJsonObject(post(""))).toBeNull();
    expect(await readJsonObject(post("[1]"))).toBeNull();
    expect(await readJsonObject(post("null"))).toBeNull();
  });
});
