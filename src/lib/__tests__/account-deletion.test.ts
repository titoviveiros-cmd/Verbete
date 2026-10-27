import { describe, expect, it, vi } from "vitest";
import {
  DELETE_ACCOUNT_FAILED,
  deleteAccountData,
} from "@/lib/account-deletion";

// Exclusão de conta (rodada 2A, 27/10/2026): antes, o erro de cada etapa
// era ignorado e o login era apagado mesmo assim — daily_attempts e
// user_achievements (sem FK para auth.users) sobravam órfãs com o user_id.
// Agora qualquer falha para ANTES de apagar o login (dá para repetir).

const USER = "00000000-0000-4000-8000-00000000b1a0";
const TABLES = [
  "match_history",
  "daily_attempts",
  "user_achievements",
  "user_stats",
  "profiles",
];

function fakeDb(fail: Partial<Record<string, string>> = {}) {
  const ops: string[] = [];
  const deleteUser = vi.fn(async (id: string) => {
    ops.push(`auth.deleteUser:${id}`);
    return { error: fail["auth"] ? { message: fail["auth"] } : null };
  });
  const from = (table: string) => ({
    delete: () => ({
      eq: async (col: string, val: string) => {
        ops.push(`${table}.delete:${col}=${val}`);
        return { error: fail[table] ? { message: fail[table] } : null };
      },
    }),
  });
  return {
    db: { from, auth: { admin: { deleteUser } } } as never,
    ops,
    deleteUser,
  };
}

describe("deleteAccountData — exclusão fail-closed", () => {
  it("apaga as 5 tabelas da conta pelo user_id e SÓ DEPOIS o login", async () => {
    const { db, ops, deleteUser } = fakeDb();
    await expect(deleteAccountData(db, USER)).resolves.toEqual({ ok: true });
    for (const t of TABLES)
      expect(ops).toContain(`${t}.delete:user_id=${USER}`);
    expect(deleteUser).toHaveBeenCalledTimes(1);
    expect(ops.at(-1)).toBe(`auth.deleteUser:${USER}`);
  });

  it.each(TABLES)(
    "falha ao apagar %s → erro e o login NÃO é apagado (nova tentativa possível)",
    async (table) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { db, deleteUser } = fakeDb({ [table]: "timeout" });
      await expect(deleteAccountData(db, USER)).rejects.toThrow(
        DELETE_ACCOUNT_FAILED,
      );
      expect(deleteUser).not.toHaveBeenCalled();
      errors.mockRestore();
    },
  );

  it("falha ao apagar o login → erro (o app não desloga nem diz que excluiu)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = fakeDb({ auth: "boom" });
    await expect(deleteAccountData(db, USER)).rejects.toThrow(
      DELETE_ACCOUNT_FAILED,
    );
    errors.mockRestore();
  });

  it("repetir depois de uma falha conclui (etapas idempotentes)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = fakeDb({ user_stats: "timeout" });
    await expect(deleteAccountData(first.db, USER)).rejects.toThrow();
    const retry = fakeDb();
    await expect(deleteAccountData(retry.db, USER)).resolves.toEqual({
      ok: true,
    });
    expect(retry.deleteUser).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});
