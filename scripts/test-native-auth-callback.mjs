// Retorno da autenticação do app nativo contra o GoTrue REAL (Supabase local
// do CI) — o caminho do login do Google sem o Google: o Supabase só devolve
// ao esquema do app se ele estiver na lista de retornos; o retorno traz um
// CÓDIGO PKCE (nunca token na URL); o código só vira sessão com o verificador
// guardado no app; um app estranho não desvia o retorno nem usa o código; e o
// retorno antigo (https://localhost, a origem do WebView) caía na URL do site.
// Envs: SUPA_URL, ANON (CI). Service role e Mailpit vêm do `supabase status`.
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";

const { SUPA_URL, ANON } = process.env;
if (!SUPA_URL || !ANON) {
  console.log("pulado: sem SUPA_URL/ANON (roda no CI com o Supabase local)");
  process.exit(0);
}
const st = spawnSync("npx", ["supabase", "status", "-o", "env"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
const env = Object.fromEntries(
  (st.stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)="?(.*?)"?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const SERVICE = env.SERVICE_ROLE_KEY;
const MAIL = (env.MAILPIT_URL || env.INBUCKET_URL || "http://127.0.0.1:54324").replace(/\/$/, "");
const SITE = "http://127.0.0.1:3000"; // site_url padrão do CLI
const CALLBACK = "app.verbete.game://auth/callback";

let total = 0;
let fails = 0;
const check = (name, ok, detail = "") => {
  total++;
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
// Log do CI é público: valores de token/código saem como "…" (só o formato importa).
const short = (x) =>
  String(x ?? "")
    .replace(/((?:access_token|refresh_token|provider_token|token|code)=)[^&#\s]+/g, "$1…")
    .slice(0, 140);
const mem = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};
const appLike = () =>
  createClient(SUPA_URL, ANON, {
    auth: { flowType: "pkce", storage: mem(), persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
  });
const admin = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const tag = Math.random().toString(36).slice(2, 7);
const users = [];

async function mkUser(email) {
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error) throw error;
  users.push(data.user.id);
  return data.user;
}
// Para onde o Supabase manda o navegador depois do link (sem segui-lo).
async function landing(redirectTo, email) {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email, options: { redirectTo } });
  if (error) throw error;
  const r = await fetch(data.properties.action_link, { redirect: "manual" });
  return r.headers.get("location") ?? "";
}
// Link do e-mail capturado pelo servidor de e-mail local (Mailpit; Inbucket nas versões antigas).
async function mailLink(email) {
  for (let i = 0; i < 20; i++) {
    try {
      const s = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`).then((r) => r.json());
      const id = s?.messages?.[0]?.ID;
      if (id) {
        const m = await fetch(`${MAIL}/api/v1/message/${id}`).then((r) => r.json());
        const body = `${m.Text ?? ""} ${m.HTML ?? ""}`.replace(/&amp;/g, "&");
        const link = body.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify[^\s"'<>]+/)?.[0];
        if (link) return link;
      }
    } catch {
      /* tenta a API antiga abaixo */
    }
    try {
      const box = email.split("@")[0];
      const list = await fetch(`${MAIL}/api/v1/mailbox/${box}`).then((r) => r.json());
      const id = Array.isArray(list) ? list.at(-1)?.id : undefined;
      if (id) {
        const m = await fetch(`${MAIL}/api/v1/mailbox/${box}/${id}`).then((r) => r.json());
        const body = `${m?.body?.text ?? ""} ${m?.body?.html ?? ""}`.replace(/&amp;/g, "&");
        const link = body.match(/https?:\/\/[^\s"'<>]+\/auth\/v1\/verify[^\s"'<>]+/)?.[0];
        if (link) return link;
      }
    } catch {
      /* ainda não chegou */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

try {
  console.log("— Lista de retornos do Supabase");
  const probe = `p-native-probe-${tag}@test.local`;
  await mkUser(probe);
  let loc = await landing(CALLBACK, probe);
  check("retorno ao esquema do app é aceito", loc.startsWith(CALLBACK), short(loc));
  loc = await landing("https://localhost", probe);
  check(
    "CAUSA RAIZ: o retorno antigo (https://localhost) é descartado e cai na URL do site",
    loc.startsWith(SITE) && !loc.startsWith("https://localhost"),
    short(loc),
  );
  loc = await landing("evil.app://auth/callback", probe);
  check("app estranho não desvia o retorno para o esquema dele", !loc.startsWith("evil.app://"), short(loc));

  console.log("\n— Fluxo do app: anônimo → login por link (PKCE) → sessão da conta");
  const email = `p-native-${tag}@test.local`;
  const account = await mkUser(email);
  const app = appLike();
  const anon = await app.auth.signInAnonymously();
  if (anon.data?.user?.id) users.push(anon.data.user.id);
  check("app começa com sessão anônima (como no boot)", !!anon.data?.session && anon.data.user?.is_anonymous === true);
  const otp = await app.auth.signInWithOtp({ email, options: { emailRedirectTo: CALLBACK, shouldCreateUser: false } });
  check("pedido do link aceito", !otp.error, short(otp.error?.message));
  const link = await mailLink(email);
  check("link chegou no e-mail", !!link, short(link));
  const back = link ? (await fetch(link, { redirect: "manual" })).headers.get("location") ?? "" : "";
  const code = back.startsWith(CALLBACK) ? new URL(back).searchParams.get("code") : null;
  check(
    "o link volta ao app com CÓDIGO PKCE — nenhum token na URL",
    back.startsWith(`${CALLBACK}?code=`) && !!code && !/access_token|refresh_token/.test(back),
    short(back),
  );
  if (code) {
    const attacker = appLike();
    const a1 = await attacker.auth.exchangeCodeForSession(code);
    check(
      "app sem o verificador (sequestro do esquema) NÃO ganha sessão",
      !!a1.error && !a1.data?.session,
      short(a1.error?.message),
    );
    const a2 = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=pkce`, {
      method: "POST",
      headers: { apikey: ANON, "content-type": "application/json" },
      body: JSON.stringify({ auth_code: code, code_verifier: "x".repeat(56) }),
    });
    check("verificador chutado é recusado pelo servidor", a2.status >= 400, `HTTP ${a2.status}`);
    const ok = await app.auth.exchangeCodeForSession(code);
    const u = ok.data?.session?.user;
    check(
      "o app (com o verificador) troca o código e vira a CONTA — deixa de ser anônimo",
      !ok.error && u?.id === account.id && u?.is_anonymous === false && u?.id !== anon.data?.user?.id,
      short(ok.error?.message ?? u?.email),
    );
    const again = await app.auth.exchangeCodeForSession(code);
    check("o mesmo código não serve duas vezes (retorno duplicado)", !!again.error, short(again.error?.message));
    const cur = await app.auth.getSession();
    check("a sessão da conta segue válida depois do retorno duplicado", cur.data?.session?.user?.id === account.id);
  }
} catch (e) {
  check("execução sem exceção", false, short(e?.message ?? e));
} finally {
  for (const id of users) await admin.auth.admin.deleteUser(id).catch(() => {});
}
console.log(fails ? `\n${fails}/${total} FALHAS` : `\nRETORNO DO LOGIN NATIVO OK — ${total}/${total}`);
process.exit(fails ? 1 : 0);
