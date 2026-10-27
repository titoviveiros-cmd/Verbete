// Auth do Supabase de mentira para os testes do aceite dos Termos: sessão
// trocável e os eventos do real (INITIAL_SESSION a quem assina; depois
// SIGNED_IN/SIGNED_OUT). Uso no teste:
//   vi.mock("@/integrations/supabase/client", async () =>
//     (await import("@/test/fake-auth")).supabaseModule);
// Estado no globalThis: sobrevive a vi.resetModules() ("reabrir o app").
import { vi } from "vitest";

type FakeUser = { id: string; is_anonymous: boolean };
export type FakeSession = { user: FakeUser } | null;
type Cb = (event: string, session: FakeSession) => void;

type SignIn = { data: { session: FakeSession }; error: unknown };
const NO_NETWORK: SignIn = {
  data: { session: null },
  error: { message: "sem rede no teste" },
};

const g = globalThis as unknown as {
  __fakeAuth?: {
    session: FakeSession;
    held: boolean;
    cbs: Set<Cb>;
    rpc: ReturnType<typeof vi.fn>;
    anonHeld: boolean;
    anonWaiter: ((id: string | null) => void) | null;
  };
};
const st = (g.__fakeAuth ??= {
  session: null,
  held: false,
  cbs: new Set(),
  rpc: vi.fn(() =>
    Promise.resolve({ data: null, error: { message: "rpc de teste" } }),
  ),
  anonHeld: false,
  anonWaiter: null,
});

function emit(event: string) {
  for (const cb of [...st.cbs]) cb(event, st.session);
}

export const anon = (id: string): FakeSession => ({
  user: { id, is_anonymous: true },
});
export const account = (id: string): FakeSession => ({
  user: { id, is_anonymous: false },
});

export const fakeAuth = {
  /** Troca a sessão e avisa (login, logout, sessão anônima nova). */
  set(next: FakeSession) {
    st.session = next;
    emit(next ? "SIGNED_IN" : "SIGNED_OUT");
  },
  /** Troca SEM avisar: outra aba trocou de conta e o evento não chegou. */
  swapSilently(next: FakeSession) {
    st.session = next;
  },
  /** Segura o INITIAL_SESSION: a identidade fica "carregando". */
  hold() {
    st.held = true;
  },
  release() {
    st.held = false;
    emit("INITIAL_SESSION");
  },
  /** O próximo cadastro anônimo fica aberto até finishAnonymous. */
  holdAnonymous() {
    st.anonHeld = true;
  },
  /** Conclui o cadastro anônimo aberto: com id, a sessão nasce; null = falha. */
  finishAnonymous(id: string | null) {
    const done = st.anonWaiter;
    st.anonHeld = false;
    st.anonWaiter = null;
    done?.(id);
  },
  /** Começo de teste: sessão nova, sem segurar nada. */
  reset(next: FakeSession = null) {
    st.held = false;
    st.anonHeld = false;
    st.anonWaiter = null;
    fakeAuth.set(next);
  },
};

/** Toda RPC devolve erro: chegar nela = passou pela trava do aceite. */
export const rpc = st.rpc;

export const supabaseModule = {
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: st.session } }),
      getUser: async () => ({ data: { user: st.session?.user ?? null } }),
      signInAnonymously: () =>
        st.anonHeld
          ? new Promise<SignIn>((resolve) => {
              st.anonWaiter = (id) => {
                if (!id) return resolve(NO_NETWORK);
                st.session = anon(id);
                emit("SIGNED_IN"); // como o real: avisa antes de resolver
                resolve({ data: { session: st.session }, error: null });
              };
            })
          : Promise.resolve(NO_NETWORK),
      onAuthStateChange: (cb: Cb) => {
        st.cbs.add(cb);
        if (!st.held) cb("INITIAL_SESSION", st.session);
        return {
          data: { subscription: { unsubscribe: () => st.cbs.delete(cb) } },
        };
      },
    },
    rpc,
    from: vi.fn(() => {
      throw new Error("from() de teste: não deveria ser chamado");
    }),
  },
};
